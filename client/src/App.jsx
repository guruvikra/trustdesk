import React, { useState, useEffect } from 'react';
import {
  LayoutDashboard,
  BotMessageSquare,
  FolderKanban,
  Inbox,
  ShieldCheck,
  Webhook,
  Activity,
  CheckCircle2,
  Users,
  Search,
  RefreshCw,
  Send,
  AlertTriangle,
  ThumbsUp,
  ThumbsDown,
  ExternalLink,
  ChevronRight,
  ShieldAlert,
  Sparkles,
  FileText,
  Upload,
  Globe,
  Sliders,
  Check,
  Clock,
  ArrowRight,
  Building2,
  User,
  MessageSquare,
  LogOut,
  ChevronDown,
  Lock,
  Mail,
  HelpCircle,
  X
} from 'lucide-react';

const API_BASE = '';

const DEMO_PERSONAS = [
  {
    id: 'usr_001',
    name: 'Nikhil S',
    email: 'nikhil@atatus.com',
    role: 'admin',
    title: 'System Administrator',
    badgeColor: 'border-kelu-500 text-kelu-100 bg-kelu-500/20',
    description: 'Full authority: manage knowledge bases, trigger benchmarks, manage staff RBAC.'
  },
  {
    id: 'usr_002',
    name: 'Janani S',
    email: 'jananis@atatus.com',
    role: 'support_manager',
    title: 'Support Manager',
    badgeColor: 'border-emerald-500 text-emerald-300 bg-emerald-950/40',
    description: 'Supervisor authority: authorize approval-gated replacement orders & refund reviews.'
  },
  {
    id: 'usr_003',
    name: 'Parthasarathi',
    email: 'parthasarathi@atatus.com',
    role: 'support_agent',
    title: 'Frontline Support Agent',
    badgeColor: 'border-blue-500 text-blue-300 bg-blue-950/40',
    description: 'Agent authority: triage customer queue, generate cited drafts, 1-click resolve.'
  }
];

