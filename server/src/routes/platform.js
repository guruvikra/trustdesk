// Assistant, evals, integrations, workspace and stats (authenticated).
const express = require('express');
const { db, parseJson } = require('../db');
const { wrap, httpError, requireRole } = require('../lib/http');
const assistant = require('../services/assistant');
const evals = require('../services/evals');
const connectors = require('../services/connectors');
const seed = require('../seed');
const llm = require('../llm');

const router = express.Router();

const accounts = require('../services/accounts');

router.get('/auth/me', (req, res) => res.json({ user: req.user, org: req.org }));
router.post('/auth/logout', (req, res) => {
  if (!accounts.DEMO_ACCOUNTS.some(a => a.token === req.token)) accounts.logout(req.token);
  res.json({ ok: true });
});

// --- Team (members of the current organisation) ----------------------------------
router.get('/team', (req, res) => res.json(accounts.listTeam(req.org.org_id)));
router.post('/team', requireRole('admin', 'support_manager'), (req, res) => res.status(201).json(accounts.invite(req.org.org_id, req.body || {})));
router.patch('/team/:id', requireRole('admin'), (req, res) => res.json(accounts.setRole(req.org.org_id, req.params.id, (req.body || {}).role, req.user)));
router.delete('/team/:id', requireRole('admin'), (req, res) => res.json(accounts.removeMember(req.org.org_id, req.params.id, req.user)));

// --- Internal assistant ---------------------------------------------------------
router.post('/assistant/ask', wrap(async (req, res) => {
  const question = String((req.body && req.body.question) || '').trim();
  if (!question) throw httpError(400, 'question is required');
  res.json(await assistant.ask({ question, ticketId: req.body.ticket_id || null, user: req.user }));
}));

router.post('/assistant/feedback', (req, res) => res.json(assistant.feedback(req.body.run_id, req.body.rating)));

router.get('/assistant/history', (req, res) => {
  res.json(db.all("SELECT * FROM agent_runs WHERE run_type = 'assistant' ORDER BY created_at DESC LIMIT 30").map(r => ({
    run_id: r.run_id, question: r.input_summary, output: parseJson(r.output_json, {}), feedback: r.feedback, created_by: r.created_by, created_at: r.created_at,
  })));
});

// --- Evals ---------------------------------------------------------------------
router.post('/eval-runs', (req, res) => {
  const provider = req.body && req.body.provider === 'mock' ? 'mock' : undefined;
  const id = evals.startEvalRun({ provider });
  res.status(202).json({ eval_run_id: id, status: 'running' });
});
router.get('/eval-runs', (req, res) => res.json(evals.listEvalRuns()));
router.get('/eval-runs/:id', (req, res) => {
  const r = evals.getEvalRun(req.params.id);
  if (!r) throw httpError(404, `Eval run ${req.params.id} not found`);
  res.json(r);
});

// --- Integrations --------------------------------------------------------------
router.get('/integrations', (req, res) => res.json(connectors.listIntegrations()));
router.put('/integrations/:platform', requireRole('support_manager', 'admin'), (req, res) => res.json(connectors.saveIntegration(req.params.platform, req.body || {})));
router.delete('/integrations/:platform', requireRole('support_manager', 'admin'), (req, res) => res.json(connectors.disableIntegration(req.params.platform)));
router.post('/integrations/:platform/test', wrap(async (req, res) => res.json(await connectors.testIntegration(req.params.platform))));
router.post('/integrations/:platform/sync', wrap(async (req, res) => res.json(await connectors.syncIntegration(req.params.platform))));
router.post('/integrations/:platform/oauth/start', requireRole('support_manager', 'admin'), (req, res) => {
  res.json(connectors.startOAuth(req.params.platform, { orgId: req.org.org_id, user: req.user }));
});

// --- Workspace & stats ------------------------------------------------------------
router.get('/workspace', (req, res) => res.json({
  ...seed.summary(), org: req.org, llm: llm.config(), webhook_secret_required: Boolean(process.env.WEBHOOK_SECRET),
  team_size: accounts.listTeam(req.org.org_id).length,
  integrations_connected: db.all('SELECT platform FROM integrations WHERE enabled = 1').map(r => r.platform),
}));
router.patch('/workspace', requireRole('admin'), (req, res) => res.json(accounts.renameOrg(req.org.org_id, (req.body || {}).name)));

