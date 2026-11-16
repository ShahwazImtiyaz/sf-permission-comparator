import { useState, useEffect, useRef } from 'react';
import UserPicker from './UserPicker';
import { getUserData, getObjectPermissions, clearSession, getOrgDomain, setSession, loadOrgSession, fetchOrgInfo, setOrgName } from '../lib/salesforce';
import { SLOT_COLORS, SLOT_LABELS } from '../lib/slotColors';
import { isDiff, Check } from '../lib/utils';
import SystemPermsTab from './SystemPermsTab';
import FieldPermsTab from './FieldPermsTab';
import AccessTab from './AccessTab';
import ReportsDashboardsTab from './ReportsDashboardsTab';
import LayoutsTypesTab from './LayoutsTypesTab';
import FilterBar from './FilterBar';
import AgentChat from './AgentChat';

const MAX_USERS = 5;

const PERM_COLS = [
  { key: 'PermissionsRead', label: 'Read' },
  { key: 'PermissionsCreate', label: 'Create' },
  { key: 'PermissionsEdit', label: 'Edit' },
  { key: 'PermissionsDelete', label: 'Delete' },
  { key: 'PermissionsViewAllRecords', label: 'View All' },
  { key: 'PermissionsModifyAllRecords', label: 'Modify All' },
];

function UserTh({ users }) {
  return users.map((u, i) => (
    <th key={i} style={{
      background: SLOT_COLORS[i].bg,
      color: SLOT_COLORS[i].text,
      borderLeft: `2px solid ${SLOT_COLORS[i].border}`,
      textAlign: 'center',
    }}>
      {u.Name.split(' ')[0]}
    </th>
  ));
}

