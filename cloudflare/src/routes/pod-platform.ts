import type { PlatformPrincipal } from "../auth/live-authorization";
import {
  authorizePlatformRequest,
  SHOP_ID_HEADER,
} from "../auth/request-authorization";
import type { ScreeningStatus } from "../catalog/screening-core";
import {
  decideByPlatform,
  listScreeningQueue,
  parsePlatformDecisionInput,
} from "../catalog/screening";
import { jsonResponse } from "../lib/http";
import {
  decodeSegment,
  invalidRequestResponse,
  readJsonBody,
  routeNotFoundResponse,
} from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";
import {
  parseDefaultPrinterInput,
  readDefaultPrinter,
  setDefaultPrinter,
} from "../pod/print-defaults";
import {
  applyCatalog,
  CATALOG_MAX_BYTES,
  parseCatalogApplyInput,
  parseCatalogPutInput,
  readCatalog,
  storeCatalog,
} from "../pod/printer-catalog";
import type { EditPrinterResult } from "../pod/printers";
import {
  dispatchTargetOf,
  editPrinter,
  getPlatformPrinter,
  isPrinterId,
  listPlatformPrinters,
  parsePrinterPatchInput,
  parseReplacePrintersInput,
  PLATFORM_PRINTER_PAGE_DEFAULT,
  PLATFORM_PRINTER_PAGE_MAX,
  printersAllowedIn,
  replacePrinters,
} from "../pod/printers";

/**
 * The platform side of the POD product path (CP2-C):
 *
 *   PUT  /v1/platform/printers                 replace the printer set (+ tiers)
 *   GET  /v1/platform/screening[?status=]      the review queue
 *   POST /v1/platform/screening/{productId}    { "decision": "approved"|"blocked" }
 *
 * Platform-guarded (live platform_admin session), same-origin on every state
 * change, and every failure before authorization is the opaque 404.
 *
 * CP3-C adds the printer read, partial edit, default printer and supplier
 * catalogue — see "CP3: the platform printer surface" below.
 */
export const PLATFORM_PRINTERS_PATH = "/v1/platform/printers";
export const PLATFORM_SCREENING_PATH = "/v1/platform/screening";
export const PLATFORM_SCREENING_PATH_PREFIX = "/v1/platform/screening/";

const SCREENING_STATUSES: readonly ScreeningStatus[] = [
  "advisory",
  "approved",
  "blocked",
  "flagged",
  "pending",
];

/**
 * Replace-all, like PUT /v1/platform/pod/profiles: the printer set is a
 * document (SnapWear's catalogue + the platform's price list). DARK (404) unless
 * this environment has a dispatch target it can seed — `fake-printer` only in
 * staging, `snapwear` in production — and an `api` printer must BE that target
 * (src/pod/printers.ts printersAllowedIn). A routing edit that removes a
 * capability or a price suspends the affected mappings in the same batch.
 */
export async function handlePlatformPrintersRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  const target = dispatchTargetOf(env);
  if (target === null) {
    return routeNotFoundResponse();
  }
  const principal = await authorizePlatformRequest(env, request);
  if (principal === null || !isSameOriginRequest(request) || request.method !== "PUT") {
    return routeNotFoundResponse();
  }

  const printers = parseReplacePrintersInput(await readJsonBody(request));
  if (printers === null || !printersAllowedIn(printers, target)) {
    return invalidRequestResponse();
  }

  const result = await replacePrinters(env.DB, principal, printers, Date.now());
  if (result === null) {
    return jsonResponse(
      { error: { code: "conflict", message: "A tenant printer already uses that id" } },
      409,
    );
  }
  return jsonResponse(result, 200);
}

