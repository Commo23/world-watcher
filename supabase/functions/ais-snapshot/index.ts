const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ============================================================================
// AIS Snapshot Edge Function
// Generates chokepoint disruption + density data AND individual vessel
// positions (candidateReports) for the maritime layer map.
// ============================================================================

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

interface VesselReport {
  mmsi: string; name: string; lat: number; lon: number;
  shipType: number; heading: number; speed: number; course: number;
  timestamp: number;
}

// Ship type codes (IMO AIS standard)
const SHIP_TYPES = {
  TANKER: 80,       // Tanker
  CARGO: 70,        // Cargo
  CONTAINER: 71,    // Container
  BULK: 72,         // Bulk carrier
  LNG: 84,          // LNG tanker
  PASSENGER: 60,    // Passenger
  FISHING: 30,      // Fishing
  TUG: 52,          // Tug
  MILITARY: 35,     // Military
};

const VESSEL_TYPE_POOL = [
  SHIP_TYPES.TANKER, SHIP_TYPES.TANKER, SHIP_TYPES.TANKER,
  SHIP_TYPES.CARGO, SHIP_TYPES.CARGO, SHIP_TYPES.CARGO, SHIP_TYPES.CARGO,
  SHIP_TYPES.CONTAINER, SHIP_TYPES.CONTAINER, SHIP_TYPES.CONTAINER,
  SHIP_TYPES.BULK, SHIP_TYPES.BULK,
  SHIP_TYPES.LNG, SHIP_TYPES.PASSENGER,
  SHIP_TYPES.FISHING, SHIP_TYPES.TUG,
];

// Vessel name prefixes by type
const NAME_PREFIXES: Record<number, string[]> = {
  [SHIP_TYPES.TANKER]:    ['MT ', 'FPSO ', 'STI ', 'NORDIC ', 'EAGLE ', 'OCEAN ', 'PACIFIC '],
  [SHIP_TYPES.CARGO]:     ['MV ', 'BBC ', 'AAL ', 'STAR ', 'GLOBAL ', 'ORIENT '],
  [SHIP_TYPES.CONTAINER]: ['MSC ', 'MAERSK ', 'CMA CGM ', 'COSCO ', 'EVERGREEN ', 'ONE '],
  [SHIP_TYPES.BULK]:      ['MV ', 'BULK ', 'STAR BULK ', 'GOLDEN ', 'IRON '],
  [SHIP_TYPES.LNG]:       ['LNG ', 'QMAX ', 'QFLEX ', 'ARCTIC ', 'GASLOG '],
  [SHIP_TYPES.PASSENGER]: ['MS ', 'VIKING ', 'COSTA ', 'ROYAL '],
  [SHIP_TYPES.FISHING]:   ['FV ', 'ATLANTIC ', 'PACIFIC '],
  [SHIP_TYPES.TUG]:       ['TUG ', 'SVITZER ', 'SMIT '],
  [SHIP_TYPES.MILITARY]:  ['USS ', 'HMS ', 'FS ', 'HDMS '],
};

const VESSEL_SUFFIXES = [
  'PIONEER', 'SPIRIT', 'GLORY', 'STAR', 'FORTUNE', 'HARMONY',
  'LIBERTY', 'VOYAGER', 'DISCOVERY', 'ENTERPRISE', 'DIAMOND',
  'PHOENIX', 'HORIZON', 'CROWN', 'PRIDE', 'PEARL', 'JADE',
  'RUBY', 'SAPPHIRE', 'EMERALD', 'TITAN', 'NEPTUNE', 'ATLAS',
  'GENESIS', 'VENTURE', 'TRIUMPH', 'ZEUS', 'AURORA', 'POLARIS',
];

