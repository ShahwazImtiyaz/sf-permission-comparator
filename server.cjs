'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { execSync, exec, execFile } = require('child_process');

const pkceStore = new Map();
const authCodeStore = new Map();
// Evict expired entries every 5 minutes so the maps don't grow unboundedly
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pkceStore) if (v.expires < now) pkceStore.delete(k);
  for (const [k, v] of authCodeStore) if (v.expires < now) authCodeStore.delete(k);
}, 300_000).unref();

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

let _chromeSession = null;
function getChromeSession() {
  if (!_chromeSession) {
    try { _chromeSession = require('./chrome-session.cjs'); } catch {}
  }
  return _chromeSession;
}

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

// ── Read SF CLI auth files from ~/.sfdx/ ────────────────────────────────────
function getSfdxDir() {
  // pkg bundles read from real home dir at runtime
  return path.join(os.homedir(), '.sfdx');
}

function readAliases() {
  try {
    const aliasFile = path.join(getSfdxDir(), 'alias.json');
    const raw = JSON.parse(fs.readFileSync(aliasFile, 'utf8'));
    // alias.json may be { orgs: { alias: username } } or { alias: username }
    const orgs = raw.orgs || raw;
    const map = {};
    for (const [alias, username] of Object.entries(orgs)) {
      map[username] = alias;
    }
    return map;
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
        orgs.push({
          username: data.username,
          instanceUrl: data.instanceUrl,
          orgId: data.orgId,
          orgName: data.name || data.orgName || '',
          alias: aliases[data.username] || '',
          isSandbox: data.isSandbox || false,
          orgEdition: data.orgEdition || '',
        });
      } catch {}
    }
  } catch {}
  return orgs.sort((a, b) => (a.alias || a.username).localeCompare(b.alias || b.username));
}

function execAsync(cmd, opts) {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: 'utf8', ...opts }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

// sf CLI binary name differs on Windows (.cmd extension required for execFile)
const SF_BIN = process.platform === 'win32' ? 'sf.cmd' : 'sf';

function execFileAsync(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', ...opts }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

// ── GET /api/orgs — list orgs from local auth files (no network validation) ──
app.get('/api/orgs', (_req, res) => {
  const orgs = readOrgFiles();
  if (!orgs.length) return res.status(404).json({ error: 'No Salesforce CLI orgs found. Run "sf org login web" first.' });
  res.json(orgs);
});

// ── POST /api/org-session — get live decrypted token via sf CLI ───────────────
// The .sfdx auth file stores an encrypted token; sf CLI decrypts it correctly.
app.post('/api/org-session', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  // Strict allowlist: Salesforce usernames are email-like with optional .sandbox suffix
  if (!/^[a-zA-Z0-9@._+\-]+$/.test(username)) {
    return res.status(400).json({ error: 'Invalid username format' });
  }
  try {
    const raw = await execFileAsync(
      SF_BIN, ['org', 'auth', 'show-access-token', '--target-org', username, '--no-prompt', '--json'],
      { timeout: 15000 }
    );
    const parsed = JSON.parse(raw);
    const token = parsed?.result?.accessToken;
    if (!token) return res.status(500).json({ error: 'Could not retrieve token. Try re-authenticating with: sf org login web' });
    const dir = getSfdxDir();
    const fileData = JSON.parse(fs.readFileSync(path.join(dir, `${username}.json`), 'utf8'));
    res.json({ accessToken: token, instanceUrl: fileData.instanceUrl });
  } catch (e) {
    res.status(500).json({ error: `Session error: ${e.message}. Try: sf org login web --alias <alias>` });
  }
});

