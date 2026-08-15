/**
 * Order Verification Export
 * Creates individual verification documents for Swedish accounting compliance
 * 
 * Swedish accounting law (Bokföringslagen) requires each business transaction
 * to have a separate verification document for audit trail and tax compliance.
 */

import { format } from 'date-fns';
import { sv } from 'date-fns/locale';
// jspdf v4 dropped the default-export class — the constructor is the NAMED
// export only (a default import resolves to the module object and throws
// "jsPDF is not a constructor" at runtime, invisible to the build).
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import { escapeHtml } from './escapeHtml';

/**
 * Format date for verification documents
 */
const formatDate = (dateValue) => {
  if (!dateValue) return '';
  
  try {
    if (dateValue && typeof dateValue.toDate === 'function') {
      return format(dateValue.toDate(), 'yyyy-MM-dd', { locale: sv });
    }
    if (typeof dateValue === 'string') {
      return format(new Date(dateValue), 'yyyy-MM-dd', { locale: sv });
    }
    if (dateValue instanceof Date) {
      return format(dateValue, 'yyyy-MM-dd', { locale: sv });
    }
    if (dateValue.seconds) {
      return format(new Date(dateValue.seconds * 1000), 'yyyy-MM-dd', { locale: sv });
    }
    return '';
  } catch (err) {
    console.error('Error formatting date:', err);
    return '';
  }
};

/**
 * Format currency amount
 */
const formatAmount = (amount) => {
  return parseFloat(amount || 0).toFixed(2) + ' kr';
};

/**
 * Extract product name from multilingual object or string
 */
const getProductName = (nameField) => {
  if (!nameField) return 'Produkt';
  if (typeof nameField === 'string') return nameField;
  if (typeof nameField === 'object') {
    return nameField['sv-SE'] || nameField['sv'] || 
           nameField['en-GB'] || nameField['en-US'] || nameField['en'] ||
           Object.values(nameField)[0] || 'Produkt';
  }
  return 'Produkt';
};

/**
 * Calculate order totals
 */
const calculateOrderTotals = (order) => {
  const items = order.items || [];
  
  const subtotal = order.subtotal || items.reduce((sum, item) => {
    return sum + ((item.price || 0) * (item.quantity || 0));
  }, 0);
  
  const shipping = (typeof order.shipping === 'number' ? order.shipping : 
                   (order.shipping?.cost || order.shippingCost || order.prisInfo?.frakt)) || 0;
  
  const discount = order.discountAmount || order.discount || 0;
  const vat = order.vat || 0;
  const totalAmount = order.total || order.totalAmount || (subtotal + shipping + vat - discount);
  const totalBeforeVAT = totalAmount - vat;
  
  return {
    subtotal,
    shipping,
    discount,
    totalBeforeVAT,
    vat,
    totalAmount
  };
};

/**
 * Create HTML verification document for a single order
 * Swedish accounting compliant format
 */
