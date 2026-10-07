import React from 'react';
import { Settings, Inbox, Star, Archive, Library } from 'lucide-react';
import { Link } from '../router.jsx';
import { useApp } from '../App.jsx';
import { Logo } from './ui.jsx';

const TABS = [
  { view: 'queue', to: '/', label: 'Queue', icon: Inbox },
  { view: 'starred', to: '/starred', label: 'Starred', icon: Star },
  { view: 'archive', to: '/archive', label: 'Archive', icon: Archive },
  { view: 'all', to: '/all', label: 'All', icon: Library },
];

export default function Header({ view, counts }) {
  const { status } = useApp();
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link to="/" className="brand"><span className="brand-mark"><Logo size={15} /></span>{status.appName}</Link>
        <Link to="/settings" className={`icon-btn ${view === 'settings' ? 'on' : ''}`} aria-label="Settings" title="Settings"><Settings size={19} /></Link>
      </div>
      {view !== 'settings' && (
        <nav className="tabs" aria-label="Lists">
          {TABS.map((t) => (
            <Link key={t.view} to={t.to} className={`tab ${view === t.view ? 'on' : ''}`} aria-current={view === t.view ? 'page' : undefined}>
              <t.icon size={15} />
              {t.label}
              {counts && t.view !== 'all' && counts[t.view] > 0 && <span className="count">{counts[t.view]}</span>}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