export async function handlePlatformScreeningRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  const principal = await authorizePlatformRequest(env, request);
  if (principal === null) {
    return routeNotFoundResponse();
  }
  if (request.method !== "GET" && !isSameOriginRequest(request)) {
    return routeNotFoundResponse();
  }

  const url = new URL(request.url);
  if (url.pathname === PLATFORM_SCREENING_PATH) {
    if (request.method !== "GET") {
      return routeNotFoundResponse();
    }
    const raw = url.searchParams.get("status");
    const status =
      raw === null
        ? null
        : (SCREENING_STATUSES as readonly string[]).includes(raw)
          ? (raw as ScreeningStatus)
          : undefined;
    if (status === undefined) {
      return invalidRequestResponse();
    }
    return jsonResponse({ screening: await listScreeningQueue(env.DB, status) });
  }

  if (!url.pathname.startsWith(PLATFORM_SCREENING_PATH_PREFIX) || request.method !== "POST") {
    return routeNotFoundResponse();
  }
  const rest = url.pathname.slice(PLATFORM_SCREENING_PATH_PREFIX.length);
  const productId = rest.includes("/") ? null : decodeSegment(rest);
  if (productId === null) {
    return routeNotFoundResponse();
  }

  const decision = parsePlatformDecisionInput(await readJsonBody(request));
  if (decision === null) {
    return invalidRequestResponse();
  }
  const screening = await decideByPlatform(env.DB, principal, productId, decision, Date.now());
  return screening === null ? routeNotFoundResponse() : jsonResponse({ screening });
}

// ── CP3: the platform printer surface ───────────────────────────────────────
//
//   GET   /v1/platform/printers[?cursor=&limit=]          every printer, with tiers
//   GET   /v1/platform/printers/default                   the default printer
//   PUT   /v1/platform/printers/default                   { printerId | null }
//   GET   /v1/platform/printers/{printerId}               one printer, with tiers
//   PATCH /v1/platform/printers/{printerId}               partial edit
//   GET   /v1/platform/printers/{printerId}/catalog       the supplier catalogue
//   PUT   /v1/platform/printers/{printerId}/catalog       store it (+ sha256)
//   POST  /v1/platform/printers/{printerId}/catalog/apply dry run | apply
//
// PLATFORM SESSIONS ONLY — these answers carry every price the platform holds.
// The guard order, identical on every route here:
//   1. dark unless the environment has a dispatch target (the replace-all
//      PUT's rule: the printer surface is one surface),
//   2. a request that names a shop (X-Shop-Id) is refused: that is how a
//      tenant-admin request — including a platform user ACTING AS a shop —
//      presents itself, and the one-number rule forbids either from seeing a
//      price, whatever the session could otherwise do,
//   3. a live platform_admin session (D1, per request),
//   4. the method the route owns, and same-origin on every state change,
// all answering the one opaque 404. Only then are the id, the query and the
// body read. `default` is never a printer id (isPrinterId).

export const PLATFORM_DEFAULT_PRINTER_PATH = "/v1/platform/printers/default";
export const PLATFORM_PRINTER_ROUTE = "/v1/platform/printers/:printerId";
export const PLATFORM_PRINTER_CATALOG_ROUTE = "/v1/platform/printers/:printerId/catalog";
export const PLATFORM_PRINTER_CATALOG_APPLY_ROUTE =
  "/v1/platform/printers/:printerId/catalog/apply";

/** A catalogue PUT body above this is refused before it is read (the document cap + envelope). */
const CATALOG_BODY_MAX_BYTES = CATALOG_MAX_BYTES + 64 * 1_024;

async function guardPlatformPrinters(
  env: Env,
  request: Request,
  methods: readonly string[],
): Promise<{ principal: PlatformPrincipal; target: "fake-printer" | "snapwear" } | null> {
  const target = dispatchTargetOf(env);
  if (target === null || request.headers.has(SHOP_ID_HEADER)) {
    return null;
  }
  const principal = await authorizePlatformRequest(env, request);
  if (principal === null || !methods.includes(request.method)) {
    return null;
  }
  if (request.method !== "GET" && !isSameOriginRequest(request)) {
    return null;
  }
  return { principal, target };
}

