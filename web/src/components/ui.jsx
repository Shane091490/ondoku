// Shared UI: toasts, modal, dropdown menu, confirm dialog, switch.
import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, opts = {}) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-2), { id, message, ...opts }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), opts.duration || (opts.action ? 6000 : 3500));
  }, []);
  const dismiss = (id) => setToasts((t) => t.filter((x) => x.id !== id));
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>
            <span>{t.message}</span>
            {t.action && <button className="toast-action" onClick={() => { t.action.onClick(); dismiss(t.id); }}>{t.action.label}</button>}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function Modal({ title, sub, onClose, children, width }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={width ? { maxWidth: width } : undefined}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <h2>{title}</h2>
            {sub && <p className="sub">{sub}</p>}
          </div>
          <button className="icon-btn small" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Dropdown anchored to its trigger; closes on outside click or Escape.
export function Menu({ trigger, children, align = 'right', up = false, className = '', label = 'More' }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState(null); // where the open menu fits: { up, dx, maxHeight }
  const ref = useRef(null);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    // Capture phase + stopPropagation: Escape closes the menu without also triggering page shortcuts.
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('touchstart', onDoc, { passive: true });
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('touchstart', onDoc); document.removeEventListener('keydown', onKey, true); };
  }, [open]);
  // Keep the open menu on screen (phones especially): open upwards when there's more room above, slide it sideways
  // back inside the window, and let it scroll when it's taller than the room it has. Measured before paint.
  useLayoutEffect(() => {
    if (!open) { setPlace(null); return; }
    const el = menuRef.current;
    const wrap = ref.current;
    if (!el || !wrap) return;
    const margin = 8;
    const t = wrap.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - t.bottom - margin - 6;
    const above = t.top - margin - 6;
    const goUp = up ? !(r.height > above && below > above) : r.height > below && above > below;
    let dx = 0;
    if (r.left < margin) dx = margin - r.left;
    else if (r.right > window.innerWidth - margin) dx = window.innerWidth - margin - r.right;
    setPlace({ up: goUp, dx, maxHeight: Math.max(140, Math.floor(goUp ? above : below)) });
  }, [open, up]);
  const goUp = place ? place.up : up;
  const style = place ? { maxHeight: place.maxHeight, overflowY: 'auto', ...(place.dx ? { transform: `translateX(${place.dx}px)` } : {}) } : undefined;
  return (
    <div className="menu-wrap" ref={ref}>
      {trigger({ open, toggle: () => setOpen((o) => !o), label })}
      {open && (
        <div ref={menuRef} style={style} className={`menu ${align === 'left' ? 'left' : ''} ${goUp ? 'up' : ''} ${className}`} role="menu" onClick={(e) => { if (e.target.closest('[data-keep-open]')) return; if (e.target.closest('button, a')) setOpen(false); }}>
          {typeof children === 'function' ? children({ close: () => setOpen(false) }) : children}
        </div>
      )}
    </div>
  );
}

// A failed action keeps the dialog open and shows why, so it can be tried again or cancelled.
export function Confirm({ title, message, confirmLabel = 'Delete', danger = true, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function confirm() {
    setBusy(true);
    setError('');
    try { await onConfirm(); onClose(); } catch (e) { setError(e?.message || 'Something went wrong'); } finally { setBusy(false); }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <p style={{ color: 'var(--text-soft)', margin: '8px 0 0' }}>{message}</p>
      {error && <div className="form-error" role="alert" style={{ margin: '12px 0 0' }}>{error}</div>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy} onClick={confirm}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}

export function Logo({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 4h9a3 3 0 0 1 3 3v13l-6-3.5L6 20z" />
    </svg>
  );
}

// Slider toggle switch (a checkbox with role="switch", so it works with the keyboard and screen readers).
export function Switch({ checked, onChange, label, hint, disabled = false }) {
  return (
    <label className={`switch ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <span className="switch-track" aria-hidden="true" />
      {hint && <span className="switch-hint">{hint}</span>}
    </label>
  );
}
