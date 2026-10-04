const { setup, AGENT, MANAGER } = require('./_helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

let ctx;
before(async () => { ctx = await setup(); });
after(() => ctx.close());

const replacementOrders = () => ctx.db.get("SELECT COUNT(*) AS n FROM orders WHERE replacement_for = 'ord_5001'").n;

test('tkt_9001: triage, cited draft, approval-gated replacement with idempotent execution', async () => {
  const tri = await ctx.api('POST', '/api/tickets/tkt_9001/triage');
  assert.strictEqual(tri.status, 200);
  assert.strictEqual(tri.body.triage.category, 'refund');
  assert.ok(tri.body.run_id);

  const draft = await ctx.api('POST', '/api/tickets/tkt_9001/draft-reply');
  assert.strictEqual(draft.status, 200);
  assert.ok(draft.body.citations.includes('KB-REFUND-001'));
  assert.ok(draft.body.reply.includes('[KB-REFUND-001]'));
  const action = draft.body.proposed_actions.find(a => a.tool_name === 'create_replacement_order');
  assert.ok(action, 'replacement proposed');
  assert.strictEqual(action.status, 'pending_approval');

  // Cannot execute before approval.
  const early = await ctx.api('POST', `/api/tool-actions/${action.action_id}/execute`);
  assert.strictEqual(early.status, 409);
  assert.strictEqual(replacementOrders(), 0);

  // Agent cannot approve; manager can.
  const agentApprove = await ctx.api('POST', `/api/tool-actions/${action.action_id}/approve`, { token: AGENT });
  assert.strictEqual(agentApprove.status, 403);
  const approve = await ctx.api('POST', `/api/tool-actions/${action.action_id}/approve`, { token: MANAGER, body: { note: 'photo received' } });
  assert.strictEqual(approve.status, 200);
  assert.strictEqual(approve.body.action.status, 'approved');
  assert.strictEqual(approve.body.action.decided_by, 'manager@trustdesk.dev');

  const exec = await ctx.api('POST', `/api/tool-actions/${action.action_id}/execute`);
  assert.strictEqual(exec.status, 200);
  assert.strictEqual(exec.body.action.status, 'executed');
  assert.ok(exec.body.action.execution_result.replacement_order_id);
  assert.strictEqual(replacementOrders(), 1);

  // Retrying execution replays the stored result.
  const again = await ctx.api('POST', `/api/tool-actions/${action.action_id}/execute`);
  assert.strictEqual(again.body.replayed, true);
  assert.strictEqual(again.body.action.execution_result.replacement_order_id, exec.body.action.execution_result.replacement_order_id);
  assert.strictEqual(replacementOrders(), 1);

  // Regenerating the draft does not create duplicate proposals.
  const redraft = await ctx.api('POST', '/api/tickets/tkt_9001/draft-reply');
  assert.strictEqual(redraft.status, 200);
  const all = (await ctx.api('GET', '/api/tool-actions?ticket_id=tkt_9001')).body.filter(a => a.tool_name === 'create_replacement_order');
  assert.strictEqual(all.length, 1);
  assert.strictEqual(replacementOrders(), 1);
});

test('rejected actions cannot be executed', async () => {
  const draft = await ctx.api('POST', '/api/tickets/tkt_9008/draft-reply');
  const review = draft.body.proposed_actions.find(a => a.tool_name === 'start_refund_review');
  assert.strictEqual(review.status, 'pending_approval');
  const rej = await ctx.api('POST', `/api/tool-actions/${review.action_id}/reject`, { token: MANAGER, body: { note: 'need txn ref' } });
  assert.strictEqual(rej.body.action.status, 'rejected');
  const exec = await ctx.api('POST', `/api/tool-actions/${review.action_id}/execute`);
  assert.strictEqual(exec.status, 409);
});

test('POST /tool-actions enforces idempotency keys', async () => {
  const body = { ticket_id: 'tkt_9002', tool_name: 'open_carrier_investigation', idempotency_key: 'test-key-1',
    parameters: { order_id: 'ord_5002', tracking_number: 'BLUETRK10002', reason: 'stale' } };
  const first = await ctx.api('POST', '/api/tool-actions', { body });
  assert.strictEqual(first.status, 201);
  assert.strictEqual(first.body.replayed, false);
  const second = await ctx.api('POST', '/api/tool-actions', { body });
  assert.strictEqual(second.status, 200);
  assert.strictEqual(second.body.replayed, true);
  assert.strictEqual(second.body.action.action_id, first.body.action.action_id);

  const conflict = await ctx.api('POST', '/api/tool-actions', { body: { ...body, parameters: { ...body.parameters, reason: 'different' } } });
  assert.strictEqual(conflict.status, 409);

  const noKey = await ctx.api('POST', '/api/tool-actions', { body: { ...body, idempotency_key: undefined } });
  assert.strictEqual(noKey.status, 400);

  // Header form of the key works too.
  const viaHeader = await ctx.api('POST', '/api/tool-actions', { body: { ...body, idempotency_key: undefined }, headers: { 'Idempotency-Key': 'test-key-1' } });
  assert.strictEqual(viaHeader.body.action.action_id, first.body.action.action_id);
});

test('coupons over the limit are blocked', async () => {
  const r = await ctx.api('POST', '/api/tool-actions', { body: { tool_name: 'issue_coupon', idempotency_key: 'coupon-big',
    parameters: { customer_id: 'cus_1002', amount: 5000, reason: 'goodwill' } } });
  assert.strictEqual(r.body.action.status, 'blocked');
  assert.match(r.body.action.block_reason, /limit/);
});

test('coupon on the prompt-injection ticket is blocked', async () => {
  await ctx.api('POST', '/api/tickets/tkt_9006/triage');
  const r = await ctx.api('POST', '/api/tool-actions', { body: { ticket_id: 'tkt_9006', tool_name: 'issue_coupon', idempotency_key: 'coupon-9006',
    parameters: { customer_id: 'cus_1006', amount: 500, reason: 'customer asked' } } });
  assert.strictEqual(r.body.action.status, 'blocked');
  assert.match(r.body.action.block_reason, /prompt_injection/);
  const exec = await ctx.api('POST', `/api/tool-actions/${r.body.action.action_id}/execute`);
  assert.strictEqual(exec.status, 409);
});

test('missing required fields block a proposal', async () => {
  const r = await ctx.api('POST', '/api/tool-actions', { body: { tool_name: 'create_replacement_order', idempotency_key: 'missing-1', parameters: { order_id: 'ord_5001' } } });
  assert.strictEqual(r.body.action.status, 'blocked');
  assert.match(r.body.action.block_reason, /Missing required fields/);
});
