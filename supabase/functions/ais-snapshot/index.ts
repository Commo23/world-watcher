const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ============================================================================
// AIS Snapshot Edge Function — Multi-source real-time maritime data
// Sources:
//   1. digitraffic.fi — 18k+ live vessels (Baltic/Nordic, free, no auth)
//   2. IMF PortWatch — Daily chokepoint transit counts (Suez, Panama, Bosporus, Bab el-Mandeb)
//   3. AISStream — Global WebSocket feed (if valid API key)
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
  vesselCount: number; source: string;
  breakdown?: { container: number; tanker: number; bulk: number; cargo: number; other: number };
}

interface Disruption {
  id: string; name: string; type: 'gap_spike' | 'chokepoint_congestion';
  lat: number; lon: number; severity: 'low' | 'elevated' | 'high';
  changePct: number; windowHours: number; darkShips: number;
  vesselCount: number; region: string; description: string;
}

interface ChokepointTransit {
  portId: string; portName: string; date: string;
  total: number; container: number; tanker: number;
  dryBulk: number; generalCargo: number; roro: number;
  capacity: number;
}

// ---- In-memory caches ----
let cachedVessels: VesselReport[] = [];
let cachedMetadata = new Map<string, { name: string; shipType: number; destination: string; flag: string }>();
let cacheTimestamp = 0;
const CACHE_TTL_MS = 90_000;
let inFlightFetch: Promise<VesselReport[]> | null = null;

let cachedTransits: ChokepointTransit[] = [];
let transitCacheTimestamp = 0;
const TRANSIT_CACHE_TTL_MS = 3600_000; // 1 hour for daily data

let metaCacheTimestamp = 0;
const META_CACHE_TTL_MS = 600_000;

// ---- Chokepoint definitions ----
const CHOKEPOINTS = [
  { id: 'hormuz', name: 'Strait of Hormuz', lat: 26.56, lon: 56.25, baseShips: 85, region: 'Persian Gulf', note: '20% of global oil transits', radius: 2.0, imfId: '' },
  { id: 'suez', name: 'Suez Canal', lat: 30.45, lon: 32.35, baseShips: 55, region: 'Egypt', note: 'Europe-Asia corridor', radius: 1.5, imfId: 'chokepoint1' },
  { id: 'malacca', name: 'Strait of Malacca', lat: 2.5, lon: 101.2, baseShips: 95, region: 'Southeast Asia', note: 'Primary Asia-Pacific oil route', radius: 3.0, imfId: '' },
  { id: 'bab-el-mandeb', name: 'Bab el-Mandeb', lat: 12.6, lon: 43.3, baseShips: 40, region: 'Red Sea', note: 'Red Sea access; Yemen/Houthi area', radius: 2.0, imfId: 'chokepoint4' },
  { id: 'panama', name: 'Panama Canal', lat: 9.08, lon: -79.68, baseShips: 38, region: 'Central America', note: 'Americas east-west transit', radius: 1.5, imfId: 'chokepoint2' },
  { id: 'taiwan', name: 'Taiwan Strait', lat: 24.0, lon: 119.5, baseShips: 70, region: 'East Asia', note: 'Semiconductor supply chain', radius: 3.0, imfId: '' },
  { id: 'cape', name: 'Cape of Good Hope', lat: -34.35, lon: 18.5, baseShips: 30, region: 'South Africa', note: 'Suez bypass for VLCCs', radius: 3.0, imfId: '' },
  { id: 'gibraltar', name: 'Strait of Gibraltar', lat: 35.96, lon: -5.5, baseShips: 65, region: 'Mediterranean', note: 'Atlantic-Mediterranean gateway', radius: 1.5, imfId: '' },
  { id: 'bosporus', name: 'Bosporus Strait', lat: 41.12, lon: 29.05, baseShips: 48, region: 'Turkey', note: 'Black Sea access', radius: 1.0, imfId: 'chokepoint3' },
  { id: 'korea', name: 'Korea Strait', lat: 34.0, lon: 129.0, baseShips: 55, region: 'East Asia', note: 'Japan-Korea trade corridor', radius: 2.5, imfId: '' },
  { id: 'dover', name: 'Dover Strait', lat: 51.0, lon: 1.5, baseShips: 120, region: 'English Channel', note: "World's busiest shipping lane", radius: 1.5, imfId: '' },
  { id: 'kerch', name: 'Kerch Strait', lat: 45.35, lon: 36.6, baseShips: 15, region: 'Black Sea', note: 'Azov Sea access', radius: 1.0, imfId: '' },
  { id: 'lombok', name: 'Lombok Strait', lat: -8.4, lon: 115.7, baseShips: 25, region: 'Indonesia', note: 'Malacca bypass for large tankers', radius: 2.0, imfId: '' },
];

