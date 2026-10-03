import React, { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  BALANCE_READ,
  callConnect,
  connectEnabledFor,
  getConnectBalance,
  getPayoutDelay,
  refreshOnReturn,
  setPayoutDelay,
  subscribeConnect,
  useLoginLinkRefusal,
} from './adminPaymentsData';
import { useShopId } from '../../contexts/ShopContext';
import { useAuth } from '../../contexts/AuthContext';
import AppLayout from '../../components/layout/AppLayout';
import { Page, Card, CardSection, Button, StatusPill } from '../../components/admin/ui';

/**
 * AdminPayments — per-shop Stripe Connect onboarding + payout status.
 *
 * The front door for a shop to start receiving payouts: it shows the connected-
 * account status and the right CTA for each state, all driven by the
 * connectOnboarding callables. The shop boundary is enforced server-side
 * (requireAdminOfShop) — this page only ever acts on the admin's managed shop
 * (useShopId). The platform commission rate is shown read-only here; it's set
 * from the platform console (Slice 3).
 *
 * Onboarding gotcha handled: returning from Stripe-hosted onboarding (?return=1)
 * does NOT mean it finished, so on mount with ?return/?refresh we re-poll via
 * refreshConnectStatus rather than trusting the redirect.
 */

const STATUS_UI = {
  none:       { tone: 'neutral',  label: 'Ej aktiverat' },
  onboarding: { tone: 'info',     label: 'Påbörjad' },
  pending:    { tone: 'warning',  label: 'Granskas av Stripe' },
  restricted: { tone: 'danger',   label: 'Åtgärd krävs' },
  active:     { tone: 'success',  label: 'Aktivt' },
};

// Stripe requirement codes → plain Swedish. The shop owner should never see
// raw codes like "individual.verification.document"; anything unmapped folds
// into one generic line. Order matters — most specific prefix first.
const REQUIREMENT_LABELS = [
  { match: (c) => c.includes('verification'),          label: 'ID-handling / verifiering' },
  { match: (c) => c.startsWith('external_account'),    label: 'Bankkonto för utbetalningar' },
  { match: (c) => c.startsWith('tos_acceptance'),      label: 'Godkännande av Stripes villkor' },
  { match: (c) => c.startsWith('business_profile'),    label: 'Uppgifter om verksamheten' },
  { match: (c) => c.startsWith('company'),             label: 'Företagsuppgifter' },
  { match: (c) => c.startsWith('individual') || c.startsWith('person_') || c.startsWith('representative'),
                                                       label: 'Personuppgifter' },
  { match: (c) => c.startsWith('directors') || c.startsWith('owners') || c.startsWith('relationship'),
                                                       label: 'Uppgifter om ägare/företrädare' },
];

const humanizeRequirements = (codes) => {
  const labels = [];
  let hasUnknown = false;
  for (const code of codes) {
    const hit = REQUIREMENT_LABELS.find((r) => r.match(code));
    if (hit) {
      if (!labels.includes(hit.label)) labels.push(hit.label);
    } else {
      hasUnknown = true;
    }
  }
  if (hasUnknown) labels.push('Övriga uppgifter (visas hos Stripe)');
  return labels;
};

// The whole journey in three steps, so the owner always knows where they are.
const stepsForStatus = (status) => {
  const idx = { none: 0, onboarding: 1, restricted: 1, pending: 2, active: 3 }[status] ?? 0;
  return [
    { label: 'Starta' },
    { label: 'Fyll i uppgifter hos Stripe' },
    { label: 'Utbetalningar aktiva' },
  ].map((s, i) => ({ ...s, state: i < idx ? 'done' : i === idx ? 'current' : 'upcoming' }));
};

