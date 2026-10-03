// The admin pages' links to the storefront — the ADMIN build's (CP5-FX,
// finding 9). The alias list of vite.admin.config.js puts this module in
// place of src/pages/admin/storefrontLinks.js (the older build's: paths on the
// admin's own origin). Same names, same meaning; the one helper behind
// AdminStorefront's "Förhandsgranska butik", the pages list's and the page
// editor's "Visa sida" and the collection editor's "Visa".
//
// An address is the storefront's origin (VITE_STOREFRONT_ORIGIN) + the active
// shop + the storefront's path (adapters/storefrontLinks.js). A published shop
// (GET /v1/admin/shop `published`) opens it as a plain link. An unpublished
// one opens its PREVIEW: the click opens the tab at once (no popup blocker),
// asks POST /v1/admin/preview for a grant, then points the tab at the address
// with `#preview=<grant>` (valid 30 minutes).

import { useMemo } from 'react';
import toast from 'react-hot-toast';
import { requestStorefrontPreview } from '../../api/admin/platform.js';
import { isUnresolvedShopId } from '../../config/tenancy';
import { useShopId } from '../providers/ActiveShop.jsx';
import { useAdminShop } from '../providers/ShopFeatures.jsx';
import {
  collectionPath,
  homePath,
  pagePath,
  storefrontLinkProps,
  storefrontUrl,
  withPreviewGrant,
} from '../adapters/storefrontLinks.js';
import { APP_URLS } from './urls.js';

/** Opens the preview of `path` of an unpublished shop in a new tab. */
export async function openStorefrontPreview(shopId, path) {
  const tab = window.open('', '_blank');
  try {
    const preview = await requestStorefrontPreview(shopId);
    if (typeof preview?.grant !== 'string' || preview.grant === '') throw new Error('No preview grant');
    const url = withPreviewGrant(storefrontUrl(APP_URLS.B2C_SHOP, shopId, path), preview.grant);
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else {
      window.open(url, '_blank', 'noopener');
    }
    const minutes = Math.round((Date.parse(preview.expiresAt) - Date.now()) / 60000);
    toast.success(Number.isFinite(minutes) && minutes > 0
      ? `Förhandsvisning öppnad – gäller i ${minutes} minuter`
      : 'Förhandsvisning öppnad');
  } catch (error) {
    console.warn('Preview not available:', error?.code || error?.message);
    tab?.close();
    toast.error('Förhandsvisningen kunde inte öppnas. Försök igen.');
  }
}

/** `{ home(), page(slug), collection(handle) }`, each the props of its link. */
export function useStorefrontLinks() {
  const active = useShopId();
  const shopId = isUnresolvedShopId(active) ? null : active;
  const { shop } = useAdminShop();
  const published = shop?.published === true;
  return useMemo(() => {
    const link = (path) =>
      storefrontLinkProps({ origin: APP_URLS.B2C_SHOP, shopId, published, path, openPreview: openStorefrontPreview });
    return {
      home: () => link(homePath()),
      page: (slug) => link(pagePath(slug)),
      collection: (handle) => link(collectionPath(handle)),
    };
  }, [shopId, published]);
}
