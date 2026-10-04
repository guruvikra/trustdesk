import React, { useCallback, useEffect, useState } from 'react';
import {
  Wand2, Sparkles, Send, ShieldAlert, ExternalLink, Bot, CheckCircle2, XCircle, Play, ArrowUpRight, User, Package, Scale, Activity, Gavel, RotateCcw, Copy, Plus,
} from 'lucide-react';
import { api } from '../api';
import { Badge, Button, Card, CitedText, Empty, Modal, Spinner, fmtTime, useToast } from '../components/ui';
import { TraceView } from '../components/Trace';
import { go } from '../App';

export function DocModal({ docId, onClose }) {
  const [doc, setDoc] = useState(null);
  useEffect(() => { api(`/api/documents/${docId}`).then(setDoc).catch(() => setDoc(false)); }, [docId]);
  return (
    <Modal title={docId} onClose={onClose}>
      {doc === null ? <Spinner /> : !doc ? <div className="muted">Document not found.</div> : (
        <div className="stack">
          <div className="row wrap"><span className="bold">{doc.title}</span><Badge>{doc.visibility}</Badge><Badge>{doc.trust}</Badge><span className="small muted">v{doc.version} · {doc.audience}</span></div>
          {doc.chunks.map(c => (
            <div key={c.chunk_id} className="source"><div className="small bold">{c.heading} <span className="faint mono tiny">{c.chunk_id}</span></div><div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{c.content}</div></div>
          ))}
        </div>
      )}
    </Modal>
  );
}

const Fact = ({ ok, children }) => <span className={ok ? 'fact-ok' : 'fact-no'}>{ok ? '✓' : '✗'} {children}</span>;

function PolicyFacts({ facts }) {
  if (!facts) return null;
  const { return_policy: rp, warranty: w, shipping: sh, customer } = facts;
  return (
    <Card title="Policy facts" icon={Scale}>
      <div className="tiny muted mb">Computed from the ticket's created_at ({fmtTime(facts.evaluated_at)}), not today's date.</div>
      <div className="kv">
        <span className="k">Customer</span><span>{customer.tier} · {customer.verified ? <span className="fact-ok">verified</span> : <span className="fact-no">not verified</span>}</span>
        {rp && <><span className="k">Return window</span><span><Fact ok={rp.within_window}>{rp.days_since_delivery} days since delivery (limit {rp.window_days})</Fact></span></>}
        {rp && rp.final_sale_items && <><span className="k">Final sale</span><span className="fact-no">Contains final-sale / software item</span></>}
        {w && <><span className="k">Warranty</span><span><Fact ok={w.within_warranty}>{w.months_since_delivery} mo of {w.coverage_months} mo{w.gold_extension_months ? ' (gold +6)' : ''}</Fact></span></>}
        {sh && <><span className="k">Tracking</span><span>{sh.stale_business_days_reported !== null ? <Fact ok={sh.carrier_investigation_eligible}>{sh.stale_business_days_reported} business days stale (≥{sh.stale_threshold_business_days} → investigation)</Fact> : 'In transit'}</span></>}
        {!facts.order && <><span className="k">Order</span><span className="muted">No linked order</span></>}
      </div>
    </Card>
  );
}

