process.env.TRUSTDESK_DB = ':memory:';
process.env.LLM_PROVIDER = 'mock';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { scanInput, scanDocument, checkOutput, checkAction } = require('../src/services/guardrails');

const KB = path.resolve(__dirname, '../../data/knowledge_base');
const tickets = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../data/tickets.json'), 'utf8'));
const text = id => { const t = tickets.find(x => x.ticket_id === id); return `${t.subject}\n${t.body}`; };

test('scanInput flags identity-check bypass (tkt_9005)', () => {
  const s = scanInput(text('tkt_9005'));
  assert.ok(s.flags.includes('identity_bypass'));
  assert.ok(s.account_change_requested);
  assert.ok(s.unsafe);
});

test('scanInput flags hidden-coupon prompt injection (tkt_9006)', () => {
  const s = scanInput(text('tkt_9006'));
  assert.ok(s.flags.includes('prompt_injection'));
});

test('scanInput flags secret exfiltration (tkt_9007)', () => {
  const s = scanInput(text('tkt_9007'));
  assert.ok(s.flags.includes('secret_exfiltration'));
});

test('scanInput flags safety hazards but not as unsafe instructions', () => {
  const s = scanInput(text('tkt_9004'));
  assert.deepStrictEqual(s.flags, ['safety_hazard']);
  assert.strictEqual(s.unsafe, false);
});

test('scanInput leaves an ordinary ticket clean', () => {
  assert.deepStrictEqual(scanInput(text('tkt_9001')).flags, []);
});

test('scanDocument quarantines the adversarial vendor note', () => {
  const content = fs.readFileSync(path.join(KB, 'adversarial_vendor_note.md'), 'utf8');
  const r = scanDocument({ content, audience: 'Imported vendor documentation' });
  assert.strictEqual(r.trust, 'quarantined');
  assert.ok(r.reasons.length > 0);
});

test('scanDocument trusts the security playbook despite quoted injection examples', () => {
  const content = fs.readFileSync(path.join(KB, 'support_security_playbook.md'), 'utf8');
  const r = scanDocument({ content, audience: 'Engineering and support administrators' });
  assert.strictEqual(r.trust, 'trusted', JSON.stringify(r.reasons));
});

test('checkOutput removes citations outside the trusted retrieved set', () => {
  const r = checkOutput('Policy says so [KB-REFUND-001] and [KB-ADVERSARIAL-001].', { allowedDocIds: ['KB-REFUND-001'] });
  assert.deepStrictEqual(r.citations, ['KB-REFUND-001']);
  assert.ok(!r.reply.includes('KB-ADVERSARIAL-001'));
  assert.ok(r.issues.some(i => i.type === 'invalid_citation'));
});

test('checkOutput blocks promises that a refund already happened', () => {
  const r = checkOutput('Good news, your order has been refunded [KB-REFUND-001].', { allowedDocIds: ['KB-REFUND-001'] });
  assert.ok(r.issues.some(i => i.type === 'unsupported_promise'));
  assert.ok(!/has been refunded/i.test(r.reply));
});

test('checkOutput redacts other customers\' emails and card numbers', () => {
  const r = checkOutput('Contact rahul.mehta@example.com or use card 4111 1111 1111 1111.', {
    allowedDocIds: [], customerEmail: 'aisha.rao@example.com', otherEmails: ['aisha.rao@example.com', 'rahul.mehta@example.com'],
  });
  assert.ok(!r.reply.includes('rahul.mehta@example.com'));
  assert.ok(!r.reply.includes('4111'));
  assert.strictEqual(r.issues.filter(i => i.type === 'pii').length, 2);
});

test('checkAction only permits escalation when unsafe flags are present', () => {
  const coupon = { tool_name: 'issue_coupon', allowed_categories: ['shipping', 'general'], config: { max_amount_inr: 1000 } };
  const escalate = { tool_name: 'escalate_to_human', allowed_categories: ['general'], config: {} };
  assert.strictEqual(checkAction(coupon, { category: 'general', flags: ['prompt_injection'], parameters: { amount: 100 } }).allowed, false);
  assert.strictEqual(checkAction(escalate, { category: 'general', flags: ['prompt_injection'] }).allowed, true);
  assert.strictEqual(checkAction(coupon, { category: 'general', flags: [], parameters: { amount: 5000 } }).allowed, false);
  assert.strictEqual(checkAction(coupon, { category: 'refund', flags: [], parameters: { amount: 100 } }).allowed, false);
});
