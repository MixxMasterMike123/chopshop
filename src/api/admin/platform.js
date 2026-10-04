// The platform console's calls (CP5 brief FI and FJ; the Worker:
// cloudflare/src/routes/platform-*.ts and pod-platform.ts). Every call is a
// `platformRequest`: it never carries X-Shop-Id (D70). Two units write this
// file, each in its own marked section; re-read it before an edit.

import { platformRequest, segment, withQuery } from './client.js';
import { AdminApiError, adminRequest } from './client.js'; // CP5-FI (its own line, so neither unit edits the other's)

// ═══ CP5-FJ ═════════════════════════════════════════════════════════════════
// Add-ons (features), users, infringement reports, the screening queue.
//
//   GET  /v1/platform/tenants[?cursor&limit]           { tenants: [{tenantId, shopName, status, …}], nextCursor }
//   GET  /v1/platform/tenants/:id/features             { features: [{key, enabled, defaultEnabled, source}], tenantId }
//   PUT  /v1/platform/tenants/:id/features             { features: {key: boolean} } → the same
//   GET  /v1/platform/users[?accountType&tenantId&cursor&limit]   { users: [DirectoryUser], nextCursor }
//   GET  /v1/platform/users/:id                        { user }
//   POST /v1/platform/users/:id/deactivate | reactivate           { user } · 409 { error: { code } }
//   POST /v1/platform/users/:id/invite                 202 { invite } · 409 not_invitable · 503 email_unavailable
//   GET  /v1/platform/reports[?status&tenantId&cursor&limit]      { reports, nextCursor, newCount }
//   GET  /v1/platform/reports/:id                      { report }
//   POST /v1/platform/reports/:id/handle               { status: 'reviewing'|'rejected', note? } → { report }
//   POST /v1/platform/reports/:id/takedown             { note?, productId? } → { report, screening }
//   GET  /v1/platform/screening[?status]               { screening: [PlatformScreeningView] }  (at most 100)
//   POST /v1/platform/screening/:productId             { decision: 'approved'|'blocked' } → { screening }
//
// A list is read to its end, a page at a time, up to MAX_PAGES (the console
// has a handful of shops and users; the cap stops a runaway cursor).

const PAGE = 100;
const MAX_PAGES = 20;

async function readPages(path, params, listKey, { signal } = {}) {
  const rows = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data } = await platformRequest('GET', withQuery(path, { ...params, limit: PAGE, cursor }), { signal });
    if (Array.isArray(data?.[listKey])) rows.push(...data[listKey]);
    cursor = typeof data?.nextCursor === 'string' && data.nextCursor !== '' ? data.nextCursor : null;
    if (cursor === null) return rows;
  }
  return rows;
}

// ── shops and their add-ons ─────────────────────────────────────────────────

/** Every shop: [{ tenantId, shopName, status, published, … }]. */
export function readAllTenants({ signal } = {}) {
  return readPages('/v1/platform/tenants', {}, 'tenants', { signal });
}

/** One shop's add-ons: [{ key, enabled, defaultEnabled, source }]. */
export async function getTenantFeatures(tenantId, { signal } = {}) {
  const { data } = await platformRequest('GET', `/v1/platform/tenants/${segment(tenantId)}/features`, { signal });
  return Array.isArray(data?.features) ? data.features : [];
}

/** Sets the named add-ons ({ key: boolean }); the others keep their value. → the shop's add-ons. */
export async function putTenantFeatures(tenantId, values) {
  const { data } = await platformRequest('PUT', `/v1/platform/tenants/${segment(tenantId)}/features`, {
    json: { features: values },
  });
  return Array.isArray(data?.features) ? data.features : [];
}

// ── users ───────────────────────────────────────────────────────────────────

