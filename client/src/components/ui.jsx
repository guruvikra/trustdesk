import React, { createContext, useCallback, useContext, useState } from 'react';
import { LoaderCircle, X } from 'lucide-react';

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, type = 'ok') => {
    const id = Math.random();
    setToasts(t => [...t, { id, message, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap">
        {toasts.map(t => <div key={t.id} className={`toast ${t.type}`}>{t.message}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

export const Spinner = ({ size = 14 }) => <LoaderCircle size={size} className="spin" />;

export function Button({ busy, icon: Icon, children, variant = '', size = '', ...rest }) {
  return (
    <button className={`btn ${variant} ${size}`} disabled={busy || rest.disabled} {...rest}>
      {busy ? <Spinner /> : Icon ? <Icon size={14} /> : null}
      {children}
    </button>
  );
}

export function Card({ title, icon: Icon, actions, children, className = '', bodyClass = 'card-b' }) {
  return (
    <div className={`card ${className}`}>
      {title && (
        <div className="card-h">
          {Icon && <Icon size={16} className="muted" />}
          <span>{title}</span>
          <span className="spacer" />
          {actions}
        </div>
      )}
      <div className={bodyClass}>{children}</div>
    </div>
  );
}

export function Empty({ icon: Icon, title, children }) {
  return (
    <div className="empty">
      {Icon && <div className="icon"><Icon size={28} /></div>}
      <div className="bold">{title}</div>
      {children && <div className="small mt">{children}</div>}
    </div>
  );
}

const TONES = {
  urgent: 'red', high: 'amber', medium: 'blue', low: '',
  open: 'blue', escalated: 'amber', resolved: 'green',
  pending_approval: 'amber', approved: 'blue', executed: 'green', rejected: 'red', blocked: 'red',
  trusted: 'green', quarantined: 'red', public: 'blue', internal: 'violet',
  completed: 'green', running: 'blue', failed: 'red', queued: '',
  draft_ready: 'green', escalated_status: 'amber', refused_and_escalated: 'red', needs_human_review: 'amber', escalation_recommended: 'amber',
  answered: 'green', no_answer: 'amber', refused: 'red',
};

export function Badge({ children, tone }) {
  const isText = typeof children === 'string';
  const t = tone !== undefined ? tone : (isText && TONES[children]) || '';
  return <span className={`badge ${t}`}>{isText ? children.replace(/_/g, ' ') : children}</span>;
}

export function Modal({ title, onClose, children }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="card modal" onClick={e => e.stopPropagation()}>
        <div className="card-h"><span>{title}</span><span className="spacer" /><button className="btn ghost sm" onClick={onClose}><X size={14} /></button></div>
        <div className="card-b">{children}</div>
      </div>
    </div>
  );
}

export function Json({ value }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

export const fmtTime = v => (v ? new Date(v).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const pct = v => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);

// Renders text with [KB-…] citations as clickable chips.
export function CitedText({ text, onCite }) {
  const parts = String(text || '').split(/(\[KB-[A-Z0-9-]+\])/g);
  return (
    <span style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
      {parts.map((p, i) => {
        const m = p.match(/^\[(KB-[A-Z0-9-]+)\]$/);
        return m ? <button key={i} className="cite" onClick={() => onCite && onCite(m[1])}>{m[1]}</button> : <React.Fragment key={i}>{p}</React.Fragment>;
      })}
    </span>
  );
}
