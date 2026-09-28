/**
 * scripts/cf-port/migrate/lib/transform-branding.mjs — the branding images of
 * the store identity (D76, docs/cf-port/CP4_D_REPORT.md item 10) → ONE UPDATE
 * of the `tenant_settings.store_identity_json` CP3 imported, per shop:
 *
 *   storeIdentity.logoUrl        → logoObjectId
 *   storeIdentity.heroImageUrl   → heroObjectId
 *   storeIdentity.faviconUrl     → faviconObjectId
 *   storeIdentity.emailLogoUrl   → emailLogoObjectId
 *   storeIdentity.gallery[i].imageUrl → gallery[i].imageObjectId
 *   storeIdentity.menu           → menu, only when the target's identity has none
 *
 * Each object id is a copied object of THIS shop of kind `shop_branding` (the
 * kind every reader of these keys asks for). The identity the UPDATE writes is
 * the target's own (read by --target-state), with the refused keys dropped by
 * the Worker's sanitizeStoreIdentity, the ids set, and the whole object passed
 * through the Worker's parseStoreSettingsInput — the parser of
 * PUT /v1/admin/settings — so it is an identity the admin route would accept.
 * A string of the identity that still names the source's storage (CP3
 * removed two hosts; the Worker refuses five markers) is removed with it.
 * An id already set in the target is never overwritten (an admin may have
 * chosen another image since CP3). The UPDATE is guarded on the row as the
 * target state read it (updated_at, updated_by, its length): when the identity
 * changed after the target state was read, it changes nothing, and
 * verify-catalogue says so.
 */

import { updateStatement } from './sql.mjs';
import { carriedRow, rowContentHash } from './plan.mjs';
import { count, IMPORT_ACTOR, isoOf, resolveImage } from './transform-products.mjs';

