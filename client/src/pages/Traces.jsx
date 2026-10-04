import React, { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import { api } from '../api';
import { Badge, Card, Empty, Spinner, fmtTime } from '../components/ui';
import { TraceView } from '../components/Trace';
import { go } from '../App';

export default function Traces({ runId }) {
  const [runs, setRuns] = useState(null);
  const [type, setType] = useState('');
  useEffect(() => { api(`/api/agent-runs?limit=100${type ? `&run_type=${type}` : ''}`).then(setRuns); }, [type]);
  const selected = runId || (runs && runs[0] && runs[0].run_id);
  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', alignItems: 'start' }}>
      <Card title="Runs" icon={Activity} bodyClass="" actions={
        <select className="select" style={{ width: 150, padding: '4px 8px' }} value={type} onChange={e => setType(e.target.value)}>
          <option value="">All types</option><option value="triage">Triage</option><option value="draft">Draft</option><option value="assistant">Assistant</option><option value="widget">Widget</option>
        </select>}>
        {runs === null ? <div className="card-b"><Spinner /></div> : runs.length === 0 ? <Empty icon={Activity} title="No AI runs yet" /> : (
          <div style={{ maxHeight: 'calc(100vh - 200px)', overflowY: 'auto' }}>
            <table className="table">
              <thead><tr><th>Run</th><th>Type</th><th>Ticket</th><th>Status</th><th>Flags</th><th>When</th></tr></thead>
              <tbody>{runs.map(r => (
                <tr key={r.run_id} className="click" style={selected === r.run_id ? { background: 'var(--accent-soft)' } : undefined} onClick={() => go('traces', r.run_id)}>
                  <td className="mono tiny">{r.run_id}</td><td><Badge tone="indigo">{r.run_type}</Badge></td><td className="mono tiny">{r.ticket_id || '—'}</td>
                  <td><Badge>{r.final_status}</Badge></td><td className="tiny">{(r.guardrails.flags || []).join(', ')}</td><td className="tiny muted">{fmtTime(r.created_at)}</td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Trace detail">{selected ? <TraceView runId={selected} /> : <div className="muted small">Select a run.</div>}</Card>
    </div>
  );
}
