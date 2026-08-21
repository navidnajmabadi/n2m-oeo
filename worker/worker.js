// Cloudflare Worker — holds API keys server-side so they never ship to the browser.
// Shared by multiple front-ends (N2M, Vivision) — origin allowlist decides who can call it.
// Deploy: npx wrangler deploy   (from inside the worker/ folder)
// Secrets:
//   npx wrangler secret put OPENAI_API_KEY     (required)
//   npx wrangler secret put SERPAPI_KEY        (required — real Google Trends data)
//   npx wrangler secret put REDDIT_CLIENT_ID       (optional, free Reddit "script" app)
//   npx wrangler secret put REDDIT_CLIENT_SECRET   (optional)
// Without the Reddit secrets, Reddit grounding is silently skipped — no fake data.
//
// Routes:
//   POST /general-problems  { country }
//        -> ~10-16 GENERAL problem statements for that country, ranked by REAL Google
//           Trends interest (via SerpApi). Not buildable on their own — no score/TAM.
//   POST /specific-problems { generalTheme, generalStatement, region, regionCode, country, force? }
//        -> 8-12 SPECIFIC, buildable problem statements (MECE breakdown of the general
//           theme, localized to the state/province), Reddit+Suggest grounded, with full
//           scoring/TAM/SAM. Cached per state+theme for 30 days unless force:true.
//   POST /problem-detail    { title, desc, solution, region, country }
//        -> platform, competitors, subscription pricing, editable revenue assumptions
//   POST /brief              { title, country, desc, notes } -> tailored MVP brief
//
// Scheduled (cron): refreshes real Trends interest scores for the theme pool daily,
// see THEME_POOL below and wrangler.toml [triggers].

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // specific problems — 30 days
const GENERAL_CACHE_TTL_SECONDS = 60 * 60 * 24 * 2; // general problems list — 2 days (rebuilds from fresh daily trend scores)
const TREND_SCORE_TTL_SECONDS = 60 * 60 * 24 * 10; // raw per-theme trend score — 10 days (cron refreshes daily anyway)

const INDUSTRIES = [
  "Construction", "Manufacturing & Industrial", "Retail", "E-commerce & Online Shops",
  "Food & Beverage / Hospitality", "Professional Services", "Healthcare", "Transportation & Logistics"
];

// Fixed candidate pool checked against real Google Trends daily. 25 themes / 5 terms
// per SerpApi call = 5 calls/country/day; 2 countries = 10 calls/day — fits the free
// 250/month tier with room to spare (most months have ~21-22 weekdays, not 25).
//
// IMPORTANT: Google Trends' 5-term comparison mode normalizes scores 0-100 WITHIN
// each batch, relative to that batch's own highest-searched term. Scores from
// different batches are NOT directly comparable on their own — a 70 in a batch of
// low-volume terms means something different from a 70 in a batch with one dominant
// term. Fixed by using ANCHOR_TERM as a constant 1st term in every batch (so pool is
// 20 unique themes / 4 per batch + anchor = 5 terms/call), then normalizing every
// theme's score against that batch's anchor score — making all 20 themes genuinely
// cross-comparable as "interest relative to a stable baseline topic."
const ANCHOR_TERM = "small business owner";
const THEME_POOL = [
  "Digital marketing", "Employee retention", "Hiring recruiting", "Small business financing",
  "Business grants", "Health insurance costs", "Regulatory compliance", "Cybersecurity",
  "Supply chain disruption", "Commercial rent", "Customer churn", "E-commerce competition",
  "SEO website", "Social media management", "Inflation rising costs", "Legal contracts",
  "Bookkeeping accounting", "Logistics shipping", "Workplace safety", "Remote work management"
];
const COUNTRY_GEO = { "United States": "US", "Canada": "CA", "US": "US", "CA": "CA" };

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

