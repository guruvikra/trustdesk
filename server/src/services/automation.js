// Helpdesk Autopilot: what happens automatically when a ticket arrives (webhook, import,
// support form, widget hand-off, manual). The workspace chooses a mode and a confidence threshold:
//   triage  — classify and prioritise only
//   draft   — triage + cited draft + action proposals, waiting for an agent
//   auto    — as draft, and send the reply automatically when it is safe and confident enough
// Auto-send is refused (the draft waits for a person) whenever any safety rule applies.

const { v4: uuidv4 } = require('uuid');
const { db, parseJson } = require('../db');
const agent = require('./agent');
const actions = require('./actions');

const DEFAULTS = { mode: 'draft', threshold: 0.8, auto_escalate: true };
const MODES = ['triage', 'draft', 'auto'];
const UNSAFE = ['prompt_injection', 'secret_exfiltration', 'identity_bypass'];

function getSettings() {
  const row = db.get("SELECT value_json, updated_by, updated_at FROM workspace_settings WHERE key = 'automation'");
  return { ...DEFAULTS, ...parseJson(row && row.value_json, {}), updated_by: row && row.updated_by, updated_at: row && row.updated_at };
}

function saveSettings(input, user) {
  const cur = getSettings();
  const next = {
    mode: MODES.includes(input.mode) ? input.mode : cur.mode,
    threshold: input.threshold !== undefined ? Number(input.threshold) : cur.threshold,
    auto_escalate: input.auto_escalate !== undefined ? Boolean(input.auto_escalate) : cur.auto_escalate,
  };
  if (!(next.threshold >= 0.5 && next.threshold <= 1)) throw Object.assign(new Error('threshold must be between 0.5 and 1'), { status: 400 });
  db.run(`INSERT INTO workspace_settings (key, value_json, updated_by, updated_at) VALUES ('automation', ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  [JSON.stringify(next), user.email, new Date().toISOString()]);
  return getSettings();
}

// Reasons a draft must wait for a human instead of being sent automatically.
function blockers(draft, threshold) {
  const reasons = [];
  const flags = draft.guardrails.flags || [];
  if (flags.some(f => UNSAFE.includes(f))) reasons.push(`Guardrails flagged ${flags.filter(f => UNSAFE.includes(f)).join(', ')}`);
  if (flags.includes('safety_hazard')) reasons.push('Product safety issue');
  if (draft.triage.should_escalate) reasons.push('Triage recommends a specialist');
  if (!draft.policy_covered) reasons.push(`No ${draft.triage.category} policy in the knowledge base`);
  if (!draft.citations.length) reasons.push('Reply has no policy citation');
  if (draft.guardrails.output_issues.length) reasons.push('Output guardrails changed the reply');
  const acts = draft.recommended_actions.filter(a => a.tool_name !== 'escalate_to_human').map(a => a.tool_name);
  if (acts.length) reasons.push(`Proposed action needs a person: ${acts.join(', ')}`);
  if (draft.confidence < threshold) reasons.push(`Confidence ${Math.round(draft.confidence * 100)}% is below the ${Math.round(threshold * 100)}% threshold`);
  return reasons;
}

function record(ev) {
  const row = { event_id: `aut_${uuidv4().slice(0, 10)}`, created_at: new Date().toISOString(), ...ev };
  db.run(`INSERT INTO automation_events (event_id, ticket_id, trigger, mode, outcome, confidence, threshold, reasons_json, run_id, detail, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  [row.event_id, row.ticket_id, row.trigger, row.mode, row.outcome, row.confidence ?? null, row.threshold ?? null, JSON.stringify(row.reasons || []), row.run_id || null, row.detail || null, row.created_at]);
  return format(db.get('SELECT * FROM automation_events WHERE event_id = ?', [row.event_id]));
}

function format(r) {
  return r && { ...r, reasons: parseJson(r.reasons_json, []), reasons_json: undefined };
}

const AUTOPILOT = { email: 'autopilot@trustdesk', role: 'support_agent' };

/**
 * Runs the workspace's automation for one ticket. Safe to call more than once:
 * actions use idempotency keys and an already-sent draft is never re-sent.
 */
async function run(ticketId, { trigger = 'new_ticket', settings = getSettings() } = {}) {
  const tickets = require('./tickets');
  const connectors = require('./connectors');
  const ctx = agent.loadContext(ticketId);
  if (!ctx) throw Object.assign(new Error(`Ticket ${ticketId} not found`), { status: 404 });
  const base = { ticket_id: ticketId, trigger, mode: settings.mode, threshold: settings.threshold };

  const tri = await agent.triage(ctx, { user: AUTOPILOT });
  if (settings.mode === 'triage') {
    return record({ ...base, outcome: 'triaged', run_id: tri.run_id, detail: `${tri.triage.category} · ${tri.triage.priority}${tri.triage.should_escalate ? ' · escalation suggested' : ''}` });
  }

  const draft = await agent.draft(agent.loadContext(ticketId), { user: AUTOPILOT, triageResult: tri.triage });
  const reasons = blockers(draft, settings.threshold);
  let escalated = false;
  if (settings.auto_escalate && draft.triage.should_escalate) {
    const esc = draft.proposed_actions.find(a => a.tool_name === 'escalate_to_human' && a.status === 'approved');
    if (esc) { actions.execute(esc.action_id, { user: AUTOPILOT }); escalated = true; }
  }

  if (settings.mode === 'auto' && reasons.length === 0) {
    let external = null;
    try {
      const t = db.get('SELECT * FROM tickets WHERE ticket_id = ?', [ticketId]);
      external = await connectors.pushReply(t, draft.reply, { resolve: true });
    } catch (e) {
      // Could not post to the helpdesk: keep the draft for a person rather than pretending it was sent.
      return record({ ...base, outcome: 'drafted', confidence: draft.confidence, run_id: draft.run_id, reasons: [`Could not post to helpdesk: ${e.message}`] });
    }
    db.run("UPDATE drafts SET status = 'sent', reviewed_by = ?, updated_at = ? WHERE draft_id = ?", [AUTOPILOT.email, new Date().toISOString(), draft.draft.draft_id]);
    tickets.addMessage(ticketId, { author_type: 'agent', author: 'TrustDesk Autopilot', body: draft.reply, internal: false });
    tickets.setStatus(ticketId, 'resolved', AUTOPILOT, `answered automatically (confidence ${Math.round(draft.confidence * 100)}%)${external ? ` — ${external}` : ''}`);
    return record({ ...base, outcome: 'auto_replied', confidence: draft.confidence, run_id: draft.run_id, detail: external || 'Reply sent and ticket resolved' });
  }

  const note = settings.mode === 'auto'
    ? `Autopilot held the reply for review: ${reasons.join('; ')}.`
    : `AI draft ready for review (confidence ${Math.round(draft.confidence * 100)}%).`;
  actions.addNote(ticketId, AUTOPILOT.email, note);
  return record({ ...base, outcome: escalated ? 'escalated' : 'drafted', confidence: draft.confidence, run_id: draft.run_id, reasons, detail: escalated ? 'Routed to specialists; draft waiting for review' : null });
}

// Fire-and-forget hook for newly created tickets; never blocks the request that created them.
function onTicketCreated(ticketId, trigger) {
  setImmediate(async () => {
    try { await run(ticketId, { trigger }); } catch (e) {
      console.error('[autopilot]', ticketId, e.message);
      try { record({ ticket_id: ticketId, trigger, mode: getSettings().mode, outcome: 'failed', detail: e.message }); } catch (_) { /* ignore */ }
    }
  });
}

function listEvents({ limit = 50, ticket_id } = {}) {
  const rows = ticket_id
    ? db.all('SELECT * FROM automation_events WHERE ticket_id = ? ORDER BY created_at DESC', [ticket_id])
    : db.all(`SELECT e.*, t.subject, t.channel FROM automation_events e LEFT JOIN tickets t ON t.ticket_id = e.ticket_id ORDER BY e.created_at DESC LIMIT ${Number(limit) || 50}`);
  return rows.map(format);
}

function summary() {
  const rows = db.all('SELECT outcome, COUNT(*) AS n FROM automation_events GROUP BY outcome');
  return Object.fromEntries(rows.map(r => [r.outcome, r.n]));
}

module.exports = { getSettings, saveSettings, run, onTicketCreated, listEvents, summary, blockers, MODES };
