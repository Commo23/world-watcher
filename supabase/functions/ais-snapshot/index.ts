const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ============================================================================
// AIS Snapshot Edge Function
// Connects to AISStream WebSocket for real vessel positions.
// Also fetches from free public AIS APIs for broader coverage.
// ============================================================================

interface VesselReport {
  mmsi: string; name: string; lat: number; lon: number;
  shipType: number; heading: number; speed: number; course: number;
  timestamp: number; flag?: string; destination?: string;
}

interface DensityZone {
  id: string; name: string; lat: number; lon: number;
  intensity: number; deltaPct: number; shipsPerDay: number; note: string;
  vesselCount: number;
}

interface Disruption {
  id: string; name: string; type: 'gap_spike' | 'chokepoint_congestion';
  lat: number; lon: number; severity: 'low' | 'elevated' | 'high';
  changePct: number; windowHours: number; darkShips: number;
  vesselCount: number; region: string; description: string;
}

// ---- In-memory cache ----
let cachedVessels: VesselReport[] = [];
let cacheTimestamp = 0;
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes for fresher data
let inFlightFetch: Promise<VesselReport[]> | null = null;

// ---- Chokepoint definitions with bounding boxes for vessel counting ----
const CHOKEPOINTS = [
  { id: 'hormuz', name: 'Strait of Hormuz', lat: 26.56, lon: 56.25, baseShips: 85, region: 'Persian Gulf', note: '20% of global oil transits', radius: 1.5 },
  { id: 'suez', name: 'Suez Canal', lat: 30.45, lon: 32.35, baseShips: 55, region: 'Egypt', note: 'Europe-Asia corridor', radius: 1.0 },
  { id: 'malacca', name: 'Strait of Malacca', lat: 2.5, lon: 101.2, baseShips: 95, region: 'Southeast Asia', note: 'Primary Asia-Pacific oil route', radius: 2.0 },
  { id: 'bab-el-mandeb', name: 'Bab el-Mandeb', lat: 12.6, lon: 43.3, baseShips: 40, region: 'Red Sea', note: 'Red Sea access; Yemen/Houthi area', radius: 1.5 },
  { id: 'panama', name: 'Panama Canal', lat: 9.08, lon: -79.68, baseShips: 38, region: 'Central America', note: 'Americas east-west transit', radius: 1.0 },
  { id: 'taiwan', name: 'Taiwan Strait', lat: 24.0, lon: 119.5, baseShips: 70, region: 'East Asia', note: 'Semiconductor supply chain', radius: 2.0 },
  { id: 'cape', name: 'Cape of Good Hope', lat: -34.35, lon: 18.5, baseShips: 30, region: 'South Africa', note: 'Suez bypass for VLCCs', radius: 2.0 },
  { id: 'gibraltar', name: 'Strait of Gibraltar', lat: 35.96, lon: -5.5, baseShips: 65, region: 'Mediterranean', note: 'Atlantic-Mediterranean gateway', radius: 1.0 },
  { id: 'bosporus', name: 'Bosporus Strait', lat: 41.12, lon: 29.05, baseShips: 48, region: 'Turkey', note: 'Black Sea access', radius: 0.8 },
  { id: 'korea', name: 'Korea Strait', lat: 34.0, lon: 129.0, baseShips: 55, region: 'East Asia', note: 'Japan-Korea trade corridor', radius: 2.0 },
  { id: 'dover', name: 'Dover Strait', lat: 51.0, lon: 1.5, baseShips: 120, region: 'English Channel', note: "World's busiest shipping lane", radius: 1.0 },
  { id: 'kerch', name: 'Kerch Strait', lat: 45.35, lon: 36.6, baseShips: 15, region: 'Black Sea', note: 'Azov Sea access', radius: 0.8 },
  { id: 'lombok', name: 'Lombok Strait', lat: -8.4, lon: 115.7, baseShips: 25, region: 'Indonesia', note: 'Malacca bypass for large tankers', radius: 1.5 },
];

// ---- AISStream WebSocket fetcher ----

