import React, { useEffect, useState } from 'react';
import { Database, Cpu, RotateCcw, Eraser, Users, Building2, UserPlus, Trash2, Copy, KeyRound } from 'lucide-react';
import { api } from '../api';
import { Badge, Button, Card, Spinner, fmtTime, useToast } from '../components/ui';

const ROLE_LABEL = { admin: 'Admin', support_manager: 'Support manager', support_agent: 'Support agent' };
const ROLE_HELP = {
  admin: 'Everything, including team, integrations and workspace data.',
  support_manager: 'Approves refunds, replacements and coupons; manages knowledge and integrations.',
  support_agent: 'Works tickets, generates drafts and proposes actions.',
};

function copy(text, toast) {
  try { navigator.clipboard.writeText(text); toast('Copied'); } catch { toast(text); }
}

function WorkspaceTab({ user, org, ws, onOrgChange }) {
  const toast = useToast();
  const [name, setName] = useState(org.name);
  const [busy, setBusy] = useState(false);
  const origin = window.location.origin;
  const save = async () => {
    setBusy(true);
    try { const o = await api('/api/workspace', { method: 'PATCH', body: { name } }); onOrgChange({ ...org, ...o }); toast('Workspace renamed'); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="grid g2" style={{ alignItems: 'start' }}>
      <Card title="Workspace" icon={Building2}>
        <div className="stack">
          <label className="field">Workspace name<input className="input" value={name} onChange={e => setName(e.target.value)} disabled={user.role !== 'admin'} /></label>
          <div className="kv">
            <span className="k">Plan</span><span><Badge tone="indigo">{org.is_demo ? 'demo' : org.plan}</Badge></span>
            <span className="k">Workspace ID</span><span className="mono small">{org.org_id}</span>
            <span className="k">Created</span><span className="small">{fmtTime(org.created_at)}</span>
            <span className="k">Data</span><span className="small">{ws.documents} documents · {ws.tickets} tickets · {ws.customers} customers</span>
          </div>
          {user.role === 'admin' && <div><Button variant="primary" busy={busy} disabled={name === org.name} onClick={save}>Save</Button></div>}
        </div>
      </Card>
      <Card title="Public key" icon={KeyRound}>
        <div className="small muted mb">Identifies this workspace on public surfaces — the website widget and inbound webhooks. It is safe to put in your website's HTML.</div>
        <div className="row"><code className="input mono" style={{ flex: 1 }}>{org.public_key}</code><Button icon={Copy} onClick={() => copy(org.public_key, toast)}>Copy</Button></div>
        <div className="small muted mt">Webhook base URL</div>
        <code className="small mono">{origin}/api/webhooks/&lt;zendesk|freshdesk|intercom&gt;?key={org.public_key}</code>
      </Card>
    </div>
  );
}

function TeamTab({ user }) {
  const toast = useToast();
  const [team, setTeam] = useState(null);
  const [f, setF] = useState({ name: '', email: '', role: 'support_agent' });
  const [created, setCreated] = useState(null);
  const [busy, setBusy] = useState(false);
  const canInvite = ['admin', 'support_manager'].includes(user.role);
  const load = () => api('/api/team').then(setTeam);
  useEffect(() => { load(); }, []);

  const invite = async () => {
    setBusy(true);
    try { const out = await api('/api/team', { method: 'POST', body: f }); setCreated(out); setF({ name: '', email: '', role: 'support_agent' }); load(); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const setRole = async (m, role) => { try { await api(`/api/team/${m.user_id}`, { method: 'PATCH', body: { role } }); toast(`${m.name} is now ${ROLE_LABEL[role]}`); load(); } catch (e) { toast(e.message, 'error'); } };
  const remove = async m => {
    if (!window.confirm(`Remove ${m.name} from the workspace? They will be signed out immediately.`)) return;
    try { await api(`/api/team/${m.user_id}`, { method: 'DELETE' }); toast(`${m.name} removed`); load(); } catch (e) { toast(e.message, 'error'); }
  };

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1fr)', alignItems: 'start' }}>
      <Card title="Members" icon={Users} bodyClass="">
        {team === null ? <div className="card-b"><Spinner /></div> : (
          <table className="table">
            <thead><tr><th>Name</th><th>Role</th><th>Last login</th><th /></tr></thead>
            <tbody>{team.map(m => (
              <tr key={m.user_id}>
                <td><div className="row"><div className="avatar" style={{ background: '#eef0ff', color: '#4f46e5', width: 28, height: 28 }}>{m.name[0]}</div><div><div className="bold">{m.name}{m.user_id === user.user_id && <span className="faint small"> (you)</span>}</div><div className="tiny muted">{m.email}</div></div></div></td>
                <td>{user.role === 'admin' && m.user_id !== user.user_id ? (
                  <select className="select" style={{ width: 170, padding: '4px 8px' }} value={m.role} onChange={e => setRole(m, e.target.value)}>
                    {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>) : <Badge tone="indigo">{ROLE_LABEL[m.role]}</Badge>}</td>
                <td className="small muted">{m.last_login_at ? fmtTime(m.last_login_at) : 'never'}</td>
                <td>{user.role === 'admin' && m.user_id !== user.user_id && <button className="btn ghost sm" title="Remove" onClick={() => remove(m)}><Trash2 size={13} /></button>}</td>
              </tr>))}</tbody>
          </table>
        )}
      </Card>
      <Card title="Invite a teammate" icon={UserPlus}>
        {!canInvite ? <div className="small muted">Only admins and support managers can invite teammates.</div> : (
          <div className="stack">
            <label className="field">Name<input className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></label>
            <label className="field">Email<input className="input" type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></label>
            <label className="field">Role
              <select className="select" value={f.role} onChange={e => setF({ ...f, role: e.target.value })}>
                {Object.entries(ROLE_LABEL).filter(([k]) => user.role === 'admin' || k !== 'admin').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <div className="tiny muted">{ROLE_HELP[f.role]}</div>
            <Button variant="primary" icon={UserPlus} busy={busy} disabled={!f.name || !f.email} onClick={invite}>Add to workspace</Button>
            {created && (
              <div className="callout green small" style={{ flexDirection: 'column' }}>
                <div><b>{created.user.name}</b> can now log in with:</div>
                <div className="mono">{created.user.email}</div>
                <div className="row"><span className="mono">{created.temporary_password}</span><button className="btn sm" onClick={() => copy(created.temporary_password, toast)}><Copy size={12} /></button></div>
                <div className="tiny">Share this temporary password securely — it is shown only once.</div>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function ModelDataTab({ user, ws, reload }) {
  const toast = useToast();
  const [keepDocs, setKeepDocs] = useState(true);
  const [busy, setBusy] = useState('');
  const canReset = ['support_manager', 'admin'].includes(user.role);
  const reset = async (mode) => {
    const msg = mode === 'empty'
      ? `Clear this workspace? All tickets, customers, orders, drafts, actions and traces are deleted${keepDocs ? ' (knowledge documents are kept)' : ', including ALL knowledge documents'}.`
      : 'Load the BlueGadgets sample store into this workspace? This replaces current workspace data with sample tickets, customers, orders and policies.';
    if (!window.confirm(msg)) return;
    setBusy(mode);
    try {
      const out = await api('/api/workspace/reset', { method: 'POST', body: { mode, keep_documents: keepDocs } });
      toast(`Done: ${out.tickets} tickets, ${out.documents} documents`);
      reload();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(''); }
  };
  return (
    <div className="grid g2" style={{ alignItems: 'start' }}>
      <Card title="AI model" icon={Cpu}>
        <div className="kv">
          <span className="k">Provider</span><span className="bold">{ws.llm.provider === 'mock' ? 'Offline policy engine' : ws.llm.provider}</span>
          <span className="k">Model</span><span className="mono">{ws.llm.model}</span>
          <span className="k">Prompt version</span><span className="mono">{ws.llm.prompt_version}</span>
        </div>
        <div className="small muted mt">Set <span className="mono">GEMINI_API_KEY</span> in the server's <span className="mono">.env</span> to use Gemini. If the hosted model fails, requests fall back to the offline engine and the trace records why. Guardrails, action policy and approvals run in application code regardless of the model.</div>
      </Card>
      <Card title="Workspace data" icon={Database}>
        <div className="small muted mb">Load the sample store to explore every feature, or clear the workspace to start from your own documents and tickets.</div>
        <label className="row small mb"><input type="checkbox" checked={keepDocs} onChange={e => setKeepDocs(e.target.checked)} /> Keep knowledge documents when clearing</label>
        <div className="row wrap">
          <Button icon={RotateCcw} busy={busy === 'demo'} disabled={!canReset} onClick={() => reset('demo')}>Load sample data</Button>
          <Button icon={Eraser} variant="danger" busy={busy === 'empty'} disabled={!canReset} onClick={() => reset('empty')}>Clear workspace</Button>
        </div>
        {!canReset && <div className="tiny muted mt">Only managers or admins can change workspace data.</div>}
      </Card>
    </div>
  );
}

export default function SettingsPage({ user, org, onOrgChange }) {
  const [tab, setTab] = useState('workspace');
  const [ws, setWs] = useState(null);
  const load = () => api('/api/workspace').then(setWs);
  useEffect(() => { load(); }, []);
  if (!ws) return <Spinner />;
  return (
    <div>
      <div className="tabs">
        <button className={`tab ${tab === 'workspace' ? 'active' : ''}`} onClick={() => setTab('workspace')}>Workspace</button>
        <button className={`tab ${tab === 'team' ? 'active' : ''}`} onClick={() => setTab('team')}>Team</button>
        <button className={`tab ${tab === 'model' ? 'active' : ''}`} onClick={() => setTab('model')}>Model & data</button>
      </div>
      {tab === 'workspace' && <WorkspaceTab user={user} org={org} ws={ws} onOrgChange={onOrgChange} />}
      {tab === 'team' && <TeamTab user={user} />}
      {tab === 'model' && <ModelDataTab user={user} ws={ws} reload={load} />}
    </div>
  );
}
