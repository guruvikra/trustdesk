import React, { useEffect, useState } from 'react';
import { Plug, RefreshCw, CheckCircle2, Webhook, Send, X, KeyRound, Link as LinkIcon, Copy, MessageSquare, ArrowRight, Info } from 'lucide-react';
import { api } from '../api';
import { Badge, Button, Card, Json, Spinner, fmtTime, useToast } from '../components/ui';
import { go } from '../App';

const MODE_LABEL = { api_key: 'API key', oauth: 'OAuth' };

const WEBHOOK_TEMPLATES = {
  zendesk: '{\n  "ticket": {\n    "id": "{{ticket.id}}",\n    "subject": "{{ticket.title}}",\n    "description": "{{ticket.description}}",\n    "requester": { "email": "{{ticket.requester.email}}", "name": "{{ticket.requester.name}}" }\n  }\n}',
  freshdesk: '{\n  "ticket_id": "{{ticket.id}}",\n  "ticket_subject": "{{ticket.subject}}",\n  "ticket_description": "{{ticket.description}}",\n  "ticket_contact_email": "{{ticket.contact.email}}",\n  "ticket_contact_name": "{{ticket.contact.name}}"\n}',
  intercom: 'Intercom sends its own payload — in the Developer Hub subscribe your app to the topic conversation.user.created.',
  front: 'Front sends its own payload — create a Rule with action "Send to a webhook" on inbound messages.',
};
const rnd = () => Math.floor(Math.random() * 90000) + 10000;
const SAMPLE = {
  zendesk: () => ({ ticket: { id: rnd(), subject: 'Earbuds case will not charge', description: 'The charging case for my BlueBuds Air stopped working after 3 weeks. Order ord_5001.', requester: { email: 'aisha.rao@example.com', name: 'Aisha Rao' } } }),
  freshdesk: () => ({ ticket_id: rnd(), ticket_subject: 'Where is my order?', ticket_description: 'Tracking has not updated for 7 business days and I need it before my trip.', ticket_contact_email: 'rahul.mehta@example.com', ticket_contact_name: 'Rahul Mehta' }),
  intercom: () => ({ data: { item: { id: String(rnd()), source: { subject: 'Charged twice', body: '<p>I was charged two times for my BlueWatch order.</p>' }, user: { email: 'arjun.patel@example.com', name: 'Arjun Patel' } } } }),
  front: () => ({ conversation: { id: `cnv_${rnd()}`, subject: 'Exchange request', recipient: { handle: 'nisha.verma@example.com', name: 'Nisha Verma' } }, target: { data: { text: 'Can I exchange my HomeCam Mini for a different model?' } } }),
};

const Logo = ({ app, size = 42 }) => <div className="app-logo" style={{ background: app.color, width: size, height: size }}>{app.label[0]}</div>;

function copy(text, toast) { try { navigator.clipboard.writeText(text); toast('Copied'); } catch { toast(text); } }