// ── GET /api/chrome-orgs ─────────────────────────────────────────────────────
app.get('/api/chrome-orgs', async (_req, res) => {
  try {
    const cs = getChromeSession();
    if (!cs) return res.json({ orgs: [], error: null });

    let sessions;
    try {
      sessions = cs.detectOrgSessions();
    } catch (e) {
      const msg = e.message || String(e);
      let errorCode = 'unknown';
      if (msg.includes('EACCES') || msg.includes('permission denied')) errorCode = 'fda_denied';
      else if (msg.includes('44') || msg.includes('SecKeychainSearch') || msg.includes('could not be found')) errorCode = 'keychain_denied';
      else if (msg.includes('ENOENT') && msg.includes('Chrome')) errorCode = 'chrome_not_found';
      return res.json({ orgs: [], error: errorCode, detail: msg });
    }

    // detectOrgSessions() already filters to open tabs (when osascript works) and sorts
    // by lastAccess descending — so sessions[0] is the most recently used org.
    const orgs = sessions.map(s => ({
      source: 'chrome', id: s.apiHost,
      label: s.label, instanceUrl: s.instanceUrl,
      profile: s.profile, accessToken: s.sessionId,
    }));
    res.json({ orgs, error: null });
  } catch (e) {
    res.json({ orgs: [], error: 'unknown', detail: e.message });
  }
});