function PermSetTab({ users, datas, onDiffCount, diffTrigger }) {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  // When parent requests "show differences", switch filter
  useEffect(() => { if (diffTrigger > 0) setFilter('diff'); }, [diffTrigger]);

  const userMaps = datas.map(data =>
    new Map(
      data.permSets
        .filter(p => p.PermissionSet && !p.PermissionSet.IsOwnedByProfile)
        .map(p => [p.PermissionSetId, p.PermissionSet.Label || p.PermissionSet.Name])
    )
  );

  const allIds = new Set(userMaps.flatMap(m => [...m.keys()]));
  const allRows = [...allIds]
    .map(id => ({
      id,
      label: userMaps.find(m => m.has(id))?.get(id) || id,
      has: userMaps.map(m => m.has(id)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const diffRows = allRows.filter(r => isDiff(r.has));

  useEffect(() => { onDiffCount?.(diffRows.length); }, [diffRows.length]);

  const counts = {
    all: allRows.length,
    diff: diffRows.length,
    shared: allRows.filter(r => r.has.every(Boolean)).length,
  };

  const rows = allRows
    .filter(r => !search || r.label.toLowerCase().includes(search.toLowerCase()))
    .filter(r => {
      if (filter === 'diff') return isDiff(r.has);
      if (filter === 'shared') return r.has.every(Boolean);
      return true;
    });

  return (
    <div className="tab-content">
      <FilterBar value={filter} onChange={setFilter} search={search} onSearch={setSearch}
        searchPlaceholder="Search permission sets..." counts={counts} />
      <div className="table-wrap">
        <table className="table-anim">
          <thead>
            <tr>
              <th>Permission Set</th>
              <UserTh users={users} />
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const diff = isDiff(row.has);
              return (
                <tr key={row.id} className={diff ? 'diff' : ''}>
                  <td>{row.label}</td>
                  {row.has.map((has, i) => (
                    <td key={i} className="check-cell"
                      style={diff && has ? { background: SLOT_COLORS[i].bg } : {}}>
                      <Check value={has} />
                    </td>
                  ))}
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={users.length + 1} className="empty">No permission sets match filter</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ObjPermTab({ users, datas, onDiffCount }) {
  const [objMaps, setObjMaps] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.all(
        datas.map(data => getObjectPermissions(data.permSets.map(p => p.PermissionSetId)))
      );
      // Aggregate once — reused for both diff count and render
      const aggregate = perms => {
        const map = new Map();
        for (const p of perms) {
          if (!map.has(p.SobjectType)) map.set(p.SobjectType, { ...p });
          else { const ex = map.get(p.SobjectType); for (const c of PERM_COLS) ex[c.key] = ex[c.key] || p[c.key]; }
        }
        return map;
      };
      const maps = results.map(aggregate);
      const allTypes = [...new Set(maps.flatMap(m => [...m.keys()]))];
      const diff = allTypes.filter(type => {
        const perms = maps.map(m => m.get(type));
        return PERM_COLS.some(c => isDiff(perms.map(p => p?.[c.key] ?? false)));
      }).length;
      onDiffCount?.(diff);
      setObjMaps(maps);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="tab-content center"><span className="spinner" /><p>Loading object permissions…</p></div>;
  if (error) return <div className="tab-content"><div className="error-banner">{error}</div></div>;
  if (!objMaps) return null;

  const maps = objMaps;
  const allTypes = new Set(maps.flatMap(m => [...m.keys()]));

  const allRows = [...allTypes].sort().map(type => {
    const perms = maps.map(m => m.get(type));
    const diff = PERM_COLS.some(c => isDiff(perms.map(p => p?.[c.key] ?? false)));
    return { type, perms, diff };
  });

  const counts = {
    all: allRows.length,
    diff: allRows.filter(r => r.diff).length,
    shared: allRows.filter(r => !r.diff).length,
  };

  const rows = allRows
    .filter(r => !search || r.type.toLowerCase().includes(search.toLowerCase()))
    .filter(r => {
      if (filter === 'diff') return r.diff;
      if (filter === 'shared') return !r.diff;
      return true;
    });

  return (
    <div className="tab-content">
      <FilterBar value={filter} onChange={setFilter} search={search} onSearch={setSearch}
        searchPlaceholder="Filter by object name..." counts={counts} />
      <div className="table-wrap obj-table">
        <table className="table-anim">
          <thead>
            <tr>
              <th rowSpan={2}>Object</th>
              {PERM_COLS.map(c => (
                <th key={c.key} colSpan={users.length} className="perm-header">{c.label}</th>
              ))}
            </tr>
            <tr>
              {PERM_COLS.map(c =>
                users.map((u, i) => (
                  <th key={c.key + i} className="user-sub" style={{
                    background: SLOT_COLORS[i].bg,
                    color: SLOT_COLORS[i].text,
                  }}>
                    {u.Name.split(' ')[0]}
                  </th>
                ))
              )}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={1 + PERM_COLS.length * users.length} className="empty">No objects match the current filter</td></tr>
            ) : rows.map(({ type, perms, diff }) => (
              <tr key={type} className={diff ? 'diff' : ''}>
                <td className="obj-name">{type}</td>
                {PERM_COLS.map(c =>
                  perms.map((p, i) => {
                    const v = p?.[c.key] ?? false;
                    const colDiff = isDiff(perms.map(pp => pp?.[c.key] ?? false));
                    return (
                      <td key={c.key + i} className="check-cell"
                        style={colDiff && v ? { background: SLOT_COLORS[i].bg } : {}}>
                        <Check value={v} />
                      </td>
                    );
                  })
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UsersStat({ users }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function handleClick(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div className="summary-stat s-total clickable users-stat" ref={ref} onClick={() => setOpen(o => !o)}>
      <div className="summary-stat-num">{users.length}</div>
      <div className="summary-stat-label">{users.length === 1 ? 'User' : 'Users'}</div>
      {open && (
        <div className="users-stat-popover">
          {users.map((u, i) => (
            <div key={u.Id} className="users-stat-row">
              <span className="users-stat-dot" style={{ background: SLOT_COLORS[i].border }} />
              <div>
                <div className="users-stat-name">{u.Name}</div>
                {u.Profile?.Name && <div className="users-stat-profile">{u.Profile.Name}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const TABS = [
  { key: 'permsets',   label: 'Permission Sets' },
  { key: 'sysperms',   label: 'System Perms' },
  { key: 'objperms',   label: 'Object Perms' },
  { key: 'fieldperms', label: 'Field Perms' },
  { key: 'access',     label: 'Apex Class Access' },
  { key: 'reports',    label: 'Reports & Dashboards' },
  { key: 'layouts',    label: 'Layouts & Types' },
];

function OrgSwitcher({ orgDomain, onSwitch }) {
  const [orgs, setOrgs] = useState([]);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const ref = useRef(null);

  async function loadOrgs() {
    // Chrome orgs are fast — show them immediately without waiting for slow SFDX validation.
    try {
      const r = await fetch('/api/chrome-orgs');
      const val = await r.json();
      const chromeOrgs = Array.isArray(val) ? val : (Array.isArray(val?.orgs) ? val.orgs : []);
      if (chromeOrgs.length > 0) {
        setOrgs(chromeOrgs);
        return;
      }
    } catch {}
    // Fall back to SFDX orgs (slower — validates each token).
    try {
      const r = await fetch('/api/orgs');
      const val = await r.json();
      if (Array.isArray(val)) setOrgs(val.map(o => ({ ...o, source: 'sfdx', id: o.username })));
    } catch {}
  }

  useEffect(() => { loadOrgs(); }, []);

  useEffect(() => {
    if (open) loadOrgs();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onClick(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  async function switchTo(org) {
    setSwitching(true);
    setOpen(false);
    try {
      const { accessToken, instanceUrl } = await loadOrgSession(org);
      setSession(accessToken, instanceUrl);
      localStorage.setItem('sf_last_org_id', org.id);
      try { const info = await fetchOrgInfo(); if (info?.Name) setOrgName(info.Name); } catch {}
      onSwitch();
    } catch (e) {
      console.error('Org switch failed:', e);
      setSwitching(false);
    }
    setSwitching(false);
  }

  const hasMultiple = orgs.length > 1;

  if (!hasMultiple) {
    return (
      <span className="org-name-badge">
        <span className="org-dot" />
        {orgDomain}
      </span>
    );
  }

  return (
    <div className="org-switcher" ref={ref}>
      <button className="org-name-badge org-switcher-trigger" onClick={() => setOpen(o => !o)} disabled={switching}>
        <span className="org-dot" />
        {switching ? 'Switching…' : orgDomain}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style={{ marginLeft: 2, opacity: 0.7 }}>
          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round"/>
        </svg>
      </button>
      {open && (
        <div className="org-switcher-dropdown">
          {orgs.map(org => {
            const domain = org.instanceUrl?.replace('https://', '').replace(/\.my\.salesforce\.com.*/, '').replace(/\.salesforce\.com.*/, '') || org.id;
            const isCurrent = domain === orgDomain;
            const label = org.label || org.alias || org.orgName || domain;
            const sub = org.source === 'sfdx' ? (org.username || domain) : (org.profile || domain);
            return (
              <button key={org.id} className={`org-switcher-item${isCurrent ? ' current' : ''}`}
                onClick={() => !isCurrent && switchTo(org)} disabled={isCurrent}>
                <span className="org-switcher-dot" style={{ background: isCurrent ? 'var(--green)' : 'var(--slate-4)' }} />
                <span className="org-switcher-info">
                  <span className="org-switcher-domain">{label}</span>
                  {sub !== label && <span className="org-switcher-profile">{sub}</span>}
                </span>
                {isCurrent && <span className="org-switcher-check">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function CompareView({ onLogout }) {
  const [userSlots, setUserSlots] = useState([null]);
  const [comparedUsers, setComparedUsers] = useState([]);
  const [datas, setDatas] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('permsets');
  const [visitedTabs, setVisitedTabs] = useState(new Set(['permsets']));
  const [tabDiffCounts, setTabDiffCounts] = useState({});
  const [compareKey, setCompareKey] = useState(0);
  const [permSetDiffTrigger, setPermSetDiffTrigger] = useState(0);

  const selectedUsers = userSlots.filter(Boolean);
  const isSingleMode = userSlots.length === 1;
  const canRun = selectedUsers.length >= 1;
  const orgDomain = getOrgDomain();

  function addSlot() {
    if (userSlots.length < MAX_USERS) setUserSlots(prev => [...prev, null]);
  }

  function removeSlot(i) {
    setUserSlots(prev => prev.filter((_, idx) => idx !== i));
  }

  function setSlotUser(i, user) {
    setUserSlots(prev => prev.map((u, idx) => idx === i ? user : u));
  }

  function switchTab(key) {
    setVisitedTabs(prev => new Set([...prev, key]));
    setTab(key);
  }

  function setDiffCount(tabKey, count) {
    setTabDiffCounts(prev => prev[tabKey] === count ? prev : { ...prev, [tabKey]: count });
  }

  async function compare() {
    const toCompare = userSlots.filter(Boolean);
    if (toCompare.length === 0) return;
    setLoading(true);
    setError(null);
    setDatas([]);
    setComparedUsers([]);
    setVisitedTabs(new Set(['permsets']));
    setTabDiffCounts({});
    try {
      const results = await Promise.all(toCompare.map(u => getUserData(u.Id)));
      setDatas(results);
      setComparedUsers(toCompare);
      setTab('permsets');
      setVisitedTabs(new Set(TABS.map(t => t.key))); // mount all tabs immediately → parallel background fetch
      setCompareKey(k => k + 1);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    clearSession();
    onLogout();
  }

  function handleOrgSwitch() {
    setUserSlots([null]);
    setComparedUsers([]);
    setDatas([]);
    setError(null);
    setTabDiffCounts({});
    setVisitedTabs(new Set(['permsets']));
    setTab('permsets');
    setCompareKey(k => k + 1);
  }

  const showResults = comparedUsers.length >= 1 && datas.length === comparedUsers.length;

  // PermSetTab calls onDiffCount which sets tabDiffCounts['permsets'] — use that directly
  // to avoid computing the same value twice.
  const permSetDiffCount = tabDiffCounts['permsets'] ?? null;

  const totalDiffs = Object.values(tabDiffCounts).reduce((s, n) => s + n, 0);
  const loadedTabCount = Object.keys(tabDiffCounts).length;
  // Navigate to the tab with the most diffs (most useful destination)
  const mostDiffTab = Object.entries(tabDiffCounts)
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'permsets';

  const profileNames = userSlots.map(u => u?.Profile?.Name).filter(Boolean);
  const allSameProfile = profileNames.length === selectedUsers.length &&
    profileNames.length > 0 && new Set(profileNames).size === 1;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <CloudIcon />
          <span className="app-title">SF Permission Comparator</span>
          {orgDomain && (
            <>
              <span className="topbar-divider" />
              <OrgSwitcher orgDomain={orgDomain} onSwitch={handleOrgSwitch} />
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn-ghost" title="Refresh" onClick={() => window.location.reload()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg>
          </button>
          <button className="btn-ghost" onClick={logout}>Disconnect</button>
        </div>
      </header>

      <div className="workspace">
        {/* User selection cards */}
        <div className="users-row">
          {userSlots.map((user, i) => (
            <div className="user-card" key={i}>
              <div className="user-card-header">
                <div className="user-card-label">
                  <span className="user-card-dot" style={{ background: SLOT_COLORS[i].main }} />
                  User {SLOT_LABELS[i]}
                </div>
                {userSlots.length > 1 && (
                  <button className="remove-user-btn" onClick={() => removeSlot(i)} title="Remove">×</button>
                )}
              </div>
              <UserPicker
                selected={user}
                onSelect={u => setSlotUser(i, u)}
                placeholder="Search by name…"
                slot={i}
              />
              {user?.Profile?.Name && (
                <div className="profile-chip" style={{
                  background: SLOT_COLORS[i].bg,
                  color: SLOT_COLORS[i].text,
                  border: `1px solid ${SLOT_COLORS[i].border}`,
                  marginTop: 8,
                }}>
                  {user.Profile.Name}
                </div>
              )}
            </div>
          ))}

          {userSlots.length < MAX_USERS && (
            <button className="add-user-card" onClick={addSlot} title="Add another user">
              <span className="add-user-card-icon">+</span>
              Add User
            </button>
          )}
        </div>

        {/* Action row */}
        <div className="action-row">
          <div className="action-row-left">
            {selectedUsers.length >= 2 ? (
              <div className={`profile-status ${allSameProfile ? 'match' : 'mismatch'}`}>
                {allSameProfile
                  ? `✓ All ${selectedUsers.length} users share profile: ${profileNames[0]}`
                  : `${selectedUsers.length} users selected · ${new Set(profileNames).size} profile${new Set(profileNames).size !== 1 ? 's' : ''}`}
              </div>
            ) : selectedUsers.length === 1 && isSingleMode ? (
              <div className="profile-status hint-status">
                Click to view permissions for {selectedUsers[0].Name}
              </div>
            ) : (
              <div className="profile-status hint-status">
                {selectedUsers.length === 0
                  ? (isSingleMode ? 'Select a user to view their permissions' : 'Select at least 2 users to compare')
                  : 'Add one more user to compare'}
              </div>
            )}
          </div>
          <button
            className="btn-primary btn-compare"
            onClick={compare}
            disabled={!canRun || loading}
          >
            {loading
              ? <><span className="btn-spinner" /> {isSingleMode ? 'Loading…' : 'Comparing…'}</>
              : isSingleMode
                ? <><span className="sparkle">✦</span> Show Permissions</>
                : <><span className="sparkle">✦</span> Compare Permissions <span className="sparkle">✦</span></>}
          </button>
        </div>

        {error && <div className="error-banner">{error}</div>}

        {loading && (
          <div className="compare-loading">
            <div className="compare-loading-track">
              <div className="compare-loading-fill" />
            </div>
            <span className="compare-loading-label">
              {isSingleMode ? `Loading permissions for ${selectedUsers[0]?.Name ?? 'user'}…` : `Fetching permissions for ${selectedUsers.length} users…`}
            </span>
          </div>
        )}

        {showResults && (
          <div className="results-panel" key={compareKey}>
            {/* Summary banner */}
            <div className="compare-summary">
              {comparedUsers.length >= 2 && (
                <div className="summary-stat s-diffs clickable" onClick={() => { switchTab('permsets'); setPermSetDiffTrigger(n => n + 1); }}>
                  <div className="summary-stat-num" key={permSetDiffCount}>{permSetDiffCount}</div>
                  <div className="summary-stat-label">Perm Set Diffs</div>
                </div>
              )}
              {comparedUsers.length >= 2 && loadedTabCount > 0 && (
                <div className="summary-stat s-diffs clickable" onClick={() => switchTab(mostDiffTab)}>
                  <div className="summary-stat-num" key={totalDiffs}>{totalDiffs}</div>
                  <div className="summary-stat-label">Total Diffs Found</div>
                </div>
              )}
              <UsersStat users={comparedUsers} />
            </div>

            {/* Tab bar */}
            <div className="tabs">
              {TABS.map(t => {
                const count = tabDiffCounts[t.key];
                return (
                  <button
                    key={t.key}
                    className={tab === t.key ? 'tab active' : 'tab'}
                    onClick={() => switchTab(t.key)}
                  >
                    {t.label}
                    {count != null ? (
                      <span key={count} className={`tab-badge ${count > 0 ? 'has-diff' : 'no-diff'}`}>{count}</span>
                    ) : visitedTabs.has(t.key) ? (
                      <span className="tab-badge loading">…</span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            {/* Tab panes */}
            <div className={`tab-pane${tab === 'permsets' ? ' active' : ''}`}>
              <PermSetTab users={comparedUsers} datas={datas}
                onDiffCount={n => setDiffCount('permsets', n)}
                diffTrigger={permSetDiffTrigger} />
            </div>
            {visitedTabs.has('sysperms') && (
              <div className={`tab-pane${tab === 'sysperms' ? ' active' : ''}`}>
                <SystemPermsTab users={comparedUsers} datas={datas}
                  onDiffCount={n => setDiffCount('sysperms', n)} />
              </div>
            )}
            {visitedTabs.has('objperms') && (
              <div className={`tab-pane${tab === 'objperms' ? ' active' : ''}`}>
                <ObjPermTab users={comparedUsers} datas={datas}
                  onDiffCount={n => setDiffCount('objperms', n)} />
              </div>
            )}
            {visitedTabs.has('fieldperms') && (
              <div className={`tab-pane${tab === 'fieldperms' ? ' active' : ''}`}>
                <FieldPermsTab users={comparedUsers} datas={datas} />
              </div>
            )}
            {visitedTabs.has('access') && (
              <div className={`tab-pane${tab === 'access' ? ' active' : ''}`}>
                <AccessTab users={comparedUsers} datas={datas}
                  onDiffCount={n => setDiffCount('access', n)} />
              </div>
            )}
            {visitedTabs.has('reports') && (
              <div className={`tab-pane${tab === 'reports' ? ' active' : ''}`}>
                <ReportsDashboardsTab users={comparedUsers} datas={datas}
                  onDiffCount={n => setDiffCount('reports', n)} />
              </div>
            )}
            {visitedTabs.has('layouts') && (
              <div className={`tab-pane${tab === 'layouts' ? ' active' : ''}`}>
                <LayoutsTypesTab users={comparedUsers} datas={datas}
                  onDiffCount={n => setDiffCount('layouts', n)} />
              </div>
            )}
          </div>
        )}
      </div>

      <AgentChat users={comparedUsers} datas={datas} />
    </div>
  );
}

function CloudIcon() {
  return (
    <svg width="26" height="18" viewBox="0 0 52 36" fill="none">
      <path d="M26 2C18.8 2 13 7.8 13 15c0 1.8.37 3.5 1.04 5.06C12.57 19.3 10.8 18.8 9 18.8 4.03 18.8 0 22.83 0 27.8S4.03 36.8 9 36.8h34c4.97 0 9-4.03 9-9 0-3.47-1.97-6.5-4.87-8.05A13.4 13.4 0 0 0 48 17C48 9.27 41.73 3 34 3c0 0-.01 0-8-1z" fill="#60A5FA"/>
      <path d="M26 0C18.8 0 13 5.8 13 13c0 1.8.37 3.5 1.04 5.06C12.57 17.3 10.8 16.8 9 16.8 4.03 16.8 0 20.83 0 25.8S4.03 34.8 9 34.8h34c4.97 0 9-4.03 9-9 0-3.47-1.97-6.5-4.87-8.05A13.4 13.4 0 0 0 48 15C48 7.27 41.73 1 34 1c0 0 0 0-8-1z" fill="#fff" fillOpacity=".9"/>
    </svg>
  );
}
