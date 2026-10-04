// src/components/layout/adminShellScope.js for the admin build (alias list,
// vite.admin.config.js): what AppLayout shows on Cloudflare.
//
// The menu: the launch scope only (CP5_GAP_ANALYSIS.md §1a/§1b). The
// feature-gated add-on entries (Affiliate, Marknadsföring, B2B-kunder,
// Rabattkoder, Recensioner, Innehållsstudio, the dining mentions) close by
// themselves, because the API answers `false` for every feature that is not
// ported (D81). The two entries below are not feature-gated and point at
// pages that left the build, so they leave the menu here. POD stays as the
// static entry of replacements/wagonRegistry.js.
//
// One entry is ADDED (unit CP5-FL): "Omdirigeringar", after "Sidor", for the
// shop's forwards page, which has no older page (the AppLayout markup is
// unchanged; the entry is data, as the menu is).
//
// The shop choice: a tenant admin may now be a member of several shops
// (`/v1/me` memberships); a platform user works only in a shop it has an open
// acting-as grant for, and leaves it through the banner's "Avsluta".

import { ArrowUturnRightIcon } from '@heroicons/react/24/outline';

/** Menu paths that leave this build, with why (the CP5-FB report lists them). */
export const LEFT_ADMIN_PATHS = Object.freeze({
  '/admin/b2c-customers': 'consumer accounts are not ported (D11, D81); the page left the build',
  '/admin/skatteuppgifter': 'DAC7 is CP9 (D23); the page left the build',
});

/** Menu entries this build adds, each after the entry of `after` (unit CP5-FL). */
export const ADDED_ADMIN_LINKS = Object.freeze([
  {
    after: '/admin/pages',
    link: { name: 'Omdirigeringar', path: '/admin/redirects', icon: ArrowUturnRightIcon, description: 'Skicka gamla adresser vidare till nya' },
  },
]);

export function scopeAdminNav(links) {
  return links
    .filter((link) => !Object.hasOwn(LEFT_ADMIN_PATHS, link.path))
    .flatMap((link) => [link, ...ADDED_ADMIN_LINKS.filter((a) => a.after === link.path).map((a) => a.link)]);
}

const activeCount = (auth) =>
  (Array.isArray(auth?.memberships) ? auth.memberships : []).filter((m) => m?.status === 'active').length;

/**
 * No shop resolved. A platform user picks among its open grants (with none,
 * the admin tree has already sent it to the console). A tenant admin with
 * memberships sees them (a suspended one marked "Pausad"); with none the
 * account is broken and the shell says so.
 */
export function mayPickShop(auth) {
  if (auth?.isPlatform) return true;
  return Array.isArray(auth?.memberships) && auth.memberships.length > 0;
}

/** "Byt butik" in the top bar: only when there is another shop to work in. */
export function maySwitchShop(auth) {
  if (auth?.isPlatform) return (Array.isArray(auth?.actingAs) ? auth.actingAs.length : 0) > 1;
  return activeCount(auth) > 1;
}