function printerIdFromSegment(rawSegment: string): string | null {
  const decoded = decodeSegment(rawSegment);
  return decoded !== null && isPrinterId(decoded) ? decoded : null;
}

function platformError(
  status: number,
  code: string,
  message: string,
  problems?: readonly string[],
): Response {
  return jsonResponse(
    { error: problems === undefined ? { code, message } : { code, message, problems } },
    status,
  );
}

const CONFLICT_MESSAGES: Record<string, string> = {
  catalog_changed: "The stored catalogue is not the one expected",
  concurrent_edit: "The printer changed while this edit was being prepared; read it again and retry",
  no_catalog: "No catalogue is stored for this printer",
  revision_mismatch: "The printer is no longer at the expected revision",
  tenant_printer: "Tenant printers are not edited here",
  too_many_mappings: "The printer has too many active mappings to revalidate in one edit",
};

function editFailureResponse(
  result: Exclude<EditPrinterResult, { status: "ok" }> | { code: string; problems?: string[]; status: "conflict" | "invalid" },
): Response {
  if (result.status === "not_found") {
    return routeNotFoundResponse();
  }
  if (result.status === "conflict") {
    return platformError(409, result.code, CONFLICT_MESSAGES[result.code] ?? "Request conflicts with the current printer state");
  }
  return platformError(400, result.code, "The edit cannot be applied", result.problems ?? []);
}

function parseListQuery(url: URL): { cursor: string | null; limit: number } | null {
  for (const key of url.searchParams.keys()) {
    if (key !== "cursor" && key !== "limit") {
      return null;
    }
  }
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(cursor)) {
    return null;
  }
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit === null) {
    return { cursor, limit: PLATFORM_PRINTER_PAGE_DEFAULT };
  }
  const limit = /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
  return limit >= 1 && limit <= PLATFORM_PRINTER_PAGE_MAX ? { cursor, limit } : null;
}

/** `GET /v1/platform/printers` → `{ printers: [PlatformPrinterView], nextCursor, defaultPrinterId }`. */
export async function handlePlatformPrinterListRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  const guard = await guardPlatformPrinters(env, request, ["GET"]);
  if (guard === null) {
    return routeNotFoundResponse();
  }
  const query = parseListQuery(new URL(request.url));
  if (query === null) {
    return invalidRequestResponse();
  }
  const [page, defaultPrinter] = await Promise.all([
    listPlatformPrinters(env.DB, query),
    readDefaultPrinter(env.DB),
  ]);
  return jsonResponse({ ...page, defaultPrinterId: defaultPrinter.printerId });
}

/**
 * `GET /v1/platform/printers/{id}` → `{ printer }`;
 * `PATCH` (parsePrinterPatchInput) → `{ printer, diff, suspendedMappings }`.
 */
export async function handlePlatformPrinterRoute(
  env: Env,
  request: Request,
  rawPrinterId: string,
): Promise<Response> {
  const guard = await guardPlatformPrinters(env, request, ["GET", "PATCH"]);
  const printerId = guard === null ? null : printerIdFromSegment(rawPrinterId);
  if (guard === null || printerId === null) {
    return routeNotFoundResponse();
  }
  if (request.method === "GET") {
    const printer = await getPlatformPrinter(env.DB, printerId);
    return printer === null ? routeNotFoundResponse() : jsonResponse({ printer });
  }

  const input = parsePrinterPatchInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }
  const result = await editPrinter(env.DB, guard.principal, printerId, input.edit, Date.now(), {
    action: "pod.printers.edit",
    dryRun: false,
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    target: guard.target,
  });
  if (result.status !== "ok") {
    return editFailureResponse(result);
  }
  const printer = await getPlatformPrinter(env.DB, printerId);
  return jsonResponse({ diff: result.diff, printer, suspendedMappings: result.suspendedMappings });
}