function ActionCard({ a, user, onDone }) {
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const isManager = ['support_manager', 'admin'].includes(user.role);
  const call = async (what, path, body) => {
    setBusy(what);
    try {
      const out = await api(path, { method: 'POST', body });
      if (out.replayed) toast(`Idempotent replay: returned existing ${out.action.action_id} (${out.action.status}) — nothing duplicated`);
      else toast(`${a.tool_name}: ${out.action.status.replace('_', ' ')}`);
      onDone();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(''); }
  };
  const resubmit = () => call('replay', '/api/tool-actions', { ticket_id: a.ticket_id, tool_name: a.tool_name, parameters: a.parameters, idempotency_key: a.idempotency_key });
  return (
    <div className={`action-card ${a.status === 'pending_approval' ? 'pending' : a.status}`}>
      <div className="row wrap">
        <span className="mono bold">{a.tool_name}</span><Badge>{a.status}</Badge>
        {a.requires_approval && <Badge tone="violet">needs approval</Badge>}
        <span className="spacer" /><span className="tiny faint">by {a.proposed_by}</span>
      </div>
      {a.block_reason && <div className="small mt" style={{ color: 'var(--red)' }}><ShieldAlert size={13} style={{ verticalAlign: -2 }} /> {a.block_reason}</div>}
      {a.status !== 'blocked' && <div className="tiny muted mt mono">{Object.entries(a.parameters).map(([k, v]) => `${k}=${v}`).join(' · ')}</div>}
      <div className="tiny faint mono" style={{ marginTop: 4 }}>idempotency_key: {a.idempotency_key}</div>
      {a.decided_by && <div className="tiny muted" style={{ marginTop: 4 }}>{a.status === 'rejected' ? 'Rejected' : 'Approved'} by {a.decided_by} · {fmtTime(a.decided_at)}{a.decision_note ? ` — ${a.decision_note}` : ''}</div>}
      {a.execution_result && <div className="callout green mt small"><CheckCircle2 size={14} /> {a.execution_result.summary}</div>}
      <div className="row wrap mt">
        {a.status === 'pending_approval' && (isManager ? <>
          <Button size="sm" variant="success" icon={CheckCircle2} busy={busy === 'approve'} onClick={() => call('approve', `/api/tool-actions/${a.action_id}/approve`, { note: 'Approved after review' })}>Approve</Button>
          <Button size="sm" variant="danger" icon={XCircle} busy={busy === 'reject'} onClick={() => call('reject', `/api/tool-actions/${a.action_id}/reject`, { note: 'Not supported' })}>Reject</Button>
        </> : <span className="small muted"><Gavel size={13} style={{ verticalAlign: -2 }} /> Waiting for a support manager. Switch user to approve.</span>)}
        {a.status === 'pending_approval' && <Button size="sm" icon={Play} busy={busy === 'exec'} onClick={() => call('exec', `/api/tool-actions/${a.action_id}/execute`)} title="Shows that execution is refused until a manager approves">Check approval gate</Button>}
        {a.status === 'approved' && <Button size="sm" variant="primary" icon={Play} busy={busy === 'exec'} onClick={() => call('exec', `/api/tool-actions/${a.action_id}/execute`)}>Execute</Button>}
        {a.status === 'executed' && <Button size="sm" icon={Play} busy={busy === 'exec'} onClick={() => call('exec', `/api/tool-actions/${a.action_id}/execute`)}>Execute again</Button>}
        {a.status !== 'blocked' && <Button size="sm" icon={Copy} busy={busy === 'replay'} onClick={resubmit} title="Re-submit the same request with the same idempotency key">Retry same key</Button>}
      </div>
    </div>
  );
}

function ProposeAction({ ticket, onDone }) {
  const toast = useToast();
  const [tools, setTools] = useState([]);
  const [tool, setTool] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('/api/tools').then(setTools); }, []);
  const def = tools.find(t => t.tool_name === tool);
  const submit = async () => {
    const o = ticket.order;
    const item = o && o.items.find(i => !i.final_sale) || (o && o.items[0]);
    const auto = { order_id: o && o.order_id, sku: item && item.sku, tracking_number: o && o.tracking_number, customer_id: ticket.customer && ticket.customer.customer_id, ticket_id: ticket.ticket_id, reason: 'Proposed by agent', queue: 'tier2_support', amount: amount || (tool === 'issue_coupon' ? undefined : o && o.total) };
    const parameters = Object.fromEntries(def.required_fields.filter(f => f !== 'idempotency_key').map(f => [f, auto[f]]));
    setBusy(true);
    try {
      const out = await api('/api/tool-actions', { method: 'POST', body: { ticket_id: ticket.ticket_id, tool_name: tool, parameters, idempotency_key: `agent:${ticket.ticket_id}:${tool}:${Date.now()}` } });
      toast(out.action.status === 'blocked' ? out.action.block_reason : `${tool} → ${out.action.status.replace('_', ' ')}`, out.action.status === 'blocked' ? 'error' : 'ok');
      onDone();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="row wrap mt">
      <select className="select" style={{ width: 260 }} value={tool} onChange={e => setTool(e.target.value)}>
        <option value="">Propose an action manually…</option>
        {tools.map(t => {
          const needsOrder = t.required_fields.some(f => ['order_id', 'sku', 'tracking_number'].includes(f)) && !ticket.order;
          const needsCustomer = t.required_fields.includes('customer_id') && !ticket.customer;
          return <option key={t.tool_name} value={t.tool_name} disabled={needsOrder || needsCustomer}>{t.tool_name}{t.requires_human_approval ? ' (approval)' : ''}{needsOrder ? ' — needs linked order' : needsCustomer ? ' — needs customer' : ''}</option>;
        })}
      </select>
      {def && def.required_fields.includes('amount') && <input className="input" style={{ width: 130 }} placeholder={tool === 'issue_coupon' ? 'INR (max 1000)' : 'amount'} value={amount} onChange={e => setAmount(e.target.value)} />}
      <Button size="sm" icon={Plus} disabled={!tool} busy={busy} onClick={submit}>Propose</Button>
    </div>
  );
}