function ConnectDrawer({ app, canEdit, onClose, onChange }) {
  const toast = useToast();
  const [mode, setMode] = useState(app.enabled ? app.auth_mode : app.auth_modes[0]);
  const [form, setForm] = useState(app.config);
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);
  const act = async (what, fn) => { setBusy(what); setResult(null); try { await fn(); } catch (e) { setResult({ error: e.message }); } finally { setBusy(''); } };
  const fields = app.fields[mode] || [];

  const save = () => act('save', async () => {
    await api(`/api/integrations/${app.platform}`, { method: 'PUT', body: { ...form, auth_mode: mode } });
    let msg = `${app.label} credentials saved`;
    try { msg = (await api(`/api/integrations/${app.platform}/test`, { method: 'POST' })).message; } catch (e) { setResult({ error: e.message }); toast('Saved, but the connection test failed', 'error'); onChange(); return; }
    setResult({ ok: msg }); toast(`${app.label} connected`); onChange();
  });
  const oauth = () => act('oauth', async () => {
    if (fields.length) await api(`/api/integrations/${app.platform}`, { method: 'PUT', body: { ...form, auth_mode: 'oauth' } });
    const { url } = await api(`/api/integrations/${app.platform}/oauth/start`, { method: 'POST' });
    window.location.href = url;
  });
  const test = () => act('test', async () => setResult({ ok: (await api(`/api/integrations/${app.platform}/test`, { method: 'POST' })).message }));
  const sync = () => act('sync', async () => { const r = await api(`/api/integrations/${app.platform}/sync`, { method: 'POST' }); setResult({ ok: r.message, ticket: r.ticket_ids[0] }); onChange(); });
  const disconnect = () => act('off', async () => { await api(`/api/integrations/${app.platform}`, { method: 'DELETE' }); toast(`${app.label} disconnected`); onChange(); onClose(); });

  return (
    <div className="drawer-back" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-h">
          <Logo app={app} />
          <div style={{ flex: 1 }}>
            <div className="bold" style={{ fontSize: 17 }}>{app.label}</div>
            <div className="small muted">{app.kind === 'helpdesk' ? 'Helpdesk' : 'Issue tracker'} · {app.enabled ? <span style={{ color: 'var(--green)' }}>Connected via {MODE_LABEL[app.auth_mode]}</span> : 'Not connected'}</div>
          </div>
          <button className="btn ghost sm" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="drawer-b">
          <div className="small muted">{app.description}</div>

          {app.auth_modes.length > 1 && (
            <div className="seg-control" style={{ alignSelf: 'flex-start' }}>
              {app.auth_modes.map(m => <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>{m === 'oauth' ? <LinkIcon size={12} /> : <KeyRound size={12} />} {MODE_LABEL[m]}</button>)}
            </div>
          )}

          {fields.map(f => (
            <label key={f.key} className="field">{f.label}
              <input className="input" type={f.secret ? 'password' : 'text'} placeholder={f.placeholder} value={form[f.key] || ''} onChange={e => setForm({ ...form, [f.key]: e.target.value })} disabled={!canEdit} />
            </label>
          ))}

          {mode === 'api_key' && (
            <>
              <div className="callout blue small"><Info size={14} style={{ flexShrink: 0 }} /><span>{app.help}</span></div>
              {canEdit && <Button variant="primary" icon={CheckCircle2} busy={busy === 'save'} onClick={save}>{app.enabled && app.auth_mode === 'api_key' ? 'Save & test' : `Connect ${app.label}`}</Button>}
            </>
          )}

          {mode === 'oauth' && app.oauth && (
            app.oauth.available ? (
              <>
                <div className="small muted">You'll be sent to {app.label} to approve access, then returned here.</div>
                {canEdit && <Button variant="primary" icon={LinkIcon} busy={busy === 'oauth'} onClick={oauth}>Connect with {app.label}</Button>}
              </>
            ) : (
              <div className="callout amber small" style={{ flexDirection: 'column', gap: 6 }}>
                <b>OAuth isn't configured on this server yet.</b>
                <span>1. Create an OAuth app in {app.label} and register this redirect URL:</span>
                <div className="row"><code className="mono tiny" style={{ wordBreak: 'break-all' }}>{app.oauth.redirect_uri}</code><button className="btn sm" onClick={() => copy(app.oauth.redirect_uri, toast)}><Copy size={12} /></button></div>
                <span>2. Add to the server's <span className="mono">.env</span> and restart: <span className="mono">{app.oauth.env_vars.join(', ')}</span></span>
                <span>Or switch to API key above — it works right away.</span>
              </div>
            )
          )}

          {!canEdit && <div className="callout blue small">Only managers and admins can change connections.</div>}

          {app.enabled && (
            <Card title="Connection" icon={Plug}>
              <div className="row wrap">
                <Button icon={CheckCircle2} busy={busy === 'test'} onClick={test}>Test connection</Button>
                {app.capabilities.import && <Button icon={RefreshCw} busy={busy === 'sync'} onClick={sync}>Import open conversations</Button>}
                {canEdit && <Button variant="danger" busy={busy === 'off'} onClick={disconnect}>Disconnect</Button>}
              </div>
              {app.last_sync_at && <div className="tiny muted mt">Last import {fmtTime(app.last_sync_at)}{app.last_result && app.last_result.message ? ` — ${app.last_result.message}` : ''}</div>}
              <div className="tiny muted mt">
                {app.capabilities.import ? `Imported conversations are triaged and drafted like any ticket. Sending a reply from TrustDesk posts it back to ${app.label} and resolves it there.` : 'Open any ticket and use "Create Linear issue" to escalate it to engineering with full context.'}
              </div>
            </Card>
          )}

          {result && (result.error
            ? <div className="callout red small">{result.error}</div>
            : <div className="callout green small"><CheckCircle2 size={14} /> {result.ok}{result.ticket && <button className="btn sm ghost" onClick={() => go('inbox', result.ticket)}>Open</button>}</div>)}
        </div>
      </div>
    </div>
  );
}

