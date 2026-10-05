// CP9-OB: the seller's identity the legal pages print, and what an adoption
// of them requires. Pure, shared by both builds; tested under Node in
// src/admin-app/adapters/placeholderIdentity.test.mjs.

import { isRealAddress, isRealText } from './placeholderIdentity.js';

// CP9-OB: what each identity gap is called where the seller adopts the pages.
// The keys are the Worker's (cloudflare/src/legal/legal-identity.ts
// LEGAL_IDENTITY_FIELDS), which a refused adoption names.
export const LEGAL_IDENTITY_LABELS = Object.freeze({
  legalName: 'Juridiskt namn saknas',
  address: 'Adress saknas',
  supportEmail: 'Support-e-post saknas',
  orgNumber: 'Organisationsnummer saknas',
  vatNumber: 'Momsregistreringsnummer saknas',
});

// The support address's gap where the platform sets it (D99, the admin build).
export const SUPPORT_EMAIL_BY_PLATFORM_LABEL = 'Support-e-post saknas (plattformen lägger in den)';

/**
 * CP9-OB: what the three legal pages print of the seller and the identity
 * lacks, so the pages would hold a hole or a placeholder. The templates
 * (legalTemplates.js) print the legal name, the address and the contact
 * address on every page; the org number in the company branch; the VAT number
 * in the company branch when VAT-registered (köpvillkor §1). The return
 * address and the VAT answer are the checkout's own blockers (below), not
 * repeated here. Adopting the pages is refused while any is missing (the
 * Worker refuses it too: 409 legal_identity_incomplete). Not a checkout
 * blocker: an adoption already made stands.
 *
 * Returns [{ key, label }] in the Worker's order.
 */
export function legalIdentityGaps(identity = {}, { supportEmailByPlatform = false } = {}) {
  const company = identity.sellerType === 'company';
  const gaps = [];
  const gap = (key, label = LEGAL_IDENTITY_LABELS[key]) => gaps.push({ key, label });
  if (!isRealText(identity.legalName)) gap('legalName');
  if (!isRealText(identity.address)) gap('address');
  if (!isRealAddress(identity.supportEmail)) {
    gap('supportEmail', supportEmailByPlatform ? SUPPORT_EMAIL_BY_PLATFORM_LABEL : LEGAL_IDENTITY_LABELS.supportEmail);
  }
  if (company && !isRealText(identity.orgNumber)) gap('orgNumber');
  if (company && identity.vatRegistered === true && !isRealText(identity.vatNumber)) gap('vatNumber');
  return gaps;
}
