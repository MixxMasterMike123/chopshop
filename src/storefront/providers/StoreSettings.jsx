// StoreSettings for the Cloudflare storefront: the same value and the same
// side effects as src/contexts/StoreSettingsContext.jsx, fed by the public
// storefront response instead of Firestore.
//
// First paint equals the baseline: the value starts as the static STORE
// defaults and is overridden, key by key and only with non-empty values,
// when the response arrives. `__loaded` turns true once the read is over,
// whether it succeeded or not (Checkout waits on it for pickup places).
//
// The theme and the tab identity below are the Firebase provider's code, kept
// line for line so the painted result cannot differ; the Firebase provider is
// deleted with the rest of the Firebase storefront at CP7, and then this is
// the only copy.

import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { STORE } from '../../config/store';
import { resolveTheme, ensureTemplateFonts } from '../../config/nordTokens';
import { getTemplate } from '../../config/templates';
import { useStorefront } from './Storefront.jsx';

const StoreSettingsContext = createContext(STORE);

export function useStoreSettings() {
  return useContext(StoreSettingsContext);
}

/**
 * The response in the shape the pages read (config/store.js keys): the
 * allowlisted `identity` keys as they are, then the fields the response
 * carries beside it. Branding images are addresses built by the API.
 */
export function settingsFromStorefront(storefront) {
  const saved = { ...(storefront.identity && typeof storefront.identity === 'object' ? storefront.identity : {}) };
  saved.shopName = storefront.name;
  saved.currency = storefront.currency;
  saved.locale = storefront.locale;
  const branding = storefront.branding || {};
  if (branding.logo?.url) saved.logoUrl = branding.logo.url;
  if (branding.hero?.url) saved.heroImageUrl = branding.hero.url;
  if (branding.favicon?.url) saved.faviconUrl = branding.favicon.url;
  // A gallery tile as the page reads it: the image's address, and the path of
  // the product it links (relative to the shop's root; shopHref adds the root).
  if (Array.isArray(saved.gallery)) {
    saved.gallery = saved.gallery.map((tile) => ({
      ...tile,
      imageUrl: tile?.image?.url ?? null,
    }));
  }
  for (const key of ['menu', 'pickupLocations', 'templateId', 'theme', 'accent']) {
    if (storefront[key] !== undefined) saved[key] = storefront[key];
  }
  return saved;
}

export function mergeSettings(saved) {
  const merged = { ...STORE, __loaded: true };
  for (const [key, value] of Object.entries(saved || {})) {
    if (value !== undefined && value !== null && value !== '') {
      merged[key] = value;
    }
  }
  return merged;
}

export function StoreSettingsProvider({ children }) {
  const { status, storefront } = useStorefront();

  const settings = useMemo(() => {
    if (status === 'ready') return mergeSettings(settingsFromStorefront(storefront));
    if (status === 'loading') return STORE;
    // Not found, unreachable or no shop: the defaults, and the read is over.
    return { ...STORE, __loaded: true };
  }, [status, storefront]);

  // NORD defaults ← template tokens ← shop inline `theme` ← shop `accent`
  // (StoreSettingsContext.jsx, verbatim).
  const resolved = useMemo(() => {
    const tpl = getTemplate(settings.templateId);
    const inline = settings.theme || {};
    const merged = {};
    for (const group of ['colors', 'fonts', 'shape', 'motion', 'layout']) {
      const t = tpl.tokens?.[group];
      const i = inline[group];
      if (t || i) merged[group] = { ...(t || {}), ...(i || {}) };
    }
    if (settings.accent) {
      merged.colors = { ...(merged.colors || {}), accent: settings.accent };
    }
    return { ...resolveTheme(merged), fonts: tpl.fonts };
  }, [settings.accent, settings.theme, settings.templateId]);

  useEffect(() => {
    const root = document.documentElement.style;
    for (const [cssVar, value] of Object.entries(resolved.vars)) {
      root.setProperty(cssVar, value);
    }
    ensureTemplateFonts(resolved.fonts);
  }, [resolved]);

  // The tab's name and icon (StoreSettingsContext.jsx, verbatim).
  useEffect(() => {
    if (!settings.__loaded) return;
    if (settings.shopName) document.title = settings.shopName;
    if (settings.faviconUrl) {
      let link = document.querySelector("link[rel~='icon'][data-shop-favicon]");
      if (!link) {
        document
          .querySelectorAll("link[rel~='icon'], link[rel='shortcut icon'], link[rel='apple-touch-icon']")
          .forEach((el) => el.parentNode?.removeChild(el));
        link = document.createElement('link');
        link.rel = 'icon';
        link.setAttribute('data-shop-favicon', '');
        document.head.appendChild(link);
      }
      const url = settings.faviconUrl;
      if (/\.svg(\?|$)/i.test(url)) link.type = 'image/svg+xml';
      else if (/\.png(\?|$)/i.test(url)) link.type = 'image/png';
      else link.removeAttribute('type');
      link.href = url;
    }
  }, [settings.__loaded, settings.shopName, settings.faviconUrl]);

  const value = useMemo(
    () => ({ ...settings, __heroStyle: resolved.heroStyle, __cardStyle: resolved.cardStyle }),
    [settings, resolved],
  );

  return <StoreSettingsContext.Provider value={value}>{children}</StoreSettingsContext.Provider>;
}
