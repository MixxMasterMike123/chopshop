// podExport.js — CSV export of the print queue, ONE row per POD line item. Built
// from the production-scoped rows returned by the getPrintQueueExport callable —
// never from raw orders (the printer surface has no direct order access). Mirrors
// pickupExport.js (csvField escaping + BOM for Excel).

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

const HEADERS = [
  'Ordernummer', 'Orderdatum', 'Butik', 'Produkt', 'SKU', 'Variant', 'Antal',
  'Placeringstyp', 'Placering', 'Profil', 'Filnamn', 'Format', 'Validering', 'Leveransort', 'Land',
];

const fmtDate = (iso) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('sv-SE'); } catch { return iso; }
};

/**
 * Export production rows (from getPrintQueueExport) to a CSV file.
 * @param {Array} rows  [{ orderNumber, orderDate, shopName, productName, sku, variant,
 *                         quantity, placement, purpose, fileName, tier, shipToCity, shipToCountry }]
 * @param {object} options { filename? }
 * @returns {{success:boolean, message:string, count:number}}
 */
export const exportPrintQueueToCSV = (rows, options = {}) => {
  try {
    if (!Array.isArray(rows) || rows.length === 0) {
      return { success: false, message: 'Inga produktionsrader att exportera', count: 0 };
    }
    const filename = options.filename || `print-ko-${new Date().toISOString().slice(0, 10)}.csv`;
    const body = rows.map((r) => [
      r.orderNumber, fmtDate(r.orderDate), r.shopName, r.productName, r.sku, r.variant,
      r.quantity, r.slot, r.placement, r.purpose, r.fileName, r.format, r.tier, r.shipToCity, r.shipToCountry,
    ]);
    const csv = [HEADERS, ...body].map((row) => row.map(csvField).join(',')).join('\n');
    triggerDownload(csv, filename);
    return { success: true, message: `${rows.length} rader exporterade till ${filename}`, count: rows.length };
  } catch (error) {
    console.error('Error exporting print queue:', error);
    return { success: false, message: error.message || 'Kunde inte exportera', count: 0 };
  }
};
