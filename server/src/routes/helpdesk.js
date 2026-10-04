// Helpdesk: tickets, triage, drafts, tool actions, traces.
const express = require('express');
const { db, parseJson } = require('../db');
const { wrap, httpError, requireRole } = require('../lib/http');
const tickets = require('../services/tickets');
const agent = require('../services/agent');
const actions = require('../services/actions');
const connectors = require('../services/connectors');
const { checkOutput } = require('../services/guardrails');

const router = express.Router();

function contextOr404(id) {
  const ctx = agent.loadContext(id);
  if (!ctx) throw httpError(404, `Ticket ${id} not found`);
  return ctx;
}

router.get('/tickets', (req, res) => res.json(tickets.listTickets({ status: req.query.status, q: req.query.q })));

router.post('/tickets', wrap(async (req, res) => {
  const { ticket } = tickets.createTicket({ ...req.body, channel: req.body.channel || 'manual' });
  res.status(201).json(ticket);
}));

router.get('/tickets/:id', (req, res) => {
  const t = tickets.getTicket(req.params.id);
  if (!t) throw httpError(404, `Ticket ${req.params.id} not found`);
  res.json({ ...t, external_links: connectors.externalLinks(t.ticket_id) });
});

// Escalate a ticket to engineering as a Linear issue (created once per ticket).
router.post('/tickets/:id/linear-issue', wrap(async (req, res) => {
  const t = tickets.getTicket(req.params.id);
  if (!t) throw httpError(404, `Ticket ${req.params.id} not found`);
  const issue = await connectors.createLinearIssue(t, req.user);
  if (!issue.replayed) actions.addNote(t.ticket_id, req.user.email, `Linear issue ${issue.identifier} created: ${issue.url}`);
  res.status(issue.replayed ? 200 : 201).json(issue);
}));

router.post('/tickets/:id/triage', wrap(async (req, res) => {
  const out = await agent.triage(contextOr404(req.params.id), { user: req.user });
  res.json({ ticket_id: req.params.id, run_id: out.run_id, triage: out.triage, provider: out.trace.provider, fallback_reason: out.trace.guardrails.fallback_reason });
}));

router.post('/tickets/:id/draft-reply', wrap(async (req, res) => {
  const ctx = contextOr404(req.params.id);
  const out = await agent.draft(ctx, { user: req.user });
  const { trace, ...rest } = out;
  res.json(rest);
}));

router.post('/tickets/:id/status', (req, res) => {
  const { status, note } = req.body || {};
  if (!['open', 'escalated', 'resolved'].includes(status)) throw httpError(400, 'status must be open, escalated or resolved');
  contextOr404(req.params.id);
  tickets.setStatus(req.params.id, status, req.user, note);
  res.json(tickets.getTicket(req.params.id));
});

router.post('/tickets/:id/notes', (req, res) => {
  contextOr404(req.params.id);
  if (!req.body || !req.body.body) throw httpError(400, 'body is required');
  tickets.addMessage(req.params.id, { author_type: 'agent', author: req.user.email, body: req.body.body, internal: true });
  res.status(201).json(tickets.getTicket(req.params.id));
});

// --- Drafts -------------------------------------------------------------------

function getDraft(id) {
  const d = db.get('SELECT * FROM drafts WHERE draft_id = ?', [id]);
  if (!d) throw httpError(404, `Draft ${id} not found`);
  return d;
}

router.patch('/drafts/:id', (req, res) => {
  const d = getDraft(req.params.id);
  if (d.status !== 'draft') throw httpError(409, `Draft is ${d.status}`);
  const run = db.get('SELECT retrieved_doc_ids_json FROM agent_runs WHERE run_id = ?', [d.run_id]);
  const checked = checkOutput(String(req.body.body || ''), { allowedDocIds: parseJson(run && run.retrieved_doc_ids_json, []) });
  db.run('UPDATE drafts SET body = ?, citations_json = ?, updated_at = ? WHERE draft_id = ?', [checked.reply, JSON.stringify(checked.citations), new Date().toISOString(), d.draft_id]);
  res.json({ draft_id: d.draft_id, body: checked.reply, citations: checked.citations, issues: checked.issues });
});

