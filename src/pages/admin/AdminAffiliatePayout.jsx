// One affiliate's payouts (CP13 A2, design §6.2 / §7.2): the manual rail.
// Money moves outside the system (bank or Swish); this page records it. An
// open request from the affiliate is marked paid (with the shop's reference)
// or rejected (with a reason, mailed to them; the amount is released); a
// payout the shop made on its own is recorded as requested and paid at once.
// NOT behind the add-on gate (design §4.5): liabilities are settled with the
// program OFF too. Every amount shown is the server's.
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import AppLayout from '../../components/layout/AppLayout';
import { useShopId } from '../../contexts/ShopContext';
import { useShopFeatures } from '../../contexts/ShopFeaturesContext';
import {
  CAPABILITIES,
  PATHS,
  downloadInvoice,
  loadAffiliate,
  loadAffiliatePayouts,
  markPayoutPaid,
  recordPayout,
  voidPayout,
} from './adminAffiliateData';
import { PAYOUT_STATUS, balanceOf, formatBp, formatDay, formatMinor, kronorText } from './affiliateView';
import { ProgramOffBanner } from './AdminAffiliateEdit';
import { Page, Card, CardSection, RightRail, Button, StatusPill, Field, Input, Textarea } from '../../components/admin/ui';
import { DocumentArrowDownIcon } from '@heroicons/react/24/outline';

const SummaryRow = ({ label, value, strong }) => (
  <div className="flex items-baseline justify-between gap-4 py-1 text-[13px]">
    <span className="text-admin-text-muted">{label}</span>
    <span className={`tabular-nums ${strong ? 'font-semibold text-admin-text' : 'text-admin-text'}`}>{value}</span>
  </div>
);

