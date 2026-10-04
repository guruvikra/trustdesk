// Connector request shapes, verified against a stubbed fetch (no real accounts needed).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { setup, MANAGER, AGENT } = require('./_helpers');

let ctx;
let calls = [];
let routes = [];
const realFetch = global.fetch;

before(async () => {
  ctx = await setup();
  // Pass local test-server traffic through; answer third-party API calls from `routes`.
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith(ctx.base)) return realFetch(url, opts);
    calls.push({ url: u, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ? (String(opts.body).startsWith('{') ? JSON.parse(opts.body) : String(opts.body)) : undefined });
    const r = routes.find(([m, re]) => (opts.method || 'GET') === m && re.test(u));
    if (!r) return new Response(JSON.stringify({ error: 'no stub' }), { status: 404 });
    return new Response(JSON.stringify(typeof r[2] === 'function' ? r[2](u, opts) : r[2]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
});
after(async () => { global.fetch = realFetch; await ctx.close(); });
beforeEach(() => { calls = []; routes = []; });

const put = (platform, body) => ctx.api('PUT', `/api/integrations/${platform}`, { token: MANAGER, body });

test('integrations list exposes 5 apps with auth modes and never leaks secrets', async () => {
  await put('front', { auth_mode: 'api_key', api_token: 'front-secret-token' });
  const list = await ctx.api('GET', '/api/integrations', { token: AGENT });
  assert.deepStrictEqual(list.body.map(i => i.platform).sort(), ['freshdesk', 'front', 'intercom', 'linear', 'zendesk']);
  const front = list.body.find(i => i.platform === 'front');
  assert.strictEqual(front.enabled, true);
  assert.strictEqual(front.config.api_token, '••••oken');
  assert.ok(!JSON.stringify(list.body).includes('front-secret-token'));
  assert.deepStrictEqual(list.body.find(i => i.platform === 'freshdesk').auth_modes, ['api_key']);
  assert.strictEqual(list.body.find(i => i.platform === 'linear').capabilities.issues, true);
  assert.strictEqual((await put('front', { auth_mode: 'api_key' })).status, 200, 'masked secret is kept on re-save');
  assert.strictEqual((await ctx.api('PUT', '/api/integrations/front', { token: AGENT, body: {} })).status, 403);
});

test('Intercom: import open conversations and reply + close as admin', async () => {
  await put('intercom', { auth_mode: 'api_key', access_token: 'ic-token' });
  routes = [
    ['GET', /api\.intercom\.io\/conversations\?/, { conversations: [
      { id: '9001', state: 'open', created_at: 1782000000, title: null, source: { body: '<p>My BlueBuds arrived cracked</p>', author: { email: 'aisha.rao@example.com', name: 'Aisha Rao' } } },
      { id: '9002', state: 'closed', source: { body: 'old' } },
    ] }],
    ['GET', /api\.intercom\.io\/me/, { id: 'adm_1', name: 'Bot Admin', app: { name: 'Acme' } }],
    ['POST', /conversations\/9001\/reply/, { ok: true }],
    ['POST', /conversations\/9001\/parts/, { ok: true }],
  ];
  const sync = await ctx.api('POST', '/api/integrations/intercom/sync', { token: AGENT });
  assert.strictEqual(sync.status, 200, JSON.stringify(sync.body));
  assert.deepStrictEqual(sync.body.ticket_ids, ['ic_9001']);
  assert.strictEqual(calls[0].headers.Authorization, 'Bearer ic-token');
  assert.strictEqual(calls[0].headers['Intercom-Version'], '2.11');
  const t = await ctx.api('GET', '/api/tickets/ic_9001', { token: AGENT });
  assert.strictEqual(t.body.customer.customer_id, 'cus_1001');
  assert.strictEqual(t.body.body, 'My BlueBuds arrived cracked');

  const d = await ctx.api('POST', '/api/tickets/ic_9001/draft-reply', { token: AGENT });
  calls = [];
  const sent = await ctx.api('POST', `/api/drafts/${d.body.draft.draft_id}/send`, { token: AGENT, body: { resolve: true } });
  assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
  const reply = calls.find(c => /reply$/.test(c.url));
  assert.deepStrictEqual({ type: reply.body.type, message_type: reply.body.message_type, admin_id: reply.body.admin_id }, { type: 'admin', message_type: 'comment', admin_id: 'adm_1' });
  assert.ok(calls.some(c => /parts$/.test(c.url) && c.body.message_type === 'close'));
  assert.match(sent.body.external, /Intercom conversation 9001/);
});

test('Front: import with first message, reply as teammate and archive', async () => {
  await put('front', { auth_mode: 'api_key', api_token: 'front-tok', teammate_id: 'tea_42' });
  routes = [
    ['GET', /api2\.frontapp\.com\/conversations\?/, { _results: [{ id: 'cnv_1', subject: 'Charged twice', created_at: 1782000000.5, recipient: { handle: 'arjun.patel@example.com', name: 'Arjun' } }] }],
    ['GET', /conversations\/cnv_1\/messages/, { _results: [{ text: 'I see two charges on my card.' }] }],
    ['POST', /conversations\/cnv_1\/messages/, { ok: true }],
    ['PATCH', /conversations\/cnv_1$/, { ok: true }],
  ];
  const sync = await ctx.api('POST', '/api/integrations/front/sync', { token: AGENT });
  assert.deepStrictEqual(sync.body.ticket_ids, ['fr_cnv_1']);
  assert.strictEqual(calls[0].headers.Authorization, 'Bearer front-tok');
  const d = await ctx.api('POST', '/api/tickets/fr_cnv_1/draft-reply', { token: AGENT });
  calls = [];
  const sent = await ctx.api('POST', `/api/drafts/${d.body.draft.draft_id}/send`, { token: AGENT, body: { resolve: true } });
  assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
  assert.strictEqual(calls.find(c => c.method === 'POST').body.author_id, 'tea_42');
  assert.deepStrictEqual(calls.find(c => c.method === 'PATCH').body, { status: 'archived' });
});

test('Linear: creates one issue per ticket in the chosen team', async () => {
  await put('linear', { auth_mode: 'api_key', api_key: 'lin_api_x', team_key: 'eng' });
  routes = [['POST', /api\.linear\.app\/graphql/, (u, o) => {
    const q = JSON.parse(o.body).query;
    if (q.includes('teams')) return { data: { teams: { nodes: [{ id: 't1', name: 'Support', key: 'SUP' }, { id: 't2', name: 'Engineering', key: 'ENG' }] } } };
    return { data: { issueCreate: { success: true, issue: { id: 'i1', identifier: 'ENG-12', url: 'https://linear.app/acme/issue/ENG-12' } } } };
  }]];
  const r = await ctx.api('POST', '/api/tickets/tkt_9004/linear-issue', { token: AGENT });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.identifier, 'ENG-12');
  const create = calls.find(c => c.body.query.includes('issueCreate'));
  assert.strictEqual(create.headers.Authorization, 'lin_api_x');
  assert.strictEqual(create.body.variables.input.teamId, 't2');
  assert.match(create.body.variables.input.description, /tkt_9004/);
  const again = await ctx.api('POST', '/api/tickets/tkt_9004/linear-issue', { token: AGENT });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.body.replayed, true);
  const t = await ctx.api('GET', '/api/tickets/tkt_9004', { token: AGENT });
  assert.strictEqual(t.body.external_links[0].external_id, 'ENG-12');
});

