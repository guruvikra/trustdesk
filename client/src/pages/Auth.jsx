import React, { useEffect, useState } from 'react';
import { ShieldCheck, CheckCircle2, ArrowRight } from 'lucide-react';
import { api, session } from '../api';
import { Button } from '../components/ui';

function Side() {
  return (
    <div className="auth-side">
      <div className="logo" style={{ color: '#fff' }}><div className="brand-mark"><ShieldCheck size={17} color="#fff" /></div>TrustDesk</div>
      <h2>Cited answers for customers. Guardrails for everyone else.</h2>
      <ul>
        {['Knowledge base from your PDFs and help centre', 'Internal assistant with numbered sources', 'Zendesk & Freshdesk drafts with policy citations', 'Refunds and replacements only after approval'].map(t => (
          <li key={t} className="row"><CheckCircle2 size={16} color="#a5b4fc" /> {t}</li>
        ))}
      </ul>
    </div>
  );
}

export function Login({ go, onAuth, demo }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [demoAccounts, setDemoAccounts] = useState([]);
  useEffect(() => { api('/api/auth/demo-accounts').then(setDemoAccounts).catch(() => {}); }, []);

  const submit = async (e, creds) => {
    if (e) e.preventDefault();
    const body = creds || { email, password };
    setBusy(creds ? creds.email : 'form'); setError('');
    try {
      const out = await api('/api/auth/login', { method: 'POST', body });
      session.save(out);
      onAuth(out);
    } catch (err) { setError(err.message); } finally { setBusy(''); }
  };

  return (
    <div className="auth">
      <Side />
      <div className="auth-main">
        <form className="auth-form" onSubmit={submit}>
          <h1>Welcome back</h1>
          <div className="muted mb">Log in to your TrustDesk workspace.</div>
          <div className="stack">
            <label className="field">Work email<input className="input" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required /></label>
            <label className="field">Password<input className="input" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
            {error && <div className="callout red">{error}</div>}
            <Button variant="primary" busy={busy === 'form'} type="submit" style={{ justifyContent: 'center' }}>Log in</Button>
          </div>
          <div className="small muted mt">No account? <a href="#/signup" onClick={e => { e.preventDefault(); go('signup'); }}>Create a workspace</a></div>

          <div className="divider">{demo ? 'EXPLORE THE DEMO WORKSPACE' : 'OR TRY THE DEMO WORKSPACE'}</div>
          <div className="stack" style={{ gap: 8 }}>
            {demoAccounts.map(a => (
              <button type="button" key={a.email} className="persona" disabled={!!busy} onClick={() => submit(null, { email: a.email, password: 'trustdesk' })}>
                <div className="avatar" style={{ background: '#eef0ff', color: '#4f46e5' }}>{a.name[0]}</div>
                <div style={{ flex: 1 }}><div className="bold small">{a.name}</div><div className="tiny muted">{a.email}</div></div>
                {busy === a.email ? <span className="tiny muted">…</span> : <ArrowRight size={14} className="faint" />}
              </button>
            ))}
          </div>
          <div className="tiny faint mt">The demo workspace is pre-loaded with the BlueGadgets sample store (tickets, customers, orders and policies).</div>
        </form>
      </div>
    </div>
  );
}

export function Signup({ go, onAuth }) {
  const [f, setF] = useState({ name: '', company: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const submit = async e => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const out = await api('/api/auth/signup', { method: 'POST', body: f });
      session.save(out);
      onAuth(out, true);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <div className="auth">
      <Side />
      <div className="auth-main">
        <form className="auth-form" onSubmit={submit}>
          <h1>Create your workspace</h1>
          <div className="muted mb">Start free. You'll be the workspace admin.</div>
          <div className="stack">
            <label className="field">Your name<input className="input" value={f.name} onChange={set('name')} required /></label>
            <label className="field">Company<input className="input" value={f.company} onChange={set('company')} placeholder="e.g. Acme Retail" required /></label>
            <label className="field">Work email<input className="input" type="email" autoComplete="email" value={f.email} onChange={set('email')} required /></label>
            <label className="field">Password<input className="input" type="password" autoComplete="new-password" value={f.password} onChange={set('password')} placeholder="At least 8 characters" required /></label>
            {error && <div className="callout red">{error}</div>}
            <Button variant="primary" busy={busy} type="submit" style={{ justifyContent: 'center' }}>Create workspace</Button>
          </div>
          <div className="small muted mt">Already have an account? <a href="#/login" onClick={e => { e.preventDefault(); go('login'); }}>Log in</a></div>
        </form>
      </div>
    </div>
  );
}