const Steps = ({ status }) => (
  <ol className="flex flex-wrap items-center gap-x-2 gap-y-2 mb-4">
    {stepsForStatus(status).map((s, i) => (
      <li key={s.label} className="flex items-center gap-2">
        {i > 0 && <span className="w-5 h-px bg-admin-border" aria-hidden="true" />}
        <span
          className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-semibold ${
            s.state === 'done'
              ? 'bg-[var(--color-admin-primary)] text-white dark:text-admin-bg'
              : s.state === 'current'
                ? 'border border-[var(--color-admin-primary)] text-admin-text'
                : 'border border-admin-border text-admin-text-muted'
          }`}
        >
          {s.state === 'done' ? '✓' : i + 1}
        </span>
        <span className={`text-[13px] ${s.state === 'upcoming' ? 'text-admin-text-muted' : 'text-admin-text'}`}>
          {s.label}
        </span>
      </li>
    ))}
  </ol>
);

const AdminPayments = () => {
  const shopId = useShopId();
  const location = useLocation();
  const navigate = useNavigate();
  const { isPlatform } = useAuth();
  const loginLinkRefusal = useLoginLinkRefusal(shopId);

  const [pay, setPay] = useState(null);       // shops/{id}.payments
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');        // which action is running
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeTone, setNoticeTone] = useState('info'); // 'info' | 'success'

  // Live subscription to the shop's payments map.
  useEffect(() => {
    if (!shopId) return;
    const unsub = subscribeConnect(
      shopId,
      (payments) => {
        setPay(payments);
        setLoading(false);
      },
      (e) => { setError(e.message); setLoading(false); }
    );
    return () => unsub();
  }, [shopId]);

  const call = useCallback((name) => callConnect(shopId, name), [shopId]);

  // On return from Stripe onboarding, re-poll the real status (don't trust ?return).
  // The return_url carries ?shopId= (set server-side) so the managed-shop context
  // survives the Stripe round-trip. While that param is still present,
  // AdminShopIdIntake hasn't pinned the managed shop yet — refreshing now would
  // hit whatever shop the context defaulted to (the original wrong-shop-binding
  // bug), so wait for the intake to strip it; this effect re-runs on that
  // navigation via location.search.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (!shopId) return;
    if (q.get('shopId')) return;
    if (q.get('return') === '1' || q.get('refresh') === '1') {
      (async () => {
        try {
          setBusy('refresh');
          setError('');
          const res = await refreshOnReturn(shopId);
          if (res?.chargesEnabled) {
            setNoticeTone('success');
            setNotice('Klart! Utbetalningar är nu aktiverade för din butik.');
          } else {
            setNoticeTone('info');
            setNotice('Status uppdaterad från Stripe.');
          }
        } catch (e) {
          setError(e.message || 'Kunde inte uppdatera status.');
        } finally {
          setBusy('');
          // Strip the query params so a reload doesn't re-trigger. Via the
          // router (not history.replaceState) so location.search stays in sync
          // and this effect doesn't re-fire on a later managed-shop switch.
          navigate('/admin/payments', { replace: true });
        }
      })();
    }
  }, [shopId, location.search, navigate]);

  const run = async (name, action) => {
    setError(''); setNotice(''); setBusy(action);
    try {
      const data = await call(name);
      if (data?.url) { window.location.href = data.url; return; }
      if (name === 'refreshConnectStatus') {
        if (data?.chargesEnabled) {
          setNoticeTone('success');
          setNotice('Klart! Utbetalningar är nu aktiverade för din butik.');
        } else {
          setNoticeTone('info');
          setNotice('Status uppdaterad.');
        }
      }
    } catch (e) {
      setError(e.message || 'Något gick fel.');
    } finally {
      setBusy('');
    }
  };

  if (loading) {
    return (
      <AppLayout>
        <Page title="Utbetalningar">
          <Card className="flex items-center justify-center py-16">
            <span className="text-[13px] text-admin-text-muted">Laddar…</span>
          </Card>
        </Page>
      </AppLayout>
    );
  }

  const status = pay?.connectStatus || 'none';
  const ui = STATUS_UI[status] || STATUS_UI.none;
  const connectEnabled = connectEnabledFor(pay, isPlatform);
  const hasAccount = !!pay?.stripeAccountId;
  const chargesEnabled = pay?.chargesEnabled === true;
  const requirementsDue = Array.isArray(pay?.requirementsDue) ? pay.requirementsDue : [];
  const requirementLabels = humanizeRequirements(requirementsDue);

  return (
    <AppLayout>
    <Page
      title="Utbetalningar"
      subtitle="Ta emot betalningar och få utbetalt via Stripe"
    >
      <div className="space-y-4">
        {error && (
          <div className="rounded-md bg-red-50 border-l-4 border-red-400 p-3 text-[13px] text-red-700">{error}</div>
        )}
        {notice && (
          <div className={`rounded-md border-l-4 p-3 text-[13px] ${
            noticeTone === 'success'
              ? 'bg-emerald-50 border-emerald-400 text-emerald-700'
              : 'bg-sky-50 border-sky-400 text-sky-700'
          }`}>{notice}</div>
        )}

        <CardSection title="Status">
          <div className="flex items-center gap-3 mb-3">
            <StatusPill tone={ui.tone}>{ui.label}</StatusPill>
            {chargesEnabled && <span className="text-[13px] text-admin-text-muted">Du kan ta emot betalningar.</span>}
          </div>

          {connectEnabled && <Steps status={status} />}

          {/* A live account keeps charging via Connect regardless of the
              connectEnabled invite flag (the money path keys on chargesEnabled),
              so never show "not enabled" once charges are enabled. */}
          {!connectEnabled && !chargesEnabled && (
            <p className="text-[13px] text-admin-text-muted">
              Utbetalningar är inte aktiverade för din butik ännu. Kontakta oss för att komma igång.
            </p>
          )}

          {connectEnabled && !hasAccount && status === 'none' && (
            <>
              <p className="text-[13px] text-admin-text-muted mb-2">
                Koppla din butik till Stripe för att ta emot betalningar och få pengarna
                utbetalda direkt till ditt bankkonto. Det tar ungefär 5–10 minuter.
              </p>
              <p className="text-[13px] text-admin-text-muted mb-1">Bra att ha till hands:</p>
              <ul className="mb-4 text-[13px] text-admin-text-muted list-disc pl-5">
                <li>Organisationsnummer eller personnummer</li>
                <li>Bankkontonummer (dit pengarna ska betalas ut)</li>
                <li>ID-handling (t.ex. pass eller körkort)</li>
              </ul>
              <Button variant="primary" disabled={busy === 'start'} onClick={() => run('createConnectAccount', 'start')}>
                {busy === 'start' ? 'Öppnar…' : 'Aktivera utbetalningar'}
              </Button>
            </>
          )}

          {connectEnabled && hasAccount && !chargesEnabled && status !== 'pending' && (
            <>
              <p className="text-[13px] text-admin-text-muted mb-3">
                {status === 'restricted'
                  ? 'Stripe behöver mer information innan du kan ta emot betalningar.'
                  : 'Du har påbörjat aktiveringen men allt är inte klart ännu. Fortsätt där du slutade — det du redan fyllt i är sparat.'}
              </p>
              {requirementLabels.length > 0 && (
                <>
                  <p className="text-[12px] text-admin-text-muted mb-1">Det här saknas:</p>
                  <ul className="mb-3 text-[12px] text-admin-text-muted list-disc pl-5">
                    {requirementLabels.map((r) => <li key={r}>{r}</li>)}
                  </ul>
                </>
              )}
              <div className="flex items-center gap-3">
                <Button variant="primary" disabled={busy === 'continue'} onClick={() => run('createConnectAccountLink', 'continue')}>
                  {busy === 'continue' ? 'Öppnar…' : 'Fortsätt hos Stripe'}
                </Button>
                <Button variant="secondary" disabled={busy === 'refresh'} onClick={() => run('refreshConnectStatus', 'refresh')}>
                  {busy === 'refresh' ? 'Uppdaterar…' : 'Uppdatera status'}
                </Button>
              </div>
            </>
          )}

          {connectEnabled && hasAccount && !chargesEnabled && status === 'pending' && (
            <>
              <p className="text-[13px] text-admin-text-muted mb-3">
                Klart från din sida! Stripe granskar dina uppgifter — det brukar gå snabbt
                (oftast minuter, ibland upp till någon dag). Statusen uppdateras automatiskt,
                och du kan även uppdatera den själv här.
              </p>
              <div className="flex items-center gap-3">
                <Button variant="primary" disabled={busy === 'refresh'} onClick={() => run('refreshConnectStatus', 'refresh')}>
                  {busy === 'refresh' ? 'Uppdaterar…' : 'Uppdatera status'}
                </Button>
                {requirementLabels.length > 0 && (
                  <Button variant="secondary" disabled={busy === 'continue'} onClick={() => run('createConnectAccountLink', 'continue')}>
                    {busy === 'continue' ? 'Öppnar…' : 'Öppna Stripe igen'}
                  </Button>
                )}
              </div>
            </>
          )}

          {chargesEnabled && (
            <>
              <p className="text-[13px] text-admin-text-muted mb-3">
                Allt är klart. Din butik tar emot betalningar och Stripe betalar ut pengarna
                till ditt bankkonto automatiskt. I Stripe-panelen ser du saldo och kommande utbetalningar.
              </p>
              <div className="flex items-center gap-3">
                <Button variant="secondary" disabled={busy === 'dashboard' || !!loginLinkRefusal} title={loginLinkRefusal || undefined} onClick={() => run('createConnectLoginLink', 'dashboard')}>
                  {busy === 'dashboard' ? 'Öppnar…' : 'Öppna Stripe-panel'}
                </Button>
                <Button variant="plain" disabled={busy === 'refresh'} onClick={() => run('refreshConnectStatus', 'refresh')}>
                  {busy === 'refresh' ? 'Uppdaterar…' : 'Uppdatera status'}
                </Button>
              </div>
              {loginLinkRefusal && (
                <p className="mt-2 text-[12px] text-admin-text-muted">{loginLinkRefusal}</p>
              )}
            </>
          )}
        </CardSection>

        {/* Platform commission is a PLATFORM decision — set per-shop in the
            platform console (PlatformShops), never shown/editable here on the
            shop owner's page. (setShopCommission is requirePlatform server-side.) */}

        {/* Balance & payout risk — noise before money can flow, so only once
            the account is live (charges enabled). */}
        {hasAccount && chargesEnabled && BALANCE_READ && (
          <CardSection title="Saldo & utbetalningsrisk">
            <BalancePanel shopId={shopId} isPlatform={isPlatform} />
          </CardSection>
        )}
        {/* Without a balance read, the payout-delay control stands alone,
            for the platform only. */}
        {hasAccount && chargesEnabled && !BALANCE_READ && isPlatform && (
          <CardSection title="Saldo & utbetalningsrisk">
            <PayoutDelayPanel shopId={shopId} />
          </CardSection>
        )}
      </div>
    </Page>
    </AppLayout>
  );
};

// Connected-account balance + (platform-only) per-account payout-delay control.
// The balance read is shop-admin-allowed (own shop); setting the delay is a
// platform risk decision (setConnectPayoutDelay is requirePlatform server-side).
const BalancePanel = ({ shopId, isPlatform }) => {
  const [bal, setBal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      setLoading(true);
      setBal(await getConnectBalance(shopId));
    } catch (e) {
      setErr(e.message || 'Kunde inte hämta saldo.');
    } finally {
      setLoading(false);
    }
  }, [shopId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="text-[13px] text-admin-text-muted">Hämtar saldo…</p>;
  if (err) return <p className="text-[13px] text-red-700">{err}</p>;
  if (!bal?.hasAccount) return <p className="text-[13px] text-admin-text-muted">Inget anslutet konto ännu.</p>;

  const sek = (ore) => `${(ore / 100).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kr`;

  return (
    <div className="space-y-3">
      {bal.negative && (
        <div className="rounded-md bg-red-50 border-l-4 border-red-400 p-3 text-[13px] text-red-700">
          ⚠️ Negativt saldo på det anslutna kontot ({sek(bal.availableOre)}). Stripe drar inte automatiskt
          från säljarens bankkonto i SE/EU — saldot kan ligga kvar tills det regleras.
        </div>
      )}
      <div className="grid grid-cols-3 gap-3 text-[13px]">
        <div>
          <div className="text-[12px] text-admin-text-muted">Tillgängligt</div>
          <div className={`tabular-nums ${bal.negative ? 'text-red-700 font-semibold' : 'text-admin-text'}`}>{sek(bal.availableOre)}</div>
        </div>
        <div>
          <div className="text-[12px] text-admin-text-muted">Väntande</div>
          <div className="tabular-nums text-admin-text">{sek(bal.pendingOre)}</div>
        </div>
        {bal.reservedOre > 0 && (
          <div>
            <div className="text-[12px] text-admin-text-muted">Reserverat</div>
            <div className="tabular-nums text-admin-text">{sek(bal.reservedOre)}</div>
          </div>
        )}
      </div>
      <Button variant="plain" onClick={load}>Uppdatera saldo</Button>

      {isPlatform && <PayoutDelayEditor shopId={shopId} current={bal.payoutDelayDays} onSaved={load} />}
    </div>
  );
};

// Platform-only, where no balance read exists: the payout-delay control with
// the current delay as the platform reads it.
const PayoutDelayPanel = ({ shopId }) => {
  const [current, setCurrent] = useState(undefined);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      setCurrent(await getPayoutDelay(shopId));
    } catch (e) {
      setErr(e.message || 'Något gick fel.');
    } finally {
      setLoading(false);
    }
  }, [shopId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return null;
  if (err) return <p className="text-[13px] text-red-700">{err}</p>;
  return <PayoutDelayEditor shopId={shopId} current={current} onSaved={load} standalone />;
};

// Platform-only: hold a SPECIFIC seller's payouts longer (targeted risk control,
// not a blanket hold). 'minimum' resets to the account-country floor.
// `standalone`: the first thing in its section (no balance above it), so no divider.
const PayoutDelayEditor = ({ shopId, current, onSaved, standalone = false }) => {
  const [days, setDays] = useState(typeof current === 'number' ? String(current) : '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const save = async (value) => {
    setMsg('');
    try {
      setSaving(true);
      await setPayoutDelay(shopId, value);
      setMsg('Sparat.');
      onSaved?.();
    } catch (e) {
      setMsg(e.message || 'Kunde inte spara.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={standalone ? undefined : 'mt-3 border-t border-admin-border-soft pt-3'}>
      <label className="block text-[12px] font-semibold text-admin-text-muted mb-1">
        Utbetalningsfördröjning (dagar) — riskkontroll för denna säljare
      </label>
      <div className="flex items-end gap-3">
        <input
          type="number" min="0" max="365" step="1" value={days}
          onChange={(e) => setDays(e.target.value)}
          placeholder="t.ex. 7"
          className="w-28 rounded-md border border-admin-border bg-admin-surface px-3 py-1.5 text-[13px] text-admin-text"
        />
        <Button variant="primary" disabled={saving} onClick={() => {
          const n = parseInt(days, 10);
          if (!Number.isInteger(n) || n < 0 || n > 365) { setMsg('Ange 0–365 dagar.'); return; }
          save(n);
        }}>
          {saving ? 'Sparar…' : 'Sätt fördröjning'}
        </Button>
        <Button variant="plain" disabled={saving} onClick={() => save('minimum')}>
          Återställ till minimum
        </Button>
        {msg && <span className="text-[12px] text-admin-text-muted">{msg}</span>}
      </div>
      {typeof current !== 'undefined' && current !== null && (
        <p className="mt-1 text-[12px] text-admin-text-muted">Nuvarande: {current === 'minimum' ? 'minimum' : `${current} dagar`}</p>
      )}
    </div>
  );
};

// (CommissionEditor moved to the platform console — PlatformShops. The platform
// fee is a platform decision and is never shown/set on the shop owner's page.)

export default AdminPayments;
