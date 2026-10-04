// The AI pipeline for a ticket: guardrail scan -> retrieval -> model -> hard policy rules ->
// output checks -> action planning -> trace. The same functions serve the API and the eval runner.

const { v4: uuidv4 } = require('uuid');
const { db, parseJson } = require('../db');
const llm = require('../llm');
const { scanInput, checkOutput, redactForLog } = require('./guardrails');
const { computeFacts } = require('./policy');
const { workspaceIndex } = require('./retrieval');
const actions = require('./actions');

const UNSAFE_FLAGS = ['prompt_injection', 'secret_exfiltration', 'identity_bypass'];
const PRIORITY_RANK = { low: 0, medium: 1, high: 2, urgent: 3 };
const atLeast = (p, min) => (PRIORITY_RANK[p] >= PRIORITY_RANK[min] ? p : min);

// Topic queries used to find the governing policy for a situation (no hardcoded doc ids).
const TOPICS = {
  refund: 'refund return policy physical products damaged replacement non-returnable final sale',
  shipping: 'shipping delivery stale tracking carrier investigation lost package',
  warranty: 'warranty product safety battery swelling replacement coverage',
  billing: 'billing duplicate charge payment refund review transaction',
  account: 'account identity verification email change sensitive data internal notes hidden prompts api keys',
  security: 'prompt injection untrusted inputs reveal system prompt api key ignore previous instructions',
  coupon: 'coupon goodwill limits disallowed uses ignore instructions',
};

// A topic document only counts as governing policy if it actually talks about that topic.
const TOPIC_ANCHORS = {
  refund: /\brefund|\breturn/i,
  shipping: /tracking|deliver|carrier|shipping|ships\b/i,
  warranty: /warranty|safety|defect/i,
  billing: /charge|billing|payment/i,
  account: /verif|identity|account/i,
  security: /injection|untrusted|instruction|prompt/i,
  coupon: /coupon|goodwill/i,
};
// A chunk governs a topic if its title/heading names it, or its text discusses it repeatedly
// (a passing mention such as a list of categories in an unrelated document does not count).
function isAbout(chunk, anchor) {
  if (anchor.test(`${chunk.title} ${chunk.heading}`)) return true;
  const g = new RegExp(anchor.source, 'gi');
  return (chunk.content.match(g) || []).length >= 3;
}

const CATEGORY_TOPIC = { refund: 'refund', shipping: 'shipping', warranty: 'warranty', billing: 'billing', account_security: 'account' };

// --- Context -------------------------------------------------------------

function parseOrder(row) {
  return row ? { ...row, items: parseJson(row.items_json, []) } : null;
}

function loadContext(ticketId) {
  const ticket = db.get('SELECT * FROM tickets WHERE ticket_id = ?', [ticketId]);
  if (!ticket) return null;
  const customer = ticket.customer_id ? db.get('SELECT * FROM customers WHERE customer_id = ?', [ticket.customer_id]) : null;
  const order = parseOrder(ticket.order_id ? db.get('SELECT * FROM orders WHERE order_id = ?', [ticket.order_id]) : null);
  const count = customer ? db.get('SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND replacement_for IS NULL', [customer.customer_id]).n : null;
  return buildContext(ticket, customer, order, count);
}

function buildContext(ticket, customer, order, customerOrderCount) {
  const text = `${ticket.subject}\n${ticket.body}`;
  const facts = computeFacts(ticket, order, customer, { customerOrderCount });
  const firstName = customer ? customer.name.split(' ')[0] : null;
  return { ticket, customer, order, facts, text, firstName };
}

// --- Trace helper ----------------------------------------------------------

