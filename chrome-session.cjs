'use strict';
// CJS version of chrome-session.js (for pkg binary bundling)
// Uses macOS sqlite3 CLI instead of node:sqlite to avoid version constraints.

const { execFileSync, execSync } = require('child_process');
const { createDecipheriv, pbkdf2Sync } = require('crypto');
const { existsSync, mkdtempSync, copyFileSync, rmSync, readdirSync, writeFileSync } = require('fs');
const { homedir, tmpdir } = require('os');
const { join, basename } = require('path');

const CHROME_DIR = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');

let cachedKey = null;
let cachedKeyTime = 0;
const KEY_TTL_MS = 60 * 60 * 1000; // re-derive after 1 hour so stale keys are not used indefinitely

function getAesKey() {
  const now = Date.now();
  if (cachedKey && (now - cachedKeyTime) < KEY_TTL_MS) return cachedKey;
  const pw = execFileSync('security', [
    'find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome',
  ]).toString().trim();
  cachedKey = pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');
  cachedKeyTime = now;
  return cachedKey;
}

function looksPrintable(s) {
  return /^[\x09\x0a\x0d\x20-\x7e]*$/.test(s);
}

function decryptCookie(encrypted, key) {
  if (!encrypted || encrypted.length === 0) return '';
  if (!Buffer.isBuffer(encrypted)) encrypted = Buffer.from(encrypted);
  const version = encrypted.slice(0, 3).toString('latin1');
  if (version !== 'v10' && version !== 'v11') return encrypted.toString('utf8');
  const iv = Buffer.alloc(16, 0x20);
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  let out = Buffer.concat([decipher.update(encrypted.slice(3)), decipher.final()]);
  const pad = out[out.length - 1];
  if (pad > 0 && pad <= 16) out = out.subarray(0, out.length - pad);
  const direct = out.toString('utf8');
  if (direct.includes('!') && looksPrintable(direct)) return direct;
  const stripped = out.subarray(32).toString('utf8');
  if (stripped.includes('!')) return stripped;
  return direct;
}

function profileDirs() {
  let names;
  try { names = readdirSync(CHROME_DIR); } catch { return []; }
  return names
    .filter(n => n === 'Default' || /^Profile \d+$/.test(n))
    .map(n => join(CHROME_DIR, n))
    .filter(d => existsSync(join(d, 'Cookies')));
}

function readSidCookies(profileDir) {
  const src = join(profileDir, 'Cookies');
  const tmpDir = mkdtempSync(join(tmpdir(), 'sfpc-cookies-'));
  const tmp = join(tmpDir, 'Cookies');
  copyFileSync(src, tmp);
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(src + ext)) copyFileSync(src + ext, tmp + ext);
  }
  const rows = [];
  try {
    // Use macOS built-in sqlite3 CLI; output hex blobs for encrypted_value
    const sql = "SELECT host_key, hex(encrypted_value) as ev, last_access_utc FROM cookies WHERE name='sid' AND (host_key LIKE '%salesforce%' OR host_key LIKE '%force.com%') ORDER BY last_access_utc DESC";
    const out = execSync(`sqlite3 "${tmp}" -separator '|' "${sql}"`, { encoding: 'utf8' });
    for (const line of out.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('|');
      if (parts.length < 2) continue;
      const host_key = parts[0];
      const hexVal = parts[1];
      const lastAccess = parseInt(parts[2] || '0', 10);
      rows.push({ host_key, encrypted_value: Buffer.from(hexVal, 'hex'), lastAccess });
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  return rows;
}

function hostToApiHost(hostKey) {
  const h = hostKey.replace(/^\./, '').toLowerCase();
  if (h.endsWith('.my.salesforce.com')) return h;
  if (h.endsWith('.my.salesforce-setup.com')) return h.replace(/\.my\.salesforce-setup\.com$/, '.my.salesforce.com');
  if (h.endsWith('.salesforce.com') && !/^(login|test|www)\./.test(h)) return h;
  if (h.endsWith('.lightning.force.com')) return h.replace(/\.lightning\.force\.com$/, '.my.salesforce.com');
  if (h.endsWith('.file.force.com')) return h.replace(/\.file\.force\.com$/, '.my.salesforce.com');
  if (h.endsWith('.content.force.com')) return h.replace(/\.content\.force\.com$/, '.my.salesforce.com');
  return null;
}

function getOpenChromeTabUrls() {
  try {
    const script = [
      'tell application "Google Chrome"',
      '  set o to ""',
      '  repeat with w in windows',
      '    repeat with t in tabs of w',
      '      set o to o & (URL of t) & linefeed',
      '    end repeat',
      '  end repeat',
      '  return o',
      'end tell',
    ].join('\n');
    const scriptPath = join(tmpdir(), '.sfpc-tabs.applescript');
    writeFileSync(scriptPath, script);
    const out = execFileSync('osascript', [scriptPath], { encoding: 'utf8', timeout: 5000 });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return null; // null = couldn't read tabs; fall back to all cookie sessions
  }
}

function detectOrgSessions() {
  const key = getAesKey();
  const byHost = new Map();
  for (const dir of profileDirs()) {
    const profile = basename(dir);
    let cookies;
    try { cookies = readSidCookies(dir); } catch { continue; }
    for (const c of cookies) {
      const apiHost = hostToApiHost(c.host_key);
      if (!apiHost) continue;
      const value = decryptCookie(c.encrypted_value, key);
      if (!value || !value.includes('!')) continue;
      const direct = c.host_key.replace(/^\./, '').toLowerCase().endsWith('.my.salesforce.com');
      const existing = byHost.get(apiHost);
      if (!existing || c.lastAccess > (existing.lastAccess || 0) || (direct && !existing.direct)) {
        byHost.set(apiHost, {
          apiHost,
          sessionId: value,
          profile,
          direct,
          lastAccess: c.lastAccess || 0,
          label: apiHost.replace(/\.my\.salesforce\.com$/, '').replace(/\.salesforce\.com$/, ''),
          instanceUrl: `https://${apiHost}`,
        });
      }
    }
  }

  let sessions = [...byHost.values()].sort((a, b) => (b.lastAccess || 0) - (a.lastAccess || 0));

  // Filter to only orgs with an open Chrome tab.
  // Check both the full apiHost (.my.salesforce.com) AND the label prefix so that
  // Lightning Experience tabs (.lightning.force.com), setup tabs (.salesforce-setup.com),
  // and other Salesforce domain variants are all matched correctly.
  const tabUrls = getOpenChromeTabUrls();
  if (tabUrls !== null && tabUrls.length > 0) {
    const lowered = tabUrls.map(u => u.toLowerCase());
    sessions = sessions.filter(s =>
      lowered.some(url =>
        url.includes(s.apiHost) ||      // matches .my.salesforce.com tabs directly
        url.includes(`${s.label}.`)     // matches .lightning.force.com, -setup.com, etc.
      )
    );
  }

  return sessions;
}

module.exports = { detectOrgSessions };
