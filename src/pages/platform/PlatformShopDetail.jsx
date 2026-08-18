// PlatformShopDetail — the operator's per-shop drill-down page (/shops/:shopId).
// Home for every per-shop action moved off the (formerly overcrowded) fleet row:
// the GO LIVE gate, counts, payments/Connect, commission, legal readiness, and the
// add-user / migrate / impersonate actions. Platform-only. DARK design
// (PlatformLayout). (docs/PLATFORM_ARCHITECTURE.md)
import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { doc, getDoc, updateDoc, collection, query, where, getCountFromServer } from 'firebase/firestore';
import { db } from '../../firebase/config';
import { APP_URLS } from '../../config/urls';
import PlatformLayout from '../../components/platform/PlatformLayout';
import ImpersonateShopModal from '../../components/platform/ImpersonateShopModal';
import AddShopUserModal from '../../components/platform/AddShopUserModal';
import MigrateShopifyModal from '../../components/platform/MigrateShopifyModal';
import MigrateWooModal from '../../components/platform/MigrateWooModal';
import { connectLabel, LegalCell, CommissionCell } from './shopCells';
import { getLegalReadiness } from '../../utils/legalPageReadiness';
import { ADDON_CATALOG, isFeatureEnabled } from '../../config/addons';
import toast from 'react-hot-toast';
import {
  ArrowLeftIcon,
  ArrowTopRightOnSquareIcon,
  UserPlusIcon,
  ArrowDownTrayIcon,
  RocketLaunchIcon,
} from '@heroicons/react/24/outline';

// Module-scope so it isn't re-created each render — a fresh Card identity every
// render would remount its children (e.g. CommissionCell would lose its edit state).
const Card = ({ title, children, action }) => (
  <div className="rounded-xl border border-white/10 bg-gray-900 p-5">
    <div className="flex items-center justify-between mb-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">{title}</h2>
      {action}
    </div>
    {children}
  </div>
);

