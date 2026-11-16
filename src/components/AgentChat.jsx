import { useState, useRef, useEffect } from 'react';
import { getFieldPermissions, getObjectPermissions } from '../lib/salesforce';

const SUGGESTIONS = [
  'Which user has more permissions?',
  'Who can edit Accounts?',
  'What permission sets does each user have?',
  'Who has system admin permissions?',
];

// Well-known Salesforce object API names for fuzzy matching from natural language
const SF_OBJECTS = [
  'Account','Contact','Lead','Opportunity','Case','Task','Event','User','Contract',
  'Order','Product2','Pricebook2','PricebookEntry','Asset','Campaign','CampaignMember',
  'Quote','QuoteLineItem','Entitlement','ServiceContract','WorkOrder','WorkOrderLineItem',
  'KnowledgeArticle','Solution','Idea','FeedItem','Attachment','ContentDocument',
  'ContentVersion','EmailMessage','Note','Report','Dashboard','ApexClass','ApexTrigger',
];

function keywords(prompt) {
  const stop = new Set(['a','an','the','is','are','for','of','in','on','to','and','or','do','does',
    'both','all','what','who','which','can','have','has','with','about','me','i','my','their',
    'this','that','these','those','how','why','when','where','show','find','get','give','tell',
    'looking','check','compare','between','users','user','permission','permissions','access',
    'fields','field','level','object','objects']);
  return prompt.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !stop.has(w));
}

function matches(text, kws) {
  if (!kws.length) return true;
  const t = text.toLowerCase();
  return kws.some(k => t.includes(k));
}

// Detect which Salesforce object the question is about (returns API name or null)
function detectObject(prompt) {
  const p = prompt.toLowerCase();
  for (const obj of SF_OBJECTS) {
    if (p.includes(obj.toLowerCase())) return obj;
  }
  // Also try capitalising each word e.g. "work order" → WorkOrder
  const words = p.split(/\s+/);
  for (let i = 0; i < words.length - 1; i++) {
    const compound = words[i][0].toUpperCase() + words[i].slice(1) +
                     words[i+1][0].toUpperCase() + words[i+1].slice(1);
    if (SF_OBJECTS.includes(compound)) return compound;
  }
  return null;
}

function isFieldQuestion(prompt) {
  const p = prompt.toLowerCase();
  return p.includes('field') || p.includes('fields') || p.includes('field level') ||
         p.includes('field-level') || p.includes('fls');
}

function isObjectQuestion(prompt) {
  const p = prompt.toLowerCase();
  return p.includes('object') || p.includes('crud') || p.includes('read') ||
         p.includes('create') || p.includes('edit') || p.includes('delete') ||
         p.includes('view all') || p.includes('modify all');
}

function buildBaseContext(users, datas, kws) {
  return users.map((u, i) => {
    const d = datas[i];
    if (!d) return { name: u.Name, profile: u.Profile?.Name };
    const allPermSets = d.permSets?.filter(p => p.PermissionSet && !p.PermissionSet.IsOwnedByProfile) ?? [];
    const permSetLabels = allPermSets
      .map(p => p.PermissionSet.Label || p.PermissionSet.Name)
      .filter(label => !kws.length || matches(label, kws));
    const sysPerms = [];
    for (const ps of d.permSets ?? []) {
      for (const [k, v] of Object.entries(ps.PermissionSet ?? {})) {
        if (k.startsWith('Permissions') && v === true) {
          const readable = k.replace('Permissions', '');
          if (!kws.length || matches(readable, kws)) sysPerms.push(readable);
        }
      }
    }
    const result = { name: u.Name, profile: u.Profile?.Name };
    if (permSetLabels.length) result.matchingPermissionSets = [...new Set(permSetLabels)];
    if (sysPerms.length) result.matchingSystemPermissions = [...new Set(sysPerms)];
    if (!result.matchingPermissionSets && !result.matchingSystemPermissions) {
      result.totalPermissionSets = allPermSets.length;
    }
    return result;
  });
}