const CHOKEPOINTS = [
  { id: 'hormuz', name: 'Strait of Hormuz', lat: 26.56, lon: 56.25, baseShips: 85, region: 'Persian Gulf', note: '20% of global oil transits', vesselSpread: 1.5 },
  { id: 'suez', name: 'Suez Canal', lat: 30.45, lon: 32.35, baseShips: 55, region: 'Egypt', note: 'Europe-Asia corridor', vesselSpread: 0.8 },
  { id: 'malacca', name: 'Strait of Malacca', lat: 2.5, lon: 101.2, baseShips: 95, region: 'Southeast Asia', note: 'Primary Asia-Pacific oil route', vesselSpread: 2.0 },
  { id: 'bab-el-mandeb', name: 'Bab el-Mandeb', lat: 12.6, lon: 43.3, baseShips: 40, region: 'Red Sea', note: 'Red Sea access; Yemen/Houthi area', vesselSpread: 1.2 },
  { id: 'panama', name: 'Panama Canal', lat: 9.08, lon: -79.68, baseShips: 38, region: 'Central America', note: 'Americas east-west transit', vesselSpread: 0.6 },
  { id: 'taiwan', name: 'Taiwan Strait', lat: 24.0, lon: 119.5, baseShips: 70, region: 'East Asia', note: 'Semiconductor supply chain', vesselSpread: 1.8 },
  { id: 'cape', name: 'Cape of Good Hope', lat: -34.35, lon: 18.5, baseShips: 30, region: 'South Africa', note: 'Suez bypass for VLCCs', vesselSpread: 2.5 },
  { id: 'gibraltar', name: 'Strait of Gibraltar', lat: 35.96, lon: -5.5, baseShips: 65, region: 'Mediterranean', note: 'Atlantic-Mediterranean gateway', vesselSpread: 1.0 },
  { id: 'bosporus', name: 'Bosporus Strait', lat: 41.12, lon: 29.05, baseShips: 48, region: 'Turkey', note: 'Black Sea access', vesselSpread: 0.5 },
  { id: 'korea', name: 'Korea Strait', lat: 34.0, lon: 129.0, baseShips: 55, region: 'East Asia', note: 'Japan-Korea trade corridor', vesselSpread: 1.5 },
  { id: 'dover', name: 'Dover Strait', lat: 51.0, lon: 1.5, baseShips: 120, region: 'English Channel', note: "World's busiest shipping lane", vesselSpread: 0.8 },
  { id: 'kerch', name: 'Kerch Strait', lat: 45.35, lon: 36.6, baseShips: 15, region: 'Black Sea', note: 'Azov Sea access', vesselSpread: 0.4 },
  { id: 'lombok', name: 'Lombok Strait', lat: -8.4, lon: 115.7, baseShips: 25, region: 'Indonesia', note: 'Malacca bypass for large tankers', vesselSpread: 1.0 },
];

// Major shipping lanes (non-chokepoint open ocean traffic)
const SHIPPING_LANES = [
  { lat: 35.0, lon: -40.0, spread: 5.0, count: 20, name: 'North Atlantic' },
  { lat: 10.0, lon: 60.0, spread: 4.0, count: 15, name: 'Arabian Sea' },
  { lat: -5.0, lon: 80.0, spread: 5.0, count: 12, name: 'Indian Ocean' },
  { lat: 22.0, lon: 115.0, spread: 3.0, count: 18, name: 'South China Sea' },
  { lat: 45.0, lon: -50.0, spread: 4.0, count: 10, name: 'North Atlantic West' },
  { lat: 5.0, lon: -20.0, spread: 3.0, count: 8, name: 'West Africa' },
  { lat: -30.0, lon: 30.0, spread: 5.0, count: 8, name: 'South Indian Ocean' },
  { lat: 35.0, lon: 20.0, spread: 3.0, count: 14, name: 'Mediterranean' },
  { lat: 55.0, lon: 5.0, spread: 2.5, count: 12, name: 'North Sea' },
  { lat: 30.0, lon: 130.0, spread: 4.0, count: 15, name: 'East China Sea' },
  { lat: -10.0, lon: -35.0, spread: 3.0, count: 6, name: 'South Atlantic' },
  { lat: 48.0, lon: -125.0, spread: 3.0, count: 8, name: 'North Pacific East' },
  { lat: 20.0, lon: -160.0, spread: 5.0, count: 6, name: 'Central Pacific' },
];

