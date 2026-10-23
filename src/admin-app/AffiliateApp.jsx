// The affiliate portal (CP13, design §1.2, §7.3, §8): the admin build's
// THIRD tree, every address under /affiliate (main.jsx picks it by path,
// `basename="/affiliate"`). Admin-Neutral tokens in a slim shell of its own:
// a top bar with the shop (a picker when the person is the affiliate of
// several shops) and a row of links. No shop-admin sidebar, never the
// platform console's dark theme.
//
// Who may be here: `/v1/me` says `accountType: 'affiliate'`. Signed out → the
// one sign-in page (/login, a full load); a shop admin → /admin; a platform
// user → /platform/. The shop: one of `/v1/me`'s memberships (role
// affiliate, the shop active); the one chosen earlier in this tab, else the
// only one, else the picker. Every request names it (X-Shop-Id).
//
// The terms gate (design §8): `GET /v1/affiliate/me` answers `terms.outdated`
// while the person has not accepted the current version; every page then
// leads to /affiliate/terms until the acceptance lands.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import ScrollToTop from '../components/ScrollToTop';
import { AuthProvider, useAuth } from './providers/Session.jsx';
import { getPortalMe, onPortalSessionLost, setPortalShopId } from '../api/affiliate-portal.js';
import {
  homeOfAccount,
  portalBannerOf,
  requestedShopIdOf,
  resolveAffiliateShopId,
  signInUrlFor,
  usableAffiliateShops,
} from './adapters/affiliatePortal.js';
import { PortalContext } from './pages/affiliate/portalContext.js';
import AffiliateOverview from './pages/affiliate/Overview.jsx';
import AffiliateOrders from './pages/affiliate/Orders.jsx';
import AffiliatePayouts from './pages/affiliate/Payouts.jsx';
import AffiliateProfile from './pages/affiliate/Profile.jsx';
import AffiliateTerms from './pages/affiliate/Terms.jsx';
import AffiliateGuide from './pages/affiliate/Guide.jsx';
import AffiliateMaterial from './pages/affiliate/Material.jsx';

/** The portal's addresses, relative to /affiliate. `nav`: the top row's label (none: not in the row). */
export const AFFILIATE_ROUTES = [
  { path: '/', page: AffiliateOverview, nav: 'Översikt' },
  { path: '/orders', page: AffiliateOrders, nav: 'Beställningar' },
  { path: '/payouts', page: AffiliatePayouts, nav: 'Utbetalningar' },
  { path: '/profile', page: AffiliateProfile, nav: 'Profil' },
  { path: '/terms', page: AffiliateTerms, nav: 'Villkor' },
  { path: '/guide', page: AffiliateGuide, nav: 'Guide' },
  // Only while the shop's marketing materials are on; the contract does not
  // say that yet (CP13_A3_REPORT.md), so the page shows nothing and is not linked.
  { path: '/material', page: AffiliateMaterial },
];

const CHOICE_KEY = 'affiliate.activeShopId';

function storedChoice() {
  try {
    return globalThis.sessionStorage?.getItem(CHOICE_KEY) ?? null;
  } catch {
    return null;
  }
}

function storeChoice(shopId) {
  try {
    if (shopId) globalThis.sessionStorage?.setItem(CHOICE_KEY, shopId);
    else globalThis.sessionStorage?.removeItem(CHOICE_KEY);
  } catch {
    /* storage refused: the choice lives for this page */
  }
}

function Centered({ children }) {
  return (
    <div className="grid min-h-screen place-items-center bg-admin-bg px-4 text-admin-text [font-size:13px] [line-height:20px]">
      {children}
    </div>
  );
}

function Spinner({ label = 'Laddar…' }) {
  return (
    <Centered>
      <div className="flex items-center gap-3 text-admin-text-muted" role="status">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-admin-border border-t-admin-text" aria-hidden="true" />
        {label}
      </div>
    </Centered>
  );
}

/** A full load somewhere else (another tree, the sign-in page). */
function Leave({ to }) {
  useEffect(() => {
    window.location.replace(to);
  }, [to]);
  return null;
}

function Message({ title, children, onLogout }) {
  return (
    <Centered>
      <div className="w-full max-w-md rounded-[var(--radius-admin)] border border-admin-border bg-admin-surface p-6 text-center shadow-[var(--shadow-admin)]">
        <h1 className="text-[16px] font-semibold">{title}</h1>
        <div className="mt-2 text-admin-text-muted">{children}</div>
        {onLogout && (
          <button
            type="button"
            onClick={onLogout}
            className="mt-4 text-admin-text-muted underline underline-offset-2 hover:text-admin-text"
          >
            Logga ut
          </button>
        )}
      </div>
    </Centered>
  );
}

