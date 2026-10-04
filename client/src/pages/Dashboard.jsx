import React, { useEffect, useMemo, useState } from 'react';
import {
  MessageCircleQuestion, CheckCircle2, Inbox, Gavel, MessageSquare, Send, HelpCircle, TrendingUp, ShieldAlert, BookOpen, ThumbsUp, ThumbsDown,
} from 'lucide-react';
import { api } from '../api';
import { Badge, Card, Empty, Spinner, fmtTime, pct } from '../components/ui';
import Onboarding from '../components/Onboarding';
import { go } from '../App';

const SERIES = [
  { key: 'assistant', label: 'Internal assistant', color: 'var(--series-1)' },
  { key: 'widget', label: 'Customer widget', color: 'var(--series-2)' },
];

function Kpi({ icon: Icon, label, value, hint, onClick, tone }) {
  return (
    <div className="card stat kpi" onClick={onClick} style={{ cursor: onClick ? 'pointer' : undefined }}>
      <div className="row label"><Icon size={14} />{label}</div>
      <div className="value" style={tone ? { color: `var(--${tone})` } : undefined}>{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

// Stacked daily bars with a per-day hover tooltip (assistant + widget questions).
function QuestionsChart({ data }) {
  const [hover, setHover] = useState(null);
  const max = Math.max(1, ...data.map(d => d.assistant + d.widget));
  const ticks = [max, Math.round(max / 2), 0].filter((v, i, a) => a.indexOf(v) === i);
  const label = d => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const every = Math.ceil(data.length / 7);
  return (
    <div className="qchart">
      <div className="legend">
        {SERIES.map(s => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}
      </div>
      <div className="plot">
        <div className="yaxis">{ticks.map(t => <span key={t} style={{ bottom: `${(t / max) * 100}%` }}>{t}</span>)}</div>
        <div className="grid-lines">{ticks.map(t => <i key={t} style={{ bottom: `${(t / max) * 100}%` }} />)}</div>
        <div className="bars">
          {data.map((d, i) => {
            const total = d.assistant + d.widget;
            return (
              <div key={d.date} className="col" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <div className="stack" style={{ height: `${(total / max) * 100}%` }}>
                  {SERIES.map(s => d[s.key] > 0 && <div key={s.key} className="seg" style={{ flexGrow: d[s.key], background: s.color }} />)}
                </div>
                {hover === i && (
                  <div className={`tip ${i > data.length * 0.7 ? 'left' : ''}`}>
                    <div className="bold">{label(d.date)}</div>
                    {SERIES.map(s => <div key={s.key} className="row"><i style={{ background: s.color }} />{s.label}<span className="spacer" /><b>{d[s.key]}</b></div>)}
                    <div className="row muted"><i style={{ background: 'transparent' }} />Not answered<span className="spacer" /><b>{d.unanswered}</b></div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="xaxis">{data.map((d, i) => <span key={d.date}>{i % every === 0 || i === data.length - 1 ? label(d.date) : ''}</span>)}</div>
    </div>
  );
}

function Funnel({ steps }) {
  const max = Math.max(1, steps[0].value);
  return (
    <div className="stack" style={{ gap: 10 }}>
      {steps.map(s => (
        <div key={s.label}>
          <div className="row small"><span>{s.label}</span><span className="spacer" /><b>{s.value}</b>{s.rate !== undefined && <span className="muted tiny" style={{ width: 44, textAlign: 'right' }}>{pct(s.rate)}</span>}</div>
          <div className="bar" style={{ height: 10, marginTop: 4 }}><span style={{ width: `${(s.value / max) * 100}%`, background: 'var(--series-1)' }} /></div>
        </div>
      ))}
    </div>
  );
}

const STATUS_BADGE = { answered: ['answered', 'green'], no_answer: ['not in KB', 'amber'], refused: ['refused', 'red'] };

export default function Dashboard({ user }) {
  const [days, setDays] = useState(14);
  const [a, setA] = useState(null);
  const [stats, setStats] = useState(null);
  const [filter, setFilter] = useState('all');
  const load = () => {
    api(`/api/analytics?days=${days}`).then(setA);
    api('/api/stats').then(setStats);
  };
  useEffect(() => { load(); }, [days]);

  const questions = useMemo(() => (a ? a.recent_questions.filter(q => filter === 'all' || (filter === 'unanswered' ? q.status !== 'answered' : q.source === filter)) : []), [a, filter]);
  if (!a || !stats) return <Spinner />;
  const t = a.totals;

  return (
    <div className="stack">
      <Onboarding stats={stats} user={user} onChanged={load} />

      <div className="row">
        <div className="small muted">Showing the last {days} days</div>
        <span className="spacer" />
        <div className="seg-control">{[7, 14, 30].map(d => <button key={d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{d}d</button>)}</div>
      </div>

      <div className="grid g4">
        <Kpi icon={MessageCircleQuestion} label="Questions asked" value={t.questions} hint={`${a.questions_per_day.reduce((s, d) => s + d.widget, 0)} from customers · ${a.questions_per_day.reduce((s, d) => s + d.assistant, 0)} from team`} onClick={() => go('assistant')} />
        <Kpi icon={CheckCircle2} label="Answered from knowledge" value={pct(t.answer_rate)} hint={`${t.answered} answered · ${t.questions - t.answered} not covered or refused`} onClick={() => go('knowledge')} />
        <Kpi icon={Inbox} label="Open tickets" value={t.tickets_open} hint={`${t.tickets} total · ${stats.tickets.untriaged} untriaged`} onClick={() => go('inbox')} />
        <Kpi icon={Gavel} label="Awaiting approval" value={stats.approvals_pending} hint={`${stats.actions_executed} executed · ${stats.actions_blocked} blocked by policy`} onClick={() => go('approvals')} tone={stats.approvals_pending ? 'amber' : undefined} />
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)' }}>
        <Card title="Questions per day" icon={TrendingUp}>
          {t.questions === 0 ? <Empty icon={MessageCircleQuestion} title="No questions yet">Ask the Internal Assistant or try the support widget — every question shows up here.</Empty> : <QuestionsChart data={a.questions_per_day} />}
        </Card>
        <Card title="Widget deflection" icon={MessageSquare}>
          <Funnel steps={[
            { label: 'Customer questions', value: a.deflection.asked },
            { label: 'Answered instantly', value: a.deflection.answered, rate: a.deflection.asked ? a.deflection.answered / a.deflection.asked : null },
            { label: 'Resolved without a ticket', value: a.deflection.deflected, rate: a.deflection.asked ? a.deflection.deflected / a.deflection.asked : null },
            { label: 'Handed off as tickets', value: a.deflection.tickets, rate: a.deflection.asked ? a.deflection.tickets / a.deflection.asked : null },
          ]} />
          <div className="hr" />
          <div className="row small"><Send size={14} className="muted" />AI drafts sent<span className="spacer" /><b>{a.drafts.sent}</b><span className="muted tiny">of {a.drafts.total}</span></div>
          <div className="row small mt"><ShieldAlert size={14} className="muted" />Guardrail events<span className="spacer" /><b>{stats.guardrail_events}</b></div>
          <div className="row small mt"><ThumbsUp size={14} className="muted" />Answer feedback<span className="spacer" /><span className="row" style={{ gap: 10 }}><span className="row" style={{ gap: 4 }}><ThumbsUp size={13} color="var(--green)" /><b>{t.thumbs_up}</b></span><span className="row" style={{ gap: 4 }}><ThumbsDown size={13} color="var(--red)" /><b>{t.thumbs_down}</b></span></span></div>
        </Card>
      </div>

      <div className="grid g2">
        <Card title="Top questions" icon={MessageCircleQuestion} bodyClass="">
          {a.top_questions.length === 0 ? <div className="card-b small muted">No questions yet.</div> : (
            <table className="table"><tbody>{a.top_questions.map(q => (
              <tr key={q.question}>
                <td className="small">{q.question}<div className="tiny faint">{q.sources.map(s => (s === 'widget' ? 'customer widget' : 'team assistant')).join(' · ')} · last {fmtTime(q.last_asked)}</div></td>
                <td style={{ width: 70, textAlign: 'right' }}><b>{q.count}×</b></td>
                <td style={{ width: 110 }}>{q.answered === q.count ? <Badge tone="green">answered</Badge> : q.answered ? <Badge tone="amber">partly</Badge> : <Badge tone="amber">not in KB</Badge>}</td>
              </tr>))}</tbody></table>
          )}
        </Card>
        <Card title="Knowledge gaps" icon={HelpCircle} bodyClass="" actions={<button className="btn sm" onClick={() => go('knowledge')}><BookOpen size={13} /> Add knowledge</button>}>
          {a.unanswered_questions.length === 0 ? <div className="card-b small muted">Nothing missing — every question was answered from your knowledge base.</div> : (
            <table className="table"><tbody>{a.unanswered_questions.map(q => (
              <tr key={q.question}><td className="small">{q.question}<div className="tiny faint">last asked {fmtTime(q.last_asked)}</div></td><td style={{ width: 70, textAlign: 'right' }}><b>{q.count - q.answered}×</b></td></tr>
            ))}</tbody></table>
          )}
        </Card>
      </div>

      <Card title="Question log" icon={MessageCircleQuestion} bodyClass="" actions={
        <div className="seg-control">{[['all', 'All'], ['unanswered', 'Not answered'], ['assistant', 'Team'], ['widget', 'Customers']].map(([k, l]) => <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>)}</div>}>
        {questions.length === 0 ? <div className="card-b small muted">No questions match.</div> : (
          <table className="table">
            <thead><tr><th>Question</th><th>Source</th><th>Result</th><th>Confidence</th><th>Feedback</th><th>Asked</th></tr></thead>
            <tbody>{questions.map(q => (
              <tr key={q.run_id} className="click" onClick={() => go('traces', q.run_id)}>
                <td className="small" style={{ maxWidth: 420 }}>{q.question}</td>
                <td className="small">{q.source === 'widget' ? 'Customer widget' : `Team${q.asked_by ? ` · ${q.asked_by}` : ''}`}</td>
                <td><Badge tone={(STATUS_BADGE[q.status] || ['', ''])[1]}>{(STATUS_BADGE[q.status] || [q.status])[0]}</Badge></td>
                <td className="small">{q.confidence ? pct(q.confidence) : '—'}</td>
                <td>{q.feedback === 'up' ? <ThumbsUp size={14} color="var(--green)" /> : q.feedback === 'down' ? <ThumbsDown size={14} color="var(--red)" /> : <span className="faint">—</span>}</td>
                <td className="small muted">{fmtTime(q.created_at)}</td>
              </tr>))}</tbody>
          </table>
        )}
      </Card>

      <div className="grid g3">
        <Card title="Tickets by category">
          {a.categories.length === 0 ? <div className="small muted">Triage tickets to see categories.</div> : a.categories.map(c => (
            <div key={c.category} className="mb"><div className="row small"><span>{c.category}</span><span className="spacer" /><b>{c.n}</b></div><div className="bar"><span style={{ width: `${(c.n / Math.max(...a.categories.map(x => x.n))) * 100}%`, background: 'var(--series-1)' }} /></div></div>
          ))}
        </Card>
        <Card title="Tickets by channel">
          {a.channels.length === 0 ? <div className="small muted">No tickets yet.</div> : a.channels.map(c => <div key={c.channel} className="row small mb"><Badge tone="indigo">{c.channel.replace('_', ' ')}</Badge><span className="spacer" /><b>{c.n}</b></div>)}
        </Card>
        <Card title="Quality">
          {stats.latest_eval ? (
            <div className="stack small" style={{ gap: 8 }}>
              <div className="row">Eval cases passed<span className="spacer" /><b>{stats.latest_eval.passed_cases}/{stats.latest_eval.total_cases}</b></div>
              <div className="row">Citation coverage<span className="spacer" /><b>{pct(stats.latest_eval.citation_coverage)}</b></div>
              <div className="row">Unsafe actions blocked<span className="spacer" /><b>{pct(stats.latest_eval.unsafe_action_block_rate)}</b></div>
              <button className="btn sm" onClick={() => go('evals')}>Open evaluations</button>
            </div>
          ) : <div className="small muted">Run the evaluation suite to see quality scores. <button className="btn sm mt" onClick={() => go('evals')}>Run evals</button></div>}
        </Card>
      </div>
    </div>
  );
}
