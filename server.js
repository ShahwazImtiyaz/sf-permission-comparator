import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';
import crypto from 'node:crypto';
import { execSync, exec, execFile } from 'node:child_process';

function execAsync(cmd, opts) {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: 'utf8', ...opts }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

function execFileAsync(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', ...opts }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}
import { detectOrgSessions } from './chrome-session.js';

// ── OAuth PKCE in-memory stores (cleared on restart — acceptable for short-lived codes) ──
const pkceStore = new Map();    // state → { codeVerifier, redirectUri, loginHost, expires }
const authCodeStore = new Map(); // tempCode → { accessToken, instanceUrl, expires }

// Evict expired entries every 5 minutes so the maps don't grow unboundedly
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pkceStore) if (v.expires < now) pkceStore.delete(k);
  for (const [k, v] of authCodeStore) if (v.expires < now) authCodeStore.delete(k);
}, 5 * 60 * 1000).unref();

function getOAuthConfigPath() {
  return path.join(os.homedir(), '.sf-comparator', 'oauth-config.json');
}
function readOAuthConfig() {
  try { return JSON.parse(fs.readFileSync(getOAuthConfigPath(), 'utf8')); } catch { return {}; }
}
function writeOAuthConfig(data) {
  const dir = path.join(os.homedir(), '.sf-comparator');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getOAuthConfigPath(), JSON.stringify(data, null, 2));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// CSRF protection: reject cross-origin mutating requests from other origins
app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin) {
      const host = req.headers.host || '';
      if (origin !== `http://${host}` && origin !== `https://${host}`) {
        return res.status(403).json({ error: 'Forbidden: cross-origin request rejected' });
      }
    }
  }
  next();
});

const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));

function getSfdxDir() { return path.join(os.homedir(), '.sfdx'); }

function readAliases() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(getSfdxDir(), 'alias.json'), 'utf8'));
    const orgs = raw.orgs || raw;
    return Object.fromEntries(Object.entries(orgs).map(([a, u]) => [u, a]));
  } catch { return {}; }
}

function readOrgFiles() {
  const dir = getSfdxDir();
  const aliases = readAliases();
  const orgs = [];
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f.includes('@'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (!data.accessToken || !data.instanceUrl) continue;
        orgs.push({ username: data.username, instanceUrl: data.instanceUrl, orgId: data.orgId,
          orgName: data.name || '', alias: aliases[data.username] || '',
          isSandbox: data.isSandbox || false, orgEdition: data.orgEdition || '' });
      } catch {}
    }
  } catch {}
  return orgs.sort((a, b) => (a.alias || a.username).localeCompare(b.alias || b.username));
}

app.get('/api/orgs', async (_req, res) => {
  const orgs = readOrgFiles();
  if (!orgs.length) return res.status(404).json({ error: 'No Salesforce CLI orgs found. Run "sf org login web" first.' });

  const validated = await Promise.all(orgs.map(async org => {
    try {
      const raw = await execFileAsync(
        'sf', ['org', 'auth', 'show-access-token', '--target-org', org.username, '--no-prompt', '--json'],
        { timeout: 8000 }
      );
      const token = JSON.parse(raw)?.result?.accessToken;
      if (!token) return null;
      const check = await sfGet(`${org.instanceUrl}/services/data/v60.0/`, token);
      if (Array.isArray(check) && check[0]?.errorCode) return null;
      return org;
    } catch { return null; }
  }));

  const active = validated.filter(Boolean);
  if (!active.length) return res.status(404).json({ error: 'No active sessions found. Try: sf org login web' });
  res.json(active);
});

app.post('/api/org-session', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  // Strict allowlist: Salesforce usernames are email-like with optional .sandbox suffix
  if (!/^[a-zA-Z0-9@._+\-]+$/.test(username)) {
    return res.status(400).json({ error: 'Invalid username format' });
  }
  try {
    const raw = await execFileAsync(
      'sf', ['org', 'auth', 'show-access-token', '--target-org', username, '--no-prompt', '--json'],
      { timeout: 15000 }
    );
    const token = JSON.parse(raw)?.result?.accessToken;
    if (!token) return res.status(500).json({ error: 'Could not retrieve token. Try: sf org login web' });
    const fileData = JSON.parse(fs.readFileSync(path.join(getSfdxDir(), `${username}.json`), 'utf8'));
    res.json({ accessToken: token, instanceUrl: fileData.instanceUrl });
  } catch (e) {
    res.status(500).json({ error: `Session error: ${e.message}` });
  }
});

function getOpenChromeTabs() {
  try {
    const out = execSync(
      `osascript -e 'tell application "Google Chrome" to return URL of every tab of every window'`,
      { encoding: 'utf8', timeout: 3000 }
    );
    return out.split(',').map(u => u.trim().toLowerCase());
  } catch { return null; }
}

