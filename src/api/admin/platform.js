// The platform console's calls (CP5 brief FI and FJ; the Worker:
// cloudflare/src/routes/platform-*.ts and pod-platform.ts). Every call is a
// `platformRequest`: it never carries X-Shop-Id (D70). Two units write this
// file, each in its own marked section; re-read it before an edit.

import { platformRequest, segment, withQuery } from './client.js';
import { AdminApiError, adminRequest } from './client.js'; // CP5-FI (its own line, so neither unit edits the other's)

// ═══ CP5-FJ ═════════════════════════════════════════════════════════════════
// Add-ons (features), users, infringement reports, the screening queue.
//
//   GET  /v1/platform/tenants[?cursor&limit&counts=1]  { tenants: [{tenantId, shopName, status, …, counts?}], nextCursor }
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

/**
 * Every shop: [{ tenantId, shopName, status, published, … }]. `counts`: each
 * row also carries `counts: { products, publishedProducts, orders }`
 * (?counts=1, CP5-WK; unit CP5-FP).
 */
export function readAllTenants({ signal, counts = false } = {}) {
  return readPages('/v1/platform/tenants', counts ? { counts: 1 } : {}, 'tenants', { signal });
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
// number). Only the platform console's pages import this section (the
// printers page; the print-jobs page reads the printers' ids and names for
// its filter, unit CP5-FP); no module of the admin tree may. The Worker refuses each of these routes with
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
//   PATCH /v1/platform/printers/:id  { …, dryRun: true }   → { dryRun: true, diff, revision, suspendedMappings }
//                                                   nothing written (CP5-WK; the save's preview, unit CP5-FP)
//   GET   /v1/platform/printers/:id                 { printer }   (the read-back of a save, CP5-FP)
//   PUT   /v1/platform/printers/default             { printerId: id | null } → { defaultPrinter: { printerId, printerActive, … } } · 422 printer_not_found | printer_inactive | tenant_printer
// The list carries every printer whole and the default's id; the single read
// serves the save's read-back after a revision moved or an answer was lost.
// GET …/default and the supplier catalogue (GET/PUT …/:id/catalog, POST
// …/catalog/apply) have no control on the page and no call here.

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

/**
 * The same edit as a DRY RUN (CP5-WK; unit CP5-FP): nothing is written. →
 * { diff, revision, suspendedMappings }: what the save would do, computed on
 * the printer at `revision` (send it back as `expectedRevision`). Refusals
 * are the write's (400 …, 409 revision_mismatch …, 404).
 */
export async function previewPrinterPatch(printerId, body) {
  const { data } = await platformRequest('PATCH', `/v1/platform/printers/${segment(printerId)}`, { json: { ...body, dryRun: true } });
  return {
    diff: data?.diff ?? null,
    revision: Number.isSafeInteger(data?.revision) ? data.revision : null,
    suspendedMappings: Number.isInteger(data?.suspendedMappings) ? data.suspendedMappings : 0,
  };
}

/** One printer as stored now (PlatformPrinterView), or null when the API answers the opaque 404 (unit CP5-FP). */
export async function getPrinter(printerId, { signal } = {}) {
  try {
    const { data } = await platformRequest('GET', `/v1/platform/printers/${segment(printerId)}`, { signal });
    return data?.printer ?? null;
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 404) return null;
    throw error;
  }
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

// ═══ CP5-FL ═════════════════════════════════════════════════════════════════
// The platform's settings, the brand filter's terms and the platform terms'
// versions (cloudflare/src/routes/platform-settings.ts, legal-platform.ts;
// CP3_D_REPORT.md §3, §4, §7; CP3_E_REPORT.md §2). PLATFORM-ONLY: only the
// console's settings pages import this section. The Worker answers the opaque
// 404 to any request that names a shop.
//
//   GET    /v1/platform/settings                    { settings }
//   PATCH  /v1/platform/settings                    { defaultCommissionBps?, reviewFirstProducts?, screeningHardBlock? }
//                                                   → { settings, rescreen: { blockedNow, pending, unverified } | null }
//                                                   400 setting_not_editable | invalid_request (+ field) · 409 conflict
//   GET    /v1/platform/screening-terms[?cursor&limit≤500]   { terms, nextCursor, termsVersion }
//   POST   /v1/platform/screening-terms             { term, kind?, hardBlock?, note? } → 201 { term, rescreen }
//                                                   409 duplicate_term | term_limit | conflict · 400
//   PATCH  /v1/platform/screening-terms/:termKey    { kind?, hardBlock?, note? } → { term, rescreen } · 404
//   DELETE /v1/platform/screening-terms/:termKey    → { deleted: true, rescreen } · 404
//   POST   /v1/platform/screening-terms/rescreen    → { rescreened, pending, unverified }   (≤ 25 products a call)
//   GET    /v1/platform/legal/terms-versions        { versions: [{ version, publishedAt, sha256, textArchived, current }] }
//   POST   /v1/platform/legal/terms-versions        { version, text, publishedAt? } → 201 { version }
//                                                   409 terms_version_exists | terms_version_not_latest · 400 · 413
//   GET    /v1/platform/legal/terms-versions/:version/text   { version, publishedAt, sha256, textArchived, text }
//   PUT    /v1/platform/legal/terms-versions/:version/text   { text } → 201 (archived now) | 200 (already) { version }
//                                                   409 terms_text_hash_mismatch · 400 · 413

const TERMS_PAGE = 500; // the Worker's TERMS_MAX_LIMIT
const TERMS_MAX_PAGES = 10; // 2 000 terms at most (MAX_SCREENING_TERMS)

/** The platform's settings, every value as the Worker stores it. */
export async function getPlatformSettings({ signal } = {}) {
  const { data } = await platformRequest('GET', '/v1/platform/settings', { signal });
  return data?.settings ?? null;
}

/** Changes the named settings only. → { settings, rescreen }. */
export async function patchPlatformSettings(patch) {
  const { data } = await platformRequest('PATCH', '/v1/platform/settings', { json: patch });
  return { settings: data?.settings ?? null, rescreen: data?.rescreen ?? null };
}

/** Every term of the brand filter, read to the end: { terms, termsVersion }. */
export async function readAllScreeningTerms({ signal } = {}) {
  const terms = [];
  let cursor = null;
  let termsVersion = null;
  for (let page = 0; page < TERMS_MAX_PAGES; page += 1) {
    const { data } = await platformRequest('GET', withQuery('/v1/platform/screening-terms', { limit: TERMS_PAGE, cursor }), { signal });
    if (Array.isArray(data?.terms)) terms.push(...data.terms);
    if (page === 0) termsVersion = Number.isInteger(data?.termsVersion) ? data.termsVersion : null;
    cursor = typeof data?.nextCursor === 'string' && data.nextCursor !== '' ? data.nextCursor : null;
    if (cursor === null) break;
  }
  return { terms, termsVersion };
}

/** Adds a term. → { term (as stored), rescreen }. */
export async function addScreeningTerm({ term, kind, hardBlock, note }) {
  const json = { term, kind, hardBlock, ...(note ? { note } : {}) };
  const { data } = await platformRequest('POST', '/v1/platform/screening-terms', { json });
  return { term: data?.term ?? null, rescreen: data?.rescreen ?? null };
}

/** Changes the named fields of one term (no rename). → { term, rescreen }. */
export async function updateScreeningTerm(termKey, fields) {
  const { data } = await platformRequest('PATCH', `/v1/platform/screening-terms/${segment(termKey)}`, { json: fields });
  return { term: data?.term ?? null, rescreen: data?.rescreen ?? null };
}

/** Removes one term. → { deleted, rescreen }. */
export async function deleteScreeningTerm(termKey) {
  const { data } = await platformRequest('DELETE', `/v1/platform/screening-terms/${segment(termKey)}`);
  return { deleted: data?.deleted === true, rescreen: data?.rescreen ?? null };
}

/** One bounded re-screen run. → { rescreened, pending, unverified }. */
export async function rescreenStale() {
  const { data } = await platformRequest('POST', '/v1/platform/screening-terms/rescreen');
  return data ?? null;
}

/** Every published or scheduled version of the platform terms, newest first. */
export async function listTermsVersions({ signal } = {}) {
  const { data } = await platformRequest('GET', '/v1/platform/legal/terms-versions', { signal });
  return Array.isArray(data?.versions) ? data.versions : [];
}

/** Publishes a new version with its text (now: no `publishedAt`). → the version. */
export async function publishTermsVersion({ version, text }) {
  const { data } = await platformRequest('POST', '/v1/platform/legal/terms-versions', { json: { version, text } });
  return data?.version ?? null;
}

/** One version's archived text: { version, publishedAt, sha256, textArchived, text }. */
export async function getTermsVersionText(version, { signal } = {}) {
  const { data } = await platformRequest('GET', `/v1/platform/legal/terms-versions/${segment(version)}/text`, { signal });
  return data ?? null;
}

/** Archives the text of a version that has none (its hash must match). → { version, created }. */
export async function archiveTermsVersionText(version, text) {
  const { status, data } = await platformRequest('PUT', `/v1/platform/legal/terms-versions/${segment(version)}/text`, { json: { text } });
  return { version: data?.version ?? null, created: status === 201 };
}

// ═══ end CP5-FL ═════════════════════════════════════════════════════════════

// ═══ CP5-FP ═════════════════════════════════════════════════════════════════
// The print jobs (cloudflare/src/routes/print-jobs-platform.ts,
// src/dispatch/print-job-list.ts, src/dispatch/production-status.ts;
// CP5_WK_REPORT.md, CP6_PS1_REPORT.md). PLATFORM-ONLY: only the console's
// print-jobs page imports this section. A row carries no cost and no buyer.
//
//   GET  /v1/platform/print-jobs[?state&dispatchState&exception&tenantId&printerId&cursor&limit≤100]
//        { jobs: [{ jobId, tenantId, shopName, orderId, orderNumber, orderStatus, lineNo,
//                   name, sku, variantLabel, quantity, printerId, printerJobRef,
//                   dispatchState, dispatchedAt, state, trackingNumber, trackingUrl,
//                   carrier, exception, exceptionResolvedAt, createdAt, updatedAt }], nextCursor }
//        ONE value per filter (`none` = no state recorded; `exception` none | out_of_stock,
//        CP6-PS3); ordered by job id (order id, line), the cursor the last job id of the page before
//   POST /v1/platform/print-jobs/:jobId/status  { state, trackingNumber?, trackingUrl?, carrier? }
//        or (CP6-PS3) exactly { exception: "out_of_stock" } / { exception: "resolved" }
//        → 200 { job, changed, orderShipped }
//        409 print_job_status_not_allowed { reason: not_accepted | cancelled | refunded |
//        backwards | tracking_differs | out_of_stock | exception_resolved | no_exception |
//        produced } · 409 conflict · 400 invalid_request · 404

/** One page of print jobs. → { jobs, nextCursor }. */
export async function listPrintJobs({ state, dispatchState, exception, tenantId, printerId, cursor, limit, signal } = {}) {
  const { data } = await platformRequest('GET', withQuery('/v1/platform/print-jobs', {
    state, dispatchState, exception, tenantId, printerId, cursor, limit,
  }), { signal });
  return {
    jobs: Array.isArray(data?.jobs) ? data.jobs : [],
    nextCursor: typeof data?.nextCursor === 'string' && data.nextCursor !== '' ? data.nextCursor : null,
  };
}

/** Records the printer's production status of one job. → { job, changed, orderShipped }. */
export async function setPrintJobStatus(jobId, body) {
  const { data } = await platformRequest('POST', `/v1/platform/print-jobs/${segment(jobId)}/status`, { json: body });
  return {
    job: data?.job ?? null,
    changed: data?.changed === true,
    orderShipped: data?.orderShipped === true,
  };
}

// ═══ end CP5-FP ═════════════════════════════════════════════════════════════
