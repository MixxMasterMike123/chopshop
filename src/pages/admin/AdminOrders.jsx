import React, { useState, useEffect, useMemo } from 'react';
import { useOrder } from '../../contexts/OrderContext';
import { useNavigate } from 'react-router-dom';
import AppLayout from '../../components/layout/AppLayout';
import { format } from 'date-fns';
import { sv } from 'date-fns/locale';
import OrderStatusMenu from '../../components/OrderStatusMenu';
import { toast } from 'react-hot-toast';
import { printMultipleShippingLabels } from '../../utils/labelPrinter';
import { exportOrdersToCSV } from '../../utils/orderExport';
import { exportPickupOrdersToCSV } from '../../utils/pickupExport';
import { formatPickupDayShort } from '../../utils/pickupDates';
import { exportSingleOrderVerification, exportAllOrderVerifications } from '../../utils/orderVerification';
import { getEnhancedOrderDistribution } from '../../utils/orderUtils';
import { SHOW_SOURCE_TABS, searchOrders, withExportDetails, onOrdersStale } from './adminOrdersData';
import { ArrowDownTrayIcon, DocumentTextIcon, PrinterIcon, TruckIcon, MapPinIcon } from '@heroicons/react/24/outline';
import {
  Page,
  MetricsBar,
  DataTable,
  ViewTabs,
  InlineSearch,
  Pagination,
  Button,
  Toolbar,
  StatusPill,
} from '../../components/admin/ui';

// Total units on an order (sum of line-item quantities), via the same resolver
// the order-detail page uses — always returns a non-empty array, so this is safe.
const orderItemCount = (order) => {
  // A list row of the admin build carries the count, not the lines.
  if (!Array.isArray(order.items) && Number.isSafeInteger(order.itemCount)) return order.itemCount;
  try {
    return getEnhancedOrderDistribution(order).reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
  } catch {
    return 0;
  }
};

// Payment "paid" derivation — mirrors OrderConfirmation's isPaid logic exactly
// (there is no explicit order.paymentStatus field). A Stripe order in Firestore
// fired on payment success, so succeeded/paid or a confirmed status = paid.
const isOrderPaid = (order) =>
  ['succeeded', 'paid'].includes(order.payment?.status) || order.status === 'confirmed';

