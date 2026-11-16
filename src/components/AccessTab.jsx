import { useState, useEffect } from 'react';
import { getApexClassAccess, getAllEntities, hasBlankApexAccess } from '../lib/salesforce';
import { SLOT_COLORS } from '../lib/slotColors';
import FilterBar from './FilterBar';
import { isDiff, Check } from '../lib/utils';

export default function AccessTab({ users, datas, onDiffCount }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState(users.length === 1 ? 'shared' : 'all');
  const [search, setSearch] = useState('');
  const singleUser = users.length === 1;

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      // Run all queries in parallel: blanket-access check, explicit access, and full org class list
      const permSetIdsList = datas.map(data => data.permSets.map(p => p.PermissionSetId));
      const [blanketFlags, accessList, { ids: orgIds, nameMap }] = await Promise.all([
        Promise.all(permSetIdsList.map(ids => hasBlankApexAccess(ids))),
        Promise.all(permSetIdsList.map(ids => getApexClassAccess(ids))),
        getAllEntities('ApexClass'),
      ]);

      // Build per-user Sets — admins with blanket access get all IDs; normalize to 15-char for lookup
      const allIdSet = new Set(orgIds);
      const grantedSets = accessList.map((access, i) =>
        blanketFlags[i] ? allIdSet : new Set(access.map(r => r.SetupEntityId.substring(0, 15)))
      );

      setState({ orgIds, nameMap, grantedSets });

      // Diff count = classes where access differs between users
      let diff = 0;
      for (const id of orgIds) {
        if (isDiff(grantedSets.map(s => s.has(id)))) diff++;
      }
      onDiffCount?.(diff);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="tab-content center"><span className="spinner" /><p>Loading Apex Class access...</p></div>;
  if (error) return <div className="tab-content"><div className="error-banner">{error}</div></div>;
  if (!state) return null;

  const { orgIds, nameMap, grantedSets } = state;

  const rows = orgIds
    .map(id => ({
      id,
      name: nameMap[id] || id,
      has: grantedSets.map(s => s.has(id)),
    }))
    .filter(r => !search || r.name.toLowerCase().includes(search.toLowerCase()))
    .filter(r => {
      if (filter === 'diff') return isDiff(r.has);
      if (filter === 'shared') return singleUser ? r.has[0] : r.has.every(Boolean);
      return true;
    });

  const totalOrg = orgIds.length;
  const diffCount = orgIds.filter(id => isDiff(grantedSets.map(s => s.has(id)))).length;
  // "Shared" = ALL users have access; "Differences" = any user differs — mutually exclusive
  const sharedCount = singleUser
    ? orgIds.filter(id => grantedSets[0].has(id)).length
    : orgIds.filter(id => grantedSets.every(s => s.has(id))).length;

  const counts = {
    all: totalOrg,
    diff: diffCount,
    shared: sharedCount,
  };

  return (
    <div className="tab-content">
      <FilterBar value={filter} onChange={setFilter} search={search} onSearch={setSearch}
        searchPlaceholder="Search by class name..." singleUser={singleUser} counts={counts} />

      <div className="access-section">
        <div className="access-section-header">
          <span className="access-section-title">Apex Classes</span>
          <span style={{ color: '#6B7280', fontSize: 12 }}>{totalOrg} total in org</span>
        </div>

        {rows.length === 0 ? (
          <div className="dropdown-empty" style={{ padding: '24px 0', textAlign: 'center' }}>
            No classes match the current filter
          </div>
        ) : (
          <table className="table-anim">
            <thead>
              <tr>
                <th>Name</th>
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
                const diff = isDiff(row.has);
                return (
                  <tr key={row.id} className={diff ? 'diff' : ''}>
                    <td>{row.name}</td>
                    {row.has.map((has, i) => (
                      <td key={i} className="check-cell"
                        style={diff && has ? { background: SLOT_COLORS[i].bg } : {}}>
                        <Check value={has} />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
