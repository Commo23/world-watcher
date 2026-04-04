import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      },
    });
  }

  // Health check
  if (req.method === "GET") {
    return new Response(JSON.stringify({ ok: true, widgetKeyConfigured: true, proKeyConfigured: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) {
    return new Response(JSON.stringify({ error: "AI not configured" }), {
      status: 503,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { prompt, mode, currentHtml, conversationHistory } = await req.json();

    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: SYSTEM_PROMPT },
    ];

    // Add conversation history
    if (conversationHistory?.length) {
      for (const msg of conversationHistory.slice(-6)) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    // Build user message
    let userContent = prompt;
    if (mode === "modify" && currentHtml) {
      userContent = `Modify this existing widget HTML:\n\n${currentHtml}\n\nUser request: ${prompt}`;
    }
    messages.push({ role: "user", content: userContent });

    // Call Lovable AI Gateway
    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages,
        stream: true,
      }),
    });

    if (!aiResponse.ok) {
      if (aiResponse.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limited, please try again later" }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResponse.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted" }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const errText = await aiResponse.text();
      console.error("AI gateway error:", aiResponse.status, errText);
      return new Response(JSON.stringify({ error: "AI service error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Stream SSE events in the format WidgetChatModal expects
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(sseEvent({ type: "tool_call", endpoint: "AI model" })));

        let fullContent = "";
        const reader = aiResponse.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });

            let newlineIdx: number;
            while ((newlineIdx = buf.indexOf("\n")) !== -1) {
              let line = buf.slice(0, newlineIdx);
              buf = buf.slice(newlineIdx + 1);
              if (line.endsWith("\r")) line = line.slice(0, -1);
              if (!line.startsWith("data: ")) continue;
              const jsonStr = line.slice(6).trim();
              if (jsonStr === "[DONE]") continue;
              try {
                const parsed = JSON.parse(jsonStr);
                const content = parsed.choices?.[0]?.delta?.content;
                if (content) fullContent += content;
              } catch { /* partial JSON, skip */ }
            }
          }

          // Extract HTML from response (strip markdown fences if present)
          let html = fullContent.trim();
          if (html.startsWith("```html")) html = html.slice(7);
          else if (html.startsWith("```")) html = html.slice(3);
          if (html.endsWith("```")) html = html.slice(0, -3);
          html = html.trim();

          // Extract a title from the prompt
          const title = prompt.slice(0, 50).replace(/[^\w\s]/g, "").trim() || "Custom Widget";

          controller.enqueue(encoder.encode(sseEvent({ type: "html_complete", html })));
          controller.enqueue(encoder.encode(sseEvent({ type: "done", title })));
        } catch (err) {
          console.error("Stream error:", err);
          controller.enqueue(encoder.encode(sseEvent({
            type: "error",
            message: err instanceof Error ? err.message : "Stream failed",
          })));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-store",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    console.error("Widget agent error:", err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
