// Reads the Salesforce session from Chrome's cookie store on macOS.
// Chrome encrypts cookie values with an AES-128-CBC key stored in the
// login Keychain ("Chrome Safe Storage").

import { execFileSync } from 'child_process';
import { createDecipheriv, pbkdf2Sync } from 'crypto';
import { existsSync, mkdtempSync, copyFileSync, rmSync, readdirSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, basename } from 'path';
import { DatabaseSync } from 'node:sqlite';

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
    const db = new DatabaseSync(tmp);
    let results;
    try {
      results = db.prepare(
        "SELECT host_key, encrypted_value, last_access_utc FROM cookies WHERE name = 'sid' AND (host_key LIKE '%salesforce%' OR host_key LIKE '%force.com%') ORDER BY last_access_utc DESC"
      ).all();
    } catch {
      // Fallback if last_access_utc column doesn't exist or ordering fails
      results = db.prepare(
        "SELECT host_key, encrypted_value FROM cookies WHERE name = 'sid' AND (host_key LIKE '%salesforce%' OR host_key LIKE '%force.com%')"
      ).all();
    }
    for (const r of results) rows.push(r);
    db.close();
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
  // Lightning Experience and file/content domains — map to .my.salesforce.com
  if (h.endsWith('.lightning.force.com')) return h.replace(/\.lightning\.force\.com$/, '.my.salesforce.com');
  if (h.endsWith('.file.force.com')) return h.replace(/\.file\.force\.com$/, '.my.salesforce.com');
  if (h.endsWith('.content.force.com')) return h.replace(/\.content\.force\.com$/, '.my.salesforce.com');
  return null;
}

export function detectOrgSessions() {
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
      const lastAccess = c.last_access_utc != null ? Number(String(c.last_access_utc)) : 0;
      const existing = byHost.get(apiHost);
      if (!existing || lastAccess > (existing.lastAccess || 0) || (direct && !existing.direct)) {
        byHost.set(apiHost, {
          apiHost,
          sessionId: value,
          profile,
          direct,
          lastAccess,
          label: apiHost.replace(/\.my\.salesforce\.com$/, '').replace(/\.salesforce\.com$/, ''),
          instanceUrl: `https://${apiHost}`,
        });
      }
    }
  }
  // Most recently active session first
  return [...byHost.values()].sort((a, b) => (b.lastAccess || 0) - (a.lastAccess || 0));
}