// ---- Source 1: Digitraffic.fi (Finnish AIS — 18k+ vessels) ----

async function fetchFromDigitraffic(): Promise<VesselReport[]> {
  try {
    console.log('[AIS] Fetching from digitraffic.fi...');
    const resp = await fetch('https://meri.digitraffic.fi/api/ais/v1/locations', {
      headers: { 'User-Agent': 'WorldMonitor/1.0', 'Accept-Encoding': 'gzip', 'Digitraffic-User': 'WorldMonitor' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) { await resp.text(); return []; }
    const data = await resp.json();
    const features = data?.features;
    if (!Array.isArray(features)) return [];
    console.log(`[AIS] digitraffic: ${features.length} positions`);

    const vessels: VesselReport[] = [];
    for (const f of features) {
      const props = f.properties;
      const coords = f.geometry?.coordinates;
      if (!props || !coords || coords.length < 2) continue;
      const mmsi = String(props.mmsi || '');
      if (!mmsi || mmsi === '0') continue;
      const lon = Number(coords[0]);
      const lat = Number(coords[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;

      const meta = cachedMetadata.get(mmsi);
      vessels.push({
        mmsi, name: meta?.name || '', lat: Math.round(lat * 10000) / 10000, lon: Math.round(lon * 10000) / 10000,
        shipType: meta?.shipType || 0, heading: Number(props.heading) || 0,
        speed: Number(props.sog) || 0, course: Number(props.cog) || 0,
        timestamp: (Number(props.timestampExternal) || Math.floor(Date.now() / 1000)) * 1000,
        navStatus: Number(props.navStat) ?? undefined,
        flag: meta?.flag || '', destination: meta?.destination || '',
      });
    }
    return vessels;
  } catch (e) { console.error('[AIS] digitraffic error:', e); return []; }
}

async function fetchVesselMetadata(): Promise<void> {
  const now = Date.now();
  if (cachedMetadata.size > 0 && (now - metaCacheTimestamp) < META_CACHE_TTL_MS) return;
  try {
    const resp = await fetch('https://meri.digitraffic.fi/api/ais/v1/vessels', {
      headers: { 'User-Agent': 'WorldMonitor/1.0', 'Digitraffic-User': 'WorldMonitor' },
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
        name: String(v.name || '').trim(), shipType: Number(v.shipType) || 0,
        destination: String(v.destination || '').trim(), flag: String(v.countryCode || '').trim(),
      });
    }
    if (newMeta.size > 0) { cachedMetadata = newMeta; metaCacheTimestamp = Date.now(); }
    console.log(`[AIS] Metadata: ${newMeta.size} vessels`);
  } catch (e) { console.error('[AIS] Metadata error:', e); }
}

// ---- Source 2: IMF PortWatch — Daily chokepoint transits ----

async function fetchChokepointTransits(): Promise<ChokepointTransit[]> {
  const now = Date.now();
  if (cachedTransits.length > 0 && (now - transitCacheTimestamp) < TRANSIT_CACHE_TTL_MS) {
    return cachedTransits;
  }
  try {
    console.log('[AIS] Fetching IMF PortWatch chokepoint data...');
    const csvUrl = 'https://hub.arcgis.com/api/v3/datasets/42132aa4e2fc4d41bdaf9a445f688931_0/downloads/data?format=csv&spatialRefId=4326&where=1%3D1';
    const resp = await fetch(csvUrl, {
      headers: { 'User-Agent': 'WorldMonitor/1.0' },
      signal: AbortSignal.timeout(25000),
      redirect: 'follow',
    });
    if (!resp.ok) { await resp.text(); return cachedTransits; }
    const text = await resp.text();
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 2) return cachedTransits;

    // Parse CSV header (may have BOM)
    const header = lines[0].replace(/^\ufeff/, '').split(',');
    const idx = (col: string) => header.indexOf(col);

    // Parse ALL rows and keep latest 60 days per chokepoint
    const allByPort = new Map<string, ChokepointTransit[]>();
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      if (cols.length < header.length) continue;
      const portId = cols[idx('portid')] || '';
      const t: ChokepointTransit = {
        portId,
        portName: cols[idx('portname')] || '',
        date: (cols[idx('date')] || '').slice(0, 10).replace(/\//g, '-'),
        total: Number(cols[idx('n_total')]) || 0,
        container: Number(cols[idx('n_container')]) || 0,
        tanker: Number(cols[idx('n_tanker')]) || 0,
        dryBulk: Number(cols[idx('n_dry_bulk')]) || 0,
        generalCargo: Number(cols[idx('n_general_cargo')]) || 0,
        roro: Number(cols[idx('n_roro')]) || 0,
        capacity: Number(cols[idx('capacity')]) || 0,
      };
      if (!allByPort.has(portId)) allByPort.set(portId, []);
      allByPort.get(portId)!.push(t);
    }

    // Keep latest 60 entries per chokepoint
    const transits: ChokepointTransit[] = [];
    for (const [, portTransits] of allByPort) {
      portTransits.sort((a, b) => b.date.localeCompare(a.date));
      transits.push(...portTransits.slice(0, 60));
    }

    if (transits.length > 0) {
      cachedTransits = transits;
      transitCacheTimestamp = Date.now();
    }
    console.log(`[AIS] PortWatch: ${transits.length} transit records`);
    return transits;
  } catch (e) {
    console.error('[AIS] PortWatch error:', e);
    return cachedTransits;
  }
}

// ---- Source 3: AISStream WebSocket ----

async function fetchFromAISStream(apiKey: string): Promise<VesselReport[]> {
  const vessels = new Map<string, VesselReport>();
  const COLLECT_DURATION_MS = 10000;
  return new Promise<VesselReport[]>((resolve) => {
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      console.log(`[AISStream] Collected ${vessels.size} vessels`);
      resolve(Array.from(vessels.values()));
    }, COLLECT_DURATION_MS);

    let ws: WebSocket;
    try { ws = new WebSocket('wss://stream.aisstream.io/v0/stream'); }
    catch { clearTimeout(timeout); resolve([]); return; }

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
        if (msg?.ERROR) { console.error('[AISStream] Error:', msg.ERROR); return; }
        const meta = msg?.MetaData;
        if (!meta) return;
        const mmsi = String(meta.MMSI || '');
        if (!mmsi || mmsi === '0') return;
        const lat = Number(meta.latitude), lon = Number(meta.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return;
        const posReport = msg?.Message?.PositionReport || msg?.Message?.StandardClassBPositionReport;
        const staticData = msg?.Message?.ShipStaticData;
        const existing = vessels.get(mmsi);
        vessels.set(mmsi, {
          mmsi, name: staticData?.Name || meta.ShipName || existing?.name || '',
          lat: Math.round(lat * 10000) / 10000, lon: Math.round(lon * 10000) / 10000,
          shipType: staticData?.Type || existing?.shipType || 0,
          heading: posReport?.TrueHeading ?? existing?.heading ?? 0,
          speed: posReport?.Sog ?? existing?.speed ?? 0,
          course: posReport?.Cog ?? existing?.course ?? 0,
          timestamp: meta.time_utc ? new Date(meta.time_utc).getTime() : Date.now(),
          flag: meta.country || existing?.flag || '', destination: staticData?.Destination || existing?.destination || '',
        });
      } catch {}
    };
    ws.onerror = () => { clearTimeout(timeout); try { ws.close(); } catch {} resolve(Array.from(vessels.values())); };
    ws.onclose = () => { clearTimeout(timeout); resolve(Array.from(vessels.values())); };
  });
}

