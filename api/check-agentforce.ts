// /api/check-agentforce.ts (Vercel)
// Env vars (Vercel → Settings → Environment Variables):
// SF_DOMAIN=https://bullhorn--uat.sandbox.my.salesforce.com
// SF_LOGIN_HOST=https://test.salesforce.com
// SF_CLIENT_ID=...
// SF_CLIENT_SECRET=...
// ALLOWED_ORIGIN=https://jvguidio.github.io
// REDIS_URL=... (opcional; Upstash Redis)

type ApexWrapper = { isAgentforceUser: boolean; userId: string | null };

// ===== Token cache (mem) =====
type TokenCache = { access_token: string; instance_url?: string; fetched_at: number };
let memToken: TokenCache | null = null;

// ===== Redis opcional =====
async function readRedis(key: string): Promise<TokenCache | null> {
  if (!process.env.REDIS_URL) return null;
  try {
    const r = await fetch(`${process.env.REDIS_URL}/get/${encodeURIComponent(key)}`);
    if (!r.ok) return null;
    const data = await r.json().catch(() => null);
    return data as TokenCache | null;
  } catch { return null; }
}
async function writeRedis(key: string, val: TokenCache, ttlSec = 3600): Promise<void> {
  if (!process.env.REDIS_URL) return;
  try {
    await fetch(`${process.env.REDIS_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: val, EX: ttlSec })
    });
  } catch { /* noop */ }
}

const TOKEN_KEY = 'sf:client_credentials:uat';

// Pequeno helper de espera
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

async function fetchSfToken(): Promise<TokenCache> {
  const loginHost = process.env.SF_LOGIN_HOST || 'https://test.salesforce.com'; // sandbox por padrão
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
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'agentforce-proxy/1.0' },
      body
    });

    if (resp.ok) {
      const js = await resp.json();
      const token: TokenCache = {
        access_token: js.access_token,
        instance_url: js.instance_url,
        fetched_at: Date.now()
      };
      // guarda em memória e Redis (TTL conservador de 45min para reduzir logins)
      memToken = token;
      await writeRedis(TOKEN_KEY, token, 45 * 60);
      return token;
    }

    lastTxt = await resp.text().catch(() => '');
    // throttling/transiente — faça backoff curto com jitter
    if (resp.status === 400 && /invalid_grant|login rate exceeded/i.test(lastTxt)) {
      await sleep(300 + Math.floor(Math.random() * 400));
      continue;
    }
    break; // outros erros não costumam resolver com retry
  }
  throw new Error(`token_error ${lastTxt}`);
}

// Lê token do cache (Redis → memória) ou busca um novo
async function getSfToken(): Promise<string> {
  // 1) Redis
  const fromRedis = await readRedis(TOKEN_KEY);
  if (fromRedis?.access_token) {
    memToken = fromRedis;
    return fromRedis.access_token;
  }
  // 2) Memória
  if (memToken?.access_token) return memToken.access_token;
  // 3) Buscar novo
  const t = await fetchSfToken();
  return t.access_token;
}

// Chama Apex; se 401, renova token e tenta de novo 1x
async function callApexWithAutoRefresh(integrationId: string) {
  const apexUrl = `${process.env.SF_DOMAIN}/services/apexrest/CheckAgentforceAccess/${encodeURIComponent(integrationId)}`;

  let token = await getSfToken();
  let resp = await fetch(apexUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    }
  });

  if (resp.status === 401) {
    // INVALID_SESSION_ID: renova e tenta novamente uma vez
    await sleep(150); // micro backoff
    await fetchSfToken(); // força refresh
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
  // CORS
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const integrationId = String(req.query.integrationId || '').trim();
    if (!integrationId) return res.status(400).json({ error: 'missing_integrationId' });

    // (Opcional) headers para ajudar caching intermediário (ajuste conforme necessário)
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');

    // 1) Chama Apex com auto-refresh de token sob 401
    const apexResp = await callApexWithAutoRefresh(integrationId);

    if (!apexResp.ok) {
      const errText = await apexResp.text().catch(() => '');
      return res.status(502).json({ error: 'apex_error', status: apexResp.status, detail: errText });
    }

    const data = (await apexResp.json()) as ApexWrapper;
    const allowed = typeof data?.isAgentforceUser === 'boolean' ? data.isAgentforceUser : false;
    const userId = data && 'userId' in data ? (data.userId ?? null) : null;

    return res.status(200).json({ allowed, userId, status: apexResp.status });
  } catch (err: any) {
    return res.status(500).json({ error: 'server_error', detail: String(err) });
  }
}