const PlatformShopDetail = () => {
  const { shopId } = useParams();
  const [shop, setShop] = useState(null);
  const [counts, setCounts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  // Which async action is in flight ('published' | 'status' | 'connect' | null),
  // so each button only disables ITSELF — not unrelated controls on the page.
  const [busy, setBusy] = useState(null);
  const [addUser, setAddUser] = useState(false);
  const [migrate, setMigrate] = useState(false);
  const [migrateWoo, setMigrateWoo] = useState(false);
  const [impersonate, setImpersonate] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const snap = await getDoc(doc(db, 'shops', shopId));
      if (!snap.exists()) {
        setNotFound(true);
        return;
      }
      setShop({ id: snap.id, ...snap.data() });

      // Same aggregation pattern as PlatformShops.loadShops.
      const c = {};
      for (const col of ['products', 'orders', 'b2cCustomers']) {
        try {
          const agg = await getCountFromServer(
            query(collection(db, col), where('shopId', '==', shopId))
          );
          c[col] = agg.data().count;
        } catch {
          c[col] = null;
        }
      }
      setCounts(c);
    } catch (e) {
      console.error('Error loading shop:', e);
      toast.error('Kunde inte ladda butiken');
    } finally {
      setLoading(false);
    }
  }, [shopId]);

  useEffect(() => {
    load();
  }, [load]);

  // Searchability derivation — IDENTICAL to the storefront gate (ShopGate): only
  // an explicit published===false hides the shop from search engines. undefined/
  // true = searchable/indexable. The STORE is open + shoppable either way; this
  // only controls whether Google/Bing may index it.
  const isSearchable = shop ? shop.published !== false : false;
  const disabled = shop?.status === 'disabled';

  // GO LIVE (make searchable) / TA UR SÖK (hide from search). Platform-only
  // Firestore write (rules: allow update if isPlatform()). Mirrors toggleStatus.
  const togglePublished = async () => {
    const next = !isSearchable; // becoming searchable = true
    if (next) {
      // Making it searchable warns if the shop isn't ready (legal pages / payments)
      // — you'd be inviting Google to index a half-finished store. Operator's call,
      // so it's a warning, not a hard block.
      const gaps = [];
      if (!getLegalReadiness(shop.storeIdentity || {}).ready) gaps.push('juridiska sidor ej klara');
      if (!shop.payments?.chargesEnabled) gaps.push('kan inte ta betalt än');
      const warn = gaps.length ? `\n\nOBS: ${gaps.join(', ')}.` : '';
      if (!window.confirm(`Vill du göra "${shop.name || shop.id}" sökbar (GO LIVE)?${warn}`)) return;
    } else if (!window.confirm(`Vill du dölja "${shop.name || shop.id}" från sökmotorer? Butiken förblir öppen via länk.`)) {
      return;
    }
    try {
      setBusy('published');
      await updateDoc(doc(db, 'shops', shop.id), { published: next });
      setShop((prev) => ({ ...prev, published: next }));
      toast.success(next ? 'Butiken är nu sökbar (indexeras)' : 'Butiken är nu dold för sökmotorer');
    } catch (e) {
      console.error('Error toggling published:', e);
      toast.error('Kunde inte ändra sökbarhet');
    } finally {
      setBusy(null);
    }
  };

  const toggleStatus = async () => {
    const next = disabled ? 'active' : 'disabled';
    const verb = next === 'disabled' ? 'inaktivera' : 'aktivera';
    if (!window.confirm(`Vill du ${verb} "${shop.name || shop.id}"?`)) return;
    try {
      setBusy('status');
      await updateDoc(doc(db, 'shops', shop.id), { status: next });
      setShop((prev) => ({ ...prev, status: next }));
      toast.success(`"${shop.name || shop.id}" ${next === 'disabled' ? 'inaktiverad' : 'aktiverad'}`);
    } catch (e) {
      console.error('Error toggling status:', e);
      toast.error('Kunde inte ändra status');
    } finally {
      setBusy(null);
    }
  };

  // Operator opt-in for Stripe Connect (lets the shop START onboarding). Pure
  // Firestore write; mirrors PlatformShops.toggleConnectEnabled.
  const toggleConnectEnabled = async () => {
    const next = !(shop.payments?.connectEnabled === true);
    try {
      setBusy('connect');
      await updateDoc(doc(db, 'shops', shop.id), { 'payments.connectEnabled': next });
      setShop((prev) => ({ ...prev, payments: { ...(prev.payments || {}), connectEnabled: next } }));
      toast.success(`Betalningar ${next ? 'aktiverade' : 'inaktiverade'} för "${shop.name || shop.id}"`);
    } catch (e) {
      console.error('Error toggling connectEnabled:', e);
      toast.error('Kunde inte ändra betalningsinställning');
    } finally {
      setBusy(null);
    }
  };

  const openStorefront = () => {
    window.open(`${APP_URLS.B2C_SHOP}/${shop.id}`, '_blank', 'noopener');
  };

  const backLink = (
    <Link to="/shops" className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200">
      <ArrowLeftIcon className="h-4 w-4" />
      Butiker
    </Link>
  );

  if (loading) {
    return (
      <PlatformLayout>
        <div className="px-6 lg:px-10 py-8 max-w-[1100px]">
          {backLink}
          <div className="py-16 text-center text-gray-500">Laddar…</div>
        </div>
      </PlatformLayout>
    );
  }

  if (notFound) {
    return (
      <PlatformLayout>
        <div className="px-6 lg:px-10 py-8 max-w-[1100px]">
          {backLink}
          <div className="mt-8 rounded-xl border border-white/10 bg-gray-900 py-16 text-center text-gray-400">
            Butiken <span className="font-mono text-gray-300">{shopId}</span> hittades inte.
          </div>
        </div>
      </PlatformLayout>
    );
  }

  const storefrontUrl = `${APP_URLS.B2C_SHOP}/${shop.id}`;
  const c = connectLabel(shop);

  return (
    <PlatformLayout>
      <div className="px-6 lg:px-10 py-8 max-w-[1100px]">
        {backLink}

        {/* Header */}
        <div className="mt-4 mb-8 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-white">{shop.name || shop.id}</h1>
            <div className="mt-1 font-mono text-sm text-gray-500">{shop.id}</div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={
                'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ' +
                (isSearchable ? 'bg-green-500/15 text-green-300' : 'bg-amber-500/15 text-amber-300')
              }
            >
              {isSearchable ? 'Sökbar' : 'Dold för sök'}
            </span>
            <span
              className={
                'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ' +
                (disabled ? 'bg-red-500/15 text-red-300' : 'bg-green-500/15 text-green-300')
              }
            >
              {disabled ? 'Inaktiverad' : 'Aktiv'}
            </span>
          </div>
        </div>

        <div className="space-y-5">
          {/* Searchability gate — the headline section. NOTE: this only controls
              search-engine indexing. The store is open + shoppable via link either
              way; "dold för sök" ≠ closed. */}
          <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-xl">
                <h2 className="flex items-center gap-2 text-base font-semibold text-white">
                  <RocketLaunchIcon className="h-5 w-5 text-indigo-300" />
                  Sökbarhet
                </h2>
                <p className="mt-2 text-sm text-gray-400">
                  {isSearchable ? (
                    <>Butiken är <span className="text-green-300 font-medium">sökbar</span> — Google och Bing får indexera{' '}
                      <a href={storefrontUrl} target="_blank" rel="noopener noreferrer" className="text-indigo-300 hover:underline">{storefrontUrl}</a>.</>
                  ) : (
                    <>Butiken är <span className="text-amber-300 font-medium">dold för sökmotorer</span> (noindex).
                      Den är fortfarande <span className="text-gray-300 font-medium">öppen och köpbar</span> via länk —
                      bara osynlig i Google/Bing tills du klickar GO LIVE.</>
                  )}
                </p>
                <p className="mt-2 text-xs text-gray-600">
                  Ändringen slår igenom när storefronten laddas om.
                </p>
              </div>
              <button
                onClick={togglePublished}
                disabled={busy === 'published'}
                className={
                  'inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50 ' +
                  (isSearchable
                    ? 'bg-white/5 text-gray-300 hover:bg-amber-500/15 hover:text-amber-300'
                    : 'bg-indigo-600 text-white hover:bg-indigo-500')
                }
              >
                <RocketLaunchIcon className="h-4 w-4" />
                {busy === 'published' ? '…' : isSearchable ? 'TA UR SÖK' : 'GO LIVE'}
              </button>
            </div>
          </div>

          {/* Overview / counts */}
          <Card title="Översikt">
            <div className="grid grid-cols-3 gap-4">
              {[
                ['Produkter', counts?.products],
                ['Ordrar', counts?.orders],
                ['Kunder', counts?.b2cCustomers],
              ].map(([label, val]) => (
                <div key={label} className="rounded-lg border border-white/10 bg-gray-950 p-4">
                  <div className="text-2xl font-bold tabular-nums text-white">{val ?? '–'}</div>
                  <div className="mt-1 text-xs text-gray-500">{label}</div>
                </div>
              ))}
            </div>
          </Card>

          {/* Funktioner — display-only. Butikstyp pill is derived from LIVE
              features.pod (never the immutable shopType audit crumb, D1), so it
              always reflects reality even if /addons toggled pod after creation.
              /addons stays the single write surface — no toggles here. */}
          <Card
            title="Funktioner"
            action={
              <Link to="/addons" className="text-sm text-indigo-300 hover:text-indigo-200">
                Hantera tillägg →
              </Link>
            }
          >
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-gray-400">Butikstyp</span>
              <span
                className={
                  'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ' +
                  (isFeatureEnabled(shop.features, 'pod') ? 'bg-indigo-500/15 text-indigo-300' : 'bg-white/5 text-gray-300')
                }
              >
                {isFeatureEnabled(shop.features, 'pod') ? 'POD-butik' : 'Vanlig butik'}
              </span>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {ADDON_CATALOG.filter((a) =>
                a.key === 'contentStudio' ? shop.features?.contentStudio === true : isFeatureEnabled(shop.features, a.key)
              ).map((a) => (
                <span
                  key={a.key}
                  className="inline-flex items-center rounded-full bg-white/5 px-2.5 py-0.5 text-xs text-gray-300"
                >
                  {a.label}
                </span>
              ))}
            </div>
          </Card>

          {/* Betalningar (Connect) */}
          <Card
            title="Betalningar"
            action={<span className={'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ' + c.cls}>{c.text}</span>}
          >
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-gray-400">
                Bjud in butiken att aktivera Stripe Connect. Butiken slutför onboarding själv innan den kan ta betalt.
              </p>
              {!shop.payments?.chargesEnabled && (
                <button
                  onClick={toggleConnectEnabled}
                  disabled={busy === 'connect'}
                  className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium bg-white/5 text-gray-200 hover:bg-sky-500/15 hover:text-sky-300 disabled:opacity-50"
                >
                  {busy === 'connect' ? '…' : shop.payments?.connectEnabled ? 'Återkalla inbjudan' : 'Bjud in'}
                </button>
              )}
            </div>
          </Card>

          {/* Avgift (commission) */}
          <Card title="Avgift">
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-gray-400">Plattformsavgift för denna butik (annars gäller standard).</p>
              <CommissionCell
                shop={shop}
                onSaved={(bps) => setShop((prev) => ({ ...prev, payments: { ...(prev.payments || {}), commissionBps: bps } }))}
              />
            </div>
          </Card>

          {/* Juridik (legal readiness) */}
          <Card title="Juridik" action={<LegalCell shop={shop} />}>
            <p className="text-sm text-gray-400">
              Butikens automatiska juridiska sidor (returadress, moms) är {' '}
              publiceringsklara när status visar &ldquo;Klar&rdquo;.
            </p>
          </Card>

          {/* Åtgärder */}
          <Card title="Åtgärder">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={openStorefront}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium bg-white/5 text-gray-200 hover:bg-white/10"
              >
                <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                Öppna storefront
              </button>
              <button
                onClick={() => setAddUser(true)}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium bg-white/5 text-gray-200 hover:bg-indigo-500/15 hover:text-indigo-300"
              >
                <UserPlusIcon className="h-4 w-4" />
                Lägg till admin
              </button>
              <button
                onClick={() => setMigrate(true)}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium bg-white/5 text-gray-200 hover:bg-emerald-500/15 hover:text-emerald-300"
              >
                <ArrowDownTrayIcon className="h-4 w-4" />
                Migrera från Shopify
              </button>
              <button
                onClick={() => setMigrateWoo(true)}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium bg-white/5 text-gray-200 hover:bg-purple-500/15 hover:text-purple-300"
              >
                <ArrowDownTrayIcon className="h-4 w-4" />
                Migrera från WooCommerce
              </button>
              <button
                onClick={() => setImpersonate(true)}
                disabled={disabled}
                title={disabled ? 'Butiken är inaktiverad — aktivera först' : 'Öppna butikens admin som plattformsadmin (loggas)'}
                className={
                  'inline-flex items-center rounded-lg px-3 py-2 text-sm font-medium ' +
                  (disabled
                    ? 'bg-white/5 text-gray-600 cursor-not-allowed'
                    : 'bg-white/5 text-gray-200 hover:bg-amber-500/15 hover:text-amber-300')
                }
              >
                Öppna Shop Admin
              </button>
              <button
                onClick={toggleStatus}
                disabled={busy === 'status'}
                className={
                  'inline-flex items-center rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 ' +
                  (disabled
                    ? 'bg-green-600 text-white hover:bg-green-500'
                    : 'bg-white/5 text-gray-300 hover:bg-red-500/15 hover:text-red-300')
                }
              >
                {busy === 'status' ? '…' : disabled ? 'Aktivera butik' : 'Inaktivera butik'}
              </button>
            </div>
          </Card>
        </div>
      </div>

      {addUser && <AddShopUserModal shop={shop} onClose={() => setAddUser(false)} />}
      {migrate && <MigrateShopifyModal shop={shop} onClose={() => setMigrate(false)} />}
      {migrateWoo && <MigrateWooModal shop={shop} onClose={() => setMigrateWoo(false)} />}
      {impersonate && <ImpersonateShopModal shop={shop} onClose={() => setImpersonate(false)} />}
    </PlatformLayout>
  );
};

export default PlatformShopDetail;
