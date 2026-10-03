import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
// The badge count, the menu's scope and the arrival notices are data: the
// Cloudflare admin build swaps this module (alias list).
import { scopePlatformNav, useNavBadgeCounts, usePlatformNotices } from './platformLayoutData';
import {
  BuildingStorefrontIcon,
  PuzzlePieceIcon,
  CreditCardIcon,
  Cog6ToothIcon,
  ArrowRightOnRectangleIcon,
  ShieldCheckIcon,
  PrinterIcon,
  InboxIcon,
  CubeIcon,
  UsersIcon,
  FlagIcon,
} from '@heroicons/react/24/outline';

/**
 * PlatformLayout — the operator console shell. DELIBERATELY separate from the
 * shop-admin AppLayout: its own dark sidebar + nav (Shops / Add-ons / Payments /
 * Settings), so the platform surface is visually and structurally disconnected
 * from any single shop's admin. (docs/PLATFORM_ARCHITECTURE.md)
 *
 * Slice P4.0/P4.1: only "Shops" is live; the rest are placeholders for later
 * slices (add-ons, payments, settings).
 */
const NAV = scopePlatformNav([
  { name: 'Butiker', path: '/shops', icon: BuildingStorefrontIcon, live: true },
  { name: 'Tillägg', path: '/addons', icon: PuzzlePieceIcon, live: true },
  { name: '3D-modeller', path: '/models', icon: CubeIcon, live: true },
  { name: 'DAC7', path: '/dac7', icon: ShieldCheckIcon, live: true },
  { name: 'Tryckerier', path: '/printers', icon: PrinterIcon, live: true },
  { name: 'Leads', path: '/leads', icon: InboxIcon, live: true },
  // badge: key into the counts below — unhandled infringement reports.
  { name: 'Anmälningar', path: '/reports', icon: FlagIcon, live: true, badge: 'reports' },
  { name: 'Användare', path: '/users', icon: UsersIcon, live: true },
  { name: 'Betalningar', path: '/payments', icon: CreditCardIcon, live: false },
  { name: 'Inställningar', path: '/settings', icon: Cog6ToothIcon, live: false },
]);

// Pages that change a badge's underlying data call this so the sidebar count
// refreshes without a reload (each page mounts its own PlatformLayout).
const BADGES_EVENT = 'platform:badges-changed';
export const notifyPlatformBadgesChanged = () => {
  try { window.dispatchEvent(new Event(BADGES_EVENT)); } catch { /* non-browser */ }
};

// Nav badge counts (./platformLayoutData): unhandled infringement reports, one
// read per layout mount and on BADGES_EVENT. A failure just hides the badge —
// the nav must never break over it.

// `badgeCounts` is for the dev harness only (renders without Firestore).
const PlatformLayout = ({ children, badgeCounts }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { currentUser, logout } = useAuth() || {};
  const counts = useNavBadgeCounts(badgeCounts, BADGES_EVENT);
  usePlatformNotices();

  const isActive = (path) =>
    location.pathname === path || (path === '/shops' && location.pathname === '/');

  const handleLogout = async () => {
    try {
      await logout();
      navigate('/login');
    } catch (e) {
      console.error('Logout failed', e);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Sidebar */}
      <aside className="hidden md:fixed md:inset-y-0 md:flex md:w-64 md:flex-col bg-gray-900 border-r border-white/10">
        <div className="flex items-center gap-2 px-5 py-6">
          <ShieldCheckIcon className="h-7 w-7 text-indigo-400" />
          <div>
            <div className="text-sm font-bold tracking-tight">meteorpr</div>
            <div className="text-[11px] uppercase tracking-widest text-indigo-300/70">Platform</div>
          </div>
        </div>

        <nav className="mt-2 flex-1 px-3 space-y-1">
          {NAV.map((item) => {
            const active = isActive(item.path);
            const Tag = item.live ? Link : 'div';
            return (
              <Tag
                key={item.name}
                {...(item.live ? { to: item.path } : {})}
                className={
                  'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ' +
                  (active
                    ? 'bg-indigo-500/15 text-white'
                    : item.live
                    ? 'text-gray-300 hover:bg-white/5 hover:text-white cursor-pointer'
                    : 'text-gray-600 cursor-not-allowed')
                }
                title={item.live ? undefined : 'Kommer snart'}
              >
                <item.icon className={'h-5 w-5 shrink-0 ' + (active ? 'text-indigo-300' : '')} />
                <span>{item.name}</span>
                {item.badge && counts[item.badge] > 0 && (
                  <span
                    className="ml-auto rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-amber-300"
                    title="Nya, ohanterade"
                  >
                    {counts[item.badge]}
                  </span>
                )}
                {!item.live && (
                  <span className="ml-auto text-[10px] uppercase tracking-wide text-gray-600">snart</span>
                )}
              </Tag>
            );
          })}
        </nav>

        <div className="border-t border-white/10 p-3">
          <div className="px-2 pb-2 text-xs text-gray-500 truncate">{currentUser?.email}</div>
          <button
            onClick={handleLogout}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-300 hover:bg-white/5 hover:text-white"
          >
            <ArrowRightOnRectangleIcon className="h-5 w-5" />
            Logga ut
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="md:pl-64">
        <main className="min-h-screen">{children}</main>
      </div>
    </div>
  );
};

export default PlatformLayout;
