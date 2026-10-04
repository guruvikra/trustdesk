// Regression tests for issues found in the full review.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, waitFor, MANAGER, AGENT } = require('./_helpers');

let ctx;
before(async () => { ctx = await setup(); });
after(async () => { await ctx.close(); });

async function jobResult(token, body) {
  const r = await ctx.api('POST', '/api/documents/ingest', { token, ...body });
  return waitFor(async () => { const j = (await ctx.api('GET', `/api/ingest-jobs/${r.body.job_id}`, { token })).body; return ['completed', 'failed'].includes(j.status) && j; });
}

test('URL import refuses internal addresses (SSRF)', async () => {
  for (const url of ['http://localhost:8000/api/auth/demo-accounts', 'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.5/', 'http://example.com:8080/']) {
    const job = await jobResult(MANAGER, { body: { url } });
    assert.strictEqual(job.status, 'failed', url);
    assert.ok(job.doc_ids.length === 0);
  }
});

test('binary or unsupported files are rejected, not ingested as text', async () => {
  const form = new FormData();
  form.append('files', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])], { type: 'image/png' }), 'fake.png');
  const job = await jobResult(MANAGER, { form });
  assert.deepStrictEqual(job.doc_ids, []);
  assert.ok(job.logs.some(l => /Unsupported file type/.test(l.message)));
});

test('user-supplied doc IDs are normalised so they can be cited', async () => {
  const job = await jobResult(MANAGER, { body: { documents: [{ doc_id: 'exchange policy 1', title: 'Ex', content: '# Ex\n\n## A\nExchanges within 15 days.' }] } });
  assert.deepStrictEqual(job.doc_ids, ['KB-EXCHANGE-POLICY-1']);
});

test('drafts: empty text rejected, sent drafts cannot be rejected, webhook tickets send without a connection', async () => {
  const hook = await ctx.api('POST', '/api/webhooks/zendesk', { token: null, body: { ticket: { id: 8801, subject: 'Damaged earbuds', description: 'My earbuds arrived cracked', requester: { email: 'aisha.rao@example.com' } } } });
  const d = await ctx.api('POST', `/api/tickets/${hook.body.ticket_id}/draft-reply`, { token: AGENT });
  const id = d.body.draft.draft_id;
  assert.strictEqual((await ctx.api('PATCH', `/api/drafts/${id}`, { token: AGENT, body: { body: '   ' } })).status, 400);
  const sent = await ctx.api('POST', `/api/drafts/${id}/send`, { token: AGENT, body: {} });
  assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
  assert.match(sent.body.external, /not connected/);
  assert.strictEqual((await ctx.api('POST', `/api/drafts/${id}/reject`, { token: AGENT, body: {} })).status, 409);
});

test('public form: repeated submit is idempotent and a claimed email is not linked to the customer', async () => {
  const ask = await ctx.api('POST', '/api/public/ask', { token: null, body: { question: 'Where is my order? Tracking is stuck.' } });
  const body = { resolved: false, channel: 'support_form', email: 'aisha.rao@example.com', subject: 'Order stuck', order_id: 'ord_5001' };
  const a = await ctx.api('POST', `/api/public/deflections/${ask.body.event_id}/outcome`, { token: null, body });
  const b = await ctx.api('POST', `/api/public/deflections/${ask.body.event_id}/outcome`, { token: null, body });
  assert.strictEqual(a.body.ticket_id, b.body.ticket_id);
  assert.strictEqual(b.body.replayed, true);
  const t = await ctx.api('GET', `/api/tickets/${a.body.ticket_id}`, { token: AGENT });
  assert.strictEqual(t.body.customer, null);
  assert.strictEqual(t.body.order, null);
  assert.strictEqual(t.body.unverified_match.customer_id, 'cus_1001');
});

test('manual tickets cannot spoof channel, id or date; misc validation', async () => {
  const t = await ctx.api('POST', '/api/tickets', { token: AGENT, body: { ticket_id: 'tkt_9001', channel: 'zendesk', source_ref: '1', created_at: '2020-01-01', subject: 'Hi', body: 'Question', requester_email: 'x@y.test' } });
  assert.strictEqual(t.status, 201);
  assert.notStrictEqual(t.body.ticket_id, 'tkt_9001');
  assert.strictEqual(t.body.channel, 'manual');
  assert.ok(!t.body.created_at.startsWith('2020'));
  assert.strictEqual((await ctx.api('GET', '/api/agent-runs?limit=-1', { token: AGENT })).body.length <= 1, true);
  assert.strictEqual((await ctx.api('POST', '/api/agent-runs/run_nope/feedback', { token: AGENT, body: { rating: 'up' } })).status, 404);
  assert.strictEqual((await ctx.api('GET', '/api/tickets?token=demo-agent-token', { token: null })).status, 401);
});

test('starting OAuth does not break a working API-key connection', async () => {
  await ctx.api('PUT', '/api/integrations/zendesk', { token: MANAGER, body: { auth_mode: 'api_key', subdomain: 'acme', email: 'a@acme.test', api_token: 'tok' } });
  await ctx.api('PUT', '/api/integrations/zendesk', { token: MANAGER, body: { auth_mode: 'oauth', subdomain: 'acme' } });
  const z = (await ctx.api('GET', '/api/integrations', { token: MANAGER })).body.find(i => i.platform === 'zendesk');
  assert.strictEqual(z.enabled, true);
  assert.strictEqual(z.auth_mode, 'api_key');
  await ctx.api('DELETE', '/api/integrations/zendesk', { token: MANAGER });
});