router.post('/workspace/reset', requireRole('support_manager', 'admin'), (req, res) => {
  const mode = req.body && req.body.mode === 'empty' ? 'empty' : 'demo';
  res.json({ mode, ...seed.reset({ mode, keepDocuments: req.body && req.body.keep_documents !== false }) });
});

router.get('/stats', (req, res) => {
  const count = (sql, p = []) => db.get(sql, p).n;
  const latestEval = db.get("SELECT metrics_json, provider, finished_at FROM eval_runs WHERE status = 'completed' ORDER BY created_at DESC LIMIT 1");
  const deflections = db.all('SELECT answered, outcome FROM deflection_events');
  res.json({
    tickets: {
      total: count('SELECT COUNT(*) AS n FROM tickets'),
      open: count("SELECT COUNT(*) AS n FROM tickets WHERE status = 'open'"),
      escalated: count("SELECT COUNT(*) AS n FROM tickets WHERE status = 'escalated'"),
      resolved: count("SELECT COUNT(*) AS n FROM tickets WHERE status = 'resolved'"),
      untriaged: count('SELECT COUNT(*) AS n FROM tickets WHERE triage_json IS NULL'),
      by_channel: db.all('SELECT channel, COUNT(*) AS n FROM tickets GROUP BY channel'),
      by_category: db.all("SELECT json_extract(triage_json, '$.category') AS category, COUNT(*) AS n FROM tickets WHERE triage_json IS NOT NULL GROUP BY category"),
    },
    approvals_pending: count("SELECT COUNT(*) AS n FROM tool_actions WHERE status = 'pending_approval'"),
    actions_blocked: count("SELECT COUNT(*) AS n FROM tool_actions WHERE status = 'blocked'"),
    actions_executed: count("SELECT COUNT(*) AS n FROM tool_actions WHERE status = 'executed'"),
    documents: {
      total: count('SELECT COUNT(*) AS n FROM documents'),
      quarantined: count("SELECT COUNT(*) AS n FROM documents WHERE trust = 'quarantined'"),
      internal: count("SELECT COUNT(*) AS n FROM documents WHERE visibility = 'internal'"),
      chunks: count('SELECT COUNT(*) AS n FROM doc_chunks'),
    },
    assistant: {
      questions: count("SELECT COUNT(*) AS n FROM agent_runs WHERE run_type = 'assistant'"),
      unanswered: count("SELECT COUNT(*) AS n FROM agent_runs WHERE run_type IN ('assistant','widget') AND final_status != 'answered'"),
      thumbs_up: count("SELECT COUNT(*) AS n FROM agent_runs WHERE feedback = 'up'"),
      thumbs_down: count("SELECT COUNT(*) AS n FROM agent_runs WHERE feedback = 'down'"),
    },
    widget: {
      questions: deflections.length,
      answered: deflections.filter(d => d.answered).length,
      deflected: deflections.filter(d => d.outcome === 'deflected').length,
      tickets_created: deflections.filter(d => d.outcome === 'ticket_created').length,
    },
    guardrail_events: count("SELECT COUNT(*) AS n FROM agent_runs WHERE guardrail_json LIKE '%\"flags\":[\"%'"),
    latest_eval: latestEval ? { ...parseJson(latestEval.metrics_json, {}), provider: latestEval.provider, finished_at: latestEval.finished_at } : null,
    unanswered_questions: db.all("SELECT input_summary AS question, MAX(created_at) AS created_at, COUNT(*) AS times FROM agent_runs WHERE run_type IN ('assistant','widget') AND final_status = 'no_answer' GROUP BY lower(input_summary) ORDER BY created_at DESC LIMIT 8"),
    llm: llm.config(),
  });
});

// --- Helpdesk Autopilot ------------------------------------------------------------------
const automation = require('../services/automation');
router.get('/automation/settings', (req, res) => res.json(automation.getSettings()));
router.put('/automation/settings', requireRole('support_manager', 'admin'), (req, res) => res.json(automation.saveSettings(req.body || {}, req.user)));
router.get('/automation/events', (req, res) => res.json({ events: automation.listEvents({ limit: req.query.limit }), summary: automation.summary() }));

