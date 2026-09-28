import type { TenantAdminPrincipal } from "../auth/live-authorization";
import { enforceRateLimit } from "../lib/rate-limit";
import { bounded, maySignForSeller, sha256Hex, TERMS_VERSION_PATTERN } from "./platform-terms";
import { checkHtml } from "../content/html-refusal";

/**
 * The seller ADOPTING the consumer-facing legal pages of its own shop
 * (köpvillkor, ångerrätt & returer, integritetspolicy) — migrations/0037
 * `legal_acceptances`, type `legalPages`. A different contract from the
 * platform terms (platform-terms.ts): these texts become the SELLER's own
 * terms towards its buyers (platform-liability guard).
 *
 * Ported from Firebase src/utils/legalAcceptance.js recordLegalAcceptance:
 * one append-only evidence row per acceptance — who, when, which template
 * version, the print-on-demand and custom flags, and a SNAPSHOT of the exact
 * texts adopted. Every acceptance is new evidence (Firebase `addDoc`), so a
 * re-acceptance appends a row and "the acceptance" is the latest one.
 *
 * Only the shop's own admin adopts: `maySignForSeller`, the same check as the
 * platform-terms acceptance. The snapshot is stored in CANONICAL form with its
 * SHA-256 (see `canonicalJson`).
 */

/** Firebase LEGAL_PAGE_KEYS (src/config/legalTemplates.js): the three pages. */
export const LEGAL_PAGE_KEYS = ["angerratt", "integritetspolicy", "kopvillkor"] as const;

/**
 * The snapshot cap, in UTF-8 bytes of the canonical JSON (0037's CHECK). The
 * three templates render to about 17 KB; 256 KiB is 15x that.
 */
export const LEGAL_TEXTS_MAX_BYTES = 262_144;

/**
 * The request-body cap for the routes that carry texts. Larger than the
 * snapshot cap because a client may escape characters the canonical form
 * writes raw (`å` is 6 bytes, `å` is 2); the snapshot cap is the real one.
 */
export const LEGAL_BODY_MAX_BYTES = 1_048_576;

/** Well-formed adoptions per shop per hour: evidence is append-only, forever. */
export const ACCEPT_PAGES_LIMIT = 20;
const ACCEPT_PAGES_WINDOW_MS = 60 * 60 * 1_000;
const ACCEPT_PAGES_SCOPE = "legal-pages-accept-tenant";

function iso(now: number): string {
  return new Date(now).toISOString();
}

// ── the canonical form (the importer computes the same) ─────────────────────

/**
 * Rebuilds every plain object with its keys inserted in `Object.keys(o).sort()`
 * order (UTF-16 code unit order), recursively; arrays keep their order.
 * Identical to scripts/cf-port/migrate/lib/typed-json.mjs sortKeysDeep.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortKeysDeep(entry));
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * THE canonical form of a snapshot: `JSON.stringify(sortKeysDeep(value))`.
 * Note what ECMAScript then does, so another implementation can match it:
 * integer-like keys ("9", "10") are emitted FIRST in ascending numeric order,
 * then the other keys in the sorted order; JSON.stringify's own escaping
 * (non-ASCII raw, `"` `\` and control characters escaped, lone surrogates as
 * `\udXXX`); no whitespace. `texts_sha256` = SHA-256 of its UTF-8 bytes.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

export async function canonicalTexts(
  texts: Record<string, unknown>,
): Promise<{ json: string; sha256: string; sizeBytes: number }> {
  const json = canonicalJson(texts);
  const bytes = new TextEncoder().encode(json);
  return { json, sha256: await sha256Hex(bytes), sizeBytes: bytes.byteLength };
}

// ── request body ────────────────────────────────────────────────────────────

export type BoundedBody = { status: "ok"; value: unknown } | { status: "too_large" };

/**
 * JSON body read under a byte cap: a declared Content-Length over the cap is
 * refused unread, and a stream is cut off as soon as it passes the cap.
 * Malformed JSON or UTF-8 reads as `undefined` (the parsers then refuse it).
 */
