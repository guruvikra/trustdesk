import React, { useEffect, useState } from 'react';
import { FlaskConical, Play, ShieldCheck, ShieldAlert } from 'lucide-react';
import { api, poll } from '../api';
import { Badge, Button, Card, Empty, Modal, Spinner, fmtTime, pct, useToast, CitedText } from '../components/ui';

const METRICS = [
  ['category_accuracy', 'Category accuracy'], ['priority_accuracy', 'Priority accuracy'], ['escalation_accuracy', 'Escalation accuracy'],
  ['citation_coverage', 'Citation coverage'], ['unsafe_action_block_rate', 'Unsafe action block rate'], ['allowed_action_recall', 'Allowed action recall'],
  ['answer_requirement_coverage', 'Answer requirements'],
];

const Check = ({ ok }) => <span className={ok ? 'fact-ok' : 'fact-no'}>{ok ? '✓' : '✗'}</span>;

export default function Evals() {
  const toast = useToast();
  const [runs, setRuns] = useState([]);
  const [run, setRun] = useState(null);
  const [busy, setBusy] = useState('');
  const [ws, setWs] = useState(null);
  const [detail, setDetail] = useState(null);

  const load = async (selectId) => {
    const list = await api('/api/eval-runs');
    setRuns(list);
    const id = selectId || (list.find(r => r.status === 'completed') || {}).eval_run_id;
    if (id) setRun(await api(`/api/eval-runs/${id}`));
  };
  useEffect(() => { load(); api('/api/workspace').then(setWs); }, []);

  const start = async (provider) => {
    setBusy(provider || 'default');
    try {
      const { eval_run_id } = await api('/api/eval-runs', { method: 'POST', body: provider ? { provider } : {} });
      toast(`Eval run ${eval_run_id} started in the background`);
      const done = await poll(() => api(`/api/eval-runs/${eval_run_id}`), r => r.status !== 'running', { interval: 800, timeout: 300000 });
      if (done.status === 'failed') toast(done.error, 'error');
      await load(eval_run_id);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(''); }
  };

  const m = run && run.metrics;
  const hosted = ws && ws.llm.provider !== 'mock';
  return (
    <div className="stack">
      <div className="card card-b">
        <div className="row wrap">
          <div style={{ flex: 1 }}>
            <div className="bold">data/eval_cases.jsonl — 8 cases including 3 adversarial</div>
            <div className="small muted">Runs on an isolated copy of the provided policy pack and tickets, so results are reproducible even after you switch to real data. Expected labels are only used to score outputs, never as inputs.</div>
          </div>
          <Button icon={Play} busy={busy === 'mock'} onClick={() => start('mock')}>Run with offline engine</Button>
          {hosted && <Button icon={Play} variant="primary" busy={busy === 'default'} onClick={() => start()}>Run with {ws.llm.model}</Button>}
        </div>
      </div>

      {!run ? <Card><Empty icon={FlaskConical} title="No eval runs yet">Run the suite to produce the report.</Empty></Card> : run.status === 'running' ? <Card><Spinner /> Running…</Card> : (
        <>
          <div className="grid g4">
            <div className="card stat"><div className="label">Cases passed</div><div className="value">{m.passed_cases}/{m.total_cases}</div><div className="hint">{run.provider} · {fmtTime(run.finished_at)}</div></div>
            {METRICS.slice(0, 3).map(([k, l]) => <div key={k} className="card stat"><div className="label">{l}</div><div className="value">{pct(m[k])}</div></div>)}
          </div>
          <div className="grid g4">
            {METRICS.slice(3).map(([k, l]) => <div key={k} className="card stat"><div className="label">{l}</div><div className="value">{pct(m[k])}</div></div>)}
          </div>
          <Card title="Adversarial cases" icon={ShieldCheck}>
            <div className="grid g3">
              {m.adversarial_safe.map(a => {
                const c = run.cases.find(x => x.case_id === a.case_id);
                return (
                  <div key={a.case_id} className={`callout ${a.safe ? 'green' : 'red'}`} style={{ flexDirection: 'column' }}>
                    <div className="row bold">{a.safe ? <ShieldCheck size={15} /> : <ShieldAlert size={15} />} {a.case_id} · {c.ticket_id} — {a.safe ? 'SAFE' : 'UNSAFE'}</div>
                    <div className="small">{c.input}</div>
                    <div className="tiny">Flags: {c.guardrail_flags.join(', ')} · Actions: {c.recommended_actions.join(', ')} {c.blocked_actions.length ? `· Blocked: ${c.blocked_actions.join(', ')}` : ''}</div>
                  </div>
                );
              })}
            </div>
          </Card>
          <Card title="Per-case results" bodyClass="">
            <table className="table">
              <thead><tr><th>Case</th><th>Input</th><th>Category</th><th>Priority</th><th>Escalate</th><th>Citations</th><th>Safe actions</th><th>Reqs</th><th>Result</th></tr></thead>
              <tbody>
                {run.cases.map(c => (
                  <tr key={c.case_id} className="click" onClick={() => setDetail(c)}>
                    <td className="mono small">{c.case_id}<div className="tiny faint">{c.ticket_id}</div></td>
                    <td className="small" style={{ maxWidth: 260 }}>{c.input}</td>
                    <td className="small"><Check ok={c.checks.category} /> {c.predicted_category}{!c.checks.category && <div className="tiny faint">exp {c.expected_category}</div>}</td>
                    <td className="small"><Check ok={c.checks.priority} /> {c.predicted_priority}{!c.checks.priority && <div className="tiny faint">exp {c.expected_priority}</div>}</td>
                    <td className="small"><Check ok={c.checks.escalation} /> {String(c.predicted_escalation)}</td>
                    <td className="small"><Check ok={c.checks.citations} /> <span className="mono tiny">{c.citations.join(', ')}</span></td>
                    <td className="small"><Check ok={c.checks.unsafe_actions_avoided && c.checks.allowed_action_recall} /> <span className="mono tiny">{c.recommended_actions.join(', ') || '—'}</span></td>
                    <td className="small">{c.requirements.filter(r => r.passed).length}/{c.requirements.length}</td>
                    <td>{c.passed ? <Badge tone="green">pass</Badge> : <Badge tone="red">fail</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          {runs.length > 1 && (
            <Card title="History" bodyClass="">
              <table className="table"><tbody>{runs.map(r => (
                <tr key={r.eval_run_id} className="click" onClick={() => load(r.eval_run_id)}>
                  <td className="mono small">{r.eval_run_id}</td><td><Badge>{r.status}</Badge></td><td className="small">{r.provider}</td>
                  <td className="small">{r.metrics ? `${r.metrics.passed_cases}/${r.metrics.total_cases} passed` : '—'}</td><td className="small muted">{fmtTime(r.created_at)}</td>
                </tr>))}</tbody></table>
            </Card>
          )}
        </>
      )}
      {detail && (
        <Modal title={`${detail.case_id} · ${detail.ticket_id}`} onClose={() => setDetail(null)}>
          <div className="stack">
            <div className="small muted">{detail.input}</div>
            <div className="msg agent"><CitedText text={detail.reply} /></div>
            <div className="small bold">Answer requirements</div>
            {detail.requirements.map(r => <div key={r.requirement} className="small"><Check ok={r.passed !== false} /> {r.requirement} <span className="faint tiny">({r.method})</span></div>)}
            <div className="small"><b>Blocked actions:</b> {detail.blocked_actions.join(', ') || 'none'} · <b>Disallowed:</b> {(detail.disallowed_actions || []).join(', ') || 'none'}</div>
            <div className="small"><b>Quarantined docs ignored:</b> {detail.quarantined_doc_ids.join(', ') || 'none'}</div>
            {detail.fallback_reason && <div className="callout amber small">Model fallback: {detail.fallback_reason}</div>}
          </div>
        </Modal>
      )}
    </div>
  );
}
