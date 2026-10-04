// Model adapter. Every caller goes through here, so tests can force the mock and the hosted
// provider can be swapped by configuration. If the hosted call fails, we fall back to the mock
// and record that in the trace instead of failing the request.

const mock = require('./mock');
const gemini = require('./gemini');
const { PROMPT_VERSION, triagePrompt, draftPrompt, answerPrompt } = require('./prompts');

const ENUMS = {
  category: ['shipping', 'refund', 'warranty', 'billing', 'account_security', 'general'],
  priority: ['low', 'medium', 'high', 'urgent'],
  sentiment: ['positive', 'neutral', 'frustrated', 'angry'],
};

function config() {
  const requested = (process.env.LLM_PROVIDER || '').toLowerCase();
  const hasGemini = Boolean(process.env.GEMINI_API_KEY);
  const provider = requested === 'mock' ? 'mock' : (requested === 'gemini' || (!requested && hasGemini)) && hasGemini ? 'gemini' : 'mock';
  return { provider, model: provider === 'gemini' ? process.env.GEMINI_MODEL || 'gemini-3.8-flash' : mock.model, prompt_version: PROMPT_VERSION };
}

function resolve(override) {
  const base = config();
  if (override === 'mock') return { ...base, provider: 'mock', model: mock.model };
  return base;
}

async function callHosted(cfg, prompt) {
  const started = Date.now();
  const { json, usage } = await gemini.generateJson({ ...prompt, model: cfg.model, apiKey: process.env.GEMINI_API_KEY });
  return { json, meta: { provider: cfg.provider, model: cfg.model, latency_ms: Date.now() - started, ...usage } };
}

function mockMeta(started, fallbackReason) {
  return { provider: 'mock', model: mock.model, latency_ms: Date.now() - started, fallback_reason: fallbackReason || undefined };
}

async function triage(input, { provider } = {}) {
  const cfg = resolve(provider);
  const started = Date.now();
  if (cfg.provider !== 'mock') {
    try {
      const { json, meta } = await callHosted(cfg, triagePrompt(input));
      const out = {
        category: ENUMS.category.includes(json.category) ? json.category : 'general',
        priority: ENUMS.priority.includes(json.priority) ? json.priority : 'medium',
        sentiment: ENUMS.sentiment.includes(json.sentiment) ? json.sentiment : 'neutral',
        should_escalate: Boolean(json.should_escalate),
        rationale: String(json.rationale || '').slice(0, 400),
        certainty: Number.isFinite(Number(json.confidence)) ? Math.max(0, Math.min(1, Number(json.confidence))) : 0.7,
      };
      return { output: out, meta };
    } catch (e) {
      return { output: mock.triage(input), meta: mockMeta(started, e.message) };
    }
  }
  return { output: mock.triage(input), meta: mockMeta(started) };
}

async function draft(input, { provider } = {}) {
  const cfg = resolve(provider);
  const started = Date.now();
  if (cfg.provider !== 'mock') {
    try {
      const { json, meta } = await callHosted(cfg, draftPrompt(input));
      if (!json.reply) throw new Error('Model returned an empty reply');
      return { output: { reply: String(json.reply), internal_note: String(json.internal_note || ''), suggested_action: json.suggested_action || null }, meta };
    } catch (e) {
      return { output: mock.draft(input), meta: mockMeta(started, e.message) };
    }
  }
  return { output: mock.draft(input), meta: mockMeta(started) };
}

async function answer(input, { provider } = {}) {
  const cfg = resolve(provider);
  const started = Date.now();
  if (cfg.provider !== 'mock') {
    try {
      const { json, meta } = await callHosted(cfg, answerPrompt(input));
      return {
        output: {
          answer: String(json.answer || ''),
          used_sources: (json.used_sources || []).map(Number).filter(n => n >= 1 && n <= input.sources.length),
          answerable: json.answerable !== false,
        },
        meta,
      };
    } catch (e) {
      return { output: mock.answer(input), meta: mockMeta(started, e.message) };
    }
  }
  return { output: mock.answer(input), meta: mockMeta(started) };
}

module.exports = { triage, draft, answer, config, PROMPT_VERSION };
