// Helpdesk Autopilot: triage / draft / auto-reply with a confidence threshold and safety rules.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, waitFor, MANAGER, AGENT } = require('./_helpers');

let ctx;
before(async () => { ctx = await setup(); });
after(async () => { await ctx.close(); });

const settings = body => ctx.api('PUT', '/api/automation/settings', { token: MANAGER, body });

test('settings: defaults, validation and role check', async () => {
  const s = await ctx.api('GET', '/api/automation/settings', { token: AGENT });
  assert.strictEqual(s.body.mode, 'draft');
  assert.strictEqual((await ctx.api('PUT', '/api/automation/settings', { token: AGENT, body: { mode: 'auto' } })).status, 403);
  assert.strictEqual((await settings({ threshold: 0.2 })).status, 400);
  assert.strictEqual((await settings({ mode: 'auto', threshold: 0.75 })).body.mode, 'auto');
});

test('auto mode answers a safe, confident ticket and resolves it', async () => {
  await settings({ mode: 'auto', threshold: 0.75 });
  const r = await ctx.api('POST', '/api/tickets/tkt_9003/autopilot', { token: AGENT });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.event.outcome, 'auto_replied', JSON.stringify(r.body.event));
  assert.ok(r.body.event.confidence >= 0.75);
  assert.strictEqual(r.body.ticket.status, 'resolved');
  assert.strictEqual(r.body.ticket.draft.status, 'sent');
  assert.ok(r.body.ticket.messages.some(m => m.author === 'TrustDesk Autopilot' && !m.internal && /KB-REFUND-001/.test(m.body)));
});

test('auto mode never sends when an approval-gated action is involved', async () => {
  await settings({ mode: 'auto', threshold: 0.5 });
  const r = await ctx.api('POST', '/api/tickets/tkt_9001/autopilot', { token: AGENT });
  assert.strictEqual(r.body.event.outcome, 'drafted');
  assert.ok(r.body.event.reasons.some(x => /create_replacement_order/.test(x)));
  assert.strictEqual(r.body.ticket.status, 'open');
  assert.strictEqual(r.body.ticket.draft.status, 'draft');
});

test('auto mode refuses adversarial tickets and auto-escalates them', async () => {
  await settings({ mode: 'auto', threshold: 0.5, auto_escalate: true });
  const r = await ctx.api('POST', '/api/tickets/tkt_9006/autopilot', { token: AGENT });
  assert.strictEqual(r.body.event.outcome, 'escalated');
  assert.strictEqual(r.body.event.confidence, 0);
  assert.ok(r.body.event.reasons.some(x => /prompt_injection/.test(x)));
  assert.strictEqual(r.body.ticket.status, 'escalated');
  assert.ok(!r.body.ticket.messages.some(m => m.author === 'TrustDesk Autopilot'));
});

test('a high threshold holds even a clean answer for review', async () => {
  await settings({ mode: 'auto', threshold: 0.99 });
  const t = await ctx.api('POST', '/api/tickets', { token: AGENT, body: { subject: 'Refund my software license', body: 'I bought a software license and changed my mind, please refund it.', requester_email: 'vikram.sethi@example.com', order_id: 'ord_5004' } });
  const ev = await waitFor(async () => (await ctx.api('GET', `/api/tickets/${t.body.ticket_id}`, { token: AGENT })).body.autopilot);
  assert.strictEqual(ev.outcome, 'drafted');
  assert.ok(ev.reasons.some(x => /below the 99% threshold/.test(x)), JSON.stringify(ev));
});

test('triage mode only classifies; new tickets from any channel trigger Autopilot', async () => {
  await settings({ mode: 'triage' });
  const hook = await ctx.api('POST', '/api/webhooks/zendesk', { token: null, body: { ticket: { id: 5151, subject: 'Package stuck', description: 'Tracking has not moved for 6 business days', requester: { email: 'rahul.mehta@example.com' } } } });
  const ev = await waitFor(async () => (await ctx.api('GET', `/api/tickets/${hook.body.ticket_id}`, { token: AGENT })).body.autopilot);
  assert.strictEqual(ev.outcome, 'triaged');
  assert.strictEqual(ev.trigger, 'zendesk');
  const t = await ctx.api('GET', `/api/tickets/${hook.body.ticket_id}`, { token: AGENT });
  assert.strictEqual(t.body.triage.category, 'shipping');
  assert.strictEqual(t.body.draft, null);
  const log = await ctx.api('GET', '/api/automation/events', { token: AGENT });
  assert.ok(log.body.events.length >= 4);
  assert.ok(log.body.summary.auto_replied >= 1);
  await settings({ mode: 'draft', threshold: 0.8 });
});

test('support form hand-off creates a support_form ticket the customer can check', async () => {
  await settings({ mode: 'auto', threshold: 0.75 });
  const ask = await ctx.api('POST', '/api/public/ask', { token: null, body: { question: 'Can I get a refund for a software license I bought?' } });
  const out = await ctx.api('POST', `/api/public/deflections/${ask.body.event_id}/outcome`, { token: null, body: { resolved: false, channel: 'support_form', email: 'vikram.sethi@example.com', name: 'Vikram', subject: 'Software license refund', details: 'I changed my mind about my annual cloud backup license, order ord_5004.' } });
  assert.strictEqual(out.status, 201);
  const status = await waitFor(async () => {
    const r = await ctx.api('GET', `/api/public/tickets/${out.body.ticket_id}?email=vikram.sethi@example.com`, { token: null });
    return r.body.reply && r.body;
  });
  assert.strictEqual(status.status, 'resolved');
  assert.match(status.reply.from, /AI-assisted/);
  assert.strictEqual((await ctx.api('GET', `/api/public/tickets/${out.body.ticket_id}?email=someone@else.test`, { token: null })).status, 404);
  const t = await ctx.api('GET', `/api/tickets/${out.body.ticket_id}`, { token: AGENT });
  assert.strictEqual(t.body.channel, 'support_form');
  await settings({ mode: 'draft', threshold: 0.8 });
});
