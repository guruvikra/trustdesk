import React, { useCallback, useEffect, useState } from 'react';
import { Inbox as InboxIcon, Plus, Search, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { Badge, Button, Empty, Modal, Spinner, fmtTime, useToast } from '../components/ui';
import TicketDetail from './TicketDetail';
import { go } from '../App';

const FILTERS = [
  ['all', 'All'], ['open', 'Open'], ['needs_approval', 'Needs approval'], ['escalation', 'Escalation suggested'], ['escalated', 'Escalated'], ['resolved', 'Resolved'],
];

function NewTicket({ onClose, onCreated }) {
  const toast = useToast();
  const [f, setF] = useState({ requester_name: '', requester_email: '', subject: '', body: '', order_id: '' });
  const [busy, setBusy] = useState(false);
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    setBusy(true);
    try {
      const t = await api('/api/tickets', { method: 'POST', body: { ...f, channel: 'manual' } });
      toast(`Ticket ${t.ticket_id} created — auto-triage running`);
      onCreated(t.ticket_id);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal title="New ticket" onClose={onClose}>
      <div className="grid g2">
        <label className="field">Customer name<input className="input" value={f.requester_name} onChange={set('requester_name')} /></label>
        <label className="field">Customer email<input className="input" value={f.requester_email} onChange={set('requester_email')} placeholder="matches existing customers by email" /></label>
      </div>
      <label className="field mt">Subject<input className="input" value={f.subject} onChange={set('subject')} /></label>
      <label className="field mt">Message<textarea className="textarea" rows={5} value={f.body} onChange={set('body')} /></label>
      <label className="field mt">Order ID (optional — only linked if it belongs to this customer)<input className="input" value={f.order_id} onChange={set('order_id')} /></label>
      <div className="row mt"><span className="spacer" /><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={submit} disabled={!f.subject && !f.body}>Create ticket</Button></div>
    </Modal>
  );
}

export default function InboxPage({ ticketId, user }) {
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [tickets, setTickets] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    api(`/api/tickets?status=${filter}${q ? `&q=${encodeURIComponent(q)}` : ''}`).then(setTickets).catch(() => setTickets([]));
  }, [filter, q]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(load, 6000); return () => clearInterval(t); }, [load]);

  return (
    <div className="inbox">
      <div className="card">
        <div className="card-b" style={{ paddingBottom: 8 }}>
          <div className="row">
            <div style={{ position: 'relative', flex: 1 }}>
              <Search size={14} className="faint" style={{ position: 'absolute', left: 10, top: 10 }} />
              <input className="input" style={{ paddingLeft: 30 }} placeholder="Search tickets" value={q} onChange={e => setQ(e.target.value)} />
            </div>
            <Button icon={RefreshCw} size="sm" onClick={load} title="Refresh" />
            <Button icon={Plus} variant="primary" size="sm" onClick={() => setCreating(true)}>New</Button>
          </div>
          <div className="row wrap mt">
            {FILTERS.map(([id, label]) => (
              <button key={id} className={`badge ${filter === id ? 'indigo' : ''}`} style={{ border: 0, cursor: 'pointer' }} onClick={() => setFilter(id)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="ticket-list">
          {tickets === null ? <div className="card-b"><Spinner /></div> : tickets.length === 0 ? (
            <Empty icon={InboxIcon} title="No tickets">Create one, connect a helpdesk, or submit through the support widget.</Empty>
          ) : tickets.map(t => (
            <div key={t.ticket_id} className={`ticket-item ${ticketId === t.ticket_id ? 'active' : ''}`} onClick={() => go('inbox', t.ticket_id)}>
              <div className="row small">
                <span className="bold">{t.customer_name}</span>
                <span className="faint tiny">· {t.channel}</span>
                <span className="spacer" />
                <span className="faint tiny">{fmtTime(t.created_at)}</span>
              </div>
              <div className="subj">{t.subject}</div>
              <div className="row wrap">
                <Badge>{t.status}</Badge>
                {t.triage ? <><Badge tone="indigo">{t.triage.category}</Badge><Badge>{t.triage.priority}</Badge>{t.triage.should_escalate && t.status === 'open' && <Badge tone="amber">escalate</Badge>}{t.triage.flags && t.triage.flags.length > 0 && <Badge tone="red">guardrail</Badge>}</> : <Badge tone="">untriaged</Badge>}
                {t.pending_approvals > 0 && <Badge tone="amber">{t.pending_approvals} approval</Badge>}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div>
        {ticketId ? <TicketDetail key={ticketId} ticketId={ticketId} user={user} onChange={load} /> : (
          <div className="card"><Empty icon={InboxIcon} title="Select a ticket">Open a ticket to run triage, generate a cited draft, and review actions.</Empty></div>
        )}
      </div>
      {creating && <NewTicket onClose={() => setCreating(false)} onCreated={id => { setCreating(false); load(); go('inbox', id); }} />}
    </div>
  );
}