const AdminAffiliatePayout = () => {
  // The admin build: /admin/affiliates/:id/payout; the older build: /admin/affiliates/payout/:affiliateId.
  const params = useParams();
  const affiliateId = params.id ?? params.affiliateId;
  const shopId = useShopId();

  const [affiliate, setAffiliate] = useState(null);
  const [payouts, setPayouts] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const { isEnabled } = useShopFeatures();
  const [balances, setBalances] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [action, setAction] = useState(null); // 'paid' | 'void' for the open request
  const [evidence, setEvidence] = useState({ reference: '', notes: '' });
  const [voidReason, setVoidReason] = useState('');
  const [form, setForm] = useState({ amount: '', invoiceNumber: '', invoiceFile: null, reference: '', notes: '' });

  const fetchData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const detail = await loadAffiliate(shopId, affiliateId);
      setAffiliate(detail);
      if (!detail) return;
      const page = await loadAffiliatePayouts(shopId, affiliateId);
      setPayouts(page.payouts);
      setNextCursor(page.nextCursor);
      setBalances(page.balances);
      const payable = balanceOf(page.balances, detail.currency).payableMinor;
      setForm((prev) => ({ ...prev, amount: payable > 0 ? kronorText(payable) : '' }));
    } catch (error) {
      setLoadError(error?.message || 'Kunde inte hämta affiliaten.');
    } finally {
      setLoading(false);
    }
  }, [shopId, affiliateId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Before the affiliate is read (or when it is not found), back leads to the
  // list, or to the orders while the gated list is away (design §4.5).
  const back = affiliate
    ? { to: PATHS.detail(affiliateId), label: affiliate.name }
    : isEnabled('affiliate')
      ? { to: PATHS.list, label: 'Affiliates' }
      : { to: '/admin/orders', label: 'Ordrar' };

  const morePayouts = async () => {
    try {
      const page = await loadAffiliatePayouts(shopId, affiliateId, nextCursor);
      setPayouts((prev) => [...prev, ...page.payouts]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      toast.error(error?.message || 'Kunde inte hämta fler utbetalningar.');
    }
  };

  if (loading || loadError || !affiliate) {
    return (
      <AppLayout>
        <Page title="Utbetalning" back={back}>
          <Card className="px-6 py-12 text-center">
            {loading ? (
              <>
                <div className="inline-block h-7 w-7 animate-spin rounded-full border-2 border-solid border-admin-text-muted border-r-transparent" />
                <p className="mt-3 text-[13px] text-admin-text-muted">Laddar affiliate-data…</p>
              </>
            ) : (
              <>
                <h2 className="text-base font-semibold text-admin-text">{loadError || 'Affiliate hittades inte'}</h2>
                <div className="mt-4">
                  <Button as={Link} to={back.to} variant="secondary">Tillbaka</Button>
                </div>
              </>
            )}
          </Card>
        </Page>
      </AppLayout>
    );
  }

  const currency = affiliate.currency;
  const balance = balanceOf(balances, currency);
  const open = payouts.find((p) => p.status === 'requested') ?? null;
  const history = payouts.filter((p) => p !== open);

  const handlePaid = async (e) => {
    e.preventDefault();
    setBusy('paid');
    try {
      await markPayoutPaid(shopId, open.payoutId, evidence);
      toast.success(`Utbetalningen på ${formatMinor(open.amountMinor, open.currency)} är markerad som betald.`);
      setAction(null);
      setEvidence({ reference: '', notes: '' });
      await fetchData();
    } catch (error) {
      toast.error(error?.message || 'Kunde inte markera utbetalningen som betald.');
    } finally {
      setBusy(null);
    }
  };

  const handleVoid = async (e) => {
    e.preventDefault();
    if (!window.confirm('Avvisa begäran? Beloppet blir tillgängligt för affiliaten igen och orsaken mejlas till dem.')) return;
    setBusy('void');
    try {
      await voidPayout(shopId, open.payoutId, voidReason);
      toast.success('Begäran är avvisad.');
      setAction(null);
      setVoidReason('');
      await fetchData();
    } catch (error) {
      toast.error(error?.message || 'Kunde inte avvisa begäran.');
    } finally {
      setBusy(null);
    }
  };

  const handleRecord = async (e) => {
    e.preventDefault();
    if (!window.confirm('Registrera utbetalningen? Gör det först när pengarna har skickats. Den kan inte ångras.')) return;
    setBusy('record');
    try {
      await recordPayout(shopId, affiliateId, form, balance.payableMinor);
      toast.success('Utbetalningen är registrerad.');
      setForm({ amount: '', invoiceNumber: '', invoiceFile: null, reference: '', notes: '' });
      await fetchData();
    } catch (error) {
      toast.error(error?.message || 'Kunde inte registrera utbetalningen.');
    } finally {
      setBusy(null);
    }
  };

  const handleDownload = async (payout) => {
    try {
      await downloadInvoice(shopId, payout);
    } catch (error) {
      toast.error(error?.message || 'Kunde inte hämta fakturan.');
    }
  };

  const set = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }));
  const recordBlocked = open
    ? 'Det finns en öppen begäran. Markera den som betald eller avvisa den först.'
    : balance.payableMinor <= 0
      ? 'Det finns inget att betala ut just nu.'
      : null;

  return (
    <AppLayout>
      <Page title="Utbetalning" subtitle={`${affiliate.name} · ${affiliate.code}`} back={back}>
        {!affiliate.programOn && <ProgramOffBanner />}

        <RightRail
          main={
            <>
              {open && (
                <CardSection
                  title="Begäran om utbetalning"
                  actions={<StatusPill tone={PAYOUT_STATUS.requested.tone}>{PAYOUT_STATUS.requested.label}</StatusPill>}
                  bodyClassName="space-y-4"
                >
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <div className="text-[22px] font-semibold leading-7 tabular-nums text-admin-text">{formatMinor(open.amountMinor, open.currency)}</div>
                      <div className="mt-0.5 text-[12px] text-admin-text-muted">
                        Begärd {formatDay(open.requestedAt)}{open.invoiceNumber ? ` · Faktura ${open.invoiceNumber}` : ''}
                      </div>
                    </div>
                    {open.invoiceObjectId && (
                      <Button variant="secondary" onClick={() => handleDownload(open)}>
                        <DocumentArrowDownIcon className="h-4 w-4" />
                        Faktura (PDF)
                      </Button>
                    )}
                  </div>

                  {action === null && (
                    <div className="flex flex-wrap gap-2">
                      <Button variant="primary" onClick={() => setAction('paid')}>Markera som betald</Button>
                      <Button variant="secondary" onClick={() => setAction('void')}>Avvisa</Button>
                    </div>
                  )}

                  {action === 'paid' && (
                    <form onSubmit={handlePaid} className="space-y-3 border-t border-admin-border-soft pt-4">
                      <p className="text-[13px] text-admin-text-muted">Markera först när pengarna har skickats. Affiliaten får ett mejl.</p>
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <Field label="Referens" htmlFor="paid-reference" help="T.ex. bankens eller Swish referens.">
                          <Input id="paid-reference" maxLength={100} value={evidence.reference} onChange={(e) => setEvidence((v) => ({ ...v, reference: e.target.value }))} />
                        </Field>
                        <Field label="Anteckning" htmlFor="paid-notes">
                          <Input id="paid-notes" maxLength={1000} value={evidence.notes} onChange={(e) => setEvidence((v) => ({ ...v, notes: e.target.value }))} />
                        </Field>
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button type="button" variant="secondary" onClick={() => setAction(null)} disabled={busy !== null}>Avbryt</Button>
                        <Button type="submit" variant="primary" disabled={busy !== null}>
                          {busy === 'paid' ? 'Sparar…' : 'Markera som betald'}
                        </Button>
                      </div>
                    </form>
                  )}

                  {action === 'void' && (
                    <form onSubmit={handleVoid} className="space-y-3 border-t border-admin-border-soft pt-4">
                      <Field label="Orsak" htmlFor="void-reason" required help="Mejlas till affiliaten. Beloppet blir tillgängligt igen.">
                        <Textarea id="void-reason" rows={3} maxLength={500} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
                      </Field>
                      <div className="flex justify-end gap-2">
                        <Button type="button" variant="secondary" onClick={() => setAction(null)} disabled={busy !== null}>Avbryt</Button>
                        <Button type="submit" variant="destructive" disabled={busy !== null || voidReason.trim() === ''}>
                          {busy === 'void' ? 'Avvisar…' : 'Avvisa'}
                        </Button>
                      </div>
                    </form>
                  )}
                </CardSection>
              )}

              <CardSection title="Registrera utbetalning">
                {recordBlocked ? (
                  <p className="text-[13px] text-admin-text-muted">{recordBlocked}</p>
                ) : (
                <form onSubmit={handleRecord} className="space-y-5">
                  <fieldset disabled={busy !== null} className="space-y-5">
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <Field label="Belopp (kr)" htmlFor="record-amount" required help={`Högst ${formatMinor(balance.payableMinor, currency)}.`}>
                        <Input id="record-amount" inputMode="decimal" value={form.amount} onChange={set('amount')} placeholder="0,00" />
                      </Field>
                      <Field label={CAPABILITIES.payoutRequests ? 'Fakturanummer (valfritt)' : 'Fakturanummer'} htmlFor="record-invoice-number">
                        <Input id="record-invoice-number" maxLength={50} value={form.invoiceNumber} onChange={set('invoiceNumber')} placeholder="t.ex. 2026-014" />
                      </Field>
                      <Field
                        label={CAPABILITIES.payoutRequests ? 'Faktura-PDF (valfritt)' : 'Faktura-PDF'}
                        htmlFor="record-invoice-file"
                        help={form.invoiceFile ? `${form.invoiceFile.name} · ${(form.invoiceFile.size / 1024 / 1024).toFixed(2)} MB` : 'Endast PDF, högst 10 MB.'}
                      >
                        <input
                          id="record-invoice-file"
                          type="file"
                          accept="application/pdf,.pdf"
                          onChange={(e) => setForm((prev) => ({ ...prev, invoiceFile: e.target.files?.[0] ?? null }))}
                          className="block w-full text-[13px] text-admin-text-muted file:mr-3 file:rounded-[var(--radius-admin-el)] file:border file:border-admin-border file:bg-admin-surface file:px-3 file:py-1 file:text-[13px] file:font-medium file:text-admin-text hover:file:bg-admin-surface-2"
                        />
                      </Field>
                      {CAPABILITIES.payoutRequests && (
                        <Field label="Referens (valfritt)" htmlFor="record-reference" help="T.ex. bankens eller Swish referens.">
                          <Input id="record-reference" maxLength={100} value={form.reference} onChange={set('reference')} />
                        </Field>
                      )}
                    </div>
                    <Field label="Anteckning (valfritt)" htmlFor="record-notes">
                      <Textarea id="record-notes" rows={2} maxLength={1000} value={form.notes} onChange={set('notes')} />
                    </Field>
                    <p className="text-[12px] text-admin-text-muted">
                      Registrera utbetalningen först när pengarna har skickats. Den kan inte ångras; ett fel rättas med en justering i reskontran.
                    </p>
                    <div className="flex justify-end">
                      <Button type="submit" variant="primary">
                        {busy === 'record' ? 'Registrerar…' : 'Registrera utbetalning'}
                      </Button>
                    </div>
                  </fieldset>
                </form>
                )}
              </CardSection>

              <CardSection title="Historik" bodyClassName="!p-0">
                {history.length === 0 ? (
                  <p className="px-4 py-6 text-center text-[13px] text-admin-text-muted">Inga utbetalningar ännu.</p>
                ) : (
                  <ul className="divide-y divide-admin-border-soft">
                    {history.map((p) => (
                      <li key={p.payoutId} className="flex items-start justify-between gap-3 px-4 py-3 text-[13px]">
                        <div className="min-w-0 space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span className="font-medium tabular-nums text-admin-text">{formatMinor(p.amountMinor, p.currency)}</span>
                            <StatusPill tone={PAYOUT_STATUS[p.status]?.tone || 'neutral'}>{PAYOUT_STATUS[p.status]?.label || p.status}</StatusPill>
                          </div>
                          <div className="text-[12px] text-admin-text-muted">
                            Begärd {formatDay(p.requestedAt)}
                            {p.paidAt ? ` · Betald ${formatDay(p.paidAt)}` : ''}
                            {p.voidedAt ? ` · Avvisad ${formatDay(p.voidedAt)}` : ''}
                            {p.invoiceNumber ? ` · Faktura ${p.invoiceNumber}` : ''}
                            {p.reference ? ` · Ref. ${p.reference}` : ''}
                          </div>
                          {p.voidReason && <p className="text-[12px] text-admin-text-muted">Orsak: {p.voidReason}</p>}
                          {p.notes && <p className="text-[12px] italic text-admin-text-muted">"{p.notes}"</p>}
                        </div>
                        {p.invoiceObjectId && (
                          <Button variant="plain" size="sm" onClick={() => handleDownload(p)} aria-label={`Ladda ner fakturan ${p.invoiceNumber || ''}`.trim()}>
                            <DocumentArrowDownIcon className="h-4 w-4" />
                            Faktura
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {nextCursor && (
                  <div className="flex justify-center border-t border-admin-border-soft py-2">
                    <Button variant="plain" onClick={morePayouts}>Visa fler</Button>
                  </div>
                )}
              </CardSection>
            </>
          }
          rail={
            <>
              <CardSection title="Affiliate" bodyClassName="space-y-3 text-[13px]">
                <div>
                  <div className="text-[12px] text-admin-text-muted">Namn</div>
                  <div className="font-medium text-admin-text">{affiliate.name}</div>
                </div>
                <div>
                  <div className="text-[12px] text-admin-text-muted">Kod</div>
                  <div className="font-mono text-admin-text">{affiliate.code}</div>
                </div>
                <div>
                  <div className="text-[12px] text-admin-text-muted">E-post</div>
                  <div className="break-words text-admin-text">{affiliate.email}</div>
                </div>
                <div>
                  <div className="text-[12px] text-admin-text-muted">Provision</div>
                  <div className="text-admin-text">{formatBp(affiliate.commissionBp)}</div>
                </div>
              </CardSection>

              <CardSection title="Saldo" bodyClassName="space-y-0.5">
                <SummaryRow label="Att betala" value={formatMinor(balance.payableMinor, currency)} strong />
                <SummaryRow label="Under ångerfrist" value={formatMinor(balance.heldMinor, currency)} />
                <SummaryRow label="Begärt" value={formatMinor(balance.requestedMinor, currency)} />
                <SummaryRow label="Utbetalt" value={formatMinor(balance.paidMinor, currency)} />
                <div className="mt-1 border-t border-admin-border-soft pt-1">
                  <SummaryRow label="Intjänat totalt" value={formatMinor(balance.earnedMinor, currency)} />
                </div>
              </CardSection>
            </>
          }
        />
      </Page>
    </AppLayout>
  );
};

export default AdminAffiliatePayout;
