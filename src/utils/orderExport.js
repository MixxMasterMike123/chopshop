/**
 * Order Export Utility
 * Export orders to CSV format for accounting and bookkeeping
 */

import { format } from 'date-fns';
import { sv } from 'date-fns/locale';

/**
 * Format date for CSV export
 */
const formatDate = (dateValue) => {
  if (!dateValue) return '';
  
  try {
    // Handle Firestore Timestamp
    if (dateValue && typeof dateValue.toDate === 'function') {
      return format(dateValue.toDate(), 'yyyy-MM-dd HH:mm', { locale: sv });
    }
    
    // Handle ISO date string
    if (typeof dateValue === 'string') {
      return format(new Date(dateValue), 'yyyy-MM-dd HH:mm', { locale: sv });
    }
    
    // Handle JavaScript Date object
    if (dateValue instanceof Date) {
      return format(dateValue, 'yyyy-MM-dd HH:mm', { locale: sv });
    }
    
    // Handle seconds-based timestamp
    if (dateValue.seconds) {
      return format(new Date(dateValue.seconds * 1000), 'yyyy-MM-dd HH:mm', { locale: sv });
    }
    
    return '';
  } catch (err) {
    console.error('Error formatting date:', err);
    return '';
  }
};

/**
 * Get status label in Swedish
 */
const getStatusLabel = (status) => {
  const statusMap = {
    'pending': 'Väntar',
    'confirmed': 'Bekräftad',
    'processing': 'Behandlas',
    'shipped': 'Skickad',
    'delivered': 'Levererad',
    'cancelled': 'Avbruten',
    'refunded': 'Återbetald',
    'partially_refunded': 'Delvis återbetald'
  };
  return statusMap[status] || status || 'Okänd';
};

/**
 * Get source label in Swedish
 */
const getSourceLabel = (source) => {
  const sourceMap = {
    'b2b': 'Återförsäljare (B2B)',
    'b2c': 'Kund (B2C)'
  };
  return sourceMap[source] || 'Återförsäljare (B2B)'; // Default to B2B for legacy orders
};

/**
 * Extract product name from multilingual object or string
 */
const getProductName = (nameField) => {
  if (!nameField) return 'Produkt';
  
  // If it's a string, return it
  if (typeof nameField === 'string') return nameField;
  
  // If it's a multilingual object, try Swedish first, then English, then first available
  if (typeof nameField === 'object') {
    return nameField['sv-SE'] || nameField['sv'] || 
           nameField['en-GB'] || nameField['en-US'] || nameField['en'] ||
           Object.values(nameField)[0] || 'Produkt';
  }
  
  return 'Produkt';
};

/**
 * Format order items as readable string
 */
const formatOrderItems = (items) => {
  if (!items || items.length === 0) return '';
  
  return items.map(item => {
    // Handle multilingual name field
    const name = getProductName(item.name || item.productName);
    const quantity = item.quantity || 0;
    const price = item.price || 0;
    
    // Variant: prefer the pre-composed label, else the legacy color/size combo.
    const variant = item.label || [item.color, item.size].filter(Boolean).join(', ');
    // Charged SKU (variant SKU wins) appended in parentheses when present.
    const chargedSku = item.variantSku || item.sku;

    const detailsStr = variant ? ` (${variant})` : '';
    const skuStr = chargedSku ? ` (${chargedSku})` : '';
    return `${name}${detailsStr}${skuStr} x ${quantity} (${price} kr)`;
  }).join('; ');
};

/**
 * Calculate order totals
 */
const calculateOrderTotals = (order) => {
  const items = order.items || [];
  
  // Subtotal (items only) - use order.subtotal if available, otherwise calculate
  const subtotal = order.subtotal || items.reduce((sum, item) => {
    return sum + ((item.price || 0) * (item.quantity || 0));
  }, 0);
  
  // Shipping cost - check multiple possible locations
  // B2C orders: order.shipping is a number
  // B2B orders: order.shippingCost or order.shipping.cost or order.prisInfo.frakt
  const shipping = (typeof order.shipping === 'number' ? order.shipping : 
                   (order.shipping?.cost || order.shippingCost || order.prisInfo?.frakt)) || 
                   0;
  
  // Discount
  const discount = order.discountAmount || order.discount || 0;
  
  // VAT - use order.vat if available, otherwise calculate
  const vat = order.vat || (order.subtotal && order.total ? order.total - order.subtotal - shipping + discount : 0);
  
  // Total including VAT - use order total if available
  const totalAmount = order.total || order.totalAmount || (subtotal + shipping + vat - discount);
  
  // Calculate total before VAT
  const totalBeforeVAT = totalAmount - vat;
  
  return {
    subtotal: subtotal.toFixed(2),
    shipping: shipping.toFixed(2),
    discount: discount.toFixed(2),
    totalBeforeVAT: totalBeforeVAT.toFixed(2),
    vat: vat.toFixed(2),
    totalAmount: totalAmount.toFixed(2)
  };
};

