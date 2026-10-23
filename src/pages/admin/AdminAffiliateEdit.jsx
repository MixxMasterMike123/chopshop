// One affiliate (CP13 A2, design §7.2): statistics, the orders attributed to
// them, the ledger ("Reskontra") with adjustments, payouts, the editable
// details, the account (invite state) and the status. NOT behind the add-on
// gate (design §4.5): with the program switched OFF the page still opens (by
// direct link, or from an order's affiliate pill) and says so in a banner.
// Every figure is the server's; the page formats and never computes money.
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import AppLayout from '../../components/layout/AppLayout';
import { useShopId } from '../../contexts/ShopContext';
import { useShopFeatures } from '../../contexts/ShopFeaturesContext';
import {
  CAPABILITIES,
  PATHS,
  addAdjustment,
  loadAffiliate,
  loadAffiliateLedger,
  loadAffiliateOrders,
  loadAffiliatePayouts,
  removeAffiliate,
  resendInvite,
  saveAffiliate,
  setAffiliateStatus,
} from './adminAffiliateData';
import {
  AFFILIATE_STATUS,
  ATTRIBUTION,
  CODE_CHANGE_WARNING,
  COUNTRIES,
  LANGUAGES,
  LEDGER_KIND,
  ORDER_STATE,
  PAYOUT_STATUS,
  PROGRAM_OFF_BANNER,
  PROMOTION_METHODS,
  SELF_REFERRAL,
  SOCIALS,
  formatBp,
  formatCount,
  formatDay,
  formatMinor,
  formatSignedMinor,
  languageLabel,
  promotionLabel,
  balanceOf,
  clickSeries,
  editFormOf,
} from './affiliateView';
import AdminAffiliateApplication from './AdminAffiliateApplication';
import {
  Page,
  Card,
  CardSection,
  RightRail,
  Button,
  StatusPill,
  DataTable,
  SegmentedTabs,
  Field,
  Input,
  Select,
} from '../../components/admin/ui';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';

export const ProgramOffBanner = () => (
  <div role="status" className="mb-5 flex items-start gap-2 rounded-[var(--radius-admin)] border border-admin-caution-dot bg-admin-caution-bg px-4 py-3 text-[13px] text-admin-caution-text">
    <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
    <p>{PROGRAM_OFF_BANNER}</p>
  </div>
);

/** Link landings per day, the last 30 days (oldest left). */
const ClickBars = ({ series }) => {
  const max = Math.max(1, ...series);
  const total = series.reduce((sum, n) => sum + n, 0);
  return (
    <svg
      viewBox={`0 0 ${series.length * 6} 40`}
      preserveAspectRatio="none"
      className="h-12 w-full"
      role="img"
      aria-label={`Klick per dag de senaste 30 dagarna, ${total} totalt`}
    >
      {series.map((n, i) => {
        const h = n === 0 ? 1 : Math.max(2, (n / max) * 40);
        return <rect key={i} x={i * 6 + 1} y={40 - h} width="4" height={h} rx="1" fill={n === 0 ? 'var(--color-admin-border)' : 'var(--color-admin-text-faint)'} />;
      })}
    </svg>
  );
};

const Stat = ({ label, value }) => (
  <div>
    <div className="text-[12px] text-admin-text-muted">{label}</div>
    <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-admin-text">{value}</div>
  </div>
);

const Row = ({ label, children }) => (
  <div className="flex items-baseline justify-between gap-4 py-1 text-[13px]">
    <span className="text-admin-text-muted">{label}</span>
    <span className="min-w-0 break-words text-right text-admin-text">{children}</span>
  </div>
);

const STATUS_OPTIONS = ['active', 'inactive', 'suspended'].map((value) => ({ value, label: AFFILIATE_STATUS[value].label }));

const MEMBERSHIP_TEXT = {
  active: 'Kan logga in i affiliateportalen',
  revoked: 'Borttagen: kan inte logga in',
  suspended: 'Avstängd av plattformen',
};

const AdminAffiliateEdit = () => {
  const location = useLocation();
  // The older build routes an application here (/admin/affiliates/application/:id).
  if (location.pathname.includes('/affiliates/application/')) return <AdminAffiliateApplication />;
  return <AffiliateDetail />;
};

