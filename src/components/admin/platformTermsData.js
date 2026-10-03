// The platform terms' data layer — the OLDER build's implementation
// (Firebase), shared by PlatformTermsGate.jsx and AdminPlatformTerms.jsx.
//
// Both reach the terms only through this module, so they serve two builds:
// the older build (vite.config.js) uses this file as it is; the admin build
// (vite.admin.config.js) swaps it, by its alias list, for
// src/admin-app/replacements/platformTermsData.js (the legal routes of the
// API). Both export the same names with the same meaning:
//
//   initialPlatformTerms()        the text known before any read:
//                                 { version, terms: {title, html}, dpa: {title, html} }
//   loadPlatformTerms(shopId, { withText })   { rendered, accepted, acceptance }
//       rendered    the text of the CURRENT version (as above); `withText`
//                   asks for it even when the version is accepted (the
//                   terms page; here the text is always at hand)
//       accepted    the shop has accepted the current version
//       acceptance  the latest acceptance { acceptedAt, version, email?, uid? } or null
//   acceptPlatformTerms({ shopId, user, version })   records the seller's acceptance
//
// The two components' former inline reads, moved and unchanged.

import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../firebase/config';
import {
  hasAcceptedCurrentPlatformTerms,
  recordPlatformTermsAcceptance,
} from '../../utils/legalAcceptance';
import { renderPlatformTerms } from '../../utils/platformTermsRenderer';

// Rendered once per module — the templates are constant.
const RENDERED = renderPlatformTerms();

export function initialPlatformTerms() {
  return RENDERED;
}

export async function loadPlatformTerms(shopId) {
  const snap = await getDoc(doc(db, 'shops', shopId));
  const shopDoc = snap.exists() ? snap.data() : {};
  return {
    rendered: RENDERED,
    accepted: hasAcceptedCurrentPlatformTerms(shopDoc),
    acceptance: shopDoc?.platformTerms || null,
  };
}

export async function acceptPlatformTerms({ shopId, user }) {
  await recordPlatformTermsAcceptance({ shopId, user });
}