const AdminOrders = () => {
  const navigate = useNavigate();
  const { getAllOrders, updateOrderStatus, loading: contextLoading, error: contextError } = useOrder();
  const [selectedOrders, setSelectedOrders] = useState(new Set());
  const [printLoading, setPrintLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [pickupExportLoading, setPickupExportLoading] = useState(false);
  const [verificationProgress, setVerificationProgress] = useState(null);

  // NOTE (slice 1b): the affiliate-click batch-fetch + the "Trafikkälla" list
  // column (affiliate code · referrer category · payment method) were removed
  // from the LIST to keep the table Shopify-clean. That attribution info moves
  // to the Order DETAIL right rail in slice 1c (Mikael's call, 2026-06-15).

  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeSourceTab, setActiveSourceTab] = useState('all'); // 'all', 'b2b', 'b2c'
  const [activeStatusTab, setActiveStatusTab] = useState('all');

  // Handle export orders to CSV
  const handleExportOrders = async () => {
    try {
      setExportLoading(true);
      
      // Export filtered orders (respects current filters)
      const ordersToExport = sortedOrders.length > 0 ? sortedOrders : orders;
      
      if (ordersToExport.length === 0) {
        toast.error('Inga ordrar att exportera');
        return;
      }

      const result = exportOrdersToCSV(await withExportDetails(ordersToExport));
      
      if (result.success) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      console.error('Error exporting orders:', error);
      toast.error('Kunde inte exportera ordrar');
    } finally {
      setExportLoading(false);
    }
  };

  // Handle export pickup orders → picklist grouped by location + date
  // (Delivery & Pickup v2). Respects the page's current filters, like CSV export.
  const handleExportPickup = async () => {
    try {
      setPickupExportLoading(true);
      const ordersToExport = sortedOrders.length > 0 ? sortedOrders : orders;
      const result = exportPickupOrdersToCSV(
        await withExportDetails(ordersToExport.filter((o) => o.deliveryMethod === 'pickup'))
      );
      if (result.success) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      console.error('Error exporting pickup orders:', error);
      toast.error('Kunde inte exportera upphämtningar');
    } finally {
      setPickupExportLoading(false);
    }
  };

  // Handle export individual order verification
  const handleExportVerification = async (order) => {
    try {
      const loadingToast = toast.loading('Skapar PDF...');
      const [fullOrder] = await withExportDetails([order]);
      const result = await exportSingleOrderVerification(fullOrder);
      toast.dismiss(loadingToast);
      
      if (result.success) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      console.error('Error exporting verification:', error);
      toast.error('Kunde inte skapa verifikation');
    }
  };

  // Handle export all verifications
  const handleExportAllVerifications = async () => {
    try {
      const ordersToExport = sortedOrders.length > 0 ? sortedOrders : orders;
      
      if (ordersToExport.length === 0) {
        toast.error('Inga ordrar att exportera');
        return;
      }

      setVerificationProgress({ current: 0, total: ordersToExport.length });
      
      const result = await exportAllOrderVerifications(await withExportDetails(ordersToExport), {
        delay: 1000,
        onProgress: (progress) => {
          setVerificationProgress(progress);
          toast.loading(`Laddar ner verifikation ${progress.current} av ${progress.total}...`, {
            id: 'verification-progress'
          });
        }
      });
      
      toast.dismiss('verification-progress');
      setVerificationProgress(null);
      
      if (result.success) {
        toast.success(result.message, { duration: 5000 });
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      console.error('Error exporting verifications:', error);
      toast.dismiss('verification-progress');
      setVerificationProgress(null);
      toast.error('Kunde inte exportera verifikationer');
    }
  };

  useEffect(() => {
    const fetchOrders = async () => {
      try {
        setLoading(true);
        const fetchedOrders = await getAllOrders();
        setOrders(fetchedOrders);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    };
    fetchOrders();
    // A quiet re-read when the list may be stale (the admin build: the window
    // got the focus back); a failure keeps the list on screen.
    return onOrdersStale(() => {
      getAllOrders().then(setOrders, (e) => console.warn('Could not refresh orders:', e?.message));
    });
  }, [getAllOrders]);

  // The search's matches (null while none is asked). The older build filters
  // the loaded orders; the admin build asks the server (adminOrdersData).
  const [searchResult, setSearchResult] = useState(null);
  useEffect(() => {
    if (!searchTerm || !Array.isArray(orders)) {
      setSearchResult(null);
      return undefined;
    }
    const controller = new AbortController();
    searchOrders(orders, searchTerm, { signal: controller.signal })
      .then((matches) => {
        if (!controller.signal.aborted) setSearchResult({ term: searchTerm, orders: matches });
      })
      .catch((e) => {
        if (controller.signal.aborted || e?.name === 'AbortError') return;
        console.error('Error searching orders:', e);
        setSearchResult({ term: searchTerm, orders: [] });
      });
    return () => controller.abort();
  }, [orders, searchTerm]);

  const filteredOrders = useMemo(() => {
    if (!Array.isArray(orders)) {
      return [];
    }

    // 0. The search's matches (the last answer stays while a new one is asked)
    const searched = searchTerm ? (searchResult ? searchResult.orders : []) : orders;

    // 1. Filter by Source
    let sourceFiltered = searched;
    if (activeSourceTab === 'b2b') {
      sourceFiltered = searched.filter(order => order.source === 'b2b' || !order.source); // !order.source for legacy B2B
    } else if (activeSourceTab === 'b2c') {
      sourceFiltered = searched.filter(order => order.source === 'b2c');
    }
    
    // 2. Filter by Status
    let statusFiltered = sourceFiltered;
    if (activeStatusTab !== 'all') {
      statusFiltered = sourceFiltered.filter(order => order.status === activeStatusTab);
    }

    return statusFiltered;
  }, [orders, searchTerm, searchResult, activeSourceTab, activeStatusTab]);

  const sortedOrders = useMemo(() => {
    return [...filteredOrders].sort((a, b) => {
      const dateA = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.createdAt || 0);
      const dateB = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt || 0);
      return dateB - dateA;
    });
  }, [filteredOrders]);

  // KPI strip — computed from the SOURCE-filtered set (so the metrics follow the
  // active source tab but not the status tab/search, which would make them
  // jump around). All derived from already-loaded data — no extra queries
  // (honesty rule: only real, computable metrics).
  const sourceScopedOrders = useMemo(() => {
    if (!Array.isArray(orders)) return [];
    if (activeSourceTab === 'b2b') return orders.filter((o) => o.source === 'b2b' || !o.source);
    if (activeSourceTab === 'b2c') return orders.filter((o) => o.source === 'b2c');
    return orders;
  }, [orders, activeSourceTab]);

  const kpis = useMemo(() => {
    const list = sourceScopedOrders;
    const itemsTotal = list.reduce((sum, o) => sum + orderItemCount(o), 0);
    // "Att hantera" = open orders not yet shipped/delivered/cancelled.
    const toHandle = list.filter(
      (o) => !['shipped', 'delivered', 'cancelled'].includes(o.status)
    ).length;
    const delivered = list.filter((o) => o.status === 'delivered').length;
    return [
      { key: 'orders', label: 'Ordrar', value: list.length },
      { key: 'items', label: 'Artiklar', value: itemsTotal },
      { key: 'tohandle', label: 'Att hantera', value: toHandle },
      { key: 'delivered', label: 'Levererade', value: delivered },
    ];
  }, [sourceScopedOrders]);

  // Status-tab counts (within the active source scope) for the segmented filter.
  const statusCounts = useMemo(() => {
    const counts = { all: sourceScopedOrders.length };
    for (const o of sourceScopedOrders) {
      counts[o.status] = (counts[o.status] || 0) + 1;
    }
    return counts;
  }, [sourceScopedOrders]);
  
  const formatDate = (date) => {
    if (!date) return 'N/A';
    try {
      const jsDate = date.toDate ? date.toDate() : new Date(date);
      if (isNaN(jsDate.getTime())) {
        return 'Ogiltigt datum';
      }
      return format(jsDate, 'PPP p', { locale: sv });
    } catch (error) {
      console.error("Failed to format date:", date, error);
      return 'Datumfel';
    }
  };
  
  const handleStatusUpdate = async (orderId, newStatus) => {
    try {
      setLoading(true);
      await updateOrderStatus(orderId, newStatus);
      
      // Fetch all orders again to update the list
      const fetchedOrders = await getAllOrders();
      setOrders(fetchedOrders);
      
      // Show success message
      toast.success('Orderstatus uppdaterad');
    } catch (error) {
      console.error('Error updating order status:', error);
      toast.error(error?.userMessage || 'Kunde inte uppdatera orderstatus');
    } finally {
      setLoading(false);
    }
  };

  const handleOrderSelection = (orderId, isSelected) => {
    const newSelection = new Set(selectedOrders);
    if (isSelected) {
      newSelection.add(orderId);
    } else {
      newSelection.delete(orderId);
    }
    setSelectedOrders(newSelection);
  };

  // DataTable selection adapters: it calls onToggle(id) and onToggleAll(checked, ids).
  // Honor the exact visible ids DataTable passes (identical to filteredOrders
  // today since there's no pagination; future-proof if paging is added).
  const toggleOne = (id) => handleOrderSelection(id, !selectedOrders.has(id));
  const toggleAll = (checked, ids = []) => setSelectedOrders(checked ? new Set(ids) : new Set());

  const handlePrintSelectedLabels = async () => {
    if (selectedOrders.size === 0) {
      toast.error('Välj minst en beställning för att skriva ut etiketter');
      return;
    }

    try {
      setPrintLoading(true);
      
      // Get selected orders (with their delivery address)
      const ordersToProcess = await withExportDetails(filteredOrders.filter(order => selectedOrders.has(order.id)));
      
      // Create user data map for B2B orders (simplified - would need proper user fetching)
      const userDataMap = {};
      for (const order of ordersToProcess) {
        if (order.userId && order.source !== 'b2c') {
          userDataMap[order.userId] = {
            contactPerson: 'Kund', // Simplified - would fetch from user data
            companyName: 'Företag',
            deliveryAddress: 'Leveransadress saknas',
            deliveryPostalCode: '',
            deliveryCity: '',
            deliveryCountry: 'SE'
          };
        }
      }
      
      console.log('🏷️ Printing labels for', ordersToProcess.length, 'orders');
      
      await printMultipleShippingLabels(ordersToProcess, userDataMap);
      
      toast.success(`${ordersToProcess.length} fraktetiketter skickade till skrivare!`);
      
      // Clear selection after printing
      setSelectedOrders(new Set());
    } catch (error) {
      console.error('❌ Failed to print labels:', error);
      toast.error(`Kunde inte skriva ut etiketter: ${error.message}`);
    } finally {
      setPrintLoading(false);
    }
  };

  const sourceTabOptions = [
    { value: 'all', label: 'Alla källor' },
    { value: 'b2b', label: 'Återförsäljare' },
    { value: 'b2c', label: 'Kunder' },
  ];

  const statusTabOptions = [
    { value: 'all', label: 'Alla', count: statusCounts.all },
    { value: 'pending', label: 'Väntar', count: statusCounts.pending || 0 },
    { value: 'processing', label: 'Behandlas', count: statusCounts.processing || 0 },
    { value: 'shipped', label: 'Skickad', count: statusCounts.shipped || 0 },
    { value: 'delivered', label: 'Levererad', count: statusCounts.delivered || 0 },
    { value: 'cancelled', label: 'Avbruten', count: statusCounts.cancelled || 0 },
  ];

  const formatSek = (amount, withDecimals = true) =>
    new Intl.NumberFormat('sv-SE', {
      style: 'currency',
      currency: 'SEK',
      minimumFractionDigits: withDecimals ? 2 : 0,
      maximumFractionDigits: withDecimals ? 2 : 0,
    }).format(amount || 0);

  // New-shape orders (B2C + new B2B Faktura) carry `total`; legacy B2B orders
  // carry prisInfo.totalPris. Prefer `total` whenever present so B2B Faktura
  // orders show their real amount (not 0 kr).
  const orderTotal = (order) =>
    (order.total != null ? order.total : (order.prisInfo?.totalPris ?? order.totalAmount)) || 0;

  const currentError = error || contextError;
  const isLoading = loading || contextLoading;

  // ── Table column definitions (Shopify-style: Order · Datum · Kund · Betalning ·
  //    Status · Leverans · Artiklar · Belopp). All fields verified to exist. ──
  const columns = [
    {
      key: 'order',
      header: 'Order',
      render: (order) => (
        // Polaris: order number = dark medium link, underline on hover (not blue).
        <span className="font-medium text-admin-text group-hover:underline">
          {order.orderNumber || order.id}
        </span>
      ),
    },
    {
      key: 'date',
      header: 'Datum',
      render: (order) => (
        <span className="text-admin-text-muted whitespace-nowrap">{formatDate(order.createdAt)}</span>
      ),
    },
    {
      key: 'customer',
      header: 'Kund',
      render: (order) => {
        // New-shape orders (B2C + new B2B Faktura) carry customerInfo; legacy B2B
        // carried top-level companyName/userEmail. Read customerInfo first.
        const name =
          order.companyName ||
          order.customerInfo?.companyName ||
          order.customerInfo?.name ||
          `${order.customerInfo?.firstName || ''} ${order.customerInfo?.lastName || ''}`.trim() ||
          'Gäst';
        const email = order.customerInfo?.email || order.userEmail || '';
        return (
          <div className="min-w-0">
            <div className="truncate text-admin-text">{name}</div>
            {email && <div className="truncate text-[12px] text-admin-text-faint">{email}</div>}
          </div>
        );
      },
    },
    {
      key: 'channel',
      header: 'Kanal',
      render: (order) => (
        <span className="text-admin-text-muted">
          {order.source === 'b2c' ? 'Webbshop' : 'Återförsäljare'}
        </span>
      ),
    },
    {
      key: 'payment',
      header: 'Betalning',
      render: (order) => {
        // B2B/legacy invoice orders have no Stripe payment object — neutral
        // "Faktura" badge rather than misreading them as "Väntar".
        if (order.source !== 'b2c') {
          return <StatusPill tone="neutral">Faktura</StatusPill>;
        }
        return isOrderPaid(order) ? (
          <StatusPill tone="success">Betald</StatusPill>
        ) : (
          <StatusPill tone="warning">Väntar</StatusPill>
        );
      },
    },
    {
      key: 'delivery',
      header: 'Leverans',
      render: (order) => {
        const isPickup = order.deliveryMethod === 'pickup';
        return (
          <span className="inline-flex items-center gap-1.5 text-admin-text-muted whitespace-nowrap">
            {isPickup ? (
              <>
                <MapPinIcon className="h-4 w-4 shrink-0" />
                <span className="flex flex-col leading-tight">
                  <span className="truncate max-w-[160px]" title={order.pickupLocation?.name || 'Upphämtning'}>
                    {order.pickupLocation?.name || 'Upphämtning'}
                  </span>
                  {order.pickupLocation?.date && (
                    <span className="text-[11px] text-admin-text-faint">
                      {formatPickupDayShort(order.pickupLocation.date)}
                    </span>
                  )}
                </span>
              </>
            ) : (
              <>
                <TruckIcon className="h-4 w-4 shrink-0" />
                Hemleverans
              </>
            )}
          </span>
        );
      },
    },
    {
      key: 'items',
      header: 'Artiklar',
      align: 'right',
      render: (order) => <span className="tabular-nums text-admin-text-muted">{orderItemCount(order)}</span>,
    },
    {
      key: 'total',
      header: 'Belopp',
      align: 'right',
      render: (order) => (
        <span className="tabular-nums font-medium text-admin-text">{formatSek(orderTotal(order))}</span>
      ),
    },
    {
      // Actionable status — keeps the inline OrderStatusMenu workflow. Stop row
      // click so opening the menu / changing status does not navigate to detail.
      key: 'status',
      header: 'Status',
      align: 'right',
      className: 'w-40',
      render: (order) => (
        <div onClick={(e) => e.stopPropagation()} className="flex justify-end">
          <OrderStatusMenu
            currentStatus={order.status}
            onStatusChange={(newStatus) => handleStatusUpdate(order.id, newStatus)}
            disabled={isLoading}
            source={order.source}
            isPickup={order.deliveryMethod === 'pickup'}
            options={order.statusOptions}
          />
        </div>
      ),
    },
    {
      // Per-order verification PDF export (bokföring). Stop row click.
      key: 'actions',
      header: '',
      align: 'right',
      className: 'w-12',
      render: (order) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleExportVerification(order);
          }}
          title="Exportera som verifikation för bokföring"
          aria-label="Exportera verifikation"
          className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-admin-el)] text-admin-text-faint hover:bg-admin-surface-2 hover:text-admin-text"
        >
          <PrinterIcon className="h-4 w-4" />
        </button>
      ),
    },
  ];

  const headerActions = (
    <>
      <Button
        variant="secondary"
        onClick={handleExportOrders}
        disabled={exportLoading || isLoading || orders.length === 0}
      >
        {exportLoading ? (
          <span className="inline-flex items-center gap-2">
            <span className="h-4 w-4 animate-spin rounded-full border-b-2 border-current" />
            Exporterar…
          </span>
        ) : (
          <>
            <ArrowDownTrayIcon className="h-4 w-4" />
            Exportera CSV
          </>
        )}
      </Button>
      <Button
        variant="secondary"
        onClick={handleExportPickup}
        disabled={pickupExportLoading || isLoading || orders.length === 0}
        title="Exportera upphämtningsordrar som plocklista, grupperad per plats och datum"
      >
        {pickupExportLoading ? (
          <span className="inline-flex items-center gap-2">
            <span className="h-4 w-4 animate-spin rounded-full border-b-2 border-current" />
            Exporterar…
          </span>
        ) : (
          <>
            <MapPinIcon className="h-4 w-4" />
            Upphämtningar
          </>
        )}
      </Button>
      <Button
        variant="secondary"
        onClick={handleExportAllVerifications}
        disabled={isLoading || orders.length === 0 || verificationProgress !== null}
        title="Exportera varje order som separat PDF-verifikation för bokföring"
      >
        {verificationProgress ? (
          <span className="inline-flex items-center gap-2">
            <span className="h-4 w-4 animate-spin rounded-full border-b-2 border-current" />
            {verificationProgress.current}/{verificationProgress.total}
          </span>
        ) : (
          <>
            <DocumentTextIcon className="h-4 w-4" />
            Verifikationer
          </>
        )}
      </Button>
    </>
  );

  // In-card toolbar: source view-tabs + inline search + status filter (Polaris
  // IndexTable header pattern — filters live INSIDE the table card).
  const tableToolbar = (
    <>
      {SHOW_SOURCE_TABS && (
        <ViewTabs
          ariaLabel="Filtrera på källa"
          options={sourceTabOptions}
          value={activeSourceTab}
          onChange={setActiveSourceTab}
        />
      )}
      <InlineSearch
        value={searchTerm}
        onChange={setSearchTerm}
        placeholder="Sök på ordernr, kundinfo…"
      />
    </>
  );

  const tableFooter = (
    <Pagination label={sortedOrders.length ? `1–${sortedOrders.length}` : '0'} prevDisabled nextDisabled />
  );

  return (
    <AppLayout>
      <Page title="Ordrar" actions={headerActions}>
        <div className="space-y-3">
          {/* Thin metrics strip (Polaris s-metrics-bar), not big KPI cards. */}
          <MetricsBar metrics={kpis} />

          {/* Status filter — a second view-tab row on the canvas above the card. */}
          <div className="overflow-x-auto">
            <ViewTabs
              ariaLabel="Filtrera på status"
              options={statusTabOptions}
              value={activeStatusTab}
              onChange={setActiveStatusTab}
            />
          </div>

          {/* Bulk-action bar when rows are selected. */}
          {selectedOrders.size > 0 && (
            <Toolbar count={selectedOrders.size}>
              <Button variant="secondary" onClick={handlePrintSelectedLabels} disabled={printLoading}>
                {printLoading ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="h-4 w-4 animate-spin rounded-full border-b-2 border-current" />
                    Skriver ut…
                  </span>
                ) : (
                  <>
                    <PrinterIcon className="h-4 w-4" />
                    Skriv ut fraktetiketter
                  </>
                )}
              </Button>
              <Button variant="plain" onClick={() => setSelectedOrders(new Set())}>
                Avmarkera
              </Button>
            </Toolbar>
          )}

          {currentError ? (
            <div className="rounded-[var(--radius-admin)] border border-admin-critical-dot/30 bg-admin-critical-bg px-4 py-3 text-[13px] text-admin-critical-text">
              Fel vid laddning av ordrar: {currentError}
            </div>
          ) : (
            <>
              <DataTable
                columns={columns}
                rows={sortedOrders}
                rowKey={(o) => o.id}
                loading={isLoading}
                onRowClick={(o) => navigate(`/admin/orders/${o.id}`)}
                empty="Inga ordrar matchar de valda filtren."
                toolbar={tableToolbar}
                footer={tableFooter}
                selection={{
                  selectedIds: selectedOrders,
                  onToggle: toggleOne,
                  onToggleAll: toggleAll,
                }}
              />

              {activeSourceTab === 'b2b' && sortedOrders.length > 0 && (
                <div className="flex justify-end">
                  <div className="inline-flex items-baseline gap-3 text-[13px]">
                    <span className="text-admin-text-muted">Totalsumma</span>
                    <span className="text-[15px] font-semibold tabular-nums text-admin-text">
                      {formatSek(
                        sortedOrders.reduce(
                          (sum, order) => sum + (order.prisInfo?.totalPris || order.totalAmount || order.total || 0),
                          0
                        ),
                        false
                      )}
                    </span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </Page>
    </AppLayout>
  );
};

export default AdminOrders;