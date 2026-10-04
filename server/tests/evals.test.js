const { setup, waitFor, MANAGER } = require('./_helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { runEvals } = require('../src/services/evals');

let ctx;
before(async () => { ctx = await setup(); });
after(() => ctx.close());

test('eval runner scores all 8 cases and handles adversarial cases safely', async () => {
  const out = await runEvals({ provider: 'mock' });
  assert.strictEqual(out.cases.length, 8);
  assert.strictEqual(out.metrics.total_cases, 8);
  assert.strictEqual(out.metrics.category_accuracy, 1);
  assert.strictEqual(out.metrics.citation_coverage, 1);
  assert.strictEqual(out.metrics.unsafe_action_block_rate, 1);
  assert.deepStrictEqual(out.metrics.adversarial_safe.map(a => a.case_id), ['eval_005', 'eval_006', 'eval_007']);
  assert.ok(out.metrics.adversarial_safe.every(a => a.safe));
});

test('POST /eval-runs runs in the background and can be polled', async () => {
  const start = await ctx.api('POST', '/api/eval-runs', { body: { provider: 'mock' } });
  assert.strictEqual(start.status, 202);
  assert.strictEqual(start.body.status, 'running');
  const done = await waitFor(async () => {
    const r = await ctx.api('GET', `/api/eval-runs/${start.body.eval_run_id}`);
    return r.body.status !== 'running' && r.body;
  });
  assert.strictEqual(done.status, 'completed');
  assert.strictEqual(done.cases.length, 8);
  assert.ok(done.metrics.passed_cases >= 0);
  const list = await ctx.api('GET', '/api/eval-runs');
  assert.ok(list.body.some(r => r.eval_run_id === start.body.eval_run_id));
});

test('empty-workspace reset keeps docs, removes tickets, and evals stay isolated', async () => {
  const agentTry = await ctx.api('POST', '/api/workspace/reset', { body: { mode: 'empty' } });
  assert.strictEqual(agentTry.status, 403);
  const r = await ctx.api('POST', '/api/workspace/reset', { token: MANAGER, body: { mode: 'empty' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.tickets, 0);
  assert.strictEqual(r.body.customers, 0);
  assert.strictEqual(r.body.documents, 8);
  assert.strictEqual((await ctx.api('GET', '/api/tickets')).body.length, 0);

  const out = await runEvals({ provider: 'mock' });
  assert.strictEqual(out.metrics.category_accuracy, 1);
  assert.ok(out.metrics.adversarial_safe.every(a => a.safe));

  const back = await ctx.api('POST', '/api/workspace/reset', { token: MANAGER, body: { mode: 'demo' } });
  assert.strictEqual(back.body.tickets, 8);
});
