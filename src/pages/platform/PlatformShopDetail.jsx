// PlatformShopDetail — the operator's per-shop drill-down page (/shops/:shopId).
// Home for every per-shop action moved off the (formerly overcrowded) fleet row:
// the GO LIVE gate, counts, payments/Connect, commission, legal readiness, and the
// add-user / migrate / impersonate actions. Platform-only. DARK design
// (PlatformLayout). (docs/PLATFORM_ARCHITECTURE.md)
import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  MIGRATORS,
  PUBLISH_COPY,
  SHOW_COUNTS,
  COUNT_COLUMNS,
  loadShop,
  openStorefront,
  setShopConnectEnabled,
  setShopPublished,
  setShopStatus,
  setShopSupportEmail,
  storefrontUrlOf,
  SUPPORT_EMAIL_EDITABLE,
} from './platformShopDetailData';
import PlatformLayout from '../../components/platform/PlatformLayout';
import ImpersonateShopModal from '../../components/platform/ImpersonateShopModal';
import AddShopUserModal from '../../components/platform/AddShopUserModal';
import MigrateShopifyModal from '../../components/platform/MigrateShopifyModal';
import MigrateWooModal from '../../components/platform/MigrateWooModal';
import { connectLabel, LegalCell, CommissionCell, platformTermsBadge } from './shopCells';
import { LEGAL_FACTS, legalReadinessOf } from './shopCellsData';
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
// ISO timestamp → Swedish local date+time; passes anything unparseable through.
const fmtDateTime = (iso) => {
  const v = String(iso || '').trim();
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString('sv-SE');
};

const Card = ({ title, children, action, tone }) => (
  <div className={`rounded-xl border bg-gray-900 p-5 ${tone === 'warn' ? 'border-amber-500/30' : 'border-white/10'}`}>
    <div className="flex items-center justify-between mb-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">{title}</h2>
      {action}
    </div>
    {children}
  </div>
);

// CP9-OB: an address at a placeholder domain is not the shop's (the legal
// pages and the order mails refuse it, legal-identity.ts / order-emails.ts).
const PLACEHOLDER_ADDRESS = /@example\.(com|org|net|se)$/i;

