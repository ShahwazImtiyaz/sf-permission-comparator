import { useState, useEffect } from 'react';
import { fetchPermFields, getSystemPermissions, getProfilePermissions } from '../lib/salesforce';
import { SLOT_COLORS } from '../lib/slotColors';
import FilterBar from './FilterBar';
import { isDiff, Check } from '../lib/utils';

export default function SystemPermsTab({ users, datas, onDiffCount }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const fields = await fetchPermFields();
      // Run permset queries and profile-only queries in parallel
      const [permsetPerms, profilePerms] = await Promise.all([
        Promise.all(datas.map(data => getSystemPermissions(data.permSets.map(p => p.PermissionSetId), fields))),
        Promise.all(users.map(u => getProfilePermissions(u.Profile?.Id, fields))),
      ]);
      // Merge: permset result + profile-only fields for each user
      const perms = permsetPerms.map((psPerms, i) => ({ ...psPerms, ...profilePerms[i] }));
      setState({ fields, perms });
      const diff = fields.filter(f => isDiff(perms.map(p => p[f.name] ?? false))).length;
      onDiffCount?.(diff);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="tab-content center"><span className="spinner" /><p>Loading system permissions...</p></div>;
  if (error) return <div className="tab-content"><div className="error-banner">{error}</div></div>;
  if (!state) return null;

  const { fields, perms } = state;

  const allRows = fields.map(f => ({
    ...f,
    values: perms.map(p => p[f.name] ?? false),
  }));

  const counts = {
    all: allRows.length,
    diff: allRows.filter(r => isDiff(r.values)).length,
    shared: allRows.filter(r => !isDiff(r.values) && r.values.some(Boolean)).length,
  };

  const rows = allRows
    .filter(r => !search || r.label.toLowerCase().includes(search.toLowerCase()))
    .filter(r => {
      if (filter === 'diff') return isDiff(r.values);
      if (filter === 'shared') return !isDiff(r.values) && r.values.some(Boolean);
      return true;
    });

  return (
    <div className="tab-content">
      <FilterBar value={filter} onChange={setFilter} search={search} onSearch={setSearch}
        searchPlaceholder="Search permissions..." counts={counts} />
      <div className="table-wrap">
        <table className="table-anim">
          <thead>
            <tr>
              <th>System Permission</th>
              {users.map((u, i) => (
                <th key={i} style={{
                  background: SLOT_COLORS[i].bg,
                  color: SLOT_COLORS[i].text,
                  borderLeft: `2px solid ${SLOT_COLORS[i].border}`,
                  textAlign: 'center',
                }}>
                  {u.Name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const diff = isDiff(row.values);
              return (
                <tr key={row.name} className={diff ? 'diff' : ''}>
                  <td>{row.label}</td>
                  {row.values.map((v, i) => (
                    <td key={i} className="check-cell"
                      style={diff && v ? { background: SLOT_COLORS[i].bg } : {}}>
                      <Check value={v} />
                    </td>
                  ))}
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={users.length + 1} className="empty">No permissions match filter</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
