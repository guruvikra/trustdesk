import React, { useEffect, useState } from 'react';
import { MessageSquare, Send, CheckCircle2, LifeBuoy, Code, ExternalLink } from 'lucide-react';
import { api } from '../api';
import { Button, Card, Spinner, useToast } from '../components/ui';
import { go } from '../App';

function LiveWidget({ onTicket, publicKey }) {
  const headers = { 'X-Workspace-Key': publicKey };
  const toast = useToast();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [thread, setThread] = useState([]);
  const [handoff, setHandoff] = useState(null);
  const [form, setForm] = useState({ name: '', email: '', details: '' });

  const ask = async () => {
    const question = q.trim();
    if (!question) return;
    setQ('');
    setThread(t => [...t, { role: 'user', text: question }]);
    setBusy(true);
    try {
      const out = await api('/api/public/ask', { method: 'POST', body: { question }, headers });
      setThread(t => [...t, { role: 'bot', ...out }]);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const decide = (ev, decided) => setThread(t => t.map(m => (m.event_id === ev.event_id ? { ...m, decided } : m)));
  const outcome = async (ev, resolved) => {
    if (resolved) {
      try {
        await api(`/api/public/deflections/${ev.event_id}/outcome`, { method: 'POST', body: { resolved: true }, headers });
        decide(ev, 'resolved');
        setThread(t => [...t, { role: 'system', text: 'Glad that helped! (counted as deflected — no ticket created)' }]);
      } catch (e) { toast(e.message, 'error'); }
    } else { decide(ev, 'handoff'); setHandoff(ev); }
  };
  const submitTicket = async () => {
    try {
      const out = await api(`/api/public/deflections/${handoff.event_id}/outcome`, { method: 'POST', body: { resolved: false, ...form }, headers });
      setThread(t => [...t, out.ticket_id
        ? { role: 'system', text: `Ticket ${out.ticket_id} ${out.replayed ? 'was already created' : 'created'}. Our team will follow up at ${form.email}.`, ticket: out.ticket_id }
        : { role: 'system', text: 'This question was already marked as answered.' }]);
      setHandoff(null);
      onTicket(out.ticket_id);
    } catch (e) { toast(e.message, 'error'); }
  };

  return (
    <div className="widget">
      <div className="widget-h"><div className="bold">Help center</div><div className="small" style={{ opacity: .85 }}>Instant answers from our policies</div></div>
      <div className="widget-b">
        {thread.length === 0 && <div className="small muted">Ask anything your public knowledge base covers — or something it doesn't, to see the hand-off to a ticket.</div>}
        {thread.map((m, i) => m.role === 'user' ? <div key={i} className="bubble user" style={{ maxWidth: '90%' }}>{m.text}</div>
          : m.role === 'system' ? <div key={i} className="callout green small">{m.text}{m.ticket && <button className="btn sm ghost" onClick={() => go('inbox', m.ticket)}>Open in inbox</button>}</div>
            : (
              <div key={i} className={`bubble bot ${m.answered ? '' : 'unknown'}`} style={{ maxWidth: '95%' }}>
                <div className="small" style={{ lineHeight: 1.55 }}>{m.answer.replace(/\[(\d+)\]/g, '[$1]')}</div>
                {m.citations.length > 0 && <div className="tiny muted mt">Sources: {[...new Map(m.citations.map(c => [c.doc_id, c])).values()].map(c => `${c.title} — ${c.heading}`).join(' · ')}</div>}
                {!m.decided ? (
                  <div className="row mt">
                    <span className="tiny muted">{m.answered ? 'Did this answer your question?' : 'Want a person to help?'}</span>
                    {m.answered && <button className="btn sm" onClick={() => outcome(m, true)}>Yes</button>}
                    <button className="btn sm" onClick={() => outcome(m, false)}>{m.answered ? 'No, contact support' : 'Contact support'}</button>
                  </div>
                ) : <div className="tiny muted mt">{m.decided === 'resolved' ? 'Marked as answered' : 'Sent to support'}</div>}
              </div>
            ))}
        {busy && <div className="small muted"><Spinner /> Looking that up…</div>}
        {handoff && (
          <div className="stack card card-b">
            <div className="small bold">Send this to our support team</div>
            <input className="input" placeholder="Your name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            <input className="input" placeholder="Email (required)" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
            <textarea className="textarea" rows={3} placeholder="Anything else? Include your order ID if you have one." value={form.details} onChange={e => setForm({ ...form, details: e.target.value })} />
            <Button variant="primary" icon={LifeBuoy} onClick={submitTicket} disabled={!form.email}>Create ticket</Button>
          </div>
        )}
      </div>
      <div className="chat-input">
        <input className="input" placeholder="Ask a question…" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && ask()} />
        <Button variant="primary" icon={Send} busy={busy} onClick={ask} />
      </div>
    </div>
  );
}

export default function WidgetPage({ org }) {
  const [stats, setStats] = useState(null);
  const load = () => api('/api/stats').then(s => setStats(s.widget)).catch(() => {});
  useEffect(() => { load(); }, []);
  const origin = window.location.origin;
  const snippet = `<script src="${origin}/widget.js" data-trustdesk="${origin}" data-workspace="${org.public_key}" defer></script>`;
  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.1fr)' }}>
      <div className="stack">
        <div className="grid g2">
          <div className="card stat"><div className="label">Widget questions</div><div className="value">{stats ? stats.questions : '—'}</div><div className="hint">{stats ? stats.answered : 0} answered from public docs</div></div>
          <div className="card stat"><div className="label">Deflected</div><div className="value">{stats ? stats.deflected : '—'}</div><div className="hint">{stats ? stats.tickets_created : 0} handed off as tickets</div></div>
        </div>
        <Card title="How it works" icon={MessageSquare}>
          <ol className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
            <li>Customers ask before submitting a ticket. Only <b>public</b>, <b>trusted</b> documents are searched — internal runbooks and quarantined sources never reach customers.</li>
            <li>If confidence is low, the widget says it doesn't know instead of guessing.</li>
            <li>“Yes” counts as a deflection. “No” opens a real ticket in the helpdesk inbox, which is auto-triaged in the background.</li>
            <li>Prompt-injection and secret requests are refused by guardrails before any model call.</li>
          </ol>
        </Card>
        <Card title="Embed on any site" icon={Code}>
          <div className="small muted mb">One script tag adds a floating help button to your docs or website:</div>
          <pre className="json">{snippet}</pre>
          <div className="row mt"><a className="btn sm" href={`/widget-demo.html?key=${org.public_key}`} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Open demo page with the embedded widget</a></div>
        </Card>
      </div>
      <div className="widget-stage"><LiveWidget publicKey={org.public_key} onTicket={() => load()} /></div>
    </div>
  );
}
