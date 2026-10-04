// Application-level guardrails. These run in code around the model; they do not rely on the
// model obeying its prompt. Customer messages and retrieved documents are treated as untrusted data.

const INPUT_RULES = [
  {
    flag: 'prompt_injection',
    patterns: [
      /ignore (all |any |the )?(previous |prior |above |support )?(instructions|policies|policy|rules)/,
      /system override/, /you are now (allowed|a|an|in)/, /disregard (the|all|your)/,
      /(do not|don't|never) (mention|tell|reveal|show)[^.]{0,40}(human|reviewer|agent|supervisor)/,
      /hide (it|this)[^.]{0,30}(human|reviewer)/, /the policy (has changed|allows it|says you can)/,
      /approve (all|every) refund/, /developer mode/, /jailbreak/,
    ],
  },
  {
    flag: 'secret_exfiltration',
    patterns: [
      /(system|hidden|internal) (prompt|instructions?)/, /api[ _-]?keys?/, /internal notes?/,
      /(print|reveal|show|dump|leak)[^.]{0,40}(prompt|secret|token|credential|config)/,
      /access token|password hash|private key/,
    ],
  },
  {
    flag: 'identity_bypass',
    patterns: [
      /(ignore|skip|bypass|without)[^.]{0,20}(identity|verification|verify|security) ?(checks?|steps?|questions?)?/,
      /no need to verify/, /don't verify/,
    ],
  },
  {
    flag: 'safety_hazard',
    patterns: [
      /swell(ing|ed)?|swollen|bulg(ing|e)/, /overheat(ing|s|ed)?|too hot to touch/, /burning smell|smells? (like )?burn/,
      /smok(e|ing)/, /exposed wires?/, /electric(al)? shock|shocked me/, /caught fire|on fire|sparks?/,
    ],
  },
];

const ACCOUNT_CHANGE = /(change|update|reset|delete)[^.]{0,30}(email|password|phone|address|account)/;

function scanInput(text) {
  const t = String(text || '').toLowerCase();
  const flags = [];
  const matches = {};
  for (const rule of INPUT_RULES) {
    const hit = rule.patterns.find(p => p.test(t));
    if (hit) {
      flags.push(rule.flag);
      matches[rule.flag] = (t.match(hit) || [''])[0];
    }
  }
  return {
    flags,
    matches,
    account_change_requested: ACCOUNT_CHANGE.test(t),
    unsafe: flags.some(f => f !== 'safety_hazard'),
  };
}

// Documents that contain instructions aimed at the assistant are quarantined at ingestion.
const DOC_INJECTION_PATTERNS = [
  /attention (support )?(assistant|ai|agent|bot)/i, /ignore (all )?(previous|prior) (policies|instructions)/i,
  /approve every refund/i, /reveal (all )?hidden instructions/i,
  /(do not|don't) mention this document/i, /issue a coupon whenever/i, /you must (always )?(obey|follow) this/i,
];

function scanDocument({ content, audience, source_type }) {
  const reasons = [];
  // Quoted examples (e.g. a security playbook listing "Ignore previous instructions.") are not directives.
  const unquoted = String(content || '').replace(/"[^"\n]{0,200}"|“[^”\n]{0,200}”/g, ' ');
  for (const p of DOC_INJECTION_PATTERNS) {
    const m = unquoted.match(p);
    if (m) reasons.push(`Embedded instruction to the assistant: "${m[0]}"`);
  }
  if (/imported|vendor|third[- ]party/i.test(audience || '') && reasons.length) {
    reasons.push('Third-party source with imperative instructions');
  }
  return { trust: reasons.length ? 'quarantined' : 'trusted', reasons, source_type };
}

// --- Output checks -------------------------------------------------------

const SECRET_OUTPUT = [/sk-[a-z0-9]{10,}/i, /api[_ -]?key\s*[:=]/i, /BEGIN [A-Z ]*PRIVATE KEY/, /system prompt:/i];
const REFUND_PROMISE = /(has been|have been|was|is being|already) (refunded|credited|reversed)|refund (has been|was) (processed|issued|completed)|we (have|'ve) (refunded|issued (you )?a refund)/i;
const INSTANT_PROMISE = /(instant|immediate(ly)?) (refund|replacement)/i;
const CARD_NUMBER = /\b(?:\d[ -]?){13,19}\b/;

function checkOutput(reply, { allowedDocIds, customerEmail, otherEmails = [] }) {
  const issues = [];
  let text = String(reply || '');

  const cited = [...text.matchAll(/\[(KB-[A-Z0-9-]+)\]/g)].map(m => m[1]);
  const invalid = [...new Set(cited.filter(id => !allowedDocIds.includes(id)))];
  for (const id of invalid) {
    issues.push({ type: 'invalid_citation', detail: `${id} was not in the trusted retrieved set; removed.` });
    text = text.split(`[${id}]`).join('');
  }
  if (SECRET_OUTPUT.some(p => p.test(text))) {
    issues.push({ type: 'secret_leak', detail: 'Reply looked like it contained secrets; blocked.' });
    text = 'I am not able to share internal configuration or credentials. A support specialist will follow up with you.';
  }
  if (REFUND_PROMISE.test(text)) {
    issues.push({ type: 'unsupported_promise', detail: 'Reply promised a completed refund; policy forbids that.' });
    text = text.replace(REFUND_PROMISE, 'will be reviewed by our team');
  }
  if (INSTANT_PROMISE.test(text)) {
    issues.push({ type: 'unsupported_promise', detail: 'Reply promised an instant refund/replacement.' });
    text = text.replace(INSTANT_PROMISE, 'a reviewed resolution');
  }
  if (CARD_NUMBER.test(text)) {
    issues.push({ type: 'pii', detail: 'Card-like number redacted.' });
    text = text.replace(CARD_NUMBER, '[redacted]');
  }
  for (const email of otherEmails) {
    if (email && email !== customerEmail && text.includes(email)) {
      issues.push({ type: 'pii', detail: 'Another customer\'s email address was redacted.' });
      text = text.split(email).join('[redacted]');
    }
  }
  const finalCitations = [...new Set([...text.matchAll(/\[(KB-[A-Z0-9-]+)\]/g)].map(m => m[1]))];
  return { reply: text.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,])/g, '$1').trim(), issues, citations: finalCitations };
}