// ---- Main vessel fetcher ----

async function getVessels(): Promise<VesselReport[]> {
  const now = Date.now();
  if (cachedVessels.length > 0 && (now - cacheTimestamp) < CACHE_TTL_MS) return cachedVessels;
  if (inFlightFetch) return inFlightFetch;

  inFlightFetch = (async () => {
    const [_, digitrafficVessels] = await Promise.all([fetchVesselMetadata(), fetchFromDigitraffic()]);
    const vesselMap = new Map<string, VesselReport>();
    for (const v of digitrafficVessels) vesselMap.set(v.mmsi, v);

    // Try AISStream for global coverage
    const apiKey = Deno.env.get('AISSTREAM_API_KEY') || '';
    if (apiKey) {
      const aisVessels = await fetchFromAISStream(apiKey);
      console.log(`[AIS] AISStream: ${aisVessels.length} vessels`);
      for (const v of aisVessels) { if (!vesselMap.has(v.mmsi)) vesselMap.set(v.mmsi, v); }
    }

    const vessels = Array.from(vesselMap.values());
    if (vessels.length > 0) { cachedVessels = vessels; cacheTimestamp = Date.now(); }
    return vessels.length > 0 ? vessels : cachedVessels;
  })();

  try { return await inFlightFetch; } finally { inFlightFetch = null; }
}

