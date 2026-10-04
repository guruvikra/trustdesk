import React, { useEffect, useState } from 'react';
import { CheckCircle2, Circle, BookOpen, Sparkles, Plug, MessageSquare, Users, Database } from 'lucide-react';
import { api } from '../api';
import { Button, useToast } from './ui';
import { go } from '../App';

// Getting-started checklist shown on the Dashboard until every step is done.
export default function Onboarding({ stats, user, org, onChanged }) {
  const toast = useToast();
  const [ws, setWs] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('/api/workspace').then(setWs).catch(() => {}); }, [stats]);
  if (!ws || (org && org.is_demo)) return null;

  const steps = [
    { icon: BookOpen, title: 'Add knowledge', text: 'Upload a policy PDF, doc or help-centre page.', done: stats.documents.total > 0, page: 'knowledge' },
    { icon: Sparkles, title: 'Ask the assistant', text: 'Get a cited answer from your documents.', done: stats.assistant.questions > 0, page: 'assistant' },
    { icon: Plug, title: 'Bring in tickets', text: 'Connect Zendesk or Freshdesk, or create a ticket.', done: ws.integrations_connected.length > 0 || stats.tickets.total > 0, page: 'integrations' },
    { icon: MessageSquare, title: 'Try the support form', text: 'See a customer question answered before a ticket exists.', done: stats.widget.questions > 0, page: 'support-form' },
    { icon: Users, title: 'Invite your team', text: 'Add an agent and a manager for approvals.', done: ws.team_size > 1, page: 'settings' },
  ];
  const doneCount = steps.filter(s => s.done).length;
  if (doneCount === steps.length) return null;

  const loadSample = async () => {
    if (!window.confirm('Load the BlueGadgets sample store (8 tickets, 6 customers, orders and 8 policies) into this workspace?')) return;
    setBusy(true);
    try { await api('/api/workspace/reset', { method: 'POST', body: { mode: 'demo' } }); toast('Sample data loaded'); onChanged(); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="onboard">
      <div className="row wrap">
        <div style={{ flex: 1 }}>
          <div className="bold" style={{ fontSize: 16 }}>Welcome{user ? `, ${user.name.split(' ')[0]}` : ''} — let's set up your workspace</div>
          <div className="small muted">{doneCount} of {steps.length} steps complete</div>
        </div>
        {stats.tickets.total === 0 && ['admin', 'support_manager'].includes(user.role) && (
          <Button icon={Database} busy={busy} onClick={loadSample}>Load sample data instead</Button>
        )}
      </div>
      <div className="bar mt" style={{ background: '#fff' }}><span style={{ width: `${(doneCount / steps.length) * 100}%` }} /></div>
      <div className="onboard-steps">
        {steps.map(s => (
          <div key={s.title} className={`ostep ${s.done ? 'done' : ''}`} onClick={() => go(s.page)}>
            <div className="row">{s.done ? <CheckCircle2 size={16} color="var(--green)" /> : <Circle size={16} className="faint" />}<s.icon size={15} className="muted" /></div>
            <div className="t">{s.title}</div>
            <div className="d">{s.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
