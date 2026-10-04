// Usage: npm run eval            (uses LLM_PROVIDER / GEMINI_API_KEY if set, else the mock)
//        npm run eval -- --mock  (forces the deterministic mock)
// Writes reports/EVAL_REPORT.md and reports/eval_results.json.

require('../src/lib/env').loadEnv();
process.env.TRUSTDESK_DB = ':memory:';
const fs = require('fs');
const path = require('path');
const { db } = require('../src/db');

(async () => {
  await db.init();
  const { runEvals, toMarkdown } = require('../src/services/evals');
  const provider = process.argv.includes('--mock') ? 'mock' : undefined;
  const out = await runEvals({ provider });
  const dir = path.resolve(__dirname, '../../reports');
  fs.mkdirSync(dir, { recursive: true });
  const suffix = out.provider === 'mock' ? '' : `_${out.provider}`;
  fs.writeFileSync(path.join(dir, `EVAL_REPORT${suffix}.md`), toMarkdown(out));
  fs.writeFileSync(path.join(dir, `eval_results${suffix}.json`), JSON.stringify(out, null, 2));
  const m = out.metrics;
  console.log(`\nTrustDesk eval — provider: ${out.provider}`);
  for (const c of out.cases) {
    const failed = Object.entries(c.checks).filter(([, v]) => !v).map(([k]) => k);
    console.log(`  ${c.passed ? '✓' : '✗'} ${c.case_id} ${c.ticket_id}  ${c.predicted_category}/${c.predicted_priority} esc=${c.predicted_escalation} cites=${c.citations.join(',')} actions=${c.recommended_actions.join(',') || '-'}${failed.length ? '  FAILED: ' + failed.join(',') : ''}${c.fallback_reason ? '  (fallback: ' + c.fallback_reason + ')' : ''}`);
  }
  console.log(`\nPassed ${m.passed_cases}/${m.total_cases} · category ${m.category_accuracy} · priority ${m.priority_accuracy} · escalation ${m.escalation_accuracy} · citations ${m.citation_coverage} · unsafe-block ${m.unsafe_action_block_rate} · action-recall ${m.allowed_action_recall} · requirements ${m.answer_requirement_coverage}`);
  console.log(`Report written to reports/EVAL_REPORT${suffix}.md\n`);
})().catch(e => { console.error(e); process.exit(1); });