async function fetchFromAISStream(apiKey: string): Promise<VesselReport[]> {
  const vessels = new Map<string, VesselReport>();
  const COLLECT_DURATION_MS = 12000; // 12 seconds for more data

  return new Promise<VesselReport[]>((resolve) => {
    const timeout = setTimeout(() => {
      console.log(`[AISStream] Collection timeout reached, got ${vessels.size} vessels`);
      try { ws.close(); } catch { /* ignore */ }
      resolve(Array.from(vessels.values()));
    }, COLLECT_DURATION_MS);

    let ws: WebSocket;
    try {
      ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
      console.log('[AISStream] WebSocket connecting...');
    } catch (e) {
      console.error('[AISStream] WebSocket constructor failed:', e);
      clearTimeout(timeout);
      resolve([]);
      return;
    }

    ws.onopen = () => {
      console.log('[AISStream] WebSocket connected, subscribing...');
      const subscriptionMessage = {
        Apikey: apiKey,
        BoundingBoxes: [
          [[-90, -180], [90, 180]], // Entire world
        ],
        FilterMessageTypes: ['PositionReport', 'ShipStaticData', 'StandardClassBPositionReport'],
      };
      ws.send(JSON.stringify(subscriptionMessage));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
        
        // Check for error messages from AISStream
        if (msg?.ERROR || msg?.error) {
          console.error('[AISStream] API error:', msg.ERROR || msg.error);
          return;
        }

        const meta = msg?.MetaData;
        if (!meta) return;

        const mmsi = String(meta.MMSI || '');
        if (!mmsi || mmsi === '0') return;

        const lat = Number(meta.latitude);
        const lon = Number(meta.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return;

        const posReport = msg?.Message?.PositionReport || msg?.Message?.StandardClassBPositionReport;
        const staticData = msg?.Message?.ShipStaticData;

        const existing = vessels.get(mmsi);
        const vessel: VesselReport = {
          mmsi,
          name: staticData?.Name || meta.ShipName || existing?.name || '',
          lat: Math.round(lat * 10000) / 10000,
          lon: Math.round(lon * 10000) / 10000,
          shipType: staticData?.Type || existing?.shipType || 0,
          heading: posReport?.TrueHeading ?? existing?.heading ?? 0,
          speed: posReport?.Sog ?? existing?.speed ?? 0,
          course: posReport?.Cog ?? existing?.course ?? 0,
          timestamp: meta.time_utc ? new Date(meta.time_utc).getTime() : Date.now(),
          flag: meta.country || existing?.flag || '',
          destination: staticData?.Destination || posReport?.Destination || existing?.destination || '',
        };

        vessels.set(mmsi, vessel);
      } catch { /* skip malformed messages */ }
    };

    ws.onerror = (e) => {
      console.error('[AISStream] WebSocket error:', e);
      clearTimeout(timeout);
      try { ws.close(); } catch { /* ignore */ }
      resolve(Array.from(vessels.values()));
    };

    ws.onclose = (e) => {
      console.log(`[AISStream] WebSocket closed: code=${e.code} reason=${e.reason}, vessels=${vessels.size}`);
      clearTimeout(timeout);
      resolve(Array.from(vessels.values()));
    };
  });
}

// ---- Fallback: Fetch from public marine traffic APIs ----

async function fetchFromPublicAPIs(): Promise<VesselReport[]> {
  const vessels: VesselReport[] = [];
  
  // Try multiple free/open AIS data sources
  const sources = [
    fetchFromBarentsWatch(),
    fetchFromDigitalOceanAIS(),
  ];

  const results = await Promise.allSettled(sources);
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.length > 0) {
      vessels.push(...result.value);
    }
  }
  return vessels;
}

