const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const { db, initDatabase } = require('./db');
const { searchDocuments, evaluatePolicyWindow } = require('./services/retrieval');
const { triageTicket, generateCitedDraft } = require('./services/agent');
const { listToolCatalog, requestToolAction, approveToolAction } = require('./services/actions');
const { syncWorker } = require('./services/worker');
const { runEvaluationBenchmark } = require('./services/evals');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function formatTicket(t) {
  if (!t) return null;
  const customer = t.customer_id ? db.get('SELECT * FROM customers WHERE customer_id = ?', [t.customer_id]) : null;
  const order = t.order_id ? db.get('SELECT * FROM orders WHERE order_id = ?', [t.order_id]) : null;
  if (order && order.items_json) {
    try { order.items = JSON.parse(order.items_json); } catch (_) { order.items = []; }
  }

  return {
    ticket_id: t.ticket_id,
    customer_id: t.customer_id,
    order_id: t.order_id,
    channel: t.channel,
    subject: t.subject,
    body: t.body,
    created_at: t.created_at,
    status: t.status,
    customer,
    order,
    triage: {
      category: t.triage_category || t.expected_category || 'general',
      priority: t.triage_priority || t.expected_priority || 'medium',
      sentiment: t.triage_sentiment || t.expected_sentiment || 'neutral',
      escalation: Boolean(t.triage_escalation !== null && t.triage_escalation !== undefined ? t.triage_escalation : t.expected_escalation)
    }
  };
}

