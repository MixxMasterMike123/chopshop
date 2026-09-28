// The infringement report's shapes (CP4 brief F2; the route of CP3-D). Pure.
//
// The API: POST /v1/reports (cloudflare/src/catalog/infringement-reports.ts)
//   { productId, reporterName, reporterOrg?, reporterEmail, rightType,
//     description, attestation: true, productUrl?, website }
//   201 { report: { reportId } } · 400 (every refusal of the body, one answer)
//   · 404 (no storefront here) · 429
// A report ALWAYS names a product of this shop by its id (0036): the page
// finds it from its `?product=` reference, or from the address of a product
// page of this shop (the page the footer link was clicked on, or a link the
// reporter pasted).

/**
 * The product reference (the last segment of `/product/<ref>`) of a path of
 * this shop, or null. `root` is the shop's root: '/<shop>' on the shared host,
 * '' on a shop's own domain (src/api/client.js storefrontRoot).
 */
export function productRefFromPath(pathname, root) {
  if (typeof pathname !== 'string' || typeof root !== 'string') return null;
  let rest;
  if (root === '') {
    rest = pathname;
  } else if (pathname.startsWith(`${root}/`)) {
    rest = pathname.slice(root.length);
  } else {
    return null;
  }
  const match = /^\/product\/([^/]+)\/?$/.exec(rest);
  if (!match) return null;
  try {
    const ref = decodeURIComponent(match[1]);
    return ref.trim() === '' || /[\u0000-\u001f\u007f/\\]/.test(ref) ? null : ref;
  } catch {
    return null;
  }
}

/**
 * The product reference of a link the reporter typed or that the page filled
 * in: an absolute address on this shop's own origin, or a path. Anything else
 * (another site, a product's name, several links) is null.
 */
export function productRefFromLink(text, { origin, root }) {
  const value = String(text ?? '').trim();
  if (value === '' || /\s/.test(value)) return null;
  let url;
  try {
    url = value.startsWith('/') && !value.startsWith('//') ? new URL(value, origin) : new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  return productRefFromPath(url.pathname, root);
}

/** The body of POST /v1/reports from the page's form and the product's id. */
export function toReportRequest(form, productId) {
  return {
    productId: productId || '',
    reporterName: String(form.reporterName ?? '').trim(),
    reporterOrg: String(form.reporterOrg ?? '').trim(),
    reporterEmail: String(form.reporterEmail ?? '').trim(),
    rightType: form.rightType,
    description: String(form.description ?? '').trim(),
    attestation: form.attestation === true,
    productUrl: String(form.productUrl ?? '').trim(),
    website: typeof form.website === 'string' ? form.website : '',
  };
}

/** An ApiError of the route → 'rate_limited' | 'invalid' | 'other'. */
export function reportErrorKind(error) {
  if (error?.status === 429) return 'rate_limited';
  if (error?.status === 400) return 'invalid';
  return 'other';
}
