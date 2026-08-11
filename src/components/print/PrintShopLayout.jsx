// PrintShopLayout — the print-shop surface shell. Its own dark sidebar, siloed
// from the shop-admin AppLayout and the platform console (same visual family as
// PlatformLayout, different identity). Nav: Print-kö + Original (artwork library).
import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { PrinterIcon, PhotoIcon, ArrowRightOnRectangleIcon } from '@heroicons/react/24/outline';

const NAV = [
  { name: 'Print-kö', path: '/', icon: PrinterIcon, live: true },
  { name: 'Original', path: '/artwork', icon: PhotoIcon, live: true },
];

const PrintShopLayout = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { currentUser, logout } = useAuth();

  const isActive = (path) => location.pathname === path;

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
      <aside className="hidden md:fixed md:inset-y-0 md:flex md:w-64 md:flex-col bg-gray-900 border-r border-white/10">
        <div className="flex items-center gap-2 px-5 py-6">
          <PrinterIcon className="h-7 w-7 text-indigo-400" />
          <div>
            <div className="text-sm font-bold tracking-tight">Tryckeri</div>
            <div className="text-[11px] uppercase tracking-widest text-indigo-300/70">Print portal</div>
          </div>
        </div>

        <nav className="mt-2 flex-1 px-3 space-y-1">
          {NAV.map((item) => {
            const active = isActive(item.path);
            return (
              <Link
                key={item.name}
                to={item.path}
                className={
                  'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ' +
                  (active ? 'bg-indigo-500/15 text-white' : 'text-gray-300 hover:bg-white/5 hover:text-white')
                }
              >
                <item.icon className={'h-5 w-5 shrink-0 ' + (active ? 'text-indigo-300' : '')} />
                <span>{item.name}</span>
              </Link>
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

      <div className="md:pl-64">
        <main className="min-h-screen">{children}</main>
      </div>
    </div>
  );
};

export default PrintShopLayout;