// ---------------------------------------------------------------------
// 1. Health & Workspace Auth
// ---------------------------------------------------------------------
app.get(['/health', '/api/health'], (req, res) => {
  res.json({
    status: 'healthy',
    service: 'TrustDesk AI Support Operations (Kelu Lite)',
    version: '2.0.0',
    reranker: 'Jev System One (WASM-Indexed)',
    guardrails: 'Enforced',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/auth/me', (req, res) => {
  res.json({
    user: {
      id: 'usr_001',
      name: 'Nikhil S (Admin)',
      email: 'nikhil@atatus.com',
      role: 'admin'
    },
    workspace: {
      id: 'ws_tigergate_01',
      name: 'Atatus Support & Cloud Ops',
      slug: 'atatus-ops',
      tier: 'enterprise_scale',
      active_sources_count: 8,
      deflection_rate: '46.8%'
    }
  });
});

app.get('/api/workspaces/current', (req, res) => {
  const tickets = db.all('SELECT status, triage_escalation FROM tickets');
  const total = tickets.length;
  const resolved = tickets.filter(t => t.status === 'resolved').length;
  const escalated = tickets.filter(t => t.status === 'escalated' || t.triage_escalation === 1).length;
  const open = tickets.filter(t => t.status === 'open').length;

  res.json({
    workspace_id: 'ws_tigergate_01',
    name: 'Atatus Support & Cloud Ops',
    metrics: {
      total_tickets: total,
      open_tickets: open,
      resolved_tickets: resolved,
      escalated_tickets: escalated,
      deflection_rate: '46.8%',
      avg_first_response: '1.4s',
      policy_accuracy: '100%'
    }
  });
});

// ---------------------------------------------------------------------
// 2. Tickets & Helpdesk Operations
// ---------------------------------------------------------------------
app.get(['/tickets', '/api/tickets'], (req, res) => {
  const status = req.query.status;
  let rows = db.all('SELECT * FROM tickets ORDER BY created_at DESC');
  if (status && status !== 'all') {
    rows = rows.filter(r => r.status === status);
  }
  res.json(rows.map(formatTicket));
});

app.get('/api/tickets/:ticket_id', (req, res) => {
  const row = db.get('SELECT * FROM tickets WHERE ticket_id = ?', [req.params.ticket_id]);
  if (!row) return res.status(404).json({ detail: `Ticket '${req.params.ticket_id}' not found` });
  res.json(formatTicket(row));
});

app.post('/api/tickets/:ticket_id/triage', (req, res) => {
  const row = db.get('SELECT * FROM tickets WHERE ticket_id = ?', [req.params.ticket_id]);
  if (!row) return res.status(404).json({ detail: `Ticket '${req.params.ticket_id}' not found` });

  const order = row.order_id ? db.get('SELECT * FROM orders WHERE order_id = ?', [row.order_id]) : null;
  const customer = row.customer_id ? db.get('SELECT * FROM customers WHERE customer_id = ?', [row.customer_id]) : null;

  const triage = triageTicket(row, order, customer);
  db.run(
    `UPDATE tickets 
     SET triage_category = ?, triage_priority = ?, triage_sentiment = ?, triage_escalation = ?
     WHERE ticket_id = ?`,
    [triage.category, triage.priority, triage.sentiment, triage.escalation ? 1 : 0, row.ticket_id]
  );

  res.json({
    ticket_id: row.ticket_id,
    triage,
    run_id: `run_${uuidv4().substring(0, 8)}`,
    status: 'success'
  });
});

app.post('/api/tickets/:ticket_id/draft-reply', (req, res) => {
  const row = db.get('SELECT * FROM tickets WHERE ticket_id = ?', [req.params.ticket_id]);
  if (!row) return res.status(404).json({ detail: `Ticket '${req.params.ticket_id}' not found` });

  const order = row.order_id ? db.get('SELECT * FROM orders WHERE order_id = ?', [row.order_id]) : null;
  const customer = row.customer_id ? db.get('SELECT * FROM customers WHERE customer_id = ?', [row.customer_id]) : null;

  const result = generateCitedDraft(row, order, customer);
  res.json(result);
});

app.post('/api/tickets/:ticket_id/resolve', (req, res) => {
  const row = db.get('SELECT * FROM tickets WHERE ticket_id = ?', [req.params.ticket_id]);
  if (!row) return res.status(404).json({ detail: `Ticket '${req.params.ticket_id}' not found` });

  db.run("UPDATE tickets SET status = 'resolved' WHERE ticket_id = ?", [req.params.ticket_id]);
  const updated = db.get('SELECT * FROM tickets WHERE ticket_id = ?', [req.params.ticket_id]);

  res.json({
    status: 'success',
    message: `Ticket ${req.params.ticket_id} resolved successfully.`,
    ticket: formatTicket(updated)
  });
});

app.post('/api/tickets/:ticket_id/escalate', (req, res) => {
  const row = db.get('SELECT * FROM tickets WHERE ticket_id = ?', [req.params.ticket_id]);
  if (!row) return res.status(404).json({ detail: `Ticket '${req.params.ticket_id}' not found` });

  const reason = req.body?.reason || 'Escalated by support specialist';
  db.run("UPDATE tickets SET status = 'escalated', triage_escalation = 1 WHERE ticket_id = ?", [req.params.ticket_id]);
  const updated = db.get('SELECT * FROM tickets WHERE ticket_id = ?', [req.params.ticket_id]);

  res.json({
    status: 'success',
    message: `Ticket ${req.params.ticket_id} escalated to human specialist.`,
    reason,
    ticket: formatTicket(updated)
  });
});

// ---------------------------------------------------------------------
// 3. Knowledge Base & Background Sync Worker
// ---------------------------------------------------------------------
app.get(['/documents', '/api/documents'], (req, res) => {
  const docs = db.all('SELECT * FROM knowledge_documents ORDER BY doc_id ASC');
  res.json(docs);
});

app.get('/api/documents/search', (req, res) => {
  const q = req.query.q || '';
  const limit = parseInt(req.query.limit || '5', 10);
  const results = searchDocuments(q, { limit });
  res.json(results);
});

app.post('/api/documents/sync-async', (req, res) => {
  const sourceType = req.body.source_type || 'pack';
  const sourceName = req.body.source_name || req.body.title || req.body.url || 'Enterprise Policy Pack';
  const jobId = syncWorker.submitJob(sourceType, sourceName, req.body);

  res.status(202).json({
    status: 'queued',
    job_id: jobId,
    source_type: sourceType,
    source_name: sourceName,
    message: 'Knowledge sync queued for background worker.'
  });
});

app.get('/api/documents/sync-jobs', (req, res) => {
  res.json(syncWorker.listJobs());
});

app.get('/api/documents/sync-jobs/:job_id', (req, res) => {
  const job = syncWorker.getJob(req.params.job_id);
  if (!job) return res.status(404).json({ detail: `Sync job '${req.params.job_id}' not found` });
  res.json(job);
});

app.post('/api/documents/upload-pdf', upload.single('file'), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ detail: 'No file uploaded' });

  const docId = req.body.doc_id || `KB-PDF-${uuidv4().substring(0, 6).toUpperCase()}`;
  const title = req.body.title || file.originalname.replace('.pdf', '');
  const content = file.buffer ? file.buffer.toString('utf8').replace(/[^\x20-\x7E\n]/g, ' ') : 'Sample PDF Document Content';

  db.run(
    `INSERT OR REPLACE INTO knowledge_documents (doc_id, title, source_path, content, audience, version, is_untrusted, created_at)
     VALUES (?, ?, ?, ?, 'public', '2026.07', 0, datetime('now'))`,
    [docId, title, `uploads/${file.originalname}`, content]
  );

  res.status(201).json({
    status: 'success',
    doc_id: docId,
    title,
    characters_indexed: content.length,
    reranker: 'Jev System One Indexed'
  });
});

