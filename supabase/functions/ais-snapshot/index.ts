const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ============================================================================
// AIS Snapshot Edge Function — Real-time vessel data
// Primary: digitraffic.fi (Finnish AIS, free, no auth)
// Secondary: AISStream WebSocket (if API key configured)
// ============================================================================

interface VesselReport {
  mmsi: string; name: string; lat: number; lon: number;
  shipType: number; heading: number; speed: number; course: number;
  timestamp: number; flag?: string; destination?: string;
  navStatus?: number;
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
let cachedMetadata: Map<string, { name: string; shipType: number; destination: string; flag: string }> = new Map();
let cacheTimestamp = 0;
const CACHE_TTL_MS = 90_000; // 90 seconds for fresher data
let inFlightFetch: Promise<VesselReport[]> | null = null;
let metaCacheTimestamp = 0;
const META_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min for vessel metadata

const CHOKEPOINTS = [
  { id: 'hormuz', name: 'Strait of Hormuz', lat: 26.56, lon: 56.25, baseShips: 85, region: 'Persian Gulf', note: '20% of global oil transits', radius: 2.0 },
  { id: 'suez', name: 'Suez Canal', lat: 30.45, lon: 32.35, baseShips: 55, region: 'Egypt', note: 'Europe-Asia corridor', radius: 1.5 },
  { id: 'malacca', name: 'Strait of Malacca', lat: 2.5, lon: 101.2, baseShips: 95, region: 'Southeast Asia', note: 'Primary Asia-Pacific oil route', radius: 3.0 },
  { id: 'bab-el-mandeb', name: 'Bab el-Mandeb', lat: 12.6, lon: 43.3, baseShips: 40, region: 'Red Sea', note: 'Red Sea access; Yemen/Houthi area', radius: 2.0 },
  { id: 'panama', name: 'Panama Canal', lat: 9.08, lon: -79.68, baseShips: 38, region: 'Central America', note: 'Americas east-west transit', radius: 1.5 },
  { id: 'taiwan', name: 'Taiwan Strait', lat: 24.0, lon: 119.5, baseShips: 70, region: 'East Asia', note: 'Semiconductor supply chain', radius: 3.0 },
  { id: 'cape', name: 'Cape of Good Hope', lat: -34.35, lon: 18.5, baseShips: 30, region: 'South Africa', note: 'Suez bypass for VLCCs', radius: 3.0 },
  { id: 'gibraltar', name: 'Strait of Gibraltar', lat: 35.96, lon: -5.5, baseShips: 65, region: 'Mediterranean', note: 'Atlantic-Mediterranean gateway', radius: 1.5 },
  { id: 'bosporus', name: 'Bosporus Strait', lat: 41.12, lon: 29.05, baseShips: 48, region: 'Turkey', note: 'Black Sea access', radius: 1.0 },
  { id: 'korea', name: 'Korea Strait', lat: 34.0, lon: 129.0, baseShips: 55, region: 'East Asia', note: 'Japan-Korea trade corridor', radius: 2.5 },
  { id: 'dover', name: 'Dover Strait', lat: 51.0, lon: 1.5, baseShips: 120, region: 'English Channel', note: "World's busiest shipping lane", radius: 1.5 },
  { id: 'kerch', name: 'Kerch Strait', lat: 45.35, lon: 36.6, baseShips: 15, region: 'Black Sea', note: 'Azov Sea access', radius: 1.0 },
  { id: 'lombok', name: 'Lombok Strait', lat: -8.4, lon: 115.7, baseShips: 25, region: 'Indonesia', note: 'Malacca bypass for large tankers', radius: 2.0 },
];

// ---- Primary: Digitraffic.fi (Finnish AIS — free, no auth, thousands of vessels) ----

async function fetchFromDigitraffic(): Promise<VesselReport[]> {
  try {
    console.log('[AIS] Fetching from digitraffic.fi...');
    const resp = await fetch('https://meri.digitraffic.fi/api/ais/v1/locations', {
      headers: {
        'User-Agent': 'WorldMonitor/1.0',
        'Accept-Encoding': 'gzip',
        'Digitraffic-User': 'WorldMonitor',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      console.error(`[AIS] digitraffic returned ${resp.status}`);
      await resp.text();
      return [];
    }

    const data = await resp.json();
    // Response is GeoJSON FeatureCollection
    const features = data?.features;
    if (!Array.isArray(features)) {
      console.error('[AIS] digitraffic: unexpected response format');
      return [];
    }

    console.log(`[AIS] digitraffic returned ${features.length} vessel positions`);

    const vessels: VesselReport[] = [];
    for (const f of features) {
      const props = f.properties;
      const coords = f.geometry?.coordinates;
      if (!props || !coords || coords.length < 2) continue;

      const mmsi = String(props.mmsi || '');
      if (!mmsi || mmsi === '0') continue;

      const lon = Number(coords[0]);
      const lat = Number(coords[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (lat === 0 && lon === 0) continue;

      // Look up metadata from cache
      const meta = cachedMetadata.get(mmsi);

      vessels.push({
        mmsi,
        name: meta?.name || '',
        lat: Math.round(lat * 10000) / 10000,
        lon: Math.round(lon * 10000) / 10000,
        shipType: meta?.shipType || 0,
        heading: Number(props.heading) || 0,
        speed: Number(props.sog) || 0,
        course: Number(props.cog) || 0,
        timestamp: (Number(props.timestampExternal) || Date.now() / 1000) * 1000,
        navStatus: Number(props.navStat) ?? undefined,
        flag: meta?.flag || '',
        destination: meta?.destination || '',
      });
    }

    return vessels;
  } catch (e) {
    console.error('[AIS] digitraffic fetch failed:', e);
    return [];
  }
}

// Fetch vessel metadata (name, type, destination) separately — cached longer
async function fetchVesselMetadata(): Promise<void> {
  const now = Date.now();
  if (cachedMetadata.size > 0 && (now - metaCacheTimestamp) < META_CACHE_TTL_MS) return;

  try {
    console.log('[AIS] Fetching vessel metadata from digitraffic...');
    const resp = await fetch('https://meri.digitraffic.fi/api/ais/v1/vessels', {
      headers: {
        'User-Agent': 'WorldMonitor/1.0',
        'Digitraffic-User': 'WorldMonitor',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) { await resp.text(); return; }
    const data = await resp.json();
    if (!Array.isArray(data)) return;

    const newMeta = new Map<string, { name: string; shipType: number; destination: string; flag: string }>();
    for (const v of data) {
      const mmsi = String(v.mmsi || '');
      if (!mmsi) continue;
      newMeta.set(mmsi, {
        name: String(v.name || '').trim(),
        shipType: Number(v.shipType) || 0,
        destination: String(v.destination || '').trim(),
        flag: String(v.countryCode || '').trim(),
      });
    }
    if (newMeta.size > 0) {
      cachedMetadata = newMeta;
      metaCacheTimestamp = Date.now();
      console.log(`[AIS] Cached metadata for ${newMeta.size} vessels`);
    }
  } catch (e) {
    console.error('[AIS] Metadata fetch failed:', e);
  }
}

// ---- AISStream WebSocket (supplementary) ----

async function fetchFromAISStream(apiKey: string): Promise<VesselReport[]> {
  const vessels = new Map<string, VesselReport>();
  const COLLECT_DURATION_MS = 10000;

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
      ws.send(JSON.stringify({
        Apikey: apiKey,
        BoundingBoxes: [[[-90, -180], [90, 180]]],
        FilterMessageTypes: ['PositionReport', 'ShipStaticData', 'StandardClassBPositionReport'],
      }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
        if (msg?.ERROR) { console.error('[AISStream]', msg.ERROR); return; }
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

        vessels.set(mmsi, {
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
          destination: staticData?.Destination || existing?.destination || '',
        });
      } catch { /* skip */ }
    };

    ws.onerror = () => { clearTimeout(timeout); try { ws.close(); } catch {} resolve(Array.from(vessels.values())); };
    ws.onclose = () => { clearTimeout(timeout); resolve(Array.from(vessels.values())); };
  });
}

// ---- Main vessel fetcher ----

async function getVessels(): Promise<VesselReport[]> {
  const now = Date.now();
  if (cachedVessels.length > 0 && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedVessels;
  }
  if (inFlightFetch) return inFlightFetch;

  inFlightFetch = (async () => {
    // Fetch metadata in parallel with positions
    const [_, digitrafficVessels] = await Promise.all([
      fetchVesselMetadata(),
      fetchFromDigitraffic(),
    ]);

    let vessels = digitrafficVessels;
    console.log(`[AIS] Digitraffic: ${vessels.length} vessels`);

    // Supplement with AISStream if available and digitraffic returned few
    const apiKey = Deno.env.get('AISSTREAM_API_KEY') || '';
    if (apiKey && vessels.length < 100) {
      const aisVessels = await fetchFromAISStream(apiKey);
      console.log(`[AIS] AISStream: ${aisVessels.length} vessels`);
      const vesselMap = new Map<string, VesselReport>();
      for (const v of vessels) vesselMap.set(v.mmsi, v);
      for (const v of aisVessels) { if (!vesselMap.has(v.mmsi)) vesselMap.set(v.mmsi, v); }
      vessels = Array.from(vesselMap.values());
    }

    if (vessels.length > 0) {
      cachedVessels = vessels;
      cacheTimestamp = Date.now();
    }
    return vessels.length > 0 ? vessels : cachedVessels;
  })();

  try { return await inFlightFetch; }
  finally { inFlightFetch = null; }
}

// ---- Analytics ----

function computeDensityFromVessels(vessels: VesselReport[]): DensityZone[] {
  return CHOKEPOINTS.map((cp) => {
    const nearby = vessels.filter(v =>
      Math.abs(v.lat - cp.lat) < cp.radius && Math.abs(v.lon - cp.lon) < cp.radius
    );
    const count = nearby.length;
    const intensity = count > 0 ? Math.min(1, count / Math.max(1, cp.baseShips * 0.1)) : 0;
    const estimatedDaily = count > 0 ? Math.round(count * 24) : cp.baseShips;
    const deltaPct = count > 0
      ? Math.round(((estimatedDaily - cp.baseShips) / Math.max(1, cp.baseShips)) * 100)
      : 0;

    return {
      id: cp.id, name: cp.name, lat: cp.lat, lon: cp.lon,
      intensity: Math.round(intensity * 100) / 100,
      deltaPct, shipsPerDay: count > 0 ? estimatedDaily : cp.baseShips,
      note: cp.note, vesselCount: count,
    };
  });
}

function computeDisruptions(density: DensityZone[], vessels: VesselReport[]): Disruption[] {
  const disruptions: Disruption[] = [];
  for (const zone of density) {
    if (zone.vesselCount === 0 || Math.abs(zone.deltaPct) < 20) continue;
    const cp = CHOKEPOINTS.find(c => c.id === zone.id);
    if (!cp) continue;

    const isGapSpike = zone.deltaPct < -20;
    const severity: 'low' | 'elevated' | 'high' =
      Math.abs(zone.deltaPct) > 50 ? 'high' : Math.abs(zone.deltaPct) > 30 ? 'elevated' : 'low';

    const nearbyVessels = vessels.filter(v =>
      Math.abs(v.lat - cp.lat) < cp.radius && Math.abs(v.lon - cp.lon) < cp.radius
    );
    const darkCount = nearbyVessels.filter(v => v.speed === 0 && (v.heading === 511 || v.heading === 0)).length;

    disruptions.push({
      id: `${zone.id}-${Date.now()}`,
      name: zone.name,
      type: isGapSpike ? 'gap_spike' : 'chokepoint_congestion',
      lat: cp.lat, lon: cp.lon, severity,
      changePct: zone.deltaPct, windowHours: 24,
      darkShips: darkCount,
      vesselCount: zone.vesselCount, region: cp.region,
      description: isGapSpike
        ? `Traffic drop near ${zone.name}: ${Math.abs(zone.deltaPct)}% below baseline`
        : `Traffic surge at ${zone.name}: +${zone.deltaPct}% above baseline`,
    });
  }
  return disruptions;
}

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
    if (v.speed > 0.5) movingCount++; else anchoredCount++;
  }

  return {
    total: vessels.length,
    moving: movingCount,
    anchored: anchoredCount,
    byType: Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count })),
    topFlags: Object.entries(byFlag).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([flag, count]) => ({ flag, count })),
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
    const disruptions = computeDisruptions(density, vessels);
    const stats = computeVesselStats(vessels);
    const candidateReports = includeCandidates ? vessels.slice(0, 8000) : [];

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
        'Cache-Control': isLive ? 'public, max-age=30, s-maxage=60' : 'public, max-age=60, s-maxage=300',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Snapshot generation failed', detail: String(err) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