/**
 * Export orders to CSV format
 * Perfect for accounting software import (Fortnox, Visma, etc.)
 */
export const exportOrdersToCSV = (orders, options = {}) => {
  try {
    if (!orders || orders.length === 0) {
      throw new Error('Inga ordrar att exportera');
    }

    // CSV Headers - designed for Swedish accounting software
    const csvHeaders = [
      'Ordernummer',
      'Orderdatum',
      'Status',
      'Källa',
      'Kundtyp',
      'Företagsnamn',
      'Kontaktperson',
      'E-post',
      'Telefon',
      'Adress',
      'Postnummer',
      'Stad',
      'Land',
      'Produkter',
      'Antal artiklar',
      'Delsumma (kr)',
      'Frakt (kr)',
      'Rabatt (kr)',
      'Summa ex. moms (kr)',
      'Moms 25% (kr)',
      'Totalt inkl. moms (kr)',
      'Betalmetod',
      'Affiliatekod',
      'Affiliatekommission (kr)',
      'Affiliaterabatt (kr)',
      'Anteckningar'
    ];

    // Convert orders to CSV rows
    const csvData = orders.map(order => {
      const totals = calculateOrderTotals(order);
      const isB2B = order.source !== 'b2c';
      const isB2C = order.source === 'b2c';
      
      // Customer information - different structure for B2B vs B2C
      let companyName = '';
      let contactPerson = '';
      let email = '';
      let phone = '';
      let address = '';
      let postalCode = '';
      let city = '';
      let country = '';
      
      if (isB2C && order.customerInfo) {
        // B2C customer
        companyName = order.customerInfo.companyName || '';
        contactPerson = `${order.customerInfo.firstName || ''} ${order.customerInfo.lastName || ''}`.trim();
        email = order.customerInfo.email || '';
        phone = order.customerInfo.phone || '';
        
        // Use shipping address if available
        if (order.shippingAddress) {
          address = order.shippingAddress.address || order.shippingAddress.street || '';
          postalCode = order.shippingAddress.postalCode || order.shippingAddress.zip || '';
          city = order.shippingAddress.city || '';
          country = order.shippingAddress.country || 'Sverige';
        }
      } else {
        // B2B customer
        companyName = order.companyName || '';
        contactPerson = order.contactPerson || '';
        email = order.userEmail || order.email || '';
        phone = order.phone || '';
        address = order.address || '';
        postalCode = order.postalCode || '';
        city = order.city || '';
        country = order.country || 'Sverige';
      }
      
      // Payment method
      const paymentMethod = order.paymentMethod || order.payment?.method || 'Faktura';
      
      // Affiliate information
      const affiliateCode = order.affiliateCode || order.affiliate?.code || '';
      const affiliateCommission = order.affiliateCommission || 0;
      const affiliateDiscount = order.discountAmount || 0;
      
      // Total number of items
      const totalItems = (order.items || []).reduce((sum, item) => sum + (item.quantity || 0), 0);
      
      // Notes
      const notes = order.notes || order.orderNotes || '';
      
      return [
        order.orderNumber || order.id || '',
        formatDate(order.createdAt),
        getStatusLabel(order.status),
        getSourceLabel(order.source),
        isB2C ? 'Privatkund' : 'Företagskund',
        companyName,
        contactPerson,
        email,
        phone,
        address,
        postalCode,
        city,
        country,
        formatOrderItems(order.items),
        totalItems,
        totals.subtotal,
        totals.shipping,
        totals.discount,
        totals.totalBeforeVAT,
        totals.vat,
        totals.totalAmount,
        paymentMethod,
        affiliateCode,
        affiliateCommission.toFixed(2),
        affiliateDiscount.toFixed(2),
        notes
      ];
    });

    // Create CSV content with proper escaping
    const csvContent = [csvHeaders, ...csvData]
      .map(row => row.map(field => {
        // Escape quotes and wrap in quotes if contains comma, quote, or newline
        const fieldStr = String(field || '');
        if (fieldStr.includes(',') || fieldStr.includes('"') || fieldStr.includes('\n')) {
          return `"${fieldStr.replace(/"/g, '""')}"`;
        }
        return fieldStr;
      }).join(','))
      .join('\n');

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = options.filename || `orders-${timestamp}.csv`;

    // Create and trigger download
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' }); // BOM for Excel compatibility
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    // Success message
    return {
      success: true,
      message: `${orders.length} ordrar exporterade till ${filename}`,
      count: orders.length
    };

  } catch (error) {
    console.error('Error exporting orders to CSV:', error);
    return {
      success: false,
      message: error.message || 'Kunde inte exportera ordrar',
      count: 0
    };
  }
};

/**
 * Export single order to CSV (for individual verification)
 */
export const exportSingleOrderToCSV = (order, options = {}) => {
  return exportOrdersToCSV([order], {
    ...options,
    filename: options.filename || `order-${order.orderNumber || order.id}-${new Date().toISOString().split('T')[0]}.csv`
  });
};