export default function TicketDetail({ ticketId, user, onChange }) {
  const toast = useToast();
  const [t, setT] = useState(null);
  const [busy, setBusy] = useState('');
  const [gen, setGen] = useState(null);
  const [body, setBody] = useState('');
  const [doc, setDoc] = useState(null);
  const [traceId, setTraceId] = useState(null);
  const [linear, setLinear] = useState(false);
  const [connected, setConnected] = useState([]);
  useEffect(() => { api('/api/integrations').then(list => { const on = list.filter(i => i.enabled).map(i => i.platform); setConnected(on); setLinear(on.includes('linear')); }).catch(() => {}); }, []);

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/tickets/${ticketId}`);
      setT(data);
      setBody(b => (data.draft && data.draft.status === 'draft' ? (b && b !== data.draft.original_body ? b : data.draft.body) : ''));
      setTraceId(id => id || (data.runs[0] && data.runs[0].run_id));
    } catch (e) { setT(false); }
  }, [ticketId]);
  useEffect(() => { load(); }, [load]);
  // New tickets are processed by Autopilot in the background: refresh until that has happened.
  useEffect(() => {
    if (!t || t.autopilot || t.triage || t.status !== 'open') return undefined;
    let n = 0;
    const timer = setInterval(() => { n += 1; if (n > 10) clearInterval(timer); else load(); }, 2500);
    return () => clearInterval(timer);
  }, [t && t.ticket_id, t && Boolean(t.autopilot || t.triage)]);

  const run = async (what, fn) => {
    setBusy(what);
    try { await fn(); await load(); onChange && onChange(); } catch (e) { toast(e.message, 'error'); } finally { setBusy(''); }
  };

  const triage = () => run('triage', async () => {
    const out = await api(`/api/tickets/${ticketId}/triage`, { method: 'POST' });
    setTraceId(out.run_id);
    toast(`Triaged: ${out.triage.category} · ${out.triage.priority}${out.triage.should_escalate ? ' · escalate' : ''}${out.fallback_reason ? ' (model fallback)' : ''}`);
  });
  const draft = () => run('draft', async () => {
    const out = await api(`/api/tickets/${ticketId}/draft-reply`, { method: 'POST' });
    setGen(out);
    setBody(out.reply);
    setTraceId(out.run_id);
    toast(`Draft ready (${out.final_status.replace(/_/g, ' ')})`);
  });
  const saveDraft = () => run('save', async () => {
    const out = await api(`/api/drafts/${t.draft.draft_id}`, { method: 'PATCH', body: { body } });
    if (out.issues.length) toast(out.issues.map(i => i.detail).join(' '), 'error'); else toast('Draft saved');
  });
  const send = () => run('send', async () => {
    if (body !== t.draft.body) await api(`/api/drafts/${t.draft.draft_id}`, { method: 'PATCH', body: { body } });
    const out = await api(`/api/drafts/${t.draft.draft_id}/send`, { method: 'POST', body: { resolve: true } });
    toast(out.external ? out.external : 'Reply sent and ticket resolved');
  });
  const setStatus = status => run(status, async () => { await api(`/api/tickets/${ticketId}/status`, { method: 'POST', body: { status } }); toast(`Ticket ${status}`); });

  if (t === null) return <div className="card card-b"><Spinner /></div>;
  if (!t) return <div className="card"><Empty title="Ticket not found" /></div>;

  const tri = t.triage;
  const flags = (tri && tri.flags) || [];
  const activeActions = t.actions.filter(a => a.status !== 'blocked');
  const blocked = t.actions.filter(a => a.status === 'blocked');

  return (
    <div className="stack">
      <div className="card card-b">
        <div className="row wrap">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="row wrap small muted"><span className="mono">{t.ticket_id}</span>·<span>{t.channel}</span>·<span>{fmtTime(t.created_at)}</span>{t.source_ref && <><span>·</span><span>external #{t.source_ref}</span></>}</div>
            <div className="bold" style={{ fontSize: 17, marginTop: 3 }}>{t.subject}</div>
          </div>
          <Badge>{t.status}</Badge>
        </div>
        <div className="row wrap mt">
          <Button icon={Wand2} busy={busy === 'triage'} onClick={triage}>{tri ? 'Re-run triage' : 'Run AI triage'}</Button>
          <Button icon={Sparkles} variant="primary" busy={busy === 'draft'} onClick={draft}>Generate cited draft</Button>
          <Button icon={Bot} busy={busy === 'autopilot'} disabled={t.status === 'resolved'} title="Run the workspace Autopilot (triage → draft → auto-reply if safe and confident)" onClick={() => run('autopilot', async () => {
            const r = await api(`/api/tickets/${ticketId}/autopilot`, { method: 'POST' });
            setTraceId(r.event.run_id);
            toast(r.event.outcome === 'auto_replied' ? 'Autopilot answered and resolved this ticket' : r.event.outcome === 'triaged' ? 'Autopilot triaged this ticket' : `Autopilot left a draft: ${r.event.reasons[0] || 'review required'}`);
          })}>Run Autopilot</Button>
          <span className="spacer" />
          {(t.external_links || []).map(l => <a key={l.platform} className="btn" href={l.url} target="_blank" rel="noreferrer"><ExternalLink size={14} /> {l.external_id}</a>)}
          {linear && !(t.external_links || []).some(l => l.platform === 'linear') && <Button busy={busy === 'linear'} onClick={() => run('linear', async () => { const r = await api(`/api/tickets/${ticketId}/linear-issue`, { method: 'POST' }); toast(`Linear issue ${r.identifier} created`); })}>Create Linear issue</Button>}
          {t.status !== 'escalated' && <Button icon={ArrowUpRight} busy={busy === 'escalated'} onClick={() => setStatus('escalated')}>Mark escalated</Button>}
          {t.status !== 'resolved' ? <Button icon={CheckCircle2} busy={busy === 'resolved'} onClick={() => setStatus('resolved')}>Resolve</Button>
            : <Button icon={RotateCcw} busy={busy === 'open'} onClick={() => setStatus('open')}>Reopen</Button>}
        </div>
      </div>

      {t.autopilot && (() => {
        const a = t.autopilot;
        const tone = a.outcome === 'auto_replied' ? 'green' : a.outcome === 'escalated' ? 'amber' : a.outcome === 'drafted' ? 'blue' : 'plain';
        const head = { auto_replied: 'Autopilot answered this ticket automatically', drafted: 'Autopilot prepared a draft for review', escalated: 'Autopilot routed this ticket to specialists', triaged: 'Autopilot triaged this ticket', failed: 'Autopilot failed' }[a.outcome] || a.outcome;
        return (
          <div className={`autopilot-banner ${tone}`}>
            <Bot size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ flex: 1 }}>
              <b>{head}</b>{a.confidence !== null && a.confidence !== undefined && <span> · confidence {Math.round(a.confidence * 100)}%{a.mode === 'auto' ? ` (threshold ${Math.round(a.threshold * 100)}%)` : ''}</span>}
              {a.reasons && a.reasons.length > 0 && <div className="small" style={{ marginTop: 2 }}>Held because: {a.reasons.join(' · ')}</div>}
              {a.detail && !(a.reasons && a.reasons.length) && <div className="small" style={{ marginTop: 2 }}>{a.detail}</div>}
            </div>
            <span className="tiny" style={{ opacity: .8 }}>{a.mode} mode · {fmtTime(a.created_at)}</span>
          </div>
        );
      })()}

      <div className="detail-grid">
        <div className="stack">
          <Card title="Conversation">
            <div className="stack">
              {t.messages.map(m => (
                <div key={m.message_id} className={`msg ${m.internal ? 'internal' : m.author_type === 'agent' ? 'agent' : ''}`}>
                  <div className="meta"><span className="bold">{m.internal ? 'Internal note' : m.author_type === 'customer' ? (t.customer ? t.customer.name : m.author) : m.author === 'TrustDesk Autopilot' ? 'TrustDesk Autopilot (sent automatically)' : `Agent · ${m.author}`}</span><span>{fmtTime(m.created_at)}</span>{m.internal && <span>· {m.author}</span>}</div>
                  <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{m.body}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card title="AI triage" icon={Wand2} actions={t.triage_run_id && <Button size="sm" variant="ghost" icon={Activity} onClick={() => setTraceId(t.triage_run_id)}>Trace</Button>}>
            {!tri ? <div className="muted small">Not triaged yet. {t.channel !== 'email' && t.channel !== 'chat' ? 'Auto-triage runs in the background for new tickets.' : ''}</div> : (
              <div className="stack">
                <div className="row wrap">
                  <span className="small muted">Category</span><Badge tone="indigo">{tri.category}</Badge>
                  <span className="small muted">Priority</span><Badge>{tri.priority}</Badge>
                  <span className="small muted">Sentiment</span><Badge tone="">{tri.sentiment}</Badge>
                  <span className="small muted">Escalate</span><Badge tone={tri.should_escalate ? 'amber' : 'green'}>{tri.should_escalate ? 'yes' : 'no'}</Badge>
                </div>
                {flags.length > 0 && <div className="callout red"><ShieldAlert size={16} /><div><b>Guardrails triggered:</b> {flags.join(', ')}. Customer text is treated as untrusted data; only escalation is allowed.</div></div>}
                {tri.rationale && <div className="small muted">{tri.rationale}</div>}
              </div>
            )}
          </Card>

          <Card title="Draft reply" icon={Sparkles} actions={t.draft && <div className="row">{t.draft.confidence !== null && t.draft.confidence !== undefined && <Badge tone={t.draft.confidence >= 0.8 ? 'green' : t.draft.confidence >= 0.5 ? 'blue' : 'amber'}>{`confidence ${Math.round(t.draft.confidence * 100)}%`}</Badge>}<Badge>{t.draft.status}</Badge></div>}>
            {!t.draft ? <div className="muted small">Generate a draft. It will cite policy documents by ID, and a human reviews it before anything is sent.</div> : (
              <div className="stack">
                {gen && gen.guardrails.output_issues.length > 0 && <div className="callout amber small"><ShieldAlert size={14} /> Output guardrails: {gen.guardrails.output_issues.map(i => i.detail).join(' ')}</div>}
                {gen && gen.internal_note && <div className="callout blue small"><b>Note for agent:</b>&nbsp;{gen.internal_note}</div>}
                {gen && gen.fallback_reason && <div className="callout amber small">Hosted model unavailable ({gen.fallback_reason}); used the offline policy engine.</div>}
                {t.draft.status === 'draft' ? (
                  <>
                    <textarea className="textarea" rows={9} value={body} onChange={e => setBody(e.target.value)} />
                    <div className="small muted">Preview with citations:</div>
                    <div className="msg agent"><CitedText text={body} onCite={setDoc} /></div>
                    <div className="row wrap">
                      <Button icon={Send} variant="primary" busy={busy === 'send'} onClick={send}>{connected.includes(t.channel) && t.source_ref ? `Send to ${t.channel[0].toUpperCase() + t.channel.slice(1)} & resolve` : 'Save reply & resolve'}</Button>
                      <Button busy={busy === 'save'} onClick={saveDraft} disabled={body === t.draft.body}>Save edits</Button>
                      <Button variant="danger" busy={busy === 'reject'} onClick={() => run('reject', async () => { await api(`/api/drafts/${t.draft.draft_id}/reject`, { method: 'POST', body: {} }); toast('Draft rejected'); })}>Reject</Button>
                      <span className="spacer" />
                      <Button size="sm" variant="ghost" icon={Activity} onClick={() => setTraceId(t.draft.run_id)}>Trace</Button>
                    </div>
                  </>
                ) : <div className="msg agent"><CitedText text={t.draft.body} onCite={setDoc} /><div className="tiny muted mt">{t.draft.status} by {t.draft.reviewed_by}</div></div>}
                <div className="row wrap"><span className="small muted">Citations:</span>{t.draft.citations.map(c => <button key={c} className="cite" onClick={() => setDoc(c)}>{c}</button>)}</div>
              </div>
            )}
          </Card>

          <Card title="Actions" icon={Gavel}>
            {activeActions.length === 0 && blocked.length === 0 && <div className="muted small">No actions yet. The AI proposes actions when you generate a draft; it can never execute sensitive ones.</div>}
            <div className="stack">
              {activeActions.map(a => <ActionCard key={a.action_id} a={a} user={user} onDone={() => { load(); onChange && onChange(); }} />)}
              {blocked.length > 0 && <div className="small bold" style={{ color: 'var(--red)' }}>Blocked by policy ({blocked.length})</div>}
              {blocked.map(a => <ActionCard key={a.action_id} a={a} user={user} onDone={load} />)}
            </div>
            <ProposeAction ticket={t} onDone={load} />
          </Card>

          <Card title="Trace" icon={Activity} actions={
            <select className="select" style={{ width: 260, padding: '4px 8px' }} value={traceId || ''} onChange={e => setTraceId(e.target.value)}>
              {t.runs.map(r => <option key={r.run_id} value={r.run_id}>{r.run_type} · {r.final_status} · {fmtTime(r.created_at)}</option>)}
            </select>}>
            {traceId ? <TraceView runId={traceId} /> : <div className="muted small">Run triage or generate a draft to see the trace.</div>}
          </Card>
        </div>

        <div className="stack">
          <Card title="Customer" icon={User}>
            {t.customer ? (
              <div className="kv">
                <span className="k">Name</span><span className="bold">{t.customer.name}</span>
                <span className="k">Email</span><span>{t.customer.email}</span>
                <span className="k">Tier</span><span><Badge tone={t.customer.tier === 'gold' ? 'amber' : ''}>{t.customer.tier}</Badge></span>
                <span className="k">Verified</span><span>{t.customer.verified ? <span className="fact-ok">Yes</span> : <span className="fact-no">No</span>}</span>
                <span className="k">Customer ID</span><span className="mono">{t.customer.customer_id}</span>
              </div>
            ) : t.unverified_match ? (
              <div className="stack" style={{ gap: 6 }}>
                <div className="small"><b>{t.requester_email}</b></div>
                <div className="callout amber small">Email not verified: submitted through a public form. It matches customer <b>{t.unverified_match.name}</b> ({t.unverified_match.customer_id}), but account and order data are withheld from the AI until you verify the requester.</div>
              </div>
            ) : <div className="muted small">{t.requester_email || 'Unknown requester'} — no customer record.</div>}
          </Card>
          <Card title="Order" icon={Package}>
            {t.order ? (
              <div className="kv">
                <span className="k">Order</span><span className="mono">{t.order.order_id}</span>
                <span className="k">Status</span><span>{t.order.status}</span>
                <span className="k">Placed</span><span>{t.order.placed_at}</span>
                <span className="k">Delivered</span><span>{t.order.delivered_at || '—'}</span>
                <span className="k">Total</span><span>{t.order.currency} {t.order.total}</span>
                <span className="k">Payment</span><span>{t.order.payment_status}</span>
                <span className="k">Tracking</span><span className="mono">{t.order.tracking_number || '—'}</span>
                <span className="k">Items</span><span>{t.order.items.map(i => <div key={i.sku}>{i.name} <span className="faint tiny">({i.category}{i.final_sale ? ', final sale' : ''})</span></div>)}</span>
              </div>
            ) : <div className="muted small">No linked order.</div>}
          </Card>
          <PolicyFacts facts={t.policy_facts} />
          {t.runs.length > 0 && <Button variant="ghost" size="sm" icon={Activity} onClick={() => go('traces')}>All traces</Button>}
        </div>
      </div>
      {doc && <DocModal docId={doc} onClose={() => setDoc(null)} />}
    </div>
  );
}
