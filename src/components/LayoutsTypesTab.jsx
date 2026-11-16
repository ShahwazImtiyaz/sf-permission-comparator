import { useState, useEffect } from 'react';
import { getProfileLayouts, getFlexiPageAssignments } from '../lib/salesforce';
import { SLOT_COLORS } from '../lib/slotColors';
import FilterBar from './FilterBar';
import { isDiff, Check } from '../lib/utils';

function PageLayoutsSection({ users, layoutLists, search }) {
  const [filter, setFilter] = useState('all');

  const layoutMap = new Map();
  layoutLists.forEach((list, ui) => {
    list.forEach(r => {
      const obj = r.RecordType?.SobjectType || r.TableEnumOrId || '—';
      const rt = r.RecordType?.Name || 'Master';
      const layout = r.Layout?.Name || '—';
      const key = `${obj}::${rt}`;
      if (!layoutMap.has(key)) {
        layoutMap.set(key, { key, obj, rt, layouts: Array(users.length).fill('—') });
      }
      layoutMap.get(key).layouts[ui] = layout;
    });
  });

  const allRows = [...layoutMap.values()]
    .filter(r => !search || r.obj.toLowerCase().includes(search.toLowerCase()) || r.rt.toLowerCase().includes(search.toLowerCase()) || r.layouts.some(l => l.toLowerCase().includes(search.toLowerCase())))
    .sort((a, b) => (a.obj || '').localeCompare(b.obj || '') || (a.rt || '').localeCompare(b.rt || ''));

  const counts = {
    all: allRows.length,
    diff: allRows.filter(r => isDiff(r.layouts)).length,
    shared: allRows.filter(r => !isDiff(r.layouts)).length,
  };

  const rows = allRows.filter(r => {
    if (filter === 'diff') return isDiff(r.layouts);
    if (filter === 'shared') return !isDiff(r.layouts);
    return true;
  });

  return (
    <div className="access-section" style={{ marginBottom: 24 }}>
      <FilterBar value={filter} onChange={setFilter} searchPlaceholder="" counts={counts} />
      {rows.length === 0 ? (
        <div className="empty">No page layouts found.</div>
      ) : (
        <div className="table-wrap">
          <table className="table-anim">
            <thead>
              <tr>
                <th>Object</th>
                <th>Record Type</th>
                {users.map((u, i) => (
                  <th key={i} style={{
                    background: SLOT_COLORS[i].bg, color: SLOT_COLORS[i].text,
                    borderLeft: `2px solid ${SLOT_COLORS[i].border}`,
                  }}>
                    {u.Name.split(' ')[0]} — Layout
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const diff = isDiff(row.layouts);
                return (
                  <tr key={row.key} className={diff ? 'diff' : ''}>
                    <td style={{ fontWeight: 500, color: 'var(--text-2)', fontSize: 12 }}>{row.obj}</td>
                    <td>{row.rt}</td>
                    {row.layouts.map((l, i) => (
                      <td key={i} style={diff && l !== '—' ? { background: SLOT_COLORS[i].bg, fontWeight: 500 } : {}}>
                        {l !== '—' ? l : <span className="check no">—</span>}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FlexiPagesSection({ users, flexiLists, search }) {
  const pageMap = new Map();
  flexiLists.forEach((list, ui) => {
    list.forEach(r => {
      const key = r.FlexiPageId;
      const label = r.FlexiPage?.MasterLabel || key;
      const pageType = r.FlexiPage?.PageType || '—';
      const entity = r.FlexiPage?.EntityDefinitionId || '—';
      if (!pageMap.has(key)) {
        pageMap.set(key, { key, label, pageType, entity, has: Array(users.length).fill(false) });
      }
      pageMap.get(key).has[ui] = true;
    });
  });

  const rows = [...pageMap.values()]
    .filter(r => !search || r.label.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (a.entity || '').localeCompare(b.entity || '') || (a.label || '').localeCompare(b.label || ''));

  if (rows.length === 0) return null;

  const diffCount = rows.filter(r => isDiff(r.has)).length;

  return (
    <div className="access-section" style={{ marginBottom: 24 }}>
      <div className="access-section-header">
        <span className="access-section-title">Lightning Record Pages</span>
        <span className="pill shared">{rows.length - diffCount} shared</span>
        {diffCount > 0 && <span className="pill only-a">{diffCount} differ</span>}
      </div>
      <div className="table-wrap">
        <table className="table-anim">
          <thead>
            <tr>
              <th>Page Name</th>
              <th>Object</th>
              {users.map((u, i) => (
                <th key={i} style={{
                  background: SLOT_COLORS[i].bg, color: SLOT_COLORS[i].text,
                  borderLeft: `2px solid ${SLOT_COLORS[i].border}`, textAlign: 'center',
                }}>
                  {u.Name.split(' ')[0]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const diff = isDiff(row.has);
              return (
                <tr key={row.key} className={diff ? 'diff' : ''}>
                  <td style={{ fontWeight: 500 }}>{row.label}</td>
                  <td style={{ color: 'var(--text-2)', fontSize: 12 }}>{row.entity}</td>
                  {row.has.map((h, i) => (
                    <td key={i} className="check-cell"
                      style={diff && h ? { background: SLOT_COLORS[i].bg } : {}}>
                      <Check value={h} />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function LayoutsTypesTab({ users, datas, onDiffCount }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [section, setSection] = useState('layouts');

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      // Map over ALL users so index aligns with user slot even when some have no profile
      const [layoutLists, flexiLists] = await Promise.all([
        Promise.all(users.map(u => u.Profile?.Id ? getProfileLayouts(u.Profile.Id).catch(() => [])       : Promise.resolve([]))),
        Promise.all(users.map(u => u.Profile?.Id ? getFlexiPageAssignments(u.Profile.Id).catch(() => []) : Promise.resolve([]))),
      ]);

      setState({ layoutLists, flexiLists });

      // Diff count: layouts only
      const lyMap = new Map();
      layoutLists.forEach((list, ui) => list.forEach(r => {
        const key = `${r.RecordType?.SobjectType || r.TableEnumOrId}::${r.RecordType?.Name || 'Master'}`;
        if (!lyMap.has(key)) lyMap.set(key, Array(users.length).fill('—'));
        lyMap.get(key)[ui] = r.Layout?.Name || '—';
      }));
      let diff = 0;
      lyMap.forEach(vals => { if (isDiff(vals)) diff++; });
      onDiffCount?.(diff);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="tab-content center"><span className="spinner" /><p>Loading layouts &amp; record types…</p></div>;
  if (error) return <div className="tab-content"><div className="error-banner">{error}</div></div>;
  if (!state) return null;

  const { layoutLists, flexiLists } = state;
  const hasFlexiData = flexiLists.some(l => l.length > 0);

  return (
    <div className="tab-content">
      <div className="filter-bar-row" style={{ marginBottom: 16 }}>
        <input className="filter-input" placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} />
        <div className="filter-toggle-group">
          <button className={`filter-btn ${section === 'layouts' ? 'active' : ''}`} onClick={() => setSection('layouts')}>Page Layouts</button>
          {hasFlexiData && (
            <button className={`filter-btn ${section === 'flexi' ? 'active' : ''}`} onClick={() => setSection('flexi')}>Lightning Pages</button>
          )}
        </div>
      </div>

      {section === 'layouts' && <PageLayoutsSection users={users} layoutLists={layoutLists} search={search} />}
      {section === 'flexi' && hasFlexiData && <FlexiPagesSection users={users} flexiLists={flexiLists} search={search} />}
    </div>
  );
}
