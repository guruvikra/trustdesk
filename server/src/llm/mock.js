// Deterministic offline "model". Used by tests, by the eval baseline, and as a fallback when the
// hosted model is unavailable. It is a transparent keyword + policy-facts classifier and template
// writer; it never sees the expected labels from the dataset.

const { includesAny, queryTerms, splitSentences } = require('../lib/text');

const CATEGORY_KEYWORDS = {
  billing: { charge: 3, charged: 3, 'two charges': 4, invoice: 3, payment: 2, card: 1, billing: 3, billed: 3, 'double charge': 5, subscription: 1, upi: 2, emi: 2 },
  shipping: { tracking: 3, 'not moved': 4, 'no movement': 4, 'in transit': 3, courier: 3, carrier: 3, shipment: 3, shipping: 2, 'not arrived': 4, "hasn't arrived": 4, 'not delivered': 4, late: 2, delayed: 2, package: 1, dispatch: 2, lost: 1 },
  refund: { refund: 3, return: 2, 'money back': 3, damaged: 3, cracked: 3, broken: 2, 'wrong item': 3, replacement: 2, exchange: 2, 'changed my mind': 3, cancel: 1 },
  warranty: { warranty: 4, battery: 2, 'stopped working': 3, defect: 2, defective: 2, 'after months': 2, months: 1, repair: 2, swelling: 3, overheating: 3, 'not charging': 2 },
  account_security: { password: 3, 'account email': 4, login: 2, 'log in': 2, hacked: 4, '2fa': 3, otp: 2, 'change my email': 4, 'account access': 3, 'lost access': 3, verification: 2 },
  general: { coupon: 2, discount: 2, voucher: 2, feedback: 2, question: 1 },
};

function scoreCategories(text) {
  const t = text.toLowerCase();
  const scores = {};
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
    scores[cat] = Object.entries(words).reduce((acc, [w, wt]) => acc + (t.includes(w) ? wt : 0), 0);
  }
  return scores;
}

function triage({ text, facts, flags, accountChange }) {
  const scores = scoreCategories(text);
  const s = facts.signals;
  let category;
  let reason;

  if (flags.includes('secret_exfiltration')) { category = 'account_security'; reason = 'Request targets internal prompts/credentials.'; }
  else if (flags.includes('identity_bypass') || accountChange) { category = 'account_security'; reason = 'Account change or identity-check bypass requested.'; }
  else if (flags.includes('safety_hazard')) { category = 'warranty'; reason = 'Product safety hazard reported.'; }
  else if (s.duplicate_charge) { category = 'billing'; reason = 'Duplicate charge reported.'; }
  else {
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    category = ranked[0][1] > 0 ? ranked[0][0] : 'general';
    // Damage after the return window but inside warranty is a warranty matter.
    if (category === 'refund' && s.mentions_damage && facts.return_policy && !facts.return_policy.within_window && facts.warranty && facts.warranty.within_warranty) category = 'warranty';
    if (flags.includes('prompt_injection') && category !== 'billing') category = 'general';
    reason = ranked[0][1] > 0 ? `Strongest keyword signal: ${ranked[0][0]} (${ranked[0][1]}).` : 'No strong category signal.';
  }

  let priority = 'medium';
  if (flags.includes('safety_hazard')) priority = 'urgent';
  else if (category === 'account_security') priority = 'high';
  else if (category === 'billing' && (s.duplicate_charge || includesAny(text, ['deducted', 'debited', 'charged', 'charge', 'payment failed', 'money taken']))) priority = 'high';
  else if (category === 'shipping' && s.urgent_need) priority = 'high';
  else if (category === 'refund' && !s.mentions_damage && (s.change_of_mind || (facts.return_policy && facts.return_policy.final_sale_items))) priority = 'low';
  if (includesAny(text, ['chargeback', 'lawyer', 'legal action', 'consumer court', 'fraud'])) priority = priority === 'urgent' ? 'urgent' : 'high';

  const negative = includesAny(text, ['damaged', 'cracked', 'not moved', 'failed', 'swelling', 'swollen', 'quickly', 'angry', 'terrible', 'worst', 'still', 'again', 'unacceptable', 'two charges', 'lost access']);
  const sentiment = includesAny(text, ['angry', 'terrible', 'worst', 'unacceptable', 'ridiculous']) ? 'angry' : negative ? 'frustrated' : 'neutral';

  const escalate = flags.some(f => ['safety_hazard', 'prompt_injection', 'secret_exfiltration', 'identity_bypass'].includes(f))
    || (category === 'account_security')
    || (category === 'general' && Math.max(...Object.values(scores)) === 0);

  // How decisive the classification was (used in the answer-confidence score).
  const best = Math.max(...Object.values(scores));
  const certainty = flags.length || accountChange || s.duplicate_charge ? 0.9 : +Math.min(1, best / 6).toFixed(2);
  return { category, priority, sentiment, should_escalate: escalate, rationale: reason, certainty };
}