// ---------------- Real Google Trends via SerpApi ----------------
// pairs[0] must always be the ANCHOR_TERM pair — used to normalize this batch's
// scores so they're comparable against every other batch (see THEME_POOL comment).
// Each pair is {canonical, query}: `query` is what's actually sent to Google (scoped
// with "for small business" so we're not picking up generic/unrelated search intent
// for a bare word like "Cybersecurity"), `canonical` is the clean label we store under.
async function fetchTrendsBatch(env, pairs, geo) {
  const queryTerms = pairs.map(p => p.query);
  const q = queryTerms.join(',');
  const url = `https://serpapi.com/search.json?engine=google_trends&q=${encodeURIComponent(q)}&geo=${geo}&date=today+1-m&data_type=TIMESERIES&api_key=${env.SERPAPI_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('SerpApi request failed: ' + res.status);
  const json = await res.json();
  const timeline = (json.interest_over_time && json.interest_over_time.timeline_data) || [];
  const sums = {}, counts = {};
  pairs.forEach(p => { sums[p.canonical] = 0; counts[p.canonical] = 0; });
  timeline.forEach(point => {
    (point.values || []).forEach(v => {
      const pair = pairs.find(p => p.query.toLowerCase() === String(v.query || '').toLowerCase());
      if (pair) {
        sums[pair.canonical] += Number(v.extracted_value ?? v.value ?? 0);
        counts[pair.canonical] += 1;
      }
    });
  });
  const raw = {};
  pairs.forEach(p => { raw[p.canonical] = counts[p.canonical] ? sums[p.canonical] / counts[p.canonical] : 0; });
  const anchorScore = raw[ANCHOR_TERM] || 0.01; // avoid divide-by-zero; anchor is a common enough phrase it should rarely be 0
  const normalized = {};
  pairs.forEach(p => {
    if (p.canonical === ANCHOR_TERM) return;
    normalized[p.canonical] = Math.round((raw[p.canonical] / anchorScore) * 100); // 100 = same interest as the anchor phrase itself
  });
  return normalized;
}

function scopedQuery(theme) {
  // Tested 3 variants with real SerpApi calls: bare term (good spread, some generic-
  // search noise), "X for small business" (too literal a phrase — most themes flatten
  // to 0), "X small business" (skews hard toward whichever theme has a common natural
  // search combo, e.g. "business grants" — most others flatten to 0). Bare term gave
  // the best usable spread across the whole pool; scoping precision cost coverage.
  return theme;
}

async function refreshTrendScores(env) {
  const results = { US: {}, CA: {} };
  const anchorPair = { canonical: ANCHOR_TERM, query: ANCHOR_TERM };
  for (const geo of ['US', 'CA']) {
    for (let i = 0; i < THEME_POOL.length; i += 4) {
      const batchThemes = THEME_POOL.slice(i, i + 4);
      const pairs = [anchorPair, ...batchThemes.map(t => ({ canonical: t, query: scopedQuery(t) }))];
      try {
        const scores = await fetchTrendsBatch(env, pairs, geo);
        Object.assign(results[geo], scores);
      } catch (e) {
        // leave this batch's themes unscored this run; next day's cron retries
      }
    }
  }
  if (env.OEO_CACHE) {
    for (const geo of ['US', 'CA']) {
      await env.OEO_CACHE.put(`trendscores:${geo}`, JSON.stringify({ scores: results[geo], updatedAt: Date.now() }), { expirationTtl: TREND_SCORE_TTL_SECONDS });
    }
  }
  return results;
}

// ---------------- Real Reddit grounding via OAuth ----------------
let redditTokenCache = { token: null, exp: 0 };
async function getRedditToken(env) {
  if (!env.REDDIT_CLIENT_ID || !env.REDDIT_CLIENT_SECRET) return null;
  if (redditTokenCache.token && Date.now() < redditTokenCache.exp) return redditTokenCache.token;
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'OEO-VivisionWorker/1.0',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) return null;
  const json = await res.json();
  if (!json.access_token) return null;
  redditTokenCache = { token: json.access_token, exp: Date.now() + (json.expires_in - 60) * 1000 };
  return json.access_token;
}
async function fetchRedditSignal(env, query) {
  try {
    const token = await getRedditToken(env);
    if (!token) return '';
    const res = await fetch(`https://oauth.reddit.com/search?q=${encodeURIComponent(query)}&sort=relevance&t=year&limit=6`, {
      headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'OEO-VivisionWorker/1.0' },
    });
    if (!res.ok) return '';
    const json = await res.json();
    const posts = (json.data && json.data.children) || [];
    if (!posts.length) return '';
    return posts.map(p => `r/${p.data.subreddit}: "${p.data.title}" (${p.data.score} upvotes)`).join('\n');
  } catch {
    return '';
  }
}

