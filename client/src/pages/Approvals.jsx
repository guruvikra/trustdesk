import React, { useEffect, useState } from 'react';
import { Gavel, CheckCircle2, XCircle } from 'lucide-react';
import { api } from '../api';
import { Badge, Button, Card, Empty, Spinner, fmtTime, useToast } from '../components/ui';
import { go } from '../App';

export default function Approvals({ user }) {
  const toast = useToast();
  const [status, setStatus] = useState('pending_approval');
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState('');
  const isManager = ['support_manager', 'admin'].includes(user.role);
  const load = () => api(`/api/tool-actions${status ? `?status=${status}` : ''}`).then(setItems).catch(e => { setItems([]); toast(e.message, 'error'); });
  useEffect(() => { load(); }, [status]);

  const decide = async (a, decision) => {
    setBusy(a.action_id + decision);
    try {
      await api(`/api/tool-actions/${a.action_id}/${decision}`, { method: 'POST', body: { note: decision === 'approve' ? 'Approved from queue' : 'Rejected from queue' } });
      toast(`${a.tool_name} ${decision}d`);
      load();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(''); }
  };

  return (
    <Card title="Tool actions" icon={Gavel} bodyClass="" actions={
      <div className="row">{[['pending_approval', 'Pending'], ['approved', 'Approved'], ['executed', 'Executed'], ['blocked', 'Blocked'], ['rejected', 'Rejected'], ['', 'All']].map(([s, l]) => (
        <button key={s} className={`badge ${status === s ? 'indigo' : ''}`} style={{ border: 0, cursor: 'pointer' }} onClick={() => setStatus(s)}>{l}</button>))}</div>}>
      {!isManager && status === 'pending_approval' && <div className="callout blue small" style={{ margin: 12 }}>You're signed in as a support agent. Agents can see the queue but only a support manager can approve — switch user from the sidebar.</div>}
      {items === null ? <div className="card-b"><Spinner /></div> : items.length === 0 ? <Empty icon={Gavel} title="Nothing here" /> : (
        <table className="table">
          <thead><tr><th>Action</th><th>Ticket</th><th>Parameters</th><th>Proposed</th><th>Status</th><th /></tr></thead>
          <tbody>{items.map(a => (
            <tr key={a.action_id}>
              <td><div className="mono bold small">{a.tool_name}</div><div className="tiny faint mono">{a.idempotency_key}</div></td>
              <td>{a.ticket_id ? <button className="cite" onClick={() => go('inbox', a.ticket_id)}>{a.ticket_id}</button> : '—'}</td>
              <td className="tiny mono">{a.block_reason ? <span style={{ color: 'var(--red)' }}>{a.block_reason}</span> : Object.entries(a.parameters).map(([k, v]) => `${k}=${v}`).join(' · ')}</td>
              <td className="small">{a.proposed_by}<div className="tiny muted">{fmtTime(a.created_at)}</div></td>
              <td><Badge>{a.status}</Badge>{a.decided_by && <div className="tiny muted">{a.decided_by}</div>}</td>
              <td>{a.status === 'pending_approval' && isManager && (
                <div className="row">
                  <Button size="sm" variant="success" icon={CheckCircle2} busy={busy === a.action_id + 'approve'} onClick={() => decide(a, 'approve')}>Approve</Button>
                  <Button size="sm" variant="danger" icon={XCircle} busy={busy === a.action_id + 'reject'} onClick={() => decide(a, 'reject')}>Reject</Button>
                </div>)}</td>
            </tr>))}</tbody>
        </table>
      )}
    </Card>
  );
}
