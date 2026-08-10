// podProfiles.js — cached loader for the print spec profiles (settings/podProfiles).
//
// The profiles are GLOBAL config (not per-shop): a single doc holding the array of
// print purposes (apparel/poster/sticker/mug…) the validation engine checks against.
// They are SEEDED/edited by an Admin-SDK script (scripts/seed-pod-profiles.cjs) and
// the platform — firestore.rules makes settings/{id} read=isActiveUser, write=
// isPlatform — so the app only ever READS them. Changing a profile's size/DPI in the
// doc auto-updates the validation thresholds (no code change).
//
// Mirrors shopConfig.loadShopFeatures' caching style: one module-level cache (global,
// not per-shop). Degrades to [] on missing/error so callers never crash.
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase/config';

const PROFILES_REF = () => doc(db, 'settings', 'podProfiles');

// Module-level cache. `null` = not loaded yet; an array (possibly empty) = loaded.
let _cache = null;
// Carries version/provisional alongside the profiles for the validation record.
let _meta = { version: 0, provisional: true };

/**
 * loadPodProfiles() → Promise<Array<profile>>
 * Reads settings/podProfiles once and caches the profiles array. Returns [] if the
 * doc is missing (not seeded yet) or on any read error — the POD UI then shows an
 * empty profile list rather than throwing.
 */
export const loadPodProfiles = async () => {
  if (_cache !== null) return _cache;
  try {
    const snap = await getDoc(PROFILES_REF());
    if (snap.exists()) {
      const data = snap.data() || {};
      _cache = Array.isArray(data.profiles) ? data.profiles : [];
      _meta = { version: data.version || 0, provisional: data.provisional !== false };
    } else {
      _cache = [];
    }
  } catch (err) {
    console.warn('podProfiles: could not load settings/podProfiles, using [] :', err?.message);
    _cache = [];
  }
  return _cache;
};

/** The version/provisional metadata of the last successful load (for validation records + banners). */
export const getPodProfilesMeta = () => _meta;

/** Find a loaded profile by its id (e.g. 'apparel_dtg'). Returns null if absent. */
export const getProfileById = (profiles, id) =>
  (Array.isArray(profiles) ? profiles : []).find((p) => p && p.id === id) || null;

/** Drop the cache (e.g. after a platform edit) so the next load re-reads Firestore. */
export const clearPodProfilesCache = () => {
  _cache = null;
  _meta = { version: 0, provisional: true };
};

/** DEV-ONLY: pre-seed the cache so the untracked studio harness can mount the
 *  FULL DesignStudio without Firestore. No-op in production builds. */
export const seedPodProfilesCacheForDev = (profiles) => {
  if (!import.meta.env.DEV) return;
  _cache = Array.isArray(profiles) ? profiles : [];
};