/** One page: { users, nextCursor }. */
export async function listPlatformUsers({ accountType, tenantId, cursor, limit, signal } = {}) {
  const { data } = await platformRequest('GET', withQuery('/v1/platform/users', { accountType, tenantId, cursor, limit }), { signal });
  return {
    users: Array.isArray(data?.users) ? data.users : [],
    nextCursor: typeof data?.nextCursor === 'string' ? data.nextCursor : null,
  };
}

/** Every user of the given account types (one filtered read per type), each read to its end. */
export async function readAllPlatformUsers(accountTypes, { tenantId, signal } = {}) {
  const lists = await Promise.all(
    accountTypes.map((accountType) => readPages('/v1/platform/users', { accountType, tenantId }, 'users', { signal })),
  );
  return lists.flat();
}

export async function getPlatformUser(userId, { signal } = {}) {
  const { data } = await platformRequest('GET', `/v1/platform/users/${segment(userId)}`, { signal });
  return data?.user ?? null;
}

async function userAction(userId, action) {
  const { data } = await platformRequest('POST', `/v1/platform/users/${segment(userId)}/${action}`);
  return data?.user ?? null;
}

/** → the user. 409 refusals (cannot_deactivate_self, last_platform_admin, not_active, no_identity) reject with `.code`. */
export const deactivatePlatformUser = (userId) => userAction(userId, 'deactivate');
/** → the user. 409 refusals (not_suspended, platform_admin_reactivation, no_identity) reject with `.code`. */
export const reactivatePlatformUser = (userId) => userAction(userId, 'reactivate');

/** → { userId, surface, expiresAt }. 409 not_invitable, 503 email_unavailable, 404 where invites are not configured. */
export async function invitePlatformUser(userId) {
  const { data } = await platformRequest('POST', `/v1/platform/users/${segment(userId)}/invite`);
  return data?.invite ?? null;
}

// ── infringement reports ────────────────────────────────────────────────────

/** Every report, newest first: [PlatformReportView]. */
export function readAllReports({ status, tenantId, signal } = {}) {
  return readPages('/v1/platform/reports', { status, tenantId }, 'reports', { signal });
}

export async function getReport(reportId, { signal } = {}) {
  const { data } = await platformRequest('GET', `/v1/platform/reports/${segment(reportId)}`, { signal });
  return data?.report ?? null;
}

/** status 'reviewing' | 'rejected', optional note (null or '' clears it). → the report. */
export async function handleReport(reportId, { status, note } = {}) {
  const json = { status };
  if (note !== undefined) json.note = note;
  const { data } = await platformRequest('POST', `/v1/platform/reports/${segment(reportId)}/handle`, { json });
  return data?.report ?? null;
}

/** Takes the report's product down. → { report, screening }. 409: report_closed, product_mismatch, tenant_mismatch, conflict. */
export async function takedownReport(reportId, { productId, note } = {}) {
  const json = {};
  if (productId !== undefined) json.productId = productId;
  if (note !== undefined) json.note = note;
  const { data } = await platformRequest('POST', `/v1/platform/reports/${segment(reportId)}/takedown`, { json });
  return { report: data?.report ?? null, screening: data?.screening ?? null };
}

// ── the screening queue ─────────────────────────────────────────────────────

/** The queue (pending, flagged, blocked; oldest first, at most 100): [PlatformScreeningView]. */
export async function listScreening({ status, signal } = {}) {
  const { data } = await platformRequest('GET', withQuery('/v1/platform/screening', { status }), { signal });
  return Array.isArray(data?.screening) ? data.screening : [];
}

/** decision 'approved' (also lifts a takedown) | 'blocked' (takes the product down). → the view. */
export async function decideScreening(productId, decision) {
  const { data } = await platformRequest('POST', `/v1/platform/screening/${segment(productId)}`, { json: { decision } });
  return data?.screening ?? null;
}

// ═══ end CP5-FJ ═════════════════════════════════════════════════════════════

