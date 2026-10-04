import React, { useEffect, useState } from 'react';
import { Bot, Wand2, FileEdit, Send, ShieldCheck, Zap, Activity, Play } from 'lucide-react';
import { api } from '../api';
import { Badge, Button, Card, Empty, Spinner, fmtTime, useToast } from '../components/ui';
import { go } from '../App';

const MODES = [
  { id: 'triage', icon: Wand2, title: 'Triage only', text: 'Classify category, priority and risk for every new ticket. Agents write replies.' },
  { id: 'draft', icon: FileEdit, title: 'Draft for review', text: 'Triage, then prepare a cited draft and propose actions. An agent reviews and sends.' },
  { id: 'auto', icon: Send, title: 'Auto-reply when confident', text: 'Send the reply automatically when it is safe and above your confidence threshold; otherwise leave a draft.' },
];

const SAFETY = [
  'Guardrails flagged prompt injection, secret requests or identity bypass',
  'Product safety issue or triage recommends a specialist',
  'No policy in your knowledge base covers the topic',
  'The reply has no valid citation or guardrails changed it',
  'Any refund, replacement, coupon or other action is proposed',
  'Confidence is below your threshold',
];

const OUTCOME = {
  auto_replied: ['answered automatically', 'green'],
  drafted: ['draft for review', 'blue'],
  escalated: ['escalated', 'amber'],
  triaged: ['triaged', ''],
  failed: ['failed', 'red'],
};