export async function readJsonBodyWithin(request: Request, maxBytes: number): Promise<BoundedBody> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    return { status: "too_large" };
  }
  if (request.body === null) {
    return { status: "ok", value: undefined };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { status: "too_large" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { status: "ok", value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { status: "ok", value: undefined };
  }
}

// ── adopting the pages ──────────────────────────────────────────────────────

type PageKey = (typeof LEGAL_PAGE_KEYS)[number];

export interface AcceptPagesInput {
  /** At least one page is the seller's own text. */
  custom: boolean;
  /** The per-page map (Firebase storeIdentity.legal.custom) when the client sent one. */
  customPages: Record<PageKey, boolean> | null;
  pod: boolean;
  templateVersion: string;
  texts: Record<PageKey, string>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `custom` is EITHER the summary boolean OR the per-page map with exactly the
 * three page keys and boolean values; the summary is then derived from it.
 */
function parseCustom(value: unknown): Pick<AcceptPagesInput, "custom" | "customPages"> | null {
  if (typeof value === "boolean") {
    return { custom: value, customPages: null };
  }
  if (
    !isPlainRecord(value) ||
    Object.keys(value).sort().join(",") !== LEGAL_PAGE_KEYS.join(",") ||
    !LEGAL_PAGE_KEYS.every((key) => typeof value[key] === "boolean")
  ) {
    return null;
  }
  const customPages = value as Record<PageKey, boolean>;
  return { custom: LEGAL_PAGE_KEYS.some((key) => customPages[key]), customPages };
}

/**
 * Strict body: exactly `{ templateVersion, texts, pod, custom }`; `texts` is
 * exactly the three page keys, each a non-empty string (the HTML adopted);
 * `custom` is a boolean or the per-page map (`parseCustom`).
 */
export function parseAcceptPagesInput(body: unknown): AcceptPagesInput | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "custom,pod,templateVersion,texts") {
    return null;
  }
  const { pod, templateVersion, texts } = record;
  const custom = parseCustom(record.custom);
  if (
    custom === null ||
    typeof pod !== "boolean" ||
    typeof templateVersion !== "string" ||
    !TERMS_VERSION_PATTERN.test(templateVersion) ||
    typeof texts !== "object" ||
    texts === null ||
    Array.isArray(texts)
  ) {
    return null;
  }
  const pages = texts as Record<string, unknown>;
  if (Object.keys(pages).sort().join(",") !== LEGAL_PAGE_KEYS.join(",")) {
    return null;
  }
  if (!LEGAL_PAGE_KEYS.every((key) => typeof pages[key] === "string" && (pages[key] as string).length > 0)) {
    return null;
  }
  // The adopted text is shown to every visitor as it is (src/routes/
  // public-legal.ts), so it passes the same refusal as a page's HTML: nothing
  // that can run or fetch is ever adopted. The templates render to plain
  // structure (headings, paragraphs, lists, links) and pass it.
  if (!LEGAL_PAGE_KEYS.every((key) => checkHtml(pages[key] as string).ok)) {
    return null;
  }
  return {
    ...custom,
    pod,
    templateVersion,
    texts: pages as AcceptPagesInput["texts"],
  };
}

export interface PagesAcceptanceEvidence {
  ip: string | null;
  userAgent: string | null;
}

export interface NewPagesAcceptance {
  acceptanceId: string;
  acceptedAt: string;
  custom: boolean;
  customPages: Record<string, boolean> | null;
  pod: boolean;
  templateVersion: string;
  textsSha256: string;
}

export type AcceptPagesResult =
  | { acceptance: NewPagesAcceptance; status: "accepted" }
  /** An acting-as principal: a platform user never adopts for the seller. */
  | { status: "forbidden" }
  | { retryAfterSeconds: number; status: "rate_limited" }
  /** The canonical snapshot is over LEGAL_TEXTS_MAX_BYTES. */
  | { status: "too_large" };

/**
 * Appends the evidence row + its audit row in one batch. The time is the
 * server clock; the email is the accepting user's own (read in the INSERT).
 */
