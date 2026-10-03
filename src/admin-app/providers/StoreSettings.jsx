// The admin build's replacement for src/contexts/StoreSettingsContext.jsx
// (alias list, vite.admin.config.js). `useStoreSettings()` returns the same
// value: the static STORE defaults, overridden key by key with the active
// shop's saved values, `__loaded` once the read is over, and the resolved
// `__heroStyle`/`__cardStyle`. Fed by `GET /v1/admin/settings` (the store
// identity and the gate fields) and the shop of `GET /v1/admin/shop` (name,
// support address, currency, VAT; shapes.js settingsFromAdmin).
//
// The identity names its images by object id (`logoObjectId`,
// `faviconObjectId`); the shell reads `logoUrl` and the tab `faviconUrl`, so
// those two are looked up (`GET /v1/admin/objects/:id` → `url`). A lookup
// that answers no address leaves the default (the shell then shows its
// wordmark).
//
// The theme and the tab identity below are the Firebase provider's code,
// line for line, as the storefront's copy keeps them.

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { STORE } from '../../config/store';
import { resolveTheme, ensureTemplateFonts } from '../../config/nordTokens';
import { getTemplate } from '../../config/templates';
import { adminRequest } from '../../api/admin/client.js';
import { getObject } from '../../api/admin/uploads.js';
import { useActiveShop } from './ActiveShop.jsx';
import { useAdminShop } from './ShopFeatures.jsx';
import { mergeSettings, settingsFromAdmin } from './shapes.js';

const StoreSettingsContext = createContext(STORE);

export function useStoreSettings() {
  return useContext(StoreSettingsContext);
}

async function imageUrl(objectId, shopId, signal) {
  if (typeof objectId !== 'string' || objectId === '') return null;
  const object = await getObject(objectId, { shopId, signal }).catch(() => null);
  return typeof object?.url === 'string' ? object.url : null;
}

export function StoreSettingsProvider({ children }) {
  const { shopId } = useActiveShop();
  const { shop, status: shopStatus } = useAdminShop();
  const [read, setRead] = useState({ shopId: null, settings: null, images: {}, done: false });

  useEffect(() => {
    if (!shopId) {
      setRead({ shopId: null, settings: null, images: {}, done: false });
      return undefined;
    }
    const controller = new AbortController();
    const { signal } = controller;
    setRead({ shopId, settings: null, images: {}, done: false });
    (async () => {
      let settings = null;
      try {
        const { data } = await adminRequest('GET', '/v1/admin/settings', { shopId, signal });
        settings = data?.settings ?? null;
      } catch (error) {
        if (error?.name === 'AbortError') return;
        console.warn('StoreSettings: using defaults (could not load the settings):', error?.message);
      }
      const identity = settings?.storeIdentity ?? {};
      const [logoUrl, faviconUrl] = await Promise.all([
        imageUrl(identity.logoObjectId, shopId, signal),
        imageUrl(identity.faviconObjectId, shopId, signal),
      ]);
      if (signal.aborted) return;
      setRead({ shopId, settings, images: { logoUrl, faviconUrl }, done: true });
    })();
    return () => controller.abort();
  }, [shopId]);

  const settings = useMemo(() => {
    if (!shopId || read.shopId !== shopId || !read.done || shopStatus === 'loading') return STORE;
    const saved = settingsFromAdmin(read.settings, shop);
    if (read.images.logoUrl) saved.logoUrl = read.images.logoUrl;
    if (read.images.faviconUrl) saved.faviconUrl = read.images.faviconUrl;
    return mergeSettings(saved);
  }, [shopId, read, shop, shopStatus]);

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
