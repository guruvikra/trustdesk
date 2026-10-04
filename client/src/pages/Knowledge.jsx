import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Upload, Link as LinkIcon, FileText, Search, RefreshCw, ShieldAlert, Trash2, Lock, Globe, Eye } from 'lucide-react';
import { api, poll } from '../api';
import { Badge, Button, Card, Empty, Spinner, fmtTime, useToast } from '../components/ui';
import { DocModal } from './TicketDetail';

function AddSource({ onIngested }) {
  const toast = useToast();
  const [tab, setTab] = useState('upload');
  const [visibility, setVisibility] = useState('public');
  const [files, setFiles] = useState([]);
  const [url, setUrl] = useState('');
  const [crawl, setCrawl] = useState(true);
  const [paste, setPaste] = useState({ title: '', doc_id: '', content: '' });
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const watch = async (jobId) => {
    setJob({ job_id: jobId, status: 'queued', logs: [] });
    const final = await poll(() => api(`/api/ingest-jobs/${jobId}`).then(j => { setJob(j); return j; }), j => ['completed', 'failed'].includes(j.status));
    if (final.status === 'completed') toast(`Ingested ${final.doc_ids.length} document(s)`); else toast(final.error || 'Ingestion failed', 'error');
    onIngested();
  };

  const submit = async () => {
    setBusy(true);
    try {
      let out;
      if (tab === 'upload') {
        const form = new FormData();
        files.forEach(f => form.append('files', f));
        form.append('visibility', visibility);
        out = await api('/api/documents/ingest', { method: 'POST', form });
      } else if (tab === 'url') {
        out = await api('/api/documents/ingest', { method: 'POST', body: { url, visibility, crawl, max_pages: 20 } });
      } else {
        out = await api('/api/documents/ingest', { method: 'POST', body: { documents: [{ ...paste, doc_id: paste.doc_id || undefined, visibility }] } });
      }
      await watch(out.job_id);
      setFiles([]); setUrl(''); setPaste({ title: '', doc_id: '', content: '' });
      if (fileRef.current) fileRef.current.value = '';
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };

  const ready = tab === 'upload' ? files.length > 0 : tab === 'url' ? url.startsWith('http') : paste.content.trim().length > 0;
  return (
    <Card title="Add knowledge" icon={Upload}>
      <div className="tabs">
        <button className={`tab ${tab === 'upload' ? 'active' : ''}`} onClick={() => setTab('upload')}><Upload size={13} /> Upload files</button>
        <button className={`tab ${tab === 'url' ? 'active' : ''}`} onClick={() => setTab('url')}><LinkIcon size={13} /> Web page</button>
        <button className={`tab ${tab === 'paste' ? 'active' : ''}`} onClick={() => setTab('paste')}><FileText size={13} /> Paste text</button>
      </div>
      {tab === 'upload' && (
        <div>
          <input ref={fileRef} type="file" multiple accept=".pdf,.md,.markdown,.txt,.html,.htm" onChange={e => setFiles([...e.target.files])} />
          <div className="small muted mt">PDF, Markdown, text or HTML — up to 10 files, 15 MB each. Use "Doc ID: KB-XXX-001" in a header line to set your own IDs.</div>
        </div>
      )}
      {tab === 'url' && (
        <div className="stack" style={{ gap: 8 }}>
          <input className="input" placeholder="https://docs.yourcompany.com" value={url} onChange={e => setUrl(e.target.value)} />
          <label className="row small"><input type="checkbox" checked={crawl} onChange={e => setCrawl(e.target.checked)} /> Also import linked pages in the same section (up to 20 pages, one document each)</label>
        </div>
      )}
      {tab === 'paste' && (
        <div className="stack">
          <div className="grid g2">
            <input className="input" placeholder="Title" value={paste.title} onChange={e => setPaste({ ...paste, title: e.target.value })} />
            <input className="input" placeholder="Doc ID (optional, e.g. KB-EXCHANGE-001)" value={paste.doc_id} onChange={e => setPaste({ ...paste, doc_id: e.target.value })} />
          </div>
          <textarea className="textarea" rows={6} placeholder={'# Exchange Policy\n\n## Size exchanges\nCustomers can exchange…'} value={paste.content} onChange={e => setPaste({ ...paste, content: e.target.value })} />
        </div>
      )}
      <div className="row mt">
        <select className="select" style={{ width: 230 }} value={visibility} onChange={e => setVisibility(e.target.value)}>
          <option value="public">Public — customers may see answers from it</option>
          <option value="internal">Internal — team only (assistant & helpdesk)</option>
        </select>
        <span className="spacer" />
        <Button variant="primary" icon={Upload} busy={busy} disabled={!ready} onClick={submit}>Ingest</Button>
      </div>
      {job && (
        <div className="mt">
          <div className="row small"><Badge>{job.status}</Badge><span className="mono tiny">{job.job_id}</span><span className="muted tiny">runs in a background job — the API stays responsive</span></div>
          <div className="json mt" style={{ maxHeight: 140 }}>{(job.logs || []).map((l, i) => <div key={i}>{l.message}</div>)}{job.error && <div style={{ color: '#ff9b9b' }}>{job.error}</div>}</div>
        </div>
      )}
    </Card>
  );
}

function Playground() {
  const [q, setQ] = useState('');
  const [vis, setVis] = useState('internal');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try { setRes(await api(`/api/documents/search?q=${encodeURIComponent(q)}&visibility=${vis}&limit=6`)); } finally { setBusy(false); }
  };
  return (
    <Card title="Retrieval playground" icon={Search}>
      <div className="row">
        <input className="input" placeholder="e.g. customer wants refund for cracked earbuds" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && search()} />
        <select className="select" style={{ width: 130 }} value={vis} onChange={e => setVis(e.target.value)}><option value="internal">As team</option><option value="public">As customer</option></select>
        <Button icon={Search} busy={busy} onClick={search}>Search</Button>
      </div>
      {res && (
        <div className="stack mt">
          {res.quarantined_doc_ids.length > 0 && <div className="callout red small"><ShieldAlert size={14} /> Matched but excluded (quarantined): {res.quarantined_doc_ids.join(', ')}</div>}
          {res.results.length === 0 && <div className="muted small">No matching chunks.</div>}
          {res.results.map(r => (
            <div key={r.chunk_id} className="source">
              <div className="row wrap"><span className="cite">{r.doc_id}</span><span className="small bold">{r.heading}</span><span className="spacer" /><span className="tiny muted">BM25 {r.score} · coverage {Math.round(r.coverage * 100)}%</span></div>
              <div className="bar mt"><span style={{ width: `${Math.min(100, (r.score / res.results[0].score) * 100)}%` }} /></div>
              <div className="small muted mt">{r.content.slice(0, 260)}{r.content.length > 260 ? '…' : ''}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export default function Knowledge({ user, org, docId }) {
  const toast = useToast();
  const [docs, setDocs] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [open, setOpen] = useState(null);
  const isManager = ['support_manager', 'admin'].includes(user.role);

  const load = useCallback(() => {
    api('/api/documents').then(setDocs).catch(e => { setDocs([]); toast(e.message, 'error'); });
    api('/api/ingest-jobs').then(setJobs).catch(() => setJobs([]));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (docId) setOpen(docId); }, [docId]);

  const patch = async (d, body) => {
    try { await api(`/api/documents/${d.doc_id}`, { method: 'PATCH', body }); load(); } catch (e) { toast(e.message, 'error'); }
  };
  const remove = async d => {
    if (!window.confirm(`Delete ${d.doc_id}? It will no longer be used for answers.`)) return;
    try { await api(`/api/documents/${d.doc_id}`, { method: 'DELETE' }); toast(`Deleted ${d.doc_id}`); load(); } catch (e) { toast(e.message, 'error'); }
  };
  const resync = async () => {
    const out = await api('/api/documents/resync', { method: 'POST' });
    toast(`Policy pack re-sync queued (${out.job_id})`);
    setTimeout(load, 1200);
  };

  const quarantined = (docs || []).filter(d => d.trust === 'quarantined');
  return (
    <div className="stack">
      <div className="grid g4">
        <div className="card stat"><div className="label">Documents</div><div className="value">{docs ? docs.length : '—'}</div><div className="hint">{docs ? docs.reduce((a, d) => a + d.chunk_count, 0) : 0} indexed chunks</div></div>
        <div className="card stat"><div className="label">Public</div><div className="value">{docs ? docs.filter(d => d.visibility === 'public').length : '—'}</div><div className="hint">usable by the customer widget</div></div>
        <div className="card stat"><div className="label">Internal only</div><div className="value">{docs ? docs.filter(d => d.visibility === 'internal').length : '—'}</div><div className="hint">team assistant & helpdesk</div></div>
        <div className="card stat"><div className="label">Quarantined</div><div className="value" style={{ color: quarantined.length ? 'var(--red)' : undefined }}>{quarantined.length}</div><div className="hint">contain instructions to the AI</div></div>
      </div>

      {quarantined.length > 0 && (
        <div className="callout red"><ShieldAlert size={16} /><div><b>{quarantined.map(d => d.doc_id).join(', ')}</b> contained instructions aimed at the assistant (for example "{(quarantined[0].trust_reasons[0] || '').replace(/^.*?"|"$/g, '')}"). Quarantined sources are never retrieved as context or cited.</div></div>
      )}

      <div className="grid g2">
        <AddSource onIngested={load} />
        <Playground />
      </div>

      <Card title="Sources" icon={BookOpen} bodyClass="" actions={org && org.is_demo && isManager && <Button size="sm" icon={RefreshCw} onClick={resync}>Re-sync sample policies</Button>}>
        {docs === null ? <div className="card-b"><Spinner /></div> : docs.length === 0 ? <Empty icon={BookOpen} title="Knowledge base is empty">Upload your policies, help-center pages or runbooks above.</Empty> : (
          <table className="table">
            <thead><tr><th>Doc ID</th><th>Title</th><th>Source</th><th>Visibility</th><th>Trust</th><th>Chunks</th><th>Updated</th><th /></tr></thead>
            <tbody>
              {docs.map(d => (
                <tr key={d.doc_id}>
                  <td><button className="cite" onClick={() => setOpen(d.doc_id)}>{d.doc_id}</button></td>
                  <td><div className="bold">{d.title}</div><div className="tiny muted">{d.audience}</div></td>
                  <td className="small muted">{d.source_type}<div className="tiny faint" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.source_path}</div></td>
                  <td><Badge>{d.visibility}</Badge></td>
                  <td><Badge>{d.trust}</Badge></td>
                  <td>{d.chunk_count}</td>
                  <td className="small muted">{fmtTime(d.updated_at)}</td>
                  <td>
                    <div className="row">
                      <button className="btn ghost sm" title="View" onClick={() => setOpen(d.doc_id)}><Eye size={13} /></button>
                      {isManager && <button className="btn ghost sm" title={d.visibility === 'public' ? 'Make internal' : 'Make public'} onClick={() => patch(d, { visibility: d.visibility === 'public' ? 'internal' : 'public' })}>{d.visibility === 'public' ? <Lock size={13} /> : <Globe size={13} />}</button>}
                      {isManager && <button className="btn ghost sm" title={d.trust === 'trusted' ? 'Quarantine' : 'Release from quarantine'} onClick={() => patch(d, { trust: d.trust === 'trusted' ? 'quarantined' : 'trusted' })}><ShieldAlert size={13} /></button>}
                      {isManager && <button className="btn ghost sm" title="Delete" onClick={() => remove(d)}><Trash2 size={13} /></button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {jobs.length > 0 && (
        <Card title="Recent ingestion jobs" bodyClass="">
          <table className="table">
            <thead><tr><th>Job</th><th>Source</th><th>Status</th><th>Documents</th><th>Started</th></tr></thead>
            <tbody>{jobs.slice(0, 6).map(j => <tr key={j.job_id}><td className="mono small">{j.job_id}</td><td className="small">{j.source_name}</td><td><Badge>{j.status}</Badge></td><td className="mono small">{j.doc_ids.join(', ') || j.error || '—'}</td><td className="small muted">{fmtTime(j.created_at)}</td></tr>)}</tbody>
          </table>
        </Card>
      )}
      {open && <DocModal docId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