// --- Analytics for the dashboard ----------------------------------------------------
router.get('/analytics', (req, res) => {
  const days = Math.min(90, Math.max(7, Number(req.query.days) || 14));
  const since = new Date(Date.now() - (days - 1) * 86400000);
  since.setHours(0, 0, 0, 0);
  const sinceIso = since.toISOString();
  const day = iso => new Date(iso).toLocaleDateString('en-CA');
  const series = [];
  for (let i = 0; i < days; i++) series.push(new Date(since.getTime() + i * 86400000).toLocaleDateString('en-CA'));

  const qs = db.all(`SELECT run_id, run_type, input_summary, final_status, output_json, feedback, created_by, created_at
                     FROM agent_runs WHERE run_type IN ('assistant','widget') AND created_at >= ? ORDER BY created_at DESC`, [sinceIso]);
  const perDay = Object.fromEntries(series.map(d => [d, { date: d, assistant: 0, widget: 0, unanswered: 0 }]));
  for (const q of qs) {
    const b = perDay[day(q.created_at)];
    if (!b) continue;
    b[q.run_type] += 1;
    if (q.final_status !== 'answered') b.unanswered += 1;
  }
  const groups = new Map();
  for (const q of qs) {
    const key = String(q.input_summary || '').trim().toLowerCase().replace(/[?.!\s]+$/, '');
    if (!key) continue;
    const g = groups.get(key) || { question: q.input_summary, count: 0, answered: 0, last_asked: q.created_at, sources: new Set() };
    g.count += 1;
    if (q.final_status === 'answered') g.answered += 1;
    g.sources.add(q.run_type);
    groups.set(key, g);
  }
  const grouped = [...groups.values()].map(g => ({ ...g, sources: [...g.sources] }));
  const tickets = db.all('SELECT created_at, channel, triage_json, status FROM tickets');
  const ticketsPerDay = Object.fromEntries(series.map(d => [d, 0]));
  for (const t of tickets) { const d = day(t.created_at); if (d in ticketsPerDay) ticketsPerDay[d] += 1; }
  const drafts = db.get(`SELECT COUNT(*) AS total, SUM(status = 'sent') AS sent, SUM(status = 'sent' AND body != original_body) AS edited,
                         SUM(status = 'rejected') AS rejected FROM drafts`);
  const deflect = db.get(`SELECT COUNT(*) AS asked, SUM(answered) AS answered, SUM(outcome = 'deflected') AS deflected,
                          SUM(outcome = 'ticket_created') AS tickets FROM deflection_events WHERE created_at >= ?`, [sinceIso]);
  const answeredCount = qs.filter(q => q.final_status === 'answered').length;
  res.json({
    days,
    totals: {
      questions: qs.length,
      answered: answeredCount,
      answer_rate: qs.length ? +(answeredCount / qs.length).toFixed(3) : null,
      refused: qs.filter(q => q.final_status === 'refused').length,
      thumbs_up: qs.filter(q => q.feedback === 'up').length,
      thumbs_down: qs.filter(q => q.feedback === 'down').length,
      tickets: tickets.length,
      tickets_open: tickets.filter(t => t.status === 'open').length,
    },
    questions_per_day: series.map(d => perDay[d]),
    tickets_per_day: series.map(d => ({ date: d, tickets: ticketsPerDay[d] })),
    top_questions: grouped.sort((a, b) => b.count - a.count || b.last_asked.localeCompare(a.last_asked)).slice(0, 8),
    unanswered_questions: grouped.filter(g => g.answered < g.count).sort((a, b) => b.count - a.count).slice(0, 8),
    recent_questions: qs.slice(0, 50).map(q => {
      const out = parseJson(q.output_json, {});
      return { run_id: q.run_id, question: q.input_summary, source: q.run_type, status: q.final_status, confidence: out.confidence ?? null, feedback: q.feedback, asked_by: q.created_by, created_at: q.created_at };
    }),
    deflection: { asked: deflect.asked || 0, answered: deflect.answered || 0, deflected: deflect.deflected || 0, tickets: deflect.tickets || 0 },
    drafts: { total: drafts.total || 0, sent: drafts.sent || 0, edited: drafts.edited || 0, rejected: drafts.rejected || 0 },
    autopilot: automation.summary(),
    categories: db.all("SELECT json_extract(triage_json, '$.category') AS category, COUNT(*) AS n FROM tickets WHERE triage_json IS NOT NULL GROUP BY category ORDER BY n DESC"),
    channels: db.all('SELECT channel, COUNT(*) AS n FROM tickets GROUP BY channel ORDER BY n DESC'),
  });
});

module.exports = router;