// --- Action policy -------------------------------------------------------

// Decides whether a tool may be proposed for this ticket. The model can suggest; this decides.
function checkAction(tool, { category, flags = [], parameters = {} }) {
  if (!tool) return { allowed: false, reason: 'Unknown tool' };
  const unsafe = flags.filter(f => ['prompt_injection', 'secret_exfiltration', 'identity_bypass'].includes(f));
  if (tool.tool_name !== 'escalate_to_human' && unsafe.length) {
    return { allowed: false, reason: `Blocked: ticket contains ${unsafe.join(', ')}; only escalation is permitted.` };
  }
  if (tool.tool_name !== 'escalate_to_human' && flags.includes('safety_hazard')) {
    return { allowed: false, reason: 'Blocked: safety issues must be escalated to a specialist before any replacement or coupon.' };
  }
  if (category && !tool.allowed_categories.includes(category)) {
    return { allowed: false, reason: `Blocked: ${tool.tool_name} is not allowed for category "${category}".` };
  }
  if (tool.config && tool.config.max_amount_inr && Number(parameters.amount) > tool.config.max_amount_inr) {
    return { allowed: false, reason: `Blocked: amount exceeds the ${tool.config.max_amount_inr} INR limit; needs manager-created exception.` };
  }
  return { allowed: true };
}

function redactForLog(text) {
  return String(text || '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(CARD_NUMBER, '[number]');
}

module.exports = { scanInput, scanDocument, checkOutput, checkAction, redactForLog };