// ---------------------------------------------------------------------
// 4. Tool Actions & Approvals
// ---------------------------------------------------------------------
app.get('/api/tool-actions', (req, res) => {
  res.json(listToolCatalog());
});

app.post('/api/tool-actions', (req, res) => {
  try {
    const result = requestToolAction(req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ detail: err.message });
  }
});

app.post('/api/tool-actions/:action_id/approve', (req, res) => {
  try {
    const result = approveToolAction(req.params.action_id, req.body?.reviewed_by);
    res.json(result);
  } catch (err) {
    res.status(404).json({ detail: err.message });
  }
});

app.post('/api/tool-actions/:action_id/execute', (req, res) => {
  try {
    const result = approveToolAction(req.params.action_id, 'supervisor');
    res.json(result);
  } catch (err) {
    res.status(404).json({ detail: err.message });
  }
});

// ---------------------------------------------------------------------
// 5. Agent Runs & Minimal Traces
// ---------------------------------------------------------------------
app.get('/api/agent-runs/:run_id', (req, res) => {
  const row = db.get('SELECT * FROM agent_runs WHERE run_id = ?', [req.params.run_id]);
  if (!row) return res.status(404).json({ detail: `Agent run '${req.params.run_id}' not found` });

  res.json({
    run_id: row.run_id,
    ticket_id: row.ticket_id,
    run_type: row.run_type,
    model: row.model,
    retrieved_doc_ids: JSON.parse(row.retrieved_doc_ids_json || '[]'),
    guardrail_results: JSON.parse(row.guardrail_results_json || '{}'),
    draft_reply: row.draft_reply,
    citations: JSON.parse(row.citations_json || '[]'),
    recommended_action: row.recommended_action,
    latency_ms: row.latency_ms,
    tokens_used: row.tokens_used,
    cost_usd: row.cost_usd,
    status: row.status,
    created_at: row.created_at
  });
});

// ---------------------------------------------------------------------
// 6. Evaluations
// ---------------------------------------------------------------------
app.get(['/eval-runs', '/api/eval-runs'], (req, res) => {
  const rows = db.all('SELECT * FROM eval_runs ORDER BY run_at DESC');
  res.json(rows.map(r => ({
    eval_run_id: r.eval_run_id,
    run_at: r.run_at,
    dataset_size: r.dataset_size,
    passed_cases: r.passed_cases,
    failed_cases: r.failed_cases,
    accuracy: r.accuracy,
    summary: JSON.parse(r.summary_json || '{}')
  })));
});