export const createOrderVerificationHTML = (order) => {
  const totals = calculateOrderTotals(order);
  const isB2C = order.source === 'b2c';

  // Customer information. P1-10: every customer-controlled string is HTML-
  // escaped HERE, at derivation — the template below may interpolate these
  // freely without re-auditing each site.
  let companyName = '';
  let contactPerson = '';
  let email = '';
  let address = '';

  if (isB2C && order.customerInfo) {
    companyName = order.customerInfo.companyName || '';
    contactPerson = `${order.customerInfo.firstName || ''} ${order.customerInfo.lastName || ''}`.trim();
    email = order.customerInfo.email || '';
    if (order.shippingInfo) {
      address = `${order.shippingInfo.address || ''}, ${order.shippingInfo.postalCode || ''} ${order.shippingInfo.city || ''}, ${order.shippingInfo.country || ''}`.trim();
    }
  } else {
    companyName = order.companyName || '';
    contactPerson = order.contactPerson || '';
    email = order.userEmail || order.email || '';
    address = `${order.address || ''}, ${order.postalCode || ''} ${order.city || ''}, ${order.country || ''}`.trim();
  }
  companyName = escapeHtml(companyName);
  contactPerson = escapeHtml(contactPerson);
  email = escapeHtml(email);
  address = escapeHtml(address);
  const orderNumber = escapeHtml(order.orderNumber || order.id);
  const shopName = escapeHtml(order.shopName || order.sellerName || 'Webbutik');
  const sellerLegalName = escapeHtml(order.sellerLegalName || '');
  const sellerOrgNumber = escapeHtml(order.sellerOrgNumber || '');
  
  // Order date
  const orderDate = formatDate(order.createdAt);
  
  // Payment method
  const paymentMethod = order.payment?.method || order.paymentMethod || 'Faktura';
  
  // Create HTML document
  const html = `
<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Orderverifikation ${orderNumber}</title>
  <style>
    @media print {
      @page { margin: 2cm; }
      body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    }
    
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      max-width: 210mm;
      margin: 0 auto;
      padding: 20px;
      color: #333;
      line-height: 1.6;
    }
    
    .header {
      display: flex;
      justify-content: space-between;
      align-items: start;
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 3px solid #459CA8;
    }
    
    .company-info {
      flex: 1;
    }
    
    .company-name {
      font-size: 24px;
      font-weight: bold;
      color: #459CA8;
      margin-bottom: 5px;
    }
    
    .verification-info {
      text-align: right;
    }
    
    .verification-label {
      font-size: 28px;
      font-weight: bold;
      color: #333;
      margin-bottom: 10px;
    }
    
    .verification-number {
      font-size: 18px;
      color: #666;
      font-family: 'Courier New', monospace;
    }
    
    .section {
      margin-bottom: 25px;
    }
    
    .section-title {
      font-size: 14px;
      font-weight: bold;
      text-transform: uppercase;
      color: #459CA8;
      margin-bottom: 10px;
      letter-spacing: 0.5px;
    }
    
    .info-grid {
      display: grid;
      grid-template-columns: 150px 1fr;
      gap: 8px;
      font-size: 14px;
    }
    
    .info-label {
      font-weight: 600;
      color: #666;
    }
    
    .info-value {
      color: #333;
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
      font-size: 14px;
    }
    
    th {
      background-color: #459CA8;
      color: white;
      padding: 12px;
      text-align: left;
      font-weight: 600;
    }
    
    td {
      padding: 10px 12px;
      border-bottom: 1px solid #e0e0e0;
    }
    
    tr:hover {
      background-color: #f8f9fa;
    }
    
    .text-right {
      text-align: right;
    }
    
    .totals-section {
      margin-top: 30px;
      padding: 20px;
      background-color: #f8f9fa;
      border-radius: 8px;
    }
    
    .totals-grid {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
      max-width: 400px;
      margin-left: auto;
    }
    
    .total-label {
      text-align: right;
      font-weight: 600;
      color: #666;
    }
    
    .total-value {
      text-align: right;
      font-family: 'Courier New', monospace;
      min-width: 120px;
    }
    
    .total-final {
      border-top: 2px solid #459CA8;
      padding-top: 12px;
      margin-top: 8px;
    }
    
    .total-final .total-label {
      font-size: 18px;
      color: #333;
    }
    
    .total-final .total-value {
      font-size: 20px;
      font-weight: bold;
      color: #459CA8;
    }
    
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #e0e0e0;
      font-size: 12px;
      color: #666;
      text-align: center;
    }
    
    .status-badge {
      display: inline-block;
      padding: 6px 12px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
    }
    
    .status-confirmed { background-color: #d4edda; color: #155724; }
    .status-pending { background-color: #fff3cd; color: #856404; }
    .status-processing { background-color: #cce5ff; color: #004085; }
    .status-shipped { background-color: #d1ecf1; color: #0c5460; }
    .status-delivered { background-color: #d4edda; color: #155724; }
    .status-cancelled { background-color: #f8d7da; color: #721c24; }
  </style>
</head>
<body>
  <div class="header">
    <div class="company-info">
      <div class="company-name">${shopName}</div>
      ${sellerLegalName ? `<div>${sellerLegalName}</div>` : ''}
      ${sellerOrgNumber ? `<div>Org.nr: ${sellerOrgNumber}</div>` : ''}
    </div>
    <div class="verification-info">
      <div class="verification-label">ORDERVERIFIKATION</div>
      <div class="verification-number">#${orderNumber}</div>
      <div style="margin-top: 10px;">${orderDate}</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Kundinformation</div>
    <div class="info-grid">
      ${companyName ? `<div class="info-label">Företag:</div><div class="info-value">${companyName}</div>` : ''}
      <div class="info-label">Kontaktperson:</div>
      <div class="info-value">${contactPerson}</div>
      <div class="info-label">E-post:</div>
      <div class="info-value">${email}</div>
      ${address ? `<div class="info-label">Adress:</div><div class="info-value">${address}</div>` : ''}
    </div>
  </div>

  <div class="section">
    <div class="section-title">Orderdetaljer</div>
    <div class="info-grid">
      <div class="info-label">Ordernummer:</div>
      <div class="info-value">${orderNumber}</div>
      <div class="info-label">Orderdatum:</div>
      <div class="info-value">${orderDate}</div>
      <div class="info-label">Status:</div>
      <div class="info-value">
        <span class="status-badge status-${escapeHtml(order.status || 'pending')}">
          ${order.status === 'confirmed' ? 'Bekräftad' : 
            order.status === 'pending' ? 'Väntar' :
            order.status === 'processing' ? 'Behandlas' :
            order.status === 'shipped' ? 'Skickad' :
            order.status === 'delivered' ? 'Levererad' :
            order.status === 'cancelled' ? 'Avbruten' :
            order.status === 'refunded' ? 'Återbetald' :
            order.status === 'partially_refunded' ? 'Delvis återbetald' : 'Okänd'}
        </span>
      </div>
      <div class="info-label">Betalmetod:</div>
      <div class="info-value">${paymentMethod === 'stripe' ? 'Stripe (Kort/Swish)' :
                                   paymentMethod === 'klarna' ? 'Klarna' :
                                   paymentMethod === 'swish' ? 'Swish' :
                                   escapeHtml(paymentMethod)}</div>
      <div class="info-label">Källa:</div>
      <div class="info-value">${isB2C ? 'B2C (Privatkund)' : 'B2B (Återförsäljare)'}</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Produkter</div>
    <table>
      <thead>
        <tr>
          <th>Produkt</th>
          <th class="text-right">Antal</th>
          <th class="text-right">Á-pris</th>
          <th class="text-right">Summa</th>
        </tr>
      </thead>
      <tbody>
        ${(order.items || []).map(item => {
          // P1-10: item fields originate from the (historically client-written)
          // order snapshot — escape before interpolation.
          const name = escapeHtml(getProductName(item.name || item.productName));
          const details = [];
          if (item.color) details.push(escapeHtml(item.color));
          if (item.size) details.push(escapeHtml(item.size));
          const detailsStr = details.length > 0 ? `<br><small style="color: #666;">${details.join(', ')}</small>` : '';
          const quantity = item.quantity || 0;
          const price = item.price || 0;
          const total = quantity * price;
          
          return `
            <tr>
              <td>${name}${detailsStr}</td>
              <td class="text-right">${quantity} st</td>
              <td class="text-right">${formatAmount(price)}</td>
              <td class="text-right">${formatAmount(total)}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  </div>

  <div class="totals-section">
    <div class="totals-grid">
      <div class="total-label">Delsumma:</div>
      <div class="total-value">${formatAmount(totals.subtotal)}</div>
      
      <div class="total-label">Frakt:</div>
      <div class="total-value">${formatAmount(totals.shipping)}</div>
      
      ${totals.discount > 0 ? `
        <div class="total-label">Rabatt:</div>
        <div class="total-value">-${formatAmount(totals.discount)}</div>
      ` : ''}
      
      <div class="total-label">Moms (25%):</div>
      <div class="total-value">${formatAmount(totals.vat)}</div>
      
      <div class="total-label total-final">TOTALT ATT BETALA:</div>
      <div class="total-value total-final">${formatAmount(totals.totalAmount)}</div>
    </div>
  </div>

  ${order.affiliate?.code ? `
    <div class="section">
      <div class="section-title">Affiliateinformation</div>
      <div class="info-grid">
        <div class="info-label">Affiliatekod:</div>
        <div class="info-value">${escapeHtml(order.affiliate.code)}</div>
        ${order.affiliate.discountPercentage ? `
          <div class="info-label">Rabatt:</div>
          <div class="info-value">${escapeHtml(order.affiliate.discountPercentage)}%</div>
        ` : ''}
      </div>
    </div>
  ` : ''}

  <div class="footer">
    <p><strong>${shopName}${sellerLegalName ? ` - ${sellerLegalName}` : ''}</strong></p>
    <p>Detta är en orderverifikation för bokföring enligt Bokföringslagen (BFL 1999:1078)</p>
    <p>Spara detta dokument i minst 7 år enligt Skatteverkets krav</p>
  </div>
</body>
</html>
  `;
  
  return html;
};

/**
 * Convert HTML to PDF and download
 */
const htmlToPDF = async (html, filename) => {
  return new Promise((resolve, reject) => {
    try {
      // Create temporary container
      const container = document.createElement('div');
      container.style.position = 'absolute';
      container.style.left = '-9999px';
      container.style.top = '0';
      container.style.width = '210mm'; // A4 width
      container.innerHTML = html;
      document.body.appendChild(container);
      
      // Wait for content to render
      setTimeout(async () => {
        try {
          // Convert HTML to canvas
          const canvas = await html2canvas(container, {
            scale: 2,
            useCORS: true,
            logging: false,
            windowWidth: 794, // A4 width in pixels at 96 DPI
            windowHeight: 1123 // A4 height in pixels at 96 DPI
          });
          
          // Create PDF
          const imgData = canvas.toDataURL('image/png');
          const pdf = new jsPDF({
            orientation: 'portrait',
            unit: 'mm',
            format: 'a4'
          });
          
          const imgWidth = 210; // A4 width in mm
          const imgHeight = (canvas.height * imgWidth) / canvas.width;
          
          pdf.addImage(imgData, 'PNG', 0, 0, imgWidth, imgHeight);
          
          // Download PDF
          pdf.save(filename);
          
          // Cleanup
          document.body.removeChild(container);
          
          resolve({
            success: true,
            message: `${filename} nedladdad`
          });
        } catch (error) {
          // Cleanup on error
          if (document.body.contains(container)) {
            document.body.removeChild(container);
          }
          reject(error);
        }
      }, 100);
    } catch (error) {
      reject(error);
    }
  });
};

/**
 * Export single order as PDF verification (downloads automatically)
 */
export const exportSingleOrderVerification = async (order) => {
  try {
    const html = createOrderVerificationHTML(order);
    const filename = `Verifikation-${order.orderNumber || order.id}-${formatDate(order.createdAt)}.pdf`;
    
    const result = await htmlToPDF(html, filename);
    
    return {
      success: true,
      message: `Verifikation för order ${order.orderNumber || order.id} nedladdad`
    };
  } catch (error) {
    console.error('Error exporting order verification:', error);
    return {
      success: false,
      message: error.message || 'Kunde inte skapa orderverifikation'
    };
  }
};

/**
 * Export all orders as individual PDF verification files (downloads automatically)
 * Downloads each PDF sequentially with progress updates
 */
export const exportAllOrderVerifications = async (orders, options = {}) => {
  try {
    if (!orders || orders.length === 0) {
      throw new Error('Inga ordrar att exportera');
    }
    
    const delay = options.delay || 1000; // Delay between downloads
    const onProgress = options.onProgress || (() => {}); // Progress callback
    
    // Confirmation for large batches
    if (orders.length > 10) {
      const confirmed = window.confirm(
        `Du är på väg att ladda ner ${orders.length} verifikationer som separata PDF-filer.\n\n` +
        `Detta kan ta ungefär ${Math.ceil(orders.length / 2)} minuter.\n\n` +
        `Fortsätt?`
      );
      
      if (!confirmed) {
        return {
          success: false,
          message: 'Export avbruten av användaren'
        };
      }
    }
    
    // Export orders sequentially
    let exported = 0;
    let failed = 0;
    
    for (let i = 0; i < orders.length; i++) {
      try {
        onProgress({
          current: i + 1,
          total: orders.length,
          order: orders[i]
        });
        
        await exportSingleOrderVerification(orders[i]);
        exported++;
        
        // Delay between downloads to avoid overwhelming browser
        if (i < orders.length - 1) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } catch (error) {
        console.error(`Failed to export order ${orders[i].orderNumber || orders[i].id}:`, error);
        failed++;
      }
    }
    
    return {
      success: true,
      message: `${exported} verifikationer nedladdade${failed > 0 ? `, ${failed} misslyckades` : ''}`,
      count: exported,
      failed
    };
  } catch (error) {
    console.error('Error exporting order verifications:', error);
    return {
      success: false,
      message: error.message || 'Kunde inte exportera orderverifikationer'
    };
  }
};

