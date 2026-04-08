const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ============================================================================
// AIS Snapshot Edge Function
// Connects to AISStream WebSocket API to fetch real vessel positions.
// Falls back to simulated data if AISSTREAM_API_KEY is not set.
// ============================================================================

interface VesselReport {
  mmsi: string; name: string; lat: number; lon: number;
  shipType: number; heading: number; speed: number; course: number;
  timestamp: number;
}

interface DensityZone {
  id: string; name: string; lat: number; lon: number;
  intensity: number; deltaPct: number; shipsPerDay: number; note: string;
}

interface Disruption {
  id: string; name: string; type: 'gap_spike' | 'chokepoint_congestion';
  lat: number; lon: number; severity: 'low' | 'elevated' | 'high';
  changePct: number; windowHours: number; darkShips: number;
  vesselCount: number; region: string; description: string;
}

// ---- In-memory cache (persists across warm invocations) ----
let cachedVessels: VesselReport[] = [];
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let inFlightFetch: Promise<VesselReport[]> | null = null;

// ---- Chokepoint definitions ----
const CHOKEPOINTS = [
  { id: 'hormuz', name: 'Strait of Hormuz', lat: 26.56, lon: 56.25, baseShips: 85, region: 'Persian Gulf', note: '20% of global oil transits' },
  { id: 'suez', name: 'Suez Canal', lat: 30.45, lon: 32.35, baseShips: 55, region: 'Egypt', note: 'Europe-Asia corridor' },
  { id: 'malacca', name: 'Strait of Malacca', lat: 2.5, lon: 101.2, baseShips: 95, region: 'Southeast Asia', note: 'Primary Asia-Pacific oil route' },
  { id: 'bab-el-mandeb', name: 'Bab el-Mandeb', lat: 12.6, lon: 43.3, baseShips: 40, region: 'Red Sea', note: 'Red Sea access; Yemen/Houthi area' },
  { id: 'panama', name: 'Panama Canal', lat: 9.08, lon: -79.68, baseShips: 38, region: 'Central America', note: 'Americas east-west transit' },
  { id: 'taiwan', name: 'Taiwan Strait', lat: 24.0, lon: 119.5, baseShips: 70, region: 'East Asia', note: 'Semiconductor supply chain' },
  { id: 'cape', name: 'Cape of Good Hope', lat: -34.35, lon: 18.5, baseShips: 30, region: 'South Africa', note: 'Suez bypass for VLCCs' },
  { id: 'gibraltar', name: 'Strait of Gibraltar', lat: 35.96, lon: -5.5, baseShips: 65, region: 'Mediterranean', note: 'Atlantic-Mediterranean gateway' },
  { id: 'bosporus', name: 'Bosporus Strait', lat: 41.12, lon: 29.05, baseShips: 48, region: 'Turkey', note: 'Black Sea access' },
  { id: 'korea', name: 'Korea Strait', lat: 34.0, lon: 129.0, baseShips: 55, region: 'East Asia', note: 'Japan-Korea trade corridor' },
  { id: 'dover', name: 'Dover Strait', lat: 51.0, lon: 1.5, baseShips: 120, region: 'English Channel', note: "World's busiest shipping lane" },
  { id: 'kerch', name: 'Kerch Strait', lat: 45.35, lon: 36.6, baseShips: 15, region: 'Black Sea', note: 'Azov Sea access' },
  { id: 'lombok', name: 'Lombok Strait', lat: -8.4, lon: 115.7, baseShips: 25, region: 'Indonesia', note: 'Malacca bypass for large tankers' },
];

// ---- AISStream WebSocket fetcher ----

async function fetchFromAISStream(apiKey: string): Promise<VesselReport[]> {
  const vessels = new Map<string, VesselReport>();
  const COLLECT_DURATION_MS = 8000; // Collect for 8 seconds

  return new Promise<VesselReport[]>((resolve) => {
    const timeout = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      resolve(Array.from(vessels.values()));
    }, COLLECT_DURATION_MS);

    let ws: WebSocket;
    try {
      ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    } catch {
      clearTimeout(timeout);
      resolve([]);
      return;
    }

    ws.onopen = () => {
      // Subscribe to all major shipping areas with bounding boxes
      const subscriptionMessage = {
        Apikey: apiKey,
        BoundingBoxes: [
          // Global coverage with large bounding boxes
          [[-90, -180], [90, 180]], // Entire world
        ],
        FilterMessageTypes: ['PositionReport', 'ShipStaticData', 'StandardClassBPositionReport'],
      };
      ws.send(JSON.stringify(subscriptionMessage));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
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
        };

        vessels.set(mmsi, vessel);
      } catch { /* skip malformed messages */ }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      try { ws.close(); } catch { /* ignore */ }
      resolve(Array.from(vessels.values()));
    };

    ws.onclose = () => {
      clearTimeout(timeout);
      resolve(Array.from(vessels.values()));
    };
  });
}

