// Cloudflare Worker — holds the OpenAI key server-side so it never ships to the browser.
// Shared by multiple front-ends (N2M, Vivision) — origin allowlist decides who can call it.
// Deploy: npx wrangler deploy   (from inside the worker/ folder)
// Set the secret once: npx wrangler secret put OPENAI_API_KEY
//
// Routes:
//   POST /problems  { region, regionCode, country, category?, force? }
//        -> real, live AI-diagnosed trend problems for that market (+ optional industry).
//           Cached in KV per region+category for 30 days unless force:true.
//        -> legacy shape { country, region } (no regionCode/category) still works, uncached.
//   POST /brief      { title, country, desc, notes }  -> tailored MVP brief for one problem

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days — real-world trends don't move fast

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

function buildProblemsPrompt(region, country, category) {
  const scope = category
    ? `for small and micro businesses in the **${category}** industry in ${region}, ${country}`
    : `for SMB owners and employees in ${region}, ${country}`;

  return `Diagnose 8 real, currently-relevant trending business problems ${scope}, as of now.

Use this validation discipline for every problem before including it — the same logic professional demand-research uses (interest alone is not demand):
1. Interest signal — is there real search/attention volume and a stable or rising trend, not a one-off spike?
2. Intent signal — are people actively searching for solutions/workarounds, asking about it in forums, not just discussing the topic?
3. Spend signal — is there evidence people or businesses already pay to solve something adjacent (competing tools, freelancers hired for it, existing paid services)?
4. Stability — has this been a consistent pain over the last 12 months, not a fad?
5. Whitespace — is the space fragmented enough that a small/lean team could compete, not dominated by one entrenched player?

Only include a problem if it would plausibly clear signals 1-3 at minimum. Weight small/micro business realities (1-15 employees) — cash-strapped, time-poor, non-technical buyers.

Return strict JSON: {"problems":[{
  "title": "short headline, one sentence",
  "category": "2-4 word category",
  "tags": ["2 to 3 short tags, e.g. Sales, HR, Compliance"],
  "desc": "1-2 sentence description of the problem",
  "solution": "1-2 sentence short solution/product idea",
  "tam_billion_usd": number (realistic global TAM estimate for this solution category, in billions),
  "sam_billion_usd": number (realistic serviceable addressable market for ${region} specifically, in billions),
  "demand": number 1-5 (interest+intent signal strength),
  "feasibility": number 1-5 (feasibility for a small team to build),
  "gtm_ease": number 1-5 (go-to-market ease),
  "white_space": number 1-5 (competitive white space, 5=little competition),
  "founder_fit": number 1-5 (how buildable by a lean/solo team),
  "persona": "primary buyer persona, short phrase",
  "age_range": "e.g. 30-45"
}]}
Exactly 8 problems. Numbers must be realistic and vary across problems (not all the same). JSON only.`;
}

async function handleProblems(env, body, corsHeaders) {
  const { country, region, regionCode, category, force } = body || {};
  const regionName = region || country;
  if (!regionName) return new Response('Missing region', { status: 400, headers: corsHeaders });

  const cacheKey = regionCode ? `problems:${regionCode}:${category || 'ALL'}` : null;

  if (cacheKey && !force && env.OEO_CACHE) {
    const cached = await env.OEO_CACHE.get(cacheKey);
    if (cached) {
      return new Response(cached, {
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
      });
    }
  }

  const sys = 'You are a market analyst diagnosing real, current trending business and workforce problems for small and micro businesses, using a disciplined multi-signal demand validation method. You answer only with valid JSON, no markdown fences, no commentary.';
  const user = buildProblemsPrompt(regionName, country || regionName, category);

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
  const responseBody = JSON.stringify(parsed);

  if (cacheKey && env.OEO_CACHE) {
    await env.OEO_CACHE.put(cacheKey, responseBody, { expirationTtl: CACHE_TTL_SECONDS });
  }

  return new Response(responseBody, {
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
  });
}

async function handleBrief(env, body, corsHeaders) {
  const { title, country, desc, notes } = body || {};
  if (!title || !country) return new Response('Missing title/country', { status: 400, headers: corsHeaders });

  const text = await callOpenAI(env, [
    { role: 'system', content: 'You are an analyst who turns diagnosed trend problems into short, buildable MVP briefs. Be concise and concrete.' },
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