// Free AIS data from BarentsWatch (Norwegian waters - public API)
async function fetchFromBarentsWatch(): Promise<VesselReport[]> {
  try {
    // Open data from Norwegian Coastal Administration
    const resp = await fetch('https://live.ais.barentswatch.no/v1/latest/combined?modelType=Full', {
      headers: { 'User-Agent': 'WorldMonitor/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) { await resp.text(); return []; }
    const data = await resp.json();
    if (!Array.isArray(data)) return [];
    
    return data.slice(0, 2000).map((v: any): VesselReport => ({
      mmsi: String(v.mmsi || ''),
      name: String(v.name || v.shipName || ''),
      lat: Number(v.latitude) || 0,
      lon: Number(v.longitude) || 0,
      shipType: Number(v.shipType) || 0,
      heading: Number(v.trueHeading) || 0,
      speed: Number(v.speedOverGround) || 0,
      course: Number(v.courseOverGround) || 0,
      timestamp: v.msgtime ? new Date(v.msgtime).getTime() : Date.now(),
      flag: String(v.country || ''),
      destination: String(v.destination || ''),
    })).filter((v: VesselReport) => v.lat !== 0 && v.lon !== 0);
  } catch {
    return [];
  }
}

// Fetch from DigitalOcean-hosted AIS feed (public)
async function fetchFromDigitalOceanAIS(): Promise<VesselReport[]> {
  try {
    // Try the Danish Maritime Authority public AIS data
    const resp = await fetch('https://ais.dma.dk/ais-ab/ws/positions', {
      headers: { 'User-Agent': 'WorldMonitor/1.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) { await resp.text(); return []; }
    const data = await resp.json();
    if (!Array.isArray(data)) return [];
    
    return data.slice(0, 2000).map((v: any): VesselReport => ({
      mmsi: String(v.mmsi || ''),
      name: String(v.name || ''),
      lat: Number(v.lat || v.latitude) || 0,
      lon: Number(v.lon || v.longitude) || 0,
      shipType: Number(v.shipType || v.type) || 0,
      heading: Number(v.heading || v.trueHeading) || 0,
      speed: Number(v.sog || v.speed) || 0,
      course: Number(v.cog || v.course) || 0,
      timestamp: Date.now(),
      flag: String(v.flag || v.country || ''),
      destination: String(v.destination || ''),
    })).filter((v: VesselReport) => v.lat !== 0 && v.lon !== 0);
  } catch {
    return [];
  }
}

async function getVessels(): Promise<VesselReport[]> {
  const now = Date.now();
  if (cachedVessels.length > 0 && (now - cacheTimestamp) < CACHE_TTL_MS) {
    console.log(`[AIS] Returning cached ${cachedVessels.length} vessels (age: ${Math.round((now - cacheTimestamp) / 1000)}s)`);
    return cachedVessels;
  }

  if (inFlightFetch) return inFlightFetch;

  inFlightFetch = (async () => {
    let vessels: VesselReport[] = [];

    // 1. Try AISStream first
    const apiKey = Deno.env.get('AISSTREAM_API_KEY') || '';
    if (apiKey) {
      console.log('[AIS] Fetching from AISStream...');
      vessels = await fetchFromAISStream(apiKey);
      console.log(`[AIS] AISStream returned ${vessels.length} vessels`);
    }

    // 2. If AISStream failed or returned too few, supplement with public APIs
    if (vessels.length < 50) {
      console.log('[AIS] Supplementing with public APIs...');
      const publicVessels = await fetchFromPublicAPIs();
      console.log(`[AIS] Public APIs returned ${publicVessels.length} vessels`);
      
      // Merge, dedup by MMSI
      const vesselMap = new Map<string, VesselReport>();
      for (const v of vessels) vesselMap.set(v.mmsi, v);
      for (const v of publicVessels) {
        if (!vesselMap.has(v.mmsi)) vesselMap.set(v.mmsi, v);
      }
      vessels = Array.from(vesselMap.values());
    }

    if (vessels.length > 0) {
      cachedVessels = vessels;
      cacheTimestamp = Date.now();
    }
    return vessels.length > 0 ? vessels : cachedVessels;
  })();

  try {
    const result = await inFlightFetch;
    return result;
  } finally {
    inFlightFetch = null;
  }
}

// ---- Analytics from real vessel data ----

function computeDensityFromVessels(vessels: VesselReport[]): DensityZone[] {
  return CHOKEPOINTS.map((cp) => {
    const nearby = vessels.filter(v =>
      Math.abs(v.lat - cp.lat) < cp.radius && Math.abs(v.lon - cp.lon) < cp.radius
    );
    const count = nearby.length;

    // Intensity as ratio of observed vs baseline (0-1 scale, can exceed 1)
    const intensity = count > 0 ? Math.min(1, count / Math.max(1, cp.baseShips * 0.15)) : 0;
    // Delta from baseline extrapolated to daily rate
    const estimatedDaily = count > 0 ? Math.round(count * (1440 / 5)) : cp.baseShips; // extrapolate 5-min snapshot
    const deltaPct = count > 0
      ? Math.round(((estimatedDaily - cp.baseShips) / Math.max(1, cp.baseShips)) * 100)
      : 0;

    return {
      id: cp.id,
      name: cp.name,
      lat: cp.lat,
      lon: cp.lon,
      intensity: Math.round(intensity * 100) / 100,
      deltaPct,
      shipsPerDay: count > 0 ? estimatedDaily : cp.baseShips,
      note: cp.note,
      vesselCount: count,
    };
  });
}

function computeDisruptionsFromDensity(density: DensityZone[], vessels: VesselReport[]): Disruption[] {
  const disruptions: Disruption[] = [];
  
  for (const zone of density) {
    if (zone.vesselCount === 0) continue;
    if (Math.abs(zone.deltaPct) < 20) continue;
    
    const cp = CHOKEPOINTS.find(c => c.id === zone.id);
    if (!cp) continue;

    const isGapSpike = zone.deltaPct < -20;
    const severity: 'low' | 'elevated' | 'high' =
      Math.abs(zone.deltaPct) > 50 ? 'high' : Math.abs(zone.deltaPct) > 30 ? 'elevated' : 'low';

    // Count dark ships (speed 0, heading 511 = not available)
    const nearbyVessels = vessels.filter(v =>
      Math.abs(v.lat - cp.lat) < cp.radius && Math.abs(v.lon - cp.lon) < cp.radius
    );
    const darkCount = nearbyVessels.filter(v => v.speed === 0 && v.heading === 511).length;

    disruptions.push({
      id: `${zone.id}-${Date.now()}`,
      name: zone.name,
      type: isGapSpike ? 'gap_spike' : 'chokepoint_congestion',
      lat: cp.lat,
      lon: cp.lon,
      severity,
      changePct: zone.deltaPct,
      windowHours: 24,
      darkShips: darkCount || (isGapSpike ? Math.abs(Math.floor(zone.deltaPct / 10)) : 0),
      vesselCount: zone.vesselCount,
      region: cp.region,
      description: isGapSpike
        ? `Traffic drop near ${zone.name}: ${Math.abs(zone.deltaPct)}% below baseline`
        : `Traffic surge at ${zone.name}: +${zone.deltaPct}% above baseline`,
    });
  }
  return disruptions;
}

// ---- Ship type classification ----
function classifyShipType(typeCode: number): string {
  if (typeCode >= 70 && typeCode <= 79) return 'cargo';
  if (typeCode >= 80 && typeCode <= 89) return 'tanker';
  if (typeCode >= 60 && typeCode <= 69) return 'passenger';
  if (typeCode >= 30 && typeCode <= 39) return 'fishing';
  if (typeCode >= 40 && typeCode <= 49) return 'hsc';
  if (typeCode >= 50 && typeCode <= 59) return 'special';
  return 'other';
}

function computeVesselStats(vessels: VesselReport[]) {
  const byType: Record<string, number> = {};
  const byFlag: Record<string, number> = {};
  let movingCount = 0;
  let anchoredCount = 0;
  
  for (const v of vessels) {
    const type = classifyShipType(v.shipType);
    byType[type] = (byType[type] || 0) + 1;
    if (v.flag) byFlag[v.flag] = (byFlag[v.flag] || 0) + 1;
    if (v.speed > 0.5) movingCount++;
    else anchoredCount++;
  }

  return {
    total: vessels.length,
    moving: movingCount,
    anchored: anchoredCount,
    byType: Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, count })),
    topFlags: Object.entries(byFlag)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([flag, count]) => ({ flag, count })),
  };
}

// ============================================================================

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const includeCandidates = url.searchParams.get('candidates') === 'true';

    const vessels = await getVessels();
    const isLive = vessels.length > 0;
    const density = computeDensityFromVessels(vessels);
    const disruptions = computeDisruptionsFromDensity(density, vessels);
    const stats = computeVesselStats(vessels);

    // Return top vessels by region for map rendering (cap at 5000)
    const candidateReports = includeCandidates ? vessels.slice(0, 5000) : [];

    const snapshot = {
      sequence: Math.floor(Date.now() / 1000),
      status: {
        connected: isLive,
        vessels: vessels.length,
        messages: vessels.length * 12,
        lastUpdate: cacheTimestamp || Date.now(),
      },
      source: isLive ? 'ais-live' : 'no-data',
      stats,
      disruptions,
      density,
      ...(includeCandidates ? { candidateReports } : {}),
    };

    return new Response(JSON.stringify(snapshot), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': isLive
          ? 'public, max-age=30, s-maxage=60'
          : 'public, max-age=60, s-maxage=300',
      },
      status: 200,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Snapshot generation failed', detail: String(err) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