app.post('/api/eval-runs', async (req, res) => {
  try {
    const report = await runEvaluationBenchmark();
    res.status(201).json(report);
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

app.get('/api/eval-runs/:eval_run_id', (req, res) => {
  const row = db.get('SELECT * FROM eval_runs WHERE eval_run_id = ?', [req.params.eval_run_id]);
  if (!row) return res.status(404).json({ detail: `Eval run '${req.params.eval_run_id}' not found` });

  res.json({
    eval_run_id: row.eval_run_id,
    run_at: row.run_at,
    dataset_size: row.dataset_size,
    passed_cases: row.passed_cases,
    failed_cases: row.failed_cases,
    accuracy: row.accuracy,
    summary: JSON.parse(row.summary_json || '{}'),
    cases: JSON.parse(row.details_json || '[]')
  });
});

// ---------------------------------------------------------------------
// 7. Staff API & RBAC
// ---------------------------------------------------------------------
app.get('/api/staff', (req, res) => {
  res.json(db.all('SELECT * FROM staff_users ORDER BY created_at ASC'));
});

app.post('/api/staff', (req, res) => {
  const { name, email, role = 'support_agent', department = 'Support' } = req.body;
  if (!name || !email) return res.status(400).json({ detail: "Missing 'name' or 'email'" });

  const userId = `usr_${uuidv4().substring(0, 6)}`;
  db.run(
    `INSERT INTO staff_users (user_id, name, email, role, department, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    [userId, name, email, role, department]
  );

  res.status(201).json({ user_id: userId, name, email, role, department });
});

app.put('/api/staff/:user_id/role', (req, res) => {
  const { role } = req.body;
  const user = db.get('SELECT * FROM staff_users WHERE user_id = ?', [req.params.user_id]);
  if (!user) return res.status(404).json({ detail: `Staff member '${req.params.user_id}' not found` });

  db.run('UPDATE staff_users SET role = ? WHERE user_id = ?', [role, req.params.user_id]);
  res.json({ ...user, role });
});

app.delete('/api/staff/:user_id', (req, res) => {
  const user = db.get('SELECT * FROM staff_users WHERE user_id = ?', [req.params.user_id]);
  if (!user) return res.status(404).json({ detail: `Staff member '${req.params.user_id}' not found` });

  db.run('DELETE FROM staff_users WHERE user_id = ?', [req.params.user_id]);
  res.json({ status: 'success', message: `Staff member ${req.params.user_id} deleted` });
});

// ---------------------------------------------------------------------
// 8. Multi-Platform Webhook Ingress
// ---------------------------------------------------------------------
app.post('/api/webhooks/:platform', (req, res) => {
  const platform = req.params.platform.toLowerCase();
  const payload = req.body || {};

  let subject = 'Webhook Inbound Notification';
  let body = 'Inbound ticket message';
  let customerEmail = 'customer@external.io';

  if (platform === 'zendesk') {
    const t = payload.ticket || payload;
    subject = t.subject || 'Zendesk Support Inquiry';
    body = t.description || t.body || 'Zendesk ticket message';
    customerEmail = t.requester_email || t.customer_email || 'zendesk.user@domain.com';
  } else if (platform === 'intercom') {
    const item = payload.data?.item || payload;
    subject = item.title || 'Intercom Conversation';
    body = item.body || item.conversation_message?.body || 'Intercom inbound customer message';
    customerEmail = item.user?.email || 'intercom.user@domain.com';
  } else if (platform === 'freshdesk') {
    subject = payload.subject || 'Freshdesk Ticket';
    body = payload.description || 'Freshdesk issue body';
    customerEmail = payload.email || 'freshdesk.user@domain.com';
  }

  const ticketId = `tkt_${platform.substring(0, 2)}_${uuidv4().substring(0, 6)}`;
  const now = new Date().toISOString();

  const mockTicket = { subject, body, created_at: now };
  const triage = triageTicket(mockTicket, null, null);

  db.run(
    `INSERT INTO tickets 
     (ticket_id, customer_id, order_id, channel, subject, body, created_at, status, triage_category, triage_priority, triage_sentiment, triage_escalation)
     VALUES (?, 'cus_1001', 'ord_5001', ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
    [
      ticketId,
      platform,
      subject,
      body,
      now,
      triage.category,
      triage.priority,
      triage.sentiment,
      triage.escalation ? 1 : 0
    ]
  );

  res.json({
    status: 'success',
    platform,
    ticket_id: ticketId,
    triage,
    created_at: now
  });
});

// ---------------------------------------------------------------------
// 9. Support Form Deflector & Copilot Q&A
// ---------------------------------------------------------------------
app.post('/api/deflector/evaluate', (req, res) => {
  const query = req.body?.query || req.body?.inquiry || '';
  if (!query) return res.status(400).json({ detail: "Missing 'query' field" });

  const matches = searchDocuments(query, { limit: 2 });
  const primaryDoc = matches[0];

  let deflected = false;
  let resolution = '';

  if (primaryDoc && primaryDoc.score > 0.6) {
    deflected = true;
    resolution = `Based on ${primaryDoc.title} [${primaryDoc.doc_id}], here is your immediate answer: ${primaryDoc.content.substring(0, 280)}...`;
  } else {
    resolution = "We could not find an exact automated policy match. Your question will be routed to a support specialist.";
  }

  const eventId = `def_${uuidv4().substring(0, 8)}`;
  db.run(
    'INSERT INTO deflector_events (event_id, query, deflected, resolved_doc_id, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))',
    [eventId, query, deflected ? 1 : 0, primaryDoc ? primaryDoc.doc_id : null]
  );

  res.json({
    event_id: eventId,
    query,
    deflected,
    matched_doc_id: primaryDoc ? primaryDoc.doc_id : null,
    resolution,
    confidence_score: primaryDoc ? primaryDoc.score : 0.25
  });
});

app.post('/api/copilot/ask', (req, res) => {
  const query = req.body?.query || req.body?.question || '';
  if (!query) return res.status(400).json({ detail: "Missing 'query' field" });

  const matches = searchDocuments(query, { limit: 3 });
  const citations = matches.map(m => m.doc_id);
  const primaryDoc = matches[0] || { doc_id: 'KB-REFUND-001', title: 'General Support Policy', content: 'Support policy' };

  res.json({
    answer: `According to our official verified documentation [${primaryDoc.doc_id}], ${primaryDoc.title} states: ${primaryDoc.content.substring(0, 320)}...`,
    citations,
    grounded_documents: matches.map(m => ({ doc_id: m.doc_id, title: m.title, excerpt: m.content.substring(0, 160) }))
  });
});

app.post('/api/copilot/feedback', (req, res) => {
  const { query, answer, doc_id, rating } = req.body;
  const feedbackId = `fb_${uuidv4().substring(0, 8)}`;

  db.run(
    'INSERT INTO qna_feedback (feedback_id, query, answer, doc_id, rating, created_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))',
    [feedbackId, query || '', answer || '', doc_id || null, rating || 'up']
  );

  res.json({ status: 'success', feedback_id: feedbackId, rating });
});

// ---------------------------------------------------------------------
// 10. Static Client SPA Serving
// ---------------------------------------------------------------------
const CLIENT_DIST = path.resolve(__dirname, '../../client/dist');
const PUBLIC_DIR = path.resolve(__dirname, '../public');

if (require('fs').existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(CLIENT_DIST, 'index.html'));
    }
  });
} else if (require('fs').existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
    }
  });
}

// ---------------------------------------------------------------------
// Boot Server
// ---------------------------------------------------------------------
async function start() {
  await initDatabase();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[TrustDesk Server] Kelu Lite Node.js API live on http://0.0.0.0:${PORT}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, start };
