// Affiliateportalen — Översikt (/affiliate; CP13 design §7.3). The code and
// the link (copy + QR), the rates, the balances, the link landings of the
// last 30 days, the last ten orders and "Begär utbetalning" (disabled with
// its reasons). Every figure is the server's (GET /v1/affiliate/me,
// GET /v1/affiliate/orders?limit=10).

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import QRCode from 'qrcode';
import { Button, Card, CardSection, KpiStrip, Page, StatusPill } from '../../../components/admin/ui';
import { listPortalOrders } from '../../../api/affiliate-portal.js';
import {
  clickSeries,
  formatDate,
  formatMinor,
  orderStateOf,
  payoutBlockReasons,
  ratesLine,
} from '../../adapters/affiliatePortal.js';
import { usePortal } from './portalContext.js';

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} kopierad`);
  } catch {
    toast.error('Kunde inte kopiera. Markera och kopiera själv.');
  }
}

function CopyRow({ label, value, what, mono = false }) {
  return (
    <div>
      <div className="text-[13px] font-medium text-admin-text-muted">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        <code
          className={`min-w-0 flex-1 truncate rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface-2 px-3 py-1.5 text-admin-text ${
            mono ? 'font-mono text-[15px] font-semibold tracking-wide' : 'text-[13px]'
          }`}
          title={value}
        >
          {value}
        </code>
        <Button onClick={() => copy(value, what)}>Kopiera</Button>
      </div>
    </div>
  );
}

function ClickBars({ clicksByDay }) {
  const series = clickSeries(clicksByDay);
  const total = series.reduce((sum, d) => sum + d.count, 0);
  const max = Math.max(1, ...series.map((d) => d.count));
  return (
    <CardSection title="Länkbesök (30 dagar)" actions={<span className="text-admin-text-muted tabular-nums">{total} totalt</span>}>
      {total === 0 ? (
        <p className="text-admin-text-muted">Inga besök via din länk ännu. Besöken räknas per dag, utan uppgifter om besökarna.</p>
      ) : (
        <>
          <div className="flex h-24 items-end gap-[3px]" role="img" aria-label={`${total} länkbesök de senaste 30 dagarna`}>
            {series.map((d) => (
              <div
                key={d.day}
                title={`${d.day}: ${d.count}`}
                className="flex-1 rounded-t-[2px] bg-admin-text/70"
                style={{ height: `${Math.max(d.count > 0 ? 6 : 2, (d.count / max) * 100)}%`, opacity: d.count > 0 ? 1 : 0.15 }}
              />
            ))}
          </div>
          <p className="mt-2 text-[12px] text-admin-text-muted">Besök via din länk per dag. Inte unika besökare.</p>
        </>
      )}
    </CardSection>
  );
}

export default function AffiliateOverview() {
  const { affiliate } = usePortal();
  const [orders, setOrders] = useState(null);
  const [qr, setQr] = useState(null);
  const link = affiliate.links?.refLink ?? null;

  useEffect(() => {
    let cancelled = false;
    listPortalOrders({ limit: 10 })
      .then(({ orders: list }) => !cancelled && setOrders(list))
      .catch(() => !cancelled && setOrders([]));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!link) return undefined;
    let cancelled = false;
    QRCode.toDataURL(link, { margin: 1, width: 240 })
      .then((url) => !cancelled && setQr(url))
      .catch(() => !cancelled && setQr(null));
    return () => {
      cancelled = true;
    };
  }, [link]);

  const balance = affiliate.balance ?? {};
  const currency = balance.currency || affiliate.currency;
  const reasons = payoutBlockReasons(affiliate);

  return (
    <Page
      title={`Hej ${affiliate.name}`}
      subtitle={`Affiliate hos ${affiliate.shop?.name ?? 'butiken'}`}
      actions={
        reasons.length === 0 ? (
          <Button as={Link} to="/payouts" variant="primary">
            Begär utbetalning
          </Button>
        ) : (
          <Button variant="primary" disabled title={reasons.map((r) => r.text).join(' ')}>
            Begär utbetalning
          </Button>
        )
      }
    >
      <div className="space-y-4">
        {reasons.length > 0 && (
          <p className="text-[12px] text-admin-text-muted sm:text-right">{reasons.map((r) => r.text).join(' ')}</p>
        )}

        <KpiStrip
          metrics={[
            { key: 'payable', label: 'Att betala', value: formatMinor(balance.payableMinor, currency) },
            { key: 'held', label: 'Under ångerfrist (14 dagar)', value: formatMinor(balance.heldMinor, currency) },
            { key: 'paid', label: 'Utbetalt', value: formatMinor(balance.paidMinor, currency) },
            { key: 'earned', label: 'Intjänat totalt', value: formatMinor(balance.earnedMinor, currency) },
          ]}
        />

        <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
          <Card padded className="min-w-0 space-y-4">
            <CopyRow label="Din kod" value={affiliate.code} what="Koden" mono />
            {link ? (
              <CopyRow label="Din länk" value={link} what="Länken" />
            ) : (
              <p className="text-admin-text-muted">Länken visas när butikens adress är klar.</p>
            )}
            <div>
              <div className="text-[13px] font-medium text-admin-text-muted">Dina villkor</div>
              <p className="mt-1">{ratesLine(affiliate)}</p>
            </div>
          </Card>
          {qr && (
            <Card padded className="flex flex-col items-center justify-center gap-2">
              <img src={qr} alt="QR-kod till din länk" className="h-36 w-36" />
              <a href={qr} download={`${affiliate.code}-qr.png`} className="text-[12px] text-admin-text-muted underline underline-offset-2 hover:text-admin-text">
                Ladda ner QR-kod
              </a>
            </Card>
          )}
        </div>

        <ClickBars clicksByDay={affiliate.clicksByDay} />

        <CardSection
          title="Senaste beställningar"
          actions={
            <Link to="/orders" className="text-admin-text-muted underline underline-offset-2 hover:text-admin-text">
              Visa alla
            </Link>
          }
          bodyClassName="p-0"
        >
          <OrderRows orders={orders} empty="Inga beställningar via din kod eller länk ännu." />
        </CardSection>
      </div>
    </Page>
  );
}

/** The orders table shared with the orders page. */
export function OrderRows({ orders, empty }) {
  if (orders === null) return <p className="px-4 py-4 text-admin-text-muted">Laddar…</p>;
  if (orders.length === 0) return <p className="px-4 py-4 text-admin-text-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead className="border-b border-admin-border text-[12px] text-admin-text-muted">
          <tr>
            <th className="px-4 py-2 font-medium">Order</th>
            <th className="px-4 py-2 font-medium">Datum</th>
            <th className="px-4 py-2 text-right font-medium">Underlag</th>
            <th className="px-4 py-2 text-right font-medium">Provision</th>
            <th className="px-4 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-admin-border">
          {orders.map((o) => {
            const [label, tone] = orderStateOf(o.state);
            return (
              <tr key={`${o.orderNumber}-${o.paidAt}`}>
                <td className="whitespace-nowrap px-4 py-2.5 font-medium">{o.orderNumber}</td>
                <td className="whitespace-nowrap px-4 py-2.5 text-admin-text-muted">{formatDate(o.paidAt)}</td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">{formatMinor(o.baseMinor, o.currency)}</td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right font-medium tabular-nums">{formatMinor(o.commissionMinor, o.currency)}</td>
                <td className="px-4 py-2.5">
                  <StatusPill tone={tone}>{label}</StatusPill>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
