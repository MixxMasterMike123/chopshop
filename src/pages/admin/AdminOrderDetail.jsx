import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useOrder } from '../../contexts/OrderContext';
import { useAuth } from '../../contexts/AuthContext';
import { format } from 'date-fns';
import { sv } from 'date-fns/locale';
import toast from 'react-hot-toast';
import AppLayout from '../../components/layout/AppLayout';
import OrderStatusMenu from '../../components/OrderStatusMenu';
import { doc, getDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '../../firebase/config';
import { useContentTranslation } from '../../hooks/useContentTranslation';
import { printShippingLabel } from '../../utils/labelPrinter';
import LabelPrintInstructions from '../../components/LabelPrintInstructions';
import { getEnhancedOrderDistribution, getDisplayColor, getDisplaySize } from '../../utils/orderUtils';
import { formatPaymentMethodName } from '../../utils/paymentMethods';
import { formatPickupDate } from '../../utils/pickupDates';
import { escapeHtml } from '../../utils/escapeHtml';
import { Page, Card, CardSection, RightRail, Button, StatusPill, toneForOrderStatus } from '../../components/admin/ui';
import { TruckIcon, MapPinIcon, PrinterIcon, TrashIcon, ArrowDownTrayIcon } from '@heroicons/react/24/outline';

// Dispute display maps (Slice A). disputeStatus mirrors Stripe's dispute status;
// connect.disputeRecoveryStatus is our own transfer-recovery state.
const DISPUTE_LABEL = {
  warning_needs_response: 'Kräver svar', needs_response: 'Kräver svar',
  under_review: 'Under granskning', won: 'Vunnen', lost: 'Förlorad',
  open: 'Öppen', closed: 'Avslutad',
};
const DISPUTE_TONE = {
  won: 'success', lost: 'danger',
  warning_needs_response: 'warning', needs_response: 'warning', under_review: 'info',
  open: 'warning', closed: 'neutral',
};
const RECOVERY_LABEL = {
  recovered: 'Återhämtad från butik', shortfall: '⚠️ Underskott — manuell avstämning',
  no_transfer_id: '⚠️ Ingen överföring att återkräva', pending_outcome: 'Väntar på utfall',
  returned_won: 'Återförd till butik (vunnen)', won_no_reversal: 'Vunnen — inget att återföra',
  retransfer_failed: '⚠️ Återföring misslyckades', lost_final: 'Förlorad — slutförd',
};

const AdminOrderDetail = () => {
  const { orderId } = useParams();
  const navigate = useNavigate();
  const { getOrderById, updateOrderStatus, deleteOrder } = useOrder();
  const { isPlatform } = useAuth();
  const [order, setOrder] = useState(null);
  const [userData, setUserData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [userLoading, setUserLoading] = useState(false);
  const [error, setError] = useState(null);
  const [updateStatusLoading, setUpdateStatusLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [fetchAttempted, setFetchAttempted] = useState(false);
  const [printLoading, setPrintLoading] = useState(false);
  const { getContentValue } = useContentTranslation();

  // Use guest data if it exists, otherwise use fetched user data
  // New B2B Faktura orders embed the buyer in customerInfo/shippingInfo (the
  // buyer is in b2bCustomers, NOT users — so the users/{userId} lookup would
  // miss). Read straight off the order doc for source==='b2b' with customerInfo.
  const isNewB2B = order?.source === 'b2b' && !!order?.customerInfo;
  const displayUser = order?.source === 'b2c' ? {
    email: order.customerInfo?.email || 'Not specified',
    companyName: `${order.customerInfo?.firstName || ''} ${order.customerInfo?.lastName || ''} (B2C Customer)`.trim(),
    contactPerson: `${order.customerInfo?.firstName || ''} ${order.customerInfo?.lastName || ''}`.trim() || 'Not specified',
    phone: 'Not specified',
    role: 'B2C Customer',
    active: true, // B2C customers are implicitly active for their order
  } : isNewB2B ? {
    email: order.customerInfo?.email || 'Not specified',
    companyName: order.customerInfo?.companyName || 'Not specified',
    contactPerson: order.customerInfo?.contactPerson || 'Not specified',
    phone: order.customerInfo?.phone || 'Not specified',
    role: 'B2B-kund',
    active: true,
  } : userData || {
    email: 'Not specified',
    companyName: 'Not specified',
    contactPerson: 'Not specified',
    phone: 'Not specified',
    role: 'User',
    active: false
  };

  const displayAddress = order?.source === 'b2c' ? {
    company: `${order.customerInfo?.firstName || ''} ${order.customerInfo?.lastName || ''}`.trim() || 'Not specified',
    contactPerson: `${order.customerInfo?.firstName || ''} ${order.customerInfo?.lastName || ''}`.trim() || 'Not specified',
    address: (() => {
      // B2C orders store address in shippingInfo
      if (order.shippingInfo) {
        const addressParts = [
          order.shippingInfo.address,
          order.shippingInfo.apartment && order.shippingInfo.apartment.trim() ? order.shippingInfo.apartment : null,
          `${order.shippingInfo.postalCode} ${order.shippingInfo.city}`.trim(),
          order.shippingInfo.country === 'SE' ? 'Sverige' : order.shippingInfo.country
        ].filter(Boolean);
        
        if (addressParts.length > 0) {
          return addressParts.join(', ');
        }
      }
      
      return 'Address information missing';
    })()
  } : isNewB2B ? {
    company: order.customerInfo?.companyName || 'Not specified',
    contactPerson: order.customerInfo?.contactPerson || 'Not specified',
    address: [
      order.shippingInfo?.address,
      `${order.shippingInfo?.postalCode || ''} ${order.shippingInfo?.city || ''}`.trim(),
      order.shippingInfo?.country,
    ].filter(Boolean).join(', ') || 'Not specified'
  } : {
    company: userData?.companyName || 'Not specified',
    contactPerson: userData?.contactPerson || 'Not specified',
    address: [
      userData?.deliveryAddress,
      userData?.deliveryPostalCode,
      userData?.deliveryCity,
      userData?.deliveryCountry
    ].filter(Boolean).join(', ') || 'Not specified'
  };

  // Fetch user data based on userId
  const fetchUserData = useCallback(async (userId) => {
    if (!userId) return null;
    
    try {
      setUserLoading(true);
      console.log('Fetching user data for ID:', userId);
      
      const userDocRef = doc(db, 'users', userId);
      const userDocSnap = await getDoc(userDocRef);
      
      if (userDocSnap.exists()) {
        console.log('User found in database');
        return userDocSnap.data();
      } else {
        console.log('User not found in database');
        return null;
      }
    } catch (err) {
      console.error('Error fetching user data:', err);
      return null;
    } finally {
      setUserLoading(false);
    }
  }, []);

  // Fetch order data
  const fetchOrder = useCallback(async () => {
    if (!orderId || fetchAttempted) return;
    
    try {
      setLoading(true);
      console.log('Fetching order with ID:', orderId);
      const orderData = await getOrderById(orderId);
      
      if (!orderData) {
        setError('Order not found');
        toast.error('Order not found');
        return;
      }
      
      setOrder(orderData);
      
      // Fetch user data if order has userId
      if (orderData.userId) {
        const userData = await fetchUserData(orderData.userId);
        if (userData) {
          setUserData(userData);
        }
      }
      
      setError(null);
    } catch (err) {
      console.error('Error fetching order:', err);
      setError('Could not load order details');
      toast.error('Could not load order details');
    } finally {
      setLoading(false);
      setFetchAttempted(true);
    }
  }, [orderId, getOrderById, fetchAttempted, fetchUserData]);

  useEffect(() => {
    fetchOrder();
  }, [fetchOrder]);

  const handleRetry = () => {
    setFetchAttempted(false); // Reset the fetch attempted flag to try again
    fetchOrder();
  };

  const getOrderDate = (dateValue) => {
    if (!dateValue) return null;
    
    // Handle Firestore Timestamp
    if (dateValue && typeof dateValue.toDate === 'function') {
      return dateValue.toDate();
    }
    
    // Handle ISO date string
    if (typeof dateValue === 'string') {
      return new Date(dateValue);
    }
    
    // Handle JavaScript Date object
    if (dateValue instanceof Date) {
      return dateValue;
    }
    
    // Handle seconds-based timestamp (for Firestore seconds)
    if (dateValue.seconds) {
      return new Date(dateValue.seconds * 1000);
    }
    
    return null;
  };

  const formatDate = (date) => {
    try {
      if (!date) return 'Unknown date';
      
      const jsDate = getOrderDate(date);
      if (!jsDate) return 'Unknown date';
      
      return format(jsDate, 'PPP p', { locale: sv });
    } catch (error) {
      console.error('Date formatting error:', error);
      return 'Date formatting error';
    }
  };

  const getStatusInfo = (status) => {
    switch (status) {
      case 'pending':
        return { text: 'Väntar', color: 'bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-300' };
      case 'confirmed':
        return { text: 'Bekräftad', color: 'bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-300' };
      case 'processing':
        return { text: 'Behandlas', color: 'bg-orange-100 dark:bg-orange-900 text-orange-800 dark:text-orange-300' };
      // POD: printer marked the order as printed (internal milestone, pre-ship).
      case 'printed':
        return { text: 'Tryckt', color: 'bg-purple-100 dark:bg-purple-900 text-purple-800 dark:text-purple-300' };
      case 'shipped':
        return { text: 'Skickad', color: 'bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-300' };
      case 'delivered':
        return { text: 'Levererad', color: 'bg-emerald-100 dark:bg-emerald-900 text-emerald-800 dark:text-emerald-300' };
      case 'ready_for_pickup':
        return { text: 'Redo att hämtas', color: 'bg-purple-100 dark:bg-purple-900 text-purple-800 dark:text-purple-300' };
      // B2B Faktura lifecycle (pending → invoiced → paid → shipped → completed)
      case 'invoiced':
        return { text: 'Fakturerad', color: 'bg-indigo-100 dark:bg-indigo-900 text-indigo-800 dark:text-indigo-300' };
      case 'paid':
        return { text: 'Betald', color: 'bg-teal-100 dark:bg-teal-900 text-teal-800 dark:text-teal-300' };
      case 'completed':
        return { text: 'Slutförd', color: 'bg-emerald-100 dark:bg-emerald-900 text-emerald-800 dark:text-emerald-300' };
      case 'cancelled':
        return { text: 'Avbruten', color: 'bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-300' };
      default:
        return { text: status || 'Unknown', color: 'bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-300' };
    }
  };

  // Tracking-number capture for the shipped transition. When the admin selects
  // 'shipped' we reveal an input first (instead of firing immediately) so the
  // tracking number reaches the status-update email + gets persisted on the order.
  const [pendingShip, setPendingShip] = useState(false);
  const [trackingNumber, setTrackingNumber] = useState('');

  const performStatusUpdate = async (newStatus, additionalData = {}) => {
    setUpdateStatusLoading(true);
    try {
      await updateOrderStatus(orderId, newStatus, additionalData);
      toast.success('Order status updated successfully');

      // Refresh order data
      setFetchAttempted(false);
      await fetchOrder();
    } catch (err) {
      console.error('Error updating order status:', err);
      toast.error('Failed to update order status: ' + (err.message || ''));
    } finally {
      setUpdateStatusLoading(false);
    }
  };

  const handleStatusUpdate = async (newStatus) => {
    // Shipping: capture a tracking number first (optional) so the email + order
    // doc carry it. Selecting 'shipped' opens the input; the confirm button fires.
    if (newStatus === 'shipped') {
      setTrackingNumber(order?.trackingNumber || '');
      setPendingShip(true);
      return;
    }
    await performStatusUpdate(newStatus);
  };

  const handleConfirmShip = async () => {
    const tn = (trackingNumber || '').trim();
    // Persist the tracking number onto the order doc AND pass it to the
    // status-update email via additionalData (the template supports it).
    await performStatusUpdate('shipped', tn ? { trackingNumber: tn } : {});
    setPendingShip(false);
  };

  const [refundLoading, setRefundLoading] = useState(false);
  const handleRefund = async () => {
    if (!window.confirm('Återbetala hela ordern? Detta kan inte ångras.')) return;
    setRefundLoading(true);
    try {
      // Server is Connect-aware: a destination-charge order is refunded with
      // transfer reversal + fee refund; a legacy order takes a plain refund.
      await httpsCallable(functions, 'refundOrder')({ orderId });
      toast.success('Ordern återbetalad');
      setFetchAttempted(false);
      await fetchOrder();
    } catch (err) {
      console.error('Refund failed:', err);
      toast.error('Återbetalning misslyckades: ' + (err.message || ''));
    } finally {
      setRefundLoading(false);
    }
  };

  const handleDeleteOrder = async () => {
    if (window.confirm('Are you sure you want to delete this order? This action cannot be undone.')) {
      setDeleteLoading(true);
      try {
        await deleteOrder(orderId);
        toast.success('Order deleted successfully');
        navigate('/admin/orders');
      } catch (err) {
        console.error('Error deleting order:', err);
        toast.error('Failed to delete order: ' + (err.message || ''));
      } finally {
        setDeleteLoading(false);
      }
    }
  };

  const handlePrintLabel = async () => {
    try {
      setPrintLoading(true);
      
      console.log('🏷️ Printing shipping label for order:', order.orderNumber || order.id);
      
      // Download the label HTML file for Preview app
      const labelData = await printShippingLabel(order, userData);
      
      toast.success(`Etikett nedladdad! Öppna HTML-filen i Preview app och tryck Cmd+P`);
    } catch (error) {
      console.error('❌ Failed to print label:', error);
      toast.error(`Kunde inte skriva ut etikett: ${error.message}`);
    } finally {
      setPrintLoading(false);
    }
  };



  // Simple print functionality that actually works
  const handlePrint = () => {
    // Create a simple print window with order data
    const printWindow = window.open('', '_blank', 'width=800,height=600');

    // P1-10: every customer-controlled string is escaped before interpolation —
    // a buyer-crafted name/address/note must render as TEXT in the admin's
    // print window, never as markup.
    const esc = escapeHtml;

    // Basic HTML template
    const printHTML = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Order_${esc(order.orderNumber || order.id)}</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; color: #333; }
          .header { border-bottom: 2px solid #333; margin-bottom: 20px; padding-bottom: 10px; }
          .title { font-size: 18px; font-weight: bold; margin-bottom: 5px; }
          .section { margin-bottom: 20px; padding: 15px; border: 1px solid #ddd; }
          .section-title { font-size: 14px; font-weight: bold; margin-bottom: 8px; }
          table { width: 100%; border-collapse: collapse; margin-top: 10px; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 12px; }
          th { background-color: #f8f9fa; font-weight: bold; }
          .text-right { text-align: right; }
          .font-bold { font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="title">Order ${esc(order.orderNumber || order.id)}</div>
        </div>

        <div class="section">
          <div class="section-title">Customer Information</div>
          <p><strong>Company:</strong> ${esc(displayUser.companyName)}</p>
          <p><strong>Contact:</strong> ${esc(displayUser.contactPerson)}</p>
          <p><strong>Email:</strong> ${esc(displayUser.email)}</p>
          <p><strong>Role:</strong> ${esc(displayUser.role)}</p>
        </div>

        <div class="section">
          <div class="section-title">Order Information</div>
          <p><strong>Date:</strong> ${esc(formatDate(order.createdAt))}</p>
          <p><strong>Status:</strong> ${esc(order.status)}</p>
          <p><strong>Payment Method:</strong> ${esc(formatPaymentMethodName(order.payment) || order.paymentMethod || 'Invoice')}</p>
          ${order.source ? `<p><strong>Source:</strong> ${order.source === 'b2c' ? 'B2C Shop' : 'B2B Portal'}</p>` : ''}
        </div>

        <div class="section">
          <div class="section-title">Delivery Address</div>
          <p><strong>Company:</strong> ${esc(displayAddress.company)}</p>
          <p><strong>Contact:</strong> ${esc(displayAddress.contactPerson)}</p>
          <p><strong>Address:</strong> ${esc(displayAddress.address)}</p>
        </div>

        <div class="section">
          <div class="section-title">Order Items</div>
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>Variant</th>
                <th>SKU</th>
                <th>Quantity</th>
                <th class="text-right">Price</th>
              </tr>
            </thead>
            <tbody>
              ${getEnhancedOrderDistribution(order).map(item => `
                <tr>
                  <td>${esc(item.name || 'Produkt')}</td>
                  <td>${esc(item.label || getDisplayColor(item.color))}</td>
                  <td>${esc(item.sku || getDisplaySize(item.size))}</td>
                  <td>${esc(item.quantity)} st</td>
                  <td class="text-right">${item.price ? item.price.toLocaleString('sv-SE', { minimumFractionDigits: 2 }) + ' kr' : (order.prisInfo?.produktPris ? order.prisInfo.produktPris.toLocaleString('sv-SE', { minimumFractionDigits: 2 }) + ' kr' : '')}</td>
                </tr>
              `).join('')}
            </tbody>
            <tfoot>
              <tr>
                <td colspan="4" class="text-right font-bold">Total:</td>
                <td class="text-right font-bold">${(order.total || order.prisInfo?.totalPris || 0).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} kr</td>
              </tr>
            </tfoot>
          </table>
        </div>

        ${order.note ? `
          <div class="section">
            <div class="section-title">Notes</div>
            <p>${esc(order.note)}</p>
          </div>
        ` : ''}
      </body>
      </html>
    `;

    printWindow.document.write(printHTML);
    printWindow.document.close();
    
    // Wait for window to load then print
    setTimeout(() => {
      printWindow.focus();
      printWindow.print();
      printWindow.close();
    }, 500);
  };

  if (loading) {
    return (
      <AppLayout>
        <Page title="Order" back={{ to: '/admin/orders', label: 'Ordrar' }}>
          <Card className="px-6 py-12 text-center">
            <div className="inline-block h-7 w-7 animate-spin rounded-full border-2 border-solid border-admin-text-muted border-r-transparent" />
            <p className="mt-3 text-[13px] text-admin-text-muted">Laddar order…</p>
          </Card>
        </Page>
      </AppLayout>
    );
  }

  if (error) {
    return (
      <AppLayout>
        <Page title="Order" back={{ to: '/admin/orders', label: 'Ordrar' }}>
          <Card className="px-6 py-12 text-center">
            <h2 className="text-base font-semibold text-admin-text">Ett fel uppstod</h2>
            <p className="mt-2 text-[13px] text-admin-text-muted">{error}</p>
            <div className="mt-5 flex justify-center gap-2">
              <Button variant="primary" onClick={handleRetry}>Försök igen</Button>
              <Button as={Link} to="/admin/orders" variant="secondary">Tillbaka till ordrar</Button>
            </div>
          </Card>
        </Page>
      </AppLayout>
    );
  }

  if (!order) {
    return (
      <AppLayout>
        <Page title="Order" back={{ to: '/admin/orders', label: 'Ordrar' }}>
          <Card className="px-6 py-12 text-center">
            <h2 className="text-base font-semibold text-admin-text">Order hittades inte</h2>
            <div className="mt-4">
              <Button as={Link} to="/admin/orders" variant="secondary">Tillbaka till ordrar</Button>
            </div>
          </Card>
        </Page>
      </AppLayout>
    );
  }



  // ── Derivations for the Shopify layout ──
  const sek = (n) =>
    (Number(n) || 0).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kr';
  const items = getEnhancedOrderDistribution(order);
  const isPickup = order.deliveryMethod === 'pickup';
  const isB2C = order.source === 'b2c';
  // Payment "paid" — mirrors the list/OrderConfirmation derivation.
  const paid = ['succeeded', 'paid'].includes(order.payment?.status) || order.status === 'confirmed';
  // New-shape orders (B2C + new B2B Faktura) carry subtotal/vat/total; legacy B2B
  // orders carry prisInfo. Prefer the new fields whenever present so B2B Faktura
  // totals render (not 0,00 kr).
  const hasNewShape = order.total != null;
  const subtotal = hasNewShape ? order.subtotal : order.prisInfo?.produktPris;
  const vat = hasNewShape ? order.vat : order.prisInfo?.moms;
  const total = hasNewShape ? order.total : order.prisInfo?.totalPris;
  const affiliateCode = order.affiliateCode || order.affiliate?.code;
  const affiliatePct =
    order.discountPercentage || order.affiliate?.discountPercentage || order.affiliateDiscount?.percentage || 0;

  const headerActions = (
    <>
      <Button variant="secondary" onClick={handlePrint}>
        <PrinterIcon className="h-4 w-4" />
        Skriv ut
      </Button>
      <Button
        variant="secondary"
        onClick={handlePrintLabel}
        disabled={printLoading}
        title="Laddar ner HTML-fil som öppnas i Preview app för enkel utskrift"
      >
        {printLoading ? (
          <span className="inline-flex items-center gap-2">
            <span className="h-4 w-4 animate-spin rounded-full border-b-2 border-current" />
            Laddar ner…
          </span>
        ) : (
          <>
            <ArrowDownTrayIcon className="h-4 w-4" />
            Ladda ner etikett
          </>
        )}
      </Button>
      <LabelPrintInstructions />
      {/* Order deletion is PLATFORM-only (P1-09: accounting records) — hide
          the button for shop admins instead of letting them hit a rules deny. */}
      {isPlatform && (
        <Button variant="destructive" onClick={handleDeleteOrder} disabled={deleteLoading}>
          <TrashIcon className="h-4 w-4" />
          {deleteLoading ? 'Tar bort…' : 'Ta bort'}
        </Button>
      )}
    </>
  );

  const statusPills = (
    <>
      {paid ? (
        <StatusPill tone="success">Betald</StatusPill>
      ) : isB2C ? (
        <StatusPill tone="warning">Väntar på betalning</StatusPill>
      ) : (
        <StatusPill tone="neutral">Faktura</StatusPill>
      )}
      <StatusPill tone={toneForOrderStatus(order.status)}>{getStatusInfo(order.status).text}</StatusPill>
    </>
  );

  const Row = ({ label, value, strong, accent }) => (
    <div className="flex items-baseline justify-between gap-4 py-1 text-[13px]">
      <span className={accent ? 'text-admin-success-text' : 'text-admin-text-muted'}>{label}</span>
      <span className={`tabular-nums ${strong ? 'font-semibold text-admin-text' : accent ? 'text-admin-success-text' : 'text-admin-text'}`}>{value}</span>
    </div>
  );

  return (
    <AppLayout>
      <Page
        title={`Order ${order.orderNumber || order.id}`}
        subtitle={formatDate(order.createdAt)}
        titleAdornment={<span className="flex items-center gap-1.5">{statusPills}</span>}
        back={{ to: '/admin/orders', label: 'Ordrar' }}
        actions={headerActions}
      >
        <RightRail
          main={
            <>
              {/* Fulfillment / items card */}
              <Card>
                <div className="flex items-center justify-between gap-3 border-b border-admin-border px-4 py-3">
                  <div className="flex items-center gap-2 text-[14px] font-semibold text-admin-text">
                    {isPickup ? <MapPinIcon className="h-4 w-4 text-admin-text-muted" /> : <TruckIcon className="h-4 w-4 text-admin-text-muted" />}
                    {isPickup
                      ? `Upphämtning${order.pickupLocation?.name ? ` · ${order.pickupLocation.name}` : ''}`
                      : 'Hemleverans'}
                  </div>
                  <div className="flex items-center gap-2">
                    {updateStatusLoading ? (
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-admin-text-muted border-r-transparent" />
                    ) : (
                      <OrderStatusMenu currentStatus={order.status} onStatusChange={handleStatusUpdate} source={order.source} isPickup={isPickup} />
                    )}
                    {paid && order.status !== 'refunded' && (
                      <Button variant="plain" disabled={refundLoading} onClick={handleRefund}>
                        {refundLoading ? 'Återbetalar…' : 'Återbetala'}
                      </Button>
                    )}
                  </div>
                </div>
                {pendingShip && (
                  <div className="border-b border-admin-border-soft px-4 py-3">
                    <label htmlFor="trackingNumber" className="mb-1 block text-[12px] font-medium text-admin-text-muted">
                      Spårningsnummer (valfritt)
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id="trackingNumber"
                        type="text"
                        value={trackingNumber}
                        onChange={(e) => setTrackingNumber(e.target.value)}
                        placeholder="t.ex. SE123456789"
                        className="min-w-0 flex-1 rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-3 py-1.5 text-[13px] text-admin-text placeholder:text-admin-text-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)]"
                        disabled={updateStatusLoading}
                      />
                      <Button variant="primary" disabled={updateStatusLoading} onClick={handleConfirmShip}>
                        {updateStatusLoading ? 'Skickar…' : 'Markera skickad'}
                      </Button>
                      <Button variant="plain" disabled={updateStatusLoading} onClick={() => setPendingShip(false)}>
                        Avbryt
                      </Button>
                    </div>
                  </div>
                )}
                {isPickup && (order.pickupLocation?.address || order.pickupLocation?.date) && (
                  <div className="border-b border-admin-border-soft px-4 py-2 text-[13px] text-admin-text-muted">
                    {order.pickupLocation?.address && <div>{order.pickupLocation.address}</div>}
                    {order.pickupLocation?.date && (
                      <div className="font-medium text-admin-text">
                        Upphämtningsdatum: {formatPickupDate(order.pickupLocation.date)}
                      </div>
                    )}
                  </div>
                )}
                <div className="divide-y divide-admin-border-soft">
                  {items.map((item, index) => (
                    <div key={index} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-admin-text">{getContentValue(item.name) || 'Produkt'}</div>
                        {(item.label || getDisplayColor(item.color) || item.sku || getDisplaySize(item.size)) && (
                          <div className="truncate text-[12px] text-admin-text-faint">
                            {[item.label || getDisplayColor(item.color), item.sku || getDisplaySize(item.size)]
                              .filter((x) => x && x !== '-')
                              .join(' · ')}
                          </div>
                        )}
                      </div>
                      <div className="whitespace-nowrap text-admin-text-muted tabular-nums">
                        {sek(item.price)} × {item.quantity}
                      </div>
                      <div className="w-24 text-right font-medium text-admin-text tabular-nums">
                        {sek(item.price * item.quantity)}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>

              {/* Payment summary card */}
              <Card>
                <div className="flex items-center gap-2 border-b border-admin-border px-4 py-3">
                  <h3 className="text-[14px] font-semibold text-admin-text">Betalning</h3>
                  {paid ? <StatusPill tone="success">Betald</StatusPill> : !isB2C ? <StatusPill tone="neutral">Faktura</StatusPill> : <StatusPill tone="warning">Väntar</StatusPill>}
                </div>
                <div className="px-4 py-3">
                  <Row label="Delsumma" value={sek(subtotal)} />
                  {isB2C && order.discountAmount > 0 && (
                    <Row
                      label={`Affiliate-rabatt (${affiliateCode || 'AFFILIATE'}), ${affiliatePct}%`}
                      value={`- ${sek(order.discountAmount)}`}
                      accent
                    />
                  )}
                  {isB2C && order.shipping > 0 && <Row label="Frakt" value={sek(order.shipping)} />}
                  <Row label="Moms (25%)" value={sek(vat)} />
                  <div className="mt-1 border-t border-admin-border-soft pt-2">
                    <Row label="Totalt" value={sek(total)} strong />
                  </div>
                </div>
              </Card>

              {/* Right-of-withdrawal proof (POD) — shown only for orders that had
                  a personalized item. Legal evidence that the buyer accepted the
                  no-withdrawal notice (or that it was missing). */}
              {order.withdrawal?.required && (
                <Card>
                  <div className="flex items-center gap-2 border-b border-admin-border px-4 py-3">
                    <h3 className="text-[14px] font-semibold text-admin-text">Ångerrätt (specialtillverkat)</h3>
                    <StatusPill tone={order.withdrawal.consent ? 'success' : 'danger'}>
                      {order.withdrawal.consent ? 'Godkänd' : 'Saknas'}
                    </StatusPill>
                  </div>
                  <div className="px-4 py-3">
                    <Row label="Kund godkände att ångerrätt ej gäller" value={order.withdrawal.consent ? 'Ja' : 'Nej'} />
                    {order.withdrawal.noticeVersion && <Row label="Textversion" value={order.withdrawal.noticeVersion} />}
                    {order.withdrawal.consentAt && <Row label="Tidpunkt" value={new Date(order.withdrawal.consentAt).toLocaleString('sv-SE')} />}
                    {order.withdrawal.noticeFingerprint && <Row label="Text-ID" value={order.withdrawal.noticeFingerprint} />}
                  </div>
                </Card>
              )}

              {/* Ångeranmälan — the consumer exercised the withdrawal function
                  (DAL 2 kap. 10 a §). The refund clock is statutory: repay
                  within 14 days of this timestamp. Use Återbetala above. */}
              {order.withdrawalRequest?.status === 'received' && (
                <Card>
                  <div className="flex items-center gap-2 border-b border-admin-border px-4 py-3">
                    <h3 className="text-[14px] font-semibold text-admin-text">Ångeranmälan</h3>
                    <StatusPill tone={order.status === 'refunded' ? 'success' : 'warning'}>
                      {order.status === 'refunded' ? 'Återbetald' : 'Mottagen — återbetala inom 14 dagar'}
                    </StatusPill>
                  </div>
                  <div className="px-4 py-3">
                    <Row
                      label="Mottagen"
                      value={order.withdrawalRequest.submittedAtIso
                        ? new Date(order.withdrawalRequest.submittedAtIso).toLocaleString('sv-SE')
                        : '—'}
                    />
                    {order.withdrawalRequest.name && <Row label="Namn" value={order.withdrawalRequest.name} />}
                    {order.withdrawalRequest.contactEmail && <Row label="E-post" value={order.withdrawalRequest.contactEmail} />}
                    {Number.isFinite(order.withdrawalRequest.orderAgeDaysAtSubmission) && (
                      <Row label="Orderålder vid anmälan" value={`${order.withdrawalRequest.orderAgeDaysAtSubmission} dagar`} />
                    )}
                    {order.withdrawalRequest.channel && (
                      <Row
                        label="Kanal"
                        value={order.withdrawalRequest.channel === 'account' ? 'Kundkonto' : 'Ångerfunktionen (publik)'}
                      />
                    )}
                    {order.withdrawalRequest.statementContent && (
                      <p className="mt-2 text-[12px] text-admin-text-muted">{order.withdrawalRequest.statementContent}</p>
                    )}
                  </div>
                </Card>
              )}

              {/* Dispute / chargeback (shown only when a dispute exists).
                  For a destination charge the platform balance is debited; the
                  webhook reverses the transfer to recover from the shop and
                  stamps the recovery status here so the admin can reconcile. */}
              {order.disputeStatus && (
                <Card>
                  <div className="flex items-center gap-2 border-b border-admin-border px-4 py-3">
                    <h3 className="text-[14px] font-semibold text-admin-text">Tvist / Återkrav</h3>
                    <StatusPill tone={DISPUTE_TONE[order.disputeStatus] || 'warning'}>
                      {DISPUTE_LABEL[order.disputeStatus] || order.disputeStatus}
                    </StatusPill>
                  </div>
                  <div className="px-4 py-3">
                    {order.disputeId && <Row label="Tvist-ID" value={order.disputeId} />}
                    {order.connect?.disputeRecoveryStatus && (
                      <Row
                        label="Återhämtning"
                        value={RECOVERY_LABEL[order.connect.disputeRecoveryStatus] || order.connect.disputeRecoveryStatus}
                      />
                    )}
                    {Number.isFinite(order.connect?.disputeReversedAmount) && order.connect.disputeReversedAmount > 0 && (
                      <Row label="Återförd överföring" value={sek(order.connect.disputeReversedAmount / 100)} />
                    )}
                    {order.connect?.disputeRecoveryError && (
                      <p className="mt-2 text-[12px] text-red-600">{order.connect.disputeRecoveryError}</p>
                    )}
                  </div>
                </Card>
              )}

              {/* Notes */}
              {order.note && (
                <CardSection title="Anteckningar">
                  <p className="text-[13px] text-admin-text">{order.note}</p>
                </CardSection>
              )}

              {/* Status history (real data) */}
              {order.statusHistory && order.statusHistory.length > 0 && (
                <CardSection title="Statushistorik" bodyClassName="space-y-2">
                  {order.statusHistory.map((history, index) => (
                    <div key={index} className="flex items-center justify-between gap-3 text-[13px]">
                      <div className="flex flex-wrap items-center gap-1.5 text-admin-text-muted">
                        <StatusPill tone={toneForOrderStatus(history.from)}>{getStatusInfo(history.from).text}</StatusPill>
                        <span>→</span>
                        <StatusPill tone={toneForOrderStatus(history.to)}>{getStatusInfo(history.to).text}</StatusPill>
                        {history.displayName && <span className="text-admin-text-faint">· {history.displayName}</span>}
                      </div>
                      <div className="whitespace-nowrap text-[12px] text-admin-text-faint">
                        {history.changedAt ? formatDate(history.changedAt) : '—'}
                      </div>
                    </div>
                  ))}
                </CardSection>
              )}
            </>
          }
          rail={
            <>
              {/* Customer */}
              <CardSection title="Kund" bodyClassName="space-y-2 text-[13px]">
                <div>
                  <div className="font-medium text-admin-text">{displayUser.companyName}</div>
                  {displayUser.contactPerson && displayUser.contactPerson !== displayUser.companyName && (
                    <div className="text-admin-text-muted">{displayUser.contactPerson}</div>
                  )}
                </div>
                <div>
                  <div className="text-[11px] font-medium uppercase tracking-wide text-admin-text-faint">E-post</div>
                  <div className="break-words text-admin-text">{displayUser.email}</div>
                </div>
                {displayUser.phone && displayUser.phone !== 'Not specified' && (
                  <div>
                    <div className="text-[11px] font-medium uppercase tracking-wide text-admin-text-faint">Telefon</div>
                    <div className="text-admin-text">{displayUser.phone}</div>
                  </div>
                )}
                <div>
                  <div className="text-[11px] font-medium uppercase tracking-wide text-admin-text-faint">Leveransadress</div>
                  <div className="text-admin-text">{displayAddress.address}</div>
                </div>
                {!isB2C && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-admin-text-muted">Konto:</span>
                    <StatusPill tone={displayUser.active ? 'success' : 'danger'}>
                      {displayUser.active ? 'Aktiv' : 'Inaktiv'}
                    </StatusPill>
                  </div>
                )}
              </CardSection>

              {/* Order info + attribution (affiliate/referrer moved here per slice 1c plan) */}
              <CardSection title="Orderinformation" bodyClassName="space-y-2 text-[13px]">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-admin-text-muted">Kanal</span>
                  <span className="text-admin-text">{isB2C ? 'Webbshop' : 'Återförsäljare'}</span>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-admin-text-muted">Betalsätt</span>
                  <span className="text-right text-admin-text">{formatPaymentMethodName(order.payment) || order.paymentMethod || 'Faktura'}</span>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-admin-text-muted">Leverans</span>
                  <span className="text-admin-text">{isPickup ? 'Upphämtning' : 'Hemleverans'}</span>
                </div>
                {affiliateCode && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-admin-text-muted">Affiliate</span>
                    <span className="inline-flex items-center gap-1.5">
                      <StatusPill tone="info" marker="none">{affiliateCode}</StatusPill>
                      {affiliatePct ? <span className="text-[12px] text-admin-text-faint">{affiliatePct}%</span> : null}
                    </span>
                  </div>
                )}
              </CardSection>
            </>
          }
        />
      </Page>
    </AppLayout>
  );
};

export default AdminOrderDetail; 