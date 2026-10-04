import React, { useEffect, useState } from 'react';
import { ClipboardList, Copy, ExternalLink, RefreshCw, Bot } from 'lucide-react';
import { api } from '../api';
import { Button, Card, useToast } from '../components/ui';
import { go } from '../App';

function copy(text, toast) { try { navigator.clipboard.writeText(text); toast('Copied'); } catch { toast(text); } }

export default function SupportForm({ org }) {
  const toast = useToast();
  const [a, setA] = useState(null);
  const [auto, setAuto] = useState(null);
  const [frameKey, setFrameKey] = useState(0);
  const load = () => { api('/api/analytics?days=30').then(setA).catch(() => {}); api('/api/automation/settings').then(setAuto).catch(() => {}); };
  useEffect(() => { load(); }, []);
  const url = `${window.location.origin}/support.html?key=${org.public_key}`;
  const embed = `<iframe src="${url}&embed=1" style="width:100%;min-height:760px;border:0" title="Contact support"></iframe>`;
  const d = a ? a.deflection : null;
  const modeText = auto ? { triage: 'triaged for your team', draft: 'triaged and drafted for review', auto: `answered automatically when confidence ≥ ${Math.round(auto.threshold * 100)}%, otherwise drafted for review` }[auto.mode] : '';
  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.15fr)', alignItems: 'start' }}>
      <div className="stack">
        <div className="grid g2">
          <div className="card stat"><div className="label">Form & widget questions (30d)</div><div className="value">{d ? d.asked : '—'}</div><div className="hint">{d ? d.answered : 0} got an instant answer</div></div>
          <div className="card stat"><div className="label">Resolved without a ticket</div><div className="value">{d ? d.deflected : '—'}</div><div className="hint">{d ? d.tickets : 0} submitted as tickets</div></div>
        </div>
        <Card title="How the deflector works" icon={ClipboardList}>
          <ol className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
            <li>While the customer types, TrustDesk searches your <b>public</b> knowledge base and shows a suggested answer with its source.</li>
            <li>“Yes, this answers my question” closes it — no ticket created.</li>
            <li>Otherwise the request becomes a ticket and goes through <b>Autopilot</b>: {modeText || '…'}.</li>
            <li>If Autopilot answers, the customer sees the reply on the confirmation page right away.</li>
          </ol>
          <div className="row mt"><Button icon={Bot} size="sm" onClick={() => go('automation')}>Autopilot settings</Button></div>
        </Card>
        <Card title="Share or embed" icon={ExternalLink}>
          <div className="small muted">Hosted page — link it from your website's “Contact us”:</div>
          <div className="row mt"><code className="input mono small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{url}</code><Button size="sm" icon={Copy} onClick={() => copy(url, toast)}>Copy</Button><a className="btn sm" href={url} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Open</a></div>
          <div className="small muted mt">Or embed it in any page:</div>
          <pre className="json mt">{embed}</pre>
          <Button size="sm" icon={Copy} onClick={() => copy(embed, toast)}>Copy embed code</Button>
        </Card>
      </div>
      <Card title="Live preview" icon={ClipboardList} bodyClass="" actions={<Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => { setFrameKey(k => k + 1); load(); }}>Reload</Button>}>
        <iframe key={frameKey} src={`${url}&embed=1`} title="Support form preview" style={{ width: '100%', height: 820, border: 0, background: 'var(--bg)', borderRadius: '0 0 10px 10px' }} />
      </Card>
    </div>
  );
}
