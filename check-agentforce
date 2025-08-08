// Vercel serverless function: /api/check-agentforce
// Env vars (Vercel → Settings → Environment Variables):
// SF_DOMAIN=https://bullhorn--uat.sandbox.my.salesforce.com
// SF_CLIENT_ID=...
// SF_CLIENT_SECRET=...
// ALLOWED_ORIGIN=https://jvguidio.github.io

export default async function handler(req: any, res: any) {
  // CORS: allow your static site to call this endpoint
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const externalId = String(req.query.externalId || '').trim();
    if (!externalId) {
      return res.status(400).json({ error: 'missing_externalId' });
    }

    // 1) Get an app token via Client Credentials (no user interaction)
    const tokenResp = await fetch(`${process.env.SF_DOMAIN}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.SF_CLIENT_ID || '',
        client_secret: process.env.SF_CLIENT_SECRET || ''
      })
    });

    if (!tokenResp.ok) {
      const txt = await tokenResp.text();
      return res.status(502).json({ error: 'token_error', detail: txt });
    }

    const { access_token } = await tokenResp.json();

    // 2) Call your Apex REST to check access
    const apexUrl = `${process.env.SF_DOMAIN}/services/apexrest/CheckAgentforceAccess/${encodeURIComponent(externalId)}`;
    const apexResp = await fetch(apexUrl, {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const bodyText = (await apexResp.text()).trim().toLowerCase();
    const allowed = apexResp.ok && bodyText === 'true';

    return res.status(200).json({
      allowed,
      status: apexResp.status,
      raw: bodyText
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'server_error', detail: String(err) });
  }
}
