// Held-out sanity set: 10 tickets written AFTER the rules were tuned on the provided eval cases.
// Labels are our own (documented in README); this checks generalisation, not the graded metric.
// Usage: npm run eval:heldout [-- --mock]
require('../src/lib/env').loadEnv();
process.env.TRUSTDESK_DB = ':memory:';
const fs = require('fs');
const path = require('path');
const { db } = require('../src/db');

(async () => {
  await db.init();
  const { policyPackIndex } = require('../src/services/evals');
  const agent = require('../src/services/agent');
  const read = f => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../data', f), 'utf8'));
  const customers = read('customers.json');
  const orders = read('orders.json');
  const cases = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../tests/fixtures/heldout_cases.json'), 'utf8'));
  const index = policyPackIndex();
  const provider = process.argv.includes('--mock') ? 'mock' : undefined;
  let pass = 0;
  for (const c of cases) {
    const customer = customers.find(x => x.customer_id === c.customer_id) || null;
    const order = orders.find(o => o.order_id === c.order_id) || null;
    const ctx = agent.buildContext({ ticket_id: c.id, subject: c.subject, body: c.body, created_at: c.created_at }, customer, order, customer ? orders.filter(o => o.customer_id === customer.customer_id).length : null);
    const tri = await agent.triage(ctx, { index, provider, persist: false });
    const res = await agent.draft(ctx, { index, provider, persist: false, triageResult: tri.triage });
    const rec = res.recommended_actions.map(a => a.tool_name);
    const e = c.expected;
    const fails = [];
    if (e.category && tri.triage.category !== e.category) fails.push(`category ${tri.triage.category}≠${e.category}`);
    if (e.priority && tri.triage.priority !== e.priority) fails.push(`priority ${tri.triage.priority}≠${e.priority}`);
    if (e.should_escalate !== undefined && tri.triage.should_escalate !== e.should_escalate) fails.push(`escalate ${tri.triage.should_escalate}≠${e.should_escalate}`);
    if (e.disallowed_actions.some(a => rec.includes(a))) fails.push(`disallowed action recommended (${rec.join(',')})`);
    if (e.allowed_actions.length && !e.allowed_actions.some(a => rec.includes(a))) fails.push(`missing allowed action (${rec.join(',') || 'none'})`);
    if (!e.allowed_actions.length && rec.length) fails.push(`unexpected action ${rec.join(',')}`);
    if (!res.citations.length) fails.push('no citation');
    if (!fails.length) pass++;
    console.log(`  ${fails.length ? '✗' : '✓'} ${c.id} ${c.subject.padEnd(34)} ${tri.triage.category}/${tri.triage.priority} esc=${tri.triage.should_escalate} actions=${rec.join(',') || '-'} cites=${res.citations.join(',')}${fails.length ? '  ← ' + fails.join('; ') : ''}`);
  }
  console.log(`\nHeld-out: ${pass}/${cases.length} passed (provider: ${provider || require('../src/llm').config().provider})\n`);
})().catch(e => { console.error(e); process.exit(1); });
