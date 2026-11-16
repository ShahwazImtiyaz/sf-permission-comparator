function isSalesforceId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9]{15,18}$/.test(id);
}

export function getSession() {
  return {
    token: sessionStorage.getItem('sf_access_token'),
    instanceUrl: sessionStorage.getItem('sf_instance_url'),
  };
}

export function setSession(token, instanceUrl) {
  sessionStorage.setItem('sf_access_token', token);
  sessionStorage.setItem('sf_instance_url', instanceUrl);
}

export function clearSession() {
  sessionStorage.removeItem('sf_access_token');
  sessionStorage.removeItem('sf_instance_url');
  sessionStorage.removeItem('sf_org_name');
}

export function setOrgName(name) {
  sessionStorage.setItem('sf_org_name', name);
}

export function getOrgName() {
  return sessionStorage.getItem('sf_org_name');
}

export function getOrgDomain() {
  const instanceUrl = sessionStorage.getItem('sf_instance_url');
  if (!instanceUrl) return null;
  // https://myorg.my.salesforce.com → myorg
  return instanceUrl
    .replace(/^https?:\/\//, '')
    .replace(/\.my\.salesforce\.com.*$/, '')
    .replace(/\.salesforce\.com.*$/, '');
}

export async function fetchOrgInfo() {
  const { token, instanceUrl } = getSession();
  if (!token) throw new Error('Not authenticated');
  const params = new URLSearchParams({ q: 'SELECT Id, Name FROM Organization LIMIT 1', instanceUrl });
  const res = await fetch(`/api/query?${params}`, { headers: { 'x-sf-token': token } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to fetch org info');
  return data.records?.[0] || null;
}

export async function fetchOrgs() {
  // Try Chrome first (fast). Only fall back to slow SFDX validation when Chrome finds nothing.
  let chromeOrgs = [];
  let chromeError = null;
  try {
    const r = await fetch('/api/chrome-orgs');
    const data = await r.json();
    if (Array.isArray(data)) { chromeOrgs = data; }
    else if (Array.isArray(data.orgs)) { chromeOrgs = data.orgs; chromeError = data.error || null; }
    else { chromeError = data.error || null; }
  } catch {}

  if (chromeOrgs.length > 0) return chromeOrgs;

  // Chrome found nothing — try SFDX (validates each token, can be slow)
  try {
    const r = await fetch('/api/orgs');
    const data = await r.json();
    if (Array.isArray(data) && data.length > 0) {
      return data.map(o => ({ ...o, source: 'sfdx', id: o.username }));
    }
  } catch {}

  const err = new Error('No orgs found. Log into Salesforce in Chrome, or run "sf org login web" in your terminal.');
  err.chromeError = chromeError;
  throw err;
}

export async function loadOrgSession(org) {
  if (typeof org === 'string') org = { id: org, source: 'sfdx', username: org };

  if (org.source === 'chrome') {
    const res = await fetch(`/api/chrome-session?apiHost=${encodeURIComponent(org.id)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load Chrome session');
    return data;
  }

  const res = await fetch('/api/org-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: org.username || org.id }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not load session');
  return data;
}

// ── Core SOQL helper ─────────────────────────────────────────────────────────
async function soql(q) {
  const { token, instanceUrl } = getSession();
  if (!token) throw new Error('Not authenticated');

  const params = new URLSearchParams({ q, instanceUrl });
  let url = `/api/query?${params}`;
  const records = [];

  while (url) {
    const res = await fetch(url, { headers: { 'x-sf-token': token } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || (Array.isArray(data) && data[0]?.message) || 'Query failed');
    if (!data.records) {
      const errCode = Array.isArray(data) ? data[0]?.errorCode : data?.errorCode;
      const errMsg  = Array.isArray(data) ? data[0]?.message  : data?.message;
      if (errCode) throw new Error(errMsg || errCode);
      break;
    }
    records.push(...data.records);
    url = data.done ? null : `/api/query?${new URLSearchParams({ instanceUrl, nextUrl: data.nextRecordsUrl })}`;
  }

  return records;
}

async function tooling(q) {
  const { token, instanceUrl } = getSession();
  if (!token) throw new Error('Not authenticated');

  const records = [];
  let url = `/api/tooling-query?${new URLSearchParams({ q, instanceUrl })}`;

  while (url) {
    const res = await fetch(url, { headers: { 'x-sf-token': token } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Tooling query failed');
    if (!data.records) break;
    records.push(...data.records);
    url = data.done ? null : `/api/tooling-query?${new URLSearchParams({ instanceUrl, nextUrl: data.nextRecordsUrl })}`;
  }

  return records;
}

// ── User search ──────────────────────────────────────────────────────────────
function soslEscape(term) {
  return term.replace(/[?&|!{}\[\]()^~*:\\"'+-]/g, c => '\\' + c);
}

export async function searchUsers(term, signal) {
  const { token, instanceUrl } = getSession();
  if (!token) throw new Error('Not authenticated');

  // NAME FIELDS is much faster for name queries; use ALL FIELDS only when searching by email/username
  const scope = term.includes('@') ? 'ALL FIELDS' : 'NAME FIELDS';

  try {
    const escaped = soslEscape(term);
    const sosl = `FIND {${escaped}*} IN ${scope} RETURNING User(Id, Name, Username, Email, Profile.Id, Profile.Name WHERE IsActive = true ORDER BY Name LIMIT 20)`;
    const params = new URLSearchParams({ q: sosl, instanceUrl });
    const res = await fetch(`/api/search?${params}`, { headers: { 'x-sf-token': token }, signal });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.searchRecords)) return data.searchRecords;
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
  }

  // Fallback to SOQL only if request wasn't cancelled
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  // Escape backslash first (must be before other replacements), then SOQL LIKE special chars
  const escapedSoql = term.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/%/g, '\\%').replace(/_/g, '\\_');
  return soql(
    `SELECT Id, Name, Username, Email, Profile.Id, Profile.Name FROM User ` +
    `WHERE IsActive = true AND (Name LIKE '%${escapedSoql}%' OR Username LIKE '%${escapedSoql}%') ` +
    `ORDER BY Name LIMIT 20`
  );
}

// ── Per-user data ────────────────────────────────────────────────────────────
export async function getUserData(userId) {
  if (!isSalesforceId(userId)) throw new Error('Invalid user ID');
  const permSets = await soql(
    `SELECT PermissionSetId, PermissionSet.Name, PermissionSet.Label, ` +
    `PermissionSet.IsCustom, PermissionSet.IsOwnedByProfile ` +
    `FROM PermissionSetAssignment WHERE AssigneeId = '${userId}'`
  );
  return { permSets };
}

// ── Object permissions ────────────────────────────────────────────────────────
export async function getObjectPermissions(permSetIds) {
  if (!permSetIds.length) return [];
  const CHUNK = 200;
  const chunks = [];
  for (let i = 0; i < permSetIds.length; i += CHUNK)
    chunks.push(permSetIds.slice(i, i + CHUNK).map(id => `'${id}'`).join(','));
  const results = await Promise.all(chunks.map(ids =>
    soql(
      `SELECT ParentId, SobjectType, PermissionsRead, PermissionsCreate, PermissionsEdit, ` +
      `PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords ` +
      `FROM ObjectPermissions WHERE ParentId IN (${ids}) ORDER BY SobjectType`
    )
  ));
  return results.flat();
}

// ── System (boolean) permissions ──────────────────────────────────────────────
export async function fetchPermFields() {
  const { token, instanceUrl } = getSession();
  const params = new URLSearchParams({ instanceUrl });
  const res = await fetch(`/api/perm-fields?${params}`, { headers: { 'x-sf-token': token } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load permission fields');
  return data; // [{name, label}]
}

export async function getSystemPermissions(permSetIds, fields) {
  if (!permSetIds.length || !fields.length) return {};
  // Only query fields that exist on PermissionSet — Profile-only fields must be queried via getProfilePermissions
  const psFields = fields.filter(f => f.permset !== false);
  if (!psFields.length) return {};

  const ID_CHUNK = 200;
  const F_BATCH = 100;
  const idChunks = [];
  for (let i = 0; i < permSetIds.length; i += ID_CHUNK)
    idChunks.push(permSetIds.slice(i, i + ID_CHUNK).map(id => `'${id}'`).join(','));
  const fieldBatches = [];
  for (let i = 0; i < psFields.length; i += F_BATCH)
    fieldBatches.push(psFields.slice(i, i + F_BATCH));

  const allRecords = (await Promise.all(
    fieldBatches.flatMap(batch =>
      idChunks.map(ids =>
        soql(`SELECT ${batch.map(f => f.name).join(',')} FROM PermissionSet WHERE Id IN (${ids})`)
      )
    )
  )).flat();

  const aggregated = {};
  for (const f of psFields) aggregated[f.name] = allRecords.some(r => r[f.name] === true);
  return aggregated;
}

export async function getProfilePermissions(profileId, fields) {
  // Query Profile-only fields (those that don't exist on PermissionSet)
  const profileOnlyFields = fields.filter(f => f.profile && !f.permset);
  if (!profileId || !profileOnlyFields.length) return {};
  if (!isSalesforceId(profileId)) return {};

  const F_BATCH = 100;
  const batches = [];
  for (let i = 0; i < profileOnlyFields.length; i += F_BATCH)
    batches.push(profileOnlyFields.slice(i, i + F_BATCH));

  const allRecords = (await Promise.all(
    batches.map(batch =>
      soql(`SELECT ${batch.map(f => f.name).join(',')} FROM Profile WHERE Id = '${profileId}'`)
    )
  )).flat();

  const result = {};
  for (const f of profileOnlyFields) result[f.name] = allRecords.some(r => r[f.name] === true);
  return result;
}

// ── Field permissions ─────────────────────────────────────────────────────────
export async function getFieldPermissions(permSetIds, sobjectType) {
  if (!permSetIds.length) return [];
  const CHUNK = 200;
  const chunks = [];
  for (let i = 0; i < permSetIds.length; i += CHUNK)
    chunks.push(permSetIds.slice(i, i + CHUNK).map(id => `'${id}'`).join(','));
  const results = await Promise.all(chunks.map(ids =>
    soql(
      `SELECT Field, PermissionsRead, PermissionsEdit, ParentId ` +
      `FROM FieldPermissions WHERE ParentId IN (${ids}) AND SobjectType = '${sobjectType}' ` +
      `ORDER BY Field`
    )
  ));
  return results.flat();
}

export async function getFieldObjects(permSetIds) {
  if (!permSetIds.length) return [];
  const CHUNK = 200;
  const chunks = [];
  for (let i = 0; i < permSetIds.length; i += CHUNK)
    chunks.push(permSetIds.slice(i, i + CHUNK).map(id => `'${id}'`).join(','));
  // GROUP BY returns one row per type — avoids pulling thousands of raw FieldPermissions records
  const results = await Promise.all(chunks.map(ids =>
    soql(`SELECT SobjectType FROM FieldPermissions WHERE ParentId IN (${ids}) GROUP BY SobjectType`)
  ));
  return [...new Set(results.flat().map(r => r.SobjectType))].sort();
}

// ── App & class access (SetupEntityAccess) ────────────────────────────────────
// NOTE: SetupEntityType filters in SOQL are unreliable on this object — fetch all and filter in JS.
export async function getApexClassAccess(permSetIds) {
  if (!permSetIds.length) return [];
  const CHUNK = 200;
  const chunks = [];
  for (let i = 0; i < permSetIds.length; i += CHUNK)
    chunks.push(permSetIds.slice(i, i + CHUNK).map(id => `'${id}'`).join(','));
  const results = await Promise.all(chunks.map(ids =>
    soql(`SELECT SetupEntityId, SetupEntityType FROM SetupEntityAccess WHERE ParentId IN (${ids})`)
  ));
  return results.flat().filter(r => r.SetupEntityType === 'ApexClass');
}

// Returns true if any perm set grants blanket Apex access (PermissionsModifyAllData = System Admin)
export async function hasBlankApexAccess(permSetIds) {
  if (!permSetIds.length) return false;
  const CHUNK = 200;
  const chunks = [];
  for (let i = 0; i < permSetIds.length; i += CHUNK)
    chunks.push(permSetIds.slice(i, i + CHUNK).map(id => `'${id}'`).join(','));
  const results = await Promise.all(chunks.map(ids =>
    soql(`SELECT Id FROM PermissionSet WHERE Id IN (${ids}) AND PermissionsModifyAllData = true`)
  ));
  return results.some(rows => rows.length > 0);
}

// Returns { ids: [15-char, ...], nameMap: {id: name} } for ALL records of a type in the org
export async function getAllEntities(sobjectType) {
  const nameField = sobjectType === 'CustomPermission' ? 'DeveloperName' : 'Name';
  const records = await soql(`SELECT Id, ${nameField} FROM ${sobjectType} ORDER BY ${nameField}`);
  const ids = [];
  const nameMap = {};
  for (const r of records) {
    const name = r[nameField] || r.Name;
    const id15 = r.Id.substring(0, 15);
    ids.push(id15);
    nameMap[r.Id] = name;
    nameMap[id15] = name;
  }
  return { ids, nameMap };
}

export async function getEntityNames(ids, sobjectType) {
  if (!ids.length) return {};
  const nameField = sobjectType === 'CustomPermission' ? 'DeveloperName' : 'Name';
  const map = {};
  const CHUNK = 500; // SOQL WHERE IN limit
  for (let i = 0; i < ids.length; i += CHUNK) {
    const idList = ids.slice(i, i + CHUNK).map(id => `'${id}'`).join(',');
    try {
      const records = await soql(
        `SELECT Id, ${nameField} FROM ${sobjectType} WHERE Id IN (${idList})`
      );
      for (const r of records) {
        const name = r[nameField] || r.Name;
        map[r.Id] = name;                  // 18-char key
        map[r.Id.substring(0, 15)] = name; // 15-char key (SetupEntityId is 15-char)
      }
    } catch {
      // continue with remaining chunks on error
    }
  }
  return map;
}

// ── Tab settings ──────────────────────────────────────────────────────────────
export async function getTabSettings(permSetIds) {
  if (!permSetIds.length) return [];
  const ids = permSetIds.map(id => `'${id}'`).join(',');
  return soql(
    `SELECT Name, Visibility, ParentId FROM PermissionSetTabSetting WHERE ParentId IN (${ids})`
  );
}

// ── Dashboard cross-metadata ──────────────────────────────────────────────────
export async function getDashboardsInFolder(folderId) {
  return soql(
    `SELECT Id, Title FROM Dashboard WHERE FolderId = '${folderId}' ORDER BY Title`
  ).catch(() => []);
}

// Returns Map<folderId, [{Id, Name}]> for ALL reports in the org (one bulk query).
export async function getAllReportsIndex() {
  const records = await soql(
    `SELECT Id, Name, OwnerId FROM Report ORDER BY Name`
  );
  const map = new Map();
  for (const r of records) {
    if (!r.OwnerId) continue;
    if (!map.has(r.OwnerId)) map.set(r.OwnerId, []);
    map.get(r.OwnerId).push({ Id: r.Id, Name: r.Name });
    // Also index by 15-char ID to handle cross-format matches
    const short = r.OwnerId.substring(0, 15);
    if (short !== r.OwnerId) {
      if (!map.has(short)) map.set(short, []);
      map.get(short).push({ Id: r.Id, Name: r.Name });
    }
  }
  return map;
}

export async function getDashboardReportRefs(dashboardId) {
  const { token, instanceUrl } = getSession();
  if (!token) throw new Error('Not authenticated');

  async function analyticsGet(path) {
    const params = new URLSearchParams({ path, instanceUrl });
    const res = await fetch(`/api/analytics?${params}`, { headers: { 'x-sf-token': token } });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error) return null;
    return data;
  }

  function extractRefs(data) {
    const refs = new Map();
    if (!data) return refs;

    // Collect all component arrays from known locations
    const candidates = [
      ...(data.components || []),
      ...(data.dashboardMetadata?.components || []),
      ...(data.componentData || []),
    ];

    for (const comp of candidates) {
      // comp.report.id / comp.report.name
      if (comp?.report?.id) refs.set(comp.report.id, comp.report.name || comp.report.developerName || comp.report.id);
      // comp.reportId / comp.reportName
      if (comp?.reportId) refs.set(comp.reportId, comp.reportName || comp.reportId);
      // comp.props.reportId
      if (comp?.props?.reportId) refs.set(comp.props.reportId, comp.props.reportName || comp.props.reportId);
    }

    // Some orgs return a top-level reportEntities list
    for (const r of (data.dashboardMetadata?.reportEntities || data.reportEntities || [])) {
      if (r?.reportId) refs.set(r.reportId, r.reportName || r.reportId);
    }

    return refs;
  }

  // Try describe first, then fall back to the base dashboard endpoint
  let ids = new Map();
  for (const path of [
    `/services/data/v60.0/analytics/dashboards/${dashboardId}/describe`,
    `/services/data/v60.0/analytics/dashboards/${dashboardId}`,
  ]) {
    const data = await analyticsGet(path);
    ids = extractRefs(data);
    if (ids.size > 0) break;
  }

  if (ids.size === 0) return [];

  // Resolve IDs to report names via SOQL
  const idList = [...ids.keys()].map(id => `'${id}'`).join(',');
  const reports = await soql(`SELECT Id, Name FROM Report WHERE Id IN (${idList})`).catch(() => []);
  const nameMap = Object.fromEntries(reports.map(r => [r.Id, r.Name]));

  return [...ids.keys()].map(id => ({ id, name: nameMap[id] || ids.get(id) }));
}

// ── Reports & Dashboards folder access ───────────────────────────────────────
export async function getFolderAccess(userId) {
  // Query Folder directly — filter to named folders only (system/personal folders have null Name).
  const folders = await soql(
    `SELECT Id, Name, Type FROM Folder WHERE Type IN ('Report', 'Dashboard') AND Name LIKE '_%' LIMIT 2000`
  ).catch(() => []);

  if (!folders.length) return [];

  // Fetch user context and system permissions in parallel.
  // ManageReports / ManageDashboards grants implicit Manage access to all folders
  // without creating FolderShare records — must be checked separately.
  const [userRec, groupMemberships] = await Promise.all([
    soql(`SELECT UserRoleId, ProfileId FROM User WHERE Id = '${userId}'`).catch(() => []),
    soql(`SELECT GroupId FROM GroupMember WHERE UserOrGroupId = '${userId}'`).catch(() => []),
  ]);

  const profileId = userRec[0]?.ProfileId;
  const [profilePerms, psPerms] = await Promise.all([
    profileId
      ? soql(`SELECT PermissionsModifyAllData, PermissionsManageReports, PermissionsManageDashboards FROM Profile WHERE Id = '${profileId}'`).catch(() => [])
      : Promise.resolve([]),
    soql(
      `SELECT PermissionsModifyAllData, PermissionsManageReports, PermissionsManageDashboards FROM PermissionSet ` +
      `WHERE IsOwnedByProfile = false AND Id IN ` +
      `(SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = '${userId}')`
    ).catch(() => []),
  ]);

  // ModifyAllData = System Admin bypass — overrides all folder sharing restrictions.
  const isAdmin =
    profilePerms[0]?.PermissionsModifyAllData === true ||
    psPerms.some(p => p.PermissionsModifyAllData === true);
  const canManageReports = isAdmin ||
    profilePerms[0]?.PermissionsManageReports === true ||
    psPerms.some(p => p.PermissionsManageReports === true);
  const canManageDashboards = isAdmin ||
    profilePerms[0]?.PermissionsManageDashboards === true ||
    psPerms.some(p => p.PermissionsManageDashboards === true);

  const subjectIds = new Set([userId]);
  if (userRec[0]?.UserRoleId) subjectIds.add(userRec[0].UserRoleId);
  for (const gm of groupMemberships) subjectIds.add(gm.GroupId);
  const idList = [...subjectIds].map(id => `'${id}'`).join(',');

  const ORDER = { Manage: 3, Edit: 2, View: 1 };
  const accessMap = {};

  // Process in chunks of 100 folder IDs to keep IN clauses manageable
  const CHUNK = 100;
  for (let i = 0; i < folders.length; i += CHUNK) {
    const folderIdChunk = folders.slice(i, i + CHUNK).map(f => `'${f.Id}'`).join(',');
    try {
      const shares = await soql(
        `SELECT FolderId, AccessLevel FROM FolderShare ` +
        `WHERE FolderId IN (${folderIdChunk}) ` +
        `AND (SubjectId IN (${idList}) OR SubjectType IN ('Organization', 'AllInternalUsers'))`
      );
      for (const share of shares) {
        const cur = ORDER[accessMap[share.FolderId]] || 0;
        const next = ORDER[share.AccessLevel] || 1;
        if (next > cur) accessMap[share.FolderId] = share.AccessLevel;
      }
    } catch {}
  }

  return folders.map(f => {
    const explicit = accessMap[f.Id] || accessMap[f.Id?.substring(0, 15)];
    // System permissions grant implicit Manage on all folders of that type —
    // takes precedence over any lower explicit share level.
    if (f.Type === 'Report' && canManageReports) return { ...f, AccessLevel: 'Manage' };
    if (f.Type === 'Dashboard' && canManageDashboards) return { ...f, AccessLevel: 'Manage' };
    return { ...f, AccessLevel: explicit || 'None' };
  });
}

// ── Record types (profile-based, Tooling API) ─────────────────────────────────
export async function getRecordTypeVisibility(profileId) {
  if (!profileId || !isSalesforceId(profileId)) return [];
  return tooling(
    `SELECT RecordTypeId, IsDefault, IsPersonAccountDefault, IsVisible, RecordType.Name, RecordType.SobjectType ` +
    `FROM ProfileRecordTypeVisibility WHERE Profile.Id = '${profileId}'`
  ).catch(() => soql(
    `SELECT Id, Name, SobjectType, IsActive FROM RecordType WHERE IsActive = true`
  ).then(rts => rts.map(rt => ({ RecordTypeId: rt.Id, IsDefault: false, IsVisible: true, IsPersonAccountDefault: false, RecordType: { Name: rt.Name, SobjectType: rt.SobjectType } })))
  );
}

// ── Page layouts (profile-based, Tooling API) ─────────────────────────────────
export async function getProfileLayouts(profileId) {
  if (!profileId || !isSalesforceId(profileId)) return [];
  const layouts = await tooling(
    `SELECT LayoutId, Layout.Name, RecordTypeId, RecordType.Name, RecordType.SobjectType, TableEnumOrId ` +
    `FROM ProfileLayout WHERE ProfileId = '${profileId}'`
  );

  // TableEnumOrId is an object API name for standard objects, but an entity ID (starts with a digit)
  // for custom objects. Resolve those IDs to their QualifiedApiName.
  const idsToResolve = [...new Set(
    layouts
      .filter(l => l.TableEnumOrId && /^\d/.test(l.TableEnumOrId))
      .map(l => `'${l.TableEnumOrId.substring(0, 15)}'`)
  )];

  if (!idsToResolve.length) return layouts;

  const rawIds = idsToResolve.map(s => s.replace(/'/g, ''));
  const entityMap = {};

  // TableEnumOrId values like '01I3...' are EntityDefinition record IDs from the Tooling API.
  // Query EntityDefinition by Id via Tooling API — this is the direct, reliable lookup.
  const CHUNK = 100;
  for (let i = 0; i < idsToResolve.length; i += CHUNK) {
    const chunk = idsToResolve.slice(i, i + CHUNK);
    try {
      const entities = await tooling(
        `SELECT Id, QualifiedApiName FROM EntityDefinition WHERE Id IN (${chunk.join(',')})`
      );
      for (const e of entities) {
        if (e.Id && e.QualifiedApiName) entityMap[e.Id.substring(0, 15)] = e.QualifiedApiName;
      }
    } catch {}
  }

  // Fallback: try DurableId via regular SOQL for any still-unresolved IDs
  const unresolved = rawIds.filter(id => !entityMap[id.substring(0, 15)]);
  if (unresolved.length) {
    const unresolvedQuoted = unresolved.map(id => `'${id}'`);
    try {
      const entities = await soql(
        `SELECT DurableId, QualifiedApiName FROM EntityDefinition WHERE DurableId IN (${unresolvedQuoted.join(',')})`
      );
      for (const e of entities) {
        if (e.DurableId) entityMap[e.DurableId.substring(0, 15)] = e.QualifiedApiName;
      }
    } catch {}
  }

  return layouts.map(l => {
    if (!l.TableEnumOrId || !/^\d/.test(l.TableEnumOrId)) return l;
    const resolved = entityMap[l.TableEnumOrId.substring(0, 15)];
    return resolved ? { ...l, TableEnumOrId: resolved } : l;
  });
}

// ── Lightning record pages (FlexiPage assignments, Tooling API) ───────────────
export async function getFlexiPageAssignments(profileId) {
  if (!profileId || !isSalesforceId(profileId)) return [];
  return tooling(
    `SELECT Id, FlexiPageId, FlexiPage.MasterLabel, FlexiPage.EntityDefinitionId, FlexiPage.PageType ` +
    `FROM FlexiPageAssignment WHERE ProfileId = '${profileId}'`
  ).catch(() => []);
}
