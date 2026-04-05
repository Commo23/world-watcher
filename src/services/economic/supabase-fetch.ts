/**
 * Supabase-first fetch wrapper for economic RPC endpoints.
 * Routes supported paths to Lovable Cloud edge functions,
 * falling back to the original URL on failure.
 */

const SUPABASE_URL = (typeof import.meta !== 'undefined' ? import.meta.env?.VITE_SUPABASE_URL : '') || '';
const SUPABASE_FN_BASE = SUPABASE_URL ? `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1` : '';

const SUPABASE_ROUTE_MAP: Record<string, string> = {
  '/api/economic/v1/get-fred-series-batch': 'get-fred-series-batch',
  '/api/economic/v1/get-eu-yield-curve': 'get-eu-yield-curve',
  '/api/economic/v1/get-eurostat-country-data': 'get-eurostat-country-data',
};

export function economicFetch(...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
  if (!SUPABASE_FN_BASE) return globalThis.fetch(...args);

  const input = args[0];
  const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;

  try {
    const url = new URL(urlStr);
    const fnName = SUPABASE_ROUTE_MAP[url.pathname];
    if (fnName) {
      const supabaseUrl = `${SUPABASE_FN_BASE}/${fnName}${url.search}`;
      const init = args[1] ? { ...args[1] } : {};
      const headers = new Headers(init.headers);
      if (!headers.has('Accept')) headers.set('Accept', 'application/json');
      init.headers = headers;
      return globalThis.fetch(supabaseUrl, init).then(async (res) => {
        if (res.ok) return res;
        return globalThis.fetch(...args);
      }).catch(() => globalThis.fetch(...args));
    }
  } catch { /* fall through */ }

  return globalThis.fetch(...args);
}
