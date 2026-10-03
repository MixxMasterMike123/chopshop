// "Öppna storefront" from the platform console (CP5 brief FI), shared by the
// list's and the detail's data modules of the admin build.
//
// A published shop: its storefront, as before. An UNPUBLISHED shop has no
// public storefront here (D57: the catalogue answers 404, not only noindex),
// so the link opens its PREVIEW when the platform user holds an open
// acting-as grant on that shop (POST /v1/admin/preview needs the shop's admin
// context: the grant + X-Shop-Id; CP4-D2 reviewer wiring 1). Without a grant
// the plain link opens, as before; no new control is added.
//
// The tab is opened inside the click (no popup blocker) and pointed at its
// address once the grant is in hand.

import toast from 'react-hot-toast';
import { getMeRaw } from '../../api/admin/client.js';
import { requestStorefrontPreview } from '../../api/admin/platform.js';
import { hasOpenGrant, previewUrlOf } from '../adapters/platformShops.js';
import { APP_URLS } from './urls.js';

function go(tab, url) {
  if (tab) {
    tab.opener = null;
    tab.location.href = url;
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

export async function openStorefrontOf(shop) {
  const plain = `${APP_URLS.B2C_SHOP}/${shop.id}`;
  if (shop.published !== false) {
    window.open(plain, '_blank', 'noopener');
    return;
  }
  const tab = window.open('', '_blank');
  try {
    if (hasOpenGrant(await getMeRaw(), shop.id)) {
      const preview = await requestStorefrontPreview(shop.id);
      if (preview?.grant) {
        go(tab, previewUrlOf(APP_URLS.B2C_SHOP, shop.id, preview.grant));
        const minutes = Math.round((Date.parse(preview.expiresAt) - Date.now()) / 60000);
        toast.success(Number.isFinite(minutes) && minutes > 0
          ? `Förhandsvisning öppnad – gäller i ${minutes} minuter`
          : 'Förhandsvisning öppnad');
        return;
      }
    }
  } catch (error) {
    console.warn('Preview not available, opening the storefront:', error?.code || error?.message);
  }
  go(tab, plain);
}
