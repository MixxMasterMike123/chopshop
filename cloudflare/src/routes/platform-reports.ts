import {
  getReport,
  handleReport,
  isReportId,
  listReports,
  parseHandleReportInput,
  parseReportListQuery,
  parseTakedownReportInput,
  type ReportConflictCode,
  takedownReportedProduct,
} from "../catalog/infringement-reports";
import { jsonResponse } from "../lib/http";
import {
  decodeSegment,
  invalidRequestResponse,
  readJsonBody,
  routeNotFoundResponse,
} from "../lib/responses";
import { authorizePlatformSurface } from "./platform-settings";

/**
 * CP3-D — the platform's infringement-report queue (Firebase PlatformReports →
 * Anmälningar). PLATFORM session only, same guard as platform-settings.ts
 * (the opaque 404 for everyone else, X-Shop-Id included; same-origin on every
 * state change). These are the ONLY responses that carry reporter data.
 *
 *   GET  /v1/platform/reports[?status=new|reviewing|rejected|taken_down&tenantId&cursor&limit]
 *        200 { reports: [PlatformReportView], nextCursor, newCount }
 *        (newest first; newCount = every shop's `new` reports, the nav badge)
 *   GET  /v1/platform/reports/:reportId
 *        200 { report }
 *   POST /v1/platform/reports/:reportId/handle     { status: "reviewing"|"rejected", note? }
 *        200 { report } · 409 transition_refused | conflict
 *   POST /v1/platform/reports/:reportId/takedown   { note?, productId? }
 *        200 { report, screening } · 409 report_closed | product_mismatch |
 *        tenant_mismatch | conflict
 */

export const PLATFORM_REPORTS_PATH = "/v1/platform/reports";
export const PLATFORM_REPORT_ROUTE = "/v1/platform/reports/:reportId";
export const PLATFORM_REPORT_HANDLE_ROUTE = "/v1/platform/reports/:reportId/handle";
export const PLATFORM_REPORT_TAKEDOWN_ROUTE = "/v1/platform/reports/:reportId/takedown";

// "", "v1", "platform", "reports", :reportId, action
const REPORT_SEGMENT = 4;

function reportIdFrom(request: Request): string | null {
  const raw = new URL(request.url).pathname.split("/")[REPORT_SEGMENT] ?? "";
  const decoded = decodeSegment(raw);
  return decoded !== null && isReportId(decoded) ? decoded : null;
}

const CONFLICT_MESSAGES: Record<ReportConflictCode, string> = {
  conflict: "The report changed meanwhile; reload it",
  product_mismatch: "The report is about another product",
  report_closed: "The report is already closed",
  tenant_mismatch: "The product does not belong to the shop in the report",
  transition_refused: "The report cannot move to that status",
};

function conflictResponse(code: ReportConflictCode): Response {
  return jsonResponse({ error: { code, message: CONFLICT_MESSAGES[code] } }, 409);
}

export async function handlePlatformReportsRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  const principal = await authorizePlatformSurface(env, request);
  if (principal === null || request.method !== "GET") {
    return routeNotFoundResponse();
  }
  const query = parseReportListQuery(new URL(request.url));
  if (query === null) {
    return invalidRequestResponse();
  }
  return jsonResponse(await listReports(env.DB, query));
}

export async function handlePlatformReportRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  const principal = await authorizePlatformSurface(env, request);
  if (principal === null || request.method !== "GET") {
    return routeNotFoundResponse();
  }
  const reportId = reportIdFrom(request);
  const report = reportId === null ? null : await getReport(env.DB, reportId);
  return report === null ? routeNotFoundResponse() : jsonResponse({ report });
}

export async function handlePlatformReportActionRoute(
  env: Env,
  request: Request,
  action: "handle" | "takedown",
): Promise<Response> {
  const principal = await authorizePlatformSurface(env, request);
  if (principal === null || request.method !== "POST") {
    return routeNotFoundResponse();
  }
  const reportId = reportIdFrom(request);
  if (reportId === null) {
    return routeNotFoundResponse();
  }
  const body = await readJsonBody(request);

  if (action === "handle") {
    const input = parseHandleReportInput(body);
    if (input === null) {
      return invalidRequestResponse();
    }
    const result = await handleReport(env.DB, principal, reportId, input, Date.now());
    if (result.status === "ok") {
      return jsonResponse({ report: result.report });
    }
    return result.status === "conflict" ? conflictResponse(result.code) : routeNotFoundResponse();
  }

  const input = parseTakedownReportInput(body);
  if (input === null) {
    return invalidRequestResponse();
  }
  const result = await takedownReportedProduct(env.DB, principal, reportId, input, Date.now());
  if (result.status === "ok") {
    return jsonResponse({ report: result.report, screening: result.screening });
  }
  return result.status === "conflict" ? conflictResponse(result.code) : routeNotFoundResponse();
}
