// /api/check-agentforce.ts (Vercel - Serverless Function)
// Env vars (Vercel → Settings → Environment Variables):
// SF_DOMAIN=https://bullhorn--uat.sandbox.my.salesforce.com
// SF_TOKEN_HOST=https://bullhorn--uat.sandbox.my.salesforce.com  // My Domain (token host)
// SF_CLIENT_ID=...
// SF_CLIENT_SECRET=...
// ALLOWED_ORIGIN=https://jvguidio.github.io
// REDIS_URL=... (opcional; Upstash Redis HTTP API ou equivalente)

type ApexWrapper = { isAgentforceUser: boolean; userId: string | null };

// ===== Cache de token (memória) =====
type TokenCache = { access_token: string; instance_url?: string; fetched_at: number };
let memToken: TokenCache | null = null;

// ===== Redis opcional (HTTP API simples) =====
async function readRedis(key: string): Promise<TokenCache | null> {
  if (!process.env.REDIS_URL) return null;
  try {
    const r = await fetch(`${process.env.REDIS_URL}/get/${encodeURIComponent(key)}`);
    if (!r.ok) return null;
    const data = await r.json().catch(() => null);
    return data as TokenCache | null;
  } catch {
    return null;
  }
}
async function writeRedis(key: string, val: TokenCache, ttlSec = 45 * 60): Promise<void> {
  if (!process.env.REDIS_URL) return;
  try {
    await fetch(`${process.env.REDIS_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: val, EX: ttlSec })
    });
  } catch {
    // noop
  }
}

const TOKEN_KEY = 'sf:client_credentials:uat';
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

async function fetchSfToken(): Promise<TokenCache> {
  const loginHost =
    process.env.SF_TOKEN_HOST?.trim() ||
    process.env.SF_DOMAIN?.trim() || // fallback seguro: usar My Domain da org
    '';

  if (!loginHost) {
    throw new Error('token_error missing SF_TOKEN_HOST/SF_DOMAIN');
  }

  const url = `${loginHost.replace(/\/+$/, '')}/services/oauth2/token`;
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
      memToken = token;
      await writeRedis(TOKEN_KEY, token, 45 * 60); // TTL conservador (45 min)
      return token;
    }

    lastTxt = await resp.text().catch(() => '');
    // Erros transitórios: invalid_grant/login rate exceeded/request not supported on this domain (pode haver propagação de DNS/políticas)
    if (
      resp.status === 400 &&
      /invalid_grant|login rate exceeded|request not supported on this domain/i.test(lastTxt)
    ) {
      await sleep(300 + Math.floor(Math.random() * 400)); // backoff curto com jitter
      continue;
    }
    break; // outros erros não costumam resolver com retry
  }
  throw new Error(`token_error ${lastTxt}`);
}

async function getSfToken(): Promise<string> {
  // 1) Redis → 2) memória → 3) buscar novo
  const fromRedis = await readRedis(TOKEN_KEY);
  if (fromRedis?.access_token) {
    memToken = fromRedis;
    return fromRedis.access_token;
  }
  if (memToken?.access_token) return memToken.access_token;
  const t = await fetchSfToken();
  return t.access_token;
}

// Chamada ao Apex com auto-refresh se 401/INVALID_SESSION_ID
async function callApexWithAutoRefresh(integrationId: string) {
  const apexUrl = `${(process.env.SF_DOMAIN || '').replace(
    /\/+$/,
    ''
  )}/services/apexrest/CheckAgentforceAccess/${encodeURIComponent(integrationId)}`;

  let token = await getSfToken();
  let resp = await fetch(apexUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    }
  });

  if (resp.status === 401) {
    // sessão inválida/expirada → força refresh e tenta novamente 1x
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
  // CORS
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const integrationId = String(req.query.integrationId || '').trim();
    if (!integrationId) {
      return res.status(400).json({ error: 'missing_integrationId' });
    }

    // Cache de CDN/edge (ajuste s-maxage conforme seu caso)
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');

    // 1) Chama Apex (auto-refresh de token sob 401)
    const apexResp = await callApexWithAutoRefresh(integrationId);

    if (!apexResp.ok) {
      const errText = await apexResp.text().catch(() => '');
      return res
        .status(502)
        .json({ error: 'apex_error', status: apexResp.status, detail: errText });
    }

    const data = (await apexResp.json()) as ApexWrapper;

    const allowed =
      typeof data?.isAgentforceUser === 'boolean' ? data.isAgentforceUser : false;
    const userId = data && 'userId' in data ? (data.userId ?? null) : null;

    return res.status(200).json({ allowed, userId, status: apexResp.status });
  } catch (err: any) {
    return res.status(500).json({ error: 'server_error', detail: String(err) });
  }
}
