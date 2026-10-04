// Tool actions: proposal -> (human approval) -> execution, with idempotency keys.
// The model never executes anything; it can only cause a proposal that a person must approve.

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db, parseJson } = require('../db');
const { checkAction } = require('./guardrails');

class ActionError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

function catalog() {
  return db.all('SELECT * FROM tool_catalog ORDER BY tool_name').map(t => ({
    tool_name: t.tool_name, description: t.description, risk_level: t.risk_level,
    requires_human_approval: Boolean(t.requires_human_approval),
    allowed_categories: parseJson(t.allowed_categories_json, []),
    required_fields: parseJson(t.required_fields_json, []),
    config: parseJson(t.config_json, {}),
  }));
}

function getTool(name) { return catalog().find(t => t.tool_name === name) || null; }

function format(row) {
  if (!row) return null;
  return {
    action_id: row.action_id, ticket_id: row.ticket_id, tool_name: row.tool_name,
    parameters: parseJson(row.parameters_json, {}), idempotency_key: row.idempotency_key, status: row.status,
    requires_approval: Boolean(row.requires_approval), proposed_by: row.proposed_by, source_run_id: row.source_run_id,
    block_reason: row.block_reason, decided_by: row.decided_by, decided_at: row.decided_at, decision_note: row.decision_note,
    executed_at: row.executed_at, execution_result: parseJson(row.execution_result_json, null), created_at: row.created_at,
  };
}

function hashPayload(ticketId, toolName, params) {
  const stable = JSON.stringify({ ticketId, toolName, params: Object.keys(params).sort().reduce((o, k) => ((o[k] = params[k]), o), {}) });
  return crypto.createHash('sha256').update(stable).digest('hex');
}

function list({ status, ticket_id } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (ticket_id) { where.push('ticket_id = ?'); params.push(ticket_id); }
  return db.all(`SELECT * FROM tool_actions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`, params).map(format);
}

function get(actionId) { return format(db.get('SELECT * FROM tool_actions WHERE action_id = ?', [actionId])); }

/**
 * Creates a proposal. Same idempotency key + same payload returns the original record (replay);
 * same key with a different payload is rejected with 409.
 */