// ---- Analytics ----

function computeDensityFromVessels(vessels: VesselReport[], transits: ChokepointTransit[]): DensityZone[] {
  // Build latest IMF transit lookup
  const latestTransit = new Map<string, ChokepointTransit>();
  for (const t of transits) {
    const existing = latestTransit.get(t.portId);
    if (!existing || t.date > existing.date) latestTransit.set(t.portId, t);
  }
  // Build 7-day average for delta
  const avgTransit = new Map<string, { avg: number; count: number }>();
  for (const t of transits) {
    const entry = avgTransit.get(t.portId) || { avg: 0, count: 0 };
    entry.avg += t.total;
    entry.count++;
    avgTransit.set(t.portId, entry);
  }

  return CHOKEPOINTS.map((cp) => {
    // Count live AIS vessels near this chokepoint
    const nearby = vessels.filter(v =>
      Math.abs(v.lat - cp.lat) < cp.radius && Math.abs(v.lon - cp.lon) < cp.radius
    );
    const aisCount = nearby.length;

    // Check if IMF data available
    const imfLatest = cp.imfId ? latestTransit.get(cp.imfId) : undefined;
    const imfAvg = cp.imfId ? avgTransit.get(cp.imfId) : undefined;

    let shipsPerDay: number;
    let deltaPct: number;
    let source: string;
    let breakdown: DensityZone['breakdown'] | undefined;

    if (imfLatest && imfLatest.total > 0) {
      // Use IMF data for this chokepoint (actual daily transit counts)
      shipsPerDay = imfLatest.total;
      const avg = imfAvg ? imfAvg.avg / Math.max(1, imfAvg.count) : cp.baseShips;
      deltaPct = Math.round(((shipsPerDay - avg) / Math.max(1, avg)) * 100);
      source = 'imf-portwatch';
      breakdown = {
        container: imfLatest.container,
        tanker: imfLatest.tanker,
        bulk: imfLatest.dryBulk,
        cargo: imfLatest.generalCargo + imfLatest.roro,
        other: Math.max(0, imfLatest.total - imfLatest.container - imfLatest.tanker - imfLatest.dryBulk - imfLatest.generalCargo - imfLatest.roro),
      };
    } else if (aisCount > 0) {
      // Use live AIS vessel count
      shipsPerDay = Math.round(aisCount * 24);
      deltaPct = Math.round(((shipsPerDay - cp.baseShips) / Math.max(1, cp.baseShips)) * 100);
      source = 'ais-live';
      // Classify AIS vessels by type
      const bkdn = { container: 0, tanker: 0, bulk: 0, cargo: 0, other: 0 };
      for (const v of nearby) {
        const t = v.shipType;
        if (t >= 70 && t <= 79) bkdn.cargo++;
        else if (t >= 80 && t <= 89) bkdn.tanker++;
        else bkdn.other++;
      }
      breakdown = bkdn;
    } else {
      shipsPerDay = cp.baseShips;
      deltaPct = 0;
      source = 'baseline';
    }

    const intensity = source !== 'baseline'
      ? Math.min(1, shipsPerDay / (cp.baseShips * 2))
      : 0;

    return {
      id: cp.id, name: cp.name, lat: cp.lat, lon: cp.lon,
      intensity: Math.round(intensity * 100) / 100,
      deltaPct, shipsPerDay, note: cp.note,
      vesselCount: aisCount > 0 ? aisCount : (imfLatest?.total || 0),
      source,
      breakdown,
    };
  });
}