// ═══ CP5-FI ═════════════════════════════════════════════════════════════════
// The shops: the list (FJ's readAllTenants above), one shop's detail, its
// status, the go-live gate, the commission and the Connect opt-in, and the
// provisioning of a shop and of its first admin. PLATFORM-ONLY facts
// (commission, Connect): only the platform console's data modules import
// this section; no module of the admin tree may.
//
//   GET    /v1/platform/tenants/:id                  { tenant: {…, commissionBps, connect}, features, domains, settings }
//   PATCH  /v1/platform/tenants/:id                  { commissionBps | shopName | supportEmail | vatRateBp } → the detail
//                                                    400 invalid_request (e.g. over the commission cap) · 409 closed
//   POST   /v1/platform/tenants/:id/publish|unpublish  → the detail · 409 closed
//   POST   /v1/platform/tenants/:id/activate|suspend   { tenant } · 409 tenant_closed
//   GET    /v1/platform/tenants/:id/connect          { connect: { enabled, chargesEnabled, accountId, … }, operations }
//   POST   /v1/platform/tenants/:id/connect/enable|disable   { connect }
//   POST   /v1/platform/tenants                      { tenantId, shopName, hostname } 201 { tenant } · 409 conflict
//   POST   /v1/platform/users                        { accountType, email } 201 { user } · 409 conflict
//                                                    (no password: created password-less, CP5-WJ4)
//   POST   /v1/platform/tenants/:id/admins           { userId } 201 { membership } · 409 conflict
//   POST   /v1/admin/preview   (X-Shop-Id; membership or an open acting-as grant)   { preview: { grant, expiresAt } }

/** One shop's platform detail, or null when the API answers the opaque 404. */
export async function getTenantDetail(tenantId, { signal } = {}) {
  try {
    const { data } = await platformRequest('GET', `/v1/platform/tenants/${segment(tenantId)}`, { signal });
    return data && typeof data === 'object' && data.tenant ? data : null;
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 404) return null;
    throw error;
  }
}

/** Platform-set fields ({ commissionBps } | shopName | supportEmail | vatRateBp). → the detail. */
export async function patchTenant(tenantId, patch) {
  const { data } = await platformRequest('PATCH', `/v1/platform/tenants/${segment(tenantId)}`, { json: patch });
  return data ?? null;
}

/** The go-live gate: true → publish, false → unpublish. → the detail. */
export async function setTenantPublished(tenantId, published) {
  const action = published ? 'publish' : 'unpublish';
  const { data } = await platformRequest('POST', `/v1/platform/tenants/${segment(tenantId)}/${action}`);
  return data ?? null;
}

/** 'active' → activate, 'suspended' → suspend. → { tenant }. A closed shop: 409 tenant_closed. */
export async function setTenantStatus(tenantId, status) {
  const action = status === 'active' ? 'activate' : 'suspend';
  const { data } = await platformRequest('POST', `/v1/platform/tenants/${segment(tenantId)}/${action}`);
  return data?.tenant ?? null;
}

/** The shop's Connect view (the platform's): { enabled, chargesEnabled, accountId, … }, or null on 404. */
export async function getTenantConnect(tenantId, { signal } = {}) {
  try {
    const { data } = await platformRequest('GET', `/v1/platform/tenants/${segment(tenantId)}/connect`, { signal });
    return data?.connect ?? null;
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 404) return null;
    throw error;
  }
}

/** The Connect opt-in (the seller may start onboarding). → the Connect view. */
export async function setTenantConnectEnabled(tenantId, enabled) {
  const action = enabled ? 'enable' : 'disable';
  const { data } = await platformRequest('POST', `/v1/platform/tenants/${segment(tenantId)}/connect/${action}`);
  return data?.connect ?? null;
}

/** A new shop with its first storefront hostname. → { tenantId, shopName, status, … }. 409: the id or hostname is taken. */
export async function createTenant({ tenantId, shopName, hostname }) {
  const { data } = await platformRequest('POST', '/v1/platform/tenants', { json: { tenantId, shopName, hostname } });
  return data?.tenant ?? null;
}

