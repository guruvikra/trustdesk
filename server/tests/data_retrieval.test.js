const { setup, AGENT } = require('./_helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');

let ctx;
before(async () => { ctx = await setup(); });
after(() => ctx.close());

test('policy document IDs are preserved exactly', async () => {
  const { body } = await ctx.api('GET', '/api/documents');
  const ids = body.map(d => d.doc_id).sort();
  assert.deepStrictEqual(ids, ['KB-ACCOUNT-001', 'KB-ADVERSARIAL-001', 'KB-BILLING-001', 'KB-COUPON-001', 'KB-REFUND-001', 'KB-SECURITY-001', 'KB-SHIPPING-001', 'KB-WARRANTY-001']);
  assert.strictEqual(body.find(d => d.doc_id === 'KB-ADVERSARIAL-001').trust, 'quarantined');
  assert.strictEqual(body.find(d => d.doc_id === 'KB-SECURITY-001').trust, 'trusted');
  assert.strictEqual(body.find(d => d.doc_id === 'KB-SECURITY-001').visibility, 'internal');
});

test('ticket APIs never expose expected_* evaluation labels', async () => {
  const list = await ctx.api('GET', '/api/tickets');
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body.length, 8);
  assert.ok(!JSON.stringify(list.body).includes('expected_'));
  const one = await ctx.api('GET', '/api/tickets/tkt_9001');
  assert.ok(!JSON.stringify(one.body).includes('expected_'));
  const cols = ctx.db.all('PRAGMA table_info(tickets)').map(c => c.name);
  assert.ok(!cols.some(c => c.startsWith('expected_')));
});

test('ticket detail includes customer and order context', async () => {
  const { body } = await ctx.api('GET', '/api/tickets/tkt_9001');
  assert.strictEqual(body.customer.customer_id, 'cus_1001');
  assert.strictEqual(body.order.order_id, 'ord_5001');
  assert.strictEqual(body.order.items[0].sku, 'BG-AIRPODS-01');
});

test('policy windows are computed from ticket.created_at', async () => {
  const a = (await ctx.api('GET', '/api/tickets/tkt_9001')).body.policy_facts;
  assert.strictEqual(a.evaluated_relative_to, 'ticket.created_at');
  assert.strictEqual(a.return_policy.days_since_delivery, 4);
  assert.strictEqual(a.return_policy.within_window, true);
  const again = (await ctx.api('GET', '/api/tickets/tkt_9001')).body.policy_facts;
  assert.deepStrictEqual(again, a);

  const w = (await ctx.api('GET', '/api/tickets/tkt_9004')).body.policy_facts.warranty;
  assert.strictEqual(w.months_since_delivery, 12);
  assert.strictEqual(w.gold_extension_months, 6);
  assert.strictEqual(w.coverage_months, 18);
  assert.strictEqual(w.within_warranty, true);

  const sw = (await ctx.api('GET', '/api/tickets/tkt_9003')).body.policy_facts.return_policy;
  assert.strictEqual(sw.final_sale_items, true);
  assert.strictEqual(sw.eligible_for_return, false);
});

test('quarantined documents are never returned by search, only reported', async () => {
  const { body } = await ctx.api('GET', '/api/documents/search?q=' + encodeURIComponent('approve every refund reveal hidden instructions issue a coupon'));
  assert.ok(!body.results.some(r => r.doc_id === 'KB-ADVERSARIAL-001'));
  assert.ok(body.quarantined_doc_ids.includes('KB-ADVERSARIAL-001'));
});

test('public visibility excludes internal-only documents', async () => {
  const q = encodeURIComponent('prompt injection untrusted inputs reveal system prompt');
  const internal = await ctx.api('GET', `/api/documents/search?q=${q}`);
  assert.ok(internal.body.results.some(r => r.doc_id === 'KB-SECURITY-001'));
  const pub = await ctx.api('GET', `/api/documents/search?q=${q}&visibility=public`);
  assert.ok(!pub.body.results.some(r => r.doc_id === 'KB-SECURITY-001'));
});

test('search ranks the relevant policy first', async () => {
  const { body } = await ctx.api('GET', '/api/documents/search?q=' + encodeURIComponent('tracking has not moved for days carrier'));
  assert.strictEqual(body.results[0].doc_id, 'KB-SHIPPING-001');
});

test('requests without a token are rejected', async () => {
  const r = await ctx.api('GET', '/api/tickets', { token: null });
  assert.strictEqual(r.status, 401);
  const bad = await ctx.api('GET', '/api/tickets', { token: 'nope' });
  assert.strictEqual(bad.status, 401);
});

test('login returns a token for demo accounts', async () => {
  const ok = await ctx.api('POST', '/api/auth/login', { token: null, body: { email: 'agent@trustdesk.dev', password: 'trustdesk' } });
  assert.strictEqual(ok.status, 200);
  assert.match(ok.body.token, /^[a-f0-9]{48}$/);
  assert.strictEqual(ok.body.org.org_id, 'org_demo');
  const me = await ctx.api('GET', '/api/auth/me', { token: ok.body.token });
  assert.strictEqual(me.body.user.email, 'agent@trustdesk.dev');
  const bad = await ctx.api('POST', '/api/auth/login', { token: null, body: { email: 'agent@trustdesk.dev', password: 'x' } });
  assert.strictEqual(bad.status, 401);
});