// --- Draft writer -------------------------------------------------------

function quote(source, hint) {
  if (!source) return '';
  const terms = queryTerms(hint);
  const best = splitSentences(source.content)
    .map(sen => ({ sen, score: terms.filter(t => sen.toLowerCase().includes(t)).length }))
    .sort((a, b) => b.score - a.score)[0];
  return best ? best.sen : '';
}

function draft({ name, text, facts, flags, triage: tri, cite, plan, accountChange, policyCovered = true }) {
  const hi = `Hi ${name || 'there'},`;
  const item = facts.order && facts.order.items[0] ? facts.order.items[0].name : 'your item';
  const orderId = facts.order ? facts.order.order_id : null;
  const lines = [];
  let note = '';
  const c = key => (cite[key] ? ` [${cite[key].doc_id}]` : '');

  if (flags.includes('secret_exfiltration')) {
    lines.push('Thanks for reaching out. I can\'t share internal instructions, system configuration, credentials or internal notes — that information is never disclosed through support' + c('security') + '.');
    lines.push('Our responses also never include authentication tokens, internal notes or other customers\' data' + c('account') + '. If you have a question about an order or your account, reply here and a specialist will help.');
    note = 'Secret-exfiltration attempt detected. Nothing internal disclosed; routed to a human specialist.';
  } else if (flags.includes('identity_bypass') || accountChange) {
    lines.push('Thanks for contacting us. For your security, changes to an account email, password or address require identity verification first, and we can\'t skip that step' + c('account') + '.');
    lines.push('I haven\'t made any change to your account. A specialist from our account security team will contact you to complete verification.');
    if (flags.includes('identity_bypass')) lines.push('Please note our policy does not allow identity checks to be skipped, so that part of the request can\'t be actioned' + c('account') + '.');
    note = facts.customer.verified ? 'Account change requested; verification required before any change.' : 'Account change requested by an UNVERIFIED customer; identity-bypass request ignored.';
  } else if (flags.includes('prompt_injection')) {
    lines.push('Thanks for your message. I\'m not able to act on instructions to override our support policy or to keep actions hidden from our review team' + c('security') + '.');
    if (facts.signals.coupon_requested) lines.push('Coupons are only issued for genuine service issues, always with human approval, and never because a message asked to bypass policy' + c('coupon') + '.');
    lines.push('I\'ve passed your ticket to a member of our team who can review your request.');
    note = 'Prompt-injection detected in the customer message. No coupon or other action proposed; escalated for human review.';
  } else if (flags.includes('safety_hazard')) {
    lines.push(`I'm sorry to hear about the problem with your ${item}. What you describe is a safety issue — please stop using and charging the device and keep it away from heat and flammable materials${c('warranty')}.`);
    lines.push('Please don\'t try to troubleshoot or open it. I\'ve escalated your ticket to a specialist on our safety team with urgent priority, and they will contact you about next steps.');
    if (facts.warranty) note = `Safety escalation. Warranty context: ${facts.warranty.months_since_delivery} months since delivery, coverage ${facts.warranty.coverage_months} months (${facts.warranty.within_warranty ? 'covered' : 'not covered'}). No replacement proposed until the specialist reviews.`;
  } else if (!policyCovered) {
    // Never state policy the knowledge base doesn't contain.
    lines.push('Thanks for reaching out. I want to make sure you get an accurate answer, so I\'ve passed your request to a specialist who will follow up shortly.');
    note = `No ${tri.category} policy found in the knowledge base. Escalated instead of drafting a policy answer — consider adding a ${tri.category} policy document.`;
  } else if (tri.category === 'billing' && facts.signals.duplicate_charge) {
    lines.push(`Sorry about the duplicate charge${orderId ? ` on order ${orderId}` : ''}. I can see ${facts.order && facts.order.customer_order_count === 1 ? 'only one order on your account' : 'your order'}, so I've started a billing review with our payments team${c('billing')}.`);
    lines.push('I can\'t confirm a refund until payments operations verifies the charge. If you can, reply with the payment date, amount and the last four digits of the card — please never share your full card number, CVV or OTP' + c('billing') + '.');
    note = 'Duplicate charge: refund review proposed (requires approval).';
  } else if (tri.category === 'billing') {
    lines.push(`Thanks for reaching out about your payment${orderId ? ` for order ${orderId}` : ''}. I've passed this to our payments team to look into${c('billing')}.`);
    lines.push('To help us find the transaction, reply with the payment date, amount and payment method type. Please never share your full card number, CVV, OTP or banking password' + c('billing') + '.');
    note = 'Billing question without a duplicate charge: no automatic action; payments team to review.';
  } else if (tri.category === 'shipping') {
    const sh = facts.shipping;
    if (sh && sh.carrier_investigation_eligible) {
      lines.push(`Sorry your ${item} hasn't moved. Since tracking${sh.tracking_number ? ` (${sh.tracking_number})` : ''} has shown no movement for ${sh.stale_business_days_reported} business days, the next step is a carrier investigation, which I'm opening now${c('shipping')}.`);
      lines.push((sh.lost_package_resolution_eligible
        ? 'Because there has been no movement for more than 10 business days, a replacement or refund review can now be considered; a team member will review that alongside the investigation'
        : 'If the carrier confirms a problem, or there is still no movement after 10 business days, we\'ll review a replacement or refund') + c('shipping') + '.' + (facts.signals.urgent_need ? ' I\'ve marked your ticket high priority because of your travel date.' : ''));
    } else {
      lines.push(`Thanks for checking on your order${sh && sh.tracking_number ? ` (tracking ${sh.tracking_number})` : ''}. Most orders are delivered within 3 to 7 business days depending on location and carrier capacity${c('shipping')}.`);
      lines.push('If tracking shows no movement for 5 or more business days, reply and we\'ll open a carrier investigation' + c('shipping') + '.');
    }
  } else if (tri.category === 'refund') {
    const rp = facts.return_policy;
    if (rp && rp.final_sale_items) {
      lines.push(`Thanks for getting in touch about ${item}. Software licenses, downloadable products and final-sale items aren't eligible for a refund after purchase${c('refund')}, so I'm not able to approve this refund.`);
      lines.push('If something isn\'t working with the product, let me know and we\'ll help you get it sorted.');
      note = 'Final-sale/software item: refund not eligible. No action proposed.';
    } else if (rp && rp.within_window && facts.signals.mentions_damage) {
      lines.push(`I'm sorry your ${item} arrived damaged. It was delivered ${rp.days_since_delivery} day(s) before you contacted us, which is within our ${rp.window_days}-day window for damaged items, so you can choose a replacement or a refund review${c('refund')}.`);
      const refund = plan.some(p => p.tool_name === 'start_refund_review');
      lines.push(`I've requested a ${refund ? 'refund review' : 'replacement'} for you; a team member will confirm it shortly. If you can, reply with a photo of the damage to help us process it faster` + c('refund') + '.');
      note = `Damaged on arrival within return window: ${refund ? 'refund review' : 'replacement'} proposed (requires approval).`;
    } else if (rp && !rp.within_window) {
      lines.push(`Thanks for reaching out about ${item}. It was delivered ${rp.days_since_delivery} days ago, which is outside our ${rp.window_days}-day return window${c('refund')}.`);
      lines.push(facts.customer.tier === 'gold' ? 'As a Gold customer you may be considered for a goodwill exception, which needs approval from our team; I\'ve flagged this for review.' : 'If the item is defective, it may still be covered under warranty — reply with details and we\'ll check.');
    } else {
      lines.push(`Thanks for contacting us about ${item}. ${quote(cite.refund, 'returned refund days delivery') }${c('refund')}`);
      lines.push('A team member will review your request and confirm the next steps.');
    }
  } else if (tri.category === 'warranty') {
    const w = facts.warranty;
    if (w && w.within_warranty) {
      lines.push(`Sorry to hear about the issue with your ${item}. It is ${w.months_since_delivery} months since delivery and your coverage is ${w.coverage_months} months${w.gold_extension_months ? ' including the Gold-tier extension' : ''}, so it's within warranty for manufacturing defects${c('warranty')}.`);
      lines.push('To proceed we may need proof of purchase, the serial number and photos; a replacement needs approval from our team' + c('warranty') + '.');
    } else {
      lines.push(`Sorry to hear about the issue with your ${item}. ${w ? `It is ${w.months_since_delivery} months since delivery, beyond the ${w.coverage_months}-month coverage` : 'I couldn\'t confirm the warranty status'}${c('warranty')}. A specialist will review options with you.`);
    }
  } else {
    const src = cite.general;
    if (src && !tri.should_escalate) {
      // Answer from the best-matching knowledge-base section (up to two relevant sentences).
      const terms = queryTerms(text || '');
      const best = splitSentences(src.content).map((sen, i) => ({ sen, i, score: terms.filter(t => sen.toLowerCase().includes(t)).length }))
        .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 2).sort((a, b) => a.i - b.i);
      lines.push(`Thanks for your question. ${best.length ? best.map(b => b.sen).join(' ') : quote(src, text)} [${src.doc_id}]`);
      lines.push(`You can read more in "${src.title}" — ${src.heading}. If this doesn't solve it, just reply and a member of our team will help.`);
      note = `Answered from the knowledge base (${src.doc_id}).`;
    } else {
      if (src) lines.push(`Thanks for your message. ${quote(src, text || tri.rationale)} [${src.doc_id}]`);
      lines.push('A member of our team will review your request and follow up.');
      note = 'No specific policy matched with confidence; routed to a human.';
    }
  }

  if (plan.some(p => p.tool_name === 'escalate_to_human') && !/specialist|our team|team member|escalat/i.test(lines.join(' '))) {
    lines.push('I\'ve escalated your ticket to a support specialist.');
  }
  return { reply: [hi, '', ...lines, '', 'Best regards,', 'Customer Support'].join('\n'), internal_note: note };
}