const AffiliateDetail = () => {
  const { id } = useParams();
  const shopId = useShopId();
  const navigate = useNavigate();

  const [affiliate, setAffiliate] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [orders, setOrders] = useState({ rows: [], nextCursor: null, loading: true });
  const [ledger, setLedger] = useState({ rows: [], nextCursor: null, loading: true });
  const [payouts, setPayouts] = useState({ rows: [], nextCursor: null, loading: true });
  const { isEnabled } = useShopFeatures();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(null);
  const [adjusting, setAdjusting] = useState(false);
  const [adjustment, setAdjustment] = useState({ amount: '', reason: '' });

  const fetchLedger = useCallback(async () => {
    if (!CAPABILITIES.ledger) return setLedger({ rows: [], nextCursor: null, loading: false });
    try {
      const page = await loadAffiliateLedger(shopId, id);
      setLedger({ rows: page.entries, nextCursor: page.nextCursor, loading: false });
    } catch (error) {
      setLedger({ rows: [], nextCursor: null, loading: false, error: error?.message });
    }
  }, [shopId, id]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const detail = await loadAffiliate(shopId, id);
      setAffiliate(detail);
      setForm(detail ? editFormOf(detail) : null);
      if (!detail) return;
      loadAffiliateOrders(shopId, id).then(
        (page) => setOrders({ rows: page.orders, nextCursor: page.nextCursor, loading: false }),
        (error) => setOrders({ rows: [], nextCursor: null, loading: false, error: error?.message }),
      );
      loadAffiliatePayouts(shopId, id).then(
        (page) => setPayouts({ rows: page.payouts, nextCursor: page.nextCursor, loading: false }),
        (error) => setPayouts({ rows: [], nextCursor: null, loading: false, error: error?.message }),
      );
      fetchLedger();
    } catch (error) {
      setLoadError(error?.message || 'Kunde inte hämta affiliaten.');
    } finally {
      setLoading(false);
    }
  }, [shopId, id, fetchLedger]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const refreshDetail = async () => {
    const detail = await loadAffiliate(shopId, id);
    if (detail) {
      setAffiliate(detail);
      setForm(editFormOf(detail));
    }
  };

  const moreOrders = async () => {
    try {
      const page = await loadAffiliateOrders(shopId, id, orders.nextCursor);
      setOrders((prev) => ({ ...prev, rows: [...prev.rows, ...page.orders], nextCursor: page.nextCursor }));
    } catch (error) {
      toast.error(error?.message || 'Kunde inte hämta fler beställningar.');
    }
  };

  const morePayouts = async () => {
    try {
      const page = await loadAffiliatePayouts(shopId, id, payouts.nextCursor);
      setPayouts((prev) => ({ ...prev, rows: [...prev.rows, ...page.payouts], nextCursor: page.nextCursor }));
    } catch (error) {
      toast.error(error?.message || 'Kunde inte hämta fler utbetalningar.');
    }
  };

  const moreLedger = async () => {
    try {
      const page = await loadAffiliateLedger(shopId, id, ledger.nextCursor);
      setLedger((prev) => ({ ...prev, rows: [...prev.rows, ...page.entries], nextCursor: page.nextCursor }));
    } catch (error) {
      toast.error(error?.message || 'Kunde inte hämta fler rader.');
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setBusy('save');
    try {
      const saved = await saveAffiliate(shopId, affiliate, form);
      if (saved) {
        setAffiliate(saved);
        setForm(editFormOf(saved));
      }
      setEditing(false);
      toast.success('Ändringarna är sparade.');
    } catch (error) {
      toast.error(error?.message || 'Kunde inte spara ändringarna.');
    } finally {
      setBusy(null);
    }
  };

  const handleStatus = async (status) => {
    if (status === affiliate.status) return;
    const label = AFFILIATE_STATUS[status].label.toLowerCase();
    const effect = status === 'active'
      ? 'Koden börjar gälla igen för nya köp.'
      : 'Koden ger ingen rabatt eller provision på nya köp. Det som redan är intjänat finns kvar.';
    if (!window.confirm(`Sätt ${affiliate.name} som ${label}? ${effect}`)) return;
    setBusy('status');
    try {
      const updated = await setAffiliateStatus(shopId, affiliate.affiliateId, status);
      if (updated) setAffiliate(updated);
      toast.success(`${affiliate.name} är nu ${label}.`);
    } catch (error) {
      toast.error(error?.message || 'Kunde inte ändra status.');
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async () => {
    if (!window.confirm(
      `Ta bort ${affiliate.name} som affiliate? Koden slutar gälla och inloggningen till affiliateportalen stängs. Reskontra och historik sparas, och affiliaten kan aktiveras igen.`,
    )) return;
    setBusy('remove');
    try {
      const updated = await removeAffiliate(shopId, affiliate.affiliateId);
      if (updated) setAffiliate(updated);
      toast.success(`${affiliate.name} är borttagen som affiliate.`);
    } catch (error) {
      toast.error(error?.message || 'Kunde inte ta bort affiliaten.');
    } finally {
      setBusy(null);
    }
  };

  const handleResend = async () => {
    setBusy('invite');
    try {
      const result = await resendInvite(shopId, affiliate);
      if (result.notice) toast(result.notice, { icon: '⚠️', duration: 15000 });
      else toast.success(`En ny inbjudan har skickats till ${affiliate.email}. Den tidigare länken fungerar inte längre.`);
    } catch (error) {
      toast.error(error?.message || 'Kunde inte skicka inbjudan.');
    } finally {
      setBusy(null);
    }
  };

  const handleAdjustment = async (e) => {
    e.preventDefault();
    setBusy('adjustment');
    try {
      await addAdjustment(shopId, affiliate.affiliateId, adjustment);
      toast.success('Justeringen är tillagd.');
      setAdjusting(false);
      setAdjustment({ amount: '', reason: '' });
      await Promise.all([fetchLedger(), refreshDetail()]);
    } catch (error) {
      toast.error(error?.message || 'Kunde inte lägga till justeringen.');
    } finally {
      setBusy(null);
    }
  };

  const copyLink = async (link) => {
    try {
      await navigator.clipboard.writeText(link);
      toast.success('Länken är kopierad.');
    } catch {
      toast(link, { duration: 10000 });
    }
  };

  // With the program OFF the list is gated away (design §4.5): back leads to the
  // orders, where an affiliate's order links here. Before the affiliate is read,
  // the shop's switch decides.
  const programOn = affiliate ? affiliate.programOn : isEnabled('affiliate');
  const back = programOn ? { to: PATHS.list, label: 'Affiliates' } : { to: '/admin/orders', label: 'Ordrar' };

  if (loading || loadError || !affiliate) {
    return (
      <AppLayout>
        <Page title="Affiliate" back={back}>
          <Card className="px-6 py-12 text-center">
            {loading ? (
              <>
                <div className="inline-block h-7 w-7 animate-spin rounded-full border-2 border-solid border-admin-text-muted border-r-transparent" />
                <p className="mt-3 text-[13px] text-admin-text-muted">Laddar…</p>
              </>
            ) : (
              <>
                <p className="text-[13px] text-admin-text-muted">{loadError || 'Affiliaten hittades inte.'}</p>
                {loadError && (
                  <div className="mt-4"><Button variant="secondary" onClick={fetchAll}>Försök igen</Button></div>
                )}
              </>
            )}
          </Card>
        </Page>
      </AppLayout>
    );
  }

  const status = AFFILIATE_STATUS[affiliate.status] ?? AFFILIATE_STATUS.inactive;
  const currency = affiliate.currency;
  const balance = balanceOf(affiliate.balances, currency);
  const series = clickSeries(affiliate.clicksByDay);
  const set = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }));
  const setSocial = (key) => (e) => setForm((prev) => ({ ...prev, socials: { ...prev.socials, [key]: e.target.value } }));
  const codeChanged = editing && form.code.trim().toUpperCase() !== affiliate.code;
  const membership = affiliate.account?.membership;
  const inviteBlocked = !affiliate.programOn
    ? 'Affiliateprogrammet är avstängt: inga inbjudningar kan skickas.'
    : membership !== 'active'
      ? 'Aktivera affiliaten först.'
      : null;

  const orderColumns = [
    {
      key: 'order',
      header: 'Order',
      render: (o) => (
        <Link to={PATHS.order(o.orderId)} onClick={(e) => e.stopPropagation()} className="font-medium text-admin-text hover:underline">
          #{o.orderNumber}
        </Link>
      ),
    },
    { key: 'paid', header: 'Betald', render: (o) => <span className="whitespace-nowrap text-admin-text-muted">{formatDay(o.paidAt)}</span> },
    { key: 'total', header: 'Belopp', align: 'right', render: (o) => <span className="tabular-nums">{formatMinor(o.totalMinor, o.currency)}</span> },
    { key: 'via', header: 'Via', render: (o) => <span className="text-admin-text-muted">{ATTRIBUTION[o.attribution] ?? '–'}</span> },
    {
      key: 'commission',
      header: 'Affiliate-provision',
      align: 'right',
      render: (o) => <span className="tabular-nums">{o.selfReferral ? '–' : formatMinor(o.affiliateCommissionMinor, o.currency)}</span>,
    },
    {
      key: 'state',
      header: 'Status',
      render: (o) => (o.selfReferral ? (
        <span className="text-[12px] text-admin-text-muted">{SELF_REFERRAL}</span>
      ) : (
        <StatusPill tone={ORDER_STATE[o.state]?.tone || 'neutral'}>{ORDER_STATE[o.state]?.label || o.state}</StatusPill>
      )),
    },
  ];

  const ledgerColumns = [
    { key: 'date', header: 'Datum', render: (e) => <span className="whitespace-nowrap text-admin-text-muted">{formatDay(e.createdAt)}</span> },
    { key: 'kind', header: 'Typ', render: (e) => <span>{LEDGER_KIND[e.kind] ?? e.kind}</span> },
    {
      key: 'about',
      header: 'Avser',
      render: (e) => <span className="text-admin-text-muted">{e.orderNumber ? `Order #${e.orderNumber}` : e.reason || '–'}</span>,
    },
    {
      key: 'amount',
      header: 'Belopp',
      align: 'right',
      render: (e) => <span className="tabular-nums">{formatSignedMinor(e.amountMinor, e.currency)}</span>,
    },
  ];

  const footerMore = (onClick) => (
    <div className="flex justify-center py-2">
      <Button variant="plain" onClick={onClick}>Visa fler</Button>
    </div>
  );

  return (
    <AppLayout>
      <Page
        title={affiliate.name}
        titleAdornment={
          <>
            <span className="rounded-[var(--radius-admin-el)] bg-admin-surface-2 px-2 py-0.5 font-mono text-[12px] text-admin-text">{affiliate.code}</span>
            <StatusPill tone={status.tone}>{status.label}</StatusPill>
          </>
        }
        back={back}
        actions={
          <Button as={Link} to={PATHS.payout(affiliate.affiliateId)} variant="secondary">
            Utbetalning
          </Button>
        }
      >
        {!affiliate.programOn && <ProgramOffBanner />}

        <RightRail
          main={
            <>
              <CardSection title="Statistik" bodyClassName="space-y-4">
                <div>
                  <div className="mb-1 flex items-baseline justify-between text-[12px] text-admin-text-muted">
                    <span>Klick per dag, 30 dagar</span>
                    <span className="tabular-nums">{formatCount(series.reduce((a, b) => a + b, 0))} klick</span>
                  </div>
                  <ClickBars series={series} />
                </div>
                <div className="grid grid-cols-2 gap-4 border-t border-admin-border-soft pt-4 sm:grid-cols-5">
                  <Stat label="Konverteringar" value={formatCount(affiliate.conversions)} />
                  <Stat label="Intjänat" value={formatMinor(balance.earnedMinor, currency)} />
                  <Stat label="Återfört" value={formatMinor(affiliate.reversedMinor, currency)} />
                  <Stat label="Utbetalt" value={formatMinor(balance.paidMinor, currency)} />
                  <Stat label="Saldo" value={formatMinor(balance.balanceMinor, currency)} />
                </div>
              </CardSection>

              <CardSection title="Beställningar" bodyClassName="!p-0">
                {orders.error ? (
                  <p className="px-4 py-4 text-[13px] text-admin-text-muted">{orders.error}</p>
                ) : (
                  <DataTable
                    columns={orderColumns}
                    rows={orders.rows}
                    rowKey={(o) => o.orderId}
                    loading={orders.loading}
                    onRowClick={(o) => navigate(PATHS.order(o.orderId))}
                    empty="Inga beställningar via affiliaten ännu."
                    className="rounded-none border-0"
                    footer={orders.nextCursor ? footerMore(moreOrders) : undefined}
                  />
                )}
              </CardSection>

              {CAPABILITIES.ledger && (
                <CardSection
                  title="Reskontra"
                  actions={CAPABILITIES.adjustments && !adjusting ? (
                    <Button variant="secondary" size="sm" onClick={() => setAdjusting(true)}>Lägg till justering</Button>
                  ) : undefined}
                  bodyClassName="!p-0"
                >
                  {adjusting && (
                    <form onSubmit={handleAdjustment} className="grid grid-cols-1 gap-3 border-b border-admin-border-soft px-4 py-4 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:items-end">
                      <Field label="Belopp (kr)" htmlFor="adjust-amount" help="Minus drar av, t.ex. -50">
                        <Input
                          id="adjust-amount"
                          inputMode="decimal"
                          value={adjustment.amount}
                          onChange={(e) => setAdjustment((a) => ({ ...a, amount: e.target.value }))}
                          placeholder="50,00"
                        />
                      </Field>
                      <Field label="Orsak" htmlFor="adjust-reason" help="Syns i reskontran.">
                        <Input
                          id="adjust-reason"
                          maxLength={500}
                          value={adjustment.reason}
                          onChange={(e) => setAdjustment((a) => ({ ...a, reason: e.target.value }))}
                        />
                      </Field>
                      <div className="flex gap-2 sm:pb-5">
                        <Button type="button" variant="secondary" onClick={() => setAdjusting(false)} disabled={busy === 'adjustment'}>Avbryt</Button>
                        <Button type="submit" variant="primary" disabled={busy === 'adjustment'}>
                          {busy === 'adjustment' ? 'Sparar…' : 'Spara'}
                        </Button>
                      </div>
                    </form>
                  )}
                  {ledger.error ? (
                    <p className="px-4 py-4 text-[13px] text-admin-text-muted">{ledger.error}</p>
                  ) : (
                    <DataTable
                      columns={ledgerColumns}
                      rows={ledger.rows}
                      rowKey={(e) => e.entryId}
                      loading={ledger.loading}
                      empty="Inga rader i reskontran ännu."
                      className="rounded-none border-0"
                      footer={ledger.nextCursor ? footerMore(moreLedger) : undefined}
                    />
                  )}
                </CardSection>
              )}

              <CardSection
                title="Utbetalningar"
                actions={<Button as={Link} to={PATHS.payout(affiliate.affiliateId)} variant="plain" size="sm">Hantera</Button>}
                bodyClassName="!p-0"
              >
                {payouts.loading ? (
                  <p className="px-4 py-4 text-[13px] text-admin-text-muted">Laddar…</p>
                ) : payouts.error ? (
                  <p className="px-4 py-4 text-[13px] text-admin-text-muted">{payouts.error}</p>
                ) : payouts.rows.length === 0 ? (
                  <p className="px-4 py-6 text-center text-[13px] text-admin-text-muted">Inga utbetalningar ännu.</p>
                ) : (
                  <ul className="divide-y divide-admin-border-soft">
                    {payouts.rows.map((p) => (
                      <li key={p.payoutId} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
                        <div className="min-w-0">
                          <div className="font-medium tabular-nums text-admin-text">{formatMinor(p.amountMinor, p.currency)}</div>
                          <div className="text-[12px] text-admin-text-muted">
                            {formatDay(p.paidAt || p.voidedAt || p.requestedAt)}
                            {p.invoiceNumber ? ` · Faktura ${p.invoiceNumber}` : ''}
                          </div>
                        </div>
                        <StatusPill tone={PAYOUT_STATUS[p.status]?.tone || 'neutral'}>{PAYOUT_STATUS[p.status]?.label || p.status}</StatusPill>
                      </li>
                    ))}
                  </ul>
                )}
                {payouts.nextCursor && <div className="border-t border-admin-border-soft">{footerMore(morePayouts)}</div>}
              </CardSection>

              <CardSection
                title="Uppgifter"
                actions={!editing ? <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>Redigera</Button> : undefined}
              >
                {!editing ? (
                  <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2">
                    <div className="space-y-0.5">
                      <Row label="Kod"><span className="font-mono">{affiliate.code}</span></Row>
                      <Row label="Provision">{formatBp(affiliate.commissionBp)}</Row>
                      <Row label="Kundrabatt">{formatBp(affiliate.discountBp)}</Row>
                      <Row label="Kanal">{promotionLabel(affiliate.promotionMethod)}</Row>
                      <Row label="Språk">{languageLabel(affiliate.preferredLang)}</Row>
                      <Row label="Skapad">{formatDay(affiliate.createdAt)}</Row>
                    </div>
                    <div className="space-y-0.5">
                      <Row label="Telefon">{affiliate.phone || '–'}</Row>
                      <Row label="Adress">
                        {[affiliate.address?.line1, affiliate.address?.line2].filter(Boolean).join(', ') || '–'}
                      </Row>
                      <Row label="Postort">
                        {[affiliate.address?.postalCode, affiliate.address?.city].filter(Boolean).join(' ') || '–'}
                      </Row>
                      <Row label="Land">{COUNTRIES.find((c) => c.value === affiliate.address?.country)?.label ?? affiliate.address?.country ?? '–'}</Row>
                      {SOCIALS.filter(({ key }) => affiliate.socials?.[key]).map(({ key, label }) => (
                        <Row key={key} label={label}>{affiliate.socials[key]}</Row>
                      ))}
                    </div>
                  </div>
                ) : (
                  <form onSubmit={handleSave} className="space-y-5">
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                      <Field label="Kod" htmlFor="edit-code" help={codeChanged ? CODE_CHANGE_WARNING : 'A–Z, 0–9 och bindestreck, 3–20 tecken.'}>
                        <Input
                          id="edit-code"
                          value={form.code}
                          onChange={(e) => setForm((prev) => ({ ...prev, code: e.target.value.toUpperCase() }))}
                          className="font-mono"
                        />
                      </Field>
                      <Field label="Provision (%)" htmlFor="edit-commission" help="Gäller nya köp.">
                        <Input id="edit-commission" type="number" min="0" max="100" step="1" value={form.commissionPercent} onChange={set('commissionPercent')} />
                      </Field>
                      <Field label="Kundrabatt (%)" htmlFor="edit-discount" help="Gäller nya köp.">
                        <Input id="edit-discount" type="number" min="0" max="100" step="1" value={form.discountPercent} onChange={set('discountPercent')} />
                      </Field>
                    </div>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <Field label="Namn" htmlFor="edit-name" required>
                        <Input id="edit-name" value={form.name} onChange={set('name')} maxLength={100} />
                      </Field>
                      <Field label="Telefon" htmlFor="edit-phone">
                        <Input id="edit-phone" type="tel" value={form.phone} onChange={set('phone')} maxLength={40} />
                      </Field>
                      <Field label="Adress" htmlFor="edit-line1">
                        <Input id="edit-line1" value={form.addressLine1} onChange={set('addressLine1')} maxLength={200} />
                      </Field>
                      <Field label="Adressrad 2" htmlFor="edit-line2">
                        <Input id="edit-line2" value={form.addressLine2} onChange={set('addressLine2')} maxLength={200} />
                      </Field>
                      <Field label="Postnummer" htmlFor="edit-postal">
                        <Input id="edit-postal" value={form.postalCode} onChange={set('postalCode')} maxLength={20} />
                      </Field>
                      <Field label="Ort" htmlFor="edit-city">
                        <Input id="edit-city" value={form.city} onChange={set('city')} maxLength={100} />
                      </Field>
                      <Field label="Land" htmlFor="edit-country">
                        <Select id="edit-country" value={form.country} onChange={set('country')}>
                          {!COUNTRIES.some((c) => c.value === form.country) && <option value={form.country}>{form.country}</option>}
                          {COUNTRIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                        </Select>
                      </Field>
                      <Field label="Kanal" htmlFor="edit-channel">
                        <Select id="edit-channel" value={form.promotionMethod} onChange={set('promotionMethod')}>
                          <option value="">–</option>
                          {PROMOTION_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                        </Select>
                      </Field>
                      <Field label="Språk" htmlFor="edit-lang">
                        <Select id="edit-lang" value={form.preferredLang} onChange={set('preferredLang')}>
                          {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                        </Select>
                      </Field>
                    </div>
                    <div>
                      <h4 className="mb-2 text-[13px] font-medium text-admin-text">Sociala medier</h4>
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        {SOCIALS.map(({ key, label }) => (
                          <Field key={key} label={label} htmlFor={`edit-social-${key}`}>
                            <Input id={`edit-social-${key}`} value={form.socials[key]} onChange={setSocial(key)} maxLength={300} />
                          </Field>
                        ))}
                      </div>
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => { setForm(editFormOf(affiliate)); setEditing(false); }}
                        disabled={busy === 'save'}
                      >
                        Avbryt
                      </Button>
                      <Button type="submit" variant="primary" disabled={busy === 'save'}>
                        {busy === 'save' ? 'Sparar…' : 'Spara ändringar'}
                      </Button>
                    </div>
                  </form>
                )}
              </CardSection>
            </>
          }
          rail={
            <>
              <CardSection title="Status" bodyClassName="space-y-3">
                <SegmentedTabs
                  ariaLabel="Affiliatens status"
                  options={STATUS_OPTIONS}
                  value={affiliate.status}
                  onChange={busy ? undefined : handleStatus}
                  className="w-full [&>button]:flex-1 [&>button]:justify-center"
                />
                <p className="text-[12px] text-admin-text-muted">
                  Inaktiv eller avstängd: koden ger ingen rabatt eller provision på nya köp. Det som redan är intjänat finns kvar.
                </p>
                {CAPABILITIES.revoke && membership !== 'revoked' && (
                  <Button variant="plain" size="sm" onClick={handleRemove} disabled={busy !== null} className="-ml-2">
                    Ta bort som affiliate
                  </Button>
                )}
              </CardSection>

              <CardSection title="Konto" bodyClassName="space-y-3 text-[13px]">
                <div>
                  <div className="text-[12px] text-admin-text-muted">Inloggning</div>
                  <div className="break-words text-admin-text">{affiliate.email || '–'}</div>
                </div>
                {CAPABILITIES.invites && (
                  affiliate.account?.invited ? (
                    <div className="space-y-2">
                      <StatusPill tone="warning">Inbjudan skickad, lösenord ej satt</StatusPill>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleResend}
                        disabled={busy !== null || inviteBlocked !== null}
                        title={inviteBlocked ?? undefined}
                        className="w-full"
                      >
                        {busy === 'invite' ? 'Skickar…' : 'Skicka inbjudan igen'}
                      </Button>
                      {inviteBlocked && <p className="text-[12px] text-admin-text-muted">{inviteBlocked}</p>}
                    </div>
                  ) : (
                    <StatusPill tone="success">Lösenord satt</StatusPill>
                  )
                )}
                {membership && !(membership === 'active' && affiliate.account?.invited) && (
                  <p className="text-admin-text-muted">{MEMBERSHIP_TEXT[membership] ?? membership}</p>
                )}
                {CAPABILITIES.invites && (
                  <Row label="Villkor">
                    {affiliate.terms?.acceptedVersion
                      ? `Godkända (version ${affiliate.terms.acceptedVersion}${affiliate.terms.outdated ? ', ny version finns' : ''})`
                      : 'Inte godkända ännu'}
                  </Row>
                )}
              </CardSection>

              {affiliate.links?.refLink && (
                <CardSection title="Affiliatelänk" bodyClassName="space-y-2">
                  <p className="break-all font-mono text-[12px] text-admin-text">{affiliate.links.refLink}</p>
                  <Button variant="secondary" size="sm" onClick={() => copyLink(affiliate.links.refLink)}>Kopiera länk</Button>
                </CardSection>
              )}
            </>
          }
        />
      </Page>
    </AppLayout>
  );
};

export default AdminAffiliateEdit;