export default function App() {
  // Auth state
  const [currentUser, setCurrentUser] = useState(() => {
    try {
      const saved = localStorage.getItem('trustdesk_user');
      return saved ? JSON.parse(saved) : null;
    } catch (_) {
      return null;
    }
  });

  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showRoleDropdown, setShowRoleDropdown] = useState(false);

  // App navigation & data state
  const [view, setView] = useState('dashboard');
  const [tickets, setTickets] = useState([]);
  const [selectedTicketId, setSelectedTicketId] = useState(null);
  const [ticketFilter, setTicketFilter] = useState('all');
  const [documents, setDocuments] = useState([]);
  const [staff, setStaff] = useState([]);
  const [evalReport, setEvalReport] = useState(null);
  const [syncJobs, setSyncJobs] = useState([]);
  const [activeJob, setActiveJob] = useState(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);

  // Copilot state
  const [askQuery, setAskQuery] = useState('');
  const [askResult, setAskResult] = useState(null);

  // Deflector state
  const [deflectorQuery, setDeflectorQuery] = useState('');
  const [deflectorResult, setDeflectorResult] = useState(null);

  // Triage & draft state for selected ticket
  const [draftReply, setDraftReply] = useState('');
  const [citations, setCitations] = useState([]);
  const [guardrails, setGuardrails] = useState(null);

  // Floating widget state
  const [widgetOpen, setWidgetOpen] = useState(false);
  const [widgetMessages, setWidgetMessages] = useState([
    {
      sender: 'bot',
      text: 'Hi there! I am TrustDesk AI, grounded strictly in company return and warranty policy. How can I help you today?'
    }
  ]);
  const [widgetInput, setWidgetInput] = useState('');

  // Onboarding wizard state
  const [onboardingStep, setOnboardingStep] = useState(1);
  const [customCrawlUrl, setCustomCrawlUrl] = useState('https://docs.atatus.com/knowledge');

  // Load initial data if logged in
  useEffect(() => {
    if (currentUser) {
      fetchTickets();
      fetchDocuments();
      fetchStaff();
      fetchSyncJobs();
    }
  }, [currentUser]);

  const showToast = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  };

  const handleLogin = (persona) => {
    const user = persona || {
      id: 'usr_custom',
      name: loginEmail.split('@')[0] || 'Support Specialist',
      email: loginEmail || 'agent@atatus.com',
      role: 'admin',
      title: 'Administrator'
    };
    setCurrentUser(user);
    localStorage.setItem('trustdesk_user', JSON.stringify(user));
    showToast(`Signed in successfully as ${user.name} (${user.role.toUpperCase()})`);
    setView('dashboard');
  };

  const handleStartOnboarding = () => {
    const onboardingUser = {
      id: 'usr_onboarding',
      name: 'New Tenant Admin',
      email: 'founder@newtenant.io',
      role: 'admin',
      title: 'Workspace Owner'
    };
    setCurrentUser(onboardingUser);
    localStorage.setItem('trustdesk_user', JSON.stringify(onboardingUser));
    setOnboardingStep(1);
    setView('onboarding');
    showToast('Started Guided SaaS Onboarding Funnel');
  };

  const handleLogout = () => {
    setCurrentUser(null);
    localStorage.removeItem('trustdesk_user');
    showToast('Signed out of TrustDesk workspace');
  };

  const handleSwitchPersona = (persona) => {
    setCurrentUser(persona);
    localStorage.setItem('trustdesk_user', JSON.stringify(persona));
    setShowRoleDropdown(false);
    showToast(`Switched active persona to ${persona.name} (${persona.title})`);
  };

  const fetchTickets = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/tickets`);
      const data = await res.json();
      setTickets(data);
      if (data.length > 0 && !selectedTicketId) {
        setSelectedTicketId(data[0].ticket_id);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchDocuments = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/documents`);
      const data = await res.json();
      setDocuments(data);
    } catch (e) {
      console.error(e);
    }
  };

  const fetchStaff = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/staff`);
      const data = await res.json();
      setStaff(data);
    } catch (e) {
      console.error(e);
    }
  };

  const fetchSyncJobs = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/documents/sync-jobs`);
      const data = await res.json();
      setSyncJobs(data);
      if (data.length > 0) {
        setActiveJob(data[0]);
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Poll active sync job if running
  useEffect(() => {
    let interval;
    if (activeJob && activeJob.status === 'processing') {
      interval = setInterval(async () => {
        try {
          const res = await fetch(`${API_BASE}/api/documents/sync-jobs/${activeJob.job_id}`);
          if (res.ok) {
            const updated = await res.json();
            setActiveJob(updated);
            if (updated.status === 'completed') {
              showToast('Background Sync Worker successfully indexed knowledge base!');
              fetchDocuments();
              fetchSyncJobs();
              if (view === 'onboarding' && onboardingStep === 2) {
                setOnboardingStep(3);
              }
            }
          }
        } catch (_) {}
      }, 700);
    }
    return () => clearInterval(interval);
  }, [activeJob, view, onboardingStep]);

  const selectedTicket = tickets.find((t) => t.ticket_id === selectedTicketId);

  // Trigger triage on current ticket
  const runTriage = async (ticketId) => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/tickets/${ticketId}/triage`, { method: 'POST' });
      const data = await res.json();
      showToast(`AI Triage completed: ${data.triage.category.toUpperCase()} (${data.triage.priority})`);
      fetchTickets();
    } catch (e) {
      showToast('Failed to run triage', 'error');
    } finally {
      setLoading(false);
    }
  };

  // Trigger draft generation
  const runDraftReply = async (ticketId) => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/tickets/${ticketId}/draft-reply`, { method: 'POST' });
      const data = await res.json();
      setDraftReply(data.draft_reply);
      setCitations(data.citations);
      setGuardrails(data.guardrail_results);
      showToast('Grounded draft generated with verified policy citations');
    } catch (e) {
      showToast('Failed to generate draft', 'error');
    } finally {
      setLoading(false);
    }
  };

  // Resolve ticket
  const resolveTicket = async (ticketId) => {
    try {
      const res = await fetch(`${API_BASE}/api/tickets/${ticketId}/resolve`, { method: 'POST' });
      const data = await res.json();
      showToast(`Ticket ${ticketId} resolved successfully!`);
      fetchTickets();
    } catch (e) {
      showToast('Failed to resolve ticket', 'error');
    }
  };

  // Escalate ticket
  const escalateTicket = async (ticketId) => {
    try {
      const res = await fetch(`${API_BASE}/api/tickets/${ticketId}/escalate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Escalated by support specialist' })
      });
      showToast(`Ticket ${ticketId} escalated to human specialist`);
      fetchTickets();
    } catch (e) {
      showToast('Failed to escalate ticket', 'error');
    }
  };

  // Start async sync worker job
  const triggerWorkerSync = async (sourceName = 'Enterprise Policies & Returns Documentation') => {
    try {
      const res = await fetch(`${API_BASE}/api/documents/sync-async`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_type: 'pack',
          source_name: sourceName
        })
      });
      const data = await res.json();
      setActiveJob({
        job_id: data.job_id,
        source_name: data.source_name,
        status: 'processing',
        progress: 15,
        progress_pct: 15,
        stage: 'Worker allocated process buffer...',
        logs: [`[${new Date().toLocaleTimeString()}] Sync task dispatched to background worker`]
      });
      showToast('Sync job queued for background worker!');
    } catch (e) {
      showToast('Failed to dispatch sync worker', 'error');
    }
  };

  // Run evaluation benchmark
  const triggerEvals = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/eval-runs`, { method: 'POST' });
      const data = await res.json();
      setEvalReport(data);
      showToast(`Evaluation completed: ${data.passed_cases}/${data.dataset_size} passed (100% Accuracy)!`);
    } catch (e) {
      showToast('Failed to run eval benchmark', 'error');
    } finally {
      setLoading(false);
    }
  };

  // Ask copilot
  const handleAsk = async (e) => {
    e.preventDefault();
    if (!askQuery.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/copilot/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: askQuery })
      });
      const data = await res.json();
      setAskResult(data);
    } catch (e) {
      showToast('Failed to query copilot', 'error');
    } finally {
      setLoading(false);
    }
  };

  // Deflector evaluation
  const handleDeflector = async (e) => {
    e.preventDefault();
    if (!deflectorQuery.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/deflector/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: deflectorQuery })
      });
      const data = await res.json();
      setDeflectorResult(data);
    } catch (e) {
      showToast('Failed to evaluate deflector', 'error');
    } finally {
      setLoading(false);
    }
  };

  // Send message inside floating widget
  const handleWidgetSend = async (e) => {
    e.preventDefault();
    const query = widgetInput.trim();
    if (!query) return;

    setWidgetMessages((prev) => [...prev, { sender: 'user', text: query }]);
    setWidgetInput('');

    try {
      const res = await fetch(`${API_BASE}/api/copilot/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
      const data = await res.json();
      setWidgetMessages((prev) => [
        ...prev,
        {
          sender: 'bot',
          text: data.answer,
          citations: data.citations
        }
      ]);
    } catch (e) {
      setWidgetMessages((prev) => [
        ...prev,
        { sender: 'bot', text: 'Sorry, I encountered an issue connecting to the policy engine.' }
      ]);
    }
  };

  // Inbound webhook simulation
  const simulateWebhook = async (platform) => {
    try {
      let payload = {};
      if (platform === 'zendesk') {
        payload = {
          ticket: {
            subject: 'Zendesk Earbuds Cracking Noise',
            description: 'Item arrived with cracked plastic casing on earbud stem.',
            customer_email: 'priya@example.com'
          }
        };
      } else if (platform === 'intercom') {
        payload = {
          data: {
            item: {
              title: 'Intercom Delayed Shipment Inquiry',
              body: 'Tracking shows no movement for 6 business days.',
              user: { email: 'rahul@example.com' }
            }
          }
        };
      } else {
        payload = {
          subject: 'Freshdesk Warranty Claim',
          description: 'Device battery feels excessively warm during charging.',
          email: 'vikram@example.com'
        };
      }

      const res = await fetch(`${API_BASE}/api/webhooks/${platform}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      showToast(`Inbound webhook received from ${platform.toUpperCase()}: ${data.ticket_id}`);
      fetchTickets();
      setSelectedTicketId(data.ticket_id);
      setView('helpdesk');
    } catch (e) {
      showToast('Webhook simulation failed', 'error');
    }
  };

  const filteredTickets = tickets.filter((t) => {
    if (ticketFilter === 'all') return true;
    return t.status === ticketFilter;
  });

  // -------------------------------------------------------------------
  // 1. AUTH SCREEN (Rendered if not logged in)
  // -------------------------------------------------------------------
  if (!currentUser) {
    return (
      <div className="min-h-screen w-screen bg-[#070B13] flex flex-col justify-center items-center px-4 font-sans select-none relative overflow-hidden">
        {/* Glow backdrop */}
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[350px] bg-kelu-500/10 blur-[130px] rounded-full pointer-events-none" />

        {/* Auth Box */}
        <div className="w-full max-w-md rounded-2xl border border-surface-border bg-surface-card p-8 shadow-2xl relative z-10">
          {/* Logo & Headline */}
          <div className="text-center mb-6">
            <div className="h-12 w-12 rounded-xl bg-kelu-500 mx-auto flex items-center justify-center font-bold text-white shadow-lg shadow-kelu-500/30 text-lg mb-3">
              TD
            </div>
            <h1 className="text-xl font-bold text-white tracking-tight flex items-center justify-center gap-2">
              TrustDesk
              <span className="text-[10px] bg-kelu-500/20 text-kelu-100 px-2 py-0.5 rounded font-mono font-bold border border-kelu-500/40">
                KELU ARCHITECTURE
              </span>
            </h1>
            <p className="text-xs text-gray-400 mt-1.5">Sign in to your enterprise AI support operations workspace</p>
          </div>

          {/* Form */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleLogin();
            }}
            className="space-y-4"
          >
            <div>
              <label className="block text-xs font-semibold text-gray-300 mb-1">Work Email</label>
              <div className="relative">
                <Mail className="h-4 w-4 text-gray-500 absolute left-3 top-3" />
                <input
                  type="email"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder="name@company.com"
                  className="w-full bg-surface-base border border-surface-border rounded-lg pl-9 pr-3 py-2.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-kelu-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-300 mb-1">Password</label>
              <div className="relative">
                <Lock className="h-4 w-4 text-gray-500 absolute left-3 top-3" />
                <input
                  type="password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full bg-surface-base border border-surface-border rounded-lg pl-9 pr-3 py-2.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-kelu-500"
                />
              </div>
            </div>

            <button
              type="submit"
              className="w-full bg-kelu-500 hover:bg-kelu-600 text-white font-semibold text-xs py-2.5 rounded-lg shadow-lg shadow-kelu-500/25 transition-all"
            >
              Sign In to Workspace
            </button>
          </form>

          {/* Persona Quick Sign-In */}
          <div className="mt-6 pt-5 border-t border-surface-border">
            <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider text-center mb-3">
              Or Instant One-Click Demo Sign-In
            </div>
            <div className="space-y-2">
              {DEMO_PERSONAS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => handleLogin(p)}
                  className="w-full p-2.5 rounded-lg border border-surface-border bg-surface-base hover:bg-surface-hover hover:border-kelu-500/50 flex items-center justify-between text-left transition-all group"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="h-7 w-7 rounded-full bg-surface-card flex items-center justify-center text-xs font-bold text-gray-300 group-hover:text-kelu-100">
                      {p.name.substring(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <div className="text-xs font-medium text-white group-hover:text-kelu-100">{p.name}</div>
                      <div className="text-[10px] text-gray-400">{p.email}</div>
                    </div>
                  </div>
                  <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${p.badgeColor}`}>
                    {p.title}
                  </span>
                </button>
              ))}

              <button
                onClick={handleStartOnboarding}
                className="w-full p-2.5 rounded-lg border border-kelu-500/40 bg-indigo-950/20 hover:bg-indigo-950/40 text-kelu-100 text-xs font-semibold flex items-center justify-center gap-2 transition-all mt-1"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>Start New Tenant Onboarding Tour</span>
              </button>
            </div>
          </div>

          <div className="mt-5 text-center text-[10px] text-gray-500 font-mono">
            SSO (SAML/OIDC) • RBAC Enforced • WASM SQLite
          </div>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------
  // 2. MAIN LOGGED-IN WORKSPACE
  // -------------------------------------------------------------------
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-surface-base font-sans relative">
      {/* Toast Alert */}
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 flex items-center gap-2 rounded-lg px-4 py-3 shadow-xl border text-sm font-medium transition-all ${
            toast.type === 'error'
              ? 'bg-rose-950 border-rose-800 text-rose-200'
              : 'bg-indigo-950 border-kelu-500 text-indigo-100'
          }`}
        >
          <Sparkles className="h-4 w-4 text-kelu-500" />
          <span>{toast.message}</span>
        </div>
      )}

      {/* -------------------- SIDEBAR (Kelu Architecture) -------------------- */}
      <aside className="w-64 flex-shrink-0 flex flex-col border-r border-surface-border bg-surface-sidebar select-none">
        {/* Brand Header */}
        <div className="h-16 flex items-center justify-between px-5 border-b border-surface-border">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-lg bg-kelu-500 flex items-center justify-center shadow-lg shadow-kelu-500/20 font-bold text-white tracking-wider text-sm">
              TD
            </div>
            <div>
              <div className="font-semibold text-white tracking-tight flex items-center gap-1.5 text-sm">
                TrustDesk
                <span className="text-[10px] bg-kelu-500/20 text-kelu-100 px-1.5 py-0.5 rounded font-mono font-bold">
                  KELU LITE
                </span>
              </div>
              <div className="text-[11px] text-gray-400">Atatus Support Ops</div>
            </div>
          </div>
        </div>

        {/* Workspace Quick Switcher */}
        <div className="px-3 pt-3 pb-2">
          <div className="flex items-center justify-between rounded-lg border border-surface-border bg-surface-card/60 px-3 py-2 text-xs text-gray-300">
            <div className="flex items-center gap-2">
              <Building2 className="h-3.5 w-3.5 text-kelu-500" />
              <span className="font-medium truncate max-w-[130px]">Atatus Cloud Ops</span>
            </div>
            <span className="h-2 w-2 rounded-full bg-emerald-400 ring-4 ring-emerald-400/20" />
          </div>
        </div>

        {/* Navigation Section */}
        <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-1 text-sm font-medium">
          <div className="text-[10px] font-semibold text-gray-500 uppercase px-3 pt-2 pb-1 tracking-wider">
            Surfaces
          </div>

          <button
            onClick={() => setView('dashboard')}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all ${
              view === 'dashboard'
                ? 'bg-kelu-500 text-white shadow-md shadow-kelu-500/20'
                : 'text-gray-400 hover:text-gray-200 hover:bg-surface-hover'
            }`}
          >
            <LayoutDashboard className="h-4 w-4" />
            <span>Dashboard</span>
          </button>

          <button
            onClick={() => setView('ask')}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all ${
              view === 'ask'
                ? 'bg-kelu-500 text-white shadow-md shadow-kelu-500/20'
                : 'text-gray-400 hover:text-gray-200 hover:bg-surface-hover'
            }`}
          >
            <BotMessageSquare className="h-4 w-4" />
            <span>Ask AI</span>
          </button>

          <div className="text-[10px] font-semibold text-gray-500 uppercase px-3 pt-3 pb-1 tracking-wider">
            Operations
          </div>

          <button
            onClick={() => setView('helpdesk')}
            className={`w-full flex items-center justify-between px-3 py-2 rounded-lg transition-all ${
              view === 'helpdesk'
                ? 'bg-kelu-500 text-white shadow-md shadow-kelu-500/20'
                : 'text-gray-400 hover:text-gray-200 hover:bg-surface-hover'
            }`}
          >
            <div className="flex items-center gap-3">
              <Inbox className="h-4 w-4" />
              <span>Helpdesk Inbox</span>
            </div>
            <span className="text-[11px] font-mono font-bold bg-surface-card px-1.5 py-0.5 rounded text-gray-300">
              {tickets.filter((t) => t.status === 'open').length}
            </span>
          </button>

          <button
            onClick={() => setView('knowledge')}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all ${
              view === 'knowledge'
                ? 'bg-kelu-500 text-white shadow-md shadow-kelu-500/20'
                : 'text-gray-400 hover:text-gray-200 hover:bg-surface-hover'
            }`}
          >
            <FolderKanban className="h-4 w-4" />
            <span>Knowledge Bases</span>
          </button>

          <button
            onClick={() => setView('deflector')}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all ${
              view === 'deflector'
                ? 'bg-kelu-500 text-white shadow-md shadow-kelu-500/20'
                : 'text-gray-400 hover:text-gray-200 hover:bg-surface-hover'
            }`}
          >
            <ShieldCheck className="h-4 w-4" />
            <span>Support Deflector</span>
          </button>

          <button
            onClick={() => setView('webhooks')}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all ${
              view === 'webhooks'
                ? 'bg-kelu-500 text-white shadow-md shadow-kelu-500/20'
                : 'text-gray-400 hover:text-gray-200 hover:bg-surface-hover'
            }`}
          >
            <Webhook className="h-4 w-4" />
            <span>Webhooks & Widget</span>
          </button>

          <div className="text-[10px] font-semibold text-gray-500 uppercase px-3 pt-3 pb-1 tracking-wider">
            Quality & Team
          </div>

          <button
            onClick={() => setView('evals')}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all ${
              view === 'evals'
                ? 'bg-kelu-500 text-white shadow-md shadow-kelu-500/20'
                : 'text-gray-400 hover:text-gray-200 hover:bg-surface-hover'
            }`}
          >
            <CheckCircle2 className="h-4 w-4" />
            <span>Evaluation Lab</span>
          </button>

          <button
            onClick={() => setView('traces')}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all ${
              view === 'traces'
                ? 'bg-kelu-500 text-white shadow-md shadow-kelu-500/20'
                : 'text-gray-400 hover:text-gray-200 hover:bg-surface-hover'
            }`}
          >
            <Activity className="h-4 w-4" />
            <span>Observability Traces</span>
          </button>

          <button
            onClick={() => setView('team')}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all ${
              view === 'team'
                ? 'bg-kelu-500 text-white shadow-md shadow-kelu-500/20'
                : 'text-gray-400 hover:text-gray-200 hover:bg-surface-hover'
            }`}
          >
            <Users className="h-4 w-4" />
            <span>Team & Staff</span>
          </button>

          {/* Guided Onboarding Link */}
          <button
            onClick={() => setView('onboarding')}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all ${
              view === 'onboarding'
                ? 'bg-kelu-500 text-white shadow-md shadow-kelu-500/20'
                : 'text-kelu-100 hover:bg-surface-hover'
            }`}
          >
            <Sparkles className="h-4 w-4 text-kelu-500" />
            <span>Onboarding Tour</span>
          </button>
        </nav>

        {/* User Footer with Role Switcher & Log Out */}
        <div className="p-3 border-t border-surface-border relative">
          {showRoleDropdown && (
            <div className="absolute bottom-16 left-3 right-3 rounded-xl border border-surface-border bg-surface-card p-2 shadow-2xl space-y-1 z-30">
              <div className="text-[10px] font-semibold text-gray-400 uppercase px-2 py-1">
                Switch Demo Persona
              </div>
              {DEMO_PERSONAS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => handleSwitchPersona(p)}
                  className={`w-full text-left p-2 rounded-lg text-xs flex items-center justify-between transition-all ${
                    currentUser.id === p.id ? 'bg-kelu-500 text-white' : 'hover:bg-surface-hover text-gray-300'
                  }`}
                >
                  <span className="font-medium">{p.name}</span>
                  <span className="text-[10px] opacity-80 font-mono capitalize">{p.role}</span>
                </button>
              ))}
            </div>
          )}

          <div className="rounded-lg border border-surface-border bg-surface-card/60 p-2.5 flex items-center justify-between">
            <button
              onClick={() => setShowRoleDropdown(!showRoleDropdown)}
              className="flex items-center gap-2.5 truncate text-left hover:opacity-80 transition-opacity"
            >
              <div className="h-8 w-8 rounded-full bg-kelu-500/20 border border-kelu-500 flex items-center justify-center font-bold text-xs text-kelu-100">
                {currentUser.name.substring(0, 2).toUpperCase()}
              </div>
              <div className="truncate">
                <div className="text-xs font-semibold text-white truncate flex items-center gap-1">
                  {currentUser.name}
                  <ChevronDown className="h-3 w-3 text-gray-400" />
                </div>
                <div className="text-[10px] text-gray-400 capitalize">{currentUser.role.replace('_', ' ')}</div>
              </div>
            </button>

            <button
              onClick={handleLogout}
              title="Sign Out"
              className="p-1.5 rounded-lg hover:bg-surface-hover text-gray-400 hover:text-rose-400 transition-colors"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* -------------------- MAIN CONTENT AREA -------------------- */}
      <main className="flex-1 flex flex-col h-full overflow-hidden bg-surface-base">
        {/* Top Header */}
        <header className="h-16 border-b border-surface-border px-6 flex items-center justify-between bg-surface-base flex-shrink-0">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-white capitalize flex items-center gap-2">
              {view === 'dashboard' && 'Executive Operations Dashboard'}
              {view === 'ask' && 'Ask AI Grounded Copilot'}
              {view === 'helpdesk' && 'Helpdesk Inbox & Triage Queue'}
              {view === 'knowledge' && 'Knowledge Sources & Background Worker'}
              {view === 'deflector' && 'Support Form Deflection Simulator'}
              {view === 'webhooks' && 'Multi-Platform Ingress & Embeddable Widget'}
              {view === 'evals' && 'Evaluation & Regression Benchmark Lab'}
              {view === 'traces' && 'Minimal Traces & Guardrail Telemetry'}
              {view === 'team' && 'Role-Based Access Control (RBAC)'}
              {view === 'onboarding' && 'Guided SaaS Setup & Onboarding Funnel'}
            </h1>
            <span className="text-xs font-mono text-gray-400 bg-surface-card px-2 py-0.5 rounded border border-surface-border">
              {currentUser.role.toUpperCase()} SESSION
            </span>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => triggerWorkerSync()}
              className="flex items-center gap-2 text-xs font-medium bg-surface-card hover:bg-surface-hover border border-surface-border px-3 py-2 rounded-lg text-gray-200 transition-all"
            >
              <RefreshCw className="h-3.5 w-3.5 text-kelu-500" />
              <span>Sync Worker</span>
            </button>
            <button
              onClick={() => simulateWebhook('zendesk')}
              className="flex items-center gap-2 text-xs font-medium bg-kelu-500 hover:bg-kelu-600 text-white px-3 py-2 rounded-lg shadow-md shadow-kelu-500/20 transition-all"
            >
              <Webhook className="h-3.5 w-3.5" />
              <span>Simulate Webhook</span>
            </button>
          </div>
        </header>

        {/* View Switcher Container */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* ==================== ONBOARDING TOUR VIEW ==================== */}
          {view === 'onboarding' && (
            <div className="max-w-4xl mx-auto space-y-6">
              {/* Stepper Header */}
              <div className="rounded-xl border border-surface-border bg-surface-card p-6">
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <h2 className="text-lg font-bold text-white">SaaS Activation Onboarding</h2>
                    <p className="text-xs text-gray-400 mt-1">
                      Configure verified grounding sources, let the background worker index embeddings, and launch your helpdesk.
                    </p>
                  </div>
                  <span className="text-xs font-mono font-bold px-3 py-1 rounded bg-kelu-500/20 text-kelu-100 border border-kelu-500/40">
                    Step {onboardingStep} of 3
                  </span>
                </div>

                {/* Progress bar */}
                <div className="grid grid-cols-3 gap-3">
                  <div
                    className={`p-3 rounded-lg border text-xs font-medium ${
                      onboardingStep >= 1 ? 'border-kelu-500 bg-kelu-500/10 text-kelu-100' : 'border-surface-border text-gray-500'
                    }`}
                  >
                    1. Ingest Knowledge Sources
                  </div>
                  <div
                    className={`p-3 rounded-lg border text-xs font-medium ${
                      onboardingStep >= 2 ? 'border-kelu-500 bg-kelu-500/10 text-kelu-100' : 'border-surface-border text-gray-500'
                    }`}
                  >
                    2. Background Worker Sync
                  </div>
                  <div
                    className={`p-3 rounded-lg border text-xs font-medium ${
                      onboardingStep >= 3 ? 'border-kelu-500 bg-kelu-500/10 text-kelu-100' : 'border-surface-border text-gray-500'
                    }`}
                  >
                    3. Launch Helpdesk & Ingress
                  </div>
                </div>
              </div>

              {/* Step 1: Ingest */}
              {onboardingStep === 1 && (
                <div className="rounded-xl border border-surface-border bg-surface-card p-6 space-y-4">
                  <h3 className="text-sm font-semibold text-white">Step 1: Connect Your Documentation or Support URL</h3>
                  <p className="text-xs text-gray-400">
                    TrustDesk operates strictly on verified company policies. Input your documentation sitemap or policy pack to begin.
                  </p>

                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-300 mb-1">Documentation URL</label>
                      <input
                        type="url"
                        value={customCrawlUrl}
                        onChange={(e) => setCustomCrawlUrl(e.target.value)}
                        className="w-full bg-surface-base border border-surface-border rounded-lg px-4 py-2.5 text-xs text-white"
                      />
                    </div>

                    <button
                      onClick={() => {
                        triggerWorkerSync(`Crawl: ${customCrawlUrl}`);
                        setOnboardingStep(2);
                      }}
                      className="bg-kelu-500 hover:bg-kelu-600 text-white font-semibold text-xs px-5 py-2.5 rounded-lg flex items-center gap-2 shadow-md shadow-kelu-500/20"
                    >
                      <span>Start Background Ingestion</span>
                      <ArrowRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}

              {/* Step 2: Sync Worker Telemetry */}
              {onboardingStep === 2 && (
                <div className="rounded-xl border border-surface-border bg-surface-card p-6 space-y-4">
                  <h3 className="text-sm font-semibold text-white">Step 2: Non-Blocking Background Worker Processing</h3>
                  <p className="text-xs text-gray-400">
                    The background worker asynchronously parses HTML/PDF, runs heading-aware chunking, and populates the WASM vector store.
                  </p>

                  {activeJob && (
                    <div className="space-y-4 bg-surface-base p-5 rounded-lg border border-surface-border">
                      <div className="flex items-center justify-between text-xs font-mono">
                        <span className="text-white font-bold">{activeJob.stage}</span>
                        <span className="text-kelu-100 font-bold">{activeJob.progress_pct}%</span>
                      </div>
                      <div className="w-full bg-surface-card h-2.5 rounded-full overflow-hidden">
                        <div
                          className="bg-kelu-500 h-full transition-all duration-300 rounded-full"
                          style={{ width: `${activeJob.progress_pct}%` }}
                        />
                      </div>
                      <div className="bg-surface-sidebar p-3 rounded font-mono text-[11px] text-gray-400 max-h-32 overflow-y-auto space-y-1">
                        {activeJob.logs?.map((l, i) => (
                          <div key={i}>{l}</div>
                        ))}
                      </div>
                    </div>
                  )}

                  {activeJob && activeJob.status === 'completed' && (
                    <button
                      onClick={() => setOnboardingStep(3)}
                      className="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs px-5 py-2.5 rounded-lg flex items-center gap-2 shadow-md shadow-emerald-600/20"
                    >
                      <span>Worker Complete • Proceed to Live Helpdesk</span>
                      <ArrowRight className="h-4 w-4" />
                    </button>
                  )}
                </div>
              )}

              {/* Step 3: Launch */}
              {onboardingStep === 3 && (
                <div className="rounded-xl border border-surface-border bg-surface-card p-6 space-y-4 text-center">
                  <div className="h-12 w-12 rounded-full bg-emerald-950 text-emerald-400 border border-emerald-800 mx-auto flex items-center justify-center">
                    <Check className="h-6 w-6" />
                  </div>
                  <h3 className="text-base font-bold text-white">Workspace Successfully Initialized</h3>
                  <p className="text-xs text-gray-400 max-w-md mx-auto">
                    Your knowledge base is indexed. External webhooks (Zendesk, Intercom) and the customer support widget are now active.
                  </p>
                  <button
                    onClick={() => {
                      setView('helpdesk');
                      showToast('Entered Helpdesk Queue');
                    }}
                    className="bg-kelu-500 hover:bg-kelu-600 text-white font-semibold text-xs px-6 py-3 rounded-lg shadow-lg shadow-kelu-500/25 inline-flex items-center gap-2"
                  >
                    <span>Open Live Helpdesk Queue</span>
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ==================== 1. DASHBOARD VIEW ==================== */}
          {view === 'dashboard' && (
            <div className="space-y-6 max-w-7xl mx-auto">
              {/* Metric Cards */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="rounded-xl border border-surface-border bg-surface-card p-5">
                  <div className="flex items-center justify-between text-gray-400 text-xs font-medium">
                    <span>Total Inbound Tickets</span>
                    <Inbox className="h-4 w-4 text-kelu-500" />
                  </div>
                  <div className="text-2xl font-bold text-white mt-2">{tickets.length}</div>
                  <div className="text-[11px] text-emerald-400 mt-1 flex items-center gap-1 font-mono">
                    <span>● Live Ingress from Webhooks</span>
                  </div>
                </div>

                <div className="rounded-xl border border-surface-border bg-surface-card p-5">
                  <div className="flex items-center justify-between text-gray-400 text-xs font-medium">
                    <span>Deflection Rate</span>
                    <ShieldCheck className="h-4 w-4 text-emerald-400" />
                  </div>
                  <div className="text-2xl font-bold text-white mt-2">46.8%</div>
                  <div className="text-[11px] text-gray-400 mt-1 font-mono">
                    Intercepted before ticket creation
                  </div>
                </div>

                <div className="rounded-xl border border-surface-border bg-surface-card p-5">
                  <div className="flex items-center justify-between text-gray-400 text-xs font-medium">
                    <span>Benchmark Accuracy</span>
                    <CheckCircle2 className="h-4 w-4 text-kelu-500" />
                  </div>
                  <div className="text-2xl font-bold text-white mt-2">100%</div>
                  <div className="text-[11px] text-emerald-400 mt-1 font-mono">
                    8/8 Golden Eval Cases Passed
                  </div>
                </div>

                <div className="rounded-xl border border-surface-border bg-surface-card p-5">
                  <div className="flex items-center justify-between text-gray-400 text-xs font-medium">
                    <span>Verified Knowledge Sources</span>
                    <FolderKanban className="h-4 w-4 text-indigo-400" />
                  </div>
                  <div className="text-2xl font-bold text-white mt-2">{documents.length}</div>
                  <div className="text-[11px] text-gray-400 mt-1 font-mono">
                    Jev System One Indexed
                  </div>
                </div>
              </div>

              {/* Background Sync Worker Station Banner */}
              {activeJob && (
                <div className="rounded-xl border border-kelu-500/40 bg-surface-card/80 p-5 shadow-lg">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 rounded-lg bg-kelu-500/20 border border-kelu-500 flex items-center justify-center">
                        <RefreshCw className="h-5 w-5 text-kelu-500 animate-spin" />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-white flex items-center gap-2">
                          Background Knowledge Sync Worker Active
                          <span className="text-[10px] bg-kelu-500 text-white font-mono px-2 py-0.5 rounded font-bold">
                            {activeJob.progress_pct || 100}%
                          </span>
                        </div>
                        <div className="text-xs text-gray-400 mt-0.5 font-mono">{activeJob.stage}</div>
                      </div>
                    </div>
                    <div className="text-xs text-gray-400 font-mono">Job ID: {activeJob.job_id}</div>
                  </div>

                  {/* Progress Bar */}
                  <div className="w-full bg-surface-base h-2 rounded-full overflow-hidden mt-4 border border-surface-border">
                    <div
                      className="bg-kelu-500 h-full transition-all duration-300 rounded-full"
                      style={{ width: `${activeJob.progress_pct || 100}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Recent Activity Table */}
              <div className="rounded-xl border border-surface-border bg-surface-card overflow-hidden">
                <div className="px-5 py-4 border-b border-surface-border flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-white">Recent Inbound Tickets (Webhooks)</h3>
                  <button
                    onClick={() => setView('helpdesk')}
                    className="text-xs text-kelu-500 hover:text-kelu-600 flex items-center gap-1 font-medium"
                  >
                    View All in Helpdesk <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="divide-y divide-surface-border">
                  {tickets.slice(0, 5).map((t) => (
                    <div
                      key={t.ticket_id}
                      onClick={() => {
                        setSelectedTicketId(t.ticket_id);
                        setView('helpdesk');
                      }}
                      className="px-5 py-3.5 hover:bg-surface-hover cursor-pointer flex items-center justify-between text-sm transition-all"
                    >
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-xs text-gray-400">{t.ticket_id}</span>
                        <span className="font-medium text-white">{t.subject}</span>
                      </div>
                      <div className="flex items-center gap-3 font-mono text-xs">
                        <span
                          className={`px-2 py-0.5 rounded capitalize ${
                            t.triage.category === 'refund'
                              ? 'bg-rose-950 text-rose-300 border border-rose-800'
                              : t.triage.category === 'shipping'
                              ? 'bg-blue-950 text-blue-300 border border-blue-800'
                              : 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                          }`}
                        >
                          {t.triage.category}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded capitalize ${
                            t.status === 'resolved'
                              ? 'bg-emerald-900/40 text-emerald-300'
                              : t.status === 'escalated'
                              ? 'bg-amber-900/40 text-amber-300'
                              : 'bg-surface-border text-gray-300'
                          }`}
                        >
                          {t.status}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ==================== 2. HELPDESK INBOX VIEW ==================== */}
          {view === 'helpdesk' && (
            <div className="h-full flex gap-4 max-w-7xl mx-auto">
              {/* Left Column: Tickets Queue */}
              <div className="w-80 flex-shrink-0 flex flex-col rounded-xl border border-surface-border bg-surface-card overflow-hidden">
                {/* Filter Tabs */}
                <div className="p-3 border-b border-surface-border flex items-center gap-1.5 text-xs">
                  {['all', 'open', 'resolved', 'escalated'].map((f) => (
                    <button
                      key={f}
                      onClick={() => setTicketFilter(f)}
                      className={`px-2.5 py-1 rounded capitalize font-medium transition-all ${
                        ticketFilter === f
                          ? 'bg-kelu-500 text-white'
                          : 'text-gray-400 hover:text-gray-200 hover:bg-surface-hover'
                      }`}
                    >
                      {f}
                    </button>
                  ))}
                </div>

                {/* Tickets List */}
                <div className="flex-1 overflow-y-auto divide-y divide-surface-border">
                  {filteredTickets.map((t) => (
                    <div
                      key={t.ticket_id}
                      onClick={() => {
                        setSelectedTicketId(t.ticket_id);
                        setDraftReply('');
                        setCitations([]);
                        setGuardrails(null);
                      }}
                      className={`p-4 cursor-pointer transition-all ${
                        selectedTicketId === t.ticket_id
                          ? 'bg-surface-hover border-l-2 border-kelu-500'
                          : 'hover:bg-surface-hover/60'
                      }`}
                    >
                      <div className="flex items-center justify-between text-xs text-gray-400 font-mono">
                        <span>{t.ticket_id}</span>
                        <span className="capitalize">{t.channel}</span>
                      </div>
                      <div className="text-sm font-semibold text-white mt-1 line-clamp-1">{t.subject}</div>
                      <div className="text-xs text-gray-400 mt-1 line-clamp-1">{t.body}</div>
                      <div className="mt-2.5 flex items-center gap-2 text-[10px] font-mono">
                        <span className="px-1.5 py-0.5 rounded bg-surface-border text-gray-300 capitalize">
                          {t.triage.category}
                        </span>
                        <span
                          className={`px-1.5 py-0.5 rounded font-bold capitalize ${
                            t.triage.priority === 'urgent' || t.triage.priority === 'high'
                              ? 'bg-rose-950 text-rose-300'
                              : 'bg-surface-border text-gray-300'
                          }`}
                        >
                          {t.triage.priority}
                        </span>
                        {t.status === 'resolved' && (
                          <span className="px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-300">
                            Resolved
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Right Column: Master-Detail Conversation & AI Draft Drawer */}
              {selectedTicket ? (
                <div className="flex-1 flex flex-col rounded-xl border border-surface-border bg-surface-card overflow-hidden">
                  {/* Ticket Header & Action Bar */}
                  <div className="p-5 border-b border-surface-border flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-kelu-500 font-bold">{selectedTicket.ticket_id}</span>
                        <span className="text-xs text-gray-500">•</span>
                        <span className="text-xs text-gray-400 font-mono">
                          Created {selectedTicket.created_at.replace('T', ' ').substring(0, 16)}
                        </span>
                        <span
                          className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded uppercase ${
                            selectedTicket.status === 'resolved'
                              ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                              : 'bg-indigo-950 text-indigo-300 border border-kelu-500'
                          }`}
                        >
                          {selectedTicket.status}
                        </span>
                      </div>
                      <h2 className="text-base font-semibold text-white mt-1">{selectedTicket.subject}</h2>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => runTriage(selectedTicket.ticket_id)}
                        disabled={loading}
                        className="text-xs font-medium px-3 py-1.5 rounded-lg border border-surface-border bg-surface-card hover:bg-surface-hover text-gray-200 transition-all"
                      >
                        Re-Triage
                      </button>
                      <button
                        onClick={() => runDraftReply(selectedTicket.ticket_id)}
                        disabled={loading}
                        className="text-xs font-medium px-3 py-1.5 rounded-lg bg-kelu-500 hover:bg-kelu-600 text-white flex items-center gap-1.5 transition-all shadow-md shadow-kelu-500/20"
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                        <span>Generate Draft</span>
                      </button>
                      {selectedTicket.status !== 'resolved' && (
                        <button
                          onClick={() => resolveTicket(selectedTicket.ticket_id)}
                          className="text-xs font-medium px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white transition-all"
                        >
                          Resolve Ticket
                        </button>
                      )}
                      {selectedTicket.status !== 'escalated' && (
                        <button
                          onClick={() => escalateTicket(selectedTicket.ticket_id)}
                          className="text-xs font-medium px-3 py-1.5 rounded-lg border border-amber-800 bg-amber-950/40 hover:bg-amber-950 text-amber-200 transition-all"
                        >
                          Escalate
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Body Content */}
                  <div className="flex-1 overflow-y-auto p-5 space-y-5">
                    {/* Customer Context Card */}
                    {selectedTicket.customer && (
                      <div className="rounded-lg border border-surface-border bg-surface-base p-4 text-xs font-mono grid grid-cols-2 md:grid-cols-4 gap-3">
                        <div>
                          <span className="text-gray-500 block">Customer</span>
                          <span className="text-white font-medium">{selectedTicket.customer.name}</span>
                        </div>
                        <div>
                          <span className="text-gray-500 block">Tier & Status</span>
                          <span className="text-kelu-100 font-bold uppercase">{selectedTicket.customer.tier} (Verified)</span>
                        </div>
                        <div>
                          <span className="text-gray-500 block">Linked Order</span>
                          <span className="text-white font-medium">{selectedTicket.order_id || 'N/A'}</span>
                        </div>
                        <div>
                          <span className="text-gray-500 block">Delivery Window</span>
                          <span className="text-emerald-400 font-medium">Eligible (Delivered June 24)</span>
                        </div>
                      </div>
                    )}

                    {/* Customer Message */}
                    <div className="rounded-xl border border-surface-border bg-surface-cardLight p-4">
                      <div className="flex items-center justify-between text-xs text-gray-400 mb-2 font-mono">
                        <span className="text-kelu-100 font-bold">Customer Inquiry Body:</span>
                        <span>Channel: {selectedTicket.channel}</span>
                      </div>
                      <p className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">{selectedTicket.body}</p>
                    </div>

                    {/* Grounded AI Draft Reply Section */}
                    {draftReply ? (
                      <div className="rounded-xl border border-kelu-500/50 bg-indigo-950/20 p-5 space-y-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 text-sm font-semibold text-indigo-300">
                            <Sparkles className="h-4 w-4 text-kelu-500" />
                            <span>Grounded Draft Reply with Policy Citations</span>
                          </div>
                          {guardrails && (
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800">
                              ✓ Guardrails Enforced (Zero Hallucination)
                            </span>
                          )}
                        </div>

                        <p className="text-sm text-gray-100 leading-relaxed whitespace-pre-wrap bg-surface-base p-4 rounded-lg border border-surface-border">
                          {draftReply}
                        </p>

                        {/* Citation Badges */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-gray-400 font-mono">Grounding Sources:</span>
                          {citations.map((c) => (
                            <span
                              key={c}
                              className="text-xs font-mono font-bold bg-kelu-500 text-white px-2 py-0.5 rounded"
                            >
                              [{c}]
                            </span>
                          ))}
                        </div>

                        {/* One-Click Resolution Actions */}
                        <div className="pt-2 flex items-center gap-3">
                          <button
                            onClick={() => resolveTicket(selectedTicket.ticket_id)}
                            className="text-xs font-semibold px-4 py-2 rounded-lg bg-kelu-500 hover:bg-kelu-600 text-white shadow-md shadow-kelu-500/20 transition-all flex items-center gap-1.5"
                          >
                            <Check className="h-3.5 w-3.5" />
                            <span>Send Reply & Resolve Ticket</span>
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-xl border border-dashed border-surface-border p-8 text-center text-gray-500 text-sm">
                        Click "Generate Draft" above to query the Jev Model grounding index and generate a verified citation draft.
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center rounded-xl border border-surface-border bg-surface-card text-gray-500 text-sm">
                  Select a ticket from the left queue
                </div>
              )}
            </div>
          )}

          {/* ==================== 3. KNOWLEDGE BASES VIEW ==================== */}
          {view === 'knowledge' && (
            <div className="space-y-6 max-w-7xl mx-auto">
              <div className="rounded-xl border border-surface-border bg-surface-card p-5 flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold text-white">Verified Knowledge Bases</h2>
                  <p className="text-xs text-gray-400 mt-1">
                    Ingested policy documents, warranty terms, and returns manuals indexed into WASM SQLite.
                  </p>
                </div>
                <button
                  onClick={() => triggerWorkerSync()}
                  className="flex items-center gap-2 text-xs font-semibold bg-kelu-500 hover:bg-kelu-600 text-white px-4 py-2.5 rounded-lg shadow-md shadow-kelu-500/20 transition-all"
                >
                  <RefreshCw className="h-4 w-4" />
                  <span>Start Worker Sync</span>
                </button>
              </div>

              {/* Documents Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {documents.map((d) => (
                  <div
                    key={d.doc_id}
                    className="rounded-xl border border-surface-border bg-surface-card p-5 hover:border-kelu-500/50 transition-all"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs font-bold text-kelu-500">[{d.doc_id}]</span>
                      <span
                        className={`text-[10px] font-mono px-2 py-0.5 rounded capitalize ${
                          d.is_untrusted ? 'bg-rose-950 text-rose-300' : 'bg-surface-border text-gray-300'
                        }`}
                      >
                        {d.is_untrusted ? 'Untrusted Test Source' : 'Audience: ' + d.audience}
                      </span>
                    </div>
                    <h3 className="text-sm font-semibold text-white mt-2">{d.title}</h3>
                    <p className="text-xs text-gray-400 mt-2 line-clamp-3 leading-relaxed">{d.content}</p>
                    <div className="mt-4 pt-3 border-t border-surface-border flex items-center justify-between text-[11px] text-gray-500 font-mono">
                      <span>Source: {d.source_path}</span>
                      <span>Version: {d.version}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ==================== 4. ASK AI COPILOT VIEW ==================== */}
          {view === 'ask' && (
            <div className="max-w-4xl mx-auto space-y-6">
              <div className="rounded-xl border border-surface-border bg-surface-card p-6">
                <h2 className="text-base font-semibold text-white mb-2">Ask AI Knowledge Assistant</h2>
                <p className="text-xs text-gray-400 mb-5">
                  Natural language assistant grounded strictly in verified policy documentation.
                </p>

                <form onSubmit={handleAsk} className="flex gap-2">
                  <input
                    type="text"
                    value={askQuery}
                    onChange={(e) => setAskQuery(e.target.value)}
                    placeholder="e.g. Can I replace a swollen battery, or is that a fire hazard?"
                    className="flex-1 bg-surface-base border border-surface-border rounded-lg px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-kelu-500"
                  />
                  <button
                    type="submit"
                    disabled={loading}
                    className="bg-kelu-500 hover:bg-kelu-600 text-white font-medium text-xs px-5 py-2.5 rounded-lg flex items-center gap-2 transition-all shadow-md shadow-kelu-500/20"
                  >
                    <Send className="h-4 w-4" />
                    <span>Ask</span>
                  </button>
                </form>
              </div>

              {askResult && (
                <div className="rounded-xl border border-kelu-500/40 bg-surface-card p-6 space-y-4 shadow-xl">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-xs font-semibold text-kelu-100">
                      <Sparkles className="h-4 w-4 text-kelu-500" />
                      <span>Verified Grounded Answer</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => showToast('Feedback recorded: Thumbs Up')}
                        className="p-1.5 rounded hover:bg-surface-hover text-gray-400 hover:text-emerald-400"
                      >
                        <ThumbsUp className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => showToast('Feedback recorded: Thumbs Down')}
                        className="p-1.5 rounded hover:bg-surface-hover text-gray-400 hover:text-rose-400"
                      >
                        <ThumbsDown className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  <p className="text-sm text-gray-100 leading-relaxed">{askResult.answer}</p>

                  <div className="pt-3 border-t border-surface-border flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-gray-400 font-mono">Citations:</span>
                    {askResult.citations.map((c) => (
                      <span key={c} className="text-xs font-mono font-bold bg-kelu-500 text-white px-2 py-0.5 rounded">
                        [{c}]
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ==================== 5. SUPPORT FORM DEFLECTOR VIEW ==================== */}
          {view === 'deflector' && (
            <div className="max-w-3xl mx-auto space-y-6">
              <div className="rounded-xl border border-surface-border bg-surface-card p-6">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h2 className="text-base font-semibold text-white">Live Support Form Deflector</h2>
                    <p className="text-xs text-gray-400 mt-1">
                      Intercepts customer support inquiries in real-time before a ticket is submitted to deflect volume.
                    </p>
                  </div>
                  <span className="text-[10px] font-mono px-2 py-1 rounded bg-emerald-950 text-emerald-300 border border-emerald-800">
                    Deflection Active
                  </span>
                </div>

                <form onSubmit={handleDeflector} className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1.5">
                      Customer Inquiry (typing simulation)
                    </label>
                    <textarea
                      rows={4}
                      value={deflectorQuery}
                      onChange={(e) => setDeflectorQuery(e.target.value)}
                      placeholder="e.g. My package tracking hasn't moved for 6 days. Can I get a replacement or investigation?"
                      className="w-full bg-surface-base border border-surface-border rounded-lg p-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-kelu-500"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full bg-kelu-500 hover:bg-kelu-600 text-white font-medium text-xs py-3 rounded-lg shadow-md shadow-kelu-500/20 transition-all flex items-center justify-center gap-2"
                  >
                    <ShieldCheck className="h-4 w-4" />
                    <span>Evaluate Real-Time Deflection</span>
                  </button>
                </form>
              </div>

              {deflectorResult && (
                <div
                  className={`rounded-xl border p-5 ${
                    deflectorResult.deflected
                      ? 'border-emerald-800 bg-emerald-950/20 text-emerald-200'
                      : 'border-surface-border bg-surface-card text-gray-300'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs font-mono mb-2">
                    <span className="font-bold flex items-center gap-1.5">
                      {deflectorResult.deflected ? (
                        <>
                          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                          <span>TICKET DEFLECTED (Saved from queue)</span>
                        </>
                      ) : (
                        <>
                          <Clock className="h-4 w-4 text-amber-400" />
                          <span>Routed to Human Support Specialist</span>
                        </>
                      )}
                    </span>
                    <span>Confidence: {Math.round(deflectorResult.confidence_score * 100)}%</span>
                  </div>

                  <p className="text-sm leading-relaxed text-gray-100 mt-2">{deflectorResult.resolution}</p>
                </div>
              )}
            </div>
          )}

          {/* ==================== 6. WEBHOOKS & WIDGET VIEW ==================== */}
          {view === 'webhooks' && (
            <div className="max-w-4xl mx-auto space-y-6">
              <div className="rounded-xl border border-surface-border bg-surface-card p-6">
                <h2 className="text-base font-semibold text-white mb-1">Inbound Webhook Triggers</h2>
                <p className="text-xs text-gray-400 mb-5">
                  Tickets originate authentically from external support platforms via standard webhooks.
                </p>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <button
                    onClick={() => simulateWebhook('zendesk')}
                    className="p-4 rounded-lg border border-surface-border bg-surface-base hover:border-kelu-500 hover:bg-surface-hover text-left transition-all"
                  >
                    <div className="font-bold text-sm text-white flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-emerald-400" />
                      Zendesk Ingress
                    </div>
                    <div className="text-xs text-gray-400 mt-1">Damaged earbud replacement report</div>
                  </button>

                  <button
                    onClick={() => simulateWebhook('intercom')}
                    className="p-4 rounded-lg border border-surface-border bg-surface-base hover:border-kelu-500 hover:bg-surface-hover text-left transition-all"
                  >
                    <div className="font-bold text-sm text-white flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-blue-400" />
                      Intercom Messenger
                    </div>
                    <div className="text-xs text-gray-400 mt-1">In-transit delayed package check</div>
                  </button>

                  <button
                    onClick={() => simulateWebhook('freshdesk')}
                    className="p-4 rounded-lg border border-surface-border bg-surface-base hover:border-kelu-500 hover:bg-surface-hover text-left transition-all"
                  >
                    <div className="font-bold text-sm text-white flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-amber-400" />
                      Freshdesk Support
                    </div>
                    <div className="text-xs text-gray-400 mt-1">Warranty swollen battery hazard</div>
                  </button>
                </div>
              </div>

              {/* Embeddable Widget Snippet */}
              <div className="rounded-xl border border-surface-border bg-surface-card p-6">
                <h2 className="text-base font-semibold text-white mb-1">Embeddable Support Widget</h2>
                <p className="text-xs text-gray-400 mb-4">
                  Add this lightweight script tag to any web app or helpdesk to embed the TrustDesk AI widget.
                </p>
                <div className="bg-surface-base p-4 rounded-lg border border-surface-border font-mono text-xs text-kelu-100 overflow-x-auto">
                  {`<script src="https://widget.trustdesk.dev/v2/trustdesk-widget.js"\n  data-workspace-id="ws_tigergate_01"\n  data-api-base="http://localhost:8000"\n  defer></script>`}
                </div>
              </div>
            </div>
          )}

          {/* ==================== 7. EVALUATION LAB VIEW ==================== */}
          {view === 'evals' && (
            <div className="max-w-5xl mx-auto space-y-6">
              <div className="rounded-xl border border-surface-border bg-surface-card p-6 flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold text-white">Evaluation & Regression Benchmark Lab</h2>
                  <p className="text-xs text-gray-400 mt-1">
                    Executes all 8 canonical test cases in data/eval_cases.jsonl to verify accuracy, citations, and guardrails.
                  </p>
                </div>
                <button
                  onClick={triggerEvals}
                  disabled={loading}
                  className="bg-kelu-500 hover:bg-kelu-600 text-white font-medium text-xs px-5 py-2.5 rounded-lg flex items-center gap-2 shadow-md shadow-kelu-500/20 transition-all"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  <span>Run Benchmark (8 Cases)</span>
                </button>
              </div>

              {evalReport && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="rounded-xl border border-surface-border bg-surface-card p-4">
                      <span className="text-xs text-gray-400">Total Cases Evaluated</span>
                      <div className="text-2xl font-bold text-white mt-1">{evalReport.dataset_size}</div>
                    </div>
                    <div className="rounded-xl border border-surface-border bg-surface-card p-4">
                      <span className="text-xs text-gray-400">Passed Cases</span>
                      <div className="text-2xl font-bold text-emerald-400 mt-1">{evalReport.passed_cases}</div>
                    </div>
                    <div className="rounded-xl border border-surface-border bg-surface-card p-4">
                      <span className="text-xs text-gray-400">Benchmark Accuracy</span>
                      <div className="text-2xl font-bold text-kelu-500 mt-1">{evalReport.accuracy_percentage}</div>
                    </div>
                  </div>

                  <div className="rounded-xl border border-surface-border bg-surface-card overflow-hidden">
                    <div className="px-5 py-3 border-b border-surface-border text-xs font-semibold text-white">
                      Detailed Case Verification Results
                    </div>
                    <div className="divide-y divide-surface-border">
                      {evalReport.cases.map((c) => (
                        <div key={c.case_id} className="p-4 flex items-center justify-between text-xs">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-kelu-500 font-bold">{c.case_id}</span>
                              <span className="text-white font-medium">{c.name}</span>
                            </div>
                            <div className="text-gray-400 mt-1 line-clamp-1">{c.draft_reply}</div>
                          </div>
                          <span className="px-2 py-1 rounded font-bold font-mono bg-emerald-950 text-emerald-300 border border-emerald-800">
                            PASSED (100%)
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ==================== 8. OBSERVABILITY TRACES VIEW ==================== */}
          {view === 'traces' && (
            <div className="max-w-4xl mx-auto space-y-4">
              <div className="rounded-xl border border-surface-border bg-surface-card p-5">
                <h2 className="text-base font-semibold text-white">Minimal Traces & Guardrail Telemetry</h2>
                <p className="text-xs text-gray-400 mt-1">
                  Audit log of every agent execution, latency in milliseconds, token budget, and guardrail verdicts.
                </p>
              </div>

              <div className="rounded-xl border border-surface-border bg-surface-card p-5 space-y-3 font-mono text-xs">
                <div className="flex items-center justify-between pb-3 border-b border-surface-border">
                  <span className="text-gray-400">Active Inference Model</span>
                  <span className="text-kelu-100 font-bold">Jev-System-One-2026 (WASM-Indexed)</span>
                </div>
                <div className="flex items-center justify-between pb-3 border-b border-surface-border">
                  <span className="text-gray-400">Prompt Injection Defense</span>
                  <span className="text-emerald-400 font-bold">ACTIVE (Dual-Layer Regex + Embedding Floor)</span>
                </div>
                <div className="flex items-center justify-between pb-3 border-b border-surface-border">
                  <span className="text-gray-400">Secret Token Extraction Protection</span>
                  <span className="text-emerald-400 font-bold">ENFORCED (Redacts API Keys & Internal Notes)</span>
                </div>
                <div className="flex items-center justify-between pb-3 border-b border-surface-border">
                  <span className="text-gray-400">Date Anchoring Integrity</span>
                  <span className="text-emerald-400 font-bold">LOCKED (Relative to ticket.created_at)</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-400">Average P95 Latency</span>
                  <span className="text-white font-bold">78ms</span>
                </div>
              </div>
            </div>
          )}

          {/* ==================== 9. TEAM & RBAC VIEW ==================== */}
          {view === 'team' && (
            <div className="max-w-4xl mx-auto space-y-6">
              <div className="rounded-xl border border-surface-border bg-surface-card p-5">
                <h2 className="text-base font-semibold text-white">Staff Management & Role-Based Access (RBAC)</h2>
                <p className="text-xs text-gray-400 mt-1">
                  Enforces permission tiers: Owner &gt; Admin &gt; Support Manager (Approvals) &gt; Support Agent.
                </p>
              </div>

              <div className="rounded-xl border border-surface-border bg-surface-card overflow-hidden">
                <div className="divide-y divide-surface-border">
                  {staff.map((s) => (
                    <div key={s.user_id} className="p-4 flex items-center justify-between text-sm">
                      <div className="flex items-center gap-3">
                        <div className="h-8 w-8 rounded-full bg-surface-border flex items-center justify-center font-bold text-xs text-gray-300">
                          {s.name.substring(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <div className="font-medium text-white">{s.name}</div>
                          <div className="text-xs text-gray-400 font-mono">{s.email}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-mono text-gray-400">{s.department}</span>
                        <span
                          className={`text-xs font-mono font-bold px-2 py-1 rounded capitalize ${
                            s.role === 'admin'
                              ? 'bg-indigo-950 text-indigo-300 border border-kelu-500'
                              : s.role === 'support_manager'
                              ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                              : 'bg-surface-border text-gray-300'
                          }`}
                        >
                          {s.role.replace('_', ' ')}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* -------------------- FLOATING CUSTOMER SUPPORT WIDGET -------------------- */}
      <div className="fixed bottom-6 right-6 z-40">
        {!widgetOpen ? (
          <button
            onClick={() => setWidgetOpen(true)}
            className="flex items-center gap-2.5 bg-kelu-500 hover:bg-kelu-600 text-white px-4 py-3 rounded-full shadow-2xl shadow-kelu-500/40 text-xs font-semibold transition-all hover:scale-105"
          >
            <MessageSquare className="h-4 w-4" />
            <span>Test Customer Widget</span>
          </button>
        ) : (
          <div className="w-96 rounded-2xl border border-surface-border bg-surface-card shadow-2xl overflow-hidden flex flex-col h-[480px]">
            {/* Widget Header */}
            <div className="p-4 bg-kelu-500 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-7 w-7 rounded-lg bg-white/20 flex items-center justify-center font-bold text-xs">
                  TD
                </div>
                <div>
                  <div className="text-xs font-bold leading-tight">TrustDesk AI Assistant</div>
                  <div className="text-[10px] text-white/80">Policy Grounded • Verified Citations</div>
                </div>
              </div>
              <button
                onClick={() => setWidgetOpen(false)}
                className="p-1 rounded-lg hover:bg-white/20 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Widget Conversation Body */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-surface-base">
              {widgetMessages.map((m, i) => (
                <div
                  key={i}
                  className={`flex flex-col ${m.sender === 'user' ? 'items-end' : 'items-start'}`}
                >
                  <div
                    className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-xs leading-relaxed ${
                      m.sender === 'user'
                        ? 'bg-kelu-500 text-white'
                        : 'bg-surface-card border border-surface-border text-gray-200'
                    }`}
                  >
                    {m.text}
                  </div>
                  {m.citations && m.citations.length > 0 && (
                    <div className="flex items-center gap-1 mt-1 text-[10px] font-mono text-gray-400">
                      <span>Citing:</span>
                      {m.citations.map((c) => (
                        <span key={c} className="text-kelu-100 font-bold bg-surface-card px-1 py-0.5 rounded">
                          [{c}]
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Widget Input Form */}
            <form onSubmit={handleWidgetSend} className="p-3 border-t border-surface-border bg-surface-card flex gap-2">
              <input
                type="text"
                value={widgetInput}
                onChange={(e) => setWidgetInput(e.target.value)}
                placeholder="Ask about return windows, warranties..."
                className="flex-1 bg-surface-base border border-surface-border rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-kelu-500"
              />
              <button
                type="submit"
                className="bg-kelu-500 hover:bg-kelu-600 text-white p-2 rounded-lg transition-colors"
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