/**
 * The storefront hostname a shop made in the console starts with. The API
 * needs one at creation; the storefront on the shared host finds a shop by its
 * path and then by this hostname (D77), so a placeholder under the reserved
 * `.invalid` name (RFC 2606) serves until the shop gets its own domain (D89).
 * The importer's shops have `<id>.import.invalid` the same way.
 */
export function provisionHostnameFor(tenantId) {
  return `${tenantId}.provisioned.invalid`;
}

/**
 * A new shop admin identity, invited by the caller. → { userId, email, accountType }. 409: the address is taken.
 * No password is sent: the API creates the identity password-less in one step
 * (provision-users.ts createInvitedUser, CP5-WJ4), and the person sets their
 * own from the invite's link. Until then the directory reads `hasPassword: false`.
 */
export async function createTenantAdminUser(email) {
  const { data } = await platformRequest('POST', '/v1/platform/users', {
    json: { accountType: 'tenant_admin', email },
  });
  return data?.user ?? null;
}

/** Makes `userId` an admin of `tenantId`. → the membership. */
export async function grantTenantAdmin(tenantId, userId) {
  const { data } = await platformRequest('POST', `/v1/platform/tenants/${segment(tenantId)}/admins`, { json: { userId } });
  return data?.membership ?? null;
}

/**
 * A preview grant of an unpublished shop for its storefront (CP4-D2). An admin
 * route: it needs the shop's admin context, which a platform user holds only
 * through an open acting-as grant on that shop. → { grant, expiresAt }.
 */
export async function requestStorefrontPreview(shopId) {
  const { data } = await adminRequest('POST', '/v1/admin/preview', { shopId });
  return data?.preview ?? null;
}

// ═══ end CP5-FI ═════════════════════════════════════════════════════════════

// ═══ CP5-FK ═════════════════════════════════════════════════════════════════
// The printers (cloudflare/src/routes/pod-platform.ts, "CP3: the platform
// printer surface"; CP3_C_REPORT.md §3). PLATFORM-ONLY: these answers carry
// every price and print frame the platform holds (the seller sees ONE
// number). Only the platform console's printer page imports this section; no
// module of the admin tree may. The Worker refuses each of these routes with
// the opaque 404 when the request names a shop, and the whole surface is dark
// (404) in an environment without a dispatch target.
//
//   GET   /v1/platform/printers[?cursor&limit≤50]   { printers: [PlatformPrinterView], nextCursor, defaultPrinterId }
//   PATCH /v1/platform/printers/:id                 { name?, status?, shippingCostMinor?, capabilities? (whole),
//                                                     tiers?: { upsert?: [{ sku, blankCostMinor, printCostsMinor }], remove?: [sku] },
//                                                     expectedRevision? }
//                                                   → { printer, diff, suspendedMappings }
//                                                   400 invalid_request | invalid_tiers | invalid_capabilities | printer_not_allowed (+ problems)
//                                                   409 revision_mismatch | concurrent_edit | tenant_printer | too_many_mappings
//   PUT   /v1/platform/printers/default             { printerId: id | null } → { defaultPrinter: { printerId, printerActive, … } } · 422 printer_not_found | printer_inactive | tenant_printer
// The page needs no other call: the list carries every printer whole and the
// default's id. The single read (GET …/:id, GET …/default) and the supplier
// catalogue (GET/PUT …/:id/catalog, POST …/catalog/apply) have no control on
// the page and no call here.

const PRINTER_PAGE = 50; // the Worker's PLATFORM_PRINTER_PAGE_MAX

/** Every printer, read to the end of its cursor: { printers: [PlatformPrinterView], defaultPrinterId }. */
export async function readAllPrinters({ signal } = {}) {
  const printers = [];
  let cursor = null;
  let defaultPrinterId = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data } = await platformRequest('GET', withQuery('/v1/platform/printers', { limit: PRINTER_PAGE, cursor }), { signal });
    if (Array.isArray(data?.printers)) printers.push(...data.printers);
    if (page === 0) defaultPrinterId = typeof data?.defaultPrinterId === 'string' ? data.defaultPrinterId : null;
    cursor = typeof data?.nextCursor === 'string' && data.nextCursor !== '' ? data.nextCursor : null;
    if (cursor === null) break;
  }
  return { printers, defaultPrinterId };
}

