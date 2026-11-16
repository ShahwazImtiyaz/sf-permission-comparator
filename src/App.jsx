import { useState, useEffect, Component } from 'react';
import { getSession, setSession, loadOrgSession, fetchOrgInfo, setOrgName, clearSession } from './lib/salesforce';
import Login from './components/Login';
import CompareView from './components/CompareView';

class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, textAlign: 'center', fontFamily: 'sans-serif' }}>
          <div style={{ color: '#DC2626', fontSize: 16, marginBottom: 8 }}>Something went wrong</div>
          <div style={{ color: '#6B7280', fontSize: 13, marginBottom: 24 }}>{this.state.error.message}</div>
          <button onClick={() => this.setState({ error: null })}
            style={{ padding: '8px 20px', borderRadius: 8, border: '1px solid #D1D5DB', cursor: 'pointer' }}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [authed, setAuthed] = useState(() => !!getSession().token);
  const [autoConnecting, setAutoConnecting] = useState(!getSession().token);
  const [autoError, setAutoError] = useState(null);

  useEffect(() => {
    if (authed) return;

    const params = new URLSearchParams(window.location.search);
    const authCode = params.get('auth_code');
    const oauthError = params.get('oauth_error');
    if (oauthError) {
      window.history.replaceState({}, '', '/');
      setAutoConnecting(false);
      setAutoError(decodeURIComponent(oauthError));
      return;
    }
    if (authCode) {
      window.history.replaceState({}, '', '/');
      redeemAuthCode(authCode);
      return;
    }

    tryAutoConnect();
  }, []);

  async function redeemAuthCode(code) {
    try {
      const res = await fetch(`/api/redeem-auth-code?code=${encodeURIComponent(code)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'OAuth login failed');
      setSession(data.accessToken, data.instanceUrl);
      try { const org = await fetchOrgInfo(); if (org?.Name) setOrgName(org.Name); } catch {}
      setAuthed(true);
    } catch (e) {
      setAutoError(e.message);
    } finally {
      setAutoConnecting(false);
    }
  }

  async function tryAutoConnect() {
    try {
      // Try Chrome orgs first (fast). Only fall back to slow SFDX if Chrome finds nothing.
      let allOrgs = [];
      try {
        const r = await fetch('/api/chrome-orgs');
        const val = await r.json();
        allOrgs = Array.isArray(val) ? val : (Array.isArray(val?.orgs) ? val.orgs : []);
      } catch {}
      if (!allOrgs.length) {
        try {
          const r = await fetch('/api/orgs');
          const val = await r.json();
          if (Array.isArray(val)) allOrgs = val.map(o => ({ ...o, source: 'sfdx', id: o.username }));
        } catch {}
      }
      if (!allOrgs.length) { setAutoConnecting(false); return; }

      const lastId = localStorage.getItem('sf_last_org_id');
      const chromeOrgs = allOrgs.filter(o => o.source === 'chrome');

      // For Chrome orgs: always auto-connect — never show picker.
      // Priority: last-used Chrome org → most recently opened Chrome tab (last in list).
      // For SFDX-only: require explicit pick if multiple.
      let target = null;
      if (chromeOrgs.length > 0) {
        // chromeOrgs[0] = most recently accessed (sorted by lastAccess desc in detectOrgSessions)
        target = (lastId && chromeOrgs.find(o => o.id === lastId)) || chromeOrgs[0];
      } else {
        target = (lastId && allOrgs.find(o => o.id === lastId)) || (allOrgs.length === 1 ? allOrgs[0] : null);
      }

      if (!target) {
        // Multiple SFDX orgs, no previous choice — show picker
        setAutoConnecting(false);
        return;
      }

      const { accessToken, instanceUrl } = await loadOrgSession(target);
      setSession(accessToken, instanceUrl);

      localStorage.setItem('sf_last_org_id', target.id);
      // Set authed immediately — fetchOrgInfo updates the name in the background.
      // If the session is already expired, fall back to the login screen.
      setAuthed(true);
      fetchOrgInfo()
        .then(org => { if (org?.Name) setOrgName(org.Name); })
        .catch(e => {
          if (/INVALID_SESSION_ID|SESSION_EXPIRED|Not authenticated/i.test(e.message)) {
            clearSession();
            setAuthed(false);
          }
        });
    } catch (e) {
      setAutoError(e.message);
    }
    setAutoConnecting(false);
  }

  if (autoConnecting) {
    return (
      <div className="callback-screen">
        <span className="spinner" />
        <p>Connecting to Salesforce…</p>
      </div>
    );
  }

  if (!authed) {
    return <Login onSuccess={() => setAuthed(true)} initialError={autoError} />;
  }

  return (
    <ErrorBoundary>
      <CompareView onLogout={() => { setAuthed(false); setAutoConnecting(false); }} />
    </ErrorBoundary>
  );
}
