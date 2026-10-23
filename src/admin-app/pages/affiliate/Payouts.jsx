// Affiliateportalen — Utbetalningar (/affiliate/payouts; CP13 design §6.1,
// §7.3). The request: Belopp (prefilled with what is payable), Fakturanummer,
// Faktura-PDF (reserved and uploaded first: POST /v1/affiliate/objects + PUT
// …/content, then named in POST /v1/affiliate/payouts). While the server's
// `payoutBlockers` name a reason, the form is disabled and says why. The
// history: every request with its state (Begärd / Betald / Avvisad) and the
// invoice to download. The server decides everything (the payable amount,
// one open request at a time, the profile, the terms); the page only asks.

import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Button, Card, CardSection, Field, Input, Page, StatusPill } from '../../../components/admin/ui';
import {
  getPayoutInvoice,
  invoiceFileProblem,
  listPortalPayouts,
  requestPortalPayout,
  uploadPortalInvoice,
} from '../../../api/affiliate-portal.js';
import {
  formatDate,
  formatMinor,
  kronorToMinor,
  minorToKronorText,
  payoutBlockReasons,
  payoutRefusalText,
  payoutStatusOf,
} from '../../adapters/affiliatePortal.js';
import { usePortal } from './portalContext.js';

const FILE_TEXT = {
  not_pdf: 'Fakturan måste vara en PDF.',
  too_large: 'Fakturan får vara högst 10 MB.',
  empty: 'Filen är tom.',
};

