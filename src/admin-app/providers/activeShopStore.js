// The shop chosen in this tab (CP5 brief FA.3): kept in sessionStorage, so
// two tabs can work in two shops, and a reload keeps the choice. Plain module
// state with listeners, so the ActiveShop provider and the module that
// replaces config/activeShop.js (src/admin-app/replacements/activeShop.js:
// what the picker and the deep-link intake call) share one value.
//
// The CHOICE is not yet the active shop: ActiveShop.jsx honours it only when
// `/v1/me` says the user may use that shop (src/api/admin/session.js
// resolveActiveShopId). Storage can be missing or throw (private mode): every
// access is guarded, and the choice then lives for the page's life only.

const KEY = 'admin.activeShopId';
const SHOP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

let memory = null;
const listeners = new Set();

function storage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** A shop id of the address grammar, or null. */
export function cleanShopId(value) {
  return typeof value === 'string' && SHOP_ID.test(value) ? value : null;
}

/** The shop chosen in this tab, or null. */
export function getChosenShopId() {
  try {
    const stored = cleanShopId(storage()?.getItem(KEY) ?? null);
    if (stored) return stored;
  } catch {
    /* storage refused: the in-memory choice below */
  }
  return memory;
}

/** Choose a shop for this tab (null clears the choice); tells the listeners. */
export function setChosenShopId(shopId) {
  const next = cleanShopId(shopId);
  if (next === getChosenShopId()) return;
  memory = next;
  try {
    const s = storage();
    if (next) s?.setItem(KEY, next);
    else s?.removeItem(KEY);
  } catch {
    /* storage refused: kept in memory */
  }
  for (const listener of listeners) {
    try {
      listener(next);
    } catch {
      /* a listener's failure is its own */
    }
  }
}

/** Subscribe to a new choice; returns the unsubscribe function. */
export function subscribeChosenShopId(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `?shopId=` of the address the page was opened with (a Connect return, an e-mail link), or null. */
export function shopIdOnArrival(search = globalThis.location?.search ?? '') {
  try {
    return cleanShopId(new URLSearchParams(search).get('shopId'));
  } catch {
    return null;
  }
}
