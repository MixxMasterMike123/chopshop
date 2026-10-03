// PlatformReports' data layer: the ADMIN build's implementation (CP5 brief FJ).
// The alias list of vite.admin.config.js puts this module in place of
// src/pages/platform/platformReportsData.js (the older build's, Firebase); both
// export the same names with the same meaning, so the page is the same file in
// both builds.
//
// Anmälningar: GET /v1/platform/reports (every report, newest first), the two
// handling routes (POST …/handle reviewing|rejected, POST …/takedown). The
// server writes who handled and when; the page sends no uid.
// Granskning: GET /v1/platform/screening (pending, flagged, blocked) and
// POST /v1/platform/screening/:productId {decision}: "Godkänn" = approved
// (it also lifts a takedown), "Avpublicera" = blocked (a takedown). The
// decision carries no note, so the queue's note field leaves.
// The shop names come from GET /v1/platform/tenants (a report carries a tenant
// id only); if that read fails the id is shown, as for a shop without a name.
// The storefront address of a product needs its slug, which neither queue
// carries: the "open in the shop" links leave.

import { AdminApiError } from '../../api/admin/client.js';
import {
  decideScreening,
  handleReport,
  listScreening,
  readAllReports,
  readAllTenants,
  takedownReport,
} from '../../api/admin/platform.js';
import { queueRowOf, reportActionMessage, reportRowOf } from '../adapters/platformConsole.js';

/** The decision of a screening carries no note: the queue's note field leaves. */
export const QUEUE_NOTE = false;

/** The paragraph above the queue (the older one says flagged products stay public: that is the Worker's D8 policy only after a shop's first products). */
export const QUEUE_INTRO =
  'Produkter som flaggats av varumärkesfiltret eller blockerats, och nya butikers första produkter, som väntar på ditt godkännande innan de kan säljas. Godkänn, eller avpublicera om säljaren saknar rätt till märket.';

/** An API error → an Error in the page's language (the page shows `.message`). Others pass. */
function asPageError(error) {
  if (!(error instanceof AdminApiError)) return error;
  const message = reportActionMessage(error);
  if (message === null) return error;
  const wrapped = new Error(message);
  wrapped.code = error.code;
  return wrapped;
}

async function run(call) {
  try {
    return await call();
  } catch (error) {
    throw asPageError(error);
  }
}

/** Everything the page shows: { reports, queue, shopNames }. The queue is unsorted (the page sorts). */
export async function loadReports() {
  const [reports, screening, tenants] = await Promise.all([
    readAllReports(),
    listScreening(),
    readAllTenants().catch(() => []),
  ]);
  const shopNames = {};
  for (const tenant of tenants) shopNames[tenant.tenantId] = tenant.shopName || tenant.tenantId;
  return { shopNames, reports: reports.map(reportRowOf), queue: screening.map(queueRowOf) };
}

/** Takes the report's product down; the report becomes "Avpublicerad". */
export const takedownForReport = (report, productId, note) =>
  run(() => takedownReport(report.id, { productId: productId || undefined, note: note || null }));

/** Closes the report ("Avvisa"). The server stamps the handler and the time. */
export const rejectReport = (report, note) =>
  run(() => handleReport(report.id, { status: 'rejected', note: note || null }));

/** Moves the report to "Granskas" (also reopens a rejected one). */
export const markReportReviewing = (report) =>
  run(() => handleReport(report.id, { status: 'reviewing' }));

/** "Godkänn": the platform approves the product (a takedown on it is lifted). */
export const clearProduct = (product) => run(() => decideScreening(product.id, 'approved'));

/** "Avpublicera" in the queue: a takedown with no report. */
export const takedownProduct = (product) => run(() => decideScreening(product.id, 'blocked'));
