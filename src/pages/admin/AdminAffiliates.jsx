import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Link, useNavigate } from 'react-router-dom';
import AppLayout from '../../components/layout/AppLayout';
import { useShopId } from '../../contexts/ShopContext';
// The page's data, one module per build (CP13 A2): Firebase in the older
// build, the API in the admin build (vite.admin.config.js ADMIN_ALIASES).
import { PATHS, loadAffiliatesOverview, loadMoreAffiliates, testLinkOf } from './adminAffiliateData';
import {
  AFFILIATE_STATUS,
  formatBp,
  formatCount,
  formatDay,
  formatMinor,
  promotionLabel,
} from './affiliateView';
import { Page, MetricsBar, DataTable, StatusPill, Button, Card } from '../../components/admin/ui';
import { PencilIcon, BanknotesIcon, LinkIcon } from '@heroicons/react/24/outline';

const ICON_BUTTON =
  'inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-admin-el)] text-admin-text-faint hover:bg-admin-surface-2 hover:text-admin-text';

const AdminAffiliates = () => {
  const shopId = useShopId();
  const navigate = useNavigate();
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setOverview(await loadAffiliatesOverview(shopId));
    } catch (error) {
      console.error('Error fetching affiliate data:', error);
      setLoadError(error?.message || 'Kunde inte hämta affiliate-data.');
    } finally {
      setLoading(false);
    }
  }, [shopId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleMore = async () => {
    setLoadingMore(true);
    try {
      const page = await loadMoreAffiliates(shopId, overview.nextCursor);
      setOverview((prev) => ({ ...prev, affiliates: [...prev.affiliates, ...page.affiliates], nextCursor: page.nextCursor }));
    } catch (error) {
      toast.error(error?.message || 'Kunde inte hämta fler affiliates.');
    } finally {
      setLoadingMore(false);
    }
  };

  const handleTestLink = async (affiliate) => {
    try {
      const link = await testLinkOf(shopId, affiliate);
      try {
        await navigator.clipboard.writeText(link);
        toast.success(`Testlänken är kopierad: ${link}`);
      } catch {
        toast(`Testlänk: ${link}`, { duration: 10000 });
      }
    } catch (error) {
      toast.error(error?.message || 'Kunde inte hämta länken.');
    }
  };

  const applications = overview?.applications ?? [];
  const affiliates = overview?.affiliates ?? [];
  const kpis = overview?.kpis;

  // Thin metrics strip (design §7.2): the server's figures of the last 30 days.
  const metrics = [
    { key: 'pending', label: 'Väntande ansökningar', value: kpis ? `${kpis.pending}${overview.moreApplications ? '+' : ''}` : null },
    { key: 'clicks', label: 'Klick (30 dagar)', value: kpis?.clicks == null ? null : formatCount(kpis.clicks) },
    { key: 'conversions', label: 'Konverteringar (30 dagar)', value: kpis?.conversions == null ? null : formatCount(kpis.conversions) },
    { key: 'accrued', label: 'Upplupen provision', value: kpis?.accruedMinor == null ? null : formatMinor(kpis.accruedMinor, kpis.currency) },
  ];

  // ── Pending applications list ──────────────────────────────────────────────
  const applicationColumns = [
    {
      key: 'name',
      header: 'Namn',
      render: (app) => (
        <span className="font-medium text-admin-text group-hover:underline">{app.name}</span>
      ),
    },
    {
      key: 'email',
      header: 'E-post',
      render: (app) => <span className="text-admin-text-muted">{app.email}</span>,
    },
    {
      key: 'channel',
      header: 'Kanal',
      render: (app) => <span className="text-admin-text-muted">{promotionLabel(app.promotionMethod)}</span>,
    },
    {
      key: 'received',
      header: 'Inkom',
      render: (app) => <span className="whitespace-nowrap text-admin-text-muted">{formatDay(app.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      className: 'w-28',
      render: (app) => (
        <div onClick={(e) => e.stopPropagation()} className="flex justify-end">
          <Button variant="secondary" onClick={() => navigate(PATHS.application(app.applicationId))}>
            Granska
          </Button>
        </div>
      ),
    },
  ];

  // ── All affiliates list ────────────────────────────────────────────────────
  const affiliateColumns = [
    {
      key: 'code',
      header: 'Kod',
      render: (affiliate) => (
        <span className="rounded-[var(--radius-admin-el)] bg-admin-surface-2 px-2 py-0.5 font-mono text-[12px] text-admin-text">
          {affiliate.code}
        </span>
      ),
    },
    {
      key: 'name',
      header: 'Namn',
      render: (affiliate) => (
        <span className="font-medium text-admin-text group-hover:underline">{affiliate.name}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (affiliate) => {
        const status = AFFILIATE_STATUS[affiliate.status];
        return <StatusPill tone={status?.tone || 'neutral'}>{status?.label || affiliate.status}</StatusPill>;
      },
    },
    {
      key: 'commission',
      header: 'Provision',
      align: 'right',
      render: (affiliate) => <span className="tabular-nums text-admin-text-muted">{formatBp(affiliate.commissionBp)}</span>,
    },
    {
      key: 'discount',
      header: 'Rabatt',
      align: 'right',
      render: (affiliate) => <span className="tabular-nums text-admin-text-muted">{formatBp(affiliate.discountBp)}</span>,
    },
    {
      key: 'clicks',
      header: 'Klick',
      align: 'right',
      render: (affiliate) => <span className="tabular-nums text-admin-text-muted">{formatCount(affiliate.clicks30d)}</span>,
    },
    {
      key: 'conversions',
      header: 'Konv.',
      align: 'right',
      render: (affiliate) => <span className="tabular-nums text-admin-text-muted">{formatCount(affiliate.conversions30d)}</span>,
    },
    {
      key: 'earned',
      header: 'Intjänat',
      align: 'right',
      render: (affiliate) => (
        <span className="tabular-nums text-admin-text">{formatMinor(affiliate.earnedMinor, affiliate.currency)}</span>
      ),
    },
    {
      key: 'payable',
      header: 'Att betala',
      align: 'right',
      render: (affiliate) => (
        <span className={`tabular-nums ${affiliate.payableMinor > 0 ? 'font-medium text-admin-text' : 'text-admin-text-muted'}`}>
          {formatMinor(affiliate.payableMinor, affiliate.currency)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      className: 'w-32',
      render: (affiliate) => (
        <div onClick={(e) => e.stopPropagation()} className="flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={() => navigate(PATHS.detail(affiliate.affiliateId))}
            title="Hantera"
            aria-label={`Hantera ${affiliate.name}`}
            className={ICON_BUTTON}
          >
            <PencilIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => navigate(PATHS.payout(affiliate.affiliateId))}
            title="Utbetalning"
            aria-label={`Utbetalning till ${affiliate.name}`}
            className={ICON_BUTTON}
          >
            <BanknotesIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => handleTestLink(affiliate)}
            title="Kopiera testlänk"
            aria-label={`Kopiera testlänk för ${affiliate.code}`}
            className={ICON_BUTTON}
          >
            <LinkIcon className="h-4 w-4" />
          </button>
        </div>
      ),
    },
  ];

  const headerActions = (
    <>
      <Button variant="secondary" as={Link} to={PATHS.analytics}>
        Detaljerad Analytics
      </Button>
      <Button variant="primary" as={Link} to={PATHS.invite}>
        Bjud in affiliate
      </Button>
    </>
  );

  return (
    <AppLayout>
      <Page
        title="Affiliate-hantering"
        subtitle="Hantera nya ansökningar och se statistik för dina aktiva affiliates."
        actions={headerActions}
      >
        {loadError ? (
          <Card className="px-6 py-10 text-center">
            <p className="text-[13px] text-admin-text">{loadError}</p>
            <div className="mt-4">
              <Button variant="secondary" onClick={fetchData}>Försök igen</Button>
            </div>
          </Card>
        ) : (
          <div className="space-y-5">
            <MetricsBar metrics={metrics} />

            {/* Pending applications */}
            <div className="space-y-2">
              <h2 className="text-[13px] font-medium text-admin-text-muted">Inkomna ansökningar</h2>
              <DataTable
                columns={applicationColumns}
                rows={applications}
                rowKey={(a) => a.applicationId}
                loading={loading}
                onRowClick={(a) => navigate(PATHS.application(a.applicationId))}
                empty="Inga nya ansökningar."
              />
            </div>

            {/* All affiliates */}
            <div className="space-y-2">
              <h2 className="text-[13px] font-medium text-admin-text-muted">
                Alla affiliates{loading ? '' : ` (${affiliates.length}${overview?.nextCursor ? '+' : ''})`}
              </h2>
              <DataTable
                columns={affiliateColumns}
                rows={affiliates}
                rowKey={(a) => a.affiliateId}
                loading={loading}
                onRowClick={(a) => navigate(PATHS.detail(a.affiliateId))}
                empty="Inga affiliates ännu. Godkänn en ansökan eller bjud in någon."
                footer={
                  overview?.nextCursor ? (
                    <div className="flex justify-center py-2">
                      <Button variant="plain" onClick={handleMore} disabled={loadingMore}>
                        {loadingMore ? 'Hämtar…' : 'Visa fler'}
                      </Button>
                    </div>
                  ) : undefined
                }
              />
            </div>
          </div>
        )}
      </Page>
    </AppLayout>
  );
};

export default AdminAffiliates;
