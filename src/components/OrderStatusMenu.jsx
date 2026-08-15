import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from '../contexts/TranslationContext';

const getStatusStyles = (status) => {
  switch (status) {
    case 'pending':
      return 'bg-yellow-100 text-yellow-800 border-yellow-200'; // Waiting for confirmation
    case 'confirmed':
      return 'bg-blue-100 text-blue-800 border-blue-200'; // Confirmed
    case 'processing':
      return 'bg-orange-100 text-orange-800 border-orange-200'; // Processing
    case 'printed':
      return 'bg-purple-100 text-purple-800 border-purple-200'; // POD: printer marked as printed (display-only, set by the print shop)
    case 'shipped':
      return 'bg-green-100 text-green-800 border-green-200'; // Shipped - GREEN for quick visual identification
    case 'delivered':
      return 'bg-emerald-100 text-emerald-800 border-emerald-200'; // Delivered - Darker green
    case 'ready_for_pickup':
      return 'bg-purple-100 text-purple-800 border-purple-200'; // Click & Collect: ready to be picked up
    // B2B Faktura lifecycle (additive — B2C orders simply never use these)
    case 'invoiced':
      return 'bg-indigo-100 text-indigo-800 border-indigo-200'; // Invoice sent by the shop
    case 'paid':
      return 'bg-teal-100 text-teal-800 border-teal-200'; // Payment received
    case 'completed':
      return 'bg-emerald-100 text-emerald-800 border-emerald-200'; // Done
    case 'cancelled':
      return 'bg-red-100 text-red-800 border-red-200'; // Cancelled
    case 'refunded':
      return 'bg-rose-100 text-rose-800 border-rose-200'; // Refunded (set by the refund flow, not selectable)
    case 'partially_refunded':
      return 'bg-orange-100 text-orange-800 border-orange-200'; // Part of the charge refunded; order still live
    default:
      return 'bg-gray-100 text-gray-800 border-gray-200'; // Unknown status
  }
};

const OrderStatusMenu = ({ currentStatus, onStatusChange, disabled, className = '', source, isPickup = false }) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);

  // Status options with shorter labels. B2B Faktura orders use the invoice
  // lifecycle (pending → invoiced → paid → shipped → completed); everything else
  // uses the consumer lifecycle. Source-aware so each surface shows the right set.
  // Click & Collect orders additionally expose 'ready_for_pickup'.
  const statusOptions = source === 'b2b'
    ? [
        { value: 'pending', label: t('order_status.pending', 'Väntar') },
        { value: 'invoiced', label: t('order_status.invoiced', 'Fakturerad') },
        { value: 'paid', label: t('order_status.paid', 'Betald') },
        ...(isPickup ? [{ value: 'ready_for_pickup', label: t('order_status.ready_for_pickup', 'Redo att hämtas') }] : []),
        { value: 'shipped', label: t('order_status.shipped', 'Skickad') },
        { value: 'completed', label: t('order_status.completed', 'Slutförd') },
        { value: 'cancelled', label: t('order_status.cancelled', 'Avbruten') }
      ]
    : [
        { value: 'pending', label: t('order_status.pending', 'Väntar') },
        { value: 'confirmed', label: t('order_status.confirmed', 'Bekräftad') },
        { value: 'processing', label: t('order_status.processing', 'Behandlas') },
        ...(isPickup ? [{ value: 'ready_for_pickup', label: t('order_status.ready_for_pickup', 'Redo att hämtas') }] : []),
        { value: 'shipped', label: t('order_status.shipped', 'Skickad') },
        { value: 'delivered', label: t('order_status.delivered', 'Levererad') },
        { value: 'cancelled', label: t('order_status.cancelled', 'Avbruten') }
      ];

  // Get current status label. 'refunded' is display-only: it's set by the
  // refund flow (which moves real money) and deliberately NOT offered as a
  // selectable option in the menu.
  const getCurrentStatusLabel = () => {
    if (currentStatus === 'refunded') return t('order_status.refunded', 'Återbetald');
    // 'partially_refunded' is likewise set by the (cumulative) refund flow —
    // display-only, never selectable.
    if (currentStatus === 'partially_refunded') return t('order_status.partially_refunded', 'Delvis återbetald');
    // 'printed' is set by the print shop, not selectable in the admin menu — show
    // its label so the pill reads "Tryckt" instead of falling through to "Okänd".
    if (currentStatus === 'printed') return t('order_status.printed', 'Tryckt');
    const status = statusOptions.find(option => option.value === currentStatus);
    return status ? status.label : t('order_status.unknown', 'Okänd');
  };

  // Handle click outside to close menu
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Handle status change
  const handleStatusSelect = (statusValue) => {
    onStatusChange(statusValue);
    setIsOpen(false);
  };

  return (
    <div className={`relative inline-block ${className}`} ref={menuRef}>
      <button
        type="button"
        disabled={disabled}
        className={`inline-flex w-32 justify-center items-center px-4 py-1 text-xs font-medium rounded-md ${
          getStatusStyles(currentStatus)
        } ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-80'}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <span className="mr-1">{getCurrentStatusLabel()}</span>
        <svg
          className="w-4 h-4"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute right-0 z-10 mt-1 w-40 origin-top-right rounded-md bg-white shadow-lg ring-1 ring-black/5 focus:outline-hidden">
          <div className="py-1">
            {statusOptions.map((option) => (
              <button
                key={option.value}
                className={`flex items-center w-full px-3 py-1.5 text-xs ${
                  option.value === currentStatus
                    ? getStatusStyles(option.value)
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
                onClick={() => handleStatusSelect(option.value)}
              >
                {option.value === currentStatus && (
                  <svg className="h-3 w-3 mr-1.5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                )}
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default OrderStatusMenu; 