router.post('/drafts/:id/send', wrap(async (req, res) => {
  const d = getDraft(req.params.id);
  if (d.status === 'sent') return res.json({ draft_id: d.draft_id, status: 'sent', replayed: true });
  if (d.status !== 'draft') throw httpError(409, `Draft is ${d.status}`);
  const ticket = db.get('SELECT * FROM tickets WHERE ticket_id = ?', [d.ticket_id]);
  const resolve = req.body.resolve !== false;
  let external = null;
  if (connectors.HELPDESKS.includes(ticket.channel) && ticket.source_ref) {
    external = await connectors.pushReply(ticket, d.body, { resolve });
  }
  db.run("UPDATE drafts SET status = 'sent', reviewed_by = ?, updated_at = ? WHERE draft_id = ?", [req.user.email, new Date().toISOString(), d.draft_id]);
  tickets.addMessage(d.ticket_id, { author_type: 'agent', author: req.user.email, body: d.body, internal: false });
  if (external) actions.addNote(d.ticket_id, req.user.email, external);
  if (resolve) tickets.setStatus(d.ticket_id, 'resolved', req.user, 'reply sent');
  res.json({ draft_id: d.draft_id, status: 'sent', external, ticket: tickets.getTicket(d.ticket_id) });
}));

router.post('/drafts/:id/reject', (req, res) => {
  const d = getDraft(req.params.id);
  db.run("UPDATE drafts SET status = 'rejected', reviewed_by = ?, updated_at = ? WHERE draft_id = ?", [req.user.email, new Date().toISOString(), d.draft_id]);
  actions.addNote(d.ticket_id, req.user.email, `Draft rejected${req.body && req.body.reason ? `: ${req.body.reason}` : ''}.`);
  res.json({ draft_id: d.draft_id, status: 'rejected' });
});

// --- Tool actions -----------------------------------------------------------------

router.get('/tools', (req, res) => res.json(actions.catalog()));

router.get('/tool-actions', (req, res) => res.json(actions.list({ status: req.query.status, ticket_id: req.query.ticket_id })));

router.get('/tool-actions/:id', (req, res) => {
  const a = actions.get(req.params.id);
  if (!a) throw httpError(404, `Action ${req.params.id} not found`);
  res.json(a);
});

// Agent-initiated proposal. Client supplies the idempotency key (header or body).
router.post('/tool-actions', (req, res) => {
  const b = req.body || {};
  const key = req.get('Idempotency-Key') || b.idempotency_key;
  let category;
  let flags = [];
  if (b.ticket_id) {
    const t = db.get('SELECT triage_json FROM tickets WHERE ticket_id = ?', [b.ticket_id]);
    if (!t) throw httpError(404, `Ticket ${b.ticket_id} not found`);
    const tri = parseJson(t.triage_json, null);
    category = tri && tri.category;
    flags = (tri && tri.flags) || [];
  }
  const out = actions.propose({ ticket_id: b.ticket_id, tool_name: b.tool_name, parameters: b.parameters || {}, idempotency_key: key, proposed_by: req.user.email, category, flags });
  res.status(out.replayed ? 200 : 201).json(out);
});

router.post('/tool-actions/:id/approve', requireRole('support_manager', 'admin'), (req, res) => {
  res.json(actions.decide(req.params.id, { decision: 'approve', user: req.user, note: req.body && req.body.note }));
});

router.post('/tool-actions/:id/reject', requireRole('support_manager', 'admin'), (req, res) => {
  res.json(actions.decide(req.params.id, { decision: 'reject', user: req.user, note: req.body && req.body.note }));
});

router.post('/tool-actions/:id/execute', (req, res) => {
  res.json(actions.execute(req.params.id, { user: req.user }));
});

// --- Traces -----------------------------------------------------------------------

router.get('/agent-runs', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.ticket_id) { where.push('ticket_id = ?'); params.push(req.query.ticket_id); }
  if (req.query.run_type) { where.push('run_type = ?'); params.push(req.query.run_type); }
  const limit = Math.min(200, Number(req.query.limit) || 50);
  res.json(db.all(`SELECT * FROM agent_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ${limit}`, params).map(agent.formatRun));
});

router.get('/agent-runs/:id', (req, res) => {
  const r = agent.formatRun(db.get('SELECT * FROM agent_runs WHERE run_id = ?', [req.params.id]));
  if (!r) throw httpError(404, `Run ${req.params.id} not found`);
  res.json(r);
});

router.post('/agent-runs/:id/feedback', (req, res) => {
  const { rating } = req.body || {};
  if (!['up', 'down'].includes(rating)) throw httpError(400, 'rating must be up or down');
  db.run('UPDATE agent_runs SET feedback = ? WHERE run_id = ?', [rating, req.params.id]);
  res.json({ run_id: req.params.id, feedback: rating });
});

module.exports = router;
