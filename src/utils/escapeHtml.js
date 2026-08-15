// escapeHtml — context-safe escaping for CUSTOMER-CONTROLLED strings that get
// interpolated into generated print/export HTML (admin order print, shipping
// labels, order verification PDFs). P1-10 (2026-08-15 audit): a buyer-supplied
// name/address/note like `<img src=x onerror=…>` executed in the ADMIN's
// browser when a print view opened — a stored-XSS privilege jump from customer
// input to admin session.
//
// Escapes the five HTML special characters, which is safe for text nodes AND
// double-quoted attribute values. null/undefined become ''.
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default escapeHtml;
