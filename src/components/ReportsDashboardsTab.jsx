import { useState, useEffect, useMemo } from 'react';
import { getFolderAccess, getDashboardsInFolder, getDashboardReportRefs, getAllReportsIndex } from '../lib/salesforce';
import { SLOT_COLORS } from '../lib/slotColors';
import FilterBar from './FilterBar';
import { isDiff } from '../lib/utils';

const ACCESS_BADGE = {
  Manage: { bg: 'rgba(124,58,237,.1)', color: '#6D28D9', label: 'Manage' },
  Edit:   { bg: 'rgba(37,99,235,.1)',  color: '#1D4ED8', label: 'Edit' },
  View:   { bg: 'rgba(5,150,105,.1)',  color: '#047857', label: 'View' },
};

function AccessPill({ level }) {
  const s = ACCESS_BADGE[level] || ACCESS_BADGE.View;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '2px 8px', borderRadius: 20,
      fontSize: 11, fontWeight: 700,
      background: s.bg, color: s.color,
    }}>{s.label}</span>
  );
}

function ExpandBtn({ expanded, onClick, title }) {
  return (
    <button onClick={onClick} title={title} style={{
      background: 'none', border: 'none', cursor: 'pointer',
      padding: '2px 4px', borderRadius: 4,
      fontSize: 10, color: 'var(--text-3)',
      lineHeight: 1, flexShrink: 0,
    }}>
      {expanded ? '▼' : '▶'}
    </button>
  );
}