export async function acceptLegalPages(
  db: D1Database,
  principal: TenantAdminPrincipal,
  input: AcceptPagesInput,
  evidence: PagesAcceptanceEvidence,
  now: number,
): Promise<AcceptPagesResult> {
  if (!maySignForSeller(principal)) {
    return { status: "forbidden" };
  }

  const snapshot = await canonicalTexts(input.texts);
  if (snapshot.sizeBytes > LEGAL_TEXTS_MAX_BYTES) {
    return { status: "too_large" };
  }

  const limited = await enforceRateLimit(db, {
    key: principal.tenantId,
    limit: ACCEPT_PAGES_LIMIT,
    now,
    scope: ACCEPT_PAGES_SCOPE,
    windowMs: ACCEPT_PAGES_WINDOW_MS,
  });
  if (!limited.allowed) {
    return { retryAfterSeconds: limited.retryAfterSeconds, status: "rate_limited" };
  }

  const acceptanceId = crypto.randomUUID();
  const acceptedAt = iso(now);
  await db.batch([
    db
      .prepare(
        `INSERT INTO legal_acceptances (
           acceptance_id, tenant_id, type, user_id, legacy_uid, email, accepted_at,
           accepted_at_original, template_version, version, is_pod, is_custom, custom_json,
           texts_json, texts_sha256, user_agent, ip, source
         ) VALUES (
           ?, ?, 'legalPages', ?, NULL, (SELECT "email" FROM "user" WHERE "id" = ?), ?,
           NULL, ?, NULL, ?, ?, ?,
           ?, ?, ?, ?, 'worker'
         )`,
      )
      .bind(
        acceptanceId,
        principal.tenantId,
        principal.userId,
        principal.userId,
        acceptedAt,
        input.templateVersion,
        input.pod ? 1 : 0,
        input.custom ? 1 : 0,
        input.customPages === null ? null : canonicalJson(input.customPages),
        snapshot.json,
        snapshot.sha256,
        bounded(evidence.userAgent, 512),
        bounded(evidence.ip, 64),
      ),
    db
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type,
           resource_id, request_id, metadata_json, created_at
         ) VALUES (?, ?, ?, 'legal.pages.accept', 'legal_acceptance', ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        principal.tenantId,
        principal.userId,
        acceptanceId,
        crypto.randomUUID(),
        JSON.stringify({ templateVersion: input.templateVersion, textsSha256: snapshot.sha256 }),
        now,
      ),
  ]);

  return {
    acceptance: {
      acceptanceId,
      acceptedAt,
      custom: input.custom,
      customPages: input.customPages,
      pod: input.pod,
      templateVersion: input.templateVersion,
      textsSha256: snapshot.sha256,
    },
    status: "accepted",
  };
}

// ── reading ─────────────────────────────────────────────────────────────────

export interface PagesAcceptanceView {
  acceptanceId: string;
  acceptedAt: string;
  custom: boolean | null;
  /** The per-page custom map as stored (custom_json), or null when only the summary was kept. */
  customPages: Record<string, unknown> | null;
  /** SHA-256 of each page's own text (string values only), by page key. */
  pageSha256: Record<string, string>;
  pod: boolean | null;
  source: "import" | "worker";
  templateVersion: string | null;
  textsSha256: string;
  /** Set on imported rows that carried a `version`; null otherwise. */
  version: string | null;
}

interface PagesRow {
  acceptance_id: string;
  accepted_at: string;
  custom_json: string | null;
  is_custom: number | null;
  is_pod: number | null;
  source: "import" | "worker";
  template_version: string | null;
  texts_json: string;
  texts_sha256: string;
  version: string | null;
}

function flag(value: number | null): boolean | null {
  return value === null ? null : value === 1;
}