function propose({ ticket_id, tool_name, parameters = {}, idempotency_key, proposed_by, source_run_id = null, category, flags = [], block_reason = null }) {
  if (!idempotency_key) throw new ActionError(400, 'idempotency_key is required');
  const tool = getTool(tool_name);
  if (!tool) throw new ActionError(400, `Unknown tool "${tool_name}"`);

  const payloadHash = hashPayload(ticket_id, tool_name, parameters);
  const existing = db.get('SELECT * FROM tool_actions WHERE idempotency_key = ?', [idempotency_key]);
  if (existing) {
    if (existing.payload_hash !== payloadHash) {
      throw new ActionError(409, 'Idempotency key already used with a different payload', { action: format(existing) });
    }
    return { action: format(existing), replayed: true };
  }

  const missing = tool.required_fields.filter(f => f !== 'idempotency_key' && (parameters[f] === undefined || parameters[f] === null || parameters[f] === ''));
  const policy = checkAction(tool, { category, flags, parameters });
  let status = tool.requires_human_approval ? 'pending_approval' : 'approved';
  let blockReason = null;
  if (block_reason) { status = 'blocked'; blockReason = block_reason; }
  else if (!policy.allowed) { status = 'blocked'; blockReason = policy.reason; }
  else if (missing.length) {
    status = 'blocked';
    blockReason = missing.includes('order_id') ? `Needs a linked order (missing: ${missing.join(', ')}).` : `Missing required fields: ${missing.join(', ')}`;
  }

  const row = {
    action_id: `act_${uuidv4().replace(/-/g, '').slice(0, 10)}`,
    created_at: new Date().toISOString(),
  };
  db.run(`INSERT INTO tool_actions (action_id, ticket_id, tool_name, parameters_json, idempotency_key, payload_hash, status,
          requires_approval, proposed_by, source_run_id, block_reason, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  [row.action_id, ticket_id, tool_name, JSON.stringify(parameters), idempotency_key, payloadHash, status,
    tool.requires_human_approval ? 1 : 0, proposed_by, source_run_id, blockReason, row.created_at]);
  if (ticket_id) {
    addNote(ticket_id, proposed_by, status === 'blocked'
      ? `Action ${tool_name} blocked: ${blockReason}`
      : `Action ${tool_name} proposed${tool.requires_human_approval ? ' — waiting for manager approval' : ''}.`);
  }
  return { action: get(row.action_id), replayed: false };
}

function decide(actionId, { decision, user, note }) {
  const action = get(actionId);
  if (!action) throw new ActionError(404, `Action ${actionId} not found`);
  if (!['support_manager', 'admin'].includes(user.role)) throw new ActionError(403, 'Only a support manager or admin can approve or reject actions');
  if (action.status !== 'pending_approval') {
    if ((decision === 'approve' && ['approved', 'executed'].includes(action.status)) || (decision === 'reject' && action.status === 'rejected')) {
      return { action, replayed: true };
    }
    throw new ActionError(409, `Action is ${action.status}; only pending actions can be ${decision}d`);
  }
  const status = decision === 'approve' ? 'approved' : 'rejected';
  db.run('UPDATE tool_actions SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE action_id = ?',
    [status, user.email, new Date().toISOString(), note || null, actionId]);
  if (action.ticket_id) addNote(action.ticket_id, user.email, `${action.tool_name} ${status}${note ? `: ${note}` : ''}.`);
  return { action: get(actionId), replayed: false };
}

// Executes an approved action exactly once. Repeated calls return the stored result.
function execute(actionId, { user }) {
  const action = get(actionId);
  if (!action) throw new ActionError(404, `Action ${actionId} not found`);
  if (action.status === 'executed') return { action, replayed: true };
  if (action.status !== 'approved') {
    throw new ActionError(409, action.status === 'pending_approval'
      ? 'This action requires human approval before it can be executed'
      : `Action is ${action.status} and cannot be executed`);
  }
  const result = db.transaction(() => {
    const r = runTool(action, user);
    db.run("UPDATE tool_actions SET status = 'executed', executed_at = ?, execution_result_json = ? WHERE action_id = ? AND status = 'approved'",
      [new Date().toISOString(), JSON.stringify(r), actionId]);
    return r;
  });
  if (action.ticket_id) addNote(action.ticket_id, user.email, `${action.tool_name} executed: ${result.summary}`);
  return { action: get(actionId), replayed: false };
}

function runTool(action, user) {
  const p = action.parameters;
  const ref = uuidv4().slice(0, 8).toUpperCase();
  switch (action.tool_name) {
    case 'create_replacement_order': {
      const original = db.get('SELECT * FROM orders WHERE order_id = ?', [p.order_id]);
      if (!original) throw new ActionError(400, `Order ${p.order_id} not found`);
      const items = parseJson(original.items_json, []).filter(i => !p.sku || i.sku === p.sku);
      const newId = `ord_r${ref.toLowerCase()}`;
      db.run(`INSERT INTO orders (order_id, customer_id, status, placed_at, total, currency, payment_status, items_json, replacement_for, created_by_action)
              VALUES (?,?,?,?,?,?,?,?,?,?)`, [newId, original.customer_id, 'processing', new Date().toISOString().slice(0, 10), 0,
        original.currency, 'not_charged', JSON.stringify(items), original.order_id, action.action_id]);
      return { replacement_order_id: newId, summary: `Replacement order ${newId} created for ${p.order_id}` };
    }
    case 'start_refund_review':
      return { refund_review_id: `rr_${ref}`, amount: p.amount, status: 'pending_payments_review', summary: `Refund review rr_${ref} opened (no money moved yet)` };
    case 'open_carrier_investigation':
      return { investigation_id: `ci_${ref}`, tracking_number: p.tracking_number, summary: `Carrier investigation ci_${ref} opened` };
    case 'issue_coupon':
      return { coupon_code: `GW-${ref}`, amount: p.amount, summary: `Coupon GW-${ref} for INR ${p.amount}` };
    case 'lock_account':
      return { locked_customer_id: p.customer_id, summary: `Account ${p.customer_id} locked` };
    case 'escalate_to_human':
      if (action.ticket_id) db.run("UPDATE tickets SET status = 'escalated', assignee = ?, updated_at = ? WHERE ticket_id = ?", [p.queue || 'specialists', new Date().toISOString(), action.ticket_id]);
      return { queue: p.queue, summary: `Routed to ${p.queue || 'specialists'} queue` };
    default:
      return { summary: `${action.tool_name} executed by ${user.email}` };
  }
}

function addNote(ticketId, author, body) {
  db.run('INSERT INTO ticket_messages (message_id, ticket_id, author_type, author, body, internal, created_at) VALUES (?,?,?,?,?,1,?)',
    [`msg_${uuidv4().slice(0, 10)}`, ticketId, 'system', author, body, new Date().toISOString()]);
}

module.exports = { catalog, getTool, list, get, propose, decide, execute, addNote, ActionError };