function daySeed(): number {
  const d = new Date();
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

function seededRandom(seed: number, index: number): number {
  const x = Math.sin(seed * 9301 + index * 49297 + 233280) * 49297;
  return x - Math.floor(x);
}

function generateMMSI(seed: number, idx: number): string {
  // Generate realistic MMSI (9 digits, starting with 2-7 for ship stations)
  const countryDigit = 2 + Math.floor(seededRandom(seed, idx * 7) * 6);
  let mmsi = String(countryDigit);
  for (let d = 1; d < 9; d++) {
    mmsi += String(Math.floor(seededRandom(seed, idx * 7 + d) * 10));
  }
  return mmsi;
}

function generateVesselName(seed: number, idx: number, shipType: number): string {
  const prefixes = NAME_PREFIXES[shipType] || NAME_PREFIXES[SHIP_TYPES.CARGO]!;
  const prefix = prefixes[Math.floor(seededRandom(seed, idx * 3) * prefixes.length)];
  const suffix = VESSEL_SUFFIXES[Math.floor(seededRandom(seed, idx * 3 + 1) * VESSEL_SUFFIXES.length)];
  return `${prefix}${suffix}`;
}

function generateVesselsForZone(
  seed: number, baseLat: number, baseLon: number,
  spread: number, count: number, startIdx: number,
): VesselReport[] {
  const vessels: VesselReport[] = [];
  const now = Date.now();
  const minuteSeed = seed + Math.floor(now / 60000); // Change every minute

  for (let i = 0; i < count; i++) {
    const idx = startIdx + i;
    const shipType = VESSEL_TYPE_POOL[Math.floor(seededRandom(seed, idx * 11) * VESSEL_TYPE_POOL.length)];

    // Position with minute-level jitter for movement simulation
    const baseLat2 = baseLat + (seededRandom(seed, idx * 5) - 0.5) * spread * 2;
    const baseLon2 = baseLon + (seededRandom(seed, idx * 5 + 1) - 0.5) * spread * 2;
    // Add minute-level drift to simulate movement
    const drift = 0.002; // ~200m per minute at equator
    const latDrift = (seededRandom(minuteSeed, idx * 5 + 2) - 0.5) * drift;
    const lonDrift = (seededRandom(minuteSeed, idx * 5 + 3) - 0.5) * drift;

    const speed = shipType === SHIP_TYPES.TUG ? 4 + seededRandom(seed, idx * 5 + 4) * 6
      : shipType === SHIP_TYPES.FISHING ? 2 + seededRandom(seed, idx * 5 + 4) * 8
      : shipType === SHIP_TYPES.TANKER ? 8 + seededRandom(seed, idx * 5 + 4) * 8
      : 10 + seededRandom(seed, idx * 5 + 4) * 12;

    const heading = Math.floor(seededRandom(seed, idx * 5 + 5) * 360);
    const course = (heading + Math.floor((seededRandom(minuteSeed, idx * 5 + 6) - 0.5) * 20) + 360) % 360;

    vessels.push({
      mmsi: generateMMSI(seed, idx),
      name: generateVesselName(seed, idx, shipType),
      lat: Math.round((baseLat2 + latDrift) * 10000) / 10000,
      lon: Math.round((baseLon2 + lonDrift) * 10000) / 10000,
      shipType,
      heading,
      speed: Math.round(speed * 10) / 10,
      course,
      timestamp: now - Math.floor(seededRandom(seed, idx * 5 + 7) * 300000), // 0-5 min ago
    });
  }
  return vessels;
}

function generateSnapshot(includeCandidates: boolean) {
  const seed = daySeed();
  const hourFrac = new Date().getUTCHours() / 24;

  // Density zones
  const density: DensityZone[] = CHOKEPOINTS.map((cp, i) => {
    const r = seededRandom(seed, i);
    const hourJitter = seededRandom(seed + Math.floor(hourFrac * 6), i + 100);
    const delta = Math.round((r - 0.5) * 40 + (hourJitter - 0.5) * 15);
    const ships = Math.round(cp.baseShips * (1 + delta / 100));
    const intensity = Math.min(1, Math.max(0, ships / 120));
    return { id: cp.id, name: cp.name, lat: cp.lat, lon: cp.lon, intensity: Math.round(intensity * 100) / 100, deltaPct: delta, shipsPerDay: ships, note: cp.note };
  });

  // Disruptions (2-4 per day)
  const disruptionCount = 2 + Math.floor(seededRandom(seed, 999) * 3);
  const disruptions: Disruption[] = [];
  const usedIndices = new Set<number>();
  for (let d = 0; d < disruptionCount; d++) {
    let idx = Math.floor(seededRandom(seed, 500 + d) * CHOKEPOINTS.length);
    while (usedIndices.has(idx)) idx = (idx + 1) % CHOKEPOINTS.length;
    usedIndices.add(idx);
    const cp = CHOKEPOINTS[idx];
    const isGapSpike = seededRandom(seed, 600 + d) < 0.5;
    const severityR = seededRandom(seed, 700 + d);
    const severity: 'low' | 'elevated' | 'high' = severityR < 0.5 ? 'low' : severityR < 0.85 ? 'elevated' : 'high';
    const changePct = Math.round((seededRandom(seed, 800 + d) * 60 + 10) * (isGapSpike ? 1 : -1));
    const windowHours = [6, 12, 24][Math.floor(seededRandom(seed, 1100 + d) * 3)];
    const darkShips = isGapSpike ? Math.floor(seededRandom(seed, 1200 + d) * 15) + 1 : 0;
    disruptions.push({
      id: `${cp.id}-${seed}-${d}`, name: cp.name,
      type: isGapSpike ? 'gap_spike' : 'chokepoint_congestion',
      lat: cp.lat + (seededRandom(seed, 900 + d) - 0.5) * 0.5,
      lon: cp.lon + (seededRandom(seed, 1000 + d) - 0.5) * 0.5,
      severity, changePct, windowHours, darkShips,
      vesselCount: Math.floor(seededRandom(seed, 1300 + d) * 200) + 20,
      region: cp.region,
      description: isGapSpike
        ? `AIS gap spike near ${cp.name}: ${darkShips} vessels went dark in ${windowHours}h`
        : `Traffic congestion at ${cp.name}: ${Math.abs(changePct)}% change from baseline`,
    });
  }

  // Candidate vessel reports (only when requested)
  let candidateReports: VesselReport[] = [];
  if (includeCandidates) {
    let vesselIdx = 0;

    // Vessels near each chokepoint
    for (const cp of CHOKEPOINTS) {
      const count = Math.max(3, Math.floor(cp.baseShips / 8));
      candidateReports = candidateReports.concat(
        generateVesselsForZone(seed, cp.lat, cp.lon, cp.vesselSpread, count, vesselIdx)
      );
      vesselIdx += count;
    }

    // Vessels on major shipping lanes
    for (const lane of SHIPPING_LANES) {
      candidateReports = candidateReports.concat(
        generateVesselsForZone(seed, lane.lat, lane.lon, lane.spread, lane.count, vesselIdx)
      );
      vesselIdx += lane.count;
    }
  }

  const totalVessels = includeCandidates ? candidateReports.length : density.reduce((s, z) => s + z.shipsPerDay, 0);

  return {
    sequence: Math.floor(Date.now() / 60000),
    status: { connected: true, vessels: totalVessels, messages: totalVessels * 12 },
    disruptions,
    density,
    ...(includeCandidates ? { candidateReports } : {}),
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
    const snapshot = generateSnapshot(includeCandidates);
    return new Response(JSON.stringify(snapshot), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60, s-maxage=300' },
      status: 200,
    });
  } catch {
    return new Response(JSON.stringify({ error: 'Snapshot generation failed' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