function RequestForm({ affiliate, onDone }) {
  const balance = affiliate.balance ?? {};
  const currency = balance.currency || affiliate.currency;
  const payable = balance.payableMinor ?? 0;
  const reasons = payoutBlockReasons(affiliate);
  const blocked = reasons.length > 0;

  const [amount, setAmount] = useState(minorToKronorText(payable));
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState(null);
  // The invoice already uploaded for this file: a retry after a refusal names
  // it again instead of uploading a second copy.
  const [uploaded, setUploaded] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const amountMinor = kronorToMinor(amount);
  const amountError =
    amount.trim() === ''
      ? null
      : amountMinor === null
        ? 'Ange ett belopp i kronor, till exempel 250 eller 250,50.'
        : amountMinor > payable
          ? `Högst ${formatMinor(payable, currency)}.`
          : null;
  const canSend = !blocked && !busy && amountMinor !== null && amountMinor <= payable && !fileError;

  const pickFile = (e) => {
    const next = e.target.files?.[0] ?? null;
    const problem = next ? invoiceFileProblem(next) : null;
    setFile(problem ? null : next);
    setFileError(problem ? FILE_TEXT[problem] : null);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      let invoiceObjectId;
      if (file) {
        invoiceObjectId = uploaded?.file === file ? uploaded.objectId : await uploadPortalInvoice(file);
        setUploaded({ file, objectId: invoiceObjectId });
      }
      await requestPortalPayout({ amountMinor, invoiceNumber, invoiceObjectId });
      toast.success('Begäran skickad. Butiken får ett meddelande.');
      setInvoiceNumber('');
      setFile(null);
      await onDone();
    } catch (err) {
      if (err?.code !== 'unauthenticated') setError(payoutRefusalText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CardSection title="Begär utbetalning">
      {blocked ? (
        <div className="mb-4 rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface-2 px-3 py-2.5">
          <p className="font-medium">Du kan inte begära utbetalning just nu.</p>
          <ul className="mt-1 list-disc pl-5 text-admin-text-muted">
            {reasons.map((r) => (
              <li key={r.key}>
                {r.key === 'profile_incomplete' ? (
                  <>
                    {r.text}{' '}
                    <Link to="/profile" className="underline underline-offset-2 hover:text-admin-text">
                      Till profilen
                    </Link>
                  </>
                ) : r.key === 'terms_required' ? (
                  <>
                    {r.text}{' '}
                    <Link to="/terms" className="underline underline-offset-2 hover:text-admin-text">
                      Till villkoren
                    </Link>
                  </>
                ) : (
                  r.text
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mb-4 text-admin-text-muted">
          Att betala nu: <span className="font-medium text-admin-text">{formatMinor(payable, currency)}</span>. Bifoga faktura
          eller annat underlag. Butiken betalar ut och markerar begäran som betald.
        </p>
      )}
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field label="Belopp (kr)" htmlFor="po-amount" required error={amountError}>
          <Input
            id="po-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={blocked || busy}
            className="tabular-nums"
          />
        </Field>
        <Field label="Fakturanummer" htmlFor="po-number" help="Valfritt, högst 50 tecken.">
          <Input
            id="po-number"
            value={invoiceNumber}
            maxLength={50}
            onChange={(e) => setInvoiceNumber(e.target.value)}
            disabled={blocked || busy}
          />
        </Field>
        <Field
          label="Faktura-PDF"
          htmlFor="po-file"
          className="sm:col-span-2"
          help={file ? `Vald fil: ${file.name}` : 'Valfritt. PDF, högst 10 MB.'}
          error={fileError}
        >
          <input
            id="po-file"
            type="file"
            accept="application/pdf,.pdf"
            onChange={pickFile}
            disabled={blocked || busy}
            className="block w-full text-[13px] text-admin-text-muted file:mr-3 file:rounded-[var(--radius-admin-el)] file:border file:border-admin-border file:bg-admin-surface file:px-3 file:py-1.5 file:text-[13px] file:font-medium file:text-admin-text hover:file:bg-admin-surface-2 disabled:opacity-60"
          />
        </Field>
        {error && (
          <p className="sm:col-span-2 text-admin-critical-text" role="alert">
            {error}
          </p>
        )}
        <div className="sm:col-span-2">
          <Button type="submit" variant="primary" disabled={!canSend}>
            {busy ? 'Skickar…' : 'Begär utbetalning'}
          </Button>
        </div>
      </form>
    </CardSection>
  );
}

function History({ payouts, cursor, onMore, loadingMore }) {
  const download = async (payout) => {
    try {
      const blob = await getPayoutInvoice(payout.payoutId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `faktura-${payout.invoiceNumber || payout.payoutId}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      if (err?.code !== 'unauthenticated') toast.error('Fakturan kunde inte hämtas.');
    }
  };

  return (
    <CardSection title="Historik" bodyClassName="p-0">
      {payouts === null ? (
        <p className="px-4 py-4 text-admin-text-muted">Laddar…</p>
      ) : payouts.length === 0 ? (
        <p className="px-4 py-4 text-admin-text-muted">Inga utbetalningar ännu.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="border-b border-admin-border text-[12px] text-admin-text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Begärd</th>
                <th className="px-4 py-2 text-right font-medium">Belopp</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Faktura</th>
                <th className="px-4 py-2 font-medium">Detaljer</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              {payouts.map((p) => {
                const [label, tone] = payoutStatusOf(p.status);
                return (
                  <tr key={p.payoutId} className="align-top">
                    <td className="whitespace-nowrap px-4 py-2.5 text-admin-text-muted">{formatDate(p.requestedAt)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right font-medium tabular-nums">{formatMinor(p.amountMinor, p.currency)}</td>
                    <td className="px-4 py-2.5">
                      <StatusPill tone={tone}>{label}</StatusPill>
                    </td>
                    <td className="px-4 py-2.5">
                      {p.hasInvoice ? (
                        <button type="button" onClick={() => download(p)} className="underline underline-offset-2 hover:text-admin-text-muted">
                          {p.invoiceNumber || 'PDF'}
                        </button>
                      ) : (
                        <span className="text-admin-text-muted">{p.invoiceNumber || '–'}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-admin-text-muted">
                      {p.status === 'paid' && (
                        <>
                          Betald {formatDate(p.paidAt)}
                          {p.reference ? ` · Ref. ${p.reference}` : ''}
                        </>
                      )}
                      {p.status === 'void' && <>Avvisad {formatDate(p.voidedAt)}{p.voidReason ? `: ${p.voidReason}` : ''}</>}
                      {p.status === 'requested' && 'Väntar på butiken'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {cursor && (
        <div className="border-t border-admin-border px-4 py-3 text-center">
          <Button onClick={onMore} disabled={loadingMore}>
            {loadingMore ? 'Hämtar…' : 'Visa fler'}
          </Button>
        </div>
      )}
    </CardSection>
  );
}

export default function AffiliatePayouts() {
  const { affiliate, reload } = usePortal();
  const [payouts, setPayouts] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (after) => {
    try {
      const page = await listPortalPayouts({ cursor: after ?? undefined, limit: 50 });
      setPayouts((prev) => (after ? [...(prev ?? []), ...page.payouts] : page.payouts));
      setCursor(page.nextCursor);
    } catch (err) {
      if (err?.code !== 'unauthenticated') toast.error('Utbetalningarna kunde inte hämtas.');
      setPayouts((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    load(null);
  }, [load]);

  const afterRequest = async () => {
    await Promise.all([reload(), load(null)]);
  };

  const more = async () => {
    setLoadingMore(true);
    await load(cursor);
    setLoadingMore(false);
  };

  const balance = affiliate.balance ?? {};
  const currency = balance.currency || affiliate.currency;

  return (
    <Page title="Utbetalningar" subtitle="Begär utbetalning av det som är klart att betala, och se tidigare utbetalningar.">
      <div className="space-y-4">
        <Card padded className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            ['Att betala', balance.payableMinor],
            ['Under ångerfrist', balance.heldMinor],
            ['Begärt', balance.requestedMinor],
            ['Utbetalt', balance.paidMinor],
          ].map(([label, value]) => (
            <div key={label}>
              <div className="text-[12px] font-medium text-admin-text-muted">{label}</div>
              <div className="mt-0.5 text-[16px] font-semibold tabular-nums">{formatMinor(value, currency)}</div>
            </div>
          ))}
        </Card>
        <RequestForm key={balance.payableMinor} affiliate={affiliate} onDone={afterRequest} />
        <History payouts={payouts} cursor={cursor} onMore={more} loadingMore={loadingMore} />
      </div>
    </Page>
  );
}