test('OAuth: start needs server credentials, builds the authorize URL, callback stores the token', async () => {
  const noCreds = await ctx.api('POST', '/api/integrations/linear/oauth/start', { token: MANAGER });
  assert.strictEqual(noCreds.status, 400);
  assert.match(noCreds.body.detail, /LINEAR_CLIENT_ID/);

  process.env.LINEAR_CLIENT_ID = 'cid';
  process.env.LINEAR_CLIENT_SECRET = 'csecret';
  try {
    const start = await ctx.api('POST', '/api/integrations/linear/oauth/start', { token: MANAGER });
    assert.strictEqual(start.status, 200, JSON.stringify(start.body));
    const url = new URL(start.body.url);
    assert.strictEqual(url.origin + url.pathname, 'https://linear.app/oauth/authorize');
    assert.strictEqual(url.searchParams.get('client_id'), 'cid');
    assert.match(url.searchParams.get('redirect_uri'), /\/api\/oauth\/linear\/callback$/);

    routes = [['POST', /api\.linear\.app\/oauth\/token/, { access_token: 'oauth-access' }]];
    const cb = await realFetch(`${ctx.base}/api/oauth/linear/callback?code=abc&state=${url.searchParams.get('state')}`, { redirect: 'manual' });
    assert.strictEqual(cb.status, 302);
    assert.match(cb.headers.get('location'), /connected=linear/);
    assert.match(calls[0].body, /code=abc/);
    const list = await ctx.api('GET', '/api/integrations', { token: MANAGER });
    const lin = list.body.find(i => i.platform === 'linear');
    assert.strictEqual(lin.enabled, true);
    assert.strictEqual(lin.auth_mode, 'oauth');

    const replay = await realFetch(`${ctx.base}/api/oauth/linear/callback?code=abc&state=${url.searchParams.get('state')}`, { redirect: 'manual' });
    assert.match(replay.headers.get('location'), /oauth_error=/, 'state is single-use');
  } finally {
    delete process.env.LINEAR_CLIENT_ID;
    delete process.env.LINEAR_CLIENT_SECRET;
  }
});

test('Front webhook creates a ticket', async () => {
  const r = await ctx.api('POST', '/api/webhooks/front', { token: null, body: { conversation: { id: 'cnv_77', subject: 'Where is my order', recipient: { handle: 'rahul.mehta@example.com' } }, target: { data: { text: 'Tracking stuck for 7 business days' } } } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.ticket_id, 'fr_cnv_77');
});
