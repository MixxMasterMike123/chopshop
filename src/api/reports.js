// The public infringement report (CP3-D, src/routes/storefront-reports.ts).

import { request } from './client.js';

/**
 * POST /v1/reports. `{ productId, reporterName, reporterOrg?, reporterEmail,
 * rightType: 'trademark' | 'copyright' | 'other', description, attestation:
 * true, productUrl?, website }` — `website` is the form's honeypot and must
 * be sent as the form holds it ('' for a person). Resolves the case reference
 * `{ reportId }`. Every refusal of the body is the same 400; 429 after five
 * reports in an hour from one address.
 */
export async function submitReport(
  { productId, reporterName, reporterOrg, reporterEmail, rightType, description, attestation, productUrl, website = '' },
  { signal } = {},
) {
  const body = { attestation, description, productId, reporterEmail, reporterName, rightType, website };
  if (reporterOrg) body.reporterOrg = reporterOrg;
  if (productUrl) body.productUrl = productUrl;
  const { data } = await request('/v1/reports', { method: 'POST', body, signal });
  return data.report;
}
