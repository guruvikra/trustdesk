// Multi-tenant SaaS behaviour: sign-up, isolated workspaces, team, public keys, logout.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, waitFor, MANAGER } = require('./_helpers');

let ctx;
before(async () => { ctx = await setup(); });
after(async () => { await ctx.close(); });

async function signup(email, company = 'Acme Retail') {
  const r = await ctx.api('POST', '/api/auth/signup', { token: null, body: { name: 'Owner', email, password: 'supersecret1', company } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

test('sign-up validates input and rejects duplicate emails', async () => {
  const weak = await ctx.api('POST', '/api/auth/signup', { token: null, body: { name: 'A', email: 'a@b.co', password: 'short', company: 'X' } });
  assert.strictEqual(weak.status, 400);
  await signup('dupe@acme.test');
  const again = await ctx.api('POST', '/api/auth/signup', { token: null, body: { name: 'A', email: 'DUPE@acme.test', password: 'supersecret1', company: 'X' } });
  assert.strictEqual(again.status, 409);
});

test('a new organisation gets an empty, isolated workspace', async () => {
  const { token, org, user } = await signup('owner@acme.test');
  assert.strictEqual(user.role, 'admin');
  assert.match(org.public_key, /^pk_/);
  const tickets = await ctx.api('GET', '/api/tickets', { token });
  assert.deepStrictEqual(tickets.body, []);
  const docs = await ctx.api('GET', '/api/documents', { token });
  assert.deepStrictEqual(docs.body, []);
  assert.strictEqual((await ctx.api('GET', '/api/tickets/tkt_9001', { token })).status, 404);

  // Data created in the new workspace is invisible to the demo workspace and vice versa.
  const created = await ctx.api('POST', '/api/tickets', { token, body: { subject: 'Acme only', body: 'hello', requester_email: 'c@acme.test' } });
  assert.strictEqual(created.status, 201);
  const demo = await ctx.api('GET', '/api/tickets', { token: MANAGER });
  assert.ok(!demo.body.some(t => t.ticket_id === created.body.ticket_id));
  assert.ok(demo.body.some(t => t.ticket_id === 'tkt_9001'));

  // The tool catalog is available so approvals work from day one.
  assert.strictEqual((await ctx.api('GET', '/api/tools', { token })).body.length, 6);
});

test('knowledge and widget are scoped by the workspace public key', async () => {
  const { token, org } = await signup('kb@acme.test', 'Acme KB');
  const job = await ctx.api('POST', '/api/documents/ingest', { token, body: { documents: [{ doc_id: 'KB-ACME-001', title: 'Acme Exchanges', content: '# Acme Exchanges\n\n## Size exchanges\nJackets can be exchanged for a different size within 15 days of delivery if tags are attached.' }] } });
  await waitFor(async () => (await ctx.api('GET', `/api/ingest-jobs/${job.body.job_id}`, { token })).body.status === 'completed');

  const own = await ctx.api('POST', '/api/public/ask', { token: null, headers: { 'X-Workspace-Key': org.public_key }, body: { question: 'Can I exchange my jacket for a different size?' } });
  assert.strictEqual(own.body.answered, true);
  assert.strictEqual(own.body.citations[0].doc_id, 'KB-ACME-001');

  const demo = await ctx.api('POST', '/api/public/ask', { token: null, body: { question: 'Can I exchange my jacket for a different size?' } });
  assert.ok(!demo.body.citations.some(c => c.doc_id === 'KB-ACME-001'));

  const bad = await ctx.api('POST', '/api/public/ask?key=pk_nope', { token: null, body: { question: 'hi there' } });
  assert.strictEqual(bad.status, 404);

  const hook = await ctx.api('POST', `/api/webhooks/zendesk?key=${org.public_key}`, { token: null, body: { ticket: { id: 777, subject: 'Exchange', description: 'Need size L', requester: { email: 'buyer@x.test' } } } });
  assert.strictEqual(hook.status, 201);
  const list = await ctx.api('GET', '/api/tickets', { token });
  assert.ok(list.body.some(t => t.ticket_id === 'zd_777'));
});

test('team: invite with temporary password, role rules, removal, logout', async () => {
  const { token } = await signup('boss@acme.test', 'Acme Team');
  const inv = await ctx.api('POST', '/api/team', { token, body: { name: 'Ravi', email: 'ravi@acme.test', role: 'support_agent' } });
  assert.strictEqual(inv.status, 201);
  const login = await ctx.api('POST', '/api/auth/login', { token: null, body: { email: 'ravi@acme.test', password: inv.body.temporary_password } });
  assert.strictEqual(login.status, 200);
  assert.strictEqual(login.body.org.name, 'Acme Team');

  const agentInvite = await ctx.api('POST', '/api/team', { token: login.body.token, body: { name: 'X', email: 'x@acme.test', role: 'admin' } });
  assert.strictEqual(agentInvite.status, 403);
  const team = await ctx.api('GET', '/api/team', { token });
  assert.strictEqual(team.body.length, 2);
  assert.ok(team.body.every(m => !('password_hash' in m)));

  const self = await ctx.api('DELETE', `/api/team/${team.body.find(m => m.email === 'boss@acme.test').user_id}`, { token });
  assert.strictEqual(self.status, 400);
  const rm = await ctx.api('DELETE', `/api/team/${inv.body.user.user_id}`, { token });
  assert.strictEqual(rm.status, 200);
  assert.strictEqual((await ctx.api('GET', '/api/auth/me', { token: login.body.token })).status, 401);

  await ctx.api('POST', '/api/auth/logout', { token });
  assert.strictEqual((await ctx.api('GET', '/api/auth/me', { token })).status, 401);
});

test('file upload in a new workspace stays in that workspace (multer keeps tenant context)', async () => {
  const { token } = await signup('upload@acme.test', 'Acme Upload');
  const form = new FormData();
  form.append('files', new Blob(['# Acme Returns Guide\n\n## Window\nAcme items can be returned within 30 days of delivery.\n'], { type: 'text/markdown' }), 'acme-returns.md');
  const res = await ctx.api('POST', '/api/documents/ingest', { token, form });
  assert.strictEqual(res.status, 202);
  const job = await waitFor(async () => {
    const r = await ctx.api('GET', `/api/ingest-jobs/${res.body.job_id}`, { token });
    assert.strictEqual(r.status, 200, 'job must be visible in the uploading workspace');
    return r.body.status === 'completed' && r.body;
  });
  const docs = await ctx.api('GET', '/api/documents', { token });
  assert.deepStrictEqual(docs.body.map(d => d.doc_id), job.doc_ids);
  assert.strictEqual(docs.body[0].title, 'Acme Returns Guide');
  const demoDocs = await ctx.api('GET', '/api/documents', { token: MANAGER });
  assert.ok(!demoDocs.body.some(d => job.doc_ids.includes(d.doc_id)), 'upload must not leak into the demo workspace');
  assert.strictEqual((await ctx.api('GET', `/api/ingest-jobs/${res.body.job_id}`, { token: MANAGER })).status, 404);
});

test('a workspace without a matching policy escalates instead of inventing one', async () => {
  const { token } = await signup('nopolicy@acme.test', 'Acme No Policy');
  const job = await ctx.api('POST', '/api/documents/ingest', { token, body: { documents: [{ title: 'Exchange Policy', content: '# Exchange Policy\n\n## Size exchanges\nJackets can be exchanged for a different size within 15 days of delivery.' }] } });
  await waitFor(async () => (await ctx.api('GET', `/api/ingest-jobs/${job.body.job_id}`, { token })).body.status === 'completed');
  const t = await ctx.api('POST', '/api/tickets', { token, body: { subject: 'Charged twice', body: 'I see two charges on my card for one order.', requester_email: 'sam@x.test' } });
  const d = await ctx.api('POST', `/api/tickets/${t.body.ticket_id}/draft-reply`, { token });
  assert.strictEqual(d.status, 200);
  assert.strictEqual(d.body.final_status, 'escalated');
  assert.deepStrictEqual(d.body.recommended_actions.map(a => a.tool_name), ['escalate_to_human']);
  assert.ok(!/duplicate charge|billing review/i.test(d.body.reply), 'must not state billing policy that does not exist');
  const run = await ctx.api('GET', `/api/agent-runs/${d.body.run_id}`, { token });
  assert.ok(run.body.steps.some(s => s.step === 'policy_coverage'));
});

test('a one-document knowledge base still answers an exact match (gate is scale-free)', async () => {
  const { token, org } = await signup('tiny@acme.test', 'Acme Tiny');
  const job = await ctx.api('POST', '/api/documents/ingest', { token, body: { documents: [{ title: 'Acme Shipping', content: '# Acme Shipping\n\n## Delivery times\nAcme ships every order within 2 business days.\n\n## International\nAcme ships to the UAE and Singapore. International delivery takes 8 to 12 business days.' }] } });
  await waitFor(async () => (await ctx.api('GET', `/api/ingest-jobs/${job.body.job_id}`, { token })).body.status === 'completed');
  const r = await ctx.api('POST', '/api/public/ask', { token: null, headers: { 'X-Workspace-Key': org.public_key }, body: { question: 'Do you ship to the UAE?' } });
  assert.strictEqual(r.body.answered, true);
  const miss = await ctx.api('POST', '/api/public/ask', { token: null, headers: { 'X-Workspace-Key': org.public_key }, body: { question: 'What are your store opening hours in Pune?' } });
  assert.strictEqual(miss.body.answered, false);
});
