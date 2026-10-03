const { db } = require('../db');
const { v4: uuidv4 } = require('uuid');

function listToolCatalog() {
  const tools = db.all('SELECT * FROM tool_actions');
  return tools.map(t => ({
    tool_name: t.tool_name,
    description: t.description,
    risk_level: t.risk_level,
    requires_human_approval: Boolean(t.requires_approval),
    allowed_categories: JSON.parse(t.allowed_categories_json || '[]'),
    required_fields: JSON.parse(t.required_fields_json || '[]')
  }));
}

function requestToolAction(payload) {
  const { action_id, tool_name, ticket_id, customer_id, order_id, parameters = {}, idempotency_key } = payload;
  const toolId = tool_name || action_id;

  if (!toolId) {
    throw new Error("Missing 'action_id' or 'tool_name'");
  }

  // Idempotency check
  if (idempotency_key) {
    const existing = db.get('SELECT * FROM approval_requests WHERE idempotency_key = ?', [idempotency_key]);
    if (existing) {
      return {
        request_id: existing.request_id,
        action_id: existing.action_id,
        status: existing.status,
        idempotency_key: existing.idempotency_key,
        message: 'Action already submitted with this idempotency key (cached response)',
        execution_result: existing.execution_result_json ? JSON.parse(existing.execution_result_json) : null,
        is_idempotent_replay: true
      };
    }
  }

  const tool = db.get('SELECT * FROM tool_actions WHERE action_id = ? OR tool_name = ?', [toolId, toolId]);
  const requiresApproval = tool ? Boolean(tool.requires_approval) : true;
  const requestId = `act_${uuidv4().replace(/-/g, '').substring(0, 10)}`;
  const now = new Date().toISOString();

  if (requiresApproval) {
    db.run(
      `INSERT INTO approval_requests 
       (request_id, action_id, ticket_id, customer_id, order_id, idempotency_key, parameters_json, status, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?)`,
      [
        requestId,
        toolId,
        ticket_id,
        customer_id,
        order_id,
        idempotency_key,
        JSON.stringify(parameters),
        now
      ]
    );

    return {
      request_id: requestId,
      action_id: toolId,
      status: 'pending_approval',
      idempotency_key,
      requires_approval: true,
      message: `Action '${toolId}' requires supervisor sign-off before financial execution.`
    };
  } else {
    const execResult = executeToolAction(toolId, parameters);
    db.run(
      `INSERT INTO approval_requests 
       (request_id, action_id, ticket_id, customer_id, order_id, idempotency_key, parameters_json, status, requested_at, reviewed_by, reviewed_at, execution_result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'executed', ?, 'system', ?, ?)`,
      [
        requestId,
        toolId,
        ticket_id,
        customer_id,
        order_id,
        idempotency_key,
        JSON.stringify(parameters),
        now,
        now,
        JSON.stringify(execResult)
      ]
    );

    return {
      request_id: requestId,
      action_id: toolId,
      status: 'executed',
      idempotency_key,
      requires_approval: false,
      execution_result: execResult
    };
  }
}

function approveToolAction(requestId, reviewedBy = 'support_manager') {
  const req = db.get('SELECT * FROM approval_requests WHERE request_id = ?', [requestId]);
  if (!req) {
    throw new Error(`Approval request '${requestId}' not found`);
  }

  if (req.status === 'executed') {
    return {
      request_id: req.request_id,
      status: 'executed',
      message: 'Request is already executed',
      execution_result: JSON.parse(req.execution_result_json || '{}')
    };
  }

  const parameters = JSON.parse(req.parameters_json || '{}');
  const execResult = executeToolAction(req.action_id, parameters);
  const now = new Date().toISOString();

  db.run(
    `UPDATE approval_requests 
     SET status = 'executed', reviewed_by = ?, reviewed_at = ?, execution_result_json = ?
     WHERE request_id = ?`,
    [reviewedBy, now, JSON.stringify(execResult), requestId]
  );

  return {
    request_id: requestId,
    action_id: req.action_id,
    status: 'executed',
    reviewed_by: reviewedBy,
    reviewed_at: now,
    execution_result: execResult
  };
}

function executeToolAction(actionId, parameters) {
  if (actionId === 'create_replacement_order') {
    const newOrderId = `ord_rep_${uuidv4().substring(0, 6)}`;
    return {
      action: 'create_replacement_order',
      success: true,
      replacement_order_id: newOrderId,
      target_order: parameters.order_id || 'ord_5001',
      sku: parameters.sku || 'BG-AIRPODS-01',
      shipping_method: 'expedited_overnight',
      status: 'order_confirmed'
    };
  }

  if (actionId === 'start_refund_review') {
    return {
      action: 'start_refund_review',
      success: true,
      workflow_id: `ref_${uuidv4().substring(0, 8)}`,
      amount_inr: parameters.amount || 8999,
      status: 'under_finance_audit'
    };
  }

  if (actionId === 'issue_coupon') {
    return {
      action: 'issue_coupon',
      success: true,
      coupon_code: `GOODWILL-${uuidv4().substring(0, 6).toUpperCase()}`,
      discount_pct: 10,
      valid_until: '2026-12-31'
    };
  }

  return {
    action: actionId,
    success: true,
    executed_at: new Date().toISOString()
  };
}

module.exports = {
  listToolCatalog,
  requestToolAction,
  approveToolAction
};
