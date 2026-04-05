import { toApiUrl } from '@/services/runtime';

export interface HormuzSeries {
  date: string;
  value: number;
}

export interface HormuzChart {
  label: string;
  title: string;
  series: HormuzSeries[];
}

export interface HormuzTrackerData {
  fetchedAt: number;
  updatedDate: string | null;
  title: string | null;
  summary: string | null;
  paragraphs: string[];
  status: 'closed' | 'disrupted' | 'restricted' | 'open';
  charts: HormuzChart[];
  attribution: { source: string; url: string };
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_HORMUZ_URL = SUPABASE_URL
  ? `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/hormuz-tracker`
  : '';

export async function fetchHormuzTracker(): Promise<HormuzTrackerData | null> {
  const url = SUPABASE_HORMUZ_URL || toApiUrl('/api/supply-chain/hormuz-tracker');
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;
    const raw = (await resp.json()) as HormuzTrackerData;
    return raw.attribution ? raw : null;
  } catch {
    return null;
  }
}