function ShopPicker({ shops, onPick, onLogout }) {
  return (
    <Centered>
      <div className="w-full max-w-md rounded-[var(--radius-admin)] border border-admin-border bg-admin-surface shadow-[var(--shadow-admin)]">
        <div className="border-b border-admin-border px-4 py-3">
          <h1 className="text-[14px] font-semibold">Välj butik</h1>
          <p className="mt-0.5 text-admin-text-muted">Du är affiliate hos flera butiker.</p>
        </div>
        <ul className="divide-y divide-admin-border">
          {shops.map((shop) => (
            <li key={shop.tenantId}>
              <button
                type="button"
                onClick={() => onPick(shop.tenantId)}
                className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-admin-surface-2"
              >
                <span className="font-medium">{shop.shopName || shop.tenantId}</span>
                <svg className="h-4 w-4 text-admin-text-muted" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
        <div className="border-t border-admin-border px-4 py-3 text-right">
          <button type="button" onClick={onLogout} className="text-admin-text-muted underline underline-offset-2 hover:text-admin-text">
            Logga ut
          </button>
        </div>
      </div>
    </Centered>
  );
}

function TopBar({ shopName, shops, shopId, onPick, onLogout, email }) {
  return (
    <header className="sticky top-0 z-30">
      <div className="flex h-14 items-center gap-3 bg-[var(--color-admin-topbar)] px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-[15px] font-semibold tracking-tight text-white">{shopName}</span>
          <span className="hidden rounded-[var(--radius-admin-el)] bg-white/10 px-1.5 py-0.5 text-[11px] font-medium text-white/70 sm:inline">
            Affiliate
          </span>
        </div>
        {shops.length > 1 && (
          <label className="flex items-center gap-2 text-white/70">
            <span className="sr-only">Byt butik</span>
            <select
              value={shopId}
              onChange={(e) => onPick(e.target.value)}
              className="h-8 max-w-[11rem] rounded-[var(--radius-admin-el)] border-0 bg-white/10 px-2 text-[13px] text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            >
              {shops.map((shop) => (
                <option key={shop.tenantId} value={shop.tenantId} className="text-admin-text">
                  {shop.shopName || shop.tenantId}
                </option>
              ))}
            </select>
          </label>
        )}
        {email && <span className="hidden max-w-[14rem] truncate text-[12px] text-white/55 md:inline">{email}</span>}
        <button
          type="button"
          onClick={onLogout}
          className="h-8 rounded-[var(--radius-admin-el)] px-2 text-[13px] text-white/80 hover:bg-white/10 hover:text-white"
        >
          Logga ut
        </button>
      </div>
      <nav aria-label="Affiliateportalen" className="border-b border-admin-border bg-admin-surface">
        <div className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-2 sm:px-4">
          {AFFILIATE_ROUTES.filter((r) => r.nav).map(({ path, nav }) => (
            <NavLink
              key={path}
              to={path}
              end={path === '/'}
              className={({ isActive }) =>
                `whitespace-nowrap border-b-2 px-3 py-2.5 text-[13px] transition-colors ${
                  isActive
                    ? 'border-admin-text font-semibold text-admin-text'
                    : 'border-transparent font-medium text-admin-text-muted hover:text-admin-text'
                }`
              }
            >
              {nav}
            </NavLink>
          ))}
        </div>
      </nav>
    </header>
  );
}

/** The portal for one shop: its PortalMe, the terms gate, the pages. */
function ShopPortal({ shopId, shopName, shops, onPick, onLogout, onLost, email }) {
  const [state, setState] = useState({ status: 'loading', affiliate: null });

  const reload = useCallback(async () => {
    try {
      const affiliate = await getPortalMe();
      setState({ status: affiliate ? 'ready' : 'missing', affiliate });
      return affiliate;
    } catch (error) {
      if (error?.code === 'unauthenticated') return null;
      setState({ status: error?.status === 404 ? 'missing' : 'error', affiliate: null });
      return null;
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const setAffiliate = useCallback((affiliate) => {
    if (affiliate) setState({ status: 'ready', affiliate });
  }, []);

  const value = useMemo(
    () => ({ affiliate: state.affiliate, shopId, shopName, reload, setAffiliate }),
    [state.affiliate, shopId, shopName, reload, setAffiliate],
  );

  // The shop answers as if the membership were gone (revoked mid-session):
  // `/v1/me` is read again, and another usable shop takes over (the only one
  // left, or the picker).
  const missing = state.status === 'missing';
  useEffect(() => {
    if (missing) onLost(shopId);
  }, [missing, onLost, shopId]);

  if (state.status === 'loading') return <Spinner />;
  if (missing) {
    const others = shops.filter((s) => s.tenantId !== shopId);
    return (
      <Message title="Ingen åtkomst" onLogout={onLogout}>
        <p>Ditt affiliatekonto hos {shopName} är inte aktivt längre. Kontakta butiken om du tror att det är fel.</p>
        {others.length > 0 && (
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {others.map((shop) => (
              <button
                key={shop.tenantId}
                type="button"
                onClick={() => onPick(shop.tenantId)}
                className="rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-3 py-1.5 font-medium text-admin-text hover:bg-admin-surface-2"
              >
                Till {shop.shopName || shop.tenantId}
              </button>
            ))}
          </div>
        )}
      </Message>
    );
  }
  if (state.status === 'error') {
    return (
      <Message title="Portalen kunde inte laddas" onLogout={onLogout}>
        <p>Servern svarade inte. Försök igen om en stund.</p>
        <button type="button" onClick={reload} className="mt-3 text-admin-text underline underline-offset-2">
          Försök igen
        </button>
      </Message>
    );
  }

  const termsOutdated = state.affiliate.terms?.outdated === true;
  // The affiliate's own status first (inactive / suspended), then the program's switch.
  const banner = portalBannerOf(state.affiliate);

  return (
    <PortalContext.Provider value={value}>
      <div className="min-h-screen bg-admin-bg text-admin-text [font-size:13px] [line-height:20px]">
        <TopBar shopName={shopName} shops={shops} shopId={shopId} onPick={onPick} onLogout={onLogout} email={email} />
        <main className="mx-auto max-w-5xl px-4 py-6">
          {banner && (
            <div className="mb-4 rounded-[var(--radius-admin)] border border-admin-border bg-admin-caution-bg px-4 py-3 text-admin-caution-text" role="status">
              {banner}
            </div>
          )}
          <Routes>
            {AFFILIATE_ROUTES.map(({ path, page: Page }) => (
              <Route
                key={path}
                path={path}
                element={termsOutdated && path !== '/terms' ? <Navigate to="/terms" replace /> : <Page />}
              />
            ))}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </PortalContext.Provider>
  );
}

function PortalShell() {
  const { me, loading, logout, refresh } = useAuth();
  const [chosen, setChosen] = useState(storedChoice);
  // The shop the address asks for (`?shopId=`, the portal links of the
  // mails; Codex finding 6), read once on arrival. It counts only when
  // `/v1/me` lists it as usable, and then wins over the stored choice.
  const [requested, setRequested] = useState(() => requestedShopIdOf(window.location.search));

  // A lost session: the sign-in page, which brings the person back here.
  useEffect(() => {
    onPortalSessionLost(() => window.location.assign(signInUrlFor(window.location.pathname, window.location.search)));
    return () => onPortalSessionLost(null);
  }, []);

  const shops = useMemo(() => usableAffiliateShops(me), [me]);
  const shopId = resolveAffiliateShopId(me, chosen, requested);
  // Every request of this render's pages names this shop (before any effect runs).
  setPortalShopId(shopId);

  // An authorised request becomes the tab's choice, and leaves the address
  // (a reload, or a later "Byt butik", then follows the choice).
  useEffect(() => {
    if (!requested || shopId !== requested) return;
    storeChoice(requested);
    setChosen(requested);
    setRequested(null);
    try {
      const params = new URLSearchParams(window.location.search);
      params.delete('shopId');
      const rest = params.toString();
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
    } catch {
      /* the address keeps its parameter; the choice is stored */
    }
  }, [requested, shopId]);

  const pick = useCallback((id) => {
    storeChoice(id);
    setChosen(id);
    setRequested(null);
  }, []);

  // A shop that no longer answers: re-read `/v1/me`; when the shop has left
  // the memberships, forget the choice so another usable shop is resolved.
  const handleLost = useCallback(
    async (lostId) => {
      let next = null;
      try {
        next = await refresh();
      } catch {
        return;
      }
      if (!usableAffiliateShops(next).some((m) => m.tenantId === lostId)) {
        storeChoice(null);
        setChosen(null);
      }
    },
    [refresh],
  );

  const handleLogout = useCallback(async () => {
    try {
      await logout();
    } finally {
      storeChoice(null);
      window.location.assign('/login');
    }
  }, [logout]);

  if (loading) return <Spinner label="Verifierar inloggning…" />;
  const home = homeOfAccount(me);
  // Signed out: the sign-in page, then back to the portal address asked for.
  if (home) return <Leave to={me ? home : signInUrlFor(window.location.pathname, window.location.search)} />;

  if (shops.length === 0) {
    return (
      <Message title="Ingen aktiv butik" onLogout={handleLogout}>
        Ditt konto är inte kopplat till någon aktiv butik just nu. Kontakta butiken du är affiliate hos.
      </Message>
    );
  }
  if (!shopId) return <ShopPicker shops={shops} onPick={pick} onLogout={handleLogout} />;

  const shopName = shops.find((s) => s.tenantId === shopId)?.shopName || shopId;
  return (
    <ShopPortal
      key={shopId}
      shopId={shopId}
      shopName={shopName}
      shops={shops}
      onPick={pick}
      onLogout={handleLogout}
      onLost={handleLost}
      email={me?.user?.email ?? null}
    />
  );
}

export default function AffiliateApp() {
  return (
    <BrowserRouter basename="/affiliate">
      <ScrollToTop />
      <AuthProvider tree="affiliate">
        <Toaster position="top-right" toastOptions={{ duration: 4000, style: { background: '#363636', color: '#fff' } }} />
        <PortalShell />
      </AuthProvider>
    </BrowserRouter>
  );
}