async function buildContext(users, datas, prompt = '') {
  if (!users?.length || !datas?.length) return null;
  const kws = keywords(prompt);
  const detectedObj = detectObject(prompt);

  // Field-level question with a known object: fetch live FLS data
  if (isFieldQuestion(prompt) && detectedObj) {
    try {
      const permSetIdsList = datas.map(d => d.permSets?.map(p => p.PermissionSetId) ?? []);
      const fieldPermsList = await Promise.all(
        permSetIdsList.map(ids => getFieldPermissions(ids, detectedObj))
      );
      const aggregate = (perms) => {
        const map = new Map();
        for (const p of perms) {
          const ex = map.get(p.Field);
          map.set(p.Field, { read: ex?.read || p.PermissionsRead, edit: ex?.edit || p.PermissionsEdit });
        }
        return map;
      };
      const maps = fieldPermsList.map(aggregate);
      const allFields = [...new Set(fieldPermsList.flat().map(p => p.Field))].sort();
      return {
        type: 'fieldPermissions',
        object: detectedObj,
        users: users.map((u, i) => ({
          name: u.Name,
          profile: u.Profile?.Name,
          fields: allFields.map(f => {
            const v = maps[i]?.get(f) || { read: false, edit: false };
            return { field: f.replace(`${detectedObj}.`, ''), read: v.read, edit: v.edit };
          }).filter(f => f.read || f.edit), // only include fields where they have any access
        })),
      };
    } catch (e) {
      // fall through to base context if fetch fails
    }
  }

  // Object-level CRUD question with a known object: fetch object permissions
  if (isObjectQuestion(prompt) && detectedObj) {
    try {
      const permSetIdsList = datas.map(d => d.permSets?.map(p => p.PermissionSetId) ?? []);
      const objPermsList = await Promise.all(
        permSetIdsList.map(ids => getObjectPermissions(ids))
      );
      return {
        type: 'objectPermissions',
        object: detectedObj,
        users: users.map((u, i) => {
          const perms = objPermsList[i]?.find(p => p.SobjectType === detectedObj);
          return {
            name: u.Name,
            profile: u.Profile?.Name,
            [detectedObj]: perms
              ? { read: perms.PermissionsRead, create: perms.PermissionsCreate,
                  edit: perms.PermissionsEdit, delete: perms.PermissionsDelete,
                  viewAll: perms.PermissionsViewAllRecords, modifyAll: perms.PermissionsModifyAllRecords }
              : 'no access',
          };
        }),
      };
    } catch (e) {
      // fall through
    }
  }

  return buildBaseContext(users, datas, kws);
}

export default function AgentChat({ users, datas }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [apiKeyMissing, setApiKeyMissing] = useState(false);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function send(text) {
    const q = (text || input).trim();
    if (!q || loading) return;
    setInput('');
    const userMsg = { role: 'user', text: q };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);
    setApiKeyMissing(false);
    try {
      const context = await buildContext(users, datas, q);
      const resp = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: q, context }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setMessages(prev => [...prev, { role: 'agent', text: data.error || 'Something went wrong.', error: true }]);
      } else {
        setMessages(prev => [...prev, { role: 'agent', text: data.answer }]);
      }
    } catch {
      setMessages(prev => [...prev, { role: 'agent', text: 'Network error. Is the server running?', error: true }]);
    } finally {
      setLoading(false);
    }
  }

  const hasData = users?.length > 0 && datas?.length > 0;

  return (
    <>
      {/* Floating button */}
      <button
        className="agent-fab"
        onClick={() => setOpen(o => !o)}
        title="Ask the AI agent about permissions"
        aria-label="Ask Me"
      >
        {open ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        )}
        <span className="agent-fab-label">Ask Me</span>
      </button>

      {/* Chat drawer */}
      {open && (
        <div className="agent-drawer">
          <div className="agent-drawer-header">
            <div className="agent-drawer-title">
              <span className="agent-drawer-icon">✦</span>
              Permission Agent
            </div>
            <button className="agent-drawer-close" onClick={() => setOpen(false)}>×</button>
          </div>

          <div className="agent-messages">
            {messages.length === 0 && (
              <div className="agent-empty">
                <div className="agent-empty-icon">✦</div>
                <div className="agent-empty-title">Ask me anything about these permissions</div>
                {!hasData && (
                  <div className="agent-empty-hint">Load users first using Show Permissions, then ask questions about them.</div>
                )}
                {hasData && (
                  <div className="agent-suggestions">
                    {SUGGESTIONS.map(s => (
                      <button key={s} className="agent-suggestion" onClick={() => send(s)}>{s}</button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={`agent-msg agent-msg-${m.role}`}>
                {m.role === 'agent' && <div className="agent-msg-label">Agent</div>}
                {m.role === 'user' && <div className="agent-msg-label">You</div>}
                {m.error && apiKeyMissing && m.role === 'agent' ? (
                  <div className="agent-msg-apikey">
                    <strong>ANTHROPIC_API_KEY not set.</strong>
                    <span> Start the server with the env var:</span>
                    <code>ANTHROPIC_API_KEY=sk-ant-... node server.cjs</code>
                  </div>
                ) : (
                  <div className={`agent-msg-bubble ${m.error ? 'agent-msg-error' : ''}`}>{m.text}</div>
                )}
              </div>
            ))}

            {loading && (
              <div className="agent-msg agent-msg-agent">
                <div className="agent-msg-label">Agent</div>
                <div className="agent-msg-bubble agent-msg-thinking">
                  <span className="agent-dot" /><span className="agent-dot" /><span className="agent-dot" />
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <div className="agent-input-row">
            <input
              ref={inputRef}
              className="agent-input"
              placeholder={hasData ? 'Ask about these permissions…' : 'Load users first, then ask…'}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              disabled={loading}
              maxLength={2000}
            />
            <button
              className="agent-send"
              onClick={() => send()}
              disabled={!input.trim() || loading}
              title="Send"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
