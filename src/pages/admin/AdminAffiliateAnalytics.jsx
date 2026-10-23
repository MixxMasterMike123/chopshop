// The affiliate program's figures for a period (CP13 A2, design §7.2: the
// port, simplified). The period is REAL: the server counts link landings and
// commission from that day on. The totals and the ranking are the server's;
// the page sorts the ranking and divides two counts for the conversion rate,
// nothing else.
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AppLayout from '../../components/layout/AppLayout';
import { useShopId } from '../../contexts/ShopContext';
import { PATHS, PERIODS, loadAnalytics } from './adminAffiliateData';
import { conversionRate, formatCount, formatMinor } from './affiliateView';
import { Page, MetricsBar, DataTable, Card, CardSection, Button } from '../../components/admin/ui';

const PERIOD_LABEL = { 30: '30 dagar', 90: '90 dagar', 365: '1 år' };

const SORTS = {
  conversions: { label: 'Konverteringar', by: (a, b) => b.conversions - a.conversions },
  commission: { label: 'Provision', by: (a, b) => b.commissionMinor - a.commissionMinor },
  clicks: { label: 'Klick', by: (a, b) => b.clicks - a.clicks },
};

const SELECT =
  'rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-3 py-1.5 text-[13px] text-admin-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)]';

const AdminAffiliateAnalytics = () => {
  const shopId = useShopId();
  const navigate = useNavigate();
  const [days, setDays] = useState(PERIODS[0]);
  const [sort, setSort] = useState('conversions');
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    loadAnalytics(shopId, days)
      .then((next) => { if (!cancelled) setAnalytics(next); })
      .catch((error) => { if (!cancelled) setLoadError(error?.message || 'Kunde inte hämta statistiken.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [shopId, days, attempt]);

  const ranking = useMemo(
    () => [...(analytics?.ranking ?? [])].sort(SORTS[sort].by),
    [analytics, sort],
  );

  const currency = analytics?.currency ?? 'SEK';
  // Two bars of three (counts, then money): six cells squeezed into one bar do not fit a phone.
  const counts = [
    { key: 'clicks', label: 'Klick', value: analytics ? formatCount(analytics.clicks) : null },
    { key: 'conversions', label: 'Konverteringar', value: analytics ? formatCount(analytics.conversions) : null },
    { key: 'rate', label: 'Konverteringsgrad', value: analytics ? conversionRate(analytics.conversions, analytics.clicks) : null },
  ];
  const money = [
    { key: 'commission', label: 'Provision', value: analytics ? formatMinor(analytics.commissionMinor, currency) : null },
    { key: 'unpaid', label: 'Obetald provision', value: analytics ? formatMinor(analytics.unpaidMinor, currency) : null },
    { key: 'active', label: 'Aktiva affiliates', value: analytics ? formatCount(analytics.activeAffiliates) : null },
  ];

  const periodSelect = (
    <div className="flex items-center gap-2">
      <label htmlFor="timeRange" className="text-[13px] text-admin-text-muted">Tidsperiod</label>
      <select id="timeRange" value={days} onChange={(e) => setDays(Number(e.target.value))} className={SELECT}>
        {PERIODS.map((d) => <option key={d} value={d}>{PERIOD_LABEL[d] ?? `${d} dagar`}</option>)}
      </select>
    </div>
  );

  const columns = [
    {
      key: 'rank',
      header: '#',
      className: 'w-10',
      render: (_a, i) => <span className="tabular-nums text-admin-text-muted">{i + 1}</span>,
    },
    {
      key: 'affiliate',
      header: 'Affiliate',
      render: (a) => (
        <div>
          <div className="font-medium text-admin-text group-hover:underline">{a.name}</div>
          <div className="font-mono text-[12px] text-admin-text-muted">{a.code}</div>
        </div>
      ),
    },
    { key: 'clicks', header: 'Klick', align: 'right', render: (a) => <span className="tabular-nums">{formatCount(a.clicks)}</span> },
    { key: 'conversions', header: 'Konverteringar', align: 'right', render: (a) => <span className="tabular-nums">{formatCount(a.conversions)}</span> },
    {
      key: 'rate',
      header: 'Konv.grad',
      align: 'right',
      render: (a) => <span className="tabular-nums text-admin-text-muted">{conversionRate(a.conversions, a.clicks)}</span>,
    },
    {
      key: 'commission',
      header: 'Provision',
      align: 'right',
      render: (a) => <span className="font-medium tabular-nums text-admin-text">{formatMinor(a.commissionMinor, currency)}</span>,
    },
  ];

  return (
    <AppLayout>
      <Page
        title="Affiliate Analytics"
        subtitle="Klick, konverteringar och provision för vald period. Obetald provision gäller hela tiden."
        back={{ to: PATHS.list, label: 'Affiliates' }}
        actions={periodSelect}
        className="space-y-5"
      >
        {loadError ? (
          <Card className="px-6 py-10 text-center">
            <p className="text-[13px] text-admin-text">{loadError}</p>
            <div className="mt-4">
              <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>Försök igen</Button>
            </div>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <MetricsBar metrics={counts} />
              <MetricsBar metrics={money} />
            </div>

            <CardSection
              title="Topplista"
              actions={
                <select
                  aria-label="Sortera topplistan"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                  className="rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-2.5 py-1 text-[12px] text-admin-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)]"
                >
                  {Object.entries(SORTS).map(([key, s]) => <option key={key} value={key}>{s.label}</option>)}
                </select>
              }
              bodyClassName="!p-0"
            >
              <DataTable
                columns={columns}
                rows={ranking}
                rowKey={(a) => a.affiliateId}
                loading={loading}
                onRowClick={(a) => navigate(PATHS.detail(a.affiliateId))}
                empty="Inga affiliates att visa."
                className="rounded-none border-0"
              />
            </CardSection>
          </>
        )}
      </Page>
    </AppLayout>
  );
};

export default AdminAffiliateAnalytics;