/**
 * `GET /v1/platform/printers/default` → `{ defaultPrinter: { printerId, printerActive, updatedAt, updatedBy } }`;
 * `PUT` `{ printerId }` / `{ printerId: null }` → the same, or 422
 * `printer_not_found | printer_inactive | tenant_printer`.
 */
export async function handlePlatformDefaultPrinterRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  const guard = await guardPlatformPrinters(env, request, ["GET", "PUT"]);
  if (guard === null) {
    return routeNotFoundResponse();
  }
  if (request.method === "GET") {
    return jsonResponse({ defaultPrinter: await readDefaultPrinter(env.DB) });
  }
  const input = parseDefaultPrinterInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }
  const result = await setDefaultPrinter(env.DB, guard.principal, input.printerId, Date.now());
  if (result.status !== "ok") {
    return platformError(
      422,
      result.code,
      result.code === "tenant_printer"
        ? "A tenant printer cannot be the platform default"
        : "The default printer must exist and be active",
    );
  }
  return jsonResponse({ defaultPrinter: result.defaultPrinter });
}

/**
 * `GET /v1/platform/printers/{id}/catalog` → `{ catalog: CatalogView }` (the
 * document, its sha256, source, pricing basis); `PUT` `{ catalog, source?,
 * pricingBasis? }` → `{ catalog: CatalogMeta }` (no document echo).
 */
export async function handlePlatformPrinterCatalogRoute(
  env: Env,
  request: Request,
  rawPrinterId: string,
): Promise<Response> {
  const guard = await guardPlatformPrinters(env, request, ["GET", "PUT"]);
  const printerId = guard === null ? null : printerIdFromSegment(rawPrinterId);
  if (guard === null || printerId === null) {
    return routeNotFoundResponse();
  }
  if (request.method === "GET") {
    const catalog = await readCatalog(env.DB, printerId);
    return catalog === null ? routeNotFoundResponse() : jsonResponse({ catalog });
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > CATALOG_BODY_MAX_BYTES) {
    return platformError(413, "payload_too_large", "The catalogue exceeds the maximum allowed size");
  }
  const parsed = parseCatalogPutInput(await readJsonBody(request));
  if (parsed.status === "too_large") {
    return platformError(413, "payload_too_large", "The catalogue exceeds the maximum allowed size");
  }
  if (parsed.status === "invalid") {
    return platformError(400, "invalid_request", "Request is not valid", parsed.problems);
  }
  const stored = await storeCatalog(env.DB, guard.principal, printerId, parsed.input, Date.now());
  if (stored.status !== "ok") {
    return stored.status === "not_found"
      ? routeNotFoundResponse()
      : platformError(409, "tenant_printer", CONFLICT_MESSAGES.tenant_printer ?? "");
  }
  return jsonResponse({ catalog: stored.catalog });
}

/**
 * `POST /v1/platform/printers/{id}/catalog/apply` (parseCatalogApplyInput) →
 * `{ dryRun, catalogSha256, diff, suspendedMappings[, printer] }` — `printer`
 * only when applied. Dry run unless `apply: true`.
 */
export async function handlePlatformPrinterCatalogApplyRoute(
  env: Env,
  request: Request,
  rawPrinterId: string,
): Promise<Response> {
  const guard = await guardPlatformPrinters(env, request, ["POST"]);
  const printerId = guard === null ? null : printerIdFromSegment(rawPrinterId);
  if (guard === null || printerId === null) {
    return routeNotFoundResponse();
  }
  const input = parseCatalogApplyInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }
  const result = await applyCatalog(env.DB, guard.principal, printerId, input, Date.now(), guard.target);
  if (result.status !== "ok") {
    return editFailureResponse(result);
  }
  const body = {
    catalogSha256: result.catalogSha256,
    diff: result.diff,
    dryRun: !input.apply,
    suspendedMappings: result.suspendedMappings,
  };
  return jsonResponse(
    input.apply ? { ...body, printer: await getPlatformPrinter(env.DB, printerId) } : body,
  );
}