app.get('/api/chrome-orgs', async (_req, res) => {
  try {
    const sessions = detectOrgSessions();
    const openTabs = getOpenChromeTabs(); // null = can't check (skip tab filter)
    // Filter by open Chrome tab only — no REST API validation call.
    // Making a live API call with the browser's sid cookie can trigger Salesforce
    // session security (IP-locked or high-assurance sessions) and log the user
    // out of their browser session.
    const result = sessions
      .filter(s => openTabs === null || openTabs.some(url =>
        url.includes(s.apiHost) ||      // matches .my.salesforce.com tabs
        url.includes(`${s.label}.`)     // matches .lightning.force.com, -setup.com, etc.
      ))
      .map(s => ({
        source: 'chrome', id: s.apiHost,
        label: s.label, instanceUrl: s.instanceUrl,
        profile: s.profile, accessToken: s.sessionId,
      }));
    res.json(result);
  } catch { res.json([]); }
});

app.get('/api/chrome-session', (_req, res) => {
  const { apiHost } = _req.query;
  if (!apiHost) return res.status(400).json({ error: 'apiHost required' });
  try {
    const sessions = detectOrgSessions();
    const s = sessions.find(x => x.apiHost === apiHost);
    if (!s) return res.status(404).json({ error: `No Chrome session found for ${apiHost}. Make sure you are logged in to this org in Chrome.` });
    res.json({ accessToken: s.sessionId, instanceUrl: s.instanceUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/perm-fields', async (req, res) => {
  const token = req.headers['x-sf-token'];
  const { instanceUrl } = req.query;
  if (!token || !instanceUrl) return res.status(400).json({ error: 'Missing params' });
  try {
    const base = decodeURIComponent(instanceUrl);
    const [psData, profileData] = await Promise.all([
      sfGet(`${base}/services/data/v60.0/sobjects/PermissionSet/describe`, token),
      sfGet(`${base}/services/data/v60.0/sobjects/Profile/describe`, token).catch(() => ({ fields: [] })),
    ]);
    const psFieldNames = new Set(
      psData.fields.filter(f => f.name.startsWith('Permissions') && f.type === 'boolean').map(f => f.name)
    );
    const profileFieldNames = new Set(
      profileData.fields.filter(f => f.name.startsWith('Permissions') && f.type === 'boolean').map(f => f.name)
    );
    const seen = new Set();
    const fields = [];
    for (const f of [...psData.fields, ...profileData.fields]) {
      if (f.name.startsWith('Permissions') && f.type === 'boolean' && !seen.has(f.name)) {
        seen.add(f.name);
        fields.push({ name: f.name, label: f.label, permset: psFieldNames.has(f.name), profile: profileFieldNames.has(f.name) });
      }
    }
    fields.sort((a, b) => a.label.localeCompare(b.label));
    res.json(fields);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/query', async (req, res) => {
  const { q, instanceUrl, nextUrl } = req.query;
  const token = req.headers['x-sf-token'];
  if (!token || !instanceUrl) return res.status(400).json({ error: 'Missing token or instanceUrl' });
  const target = decodeURIComponent(instanceUrl);
  const apiPath = nextUrl ? decodeURIComponent(nextUrl) : `/services/data/v60.0/query?q=${encodeURIComponent(q)}`;
  try { res.json(await sfGet(target + apiPath, token)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/search', async (req, res) => {
  const { q, instanceUrl } = req.query;
  const token = req.headers['x-sf-token'];
  if (!token || !instanceUrl || !q) return res.status(400).json({ error: 'Missing params' });
  const target = decodeURIComponent(instanceUrl);
  try { res.json(await sfGet(`${target}/services/data/v60.0/search?q=${encodeURIComponent(q)}`, token)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tooling-query', async (req, res) => {
  const { q, instanceUrl, nextUrl } = req.query;
  const token = req.headers['x-sf-token'];
  if (!token || !instanceUrl) return res.status(400).json({ error: 'Missing params' });
  const target = decodeURIComponent(instanceUrl);
  const apiPath = nextUrl ? decodeURIComponent(nextUrl) : `/services/data/v60.0/tooling/query?q=${encodeURIComponent(q)}`;
  try { res.json(await sfGet(target + apiPath, token)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/analytics', async (req, res) => {
  const { path: apiPath, instanceUrl } = req.query;
  const token = req.headers['x-sf-token'];
  if (!token || !instanceUrl || !apiPath) return res.status(400).json({ error: 'Missing params' });
  const target = decodeURIComponent(instanceUrl);
  try { res.json(await sfGet(`${target}${decodeURIComponent(apiPath)}`, token)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Pinned session — server owner shares their active session with remote users ─
let pinnedSession = null; // { accessToken, instanceUrl }
let pinnedToken = null;   // random token required to retrieve the pinned session

app.post('/api/pin-session', (req, res) => {
  const { accessToken, instanceUrl } = req.body;
  if (!accessToken || !instanceUrl) return res.status(400).json({ error: 'Missing fields' });
  pinnedSession = { accessToken, instanceUrl };
  pinnedToken = crypto.randomBytes(16).toString('hex');
  // Return the token so the caller can share it with remote users
  res.json({ ok: true, token: pinnedToken });
});

app.get('/api/pinned-session', (req, res) => {
  if (!pinnedSession) return res.status(404).json({ error: 'No session pinned yet' });
  const provided = req.query.token || req.headers['x-pin-token'];
  if (!provided || provided !== pinnedToken) {
    return res.status(401).json({ error: 'Unauthorized: provide ?token= from the pin-session response' });
  }
  res.json(pinnedSession);
});

// ── OAuth PKCE endpoints ──────────────────────────────────────────────────────

app.get('/api/oauth/config', (_req, res) => {
  const { clientId } = readOAuthConfig();
  res.json({ hasClientId: !!clientId, clientId: clientId || '' });
});

app.post('/api/oauth/config', (req, res) => {
  const { clientId } = req.body;
  if (!clientId?.trim()) return res.status(400).json({ error: 'clientId required' });
  writeOAuthConfig({ clientId: clientId.trim() });
  res.json({ ok: true });
});

app.get('/api/oauth/start', (req, res) => {
  const { clientId } = readOAuthConfig();
  if (!clientId) return res.status(400).send('No Connected App configured. Please set a Consumer Key first.');

  const loginHost = (req.query.loginUrl || 'login.salesforce.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const redirectUri = `${req.protocol}://${req.headers.host}/api/oauth/callback`;

  const state = crypto.randomBytes(16).toString('hex');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  pkceStore.set(state, { codeVerifier, redirectUri, loginHost, expires: Date.now() + 600_000 });

  const authUrl = `https://${loginHost}/services/oauth2/authorize?` + new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'api refresh_token',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  res.redirect(authUrl);
});

app.get('/api/oauth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) return res.redirect(`/?oauth_error=${encodeURIComponent(error_description || error)}`);

  const pkce = pkceStore.get(state);
  if (!pkce || pkce.expires < Date.now()) {
    pkceStore.delete(state);
    return res.redirect('/?oauth_error=OAuth+session+expired.+Please+try+again.');
  }
  pkceStore.delete(state);

  const { clientId } = readOAuthConfig();
  try {
    const tokenData = await sfPost(`https://${pkce.loginHost}/services/oauth2/token`, {
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: pkce.redirectUri,
      code,
      code_verifier: pkce.codeVerifier,
    });
    if (tokenData.error) {
      return res.redirect(`/?oauth_error=${encodeURIComponent(tokenData.error_description || tokenData.error)}`);
    }
    const tempCode = crypto.randomBytes(16).toString('hex');
    authCodeStore.set(tempCode, {
      accessToken: tokenData.access_token,
      instanceUrl: tokenData.instance_url,
      expires: Date.now() + 60_000,
    });
    res.redirect(`/?auth_code=${tempCode}`);
  } catch (e) {
    res.redirect(`/?oauth_error=${encodeURIComponent(e.message)}`);
  }
});

app.get('/api/redeem-auth-code', (req, res) => {
  const data = authCodeStore.get(req.query.code);
  if (!data || data.expires < Date.now()) {
    authCodeStore.delete(req.query.code);
    return res.status(401).json({ error: 'Auth code expired or invalid.' });
  }
  authCodeStore.delete(req.query.code);
  res.json({ accessToken: data.accessToken, instanceUrl: data.instanceUrl });
});

app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`SF Permission Comparator running at ${url}`);
  try { execSync(`open ${url}`); } catch {}
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const url = `http://localhost:${PORT}`;
    console.log(`Port ${PORT} already in use — opening existing server at ${url}`);
    try { execSync(`open ${url}`); } catch {}
  } else {
    throw err;
  }
});

function sfGet(url, token) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search,
        method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      res => { let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Invalid JSON')); } }); }
    );
    req.on('error', reject); req.end();
  });
}

function sfPost(url, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const parsed = new URL(url);
    const req = https.request(
      { hostname: parsed.hostname, path: parsed.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
      res => { let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Invalid JSON from SF token endpoint')); } }); }
    );
    req.on('error', reject); req.write(body); req.end();
  });
}