class Trace {
  constructor(runType, ticketId) {
    this.run_id = `run_${uuidv4().replace(/-/g, '').slice(0, 10)}`;
    this.run_type = runType;
    this.ticket_id = ticketId;
    this.started = Date.now();
    this.steps = [];
  }
  step(name, data) { this.steps.push({ step: name, at_ms: Date.now() - this.started, ...data }); }
  save(fields, persist) {
    const row = {
      run_id: this.run_id, ticket_id: this.ticket_id, run_type: this.run_type, latency_ms: Date.now() - this.started,
      steps: this.steps, created_at: new Date().toISOString(), prompt_version: llm.PROMPT_VERSION, ...fields,
    };
    if (persist) {
      db.run(`INSERT INTO agent_runs (run_id, ticket_id, run_type, provider, model, input_summary, retrieved_doc_ids_json,
              quarantined_doc_ids_json, recommended_actions_json, blocked_actions_json, guardrail_json, output_json, steps_json,
              final_status, latency_ms, prompt_version, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [row.run_id, row.ticket_id, row.run_type, row.provider, row.model, row.input_summary,
        JSON.stringify(row.retrieved_doc_ids || []), JSON.stringify(row.quarantined_doc_ids || []),
        JSON.stringify(row.recommended_actions || []), JSON.stringify(row.blocked_actions || []),
        JSON.stringify(row.guardrails || {}), JSON.stringify(row.output || {}), JSON.stringify(row.steps),
        row.final_status, row.latency_ms, row.prompt_version, row.created_by || null, row.created_at]);
    }
    return row;
  }
}

// --- Retrieval for a ticket ------------------------------------------------

function retrieveForTicket(ctx, { index, category, flags, accountChange }) {
  const main = index.search(ctx.text, { limit: 4 });
  const topicKeys = new Set([category === 'account_security' ? 'account' : category]);
  if (flags.some(f => ['prompt_injection', 'secret_exfiltration'].includes(f))) topicKeys.add('security');
  if (flags.includes('secret_exfiltration') || flags.includes('identity_bypass') || accountChange) topicKeys.add('account');
  if (ctx.facts.signals.coupon_requested) topicKeys.add('coupon');
  if (flags.includes('safety_hazard')) topicKeys.add('warranty');

  const cite = {};
  const sources = [...main.results];
  for (const key of topicKeys) {
    if (!TOPICS[key]) continue;
    const top = index.search(TOPICS[key] + ' ' + ctx.text, { limit: 1 }).results[0];
    if (top && isAbout(top, TOPIC_ANCHORS[key])) {
      cite[key] = top;
      if (!sources.some(s => s.chunk_id === top.chunk_id)) sources.push(top);
    }
  }
  if (category === 'general' && main.results[0]) cite.general = main.results[0];
  return { sources, cite, quarantined: main.quarantined_doc_ids };
}

// --- Triage -----------------------------------------------------------------

function enforceTriage(raw, { flags, accountChange, facts }) {
  const t = { ...raw };
  const applied = [];
  if (flags.includes('safety_hazard')) {
    if (t.priority !== 'urgent' || !t.should_escalate) applied.push('safety hazard → urgent + escalate');
    t.priority = 'urgent'; t.should_escalate = true;
    if (!['warranty', 'refund'].includes(t.category)) t.category = 'warranty';
  }
  if (flags.includes('secret_exfiltration') || flags.includes('identity_bypass')) {
    if (!t.should_escalate) applied.push(`${flags.filter(f => UNSAFE_FLAGS.includes(f)).join('+')} → escalate`);
    t.should_escalate = true; t.priority = atLeast(t.priority, 'high');
  }
  if (flags.includes('identity_bypass') || (accountChange && !flags.includes('prompt_injection'))) {
    if (t.category !== 'account_security') applied.push('account change → account_security');
    t.category = 'account_security'; t.should_escalate = true; t.priority = atLeast(t.priority, 'high');
  }
  if (flags.includes('prompt_injection') && !t.should_escalate) { applied.push('prompt injection → escalate'); t.should_escalate = true; }
  if (accountChange && !facts.customer.verified && !t.should_escalate) { applied.push('unverified customer account change → escalate'); t.should_escalate = true; }
  return { triage: t, applied };
}

async function triage(ctx, { index = workspaceIndex(), provider, user, persist = true } = {}) {
  const trace = new Trace('triage', ctx.ticket.ticket_id);
  const scan = scanInput(ctx.text);
  trace.step('guardrail_input', { flags: scan.flags, matches: scan.matches, account_change_requested: scan.account_change_requested });

  const prelim = index.search(ctx.text, { limit: 3 });
  trace.step('retrieve', { doc_ids: [...new Set(prelim.results.map(r => r.doc_id))], quarantined_doc_ids: prelim.quarantined_doc_ids });

  const { output, meta } = await llm.triage({ text: ctx.text, facts: ctx.facts, flags: scan.flags, accountChange: scan.account_change_requested }, { provider });
  trace.step('model', { ...meta, output });

  const { triage: final, applied } = enforceTriage(output, { flags: scan.flags, accountChange: scan.account_change_requested, facts: ctx.facts });
  trace.step('policy_rules', { applied });

  const run = trace.save({
    provider: meta.provider, model: meta.model, input_summary: redactForLog(ctx.ticket.subject),
    retrieved_doc_ids: [...new Set(prelim.results.map(r => r.doc_id))], quarantined_doc_ids: prelim.quarantined_doc_ids,
    guardrails: { flags: scan.flags, rules_applied: applied, fallback_reason: meta.fallback_reason },
    output: final, final_status: final.should_escalate ? 'escalation_recommended' : 'completed', created_by: user && user.email,
  }, persist);

  if (persist) {
    db.run('UPDATE tickets SET triage_json = ?, triage_run_id = ?, updated_at = ? WHERE ticket_id = ?',
      [JSON.stringify({ ...final, flags: scan.flags }), run.run_id, new Date().toISOString(), ctx.ticket.ticket_id]);
  }
  return { run_id: run.run_id, triage: { ...final, flags: scan.flags }, trace: run };
}

// --- Action planning ----------------------------------------------------------

function planActions(ctx, { category, flags, triage: tri, accountChange, policyCovered = true }) {
  const { facts, ticket } = ctx;
  const plan = [];
  const blocked = [];
  const unsafe = flags.filter(f => UNSAFE_FLAGS.includes(f));
  const order = facts.order;
  const item = order && order.items.find(i => !i.final_sale) || (order && order.items[0]);

  // No document in this workspace governs the request: hand it to a person instead of acting.
  const escalate = tri.should_escalate || !policyCovered;
  if (escalate) {
    const queue = flags.includes('safety_hazard') ? 'product_safety'
      : unsafe.some(f => f !== 'identity_bypass') ? 'trust_and_safety'
        : category === 'account_security' ? 'account_security' : 'tier2_support';
    const why = unsafe.length ? `Guardrail flags: ${unsafe.join(', ')}` : flags.includes('safety_hazard') ? 'Product safety issue'
      : !policyCovered ? `No ${category} policy in the knowledge base` : 'Requires specialist review';
    plan.push({ tool_name: 'escalate_to_human', reason: !policyCovered && !tri.should_escalate ? why : tri.rationale || why, parameters: { ticket_id: ticket.ticket_id, reason: why, queue } });
  }

  if (!unsafe.length && !flags.includes('safety_hazard') && order && policyCovered) {
    const rp = facts.return_policy;
    if (category === 'refund' && rp && rp.eligible_for_return && facts.signals.mentions_damage) {
      // Policy allows either; follow what the customer asked for (replacement by default).
      const why = `Damaged on arrival, reported ${rp.days_since_delivery} days after delivery (within ${rp.window_days}-day window).`;
      if (facts.signals.refund_requested && !facts.signals.replacement_requested) plan.push({ tool_name: 'start_refund_review', reason: why, parameters: { order_id: order.order_id, amount: order.total, reason: 'Damaged on arrival' } });
      else plan.push({ tool_name: 'create_replacement_order', reason: why, parameters: { order_id: order.order_id, sku: item.sku, reason: 'Damaged on arrival' } });
    } else if (category === 'refund' && rp && rp.eligible_for_return && facts.signals.refund_requested) {
      plan.push({ tool_name: 'start_refund_review', reason: 'Return requested within the return window.', parameters: { order_id: order.order_id, amount: order.total, reason: 'Return within window' } });
    } else if (category === 'warranty' && facts.warranty && facts.warranty.within_warranty && facts.signals.mentions_damage) {
      plan.push({ tool_name: 'create_replacement_order', reason: 'Defect reported within warranty coverage.', parameters: { order_id: order.order_id, sku: item.sku, reason: 'Warranty defect' } });
    } else if (category === 'shipping' && facts.shipping && facts.shipping.carrier_investigation_eligible) {
      plan.push({ tool_name: 'open_carrier_investigation', reason: `No tracking movement for ${facts.shipping.stale_business_days_reported} business days (threshold ${facts.shipping.stale_threshold_business_days}).`, parameters: { order_id: order.order_id, tracking_number: order.tracking_number, reason: 'Stale tracking' } });
    } else if (category === 'billing' && facts.signals.duplicate_charge) {
      plan.push({ tool_name: 'start_refund_review', reason: 'Duplicate charge reported on a single order.', parameters: { order_id: order.order_id, amount: order.total, reason: 'Duplicate charge' } });
    }
  }

  // Tools the customer asked for that policy does not support are recorded as blocked.
  const requested = [];
  if (facts.signals.coupon_requested) requested.push('issue_coupon');
  if (facts.signals.refund_requested) requested.push('start_refund_review');
  if (facts.signals.replacement_requested) requested.push('create_replacement_order');
  for (const tool of requested) {
    if (plan.some(p => p.tool_name === tool)) continue;
    let reason = 'Not supported by policy for this ticket.';
    if (unsafe.length) reason = `Requested alongside ${unsafe.join(', ')}; unsafe instructions are never acted on.`;
    else if (flags.includes('safety_hazard')) reason = 'Safety escalation must happen before any replacement or refund.';
    else if (facts.return_policy && facts.return_policy.final_sale_items) reason = 'Final-sale / software items are not eligible for refund.';
    else if (category === 'shipping') reason = facts.shipping && facts.shipping.lost_package_resolution_eligible
      ? 'Past 10 business days: a replacement/refund review can be considered, but it needs human review — the AI does not create it from a shipping ticket.'
      : 'Lost-package replacement/refund needs carrier confirmation or 10 business days without movement.';
    else if (facts.return_policy && !facts.return_policy.within_window) reason = `Outside the ${facts.return_policy.window_days}-day return window.`;
    else if (!order) reason = 'No order is linked to this ticket.';
    if (!policyCovered && !unsafe.length) reason = `No ${category} policy in the knowledge base supports this action.`;
    blocked.push({ tool_name: tool, reason });
  }
  return { plan, blocked };
}

// --- Draft ------------------------------------------------------------------

async function draft(ctx, { index = workspaceIndex(), provider, user, persist = true, triageResult } = {}) {
  let tri = triageResult || parseJson(ctx.ticket.triage_json, null);
  if (!tri) tri = (await triage(ctx, { index, provider, user, persist })).triage;

  const trace = new Trace('draft', ctx.ticket.ticket_id);
  const scan = scanInput(ctx.text);
  const flags = scan.flags;
  trace.step('guardrail_input', { flags, matches: scan.matches });

  const { sources, cite, quarantined } = retrieveForTicket(ctx, { index, category: tri.category, flags, accountChange: scan.account_change_requested });
  const allowedDocIds = [...new Set(sources.map(s => s.doc_id))];
  trace.step('retrieve', { doc_ids: allowedDocIds, chunks: sources.map(s => ({ chunk_id: s.chunk_id, score: s.score })), quarantined_doc_ids: quarantined });

  const topicKey = CATEGORY_TOPIC[tri.category];
  const policyCovered = !topicKey || Boolean(cite[topicKey]);
  const { plan, blocked } = planActions(ctx, { category: tri.category, flags, triage: tri, accountChange: scan.account_change_requested, policyCovered });
  trace.step('action_policy', { planned: plan.map(p => p.tool_name), blocked });

  if (!policyCovered) trace.step('policy_coverage', { covered: false, category: tri.category, detail: `No document in this workspace covers ${tri.category}; escalating instead of answering.` });
  const { output, meta } = await llm.draft({
    name: ctx.firstName, text: ctx.text, facts: ctx.facts, flags, triage: tri, sources, cite, plan, policyCovered,
    accountChange: scan.account_change_requested,
  }, { provider });
  trace.step('model', { provider: meta.provider, model: meta.model, latency_ms: meta.latency_ms, input_tokens: meta.input_tokens, output_tokens: meta.output_tokens, fallback_reason: meta.fallback_reason });

  const otherEmails = persist ? db.all('SELECT email FROM customers').map(r => r.email) : [];
  const checked = checkOutput(output.reply, { allowedDocIds, customerEmail: ctx.customer && ctx.customer.email, otherEmails });
  if (!checked.citations.length) checked.issues.push({ type: 'uncited', detail: 'No policy citation in reply; human review required.' });
  trace.step('guardrail_output', { issues: checked.issues, citations: checked.citations });

  if (output.suggested_action && !plan.some(p => p.tool_name === output.suggested_action)) {
    trace.step('model_suggestion_ignored', { suggested_action: output.suggested_action, reason: 'Actions are decided by the policy engine, not the model.' });
  }

  const unsafe = flags.some(f => UNSAFE_FLAGS.includes(f));
  const { confidence, components } = answerConfidence({ index, ctx, tri, cite, topicKey, sources, policyCovered, checked, unsafe });
  trace.step('confidence', { confidence, components });
  const finalStatus = unsafe ? 'refused_and_escalated' : tri.should_escalate || !policyCovered ? 'escalated'
    : checked.issues.some(i => i.type === 'uncited') ? 'needs_human_review' : 'draft_ready';

  const run = trace.save({
    provider: meta.provider, model: meta.model, input_summary: redactForLog(ctx.ticket.subject),
    retrieved_doc_ids: allowedDocIds, quarantined_doc_ids: quarantined,
    recommended_actions: plan.map(p => p.tool_name), blocked_actions: blocked,
    guardrails: { flags, output_issues: checked.issues, fallback_reason: meta.fallback_reason },
    output: { reply: checked.reply, citations: checked.citations, internal_note: output.internal_note, confidence, confidence_components: components, policy_covered: policyCovered },
    final_status: finalStatus, created_by: user && user.email,
  }, persist);

  let draftRow = null;
  let proposed = [];
  if (persist) {
    const draftId = `drf_${uuidv4().replace(/-/g, '').slice(0, 10)}`;
    const now = new Date().toISOString();
    db.run("UPDATE drafts SET status = 'superseded' WHERE ticket_id = ? AND status = 'draft'", [ctx.ticket.ticket_id]);
    db.run(`INSERT INTO drafts (draft_id, ticket_id, run_id, body, original_body, citations_json, status, created_at, updated_at)
            VALUES (?,?,?,?,?,?, 'draft', ?, ?)`, [draftId, ctx.ticket.ticket_id, run.run_id, checked.reply, checked.reply, JSON.stringify(checked.citations), now, now]);
    draftRow = { draft_id: draftId, body: checked.reply, citations: checked.citations, status: 'draft' };

    // Proposals use deterministic idempotency keys, so regenerating a draft never duplicates actions.
    for (const p of plan) {
      const res = actions.propose({ ticket_id: ctx.ticket.ticket_id, tool_name: p.tool_name, parameters: p.parameters,
        idempotency_key: `ai:${ctx.ticket.ticket_id}:${p.tool_name}`, proposed_by: 'ai', source_run_id: run.run_id, category: tri.category, flags });
      proposed.push({ ...res.action, reason: p.reason, replayed: res.replayed });
    }
    for (const b of blocked) {
      const tool = actions.getTool(b.tool_name);
      if (!tool) continue;
      actions.propose({ ticket_id: ctx.ticket.ticket_id, tool_name: b.tool_name, parameters: { requested_by_customer: true },
        idempotency_key: `ai-blocked:${ctx.ticket.ticket_id}:${b.tool_name}`, proposed_by: 'ai', source_run_id: run.run_id,
        category: tri.category, flags, block_reason: b.reason });
    }
  }

  const sourceMap = {};
  for (const s of sources) if (!sourceMap[s.doc_id]) sourceMap[s.doc_id] = { doc_id: s.doc_id, title: s.title, heading: s.heading, excerpt: s.content.slice(0, 400) };
  return {
    run_id: run.run_id, ticket_id: ctx.ticket.ticket_id, triage: tri, draft: draftRow,
    reply: checked.reply, citations: checked.citations, sources: checked.citations.map(id => sourceMap[id]).filter(Boolean),
    internal_note: output.internal_note, recommended_actions: plan, proposed_actions: proposed, blocked_actions: blocked,
    guardrails: { flags, output_issues: checked.issues, quarantined_doc_ids: quarantined },
    final_status: finalStatus, provider: meta.provider, model: meta.model, fallback_reason: meta.fallback_reason, trace: run,
    confidence, confidence_components: components, policy_covered: policyCovered,
  };
}

// Transparent answer-confidence heuristic used by Autopilot's threshold:
//   policy (0.35)        the governing policy document exists and is cited in the reply
//   retrieval (0.35)     how much of the ticket's wording that document covers (full marks at 50%)
//   classification (0.2) how decisive triage was
//   grounding (0.1)      the reply passed output guardrails with at least one valid citation
// Capped at 0.97. Unsafe input forces 0; escalations are capped at 0.5 so they are never auto-sent.
function answerConfidence({ index, ctx, tri, cite, topicKey, sources, policyCovered, checked, unsafe }) {
  const governing = (topicKey && cite[topicKey]) || cite.general || sources[0];
  const coverage = governing ? index.coverage(ctx.text, governing.chunk_id) : 0;
  const components = {
    policy: policyCovered && governing && checked.citations.includes(governing.doc_id) ? 0.35 : 0,
    retrieval: +(0.35 * Math.min(1, coverage / 0.5)).toFixed(3),
    classification: +(0.2 * (Number.isFinite(tri.certainty) ? tri.certainty : 0.7)).toFixed(3),
    grounding: checked.citations.length && !checked.issues.length ? 0.1 : 0,
  };
  // A heuristic is never certain: cap at 97%, so a 98–100% threshold means "never auto-send".
  let confidence = Math.min(0.97, Object.values(components).reduce((a, b) => a + b, 0));
  if (unsafe) confidence = 0;
  else if (tri.should_escalate || !policyCovered) confidence = Math.min(confidence, 0.5);
  return { confidence: +confidence.toFixed(2), components: { ...components, governing_doc: governing ? governing.doc_id : null, governing_coverage: coverage } };
}

function formatRun(r) {
  if (!r) return null;
  return {
    run_id: r.run_id, ticket_id: r.ticket_id, run_type: r.run_type, provider: r.provider, model: r.model,
    input_summary: r.input_summary, retrieved_doc_ids: parseJson(r.retrieved_doc_ids_json, []),
    quarantined_doc_ids: parseJson(r.quarantined_doc_ids_json, []), recommended_actions: parseJson(r.recommended_actions_json, []),
    blocked_actions: parseJson(r.blocked_actions_json, []), guardrails: parseJson(r.guardrail_json, {}),
    output: parseJson(r.output_json, {}), steps: parseJson(r.steps_json, []), final_status: r.final_status,
    latency_ms: r.latency_ms, prompt_version: r.prompt_version, feedback: r.feedback, created_by: r.created_by, created_at: r.created_at,
  };
}

module.exports = { loadContext, buildContext, triage, draft, planActions, formatRun, Trace, enforceTriage };
