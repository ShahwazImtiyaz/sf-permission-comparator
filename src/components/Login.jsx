import { useState, useEffect } from 'react';
import { fetchOrgs, loadOrgSession, setSession, fetchOrgInfo, setOrgName } from '../lib/salesforce';

const CHROME_ERROR_MSGS = {
  keychain_denied: 'macOS blocked keychain access. In Terminal, run:\n  security unlock-keychain ~/Library/Keychains/login.keychain-db\nThen restart the app. Or in Keychain Access, find "Chrome Safe Storage" → Access Control → add your terminal app.',
  fda_denied: 'macOS Full Disk Access is needed to read Chrome sessions.\nGo to System Settings → Privacy & Security → Full Disk Access → enable Terminal (or drag it in).',
  chrome_not_found: 'Google Chrome was not found on this Mac. Make sure Chrome is installed.',
  unknown: 'Chrome session detection failed. Make sure Chrome is open and logged into Salesforce, then click Retry.',
};

export default function Login({ onSuccess, initialError }) {
  const [orgs, setOrgs] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loadingOrgs, setLoadingOrgs] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(initialError || null);
  const [chromeError, setChromeError] = useState(null);

  useEffect(() => { loadOrgs(); }, []);

  function loadOrgs() {
    setLoadingOrgs(true);
    setChromeError(null);
    fetchOrgs()
      .then(data => {
        setOrgs(data);
        const lastTs = Number(localStorage.getItem('sf_last_org_ts') || '0');
        const lastId = (Date.now() - lastTs < 86_400_000) ? localStorage.getItem('sf_last_org_id') : null;
        const chromeOrgs = data.filter(o => o.source === 'chrome');
        // Most recent Chrome tab (last in list) or last-used org
        const preselect =
          (lastId && data.find(o => o.id === lastId)) ||
          (chromeOrgs.length > 0 ? chromeOrgs[0] : null) ||
          (data.length === 1 ? data[0] : null);
        if (preselect) {
          setSelected(preselect);
          // Auto-connect for Chrome orgs without requiring a click
          if (preselect.source === 'chrome') connectOrg(preselect);
        }
      })
      .catch(e => { setChromeError(e.chromeError || null); setOrgs([]); })
      .finally(() => setLoadingOrgs(false));
  }

  async function connectOrg(org) {
    setConnecting(true);
    setError(null);
    try {
      const { accessToken, instanceUrl } = await loadOrgSession(org);
      setSession(accessToken, instanceUrl);
      localStorage.setItem('sf_last_org_id', org.id);
      localStorage.setItem('sf_last_org_ts', String(Date.now()));
      onSuccess();
      fetchOrgInfo().then(o => { if (o?.Name) setOrgName(o.Name); }).catch(() => {});
    } catch (e) {
      setError(e.message);
      setConnecting(false);
    }
  }

  async function connect() {
    if (!selected) return;
    connectOrg(selected);
  }

  return (
    <div className="login-bg">
      <div className="login-card">
        <div className="login-header">
          <CloudIcon />
          <h1>SF Permission Comparator</h1>
          <p>Compare profiles and permission sets between users</p>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <div className="form-group">
          <label>Select your Salesforce Org</label>
          {loadingOrgs ? (
            <div className="orgs-loading"><span className="btn-spinner dark" /> Detecting local sessions…</div>
          ) : orgs.length === 0 ? (
            <div className="no-orgs">
              {chromeError ? (
                <>
                  <div style={{ marginBottom: 8, fontWeight: 600 }}>Chrome session detection failed</div>
                  <div style={{ whiteSpace: 'pre-line', fontSize: 12, color: '#6B7280', marginBottom: 10 }}>
                    {CHROME_ERROR_MSGS[chromeError] || CHROME_ERROR_MSGS.unknown}
                  </div>
                </>
              ) : (
                'No orgs found. Make sure you\'re logged into Salesforce in Chrome, then click Retry.'
              )}
              <button className="btn-retry" onClick={loadOrgs}>↻ Retry</button>
            </div>
          ) : (
            <div className="org-list">
              {orgs.map(org => {
                const displayName = org.label || org.alias || org.orgName || org.username || org.id;
                const subLabel = org.source === 'chrome'
                  ? `${org.instanceUrl?.replace('https://', '')} · Chrome`
                  : `${org.username} · ${org.orgEdition || (org.isSandbox ? 'Sandbox' : 'Production')}`;
                return (
                  <div key={org.id} className={`org-item ${selected?.id === org.id ? 'selected' : ''}`}
                    onClick={() => setSelected(org)}>
                    <div className="org-icon">{displayName.charAt(0).toUpperCase()}</div>
                    <div className="org-details">
                      <div className="org-name">{displayName}</div>
                      <div className="org-meta">{subLabel}</div>
                    </div>
                    {selected?.id === org.id && <div className="org-check">✓</div>}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {selected && (
          <div className="selected-org-chip">
            Connecting to <strong>{selected.instanceUrl?.replace('https://', '')}</strong>
          </div>
        )}

        <button className="btn-primary full-width" onClick={connect}
          disabled={!selected || connecting || loadingOrgs}>
          {connecting ? <><span className="btn-spinner" /> Connecting…</> : 'Connect'}
        </button>

        <p className="login-hint">Uses your Chrome session or Salesforce CLI — no password needed.</p>
      </div>
    </div>
  );
}

function CloudIcon() {
  return (
    <svg width="48" height="34" viewBox="0 0 48 34" fill="none">
      <path d="M24 2C17.373 2 12 7.373 12 14c0 1.687.348 3.294.975 4.752C11.456 18.028 9.786 17.6 8 17.6 3.582 17.6 0 21.182 0 25.6S3.582 33.6 8 33.6h32c4.418 0 8-3.582 8-8 0-3.09-2.124-5.678-4.992-6.403A11.95 11.95 0 0 0 44 16c0-6.627-5.373-12-12-12-.002 0-.002 0-8 0-.002 0-.002 0 0-2z" fill="#00A1E0"/>
    </svg>
  );
}
