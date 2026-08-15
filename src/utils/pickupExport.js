/**
 * Pickup Export Utility (Delivery & Pickup v2)
 *
 * Produces an operational PICKLIST CSV of pickup (Click & Collect) orders,
 * grouped by pickup location then by pickup date, so a shop fulfilling pickups
 * can scan "what to prepare for Location X on date Y". Separate from the
 * accounting-focused orderExport.js (different audience + columns).
 *
 * Grouping: orders are sorted location → date → order number, and a blank
 * separator row is emitted between date blocks so each date stands out.
 */

import { formatPickupDate } from './pickupDates';

// Reuse the multilingual product-name resolution shape used across the app.
const getProductName = (nameField) => {
  if (!nameField) return 'Produkt';
  if (typeof nameField === 'string') return nameField;
  if (typeof nameField === 'object') {
    return (
      nameField['sv-SE'] || nameField['sv'] ||
      nameField['en-GB'] || nameField['en-US'] || nameField['en'] ||
      Object.values(nameField)[0] || 'Produkt'
    );
  }
  return 'Produkt';
};

// Compact "2× Gravad Lax (Small); 1× Rom" item summary for the picklist.
const formatItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) return '';
  return items
    .map((item) => {
      const name = getProductName(item.name || item.productName);
      const qty = item.quantity || 0;
      const label = item.label || item.size || item.color || '';
      return `${qty}× ${name}${label ? ` (${label})` : ''}`;
    })
    .join('; ');
};

const STATUS_LABELS = {
  pending: 'Väntar',
  confirmed: 'Bekräftad',
  processing: 'Behandlas',
  shipped: 'Skickad',
  ready_for_pickup: 'Redo att hämtas',
  delivered: 'Levererad',
  cancelled: 'Avbruten',
  refunded: 'Återbetald',
  partially_refunded: 'Delvis återbetald',
};
const statusLabel = (s) => STATUS_LABELS[s] || s || 'Okänd';

const customerName = (order) => {
  const ci = order.customerInfo || {};
  const n = `${ci.firstName || ''} ${ci.lastName || ''}`.trim();
  return n || ci.name || ci.email || '';
};

// Order-date for display in the picklist (handles the common shapes).
const orderDate = (order) => {
  const v = order.createdAt;
  try {
    if (v && typeof v.toDate === 'function') return v.toDate().toISOString().slice(0, 10);
    if (v && v.seconds) return new Date(v.seconds * 1000).toISOString().slice(0, 10);
    if (typeof v === 'string') return v.slice(0, 10);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  } catch {
    /* fall through */
  }
  return '';
};

const csvField = (field) => {
  const s = String(field ?? '');
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
};

const triggerDownload = (csvContent, filename) => {
  const blob = new Blob(['﻿' + csvContent], { type: 'text/csv;charset=utf-8;' }); // BOM for Excel
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

/**
 * Export pickup orders to a picklist CSV, grouped by location then date.
 * @param {Array} orders  the orders to consider (already filtered by the page's
 *                        active filters); non-pickup orders are skipped.
 * @param {object} options { filename? }
 * @returns {{success:boolean, message:string, count:number}}
 */
export const exportPickupOrdersToCSV = (orders, options = {}) => {
  try {
    const pickupOrders = (orders || []).filter((o) => o.deliveryMethod === 'pickup');
    if (pickupOrders.length === 0) {
      return { success: false, message: 'Inga upphämtningsordrar att exportera', count: 0 };
    }

    // Sort by location name, then date (empty dates last), then order number, so
    // each location's dates form contiguous, scannable blocks.
    const keyOf = (o) => ({
      loc: (o.pickupLocation?.name || '').toLowerCase(),
      date: o.pickupLocation?.date || '9999-99-99', // dateless → end of the block
      num: o.orderNumber || o.id || '',
    });
    const sorted = [...pickupOrders].sort((a, b) => {
      const ka = keyOf(a);
      const kb = keyOf(b);
      return ka.loc.localeCompare(kb.loc, 'sv') ||
        ka.date.localeCompare(kb.date) ||
        String(ka.num).localeCompare(String(kb.num), 'sv');
    });

    const headers = [
      'Upphämtningsplats',
      'Upphämtningsdatum',
      'Ordernummer',
      'Orderdatum',
      'Kund',
      'E-post',
      'Telefon',
      'Produkter',
      'Antal artiklar',
      'Totalt (kr)',
      'Status',
    ];

    const rows = [];
    let prevLoc = null;
    let prevDate = null;
    for (const o of sorted) {
      const loc = o.pickupLocation?.name || '(plats saknas)';
      const dateRaw = o.pickupLocation?.date || '';
      // Blank separator row between date blocks (and between locations).
      if (prevLoc !== null && (loc !== prevLoc || dateRaw !== prevDate)) {
        rows.push(headers.map(() => ''));
      }
      prevLoc = loc;
      prevDate = dateRaw;

      const totalItems = (o.items || []).reduce((sum, it) => sum + (it.quantity || 0), 0);
      const totalNum = Number(o.total ?? o.totalAmount ?? 0);
      rows.push([
        loc,
        dateRaw ? formatPickupDate(dateRaw) : '(inget datum)',
        o.orderNumber || o.id || '',
        orderDate(o),
        customerName(o),
        o.customerInfo?.email || '',
        o.customerInfo?.phone || '',
        formatItems(o.items),
        totalItems,
        (Number.isFinite(totalNum) ? totalNum : 0).toFixed(2),
        statusLabel(o.status),
      ]);
    }

    const csvContent = [headers, ...rows]
      .map((row) => row.map(csvField).join(','))
      .join('\n');

    const timestamp = new Date().toISOString().split('T')[0];
    const filename = options.filename || `upphamtningar-${timestamp}.csv`;
    triggerDownload(csvContent, filename);

    return {
      success: true,
      message: `${pickupOrders.length} upphämtningsordrar exporterade till ${filename}`,
      count: pickupOrders.length,
    };
  } catch (error) {
    console.error('Error exporting pickup orders:', error);
    return { success: false, message: error.message || 'Kunde inte exportera upphämtningar', count: 0 };
  }
};