// ---------------- Real Google Suggest (free, no auth) ----------------
async function fetchGoogleSuggest(query) {
  try {
    const res = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OEO-VivisionWorker/1.0)' },
    });
    if (!res.ok) return [];
    const json = await res.json();
    return (json[1] || []).slice(0, 8);
  } catch {
    return [];
  }
}
async function fetchSuggestSignal(region) {
  const queries = [
    `small business owners in ${region}`,
    `${region} small business biggest`,
    `small business owners struggle with`,
  ];
  const results = await Promise.all(queries.map(fetchGoogleSuggest));
  return [...new Set(results.flat())].filter(Boolean);
}

// ---------------- /general-problems ----------------
async function handleGeneralProblems(env, body, corsHeaders) {
  const { country } = body || {};
  const geo = COUNTRY_GEO[country];
  if (!geo) return new Response('Missing/unknown country', { status: 400, headers: corsHeaders });

  const cacheKey = `general:${geo}`;
  if (!body.force && env.OEO_CACHE) {
    const cached = await env.OEO_CACHE.get(cacheKey);
    if (cached) return new Response(cached, { headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Cache': 'HIT' } });
  }

  let trendData = env.OEO_CACHE ? await env.OEO_CACHE.get(`trendscores:${geo}`, 'json') : null;
  if (!trendData) {
    // Bootstrap: no cron run yet for this geo — fetch live now (costs real SerpApi credits once).
    const fresh = await refreshTrendScores(env);
    trendData = { scores: fresh[geo], updatedAt: Date.now() };
  }
  const scores = trendData.scores || {};
  const ranked = THEME_POOL.map(t => ({ theme: t, score: scores[t] || 0 })).sort((a, b) => b.score - a.score);
  const top = ranked.slice(0, 14).filter(r => r.score > 0);
  if (!top.length) return new Response('No trend data available yet', { status: 503, headers: corsHeaders });

  const sys = 'You turn raw trend-topic keywords into properly framed GENERAL business problem statements for small/micro business owners. A general statement names the symptom area — it is NOT a buildable product on its own (no numbers, no build spec). You answer only with valid JSON, no markdown fences.';
  const user = `Country: ${country}. These topics showed real, measured search interest (Google Trends, past 30 days, ranked highest first — score is search volume relative to a "small business owner" baseline, so 100 = same interest as that baseline phrase, higher = more searched):
${top.map((r, i) => `${i + 1}. "${r.theme}" (relative interest ${r.score})`).join('\n')}

For each, write a proper general problem statement — the symptom small/micro business owners face, one sentence, specific enough to be meaningful but NOT a product spec. Return strict JSON:
{"generalProblems":[{"theme":"the original topic keyword, exact match","statement":"one-sentence general problem statement","trendScore":number (the interest score given above)}]}
Same order as given (highest interest first). JSON only.`;

  const content = await callOpenAI(env, [{ role: 'system', content: sys }, { role: 'user', content: user }], true);
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Model returned invalid JSON');
  }
  parsed.updatedAt = trendData.updatedAt;
  const responseBody = JSON.stringify(parsed);
  if (env.OEO_CACHE) await env.OEO_CACHE.put(cacheKey, responseBody, { expirationTtl: GENERAL_CACHE_TTL_SECONDS });
  return new Response(responseBody, { headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Cache': 'MISS' } });
}

// ---------------- /specific-problems ----------------
function buildSpecificPrompt(generalStatement, region, country, redditSignal, suggestSignal) {
  const groundingParts = [];
  if (redditSignal) groundingParts.push(`Real Reddit discussion signal for this region (genuine evidence, weight problems it supports more heavily):\n${redditSignal}`);
  if (suggestSignal && suggestSignal.length) groundingParts.push(`Real Google autocomplete phrases for this region (genuine search-behavior signal):\n${suggestSignal.map(s => `- "${s}"`).join('\n')}`);
  const groundingBlock = groundingParts.length ? `\n\n${groundingParts.join('\n\n')}\n` : '';

  return `General problem (already validated as a real trend): "${generalStatement}"

Break this GENERAL problem into 10 SPECIFIC, narrow, buildable problem statements for small/micro business owners (1-15 employees) in ${region}, ${country} — a MECE decomposition, each independently buildable as ONE narrow self-serve software product (not a suite). Example of the level of specificity required: under "lacks digital marketing expertise" → "content generation", "auto-publish scheduling", "ICP/target market identification", "SEO", "campaign design", "churn analytics" — NOT another restatement of the general problem.
${groundingBlock}
Use this validation discipline for every specific problem before including it:
1. Interest signal — real search/attention volume for this specific angle
2. Intent signal — people actively searching for solutions/workarounds for this specific angle
3. Spend signal — evidence people/businesses already pay for something adjacent
4. Stability — a consistent pain, not a fad
5. Whitespace — fragmented enough a small/lean team could compete

Score HONESTLY with real variety — most problems land 2-4 on each factor; a 5 is rare and must be justified. Do not give most problems similar high scores.

For each, identify which of these 8 industries it applies to and priority within each (1-3 industries per problem):
${INDUSTRIES.join(', ')}

Return strict JSON: {"problems":[{
  "title": "short headline, one sentence, SPECIFIC not general",
  "industries": [{"name": "one of the 8 industries above, exact match", "priority": "High, Medium, or Low"}],
  "tags": ["2-3 short functional tags"],
  "desc": "1-2 sentence description",
  "solution": "1-2 sentence short solution/product idea",
  "tam_billion_usd": number,
  "sam_billion_usd": number (for ${region} specifically),
  "demand": number 1-5, "feasibility": number 1-5, "gtm_ease": number 1-5, "white_space": number 1-5, "founder_fit": number 1-5,
  "persona": "primary buyer persona, short phrase",
  "age_range": "e.g. 30-45"
}]}
Exactly 10 problems. JSON only, no markdown fences.`;
}

async function handleSpecificProblems(env, body, corsHeaders) {
  const { generalTheme, generalStatement, region, regionCode, country, force } = body || {};
  if (!region || !generalStatement) return new Response('Missing region/generalStatement', { status: 400, headers: corsHeaders });

  const cacheKey = regionCode ? `specific:${regionCode}:${generalTheme}` : null;
  if (cacheKey && !force && env.OEO_CACHE) {
    const cached = await env.OEO_CACHE.get(cacheKey);
    if (cached) return new Response(cached, { headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Cache': 'HIT' } });
  }

  const [redditSignal, suggestSignal] = await Promise.all([
    fetchRedditSignal(env, `${generalTheme} small business ${region}`),
    fetchSuggestSignal(region),
  ]);

  const sys = 'You are a market analyst decomposing a validated general business problem into specific, buildable sub-problems using a disciplined multi-signal demand validation method. You score honestly with realistic variety, never inflating scores. You answer only with valid JSON, no markdown fences, no commentary.';
  const user = buildSpecificPrompt(generalStatement, region, country || region, redditSignal, suggestSignal);

  const content = await callOpenAI(env, [{ role: 'system', content: sys }, { role: 'user', content: user }], true);
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Model returned invalid JSON');
  }
  parsed.groundedByReddit = !!redditSignal;
  parsed.groundedBySuggest = suggestSignal.length > 0;
  const responseBody = JSON.stringify(parsed);
  if (cacheKey && env.OEO_CACHE) await env.OEO_CACHE.put(cacheKey, responseBody, { expirationTtl: CACHE_TTL_SECONDS });
  return new Response(responseBody, { headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Cache': 'MISS' } });
}

// ---------------- /problem-detail ----------------
async function handleProblemDetail(env, body, corsHeaders) {
  const { title, desc, solution, region, country, force } = body || {};
  if (!title || !region) return new Response('Missing title/region', { status: 400, headers: corsHeaders });

  const cacheKey = `detail:${region}:${title}`.slice(0, 500);
  if (!force && env.OEO_CACHE) {
    const cached = await env.OEO_CACHE.get(cacheKey);
    if (cached) return new Response(cached, { headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Cache': 'HIT' } });
  }

  const sys = 'You are a blunt, honest startup analyst. You never produce hockey-stick hype projections. Real micro-SaaS/SMB tools typically start with 1-5 paying customers in month 1 and grow slowly, with realistic monthly churn (5-12% is typical for low-price SMB tools). You propose conservative default assumptions, not optimistic ones. You answer only with valid JSON, no markdown fences.';
  const user = `Problem: "${title}" in ${region}, ${country}. ${desc || ''} Proposed solution: ${solution || ''}

Write an honest, non-hype mini business plan for this as a self-serve software product. Instead of a baked revenue curve, give NUMERIC ASSUMPTIONS a reader can adjust themselves. Return strict JSON:
{
  "platform": "1 sentence: exact product form, e.g. 'Web app + Chrome extension' or 'Mobile app (iOS/Android)' or 'Shopify app'",
  "competitors": [{"name":"plausible real or realistic-sounding competitor/alternative","note":"1 short phrase on how they fall short or why whitespace remains"}] (2-4 items),
  "subscription_fee_usd": number (realistic monthly price in USD for a micro-SaaS targeting 1-15 person businesses, e.g. 19, 29, 49),
  "starting_customers_m1": number (realistic paying customers by end of month 1 — usually 0-5, be conservative),
  "monthly_new_customers": number (realistic average NEW paying customers added per month from here, usually 1-8 for a self-serve tool with no paid ads),
  "monthly_churn_rate_pct": number (realistic monthly churn %, typically 5-12 for low-price SMB SaaS),
  "monthly_marketing_cost_usd": number (realistic monthly spend on marketing/tools to sustain that growth rate, usually $0-500 for organic-led growth),
  "honest_note": "1-2 sentences, blunt reality check on what has to go right for this to work, and the realistic odds"
}
JSON only.`;

  const content = await callOpenAI(env, [{ role: 'system', content: sys }, { role: 'user', content: user }], true);
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Model returned invalid JSON');
  }
  const responseBody = JSON.stringify(parsed);
  if (env.OEO_CACHE) await env.OEO_CACHE.put(cacheKey, responseBody, { expirationTtl: CACHE_TTL_SECONDS });
  return new Response(responseBody, { headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Cache': 'MISS' } });
}

// ---------------- /brief ----------------
async function handleBrief(env, body, corsHeaders) {
  const { title, country, desc, notes } = body || {};
  if (!title || !country) return new Response('Missing title/country', { status: 400, headers: corsHeaders });

  const text = await callOpenAI(env, [
    { role: 'system', content: 'You are an analyst who turns diagnosed trend problems into short, buildable MVP briefs. Be concise and concrete.' },
    { role: 'user', content: `Problem: ${title} (${country}). ${desc || ''} Constraints/context from the team: ${notes || 'none given'}. Write a 4-6 sentence tailored MVP brief: what to build first, who the first customer is, and the first KPI to track.` },
  ], false);

  return new Response(JSON.stringify({ text }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// ---------------- /refresh-trends (manual bootstrap/testing trigger) ----------------
async function handleRefreshTrends(env, corsHeaders) {
  const results = await refreshTrendScores(env);
  return new Response(JSON.stringify({ ok: true, results }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    if (!allowed) return new Response('Forbidden origin', { status: 403, headers: corsHeaders });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Invalid JSON', { status: 400, headers: corsHeaders });
    }

    const path = new URL(request.url).pathname;
    try {
      if (path === '/general-problems') return await handleGeneralProblems(env, body, corsHeaders);
      if (path === '/specific-problems') return await handleSpecificProblems(env, body, corsHeaders);
      if (path === '/problem-detail') return await handleProblemDetail(env, body, corsHeaders);
      if (path === '/refresh-trends') return await handleRefreshTrends(env, corsHeaders);
      return await handleBrief(env, body, corsHeaders);
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Upstream error', detail: String(err.message || err) }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshTrendScores(env));
  },
};