// ── GET /api/chrome-session ───────────────────────────────────────────────────
app.get('/api/chrome-session', (_req, res) => {
  const { apiHost } = _req.query;
  if (!apiHost) return res.status(400).json({ error: 'apiHost required' });
  try {
    const cs = getChromeSession();
    if (!cs) return res.status(500).json({ error: 'Chrome session module not available' });
    const sessions = cs.detectOrgSessions();
    const s = sessions.find(x => x.apiHost === apiHost);
    if (!s) return res.status(404).json({ error: `No Chrome session found for ${apiHost}.` });
    res.json({ accessToken: s.sessionId, instanceUrl: s.instanceUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/perm-fields — union of PermissionSet + Profile Permissions* boolean fields ─
app.get('/api/perm-fields', async (req, res) => {
  const token = req.headers['x-sf-token'];
  const { instanceUrl } = req.query;
  if (!token || !instanceUrl) return res.status(400).json({ error: 'Missing params' });
  try {
    const base = decodeURIComponent(instanceUrl);
    // Describe both objects in parallel; Profile has a superset of Permissions* fields
    const [psData, profileData] = await Promise.all([
      sfGet(`${base}/services/data/v60.0/sobjects/PermissionSet/describe`, token),
      sfGet(`${base}/services/data/v60.0/sobjects/Profile/describe`, token).catch(() => ({ fields: [] })),
    ]);
    // Build a set of which object each field belongs to so queries only use compatible fields
    const psFields = psData.fields || [];
    const profileFields = profileData.fields || [];
    const psFieldNames = new Set(
      psFields.filter(f => f.name.startsWith('Permissions') && f.type === 'boolean').map(f => f.name)
    );
    const profileFieldNames = new Set(
      profileFields.filter(f => f.name.startsWith('Permissions') && f.type === 'boolean').map(f => f.name)
    );

    const seen = new Set();
    const fields = [];
    for (const f of [...psFields, ...profileFields]) {
      if (f.name.startsWith('Permissions') && f.type === 'boolean' && !seen.has(f.name)) {
        seen.add(f.name);
        fields.push({
          name: f.name,
          label: f.label,
          permset: psFieldNames.has(f.name),
          profile: profileFieldNames.has(f.name),
        });
      }
    }
    fields.sort((a, b) => a.label.localeCompare(b.label));
    res.json(fields);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/query — SOQL proxy ───────────────────────────────────────────────
app.get('/api/query', async (req, res) => {
  const { q, instanceUrl, nextUrl } = req.query;
  const token = req.headers['x-sf-token'];
  if (!token || !instanceUrl) return res.status(400).json({ error: 'Missing token or instanceUrl' });

  const target = decodeURIComponent(instanceUrl);
  const apiPath = nextUrl
    ? decodeURIComponent(nextUrl)
    : `/services/data/v60.0/query?q=${encodeURIComponent(q)}`;

  try {
    const data = await sfGet(target + apiPath, token);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tooling-query', async (req, res) => {
  const { q, instanceUrl, nextUrl } = req.query;
  const token = req.headers['x-sf-token'];
  if (!token || !instanceUrl) return res.status(400).json({ error: 'Missing params' });
  const target = decodeURIComponent(instanceUrl);
  const apiPath = nextUrl ? decodeURIComponent(nextUrl) : `/services/data/v60.0/tooling/query?q=${encodeURIComponent(q)}`;
  try {
    const data = await sfGet(target + apiPath, token);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/search — SOSL search proxy ──────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q, instanceUrl } = req.query;
  const token = req.headers['x-sf-token'];
  if (!token || !instanceUrl || !q) return res.status(400).json({ error: 'Missing params' });
  const target = decodeURIComponent(instanceUrl);
  try {
    const data = await sfGet(`${target}/services/data/v60.0/search?q=${encodeURIComponent(q)}`, token);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Pinned session — server owner shares their active session with remote users ─
let pinnedSession = null; // { accessToken, instanceUrl }
let pinnedToken = null;   // random token required to retrieve the pinned session

app.post('/api/pin-session', (req, res) => {
  const { accessToken, instanceUrl } = req.body;
  if (!accessToken || !instanceUrl) return res.status(400).json({ error: 'Missing fields' });
  pinnedSession = { accessToken, instanceUrl };
  pinnedToken = crypto.randomBytes(16).toString('hex');
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

// ── GET /api/analytics — Salesforce Analytics API proxy ──────────────────────
app.get('/api/analytics', async (req, res) => {
  const { path: apiPath, instanceUrl } = req.query;
  const token = req.headers['x-sf-token'];
  if (!token || !instanceUrl || !apiPath) return res.status(400).json({ error: 'Missing params' });
  const target = decodeURIComponent(instanceUrl);
  try {
    const data = await sfGet(`${target}${decodeURIComponent(apiPath)}`, token);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

// Mac: Start.command hardcodes /tmp/.sfpc.port — keep this path in sync.
// Windows: /tmp/ doesn't exist; the write is best-effort (try/catch).
const PORT_FILE = process.platform === 'win32'
  ? path.join(os.tmpdir(), '.sfpc.port')
  : '/tmp/.sfpc.port';

function findFreePort(start) {
  return new Promise((resolve, reject) => {
    function tryPort(p) {
      if (p > start + 50) return reject(new Error('No free port found'));
      const srv = net.createServer();
      srv.once('error', () => tryPort(p + 1));
      srv.once('listening', () => { srv.close(() => resolve(p)); });
      srv.listen(p);
    }
    tryPort(start);
  });
}

findFreePort(process.env.PORT ? Number(process.env.PORT) : 3000).then(port => {
  app.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`SF Permission Comparator running at ${url}`);
    // Write port file for Start.command (macOS). Safe to fail on Windows.
    try { fs.writeFileSync(PORT_FILE, String(port)); } catch {}
    // Open browser on all platforms — whether launched via Start.command or directly.
    // Start.command no longer opens Chrome separately, so this is the single open point.
    openBrowser(url);
  });
}).catch(err => {
  console.error('Could not start server:', err.message);
  process.exit(1);
});

// ── helpers ──────────────────────────────────────────────────────────────────
function sfGet(url, token) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'GET',
        headers: { Authorization: `Bearer ${token}` } },
      res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Invalid JSON from Salesforce')); } });
      }
    );
    req.on('error', reject);
    req.end();
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

function openBrowser(url) {
  try {
    if (process.platform === 'win32') execSync(`cmd /c start "" "${url}"`);
    else if (process.platform === 'darwin') execSync(`open "${url}"`);
    else execSync(`xdg-open "${url}"`);
  } catch {}
}