function computeDisruptions(density: DensityZone[], vessels: VesselReport[]): Disruption[] {
  const disruptions: Disruption[] = [];
  for (const zone of density) {
    if (zone.source === 'baseline') continue;
    if (Math.abs(zone.deltaPct) < 15) continue;
    const cp = CHOKEPOINTS.find(c => c.id === zone.id);
    if (!cp) continue;

    const isGapSpike = zone.deltaPct < -15;
    const severity: 'low' | 'elevated' | 'high' =
      Math.abs(zone.deltaPct) > 40 ? 'high' : Math.abs(zone.deltaPct) > 25 ? 'elevated' : 'low';

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
  let movingCount = 0, anchoredCount = 0;

  for (const v of vessels) {
    const type = classifyShipType(v.shipType);
    byType[type] = (byType[type] || 0) + 1;
    if (v.flag) byFlag[v.flag] = (byFlag[v.flag] || 0) + 1;
    if (v.speed > 0.5) movingCount++; else anchoredCount++;
  }

  return {
    total: vessels.length, moving: movingCount, anchored: anchoredCount,
    byType: Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count })),
    topFlags: Object.entries(byFlag).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([flag, count]) => ({ flag, count })),
  };
}

// Build recent transit history for chart rendering
function getTransitHistory(transits: ChokepointTransit[]): Record<string, { date: string; total: number; tanker: number; container: number }[]> {
  const byPort: Record<string, { date: string; total: number; tanker: number; container: number }[]> = {};
  for (const t of transits) {
    if (!byPort[t.portId]) byPort[t.portId] = [];
    byPort[t.portId].push({ date: t.date, total: t.total, tanker: t.tanker, container: t.container });
  }
  // Sort each by date
  for (const key of Object.keys(byPort)) {
    byPort[key].sort((a, b) => a.date.localeCompare(b.date));
  }
  return byPort;
}

// ============================================================================

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const includeCandidates = url.searchParams.get('candidates') === 'true';

    // Fetch all data sources in parallel
    const [vessels, transits] = await Promise.all([getVessels(), fetchChokepointTransits()]);

    const isLive = vessels.length > 0 || transits.length > 0;
    const density = computeDensityFromVessels(vessels, transits);
    const disruptions = computeDisruptions(density, vessels);
    const stats = computeVesselStats(vessels);
    const transitHistory = getTransitHistory(transits);
    const candidateReports = includeCandidates ? vessels.slice(0, 8000) : [];

    const sources: string[] = [];
    if (vessels.length > 0) sources.push(`digitraffic:${vessels.length}`);
    if (transits.length > 0) sources.push(`imf-portwatch:${transits.length}`);

    const snapshot = {
      sequence: Math.floor(Date.now() / 1000),
      status: {
        connected: isLive,
        vessels: vessels.length,
        messages: vessels.length * 12,
        lastUpdate: cacheTimestamp || Date.now(),
        sources,
      },
      source: isLive ? 'ais-live' : 'no-data',
      stats,
      disruptions,
      density,
      transitHistory,
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
    return new Response(JSON.stringify({ error: 'Snapshot failed', detail: String(err) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500,
    });
  }
});