export default function Integrations({ user, org, param }) {
  const toast = useToast();
  const [apps, setApps] = useState(null);
  const [open, setOpen] = useState(null);
  const [platform, setPlatform] = useState('zendesk');
  const [payload, setPayload] = useState(JSON.stringify(SAMPLE.zendesk(), null, 2));
  const [resp, setResp] = useState(null);
  const canEdit = ['support_manager', 'admin'].includes(user.role);
  const load = () => api('/api/integrations').then(setApps);
  useEffect(() => { load(); }, []);

  // Returning from an OAuth redirect: #/integrations/connected=zendesk or oauth_error=...
  useEffect(() => {
    if (!param) return;
    const [k, v] = param.split('=');
    if (k === 'connected') toast(`${v} connected via OAuth`);
    if (k === 'oauth_error') toast(decodeURIComponent(v || 'OAuth failed'), 'error');
    window.history.replaceState(null, '', '#/integrations');
  }, [param]);

  const fire = async () => {
    try {
      const r = await fetch(`/api/webhooks/${platform}?key=${org.public_key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
      const data = await r.json();
      setResp(data);
      if (!r.ok) toast(data.detail, 'error'); else toast(data.created ? `Webhook created ticket ${data.ticket_id}` : `Duplicate webhook — ticket ${data.ticket_id} already exists`);
    } catch (e) { toast('Invalid JSON payload', 'error'); }
  };

  if (!apps) return <Spinner />;
  const current = open && apps.find(a => a.platform === open);
  const connected = apps.filter(a => a.enabled).length;
  return (
    <div className="stack">
      <div className="row"><div className="small muted">{connected} of {apps.length} apps connected · tickets from every source run through the same triage, cited drafts and approvals.</div></div>
      <div className="apps">
        {apps.map(app => (
          <div key={app.platform} className="app-card">
            <div className="row">
              <Logo app={app} />
              <div style={{ flex: 1 }}>
                <div className="bold">{app.label}</div>
                <div className="tiny muted">{app.kind === 'helpdesk' ? 'Helpdesk' : 'Issue tracker'} · {app.auth_modes.map(m => MODE_LABEL[m]).join(' / ')}</div>
              </div>
              {app.enabled ? <Badge tone="green"><span className="dot" style={{ background: 'var(--green)' }} /> connected</Badge> : <Badge tone="">not connected</Badge>}
            </div>
            <div className="desc">{app.description}</div>
            <Button variant={app.enabled ? '' : 'primary'} onClick={() => setOpen(app.platform)}>{app.enabled ? 'Manage' : 'Connect'} <ArrowRight size={14} /></Button>
          </div>
        ))}
        <div className="app-card">
          <div className="row"><div className="app-logo" style={{ background: '#4f46e5' }}><MessageSquare size={20} /></div><div style={{ flex: 1 }}><div className="bold">Website widget</div><div className="tiny muted">Channel · one script tag</div></div><Badge tone="green">built in</Badge></div>
          <div className="desc">Answer customers on your site from public knowledge, and hand off to a ticket when it can't help.</div>
          <Button onClick={() => go('widget')}>Set up widget <ArrowRight size={14} /></Button>
        </div>
      </div>

      <div className="grid g2">
        <Card title="Inbound webhooks" icon={Webhook}>
          <div className="small muted mb">Real-time alternative to importing: point a helpdesk trigger at this URL (needs a public URL such as ngrok when running locally).</div>
          <div className="row mb">
            <select className="select" style={{ width: 160 }} value={platform} onChange={e => { setPlatform(e.target.value); setPayload(JSON.stringify(SAMPLE[e.target.value](), null, 2)); }}>
              {Object.keys(SAMPLE).map(p => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
            </select>
            <button className="btn sm" onClick={() => copy(`${window.location.origin}/api/webhooks/${platform}?key=${org.public_key}`, toast)}><Copy size={12} /> Copy URL</button>
          </div>
          <code className="small mono" style={{ wordBreak: 'break-all' }}>POST {window.location.origin}/api/webhooks/{platform}?key={org.public_key}</code>
          <pre className="json mt">{WEBHOOK_TEMPLATES[platform]}</pre>
        </Card>
        <Card title="Webhook tester" icon={Send}>
          <div className="small muted mb">Send a sample payload to the real endpoint. Sending the same payload twice does not create a duplicate ticket.</div>
          <textarea className="textarea mono" rows={10} value={payload} onChange={e => setPayload(e.target.value)} />
          <div className="row mt"><Button variant="primary" icon={Send} onClick={fire}>Send webhook</Button>{resp && resp.ticket_id && <Button onClick={() => go('inbox', resp.ticket_id)}>Open {resp.ticket_id}</Button>}</div>
          {resp && <div className="mt"><Json value={resp} /></div>}
        </Card>
      </div>
      {current && <ConnectDrawer key={current.platform} app={current} canEdit={canEdit} onClose={() => setOpen(null)} onChange={load} />}
    </div>
  );
}
