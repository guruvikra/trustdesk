// Internal Assistant (team Q&A over the knowledge base) and the public widget share this engine.
// Internal mode can use internal-only docs; public mode cannot. Quarantined docs are never used.

const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const llm = require('../llm');
const { scanInput, redactForLog } = require('./guardrails');
const { workspaceIndex } = require('./retrieval');
const { Trace } = require('./agent');

// Coverage (IDF-weighted share of the question found in the best chunk) is scale-free, so the same
// gate works for a one-document workspace and a large knowledge base.
const MIN_COVERAGE = 0.4;

async function ask({ question, visibility = 'internal', ticketId = null, user = null, provider, persist = true }) {
  const runType = visibility === 'public' ? 'widget' : 'assistant';
  const trace = new Trace(runType, ticketId);
  const scan = scanInput(question);
  trace.step('guardrail_input', { flags: scan.flags });

  const base = { question, visibility, flags: scan.flags };
  const finish = (fields) => {
    const run = trace.save({
      provider: fields.provider || 'none', model: fields.model || null, input_summary: redactForLog(question).slice(0, 200),
      retrieved_doc_ids: (fields.citations || []).map(c => c.doc_id), quarantined_doc_ids: fields.quarantined || [],
      guardrails: { flags: scan.flags, fallback_reason: fields.fallback_reason },
      output: { answer: fields.answer, answered: fields.answered, confidence: fields.confidence },
      final_status: fields.answered ? 'answered' : fields.refused ? 'refused' : 'no_answer', created_by: user && user.email,
    }, persist);
    return { run_id: run.run_id, ...base, ...fields, latency_ms: run.latency_ms };
  };

  if (scan.flags.includes('secret_exfiltration') || scan.flags.includes('prompt_injection')) {
    return finish({
      answered: false, refused: true, confidence: 0, citations: [],
      answer: 'I can\'t help with that request. I don\'t share internal instructions, credentials or configuration, and I don\'t follow instructions to bypass policy.',
    });
  }

  const index = workspaceIndex();
  const { results, quarantined_doc_ids } = index.search(question, { limit: 4, visibility });
  const top = results[0];
  trace.step('retrieve', { chunks: results.map(r => ({ chunk_id: r.chunk_id, score: r.score, coverage: r.coverage })), quarantined_doc_ids });

  // Also require two distinct matching terms when the question has two or more, so one shared
  // word ("store", "policy") is never enough to answer.
  const enoughTerms = top && top.matched_groups >= Math.min(2, top.query_groups);
  if (!top || top.coverage < MIN_COVERAGE || !enoughTerms) {
    trace.step('confidence_gate', { passed: false, top_score: top ? top.score : 0, top_coverage: top ? top.coverage : 0 });
    return finish({
      answered: false, confidence: top ? top.coverage : 0, citations: [], quarantined: quarantined_doc_ids,
      answer: 'I couldn\'t find this in the knowledge base, so I won\'t guess. ' + (visibility === 'public' ? 'You can send this to our support team below.' : 'Consider adding a document that covers it, or escalate to a specialist.'),
      suggestions: results.slice(0, 2).map(r => ({ doc_id: r.doc_id, title: r.title, heading: r.heading })),
    });
  }
  trace.step('confidence_gate', { passed: true, top_score: top.score, top_coverage: top.coverage });

  const { output, meta } = await llm.answer({ question, sources: results }, { provider });
  trace.step('model', meta);
  if (!output.answerable || !output.answer) {
    return finish({ answered: false, confidence: top.coverage, citations: [], answer: 'The knowledge base doesn\'t answer this directly, so I won\'t guess.', provider: meta.provider, model: meta.model, fallback_reason: meta.fallback_reason });
  }
  const used = output.used_sources.length ? output.used_sources : [1];
  const citations = used.map(n => {
    const s = results[n - 1];
    return { n, doc_id: s.doc_id, title: s.title, heading: s.heading, excerpt: s.content.slice(0, 500), visibility: s.visibility };
  });
  return finish({
    answered: true, answer: output.answer, citations, confidence: +Math.min(1, top.coverage).toFixed(2), quarantined: quarantined_doc_ids,
    retrieved: results.map((r, i) => ({ n: i + 1, doc_id: r.doc_id, title: r.title, heading: r.heading, excerpt: r.content.slice(0, 500), score: r.score, coverage: r.coverage, visibility: r.visibility, cited: used.includes(i + 1) })),
    provider: meta.provider, model: meta.model, fallback_reason: meta.fallback_reason,
  });
}

function feedback(runId, rating) {
  if (!['up', 'down'].includes(rating)) throw Object.assign(new Error('rating must be "up" or "down"'), { status: 400 });
  if (!db.get('SELECT run_id FROM agent_runs WHERE run_id = ?', [runId])) throw Object.assign(new Error('Answer not found'), { status: 404 });
  db.run('UPDATE agent_runs SET feedback = ? WHERE run_id = ?', [rating, runId]);
  return { run_id: runId, feedback: rating };
}

// --- Public widget deflection ----------------------------------------------

async function deflect(question) {
  const res = await ask({ question, visibility: 'public' });
  const eventId = `dfl_${uuidv4().slice(0, 8)}`;
  db.run('INSERT INTO deflection_events (event_id, question, answered, confidence, citations_json, outcome, created_at) VALUES (?,?,?,?,?,?,?)',
    [eventId, question.slice(0, 1000), res.answered ? 1 : 0, res.confidence, JSON.stringify(res.citations.map(c => c.doc_id)), 'pending', new Date().toISOString()]);
  return { event_id: eventId, answered: res.answered, answer: res.answer, citations: res.citations.map(c => ({ n: c.n, doc_id: c.doc_id, title: c.title, heading: c.heading })), confidence: res.confidence };
}

module.exports = { ask, feedback, deflect };
