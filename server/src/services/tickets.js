// Ticket creation and read models. Every channel (web form, widget hand-off, webhooks,
// Zendesk/Freshdesk sync, manual) goes through createTicket so they share one pipeline.

const { v4: uuidv4 } = require('uuid');
const { db, parseJson } = require('../db');
const agent = require('./agent');
const actions = require('./actions');
const { computeFacts } = require('./policy');

function findOrCreateCustomer({ email, name }) {
  if (!email) return null;
  const existing = db.get('SELECT * FROM customers WHERE lower(email) = lower(?)', [email]);
  if (existing) return existing;
  const id = `cus_${uuidv4().slice(0, 8)}`;
  db.run('INSERT INTO customers (customer_id, name, email, tier, country, verified, tags_json, created_at) VALUES (?,?,?,?,?,0,?,?)',
    [id, name || email.split('@')[0], email, 'standard', null, JSON.stringify(['auto_created']), new Date().toISOString()]);
  return db.get('SELECT * FROM customers WHERE customer_id = ?', [id]);
}

/**
 * @param {object} t channel, subject, body, requester_email, requester_name, order_id, source_ref, ticket_id, created_at
 * @param {{autoTriage?: boolean}} opts auto-triage runs in the background so the caller is never blocked.
 */
function createTicket(t, { autoTriage = true } = {}) {
  if (!t.subject && !t.body) throw Object.assign(new Error('subject or body is required'), { status: 400 });
  const ticketId = t.ticket_id || `tkt_${uuidv4().replace(/-/g, '').slice(0, 8)}`;
  const existing = db.get('SELECT ticket_id FROM tickets WHERE ticket_id = ?', [ticketId]);
  if (existing) return { ticket: getTicket(ticketId), created: false };

  const customer = findOrCreateCustomer({ email: t.requester_email, name: t.requester_name });
  let orderId = t.order_id || (String(`${t.subject} ${t.body}`).match(/\bord_[a-z0-9]+\b/i) || [])[0] || null;
  if (orderId) {
    const order = db.get('SELECT customer_id FROM orders WHERE order_id = ?', [orderId]);
    // Only link orders that belong to this requester, so no other customer's data leaks into context.
    if (!order || (customer && order.customer_id !== customer.customer_id)) orderId = null;
  }
  const now = t.created_at || new Date().toISOString();
  db.run(`INSERT INTO tickets (ticket_id, customer_id, order_id, channel, subject, body, created_at, status, requester_email, source_ref, updated_at)
          VALUES (?,?,?,?,?,?,?, 'open', ?, ?, ?)`,
  [ticketId, customer && customer.customer_id, orderId, t.channel || 'manual', String(t.subject || '(no subject)').slice(0, 300),
    String(t.body || '').slice(0, 20000), now, t.requester_email || null, t.source_ref || null, now]);
  db.run('INSERT INTO ticket_messages (message_id, ticket_id, author_type, author, body, internal, created_at) VALUES (?,?,?,?,?,0,?)',
    [`msg_${uuidv4().slice(0, 10)}`, ticketId, 'customer', t.requester_email || 'customer', String(t.body || ''), now]);

  if (autoTriage) {
    setImmediate(async () => {
      try { await agent.triage(agent.loadContext(ticketId), { user: { email: 'auto-triage' } }); } catch (e) { console.error('[auto-triage]', e.message); }
    });
  }
  return { ticket: getTicket(ticketId), created: true };
}

function summary(row) {
  const triage = parseJson(row.triage_json, null);
  return {
    ticket_id: row.ticket_id, subject: row.subject, channel: row.channel, status: row.status, created_at: row.created_at,
    customer_name: row.customer_name || row.requester_email || 'Unknown', customer_id: row.customer_id, order_id: row.order_id,
    triage, pending_approvals: row.pending_approvals || 0, updated_at: row.updated_at,
  };
}

function listTickets({ status, q } = {}) {
  const rows = db.all(`SELECT t.*, c.name AS customer_name,
      (SELECT COUNT(*) FROM tool_actions a WHERE a.ticket_id = t.ticket_id AND a.status = 'pending_approval') AS pending_approvals
    FROM tickets t LEFT JOIN customers c ON c.customer_id = t.customer_id ORDER BY t.created_at DESC`);
  return rows.map(summary).filter(t => {
    if (status === 'needs_approval') return t.pending_approvals > 0;
    if (status === 'escalation') return t.status === 'open' && t.triage && t.triage.should_escalate;
    if (status && status !== 'all' && t.status !== status) return false;
    if (q && !`${t.subject} ${t.customer_name} ${t.ticket_id}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
}

function getTicket(ticketId) {
  const row = db.get('SELECT * FROM tickets WHERE ticket_id = ?', [ticketId]);
  if (!row) return null;
  const customer = row.customer_id ? db.get('SELECT * FROM customers WHERE customer_id = ?', [row.customer_id]) : null;
  const orderRow = row.order_id ? db.get('SELECT * FROM orders WHERE order_id = ?', [row.order_id]) : null;
  const order = orderRow ? { ...orderRow, items: parseJson(orderRow.items_json, []), items_json: undefined } : null;
  const count = customer ? db.get('SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND replacement_for IS NULL', [customer.customer_id]).n : null;
  const draft = db.get("SELECT * FROM drafts WHERE ticket_id = ? AND status != 'superseded' ORDER BY created_at DESC LIMIT 1", [ticketId]);
  return {
    ticket_id: row.ticket_id, channel: row.channel, subject: row.subject, body: row.body, created_at: row.created_at,
    status: row.status, assignee: row.assignee, requester_email: row.requester_email, source_ref: row.source_ref,
    customer: customer ? { ...customer, verified: Boolean(customer.verified), tags: parseJson(customer.tags_json, []), tags_json: undefined } : null,
    order,
    policy_facts: computeFacts(row, order, customer, { customerOrderCount: count }),
    triage: parseJson(row.triage_json, null), triage_run_id: row.triage_run_id,
    draft: draft ? { draft_id: draft.draft_id, run_id: draft.run_id, body: draft.body, original_body: draft.original_body, citations: parseJson(draft.citations_json, []), status: draft.status, reviewed_by: draft.reviewed_by, updated_at: draft.updated_at } : null,
    actions: actions.list({ ticket_id: ticketId }),
    messages: db.all('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC', [ticketId]).map(m => ({ ...m, internal: Boolean(m.internal) })),
    runs: db.all('SELECT run_id, run_type, provider, final_status, latency_ms, created_at FROM agent_runs WHERE ticket_id = ? ORDER BY created_at DESC', [ticketId]),
  };
}

function setStatus(ticketId, status, user, note) {
  db.run('UPDATE tickets SET status = ?, updated_at = ? WHERE ticket_id = ?', [status, new Date().toISOString(), ticketId]);
  actions.addNote(ticketId, user.email, `Ticket marked ${status}${note ? `: ${note}` : ''}.`);
}

function addMessage(ticketId, { author_type, author, body, internal }) {
  db.run('INSERT INTO ticket_messages (message_id, ticket_id, author_type, author, body, internal, created_at) VALUES (?,?,?,?,?,?,?)',
    [`msg_${uuidv4().slice(0, 10)}`, ticketId, author_type, author, body, internal ? 1 : 0, new Date().toISOString()]);
}

module.exports = { createTicket, listTickets, getTicket, setStatus, addMessage, findOrCreateCustomer };