/** A partial edit (the body as the route takes it). → { printer, diff, suspendedMappings }. */
export async function patchPrinter(printerId, body) {
  const { data } = await platformRequest('PATCH', `/v1/platform/printers/${segment(printerId)}`, { json: body });
  return {
    printer: data?.printer ?? null,
    diff: data?.diff ?? null,
    suspendedMappings: Number.isInteger(data?.suspendedMappings) ? data.suspendedMappings : 0,
  };
}

/** Sets (an id) or clears (null) the default printer. → { printerId, printerActive, updatedAt, updatedBy }. */
export async function putDefaultPrinter(printerId) {
  const { data } = await platformRequest('PUT', '/v1/platform/printers/default', { json: { printerId } });
  return data?.defaultPrinter ?? null;
}

// ═══ end CP5-FK ═════════════════════════════════════════════════════════════

// ═══ CP5-FO ═════════════════════════════════════════════════════════════════
// The platform's 3D models for the design studio's 3D view, and the studio
// files they name (cloudflare/src/routes/pod-studio-assets.ts; CP5_WH_REPORT.md
// "Platform"). PLATFORM-ONLY: only the platform console's models page imports
// this section. No route here deletes anything: a model is deactivated, and a
// studio file stays in the public bucket.
//
//   GET   /v1/platform/pod/3d-models             { models: [PlatformModel], files: { fileId: StudioFile } }
//                                                (inactive models too; files = every active file they name)
//   PUT   /v1/platform/pod/3d-models/:modelId    the whole document → 201 (created) | 200 { changed, model }
//                                                400 invalid_request (reason: file_not_found | not_registered |
//                                                duplicate_colorway, or none) · 409 limit_reached · 413
//   PATCH /v1/platform/pod/3d-models/:modelId    { active } → 200 { changed, model } · 404 unknown id
//   POST  /v1/platform/pod/studio-files          the raw bytes, Content-Type image/png|jpeg|webp|avif
//                                                → 201 | 200 (the same bytes were stored) { file }
//                                                400 (reason: not_an_allowed_image | type_not_as_stated) ·
//                                                413 (over 15 MiB) · 409 conflict · 404 (dark: no public bucket)

/** Every model, inactive ones included, and the files they name: { models, files }. */
export async function readAll3dModels({ signal } = {}) {
  const { data } = await platformRequest('GET', '/v1/platform/pod/3d-models', { signal });
  return {
    models: Array.isArray(data?.models) ? data.models : [],
    files: data?.files && typeof data.files === 'object' && !Array.isArray(data.files) ? data.files : {},
  };
}

/** Creates or replaces a model whole. → { model, changed, created }. */
export async function put3dModel(modelId, body) {
  const { status, data } = await platformRequest('PUT', `/v1/platform/pod/3d-models/${segment(modelId)}`, { json: body });
  return { model: data?.model ?? null, changed: data?.changed === true, created: status === 201 };
}

/** Activates or deactivates a model. → { model, changed }. */
export async function set3dModelActive(modelId, active) {
  const { data } = await platformRequest('PATCH', `/v1/platform/pod/3d-models/${segment(modelId)}`, { json: { active } });
  return { model: data?.model ?? null, changed: data?.changed === true };
}

/** One image (a Blob) as a studio file, its type stated. → { fileId, url, width, height, … }. */
export async function uploadStudioFile(blob, contentType = blob?.type) {
  const { data } = await platformRequest('POST', '/v1/platform/pod/studio-files', { body: blob, contentType });
  return data?.file ?? null;
}

// ═══ end CP5-FO ═════════════════════════════════════════════════════════════
