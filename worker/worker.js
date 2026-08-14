// Cloudflare Worker — holds the OpenAI key server-side so it never ships to the browser.
// Deploy: npx wrangler deploy   (from inside the worker/ folder)
// Set the secret once: npx wrangler secret put OPENAI_API_KEY

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = origin === env.ALLOWED_ORIGIN;

    const corsHeaders = {
      'Access-Control-Allow-Origin': allowed ? origin : 'null',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    if (!allowed) {
      return new Response('Forbidden origin', { status: 403, headers: corsHeaders });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Invalid JSON', { status: 400, headers: corsHeaders });
    }

    const { title, country, desc, notes } = body || {};
    if (!title || !country) {
      return new Response('Missing title/country', { status: 400, headers: corsHeaders });
    }

    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are an analyst for N2M, a venture studio that turns trend problems into short, buildable MVP briefs. Be concise and concrete.' },
          { role: 'user', content: `Problem: ${title} (${country}). ${desc || ''} Constraints/context from the team: ${notes || 'none given'}. Write a 4-6 sentence tailored MVP brief: what to build first, who the first customer is, and the first KPI to track.` },
        ],
        temperature: 0.6,
      }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      return new Response(JSON.stringify({ error: 'Upstream error', detail: errText }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const json = await upstream.json();
    const text = json.choices?.[0]?.message?.content || 'No response from model.';

    return new Response(JSON.stringify({ text }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  },
};