/** The shop's LATEST legal-pages acceptance (by acceptance time), or null. */
export async function readLatestLegalPagesAcceptance(
  db: D1Database,
  tenantId: string,
): Promise<PagesAcceptanceView | null> {
  const row = await db
    .prepare(
      `SELECT acceptance_id, accepted_at, custom_json, is_custom, is_pod, source, template_version,
              texts_json, texts_sha256, version
       FROM legal_acceptances
       WHERE tenant_id = ? AND type = 'legalPages'
       ORDER BY accepted_at DESC, acceptance_id DESC
       LIMIT 1`,
    )
    .bind(tenantId)
    .first<PagesRow>();
  if (row === null) {
    return null;
  }

  const texts = JSON.parse(row.texts_json) as Record<string, unknown>;
  const pageSha256: Record<string, string> = {};
  for (const key of Object.keys(texts).sort()) {
    const page = texts[key];
    if (typeof page === "string") {
      pageSha256[key] = await sha256Hex(page);
    }
  }

  return {
    acceptanceId: row.acceptance_id,
    acceptedAt: row.accepted_at,
    custom: flag(row.is_custom),
    customPages: row.custom_json === null ? null : (JSON.parse(row.custom_json) as Record<string, unknown>),
    pageSha256,
    pod: flag(row.is_pod),
    source: row.source,
    templateVersion: row.template_version,
    textsSha256: row.texts_sha256,
    version: row.version,
  };
}

/**
 * Does this tenant hold ANY legal-pages acceptance (Worker or imported)? One
 * of the three readiness conditions below.
 */
export async function hasLegalPagesAcceptance(db: D1Database, tenantId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS one FROM legal_acceptances WHERE tenant_id = ? AND type = 'legalPages' LIMIT 1")
    .bind(tenantId)
    .first();
  return row !== null;
}

// ── the legal readiness gate ────────────────────────────────────────────────

export interface LegalReadiness {
  legalPagesAccepted: boolean;
  /** All three hold: the shop may take a checkout (as far as its legal pages go). */
  ready: boolean;
  returnAddress: boolean;
  vatAnswered: boolean;
}

/**
 * THE legal readiness gate, ported from Firebase
 * functions/src/payment/createPaymentIntent.ts legalCheckoutBlockReason (the
 * server side of src/utils/legalPageReadiness.js getLegalReadiness's HARD
 * blockers). A shop takes a checkout only when ALL of these hold:
 *
 *   returnAddress       a return address is set — köpvillkor §8 and the
 *                       ångerrätt page name it. Firebase: `String(returnAddress
 *                       || '').trim()` non-empty, so the same JavaScript trim is
 *                       applied here (every Unicode space and line break, not
 *                       SQLite's trim of plain spaces): an imported
 *                       whitespace-only address counts as missing;
 *   vatAnswered         the VAT question is answered (vat_registered 0 or 1;
 *                       Firebase `typeof vatRegistered === 'boolean'`), so the
 *                       pages' VAT wording matches what checkout charges;
 *   legalPagesAccepted  the seller adopted the pages as its own terms (any
 *                       legal-pages acceptance; Firebase `legal.acceptance`
 *                       with a non-empty acceptedAt — every row here has one).
 *
 * Deliberately NOT blockers, as in Firebase: template-version drift and
 * seller-edited text after the acceptance (`needsReacceptance`: "a template
 * bump must never close checkout"), and the softer identity gaps (legal name,
 * address, support email, seller type, org and VAT numbers).
 *
 * No tenant_settings row = nothing answered. One read.
 */
export async function readLegalReadiness(db: D1Database, tenantId: string): Promise<LegalReadiness> {
  const row = await db
    .prepare(
      `SELECT s.return_address AS return_address, s.vat_registered AS vat_registered,
              EXISTS (SELECT 1 FROM legal_acceptances AS a
                      WHERE a.tenant_id = ?1 AND a.type = 'legalPages') AS accepted
       FROM (SELECT ?1 AS tenant_id) AS t
       LEFT JOIN tenant_settings AS s ON s.tenant_id = t.tenant_id`,
    )
    .bind(tenantId)
    .first<{ accepted: number; return_address: string | null; vat_registered: number | null }>();

  const returnAddress = (row?.return_address ?? "").trim().length > 0;
  const vatAnswered = row?.vat_registered === 0 || row?.vat_registered === 1;
  const legalPagesAccepted = row?.accepted === 1;
  return {
    legalPagesAccepted,
    ready: returnAddress && vatAnswered && legalPagesAccepted,
    returnAddress,
    vatAnswered,
  };
}

/** THE second checkout gate (next to the terms gate in createCheckout). */
export async function isLegallyReady(db: D1Database, tenantId: string): Promise<boolean> {
  return (await readLegalReadiness(db, tenantId)).ready;
}