/** source key → identity key (the four top-level images of D's projection). */
export const BRANDING_KEYS = Object.freeze({
  emailLogoUrl: 'emailLogoObjectId',
  faviconUrl: 'faviconObjectId',
  heroImageUrl: 'heroObjectId',
  logoUrl: 'logoObjectId',
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The identity without any string that names the source's storage, at any
 * depth (the key is dropped, an array entry removed), by the Worker's own
 * isSourceStorageAddress: PUT /v1/admin/settings refuses such an identity, and
 * CP3 removed only the two hosts it knew. Returns { value, removed }.
 */
function withoutSourceAddresses(value, isSourceStorageAddress) {
  let removed = 0;
  const walk = (node) => {
    if (Array.isArray(node)) {
      return node.filter((entry) => {
        const drop = typeof entry === 'string' && isSourceStorageAddress(entry);
        if (drop) removed += 1;
        return !drop;
      }).map(walk);
    }
    if (isPlainObject(node)) {
      return Object.fromEntries(
        Object.entries(node).filter(([, child]) => {
          const drop = typeof child === 'string' && isSourceStorageAddress(child);
          if (drop) removed += 1;
          return !drop;
        }).map(([key, child]) => [key, walk(child)]),
      );
    }
    return node;
  };
  const cleaned = walk(value);
  return { removed, value: cleaned };
}

/**
 * @param {object} args
 * @param {object} args.ctx      the shared context (transform-products.mjs)
 * @param {object[]} args.shops  decoded `shops` documents
 * @param {Map} args.tenants     the shops this plan writes into
 * @param {Map} args.settings    tenantId → { storeIdentityJson, updatedAt, updatedBy } as the target holds it
 * @returns {{ sections, expected: { [tenantId]: { [path]: objectId } } }}
 */
export function transformBranding({ ctx, settings, shops, tenants }) {
  const { nowMillis, report, rules } = ctx;
  const sections = { tenant_settings: [] };
  const expected = {};

  const sorted = [...shops].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const doc of sorted) {
    const tenantId = doc.id;
    if (!tenants.has(tenantId)) continue;
    const source = isPlainObject(doc.data?.storeIdentity) ? doc.data.storeIdentity : {};

    // What the source names, resolved to this shop's copied branding objects.
    const wanted = [];
    for (const [sourceKey, identityKey] of Object.entries(BRANDING_KEYS)) {
      const address = source[sourceKey];
      if (typeof address !== 'string' || address.trim().length === 0) continue;
      const image = resolveImage(ctx, tenantId, address, 'shop_branding');
      if (image.status === 'copied') wanted.push({ objectId: image.objectId, path: identityKey });
      else count(report, tenantId, `branding_left_out:${image.status}`);
    }
    const gallery = Array.isArray(source.gallery) ? source.gallery : [];
    gallery.forEach((tile, index) => {
      const address = isPlainObject(tile) ? tile.imageUrl : undefined;
      if (typeof address !== 'string' || address.trim().length === 0) return;
      const image = resolveImage(ctx, tenantId, address, 'shop_branding');
      if (image.status === 'copied') wanted.push({ index, objectId: image.objectId, path: `gallery[${index}].imageObjectId` });
      else count(report, tenantId, `branding_left_out:${image.status}`);
    });
    const sourceMenu = Array.isArray(source.menu) ? source.menu : null;

    const target = settings.get(tenantId);
    if (target === undefined) {
      if (wanted.length > 0 || sourceMenu !== null) count(report, tenantId, 'branding_left_out:no_settings_row_in_target', wanted.length);
      continue;
    }
    let current;
    try {
      current = JSON.parse(target.storeIdentityJson);
    } catch {
      current = null;
    }
    if (!isPlainObject(current)) {
      ctx.problems.push(`REFUSED: tenant_settings of ${tenantId} in the target is not a JSON object`);
      continue;
    }

    const cleaned = withoutSourceAddresses(rules.sanitizeStoreIdentity(current), rules.isSourceStorageAddress);
    const next = cleaned.value;
    const written = {};
    for (const want of wanted) {
      if (want.index === undefined) {
        if (typeof next[want.path] === 'string' && next[want.path].length > 0) {
          count(report, tenantId, 'branding_kept_target_value');
          continue;
        }
        next[want.path] = want.objectId;
      } else {
        const tiles = Array.isArray(next.gallery) ? next.gallery : null;
        const tile = tiles === null ? undefined : tiles[want.index];
        if (!isPlainObject(tile)) {
          count(report, tenantId, 'branding_left_out:gallery_tile_not_in_target');
          continue;
        }
        if (typeof tile.imageObjectId === 'string' && tile.imageObjectId.length > 0) {
          count(report, tenantId, 'branding_kept_target_value');
          continue;
        }
        next.gallery = tiles.map((entry, i) => (i === want.index ? { ...entry, imageObjectId: want.objectId } : entry));
      }
      written[want.path] = want.objectId;
    }
    let menuWritten = false;
    if (sourceMenu !== null) {
      if (Array.isArray(next.menu)) count(report, tenantId, 'menu_already_in_target');
      else {
        next.menu = JSON.parse(ctx.textScrub(JSON.stringify(sourceMenu), `shops/${tenantId}.storeIdentity.menu`));
        menuWritten = true;
        count(report, tenantId, 'menu_written');
      }
    }
    if (cleaned.removed > 0) count(report, tenantId, 'identity_source_addresses_removed', cleaned.removed);
    if (Object.keys(written).length === 0 && !menuWritten && cleaned.removed === 0) continue;

    const parsed = rules.parseStoreSettingsInput({ storeIdentity: next });
    if (parsed.status !== 'ok') {
      count(report, tenantId, `branding_left_out:identity_${parsed.status}`, Object.keys(written).length);
      continue;
    }
    const refs = rules.storeIdentityImageRefs(JSON.parse(parsed.input.storeIdentityJson));
    const refMap = Object.fromEntries(refs.map((ref) => [ref.path, ref.objectId]));
    if (Object.entries(written).some(([path, objectId]) => refMap[path] !== objectId)) {
      ctx.problems.push(`INTERNAL: tenant_settings of ${tenantId}: an image id the Worker would not read back`);
      continue;
    }

    const values = {
      store_identity_json: parsed.input.storeIdentityJson,
      updated_at: isoOf(nowMillis),
      updated_by: IMPORT_ACTOR,
    };
    // The guard: the row as the target state read it (its last writer, its
    // time, its length in bytes). An admin write since then moves updated_at
    // and updated_by, and this UPDATE then changes nothing. The old text itself
    // is not repeated in the plan.
    const guarded = updateStatement('tenant_settings', values, { tenant_id: tenantId, updated_at: target.updatedAt, updated_by: target.updatedBy });
    const statement = `${guarded.slice(0, -1)} AND length(CAST(store_identity_json AS BLOB)) = ${Buffer.byteLength(target.storeIdentityJson, 'utf8')};`;
    const columns = ['tenant_id', 'store_identity_json', 'updated_at', 'updated_by'];
    sections.tenant_settings.push(
      carriedRow('tenant_settings', `${tenantId}#catalogue-branding`, statement, rowContentHash('tenant_settings', columns, { ...values, tenant_id: tenantId })),
    );
    expected[tenantId] = { images: refMap, menuWritten };
    for (const path of Object.keys(written)) count(report, tenantId, `branding_written:${path.startsWith('gallery[') ? 'gallery' : path}`);
  }
  return { expected, sections };
}
