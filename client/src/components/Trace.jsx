import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { Badge, Json, Spinner, fmtTime } from './ui';

const STEP_LABELS = {
  guardrail_input: 'Input guardrails',
  retrieve: 'Knowledge retrieval',
  confidence_gate: 'Confidence gate',
  model: 'Model call',
  policy_rules: 'Hard policy rules',
  action_policy: 'Action policy',
  guardrail_output: 'Output guardrails',
  model_suggestion_ignored: 'Model suggestion ignored',
  policy_coverage: 'Policy coverage',
  confidence: 'Answer confidence',
};

function stepSummary(s) {
  switch (s.step) {
    case 'guardrail_input': return s.flags && s.flags.length ? `Flags: ${s.flags.join(', ')}` : 'No unsafe patterns detected';
    case 'retrieve': return `Docs: ${(s.doc_ids || (s.chunks || []).map(c => c.chunk_id)).join(', ') || 'none'}${s.quarantined_doc_ids && s.quarantined_doc_ids.length ? ` · quarantined (ignored): ${s.quarantined_doc_ids.join(', ')}` : ''}`;
    case 'confidence_gate': return s.passed ? `Passed (coverage ${s.top_coverage}, score ${s.top_score})` : `Not confident enough (coverage ${s.top_coverage}) — no answer given`;
    case 'model': return `${s.provider} · ${s.model} · ${s.latency_ms}ms${s.input_tokens ? ` · ${s.input_tokens}+${s.output_tokens} tokens` : ''}${s.fallback_reason ? ` · FELL BACK: ${s.fallback_reason}` : ''}`;
    case 'policy_rules': return s.applied && s.applied.length ? s.applied.join('; ') : 'Model output accepted unchanged';
    case 'action_policy': return `Planned: ${(s.planned || []).join(', ') || 'none'}${s.blocked && s.blocked.length ? ` · Blocked: ${s.blocked.map(b => b.tool_name).join(', ')}` : ''}`;
    case 'guardrail_output': return s.issues && s.issues.length ? s.issues.map(i => i.type).join(', ') : `Clean · citations ${(s.citations || []).join(', ')}`;
    case 'model_suggestion_ignored': return `${s.suggested_action}: ${s.reason}`;
    case 'policy_coverage': return s.detail;
    case 'confidence': return `${Math.round(s.confidence * 100)}% = policy ${s.components.policy} + retrieval ${s.components.retrieval} + classification ${s.components.classification} + grounding ${s.components.grounding} (governing ${s.components.governing_doc || 'none'}, covers ${Math.round((s.components.governing_coverage || 0) * 100)}% of the ticket)`;
    default: return '';
  }
}

const tone = s => (s.step === 'guardrail_input' && s.flags && s.flags.length) || (s.step === 'model' && s.fallback_reason) || (s.step === 'confidence_gate' && !s.passed) ? 'warn'
  : s.step === 'policy_coverage' ? 'warn' : (s.step === 'guardrail_output' && s.issues && s.issues.length) || (s.step === 'action_policy' && s.blocked && s.blocked.length) ? 'bad' : '';

export function TraceView({ runId }) {
  const [run, setRun] = useState(null);
  const [raw, setRaw] = useState(false);
  useEffect(() => { setRun(null); if (runId) api(`/api/agent-runs/${runId}`).then(setRun).catch(() => setRun(false)); }, [runId]);
  if (!runId) return null;
  if (run === null) return <Spinner />;
  if (!run) return <div className="muted">Trace not found.</div>;
  return (
    <div>
      <div className="row wrap mb">
        <span className="mono bold">{run.run_id}</span>
        <Badge tone="indigo">{run.run_type}</Badge>
        <Badge>{run.final_status}</Badge>
        <span className="small muted">{run.provider} · {run.latency_ms}ms · prompt {run.prompt_version} · {fmtTime(run.created_at)}</span>
      </div>
      <div className="kv mb">
        <span className="k">Ticket</span><span className="mono">{run.ticket_id || '—'}</span>
        <span className="k">Retrieved docs</span><span className="mono">{run.retrieved_doc_ids.join(', ') || '—'}</span>
        <span className="k">Quarantined</span><span className="mono">{run.quarantined_doc_ids.join(', ') || '—'}</span>
        <span className="k">Recommended</span><span className="mono">{run.recommended_actions.join(', ') || '—'}</span>
        <span className="k">Blocked</span><span className="mono">{run.blocked_actions.map(b => b.tool_name).join(', ') || '—'}</span>
        <span className="k">Guardrail flags</span><span className="mono">{(run.guardrails.flags || []).join(', ') || 'none'}</span>
      </div>
      {run.steps.map((s, i) => (
        <div className="trace-step" key={i}>
          <div className={`trace-dot ${tone(s)}`} />
          <div>
            <div className="row"><span className="bold small">{STEP_LABELS[s.step] || s.step}</span><span className="tiny faint">+{s.at_ms}ms</span></div>
            <div className="small muted">{stepSummary(s)}</div>
          </div>
        </div>
      ))}
      <button className="btn sm ghost" onClick={() => setRaw(!raw)}>{raw ? 'Hide' : 'Show'} raw trace JSON</button>
      {raw && <Json value={run} />}
    </div>
  );
}
