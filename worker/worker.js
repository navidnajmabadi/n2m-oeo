// Cloudflare Worker — holds the OpenAI key server-side so it never ships to the browser.
// Deploy: npx wrangler deploy   (from inside the worker/ folder)
// Set the secret once: npx wrangler secret put OPENAI_API_KEY
//
// Routes:
//   POST /problems  { country, region }              -> real, live AI-diagnosed trend problems for that market
//   POST /brief      { title, country, desc, notes }  -> tailored MVP brief for one problem

async function callOpenAI(env, messages, jsonMode) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || 'gpt-4o-mini',
      messages,
      temperature: 0.7,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail);
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content || '';
}

async function handleProblems(env, body, corsHeaders) {
  const { country, region } = body || {};
  if (!country) return new Response('Missing country', { status: 400, headers: corsHeaders });

  const sys = 'You are a market analyst for N2M, a venture studio that diagnoses real, current trending business and workforce problems by country and turns the best ones into short MVP briefs. You answer only with valid JSON, no markdown fences, no commentary.';
  const user = `Diagnose 10 real, currently-relevant trending business and workforce problems for SMB owners and employees in ${country} (${region}), as of now. Cover a mix of categories (e.g. AI/tech disruption, compliance/regulation, hiring/talent, payments/finance, customer support, supply chain, energy costs, fraud/trust, localization, retention, sales, marketing) — pick whichever are genuinely most relevant to ${country} right now, not a fixed list.

Return strict JSON: {"problems":[{
  "title": "short headline, one sentence",
  "category": "2-4 word category",
  "tags": ["2 to 3 short tags, e.g. Sales, HR, Compliance"],
  "desc": "1-2 sentence description of the problem",
  "solution": "1-2 sentence short solution/product idea",
  "tam_billion_usd": number (realistic global TAM estimate for this solution category, in billions),
  "sam_billion_usd": number (realistic serviceable addressable market for ${country} specifically, in billions),
  "demand": number 1-5 (market demand strength),
  "feasibility": number 1-5 (feasibility for a small team to build),
  "gtm_ease": number 1-5 (go-to-market ease),
  "white_space": number 1-5 (competitive white space, 5=little competition),
  "founder_fit": number 1-5 (how buildable by a lean/solo team),
  "persona": "primary buyer persona, short phrase",
  "age_range": "e.g. 30-45"
}]}
Exactly 10 problems. Numbers must be realistic and vary across problems (not all the same). JSON only.`;

  const content = await callOpenAI(env, [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ], true);

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Model returned invalid JSON');
  }
  return new Response(JSON.stringify(parsed), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleBrief(env, body, corsHeaders) {
  const { title, country, desc, notes } = body || {};
  if (!title || !country) return new Response('Missing title/country', { status: 400, headers: corsHeaders });

  const text = await callOpenAI(env, [
    { role: 'system', content: 'You are an analyst for N2M, a venture studio that turns trend problems into short, buildable MVP briefs. Be concise and concrete.' },
    { role: 'user', content: `Problem: ${title} (${country}). ${desc || ''} Constraints/context from the team: ${notes || 'none given'}. Write a 4-6 sentence tailored MVP brief: what to build first, who the first customer is, and the first KPI to track.` },
  ], false);

  return new Response(JSON.stringify({ text }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

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

    const path = new URL(request.url).pathname;
    try {
      if (path === '/problems') return await handleProblems(env, body, corsHeaders);
      return await handleBrief(env, body, corsHeaders);
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Upstream error', detail: String(err.message || err) }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};