// --- Assistant: extractive answer from the top sources --------------------

function answer({ question, sources }) {
  const terms = queryTerms(question);
  const picked = [];
  sources.forEach((s, idx) => {
    splitSentences(s.content).forEach((sen, pos) => {
      const lower = sen.toLowerCase();
      const score = terms.filter(t => lower.includes(t)).length;
      if (score > 0) picked.push({ sen, score: score - idx * 0.3, n: idx + 1, pos });
    });
  });
  picked.sort((a, b) => b.score - a.score);
  // Keep only sentences nearly as relevant as the best one, then present them in source order.
  const best = picked.length ? picked[0].score : 0;
  // Prefer the single best source; only borrow from others if it has fewer than two good sentences.
  const strong = picked.filter(p => p.score >= best * 0.6);
  const fromTop = strong.filter(p => p.n === 1);
  const top = (fromTop.length >= 2 ? fromTop : strong).slice(0, 3).sort((a, b) => a.n - b.n || a.pos - b.pos);
  if (!top.length) return { answer: '', used_sources: [], answerable: false };
  return {
    answer: top.map(p => `${p.sen} [${p.n}]`).join(' '),
    used_sources: [...new Set(top.map(p => p.n))],
    answerable: true,
  };
}

module.exports = { triage, draft, answer, name: 'mock', model: 'policy-engine-v1' };