// The shop's support address, set by the platform (D99). The seller cannot
// adopt its legal pages without it: they print it. Inline editor in the
// pattern of CommissionCell.
const SupportEmailCell = ({ shop, onSaved }) => {
  const current = typeof shop.supportEmail === 'string' && !PLACEHOLDER_ADDRESS.test(shop.supportEmail) ? shop.supportEmail : '';
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(current);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const email = value.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast.error('Ange en giltig e-postadress.'); return; }
    if (PLACEHOLDER_ADDRESS.test(email)) { toast.error('En adress på example.com räknas inte. Ange butikens riktiga adress.'); return; }
    try {
      setSaving(true);
      const stored = await setShopSupportEmail(shop, email || null);
      toast.success(stored ? `Support-e-post sparad: ${stored}` : 'Support-e-post borttagen');
      onSaved?.(stored);
      setEditing(false);
    } catch (e) {
      console.error('Error saving support email:', e);
      toast.error(e?.status === 400 ? 'Ange en giltig e-postadress.' : 'Kunde inte spara support-e-posten.');
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button
        onClick={() => { setValue(current); setEditing(true); }}
        className="inline-flex items-center gap-1.5 rounded-lg bg-white/5 px-2.5 py-1 text-xs font-medium text-gray-200 hover:bg-indigo-500/15 hover:text-indigo-300"
      >
        {current || <span className="text-amber-300">Lägg in adress</span>}
      </button>
    );
  }

  return (
    <div className="flex w-full items-center gap-1.5 sm:w-auto">
      <input
        type="email" value={value} autoFocus
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
        placeholder="kundtjanst@butiken.se"
        className="min-w-0 flex-1 rounded-lg border border-white/10 bg-gray-950 px-2 py-1 text-xs text-gray-100 focus:border-indigo-500 focus:outline-none sm:w-56 sm:flex-none"
      />
      <button disabled={saving} onClick={save} className="rounded-lg bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
        {saving ? '…' : 'Spara'}
      </button>
      <button onClick={() => setEditing(false)} className="rounded-lg bg-white/5 px-2 py-1 text-xs text-gray-400 hover:bg-white/10">✕</button>
    </div>
  );
};

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
      const loaded = await loadShop(shopId);
      if (!loaded) {
        setNotFound(true);
        return;
      }
      setShop(loaded.shop);
      setCounts(loaded.counts);
    } catch (e) {
      console.error('Error loading shop:', e);
      toast.error('Kunde inte ladda butiken');
      setNotFound(true); // without a shop the page below cannot render (it used to go blank)
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
  // only controls whether Google/Bing may index it. (The admin build: unpublished
  // = closed, D57; the words come from the data module's PUBLISH_COPY.)
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
      if (!legalReadinessOf(shop).ready) gaps.push('juridiska sidor ej klara');
      if (!shop.payments?.chargesEnabled) gaps.push('kan inte ta betalt än');
      const warn = gaps.length ? `\n\nOBS: ${gaps.join(', ')}.` : '';
      if (!window.confirm(PUBLISH_COPY.confirmPublish(shop.name || shop.id, warn))) return;
    } else if (!window.confirm(PUBLISH_COPY.confirmUnpublish(shop.name || shop.id))) {
      return;
    }
    try {
      setBusy('published');
      await setShopPublished(shop, next);
      setShop((prev) => ({ ...prev, published: next }));
      toast.success(next ? PUBLISH_COPY.publishedToast : PUBLISH_COPY.unpublishedToast);
    } catch (e) {
      console.error('Error toggling published:', e);
      toast.error(PUBLISH_COPY.failedToast);
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
      await setShopStatus(shop, next);
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
      await setShopConnectEnabled(shop, next);
      setShop((prev) => ({ ...prev, payments: { ...(prev.payments || {}), connectEnabled: next } }));
      toast.success(`Betalningar ${next ? 'aktiverade' : 'inaktiverade'} för "${shop.name || shop.id}"`);
    } catch (e) {
      console.error('Error toggling connectEnabled:', e);
      toast.error('Kunde inte ändra betalningsinställning');
    } finally {
      setBusy(null);
    }
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

  const storefrontUrl = storefrontUrlOf(shop);
  const c = connectLabel(shop);
  const hasSupportEmail = typeof shop.supportEmail === 'string' && shop.supportEmail.trim() !== ''
    && !PLACEHOLDER_ADDRESS.test(shop.supportEmail);

  // Legal facts for the read-only Juridik card below.
  const legalReadiness = legalReadinessOf(shop);
  const legalBlockers = legalReadiness.blockers;
  const legalNeedsReaccept = legalReadiness.needsReacceptance;
  const rawLegalAcceptance = shop.storeIdentity?.legal?.acceptance;
  const legalAcceptance = String(rawLegalAcceptance?.acceptedAt || '').trim() ? rawLegalAcceptance : null;
  const ptBadge = platformTermsBadge(shop);
  const platformTermsAccepted = Boolean(String(shop.platformTerms?.acceptedAt || '').trim());

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
              {isSearchable ? PUBLISH_COPY.badgeOn : PUBLISH_COPY.badgeOff}
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
                  {PUBLISH_COPY.heading}
                </h2>
                <p className="mt-2 text-sm text-gray-400">
                  {isSearchable ? (
                    <>{PUBLISH_COPY.onLead}<span className="text-green-300 font-medium">{PUBLISH_COPY.onWord}</span>{PUBLISH_COPY.onTail}{' '}
                      <a href={storefrontUrl} target="_blank" rel="noopener noreferrer" className="text-indigo-300 hover:underline">{storefrontUrl}</a>.</>
                  ) : (
                    <>{PUBLISH_COPY.offLead}<span className="text-amber-300 font-medium">{PUBLISH_COPY.offWord}</span>{PUBLISH_COPY.offMiddle}<span className="text-gray-300 font-medium">{PUBLISH_COPY.offWord2}</span>{PUBLISH_COPY.offTail}</>
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
                {busy === 'published' ? '…' : isSearchable ? PUBLISH_COPY.unpublishButton : 'GO LIVE'}
              </button>
            </div>
          </div>

          {/* Overview / counts */}
          {SHOW_COUNTS && <Card title="Översikt">
            <div className="grid grid-cols-3 gap-4">
              {COUNT_COLUMNS.map((c) => [c.label, counts?.[c.key], c.title]).map(([label, val, title]) => (
                <div key={label} title={title} className="rounded-lg border border-white/10 bg-gray-950 p-4">
                  <div className="text-2xl font-bold tabular-nums text-white">{val ?? '–'}</div>
                  <div className="mt-1 text-xs text-gray-500">{label}</div>
                </div>
              ))}
            </div>
          </Card>}

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

          {/* Betalningar (Connect). CP9-OB: the card says which step the shop
              is at, and turns amber while it waits for the operator's "Bjud in". */}
          <Card
            title="Betalningar"
            tone={c.waitsForOperator ? 'warn' : undefined}
            action={<span className={'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ' + c.cls}>{c.text}</span>}
          >
            <div className="flex items-center justify-between gap-4">
              <p className={`text-sm ${c.waitsForOperator ? 'text-amber-200' : 'text-gray-400'}`}>
                {c.step}
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

          {/* Support-e-post (CP9-OB): the platform sets it (D99); the shop's
              legal pages print it, so the seller cannot adopt them without it. */}
          {SUPPORT_EMAIL_EDITABLE && (
            <Card title="Support-e-post" tone={hasSupportEmail ? undefined : 'warn'}>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <p className={`text-sm ${hasSupportEmail ? 'text-gray-400' : 'text-amber-200'}`}>
                  {hasSupportEmail
                    ? 'Adressen köparna når butiken på. Den står i butikens juridiska sidor och sidfot.'
                    : 'Saknas. Butiken kan inte godkänna sina juridiska sidor förrän du har lagt in den: sidorna skriver ut den.'}
                </p>
                <SupportEmailCell
                  shop={shop}
                  onSaved={(email) => setShop((prev) => ({ ...prev, supportEmail: email }))}
                />
              </div>
            </Card>
          )}

          {/* Juridik — two independent facts, read-only:
              (1) the shop's own consumer legal pages (readiness + who accepted
                  them), and (2) the platform's B2B terms the seller accepted to
                  use the admin. Neither is editable from here — the seller
                  accepts both themselves (never the operator, not even while
                  impersonating). */}
          <Card title="Juridik" action={<LegalCell shop={shop} />}>
            <p className="text-sm text-gray-400">
              Butikens automatiska juridiska sidor (returadress, moms) är{' '}
              publiceringsklara när status visar &ldquo;Juridik OK&rdquo;.
            </p>
            {legalBlockers.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm text-amber-300">
                {legalBlockers.map((b) => (
                  <li key={b.key}>• {b.label}</li>
                ))}
              </ul>
            )}
            {LEGAL_FACTS && <dl className="mt-4 space-y-3 border-t border-white/10 pt-4 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <dt className="text-gray-500">Butikens villkor godkända</dt>
                <dd className="text-gray-300">
                  {!legalAcceptance ? (
                    <span className="text-red-300">Ej godkända</span>
                  ) : (
                    <>
                      {legalAcceptance.email || legalAcceptance.uid || 'okänd användare'}
                      {' · '}
                      {fmtDateTime(legalAcceptance.acceptedAt)}
                      {' · v'}
                      {legalAcceptance.templateVersion || '–'}
                      {legalNeedsReaccept && (
                        <span className="ml-2 text-amber-300">behöver godkännas på nytt</span>
                      )}
                    </>
                  )}
                </dd>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <dt className="text-gray-500">Plattformsvillkor godkända</dt>
                <dd className="text-gray-300">
                  {!platformTermsAccepted ? (
                    <span className="text-red-300">Ej godkända</span>
                  ) : (
                    <>
                      {shop.platformTerms.email || shop.platformTerms.uid || 'okänd användare'}
                      {' · '}
                      {fmtDateTime(shop.platformTerms.acceptedAt)}
                      {' · v'}
                      {shop.platformTerms.version || '–'}
                      {ptBadge.tone === 'warn' && (
                        <span className="ml-2 text-amber-300">gammal version</span>
                      )}
                    </>
                  )}
                </dd>
              </div>
            </dl>}
          </Card>

          {/* Åtgärder */}
          <Card title="Åtgärder">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => openStorefront(shop)}
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
              {MIGRATORS && <button
                onClick={() => setMigrate(true)}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium bg-white/5 text-gray-200 hover:bg-emerald-500/15 hover:text-emerald-300"
              >
                <ArrowDownTrayIcon className="h-4 w-4" />
                Migrera från Shopify
              </button>}
              {MIGRATORS && <button
                onClick={() => setMigrateWoo(true)}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium bg-white/5 text-gray-200 hover:bg-purple-500/15 hover:text-purple-300"
              >
                <ArrowDownTrayIcon className="h-4 w-4" />
                Migrera från WooCommerce
              </button>}
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
