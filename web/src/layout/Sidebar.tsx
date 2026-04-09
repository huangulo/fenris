import React from 'react';
import { View } from '../types';
import { useAuth } from '../auth';

// ── SVG icons (outline, 20×20) ────────────────────────────────────────────────

const IconGrid = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="7" rx="1.5"/>
    <rect x="14" y="3" width="7" height="7" rx="1.5"/>
    <rect x="3" y="14" width="7" height="7" rx="1.5"/>
    <rect x="14" y="14" width="7" height="7" rx="1.5"/>
  </svg>
);

const IconServer = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2" width="20" height="8" rx="2"/>
    <rect x="2" y="14" width="20" height="8" rx="2"/>
    <line x1="6" y1="6" x2="6.01" y2="6"/>
    <line x1="6" y1="18" x2="6.01" y2="18"/>
  </svg>
);

const IconCube = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
    <polyline points="3.27,6.96 12,12.01 20.73,6.96"/>
    <line x1="12" y1="22.08" x2="12" y2="12"/>
  </svg>
);

const IconBell = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/>
    <path d="M13.73 21a2 2 0 01-3.46 0"/>
  </svg>
);

const IconHeartbeat = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
  </svg>
);

const IconSettings = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
  </svg>
);

const IconShield = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
  </svg>
);

const IconFire = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2c0 0-5 4.5-5 9.5a5 5 0 0010 0c0-2-1-3.5-2-4.5 0 2-1 3-2 3s-2-1-2-2.5c0-2 1.5-4 1-5.5z"/>
    <path d="M12 22c-2.5 0-4-1.5-4-3.5 0-1 .5-2 1.5-2.5-.5 1 0 2 1 2.5.5-1.5.5-3 1.5-4 .5 1.5 1.5 2.5 1.5 4 1-1 1.5-2 1.5-2.5C16 17 16.5 18 16.5 19c0 2-1.5 3-4.5 3z"/>
  </svg>
);

const IconChevron = ({ right }: { right?: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {right ? <polyline points="9 18 15 12 9 6"/> : <polyline points="15 18 9 12 15 6"/>}
  </svg>
);

// ── Types ─────────────────────────────────────────────────────────────────────

interface NavItem {
  id: View;
  label: string;
  icon: React.ReactNode;
  badge?: number;
}

interface SidebarProps {
  view: View;
  onNavigate: (v: View) => void;
  activeAlerts: number;
  activeIncidents?: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
  wazuhEnabled?: boolean;
  crowdSecEnabled?: boolean;
}

// ── User bar ──────────────────────────────────────────────────────────────────

function IconLogout() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
      <polyline points="16 17 21 12 16 7"/>
      <line x1="21" y1="12" x2="9" y2="12"/>
    </svg>
  );
}

