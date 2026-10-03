const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const { triageTicket, generateCitedDraft } = require('./agent');
const { v4: uuidv4 } = require('uuid');

const EVAL_CASES_PATH = path.resolve(__dirname, '../../../data/eval_cases.jsonl');

async function runEvaluationBenchmark() {
  if (!fs.existsSync(EVAL_CASES_PATH)) {
    throw new Error(`Eval cases file not found at ${EVAL_CASES_PATH}`);
  }

  const rawLines = fs.readFileSync(EVAL_CASES_PATH, 'utf8').trim().split('\n').filter(Boolean);
  const results = [];
  let passedCount = 0;

  for (const line of rawLines) {
    const testCase = JSON.parse(line);
    const mockTicket = {
      ticket_id: testCase.case_id || testCase.ticket_id || `eval_${results.length + 1}`,
      subject: testCase.subject || testCase.inquiry || 'Inquiry',
      body: testCase.body || testCase.inquiry || '',
      created_at: testCase.created_at || '2026-06-28T10:15:00+05:30',
      expected_category: testCase.expected_category,
      expected_priority: testCase.expected_priority,
      expected_sentiment: testCase.expected_sentiment,
      expected_escalation: testCase.expected_escalation
    };

    const triage = triageTicket(mockTicket, null, null);
    const draft = generateCitedDraft(mockTicket, null, null);

    let passed = true;
    const failures = [];

    // Check category if specified
    if (testCase.expected_category && triage.category !== testCase.expected_category) {
      passed = false;
      failures.push(`Category mismatch: got ${triage.category}, expected ${testCase.expected_category}`);
    }

    // Check escalation if specified
    if (testCase.expected_escalation !== undefined) {
      const expEsc = Boolean(testCase.expected_escalation);
      if (triage.escalation !== expEsc) {
        passed = false;
        failures.push(`Escalation mismatch: got ${triage.escalation}, expected ${expEsc}`);
      }
    }

    // Check citations if specified
    if (testCase.expected_citations && testCase.expected_citations.length > 0) {
      const hasCitation = testCase.expected_citations.some(c => draft.citations.includes(c));
      if (!hasCitation) {
        passed = false;
        failures.push(`Citations mismatch: missing expected citation from ${testCase.expected_citations.join(', ')}`);
      }
    }

    // Check adversarial safety
    if (testCase.is_adversarial) {
      if (testCase.expected_action_blocked && draft.guardrail_results && !draft.guardrail_results.prompt_injection_detected && !draft.guardrail_results.secret_leak_prevented) {
        passed = false;
        failures.push('Adversarial attack was not caught by guardrails');
      }
    }

    if (passed) passedCount++;

    results.push({
      case_id: testCase.case_id,
      name: testCase.name || testCase.case_id,
      passed,
      triage,
      draft_reply: draft.draft_reply,
      citations: draft.citations,
      guardrails: draft.guardrail_results,
      failures
    });
  }

  const accuracy = passedCount / results.length;
  const evalRunId = `eval_${uuidv4().replace(/-/g, '').substring(0, 8)}`;
  const now = new Date().toISOString();

  const summary = {
    eval_run_id: evalRunId,
    run_at: now,
    dataset_size: results.length,
    passed_cases: passedCount,
    failed_cases: results.length - passedCount,
    accuracy: Math.round(accuracy * 100) / 100,
    accuracy_percentage: `${Math.round(accuracy * 100)}%`
  };

  db.run(
    `INSERT INTO eval_runs (eval_run_id, run_at, dataset_size, passed_cases, failed_cases, accuracy, summary_json, details_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      evalRunId,
      now,
      results.length,
      passedCount,
      results.length - passedCount,
      accuracy,
      JSON.stringify(summary),
      JSON.stringify(results)
    ]
  );

  return {
    ...summary,
    cases: results
  };
}

module.exports = {
  runEvaluationBenchmark
};
