// PlatformAddons' data layer: the ADMIN build's implementation (CP5 brief FJ).
// The alias list of vite.admin.config.js puts this module in place of
// src/pages/platform/platformAddonsData.js (the older build's, Firebase); both
// export the same names with the same meaning, so the page is the same file in
// both builds.
//
// The shops are GET /v1/platform/tenants; each shop's add-ons are
// GET /v1/platform/tenants/:id/features (one read per shop), and a switch is
// PUT …/features with the one key. The page's `features` map holds the
// EFFECTIVE value of each key, so its own isFeatureEnabled() reads it as the
// server does.
//
// Which columns exist is the Worker's list (tenant-config.ts): the affiliate
// and wholesale add-ons (not ported, D62) and the four deleted CRM add-ons
// (D2) are refused by the PUT, so their columns leave. Closed shops are not
// listed (closed is final).

import { ADDON_CATALOG } from '../../config/addons.js';
import { getTenantFeatures, putTenantFeatures, readAllTenants } from '../../api/admin/platform.js';
import { columnsOf, listedTenants, shopRowOf, sortShops } from '../adapters/platformConsole.js';

export const ADDON_COLUMNS = columnsOf(ADDON_CATALOG);

/** The note under the table, without the sentence about the affiliate add-on (it has no column here). */
export const ADDONS_FOOTNOTE = 'Tillägg styrs endast härifrån (plattformsnivå).';

/** Every shop, sorted by name: [{ id, name, features }]. */
export async function loadShops() {
  const tenants = listedTenants(await readAllTenants());
  const rows = await Promise.all(
    tenants.map(async (tenant) => shopRowOf(tenant, await getTenantFeatures(tenant.tenantId))),
  );
  return sortShops(rows);
}

/** Sets one add-on of one shop; the others keep their value. */
export async function writeAddon(shop, key, next) {
  await putTenantFeatures(shop.id, { [key]: next });
}