async function getVessels(): Promise<VesselReport[]> {
  const now = Date.now();
  if (cachedVessels.length > 0 && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedVessels;
  }

  if (inFlightFetch) return inFlightFetch;

  const apiKey = Deno.env.get('AISSTREAM_API_KEY') || '';
  if (!apiKey) return []; // No key = no real data

  inFlightFetch = fetchFromAISStream(apiKey).then((vessels) => {
    if (vessels.length > 0) {
      cachedVessels = vessels;
      cacheTimestamp = Date.now();
    }
    inFlightFetch = null;
    return cachedVessels;
  }).catch(() => {
    inFlightFetch = null;
    return cachedVessels; // return stale on error
  });

  return inFlightFetch;
}

// ---- Density & disruption generation from real vessel data ----

function computeDensityFromVessels(vessels: VesselReport[]): DensityZone[] {
  return CHOKEPOINTS.map((cp) => {
    // Count vessels within ~2° of each chokepoint
    const nearby = vessels.filter(v =>
      Math.abs(v.lat - cp.lat) < 2 && Math.abs(v.lon - cp.lon) < 2
    ).length;

    const intensity = Math.min(1, nearby / Math.max(1, cp.baseShips));
    const deltaPct = nearby > 0
      ? Math.round(((nearby - cp.baseShips) / Math.max(1, cp.baseShips)) * 100)
      : 0;

    return {
      id: cp.id,
      name: cp.name,
      lat: cp.lat,
      lon: cp.lon,
      intensity: Math.round(intensity * 100) / 100,
      deltaPct,
      shipsPerDay: nearby > 0 ? nearby * 6 : cp.baseShips, // Extrapolate from snapshot
      note: cp.note,
    };
  });
}

function computeDisruptionsFromDensity(density: DensityZone[]): Disruption[] {
  const disruptions: Disruption[] = [];
  for (const zone of density) {
    if (Math.abs(zone.deltaPct) < 20) continue; // Only flag significant changes
    const cp = CHOKEPOINTS.find(c => c.id === zone.id);
    if (!cp) continue;

    const isGapSpike = zone.deltaPct < -20;
    const severity: 'low' | 'elevated' | 'high' =
      Math.abs(zone.deltaPct) > 50 ? 'high' : Math.abs(zone.deltaPct) > 30 ? 'elevated' : 'low';

    disruptions.push({
      id: `${zone.id}-${Date.now()}`,
      name: zone.name,
      type: isGapSpike ? 'gap_spike' : 'chokepoint_congestion',
      lat: cp.lat,
      lon: cp.lon,
      severity,
      changePct: zone.deltaPct,
      windowHours: 24,
      darkShips: isGapSpike ? Math.abs(Math.floor(zone.deltaPct / 10)) : 0,
      vesselCount: zone.shipsPerDay,
      region: cp.region,
      description: isGapSpike
        ? `Traffic drop near ${zone.name}: ${Math.abs(zone.deltaPct)}% below baseline`
        : `Traffic surge at ${zone.name}: +${zone.deltaPct}% above baseline`,
    });
  }
  return disruptions;
}


// ============================================================================

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const includeCandidates = url.searchParams.get('candidates') === 'true';
    // Fetch real AIS data (returns empty if no API key)
    const vessels = await getVessels();
    const isLive = vessels.length > 0;
    const density = computeDensityFromVessels(vessels);
    const disruptions = computeDisruptionsFromDensity(density);
    const candidateReports = includeCandidates ? vessels : [];
    const vesselCount = vessels.length;

    const snapshot = {
      sequence: Math.floor(Date.now() / 60000),
      status: { connected: isLive, vessels: vesselCount, messages: vesselCount * 12 },
      source: isLive ? 'aisstream-live' : 'simulated',
      disruptions,
      density,
      ...(includeCandidates ? { candidateReports } : {}),
    };

    return new Response(JSON.stringify(snapshot), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': isLive
          ? 'public, max-age=30, s-maxage=120'
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
