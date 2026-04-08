import { corsHeaders } from "@supabase/supabase-js/cors";

// In-memory token cache (persists across warm invocations)
let cachedToken: { access_token: string; refresh_token: string; expires_at: number } | null = null;

async function getAccessToken(): Promise<string> {
  // Return cached token if still valid (with 5 min buffer)
  if (cachedToken && Date.now() < cachedToken.expires_at - 300_000) {
    return cachedToken.access_token;
  }

  // Try refresh if we have a refresh token
  if (cachedToken?.refresh_token) {
    try {
      const refreshRes = await fetch("https://acleddata.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: cachedToken.refresh_token,
          client_id: "acled",
        }),
      });
      if (refreshRes.ok) {
        const data = await refreshRes.json();
        cachedToken = {
          access_token: data.access_token,
          refresh_token: data.refresh_token || cachedToken.refresh_token,
          expires_at: Date.now() + (data.expires_in ?? 86400) * 1000,
        };
        return cachedToken.access_token;
      }
      await refreshRes.text(); // consume body
    } catch {
      // Fall through to password grant
    }
  }

  // Password grant
  const email = Deno.env.get("ACLED_EMAIL");
  const password = Deno.env.get("ACLED_PASSWORD");
  if (!email || !password) {
    throw new Error("ACLED_EMAIL and ACLED_PASSWORD secrets are not configured");
  }

  const res = await fetch("https://acleddata.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: email,
      password: password,
      grant_type: "password",
      client_id: "acled",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ACLED OAuth failed [${res.status}]: ${body}`);
  }

  const data = await res.json();
  cachedToken = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 86400) * 1000,
  };
  return cachedToken.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    
    // Extract query params to forward to ACLED API
    const endpoint = url.searchParams.get("endpoint") || "acled/read";
    
    // Build ACLED API URL with all params except 'endpoint'
    const acledParams = new URLSearchParams();
    for (const [key, value] of url.searchParams.entries()) {
      if (key !== "endpoint") {
        acledParams.set(key, value);
      }
    }

    // Default sensible params if not provided
    if (!acledParams.has("limit")) acledParams.set("limit", "500");

    const token = await getAccessToken();
    const acledUrl = `https://acleddata.com/api/${endpoint}?${acledParams.toString()}`;

    const acledRes = await fetch(acledUrl, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
        "User-Agent": "CommoHedge-Monitor/1.0",
      },
    });

    if (!acledRes.ok) {
      const body = await acledRes.text();
      // If 401, clear token cache and retry once
      if (acledRes.status === 401 && cachedToken) {
        cachedToken = null;
        const retryToken = await getAccessToken();
        const retryRes = await fetch(acledUrl, {
          headers: {
            "Authorization": `Bearer ${retryToken}`,
            "Accept": "application/json",
            "User-Agent": "CommoHedge-Monitor/1.0",
          },
        });
        if (retryRes.ok) {
          const retryData = await retryRes.json();
          return new Response(JSON.stringify(retryData), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const retryBody = await retryRes.text();
        return new Response(JSON.stringify({ error: `ACLED API error after retry [${retryRes.status}]: ${retryBody}` }), {
          status: retryRes.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: `ACLED API error [${acledRes.status}]: ${body}` }), {
        status: acledRes.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await acledRes.json();
    return new Response(JSON.stringify(data), {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=900", // 15 min cache
      },
    });
  } catch (error: unknown) {
    console.error("ACLED proxy error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
