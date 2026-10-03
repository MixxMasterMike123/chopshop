// What the admin shell (AppLayout.jsx) shows, as DATA: the older build's
// answers. The Cloudflare admin build swaps this module for
// src/admin-app/replacements/adminShellScope.js (alias list,
// vite.admin.config.js), so AppLayout's markup serves both builds.

/** The main menu's entries this build shows: all of them. */
export function scopeAdminNav(links) {
  return links;
}

/** With no shop resolved: may this user pick one (the picker), or is the account broken? */
export function mayPickShop(auth) {
  return Boolean(auth?.isPlatform);
}

/** Does the top bar's shop label switch shops ("Byt butik")? */
export function maySwitchShop(auth) {
  return Boolean(auth?.isPlatform);
}
