import React, { useState, useEffect } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { getOrder, loadPendingCheckout, loadReceiptToken } from '../../api/orders';
import { useReceiptPoll } from '../../api/useReceiptPoll';
import { confirmationSource, toPageOrder } from '../../storefront/adapters/order';
import { CheckCircleIcon, ShoppingBagIcon, TruckIcon, EnvelopeIcon } from '@heroicons/react/24/outline';
import { useTranslation } from '../../contexts/TranslationContext';
import { useContentTranslation } from '../../hooks/useContentTranslation';
import ShopNavigation from '../../components/shop/ShopNavigation';
import ShopFooter from '../../components/shop/ShopFooter';
import { format } from 'date-fns';
import { sv } from 'date-fns/locale';
import { toast } from 'react-hot-toast';
import SeoHreflang from '../../components/shop/SeoHreflang';
import { getCountryAwareUrl } from '../../utils/productUrls';
import { getEnhancedOrderDistribution, getDisplayColor, getDisplaySize } from '../../utils/orderUtils';
import { STORE } from '../../config/store';
import { formatPickupDate } from '../../utils/pickupDates';

const OrderConfirmation = () => {
  const { orderId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { getContentValue } = useContentTranslation();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [waitTimedOut, setWaitTimedOut] = useState(false);

  // Get order number from navigation state for immediate display while fetching full order
  const orderNumberFromState = location.state?.orderNumber;

  // Orders are created server-side when the payment provider confirms the
  // payment, usually within a couple of seconds. The address names either
  //   - the payment this tab just made: the tab holds its checkout (session
  //     storage), and the receipt poll asks for the order every 2 s for at
  //     most 90 s; when it is there, the address becomes the order's; or
  //   - an order whose receipt token this tab holds: the order is read with it.
  // The token lives in this tab's session storage only (src/api/orders.js).
  const source = confirmationSource(orderId, { loadReceiptToken, loadPendingCheckout });
  const receipt = useReceiptPoll(source.kind === 'checkout' ? source.checkoutId : null);

  useEffect(() => {
    if (!orderId) {
      setLoading(false);
      toast.error(t('order_confirmation_no_id', 'Ingen order ID hittades.'));
      navigate(getCountryAwareUrl(''));
      return undefined;
    }

    // GET /v1/orders/:id with the receipt token: the buyer's order, or null.
    const readOrder = (id, token) => {
      setLoading(true);
      setWaitTimedOut(false);
      const controller = new AbortController();
      getOrder(id, token, { signal: controller.signal }).then(
        (found) => {
          if (controller.signal.aborted) return;
          setOrder(toPageOrder(found));
          setLoading(false);
        },
        (error) => {
          if (controller.signal.aborted) return;
          console.error('Error fetching order:', error?.code);
          toast.error(t('order_confirmation_fetch_error', 'Ett fel uppstod när din beställning skulle hämtas.'));
          setLoading(false);
        }
      );
      return () => controller.abort();
    };

    if (source.kind === 'order') return readOrder(source.orderId, source.token);

    if (source.kind === 'none') {
      setLoading(false);
      return undefined;
    }

    // The receipt poll of this tab's checkout.
    if (receipt.status === 'ready') {
      // The order exists. With its token kept for this tab, read it at its own
      // address (a reload then reads it again); if the tab could not keep it,
      // read it this once with the token in hand.
      if (loadReceiptToken(receipt.orderId)) {
        navigate(getCountryAwareUrl(`order-confirmation/${receipt.orderId}`), { replace: true });
        return undefined;
      }
      return readOrder(receipt.orderId, receipt.receiptToken);
    } else if (receipt.status === 'timeout' || receipt.status === 'issued') {
      // Paid, and no order yet within 90 s — or its receipt went to another
      // tab: never a success and never a failure.
      setWaitTimedOut(true);
      setLoading(false);
    } else if (receipt.status === 'error') {
      console.error('Error fetching order:', receipt.error?.code);
      toast.error(t('order_confirmation_fetch_error', 'Ett fel uppstod när din beställning skulle hämtas.'));
      setLoading(false);
    }
    return undefined;
    // `t` is left out: a new function on a render must not read the order again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, navigate, source.kind, source.orderId, source.token, receipt.status, receipt.orderId]);

  const formatPrice = (price) => {
    if (typeof price !== 'number') return 'N/A';
    return new Intl.NumberFormat('sv-SE', {
      style: 'currency',
      currency: 'SEK',
    }).format(price);
  };
  
  const formattedDate = order?.createdAt?.seconds 
    ? format(new Date(order.createdAt.seconds * 1000), 'd MMMM yyyy, HH:mm', { locale: sv }) 
    : t('order_confirmation_processing', 'Bearbetar...');

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <ShopNavigation breadcrumb={t('breadcrumb_order_confirmation', 'Orderbekräftelse')} />
        <div className="max-w-2xl mx-auto px-4 py-16 text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">{t('order_confirmation_preparing', 'Din betalning är genomförd — vi förbereder din orderbekräftelse...')}</p>
        </div>
        <ShopFooter />
      </div>
    );
  }

  if (!order) {
    return (
      <div className="min-h-screen bg-gray-50">
        <ShopNavigation breadcrumb={t('breadcrumb_order_confirmation', 'Orderbekräftelse')} />
        <div className="max-w-2xl mx-auto px-4 py-16 text-center">
          <h1 className="text-2xl font-bold text-gray-900 mb-4">
            {waitTimedOut
              ? t('order_confirmation_delayed_title', 'Din beställning behandlas')
              : t('order_confirmation_not_found_title', 'Order hittades inte')}
          </h1>
          <p className="text-gray-600 mb-8">
            {waitTimedOut
              ? t('order_confirmation_delayed_description', 'Din betalning är genomförd och beställningen registreras. Du får en orderbekräftelse via e-post inom kort.')
              : t('order_confirmation_not_found_description', 'Vi kunde inte hitta den begärda ordern.')}
          </p>
          <button
            onClick={() => navigate(getCountryAwareUrl(''))}
            className="bg-blue-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-blue-700 transition-colors"
          >
            {t('order_confirmation_back_to_shop', 'Tillbaka till butiken')}
          </button>
        </div>
        <ShopFooter />
      </div>
    );
  }

  return (
    <>
      <SeoHreflang />
      <div className="min-h-screen bg-linear-to-br from-slate-50 via-blue-50 to-indigo-50">
        <ShopNavigation breadcrumb={t('breadcrumb_order_confirmation', 'Orderbekräftelse')} />
        
        <div className="max-w-4xl mx-auto px-4 py-8">
          
          {/* Success Header */}
          <div className="text-center mb-12">
            <div className="mx-auto flex items-center justify-center h-16 w-16 rounded-full bg-green-100 mb-6">
              <CheckCircleIcon className="h-8 w-8 text-green-600" />
            </div>
            <h1 className="text-3xl font-bold text-gray-900 mb-2">
              {t('order_confirmation_thank_you', 'Tack för din beställning!')}
            </h1>
            <p className="text-lg text-gray-600">
              {t('order_confirmation_received', 'Din beställning har tagits emot och kommer att behandlas inom kort.')}
            </p>
            <div className="mt-4 p-4 bg-blue-50 rounded-lg inline-block">
              <p className="text-sm text-blue-800">
                <strong>{t('order_confirmation_order_number', 'Ordernummer:')} </strong> 
                {order.orderNumber || orderNumberFromState}
              </p>
              <p className="text-sm text-blue-600">
                {t('order_confirmation_ordered', 'Beställd:')}: {formattedDate}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            
            {/* Order Details */}
            <div className="lg:col-span-2 space-y-6">
              
              {/* Customer Information */}
              <div className="bg-white rounded-xl p-6 shadow-xs border border-gray-200">
                <h2 className="text-xl font-semibold text-gray-900 mb-4">
                  {t('order_confirmation_customer_info', 'Kunduppgifter')}
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <h3 className="font-medium text-gray-900 mb-2">
                      {t('order_confirmation_contact_info', 'Kontaktinformation')}
                    </h3>
                    <p className="text-gray-600">{order.customerInfo?.email}</p>
                    {order.customerInfo?.marketingOptIn && (
                      <p className="text-sm text-green-600 mt-1">
                        {t('order_confirmation_newsletter_subscription', '✓ Prenumererar på nyhetsbrev')}
                      </p>
                    )}
                  </div>
                  <div>
                    <h3 className="font-medium text-gray-900 mb-2">
                      {order.deliveryMethod === 'pickup'
                        ? t('order_confirmation_pickup', 'Upphämtning')
                        : t('order_confirmation_shipping_address', 'Leveransadress')}
                    </h3>
                    <div className="text-gray-600">
                      {(() => {
                        const addr = order.shippingInfo || order.shippingAddress || {};
                        const firstName = order.customerInfo?.firstName || addr.firstName;
                        const lastName = order.customerInfo?.lastName || addr.lastName;
                        // Pickup order: show the chosen location, not an (empty) address.
                        if (order.deliveryMethod === 'pickup') {
                          const loc = order.pickupLocation || {};
                          return (
                            <>
                              <p>{firstName} {lastName}</p>
                              {loc.name && <p className="font-medium">{loc.name}</p>}
                              {loc.address && <p>{loc.address}</p>}
                              {loc.date && (
                                <p className="mt-1">
                                  {t('order_confirmation_pickup_date', 'Upphämtningsdatum')}: {formatPickupDate(loc.date)}
                                </p>
                              )}
                            </>
                          );
                        }
                        // Orders store the address in shippingInfo (name lives in customerInfo);
                        // fall back to the legacy shippingAddress shape for old orders
                        return (
                          <>
                            <p>{firstName} {lastName}</p>
                            <p>{addr.address}</p>
                            {addr.apartment && <p>{addr.apartment}</p>}
                            <p>{addr.postalCode} {addr.city}</p>
                            <p>{addr.country}</p>
                          </>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              </div>

              {/* Order Items */}
              <div className="bg-white rounded-xl p-6 shadow-xs border border-gray-200">
                <h2 className="text-xl font-semibold text-gray-900 mb-4">
                  {t('order_confirmation_order_contents', 'Orderinnehåll')}
                </h2>
                <div className="space-y-4">
                  {getEnhancedOrderDistribution(order).map((item, index) => {
                    const itemName = getContentValue(item.name);
                    return (
                      <div key={index} className="flex items-center space-x-4 py-3 border-b border-gray-100 last:border-b-0">
                        <div className="w-16 h-16 bg-gray-100 rounded-lg flex items-center justify-center">
                          {item.image ? (
                            <img src={item.image} alt={itemName} className="w-full h-full object-cover rounded-lg" />
                          ) : (
                            <ShoppingBagIcon className="h-8 w-8 text-gray-400" />
                          )}
                        </div>
                        <div className="flex-1">
                          <h3 className="font-medium text-gray-900">{itemName}</h3>
                          <p className="text-sm text-gray-500">
                            {t('order_confirmation_quantity', 'Antal: {{quantity}}', { quantity: item.quantity })}
                          </p>
                          {/* Variant label (v2); color/size kept for old orders. */}
                          <div className="text-sm text-gray-500 space-x-2">
                            {item.label && (
                              <span className="inline-block bg-gray-100 px-2 py-1 rounded-full text-xs">{item.label}</span>
                            )}
                            {!item.label && item.color && (
                              <span className="inline-block bg-gray-100 px-2 py-1 rounded-full text-xs">
                                {t('order_confirmation_color', 'Färg: {{color}}', { color: getDisplayColor(item.color) })}
                              </span>
                            )}
                            {!item.label && item.size && (
                              <span className="inline-block bg-gray-100 px-2 py-1 rounded-full text-xs">
                                {t('order_confirmation_size', 'Storlek: {{size}}', { size: getDisplaySize(item.size) })}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="font-medium text-gray-900">
                          {formatPrice(item.price * item.quantity)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Affiliate Information (if applicable) */}
              {(() => {
                const affiliateCode = order.affiliateCode || order.affiliate?.code;
                const discountPercentage = order.discountPercentage || order.affiliate?.discountPercentage || order.affiliateDiscount?.percentage;
                const discountAmount = order.discountAmount || order.affiliate?.amount || order.affiliateDiscount?.amount;
                
                return affiliateCode && (
                  <div className="bg-green-50 border border-green-200 rounded-xl p-6">
                    <h2 className="text-xl font-semibold text-green-800 mb-4">
                      {t('order_confirmation_affiliate_applied', '🎉 Affiliate-rabatt tillämpad')}
                    </h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <p className="text-sm text-green-700 font-medium">
                          {t('order_confirmation_affiliate_code', 'Affiliate-kod')}
                        </p>
                        <p className="text-green-900 font-semibold">{affiliateCode}</p>
                      </div>
                      {(discountPercentage || discountAmount) && (
                        <div>
                          <p className="text-sm text-green-700 font-medium">
                            {t('order_confirmation_discount', 'Rabatt')}
                          </p>
                          <p className="text-green-900 font-semibold">
                            {discountPercentage}% ({formatPrice(discountAmount)})
                          </p>
                        </div>
                      )}
                    </div>
                    <div className="mt-4 p-3 bg-white rounded-lg border border-green-200">
                      <p className="text-sm text-green-800">
                        <strong>{t('order_confirmation_tracking_status', 'Spårningsstatus:')}</strong> {' '}
                        {t('order_confirmation_affiliate_tracking_description', 'Denna beställning har registrerats för affiliate-provision. Affiliate-partnern kommer att få kredit för denna försäljning.')}
                      </p>
                    </div>
                  </div>
                );
              })()}

              {/* Next Steps */}
              <div className="bg-white rounded-xl p-6 shadow-xs border border-gray-200">
                <h2 className="text-xl font-semibold text-gray-900 mb-4">
                  {t('order_confirmation_next_steps', 'Nästa steg')}
                </h2>
                <div className="space-y-4">
                  <div className="flex items-start space-x-3">
                    <EnvelopeIcon className="h-6 w-6 text-blue-600 mt-1" />
                    <div>
                      <h3 className="font-medium text-gray-900">
                        {t('order_confirmation_email_confirmation', 'Orderbekräftelse via e-post')}
                      </h3>
                      <p className="text-sm text-gray-600">
                        {t('order_confirmation_email_sent', 'En bekräftelse har skickats till {{email}}', { 
                          email: order.customerInfo?.email 
                        })}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start space-x-3">
                    <TruckIcon className="h-6 w-6 text-blue-600 mt-1" />
                    <div>
                      <h3 className="font-medium text-gray-900">
                        {t('order_confirmation_shipping_updates', 'Leveransuppdateringar')}
                      </h3>
                      <p className="text-sm text-gray-600">
                        {t('order_confirmation_shipping_updates_description', 'Du kommer att få uppdateringar när din beställning skickas')}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Order Summary Sidebar */}
            <div className="lg:sticky lg:top-8 lg:h-fit">
              <div className="bg-white rounded-xl p-6 shadow-xs border border-gray-200">
                <h2 className="text-xl font-semibold text-gray-900 mb-6">
                  {t('order_confirmation_order_summary', 'Ordersammanfattning')}
                </h2>
                
                <div className="space-y-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">{t('order_confirmation_subtotal', 'Delsumma')}</span>
                    <span className="font-medium">{formatPrice(order.subtotal)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">{t('order_confirmation_shipping', 'Frakt')}</span>
                    <span className="font-medium">{formatPrice(order.shipping)}</span>
                  </div>
                  {order.discountAmount > 0 && (
                    <div className="flex justify-between text-sm text-green-600">
                      <span className="font-medium">
                        {(() => {
                          // Handle different affiliate data structures
                          const affiliateCode = order.affiliateCode || order.affiliate?.code || 'AFFILIATE';
                          const discountPercentage = order.discountPercentage || order.affiliate?.discountPercentage || order.affiliateDiscount?.percentage || 0;
                          
                          return t('order_confirmation_discount_with_code', 'Rabatt ({{affiliateCode}}) {{discountPercentage}}%', { 
                            affiliateCode, 
                            discountPercentage 
                          });
                        })()}
                      </span>
                      <span className="font-medium">- {formatPrice(order.discountAmount)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">{t('order_confirmation_vat_rate', 'Moms ({{rate}}%)', { rate: Math.round(STORE.vatRate * 100) })}</span>
                    <span className="font-medium">{formatPrice(order.vat)}</span>
                  </div>
                  <div className="flex justify-between font-bold text-lg text-gray-900 pt-3 border-t border-gray-300">
                    <span>{t('order_confirmation_total', 'Totalt')}</span>
                    <span>{formatPrice(order.total)}</span>
                  </div>
                </div>

                <div className="mt-6 pt-6 border-t border-gray-200">
                  <div className="text-center">
                    <p className="text-sm text-gray-600 mb-4">
                      {t('order_confirmation_payment_status', 'Betalningsstatus')}
                    </p>
                    {(() => {
                      const isPaid = ['succeeded', 'paid'].includes(order.payment?.status) || order.status === 'confirmed';
                      return isPaid ? (
                        <div className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-green-100 text-green-800">
                          {t('order_confirmation_payment_paid', 'Betald')}
                        </div>
                      ) : (
                        <div className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-yellow-100 text-yellow-800">
                          {t('order_confirmation_payment_pending', 'Väntar på betalning')}
                        </div>
                      );
                    })()}
                  </div>
                </div>

                <div className="mt-6 space-y-3">
                  <button
                    onClick={() => navigate(getCountryAwareUrl(''))}
                    className="w-full bg-blue-600 text-white px-4 py-3 rounded-lg font-semibold hover:bg-blue-700 transition-colors"
                  >
                    {t('order_confirmation_continue_shopping', 'Fortsätt handla')}
                  </button>
                </div>

                {/* Ångerfunktionen (DAL 2 kap. 10 a §): point the buyer to the
                    statutory "ångra avtalet här" function, prefilled with this
                    order's number — works for guest purchases too. */}
                <p className="mt-4 text-center text-xs text-gray-500">
                  {t('order_confirmation_withdrawal_prefix', 'Du har normalt 14 dagars ångerrätt.')}{' '}
                  <button
                    type="button"
                    onClick={() => navigate(getCountryAwareUrl(`angra?order=${encodeURIComponent(order.orderNumber || '')}`))}
                    className="underline text-gray-600 hover:text-gray-900"
                  >
                    {t('order_confirmation_withdrawal_link', 'Ångra avtalet här')}
                  </button>
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <ShopFooter />
    </>
  );
};

export default OrderConfirmation; 