export default function Automation({ user }) {
  const toast = useToast();
  const [s, setS] = useState(null);
  const [saved, setSaved] = useState(null);
  const [log, setLog] = useState(null);
  const [busy, setBusy] = useState('');
  const [sim, setSim] = useState({ requester_email: 'vikram.sethi@example.com', subject: 'Refund my software license', body: 'I bought the annual cloud backup license (order ord_5004) but changed my mind. Can I get a refund?' });
  const canEdit = ['support_manager', 'admin'].includes(user.role);

  const loadLog = () => api('/api/automation/events?limit=40').then(setLog).catch(() => setLog({ events: [], summary: {} }));
  useEffect(() => {
    api('/api/automation/settings').then(x => { setS(x); setSaved(x); });
    loadLog();
    const t = setInterval(loadLog, 4000);
    return () => clearInterval(t);
  }, []);

  const save = async () => {
    setBusy('save');
    try { const x = await api('/api/automation/settings', { method: 'PUT', body: { mode: s.mode, threshold: s.threshold, auto_escalate: s.auto_escalate } }); setS(x); setSaved(x); toast('Autopilot settings saved'); } catch (e) { toast(e.message, 'error'); } finally { setBusy(''); }
  };
  const simulate = async () => {
    setBusy('sim');
    try {
      const t = await api('/api/tickets', { method: 'POST', body: { ...sim, requester_name: sim.requester_email.split('@')[0], channel: 'simulated' } });
      toast(`Ticket ${t.ticket_id} received — Autopilot is processing it`);
      setTimeout(loadLog, 800);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(''); }
  };

  if (!s) return <Spinner />;
  const dirty = saved && (saved.mode !== s.mode || saved.threshold !== s.threshold || saved.auto_escalate !== s.auto_escalate);
  const sum = (log && log.summary) || {};

  return (
    <div className="stack">
      <div className="grid g4">
        <div className="card stat"><div className="row label"><Send size={14} />Answered automatically</div><div className="value">{sum.auto_replied || 0}</div></div>
        <div className="card stat"><div className="row label"><FileEdit size={14} />Drafts for review</div><div className="value">{sum.drafted || 0}</div></div>
        <div className="card stat"><div className="row label"><ShieldCheck size={14} />Escalated</div><div className="value">{sum.escalated || 0}</div></div>
        <div className="card stat"><div className="row label"><Wand2 size={14} />Triaged only</div><div className="value">{sum.triaged || 0}</div></div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr)', alignItems: 'start' }}>
        <Card title="When a new ticket arrives" icon={Bot} actions={canEdit && <Button variant="primary" busy={busy === 'save'} disabled={!dirty} onClick={save}>Save</Button>}>
          <div className="small muted mb">Runs for every new ticket — helpdesk imports and webhooks, the support form, the widget hand-off and manual tickets.</div>
          <div className="mode-cards">
            {MODES.map(m => (
              <button key={m.id} className={`mode-card ${s.mode === m.id ? 'on' : ''}`} disabled={!canEdit} onClick={() => setS({ ...s, mode: m.id })}>
                <div className="row"><m.icon size={16} /><span className="bold">{m.title}</span>{s.mode === m.id && <Badge tone="indigo">selected</Badge>}</div>
                <div className="small muted">{m.text}</div>
              </button>
            ))}
          </div>

          <div className={`threshold ${s.mode === 'auto' ? '' : 'dim'}`}>
            <div className="row"><span className="bold">Confidence threshold</span><span className="spacer" /><span className="th-val">{Math.round(s.threshold * 100)}%</span></div>
            <input type="range" min="50" max="100" step="1" value={Math.round(s.threshold * 100)} disabled={!canEdit || s.mode !== 'auto'} onChange={e => setS({ ...s, threshold: Number(e.target.value) / 100 })} />
            <div className="row tiny muted"><span>50% · answers more</span><span className="spacer" /><span>100% · answers only when certain</span></div>
            <div className="small muted mt">Confidence combines: governing policy found and cited (35%), how much of the ticket that policy covers (35%), how clear the triage was (20%), and clean grounding (10%). {s.mode !== 'auto' && 'Used only in auto-reply mode.'}</div>
          </div>

          <label className="row small mt"><input type="checkbox" checked={s.auto_escalate} disabled={!canEdit} onChange={e => setS({ ...s, auto_escalate: e.target.checked })} /> Automatically route safety, security and unsupported tickets to specialists</label>
          {!canEdit && <div className="callout blue small mt">Only managers and admins can change Autopilot.</div>}
          {s.updated_by && <div className="tiny faint mt">Last changed by {s.updated_by} · {fmtTime(s.updated_at)}</div>}
        </Card>

        <div className="stack">
          <Card title="Never sent automatically when…" icon={ShieldCheck}>
            <ul className="safety-list">{SAFETY.map(x => <li key={x}>{x}</li>)}</ul>
            <div className="tiny muted">These rules are enforced in code. The reply is kept as a draft with the reason, and actions still need manager approval.</div>
          </Card>
          <Card title="Try it" icon={Zap}>
            <div className="small muted mb">Send a ticket through the same pipeline as a real incoming one.</div>
            <div className="stack" style={{ gap: 8 }}>
              <input className="input" value={sim.requester_email} onChange={e => setSim({ ...sim, requester_email: e.target.value })} placeholder="Customer email" />
              <input className="input" value={sim.subject} onChange={e => setSim({ ...sim, subject: e.target.value })} placeholder="Subject" />
              <textarea className="textarea" rows={3} value={sim.body} onChange={e => setSim({ ...sim, body: e.target.value })} />
              <Button icon={Play} busy={busy === 'sim'} disabled={!sim.body.trim()} onClick={simulate}>Send test ticket</Button>
            </div>
          </Card>
        </div>
      </div>

      <Card title="Autopilot activity" icon={Activity} bodyClass="">
        {!log ? <div className="card-b"><Spinner /></div> : log.events.length === 0 ? <Empty icon={Bot} title="No activity yet">New tickets will appear here with what Autopilot did and why. Use “Send test ticket” to try it.</Empty> : (
          <table className="table">
            <thead><tr><th>Ticket</th><th>Source</th><th>Outcome</th><th>Confidence</th><th>Why</th><th>When</th></tr></thead>
            <tbody>{log.events.map(e => {
              const [label, tone] = OUTCOME[e.outcome] || [e.outcome, ''];
              return (
                <tr key={e.event_id} className="click" onClick={() => go('inbox', e.ticket_id)}>
                  <td><div className="small bold" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.subject || e.ticket_id}</div><div className="tiny faint mono">{e.ticket_id}</div></td>
                  <td className="small">{String(e.trigger).startsWith('manual:') ? 'run manually' : String(e.trigger).replace('_', ' ')}</td>
                  <td><Badge tone={tone}>{label}</Badge><div className="tiny faint">{e.mode} mode</div></td>
                  <td className="small">{e.confidence !== null && e.confidence !== undefined ? <span><b>{Math.round(e.confidence * 100)}%</b>{e.mode === 'auto' && <span className="faint"> / {Math.round(e.threshold * 100)}%</span>}</span> : '—'}</td>
                  <td className="tiny" style={{ maxWidth: 380 }}>{e.reasons.length ? e.reasons.join(' · ') : e.detail || '—'}</td>
                  <td className="small muted">{fmtTime(e.created_at)}</td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
