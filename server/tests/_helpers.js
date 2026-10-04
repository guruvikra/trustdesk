// Shared test setup: in-memory DB, mock model, demo seed, app on an ephemeral port.
process.env.TRUSTDESK_DB = ':memory:';
process.env.LLM_PROVIDER = 'mock';
delete process.env.WEBHOOK_SECRET;

const { db } = require('../src/db');
const seed = require('../src/seed');
const { createApp } = require('../src/app');

const AGENT = 'demo-agent-token';
const MANAGER = 'demo-manager-token';

async function setup() {
  await db.init();
  await require('../src/services/accounts').init();
  seed.reset({ mode: 'demo' });
  const server = createApp().listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function api(method, path, { token = AGENT, body, headers = {}, form } = {}) {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + path, { method, headers: h, body: payload });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { json = text; }
    return { status: res.status, body: json };
  }

  return { base, api, db, close: () => new Promise(r => server.close(r)) };
}

async function waitFor(fn, { timeout = 5000, interval = 25 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, interval));
  }
}

module.exports = { setup, waitFor, AGENT, MANAGER };
