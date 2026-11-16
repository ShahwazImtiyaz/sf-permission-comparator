import { useState, useEffect } from 'react';
import { getFieldObjects, getFieldPermissions } from '../lib/salesforce';
import { SLOT_COLORS } from '../lib/slotColors';
import FilterBar from './FilterBar';
import { isDiff, Check } from '../lib/utils';

export default function FieldPermsTab({ users, datas }) {
  const [objects, setObjects] = useState(null);
  const [loadingObjects, setLoadingObjects] = useState(false);
  const [selectedObj, setSelectedObj] = useState('');
  const [fieldCache, setFieldCache] = useState({});
  const [loadingFields, setLoadingFields] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  useEffect(() => { loadObjects(); }, []);

  async function loadObjects() {
    setLoadingObjects(true);
    setError(null);
    try {
      const allIds = [...new Set(datas.flatMap(data => data.permSets.map(p => p.PermissionSetId)))];
      const objs = await getFieldObjects(allIds);
      setObjects(objs);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingObjects(false);
    }
  }

  async function loadFields(objType) {
    if (selectedObj === objType) return;
    setSelectedObj(objType);
    if (fieldCache[objType]) return;

    setLoadingFields(true);
    setError(null);
    try {
      const permsList = await Promise.all(
        datas.map(data => getFieldPermissions(data.permSets.map(p => p.PermissionSetId), objType))
      );
      setFieldCache(prev => ({ ...prev, [objType]: permsList }));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingFields(false);
    }
  }

  const aggregate = (perms) => {
    const map = new Map();
    for (const p of perms) {
      const ex = map.get(p.Field);
      map.set(p.Field, { read: ex?.read || p.PermissionsRead, edit: ex?.edit || p.PermissionsEdit });
    }
    return map;
  };

  const cached = selectedObj ? fieldCache[selectedObj] : null;
  let rows = [];
  let counts = { all: 0, diff: 0, shared: 0 };

  if (cached) {
    const maps = cached.map(aggregate);
    const allFields = new Set(maps.flatMap(m => [...m.keys()]));
    const allRows = [...allFields].sort().map(field => {
      const vals = maps.map(m => m.get(field) || { read: false, edit: false });
      const diff = isDiff(vals.map(v => v.read)) || isDiff(vals.map(v => v.edit));
      return { field, vals, diff };
    });
    counts = {
      all: allRows.length,
      diff: allRows.filter(r => r.diff).length,
      shared: allRows.filter(r => !r.diff && r.vals.some(v => v.read || v.edit)).length,
    };
    rows = allRows
      .filter(r => !search || r.field.toLowerCase().includes(search.toLowerCase()))
      .filter(r => {
        if (filter === 'diff') return r.diff;
        if (filter === 'shared') return !r.diff && r.vals.some(v => v.read || v.edit);
        return true;
      });
  }

  return (
    <div className="tab-content">
      <div className="field-perm-layout">
        <div className="object-sidebar">
          <div className="sidebar-header">
            {loadingObjects ? 'Loading...' : `Objects (${objects?.length ?? 0})`}
          </div>
          <div className="object-list">
            {loadingObjects && <div className="object-item" style={{ color: 'var(--text-light)' }}>Loading...</div>}
            {objects?.map(obj => (
              <div
                key={obj}
                className={`object-item ${selectedObj === obj ? 'selected' : ''}`}
                onClick={() => loadFields(obj)}
              >
                {obj}
              </div>
            ))}
          </div>
        </div>

        <div className="field-perm-main">
          {error && <div className="error-banner">{error}</div>}
          {!selectedObj && !error && (
            <div className="empty-state">← Select an object to see field permissions</div>
          )}
          {loadingFields && <div className="empty-state"><span className="spinner" /></div>}
          {cached && !loadingFields && (
            <>
              <FilterBar value={filter} onChange={setFilter} search={search} onSearch={setSearch}
                searchPlaceholder="Search fields..." counts={counts} />
              <div className="table-wrap">
                <table className="table-anim">
                  <thead>
                    <tr>
                      <th rowSpan={2}>Field</th>
                      <th colSpan={users.length} className="perm-header">Read</th>
                      <th colSpan={users.length} className="perm-header">Edit</th>
                    </tr>
                    <tr>
                      {['read', 'edit'].flatMap(type =>
                        users.map((u, i) => (
                          <th key={type + i} className="user-sub" style={{
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
                    {rows.map(({ field, vals, diff }) => (
                      <tr key={field} className={diff ? 'diff' : ''}>
                        <td className="obj-name">{field.split('.')[1] || field}</td>
                        {vals.map((v, i) => {
                          const colDiff = isDiff(vals.map(vv => vv.read));
                          return (
                            <td key={'r' + i} className="check-cell"
                              style={colDiff && v.read ? { background: SLOT_COLORS[i].bg } : {}}>
                              <Check value={v.read} />
                            </td>
                          );
                        })}
                        {vals.map((v, i) => {
                          const colDiff = isDiff(vals.map(vv => vv.edit));
                          return (
                            <td key={'e' + i} className="check-cell"
                              style={colDiff && v.edit ? { background: SLOT_COLORS[i].bg } : {}}>
                              <Check value={v.edit} />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    {rows.length === 0 && <tr><td colSpan={users.length * 2 + 1} className="empty">No fields match filter</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