function UserBar({ collapsed }: { collapsed: boolean }) {
  const { user, logout } = useAuth();
  if (!user) return null;

  const roleColor = user.role === 'admin' ? 'text-cyan-400'
                  : user.role === 'operator' ? 'text-yellow-400'
                  : 'text-gray-400';

  return (
    <div className={`border-t border-gray-800/60 ${collapsed ? 'py-2 flex flex-col items-center gap-1' : 'px-3 py-2'}`}>
      {!collapsed && (
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium text-gray-300 truncate">{user.username}</p>
            <p className={`text-[10px] font-mono ${roleColor}`}>{user.role}</p>
          </div>
          <button
            onClick={() => logout()}
            title="Sign out"
            className="flex-shrink-0 text-gray-600 hover:text-red-400 transition-colors ml-2 p-1 rounded"
          >
            <IconLogout />
          </button>
        </div>
      )}
      {collapsed && (
        <button
          onClick={() => logout()}
          title={`${user.username} — Sign out`}
          className="text-gray-600 hover:text-red-400 transition-colors p-1 rounded"
        >
          <IconLogout />
        </button>
      )}
    </div>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

const IconShieldLock = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    <rect x="9" y="11" width="6" height="5" rx="1"/>
    <path d="M12 11v-2a1 1 0 00-2 0v2"/>
    <circle cx="12" cy="13.5" r="0.6" fill="currentColor"/>
  </svg>
);

export function Sidebar({ view, onNavigate, activeAlerts, activeIncidents = 0, collapsed, onToggleCollapse, wazuhEnabled, crowdSecEnabled }: SidebarProps) {
  const navItems: NavItem[] = [
    { id: 'incidents',   label: 'Incidents',   icon: <IconFire />, badge: activeIncidents },
    { id: 'overview',    label: 'Overview',    icon: <IconGrid /> },
    { id: 'server',      label: 'Servers',     icon: <IconServer /> },
    { id: 'containers',  label: 'Containers',  icon: <IconCube /> },
    { id: 'uptime',      label: 'Uptime',      icon: <IconHeartbeat /> },
    { id: 'alerts',      label: 'Alerts',      icon: <IconBell />, badge: activeAlerts },
    ...(wazuhEnabled    ? [{ id: 'wazuh'     as View, label: 'Wazuh',    icon: <IconShield /> }]     : []),
    ...(crowdSecEnabled ? [{ id: 'crowdsec'  as View, label: 'CrowdSec', icon: <IconShieldLock /> }] : []),
    { id: 'settings',    label: 'Settings',    icon: <IconSettings /> },
  ];

  return (
    <>
      {/* ── Desktop sidebar ─────────────────────────────────────────────────── */}
      <aside
        className="hidden md:flex flex-col h-full bg-[#0e1420] border-r border-gray-800/60 flex-shrink-0 transition-all duration-200"
        style={{ width: collapsed ? 56 : 200 }}
      >
        {/* Logo area */}
        <div className={`flex items-center h-14 border-b border-gray-800/60 flex-shrink-0 ${collapsed ? 'justify-center px-0' : 'px-4 gap-3'}`}>
          {!collapsed && (
            <span className="font-mono font-bold text-sm tracking-[0.2em] text-white">FENRIS</span>
          )}
          {collapsed && (
            <span className="font-mono font-bold text-sm text-white">F</span>
          )}
        </div>

        {/* Nav items */}
        <nav className="flex-1 py-3 overflow-y-auto overflow-x-hidden">
          {navItems.map(item => {
            const active = view === item.id || (item.id === 'server' && view === 'server');
            return (
              <button
                key={item.id}
                onClick={() => onNavigate(item.id)}
                title={collapsed ? item.label : undefined}
                className={`
                  w-full flex items-center transition-colors duration-100 relative
                  ${collapsed ? 'justify-center h-10 px-0' : 'gap-3 px-4 h-10'}
                  ${active ? 'nav-active' : 'nav-inactive'}
                `}
              >
                <span className="flex-shrink-0">{item.icon}</span>
                {!collapsed && (
                  <span className="text-sm font-medium flex-1 text-left">{item.label}</span>
                )}
                {/* Badge */}
                {item.badge != null && item.badge > 0 && (
                  <span className={`
                    flex-shrink-0 text-[10px] font-mono font-bold bg-red-500 text-white rounded-full leading-none
                    ${collapsed ? 'absolute top-1.5 right-2.5 w-4 h-4 flex items-center justify-center' : 'min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full'}
                  `}>
                    {item.badge > 99 ? '99+' : item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* User + logout */}
        <UserBar collapsed={collapsed} />

        {/* Collapse toggle */}
        <button
          onClick={onToggleCollapse}
          className={`flex items-center h-10 border-t border-gray-800/60 text-gray-600 hover:text-gray-300 transition-colors ${collapsed ? 'justify-center' : 'px-4 gap-2'}`}
        >
          <IconChevron right={collapsed} />
          {!collapsed && <span className="text-xs text-gray-500">Collapse</span>}
        </button>
      </aside>

      {/* ── Mobile bottom nav ────────────────────────────────────────────────── */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-[#0e1420] border-t border-gray-800/60 flex">
        {navItems.map(item => {
          const active = view === item.id || (item.id === 'server' && view === 'server');
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`flex-1 flex flex-col items-center justify-center gap-1 py-2 relative transition-colors ${
                active ? 'text-cyan-400' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {item.icon}
              <span className="text-[9px] font-medium">{item.label}</span>
              {item.badge != null && item.badge > 0 && (
                <span className="absolute top-1.5 right-[calc(50%-14px)] w-4 h-4 text-[9px] font-bold bg-red-500 text-white rounded-full flex items-center justify-center">
                  {item.badge > 9 ? '9+' : item.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </>
  );
}
