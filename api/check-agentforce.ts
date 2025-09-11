// /api/check-agentforce.ts  (Vercel Serverless Function)
// -----------------------------------------------------------------------------
// Environment variables (Vercel → Settings → Environment Variables):
// SF_DOMAIN=https://bullhorn--uat.sandbox.my.salesforce.com     // Org (Apex REST host)
// SF_TOKEN_HOST=https://bullhorn--uat.sandbox.my.salesforce.com // My Domain used for OAuth token POST
// SF_CLIENT_ID=...                                              // Connected App consumer key
// SF_CLIENT_SECRET=...                                          // Connected App consumer secret
// ALLOWED_ORIGIN=https://jvguidio.github.io                     // CORS allowlist for your front-end
// -----------------------------------------------------------------------------
//
// What this function does:
// 1) Receives a GET with ?integrationId=... from your web page.
// 2) Gets an OAuth access token via OAuth 2.0 Client Credentials (posts to My Domain).
//    - The token is cached in memory to avoid hitting Salesforce login limits.
//    - Transient token errors are retried with small jitter.
// 3) Calls an Apex REST endpoint (CheckAgentforceAccess/{integrationId}).
//    - If the call returns 401 (INVALID_SESSION_ID), it refreshes the token once and retries.
// 4) Returns { allowed, userId } to the browser.
// -----------------------------------------------------------------------------

type ApexWrapper = { isAgentforceUser: boolean; userId: string | null };

// -------- In-memory token cache (persists across warm invocations; reset on cold start)
type TokenCache = { access_token: string; instance_url?: string; fetched_at: number };
let memToken: TokenCache | null = null;

// Small sleep helper for backoff/jitter
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

/**
 * Fetch a new Salesforce OAuth token using the Client Credentials flow.
 * - Posts to My Domain (`SF_TOKEN_HOST`) or falls back to `SF_DOMAIN`.
 * - Retries a few times with jitter on transient 400s (e.g., login rate exceeded).
 * - Stores the token in the in-memory cache.
 */
async function fetchSfToken(): Promise<TokenCache> {
  const loginHost =
    (process.env.SF_TOKEN_HOST || process.env.SF_DOMAIN || '').replace(/\/+$/, '');
  if (!loginHost) throw new Error('token_error missing SF_TOKEN_HOST/SF_DOMAIN');

  const url = `${loginHost}/services/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.SF_CLIENT_ID || '',
    client_secret: process.env.SF_CLIENT_SECRET || ''
  });

  let lastTxt = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'agentforce-proxy/1.0'
      },
      body
    });

    if (resp.ok) {
      const js = await resp.json();
      const token: TokenCache = {
        access_token: js.access_token,
        instance_url: js.instance_url,
        fetched_at: Date.now()
      };
      memToken = token; // cache in memory
      return token;
    }

    // Read error text for diagnostics and retry heuristics
    lastTxt = await resp.text().catch(() => '');

    // Retry only on common transient cases (status 400)
    if (
      resp.status === 400 &&
      /invalid_grant|login rate exceeded|request not supported on this domain/i.test(lastTxt)
    ) {
      await sleep(300 + Math.floor(Math.random() * 400)); // 300–700ms jitter
      continue;
    }
    break; // Non-retriable error → break and throw below
  }

  throw new Error(`token_error ${lastTxt}`);
}

/**
 * Returns a valid access token.
 * - Uses the in-memory cache if present.
 * - Otherwise fetches a new one.
 * Note: Vercel serverless can cold start, so treat this as a best-effort cache.
 */
async function getSfToken(): Promise<string> {
  if (memToken?.access_token) return memToken.access_token;
  const t = await fetchSfToken();
  return t.access_token;
}

/**
 * Calls the Apex REST endpoint with the current token.
 * If Salesforce responds with 401 (INVALID_SESSION_ID), it refreshes the token once and retries.
 */
async function callApexWithAutoRefresh(integrationId: string) {
  const apexHost = (process.env.SF_DOMAIN || '').replace(/\/+$/, '');
  const apexUrl = `${apexHost}/services/apexrest/CheckAgentforceAccess/${encodeURIComponent(
    integrationId
  )}`;

  let token = await getSfToken();

  let resp = await fetch(apexUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    }
  });

  // If session/token is invalidated or expired, refresh and retry once
  if (resp.status === 401) {
    await sleep(150);
    await fetchSfToken();
    token = await getSfToken();
    resp = await fetch(apexUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      }
    });
  }

  return resp;
}

export default async function handler(req: any, res: any) {
  // ----- CORS (lock down to your site)
  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Validate input
    const integrationId = String(req.query.integrationId || '').trim();
    if (!integrationId) {
      return res.status(400).json({ error: 'missing_integrationId' });
    }

    // Hint to CDN/edge to cache responses briefly (tune for your use case)
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');

    // 1) Call Apex with token auto-refresh on 401
    const apexResp = await callApexWithAutoRefresh(integrationId);

    if (!apexResp.ok) {
      const errText = await apexResp.text().catch(() => '');
      return res
        .status(502)
        .json({ error: 'apex_error', status: apexResp.status, detail: errText });
    }

    // 2) Validate/normalize the expected payload
    const data = (await apexResp.json()) as ApexWrapper;
    const allowed =
      typeof data?.isAgentforceUser === 'boolean' ? data.isAgentforceUser : false;
    const userId = data && 'userId' in data ? (data.userId ?? null) : null;

    // 3) Respond to the browser
    return res.status(200).json({ allowed, userId, status: apexResp.status });
  } catch (err: any) {
    return res.status(500).json({ error: 'server_error', detail: String(err) });
  }
}
