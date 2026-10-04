import React, { useEffect, useState } from 'react';
import {
  LayoutDashboard, Inbox, Gavel, Sparkles, BookOpen, MessageSquare, Plug, FlaskConical, Activity, Settings, LogOut, ShieldCheck, Bot, ClipboardList,
} from 'lucide-react';
import { api, session } from './api';
import { ToastProvider } from './components/ui';
import Dashboard from './pages/Dashboard';
import InboxPage from './pages/Inbox';
import Approvals from './pages/Approvals';
import Automation from './pages/Automation';
import SupportForm from './pages/SupportForm';
import Assistant from './pages/Assistant';
import Knowledge from './pages/Knowledge';
import WidgetPage from './pages/Widget';
import Integrations from './pages/Integrations';
import Evals from './pages/Evals';
import Traces from './pages/Traces';
import SettingsPage from './pages/Settings';
import Landing from './pages/Landing';
import { Login, Signup } from './pages/Auth';

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, title: 'Dashboard', sub: 'Questions, answers, tickets and quality at a glance' },
  { section: 'Helpdesk' },
  { id: 'inbox', label: 'Inbox', icon: Inbox, title: 'Helpdesk inbox', sub: 'Triage, cited drafts and approval-gated actions' },
  { id: 'approvals', label: 'Approvals', icon: Gavel, title: 'Approval queue', sub: 'Sensitive actions waiting for a manager', countKey: 'approvals_pending' },
  { id: 'automation', label: 'Autopilot', icon: Bot, title: 'Autopilot', sub: 'What happens automatically when a ticket arrives: triage, draft, or answer when confident' },
  { section: 'Knowledge' },
  { id: 'assistant', label: 'AI Assistant', icon: Sparkles, title: 'AI Assistant', sub: 'Ask your knowledge base — every answer cites its sources' },
  { id: 'knowledge', label: 'Knowledge Base', icon: BookOpen, title: 'Knowledge Base', sub: 'Sources, ingestion, quarantine and search playground' },
  { section: 'Channels' },
  { id: 'support-form', label: 'Support Form', icon: ClipboardList, title: 'Support form deflector', sub: 'A contact form that answers customers before a ticket is created' },
  { id: 'widget', label: 'Chat Widget', icon: MessageSquare, title: 'Chat widget', sub: 'Instant, sourced answers on your website' },
  { id: 'integrations', label: 'Integrations', icon: Plug, title: 'Integrations', sub: 'Zendesk, Freshdesk, Intercom, Front, Linear, widget and webhooks' },
  { section: 'Quality' },
  { id: 'evals', label: 'Evaluations', icon: FlaskConical, title: 'Evaluations', sub: 'Run the provided eval cases and inspect every check' },
  { id: 'traces', label: 'Traces', icon: Activity, title: 'Agent traces', sub: 'Every AI run, step by step' },
  { section: 'Workspace settings' },
  { id: 'settings', label: 'Settings & team', icon: Settings, title: 'Settings', sub: 'Workspace, team members, model and data' },
];

function parseHash() {
  const [page, ...rest] = window.location.hash.replace(/^#\/?/, '').split('/');
  return { page: page || '', param: rest.join('/') || null };
}

export function go(page, param) {
  window.location.hash = `/${page}${param ? `/${param}` : ''}`;
}

const PUBLIC_PAGES = ['', 'login', 'signup'];

export default function App() {
  const [auth, setAuth] = useState(session.read());
  const [route, setRoute] = useState(parseHash());
  const [counts, setCounts] = useState({});

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    const onLogout = () => setAuth(null);
    window.addEventListener('hashchange', onHash);
    window.addEventListener('trustdesk:logout', onLogout);
    return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener('trustdesk:logout', onLogout); };
  }, []);

  // Refresh the session (role or workspace name may have changed) and keep the approvals badge live.
  useEffect(() => {
    if (!auth) return undefined;
    api('/api/auth/me').then(me => { const next = { ...auth, ...me }; session.save(next); setAuth(next); })
      .catch(e => { if (e.status === 401) { session.clear(); setAuth(null); } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth && auth.token]);
  useEffect(() => {
    if (!auth) return undefined;
    const load = () => api('/api/stats').then(s => setCounts({ approvals_pending: s.approvals_pending })).catch(() => {});
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [auth, route.page]);

  const onAuth = (data, isNew) => { setAuth(data); go(isNew ? 'dashboard' : (PUBLIC_PAGES.includes(route.page) ? 'dashboard' : route.page)); };
  const logout = async () => { try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* already gone */ } session.clear(); setAuth(null); go(''); };

  if (!auth) {
    const page = ['overview', 'dashboard'].includes(route.page) ? '' : route.page;
    return (
      <ToastProvider>
        {page === 'signup' ? <Signup go={go} onAuth={onAuth} />
          : page === '' ? <Landing go={go} />
            : <Login go={go} onAuth={onAuth} demo={route.param === 'demo'} />}
      </ToastProvider>
    );
  }

  const { user, org } = auth;
  const pageId = NAV.some(n => n.id === route.page) ? route.page : 'dashboard';
  const nav = NAV.find(n => n.id === pageId) || NAV[0];
  const pages = {
    dashboard: <Dashboard user={user} org={org} />,
    inbox: <InboxPage ticketId={route.param} user={user} />,
    approvals: <Approvals user={user} />,
    automation: <Automation user={user} />,
    'support-form': <SupportForm org={org} />,
    assistant: <Assistant />,
    knowledge: <Knowledge user={user} org={org} docId={route.param} />,
    widget: <WidgetPage org={org} />,
    integrations: <Integrations user={user} org={org} param={route.param} />,
    evals: <Evals />,
    traces: <Traces runId={route.param} />,
    settings: <SettingsPage user={user} org={org} onOrgChange={o => { const next = { ...auth, org: o }; session.save(next); setAuth(next); }} />,
  };

  return (
    <ToastProvider>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand"><div className="brand-mark"><ShieldCheck size={17} color="#fff" /></div>TrustDesk</div>
          <div className="ws-chip">
            <div className="tiny" style={{ color: '#5d6584', textTransform: 'uppercase', letterSpacing: '.08em' }}>Workspace</div>
            <div className="row"><div className="n" style={{ flex: 1 }}>{org.name}</div><span className="badge indigo" style={{ background: '#262d4f', color: '#c7d2fe' }}>{org.is_demo ? 'demo' : org.plan}</span></div>
          </div>
          {NAV.map((n, i) => n.section
            ? <div key={i} className="nav-section">{n.section}</div>
            : (
              <button key={n.id} className={`nav-item ${pageId === n.id ? 'active' : ''}`} onClick={() => go(n.id)}>
                <n.icon size={16} />{n.label}
                {n.countKey && counts[n.countKey] > 0 && <span className="count">{counts[n.countKey]}</span>}
              </button>
            ))}
          <div className="sidebar-foot">
            <div className="user-chip">
              <div className="avatar">{user.name[0]}</div>
              <div style={{ flex: 1, minWidth: 0 }}><div className="small bold" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.name}</div><div className="role">{user.role.replace('_', ' ')}</div></div>
              <button className="btn ghost sm" title="Log out" style={{ color: '#aab1c8' }} onClick={logout}><LogOut size={14} /></button>
            </div>
          </div>
        </aside>
        <main className="main">
          <div className="topbar"><div><h1>{nav.title}</h1><div className="sub">{nav.sub}</div></div></div>
          <div className="page">{pages[nav.id] || pages.dashboard}</div>
        </main>
      </div>
    </ToastProvider>
  );
}
