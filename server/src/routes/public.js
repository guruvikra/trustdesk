// Unauthenticated surfaces: login, customer widget/deflector, inbound webhooks.
const express = require('express');
const { db } = require('../db');
const { wrap, httpError, publicWorkspace } = require('../lib/http');
const accounts = require('../services/accounts');
const seed = require('../seed');
const { openTenant, withTenant } = require('../db');
const assistant = require('../services/assistant');
const tickets = require('../services/tickets');
const connectors = require('../services/connectors');

const router = express.Router();

router.post('/auth/login', (req, res) => res.json(accounts.login(req.body || {})));

// Sign-up creates an organisation with its own empty workspace (tool catalog only).
router.post('/auth/signup', wrap(async (req, res) => {
  const out = accounts.signup(req.body || {});
  const tdb = await openTenant(out.org.org_id);
  withTenant(out.org.org_id, tdb, () => seed.reset({ mode: 'empty', keepDocuments: false }));
  res.status(201).json(out);
}));

router.get('/auth/demo-accounts', (req, res) => {
  res.json(accounts.DEMO_ACCOUNTS.map(a => ({ name: a.name, email: a.email, role: a.role })));
});

// --- Customer widget / support-form deflector --------------------------------------
router.post('/public/ask', publicWorkspace, wrap(async (req, res) => {
  const question = String((req.body && req.body.question) || '').trim();
  if (!question) throw httpError(400, 'question is required');
  if (question.length > 2000) throw httpError(400, 'question is too long');
  res.json(await assistant.deflect(question));
}));

// The customer says whether the answer solved it; if not, a real ticket is created.
router.post('/public/deflections/:id/outcome', publicWorkspace, (req, res) => {
  const ev = db.get('SELECT * FROM deflection_events WHERE event_id = ?', [req.params.id]);
  if (!ev) throw httpError(404, 'Unknown deflection event');
  const b = req.body || {};
  if (b.resolved) {
    db.run("UPDATE deflection_events SET outcome = 'deflected' WHERE event_id = ?", [ev.event_id]);
    return res.json({ outcome: 'deflected' });
  }
  if (!b.email) throw httpError(400, 'email is required to open a ticket');
  const { ticket } = tickets.createTicket({
    channel: 'web_widget', subject: b.subject || ev.question.slice(0, 80), body: b.details ? `${ev.question}\n\n${b.details}` : ev.question,
    requester_email: b.email, requester_name: b.name, order_id: b.order_id,
  });
  db.run("UPDATE deflection_events SET outcome = 'ticket_created', ticket_id = ? WHERE event_id = ?", [ticket.ticket_id, ev.event_id]);
  res.status(201).json({ outcome: 'ticket_created', ticket_id: ticket.ticket_id });
});

// --- Inbound helpdesk webhooks ----------------------------------------------------------
router.post('/webhooks/:platform', publicWorkspace, (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.get('X-TrustDesk-Secret') !== secret && req.query.secret !== secret) throw httpError(401, 'Invalid webhook secret');
  const platform = req.params.platform.toLowerCase();
  if (!['zendesk', 'freshdesk', 'intercom', 'front', 'generic'].includes(platform)) throw httpError(404, `Unsupported platform ${platform}`);
  const normalized = connectors.normalizeWebhook(platform, req.body || {});
  const { ticket, created } = tickets.createTicket(normalized);
  res.status(created ? 201 : 200).json({ received: true, created, ticket_id: ticket.ticket_id, platform });
});

// --- OAuth callback (the app redirects the browser here after the user approves) -----------
router.get('/oauth/:platform/callback', async (req, res) => {
  const { platform } = req.params;
  const back = (q) => res.redirect(`/#/integrations/${q}`);
  try {
    if (req.query.error) return back(`oauth_error=${encodeURIComponent(req.query.error_description || req.query.error)}`);
    const state = connectors.consumeState(String(req.query.state || ''), platform);
    const tdb = await openTenant(state.orgId);
    await withTenant(state.orgId, tdb, () => connectors.finishOAuth(platform, String(req.query.code || '')));
    back(`connected=${platform}`);
  } catch (e) {
    back(`oauth_error=${encodeURIComponent(e.message)}`);
  }
});

module.exports = router;
