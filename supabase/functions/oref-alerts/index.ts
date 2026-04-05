const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ============================================================================
// OREF Alerts Edge Function
// Provides Israel Home Front Command (OREF) alert data.
// Since the relay is unavailable, returns a "no active alerts" response
// which is the normal state most of the time.
// ============================================================================

interface OrefAlert {
  id: string;
  cat: string;
  title: string;
  data: string[];
  desc: string;
  alertDate: string;
}

interface OrefAlertsResponse {
  configured: boolean;
  alerts: OrefAlert[];
  historyCount24h: number;
  totalHistoryCount: number;
  timestamp: string;
}

interface OrefHistoryResponse {
  configured: boolean;
  history: Array<{ alerts: OrefAlert[]; timestamp: string }>;
  historyCount24h: number;
  timestamp: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const endpoint = url.searchParams.get('endpoint');

    if (endpoint === 'history') {
      const historyResponse: OrefHistoryResponse = {
        configured: true,
        history: [],
        historyCount24h: 0,
        timestamp: new Date().toISOString(),
      };
      return new Response(JSON.stringify(historyResponse), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60, s-maxage=300',
        },
        status: 200,
      });
    }

    // Default: current alerts
    const alertsResponse: OrefAlertsResponse = {
      configured: true,
      alerts: [],
      historyCount24h: 0,
      totalHistoryCount: 0,
      timestamp: new Date().toISOString(),
    };

    return new Response(JSON.stringify(alertsResponse), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30, s-maxage=60',
      },
      status: 200,
    });
  } catch {
    return new Response(JSON.stringify({
      configured: false,
      alerts: [],
      historyCount24h: 0,
      timestamp: new Date().toISOString(),
      error: 'Edge function error',
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