export default function ReportsDashboardsTab({ users, datas, onDiffCount }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('All');

  // Cross-metadata drill-down state
  const [expandedFolders, setExpandedFolders] = useState(new Set());
  const [folderDashboards, setFolderDashboards] = useState(new Map()); // folderId → { loading, data, error }
  const [expandedDashboards, setExpandedDashboards] = useState(new Set());
  const [dashboardRefs, setDashboardRefs] = useState(new Map()); // dashboardId → { loading, data, error }
  const [reportsByFolder, setReportsByFolder] = useState(null); // null = not loaded; Map<folderId,{Id,Name}[]> when loaded
  const [searchLoadTriggered, setSearchLoadTriggered] = useState(false);

  useEffect(() => { load(); }, []);

  // When search is first typed, pre-load all folder contents so search is comprehensive.
  useEffect(() => {
    if (!search || !state || searchLoadTriggered) return;
    setSearchLoadTriggered(true);

    // Dashboard folders: load per-folder (needed for drill-down UI too)
    const dashFolderIds = new Set();
    state.forEach(list => list.forEach(f => { if (f.Type === 'Dashboard') dashFolderIds.add(f.Id); }));
    const dashToLoad = [...dashFolderIds].filter(id => !folderDashboards.has(id));
    if (dashToLoad.length) {
      setFolderDashboards(prev => {
        const next = new Map(prev);
        dashToLoad.forEach(id => { if (!next.has(id)) next.set(id, { loading: true, data: [], error: null }); });
        return next;
      });
      dashToLoad.forEach(id => {
        getDashboardsInFolder(id)
          .then(data => setFolderDashboards(prev => new Map(prev).set(id, { loading: false, data, error: null })))
          .catch(e => setFolderDashboards(prev => new Map(prev).set(id, { loading: false, data: [], error: e.message })));
      });
    }

    // Report folders: one bulk query for ALL reports, indexed by folder (OwnerId)
    getAllReportsIndex()
      .then(map => setReportsByFolder(map))
      .catch(() => setReportsByFolder(new Map()));
  }, [search, state]);

  // Auto-expand folders/dashboards whose children match the search term.
  const searchExpandedFolders = useMemo(() => {
    if (!search) return new Set();
    const sl = search.toLowerCase();
    const exp = new Set();
    for (const [folderId, fd] of folderDashboards) {
      if (fd?.data?.some(d => d.Title?.toLowerCase().includes(sl))) { exp.add(folderId); continue; }
      if (fd?.data) {
        for (const dash of fd.data) {
          const refs = dashboardRefs.get(dash.Id);
          if (refs?.data?.some(r => r.name?.toLowerCase().includes(sl))) { exp.add(folderId); break; }
        }
      }
    }
    return exp;
  }, [search, folderDashboards, dashboardRefs]);

  const searchExpandedDashboards = useMemo(() => {
    if (!search) return new Set();
    const sl = search.toLowerCase();
    const exp = new Set();
    for (const [dashId, refs] of dashboardRefs) {
      if (refs?.data?.some(r => r.name?.toLowerCase().includes(sl))) exp.add(dashId);
    }
    return exp;
  }, [search, dashboardRefs]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const accessLists = await Promise.all(users.map(u => getFolderAccess(u.Id)));
      setState(accessLists);
      const allFolderIds = new Set(accessLists.flatMap(list => list.map(f => f.Id)));
      let diff = 0;
      for (const id of allFolderIds) {
        const levels = accessLists.map(list => list.find(f => f.Id === id)?.AccessLevel || 'None');
        if (isDiff(levels)) diff++;
      }
      onDiffCount?.(diff);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function toggleFolder(folderId) {
    const next = new Set(expandedFolders);
    if (next.has(folderId)) {
      next.delete(folderId);
    } else {
      next.add(folderId);
      if (!folderDashboards.has(folderId)) {
        setFolderDashboards(prev => new Map(prev).set(folderId, { loading: true, data: [], error: null }));
        try {
          const data = await getDashboardsInFolder(folderId);
          setFolderDashboards(prev => new Map(prev).set(folderId, { loading: false, data, error: null }));
        } catch (e) {
          setFolderDashboards(prev => new Map(prev).set(folderId, { loading: false, data: [], error: e.message }));
        }
      }
    }
    setExpandedFolders(next);
  }

  async function toggleDashboard(dashboardId) {
    const next = new Set(expandedDashboards);
    if (next.has(dashboardId)) {
      next.delete(dashboardId);
    } else {
      next.add(dashboardId);
      if (!dashboardRefs.has(dashboardId)) {
        setDashboardRefs(prev => new Map(prev).set(dashboardId, { loading: true, data: [], error: null }));
        try {
          const data = await getDashboardReportRefs(dashboardId);
          setDashboardRefs(prev => new Map(prev).set(dashboardId, { loading: false, data, error: null }));
        } catch (e) {
          setDashboardRefs(prev => new Map(prev).set(dashboardId, { loading: false, data: [], error: e.message }));
        }
      }
    }
    setExpandedDashboards(next);
  }

  if (loading) return <div className="tab-content center"><span className="spinner" /><p>Loading folder access…</p></div>;
  if (error) return <div className="tab-content"><div className="error-banner">{error}</div></div>;
  if (!state) return null;

  const folderMap = new Map();
  state.forEach((list, ui) => {
    list.forEach(f => {
      if (!folderMap.has(f.Id)) folderMap.set(f.Id, { id: f.Id, name: f.Name, type: f.Type, levels: Array(users.length).fill('None') });
      folderMap.get(f.Id).levels[ui] = f.AccessLevel || 'View';
    });
  });

  const allRows = [...folderMap.values()].sort((a, b) => {
    const at = a.type || '', bt = b.type || '';
    if (at !== bt) return at === 'Report' ? -1 : 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  const counts = {
    all: allRows.length,
    diff: allRows.filter(r => isDiff(r.levels)).length,
    shared: allRows.filter(r => !isDiff(r.levels) && r.levels.some(l => l !== 'None')).length,
  };

  const types = ['All', ...new Set(allRows.map(r => r.type))];
  const sl = search.toLowerCase();
  const rows = allRows
    .filter(r => typeFilter === 'All' || r.type === typeFilter)
    .filter(r => {
      if (!search) return true;
      if (r.name.toLowerCase().includes(sl)) return true;
      // Report folder: search through individual report names (bulk-loaded index)
      if (reportsByFolder?.get(r.id)?.some(rep => rep.Name?.toLowerCase().includes(sl))) return true;
      // Dashboard folder: search through dashboard names
      const fd = folderDashboards.get(r.id);
      if (fd?.data?.some(d => d.Title?.toLowerCase().includes(sl))) return true;
      // Dashboard folder: search through report names referenced by dashboards
      if (fd?.data) {
        for (const dash of fd.data) {
          const refs = dashboardRefs.get(dash.Id);
          if (refs?.data?.some(ref => ref.name?.toLowerCase().includes(sl))) return true;
        }
      }
      return false;
    })
    .filter(r => {
      if (filter === 'diff') return isDiff(r.levels);
      if (filter === 'shared') return !isDiff(r.levels) && r.levels.some(l => l !== 'None');
      return true;
    });

  const effectiveExpandedFolders = search
    ? new Set([...expandedFolders, ...searchExpandedFolders])
    : expandedFolders;
  const effectiveExpandedDashboards = search
    ? new Set([...expandedDashboards, ...searchExpandedDashboards])
    : expandedDashboards;

  const colSpanRest = 1 + users.length;

  return (
    <div className="tab-content">
      <div className="filter-bar-row" style={{ marginBottom: 8 }}>
        <div className="filter-toggle-group" style={{ padding: '3px', gap: 2 }}>
          {types.map(t => (
            <button key={t} className={`filter-btn ${typeFilter === t ? 'active' : ''}`}
              onClick={() => setTypeFilter(t)}>
              {t === 'Report' ? '📊 Reports' : t === 'Dashboard' ? '📈 Dashboards' : 'All'}
            </button>
          ))}
        </div>
      </div>
      <FilterBar value={filter} onChange={setFilter} search={search} onSearch={setSearch}
        searchPlaceholder="Search folders, dashboards, reports…" counts={counts} />
      {counts.diff === 0 && counts.all > 0 && users.length > 1 && (
        <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '4px 4px 8px', fontStyle: 'italic' }}>
          All folders show the same access — both users likely share the same role or org-wide folder sharing is active.
        </div>
      )}

      {rows.length === 0 && !loading && (
        <div className="empty" style={{ padding: '40px 24px' }}>
          {allRows.length === 0 ? 'No report or dashboard folders found.' : 'No folders match the current filter.'}
        </div>
      )}

      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="table-anim">
            <thead>
              <tr>
                <th>Folder</th>
                <th>Type</th>
                {users.map((u, i) => (
                  <th key={i} style={{
                    background: SLOT_COLORS[i].bg,
                    color: SLOT_COLORS[i].text,
                    borderLeft: `2px solid ${SLOT_COLORS[i].border}`,
                    textAlign: 'center',
                  }}>
                    {u.Name.split(' ')[0]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.flatMap(row => {
                const diff = isDiff(row.levels);
                const isDashFolder = row.type === 'Dashboard';
                const isExpanded = effectiveExpandedFolders.has(row.id);
                const folderData = folderDashboards.get(row.id);

                const folderRow = (
                  <tr key={row.id} className={diff ? 'diff' : ''}>
                    <td style={{ fontWeight: 500 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {isDashFolder && (
                          <ExpandBtn
                            expanded={isExpanded}
                            onClick={() => toggleFolder(row.id)}
                            title="Show dashboards in this folder"
                          />
                        )}
                        {row.name}
                      </div>
                    </td>
                    <td>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                        background: row.type === 'Report' ? 'rgba(37,99,235,.08)' : 'rgba(124,58,237,.08)',
                        color: row.type === 'Report' ? '#1D4ED8' : '#6D28D9',
                      }}>
                        {row.type === 'Report' ? '📊' : '📈'} {row.type}
                      </span>
                    </td>
                    {row.levels.map((lvl, i) => (
                      <td key={i} className="check-cell"
                        style={diff && lvl !== 'None' ? { background: SLOT_COLORS[i].bg } : {}}>
                        {lvl !== 'None' ? <AccessPill level={lvl} /> : <span className="check no">—</span>}
                      </td>
                    ))}
                  </tr>
                );

                if (!isExpanded || !isDashFolder) return [folderRow];

                // ── Sub-rows: dashboards inside folder ──────────────────────────
                const subRows = [];

                if (!folderData || folderData.loading) {
                  subRows.push(
                    <tr key={`${row.id}-loading`} style={{ background: 'rgba(124,58,237,.03)' }}>
                      <td colSpan={2 + users.length} style={{ paddingLeft: 36, fontSize: 12, color: 'var(--text-3)', fontStyle: 'italic' }}>
                        Loading dashboards…
                      </td>
                    </tr>
                  );
                } else if (folderData.error) {
                  subRows.push(
                    <tr key={`${row.id}-err`}>
                      <td colSpan={2 + users.length} style={{ paddingLeft: 36, fontSize: 12, color: '#dc2626' }}>
                        {folderData.error}
                      </td>
                    </tr>
                  );
                } else if (folderData.data.length === 0) {
                  subRows.push(
                    <tr key={`${row.id}-empty`} style={{ background: 'rgba(124,58,237,.03)' }}>
                      <td colSpan={2 + users.length} style={{ paddingLeft: 36, fontSize: 12, color: 'var(--text-3)', fontStyle: 'italic' }}>
                        No dashboards in this folder.
                      </td>
                    </tr>
                  );
                } else {
                  for (const dash of folderData.data) {
                    const isDashExpanded = effectiveExpandedDashboards.has(dash.Id);
                    const refData = dashboardRefs.get(dash.Id);

                    subRows.push(
                      <tr key={`dash-${dash.Id}`} style={{ background: 'rgba(124,58,237,.04)' }}>
                        <td style={{ paddingLeft: 36 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <ExpandBtn
                              expanded={isDashExpanded}
                              onClick={() => toggleDashboard(dash.Id)}
                              title="Show reports referenced by this dashboard"
                            />
                            <span style={{ fontSize: 13 }}>📈 {dash.Title}</span>
                          </div>
                        </td>
                        <td colSpan={colSpanRest}>
                          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>dashboard</span>
                        </td>
                      </tr>
                    );

                    // ── Sub-sub-rows: reports referenced by dashboard ───────────
                    if (isDashExpanded) {
                      if (!refData || refData.loading) {
                        subRows.push(
                          <tr key={`${dash.Id}-loading`} style={{ background: 'rgba(37,99,235,.03)' }}>
                            <td colSpan={2 + users.length} style={{ paddingLeft: 68, fontSize: 12, color: 'var(--text-3)', fontStyle: 'italic' }}>
                              Loading reports…
                            </td>
                          </tr>
                        );
                      } else if (refData.error) {
                        subRows.push(
                          <tr key={`${dash.Id}-err`}>
                            <td colSpan={2 + users.length} style={{ paddingLeft: 68, fontSize: 12, color: '#dc2626' }}>
                              {refData.error}
                            </td>
                          </tr>
                        );
                      } else if (refData.data.length === 0) {
                        subRows.push(
                          <tr key={`${dash.Id}-empty`} style={{ background: 'rgba(37,99,235,.03)' }}>
                            <td colSpan={2 + users.length} style={{ paddingLeft: 68, fontSize: 12, color: 'var(--text-3)', fontStyle: 'italic' }}>
                              No report components found.
                            </td>
                          </tr>
                        );
                      } else {
                        for (const ref of refData.data) {
                          subRows.push(
                            <tr key={`ref-${ref.id}`} style={{ background: 'rgba(37,99,235,.04)' }}>
                              <td style={{ paddingLeft: 68 }}>
                                <span style={{ fontSize: 12 }}>📊 {ref.name}</span>
                              </td>
                              <td colSpan={colSpanRest}>
                                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>referenced report</span>
                              </td>
                            </tr>
                          );
                        }
                      }
                    }
                  }
                }

                return [folderRow, ...subRows];
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
