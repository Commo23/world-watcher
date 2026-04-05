/**
 * Vercel edge function for the widget agent.
 *
 * Uses Groq or OpenRouter to generate widget HTML via streaming SSE.
 * Falls back gracefully if neither key is configured.
 *
 * GET  → health check
 * POST → SSE stream of widget HTML generation
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from './_cors.js';

const SYSTEM_PROMPT = `You are a dashboard widget generator for CommoHedge Monitor, a real-time global intelligence dashboard.

When the user describes a widget, you MUST respond with a single self-contained HTML snippet that:
- Uses inline CSS (no external stylesheets)
- Can fetch data from public APIs using fetch()
- Has a dark theme by default (background: #1a1a2e, text: #e0e0e0)
- Is responsive and fits in a dashboard panel (~400x300px)
- Includes error handling for API calls
- Uses modern JavaScript (async/await)

Respond ONLY with the HTML. No markdown, no code fences, no explanation.
Start with <div> or <style> directly.`;

function sseEvent(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

function getAiCredentials(): { apiUrl: string; model: string; headers: Record<string, string> } | null {
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    return {
      apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.1-70b-versatile',
      headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
    };
  }
  const orKey = process.env.OPENROUTER_API_KEY;
  if (orKey) {
    return {
      apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'google/gemini-2.5-flash',
      headers: {
        Authorization: `Bearer ${orKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://worldmonitor.app',
      },
    };
  }
  return null;
}

export default async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req) as Record<string, string>;

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-WorldMonitor-Key',
      },
    });
  }

  const creds = getAiCredentials();

  // Health check
  if (req.method === 'GET') {
    return json({ ok: !!creds, widgetKeyConfigured: !!creds, proKeyConfigured: !!creds }, 200, corsHeaders);
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  if (!creds) {
    return json({ error: 'AI not configured — set GROQ_API_KEY or OPENROUTER_API_KEY' }, 503, corsHeaders);
  }

  try {
    const { prompt, mode, currentHtml, conversationHistory } = await req.json() as Record<string, any>;

    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: SYSTEM_PROMPT },
    ];

    if (conversationHistory?.length) {
      for (const msg of conversationHistory.slice(-6)) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    let userContent = prompt;
    if (mode === 'modify' && currentHtml) {
      userContent = `Modify this existing widget HTML:\n\n${currentHtml}\n\nUser request: ${prompt}`;
    }
    messages.push({ role: 'user', content: userContent });

    const aiResponse = await fetch(creds.apiUrl, {
      method: 'POST',
      headers: creds.headers,
      body: JSON.stringify({
        model: creds.model,
        messages,
        stream: true,
      }),
    });

    if (!aiResponse.ok) {
      if (aiResponse.status === 429) return json({ error: 'Rate limited' }, 429, corsHeaders);
      const errText = await aiResponse.text();
      console.error('AI error:', aiResponse.status, errText);
      return json({ error: 'AI service error' }, 500, corsHeaders);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(sseEvent({ type: 'tool_call', endpoint: 'AI model' })));

        let fullContent = '';
        const reader = aiResponse.body!.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });

            let newlineIdx: number;
            while ((newlineIdx = buf.indexOf('\n')) !== -1) {
              let line = buf.slice(0, newlineIdx);
              buf = buf.slice(newlineIdx + 1);
              if (line.endsWith('\r')) line = line.slice(0, -1);
              if (!line.startsWith('data: ')) continue;
              const jsonStr = line.slice(6).trim();
              if (jsonStr === '[DONE]') continue;
              try {
                const parsed = JSON.parse(jsonStr);
                const content = parsed.choices?.[0]?.delta?.content;
                if (content) fullContent += content;
              } catch { /* partial JSON, skip */ }
            }
          }

          let html = fullContent.trim();
          if (html.startsWith('```html')) html = html.slice(7);
          else if (html.startsWith('```')) html = html.slice(3);
          if (html.endsWith('```')) html = html.slice(0, -3);
          html = html.trim();

          const title = prompt.slice(0, 50).replace(/[^\w\s]/g, '').trim() || 'Custom Widget';

          controller.enqueue(encoder.encode(sseEvent({ type: 'html_complete', html })));
          controller.enqueue(encoder.encode(sseEvent({ type: 'done', title })));
        } catch (err) {
          console.error('Stream error:', err);
          controller.enqueue(encoder.encode(sseEvent({
            type: 'error',
            message: err instanceof Error ? err.message : 'Stream failed',
          })));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-store',
        'X-Accel-Buffering': 'no',
        ...corsHeaders,
      },
    });
  } catch (err) {
    console.error('Widget agent error:', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500, corsHeaders);
  }
}
