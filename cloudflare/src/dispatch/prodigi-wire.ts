/**
 * The Prodigi order wire format (CP11, decision D6) — the body we send and the
 * readings of what Prodigi answers. Verified against the sandbox on
 * 2026-10-19 (docs/cf-port/HANDOVER.md, CP11 entry: order ord_1186010) and
 * Prodigi's v4 reference.
 *
 *   POST {PRODIGI_API_BASE_URL}/v4.0/orders, header X-API-Key.
 *   ONE Prodigi order per order of ours (D4): `idempotencyKey` and
 *   `merchantReference` are our order id, each item's `merchantReference` is
 *   its line number. Prodigi answers a repeat of the same idempotency key with
 *   200 `AlreadyExists` and the same order — which is what makes re-submitting
 *   after a lost answer safe, and why a second dispatch row of the same order
 *   can never create a second Prodigi order.
 *
 * NOT SENT, deliberately: `branding` (no inserts on the tees we sell; a packing
 * slip only on 18500), the buyer's e-mail on the recipient (Prodigi needs none
 * for SE, and it would be a personal datum shared for nothing), `metadata`.
 *
 * The outcome strings: the sandbox answered PascalCase ("Created",
 * "AlreadyExists") on 2026-10-19 while the v4 reference documents camelCase
 * ("created", "alreadyExists", "onHold", "createdWithIssues",
 * "validationFailed", …). Both are read, case-insensitively.
 */

import type { ShipTo } from "../commerce/recipient";
import type { PrinterJob, PrinterSubmitResult } from "./printer-client";
import type { PrintLocation } from "./snapwear-wire";

/** The order-creation path on PRODIGI_API_BASE_URL's origin. */
export const PRODIGI_ORDERS_PATH = "/v4.0/orders";

/** The header that carries our key. */
export const PRODIGI_API_KEY_HEADER = "X-API-Key";

/** Where Prodigi posts its order callbacks (the intake is unit U3's route). */
export const PRODIGI_CALLBACK_PATH = "/v1/webhooks/prodigi";

/** Our own reference, and Prodigi's for its order (D6: `^ord_[A-Za-z0-9]+$`). */
const PRODIGI_ORDER_ID_PATTERN = /^ord_[A-Za-z0-9]{1,60}$/;

export interface ProdigiAddress {
  countryCode: string;
  line1: string;
  line2?: string;
  postalOrZipCode: string;
  townOrCity: string;
}

export interface ProdigiRecipient {
  address: ProdigiAddress;
  name: string;
  phoneNumber?: string;
}

export interface ProdigiItem {
  assets: Array<{ printArea: PrintLocation; url: string }>;
  attributes: { color: string; size: string };
  copies: number;
  merchantReference: string;
  sizing: "fitPrintArea";
  sku: string;
}

/**
 * Our catalogue's SKU key for a Prodigi printer (unit U4's importer,
 * scripts/cf-port/prodigi-catalog.mjs skuKey): a Prodigi SKU is a PRODUCT
 * (`GLOBAL-TEE-GIL-64000`); colour and size are per-item `attributes`. So the
 * key a line freezes is `<prodigiSku>.<colour-slug>.<size>`, e.g.
 * `GLOBAL-TEE-GIL-64000.heather-navy.2xl`, inside the catalogue's SKU grammar
 * `[A-Za-z0-9._-]{1,64}`. Split: the Prodigi SKU is the text before the FIRST
 * `.`, the size the text after the LAST `.`, the colour the middle with `-`
 * read as a space (the importer's colourOfSlug). A key without two dots, or
 * with an empty part, is null: the job is refused `sku_invalid`, never sent.
 */
export function splitProdigiSkuKey(key: string): { color: string; size: string; sku: string } | null {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first < 0 || last === first) {
    return null;
  }
  const sku = key.slice(0, first);
  const color = key.slice(first + 1, last).replace(/-/g, " ");
  const size = key.slice(last + 1);
  return sku === "" || color.trim() === "" || size === "" ? null : { color, size, sku };
}

export interface ProdigiOrderBody {
  callbackUrl: string;
  idempotencyKey: string;
  items: ProdigiItem[];
  merchantReference: string;
  recipient: ProdigiRecipient;
  shippingMethod: "Standard";
}

/**
 * The recipient from the order's frozen ShipTo. ShipTo.country is already an
 * ISO 3166-1 alpha-2 code in upper case (src/commerce/recipient.ts
 * COUNTRY_PATTERN, and 0045's CHECK on the column), which is what Prodigi's
 * `countryCode` takes. Optional fields are left out when empty, never sent as
 * null. No `stateOrCounty`: ShipTo has none, and Prodigi needs none for SE.
 */
export function prodigiRecipient(shipTo: ShipTo): ProdigiRecipient {
  const address: ProdigiAddress = {
    countryCode: shipTo.country,
    line1: shipTo.addressLine1,
    postalOrZipCode: shipTo.postalCode,
    townOrCity: shipTo.city,
  };
  if (shipTo.addressLine2 !== null && shipTo.addressLine2.trim() !== "") {
    address.line2 = shipTo.addressLine2;
  }
  const recipient: ProdigiRecipient = { address, name: shipTo.name };
  if (shipTo.phone !== null && shipTo.phone.trim() !== "") {
    recipient.phoneNumber = shipTo.phone;
  }
  return recipient;
}

/** Why toProdigiOrderBody built no body (the job's `rejected` code). */
export type ProdigiBodyRefusal = "front_missing" | "sku_invalid";

/**
 * THE ONE PLACE the Prodigi body is built (D6). `job.lines` are the order's
 * dispatchable lines (dispatch-effect.ts runOrderUnit), each one item with
 * its front/back assets and its colour and size split from the line's SKU
 * key (splitProdigiSkuKey); the order's id is the idempotency key. The caller
 * has already refused a job without a parcel address (ship_to_missing).
 * A refusal instead of a body, and the caller refuses the job with it:
 *   sku_invalid    a line's SKU key does not split — no line is ever sent
 *                  without its colour and size;
 *   front_missing  a line has no `front` asset (CP11 U7, audit F2: every
 *                  apparel product Prodigi lists requires its front print
 *                  area). The LAST guard: publication and checkout refuse
 *                  such a line first (pod-mappings.ts requiredSlotsOf).
 */
export function toProdigiOrderBody(
  job: PrinterJob & { shipTo: ShipTo },
  callbackUrl: string,
): { body: ProdigiOrderBody } | { refusal: ProdigiBodyRefusal } {
  const items: ProdigiItem[] = [];
  for (const line of job.lines) {
    const split = splitProdigiSkuKey(line.sku);
    if (split === null) {
      return { refusal: "sku_invalid" };
    }
    if (!line.artworks.some((artwork) => artwork.location === "front")) {
      return { refusal: "front_missing" };
    }
    items.push({
      assets: line.artworks.map((artwork) => ({ printArea: artwork.location, url: artwork.url })),
      attributes: { color: split.color, size: split.size },
      copies: line.quantity,
      merchantReference: String(line.lineNo),
      sizing: "fitPrintArea",
      sku: split.sku,
    });
  }
  return {
    body: {
      callbackUrl,
      idempotencyKey: job.orderId,
      items,
      merchantReference: job.orderId,
      recipient: prodigiRecipient(job.shipTo),
      shippingMethod: "Standard",
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Prodigi's order id from an answer's `order.id`, or null when it is not one. */
export function prodigiOrderId(body: unknown): string | null {
  const order = isRecord(body) ? body.order : undefined;
  const id = isRecord(order) ? order.id : undefined;
  return typeof id === "string" && PRODIGI_ORDER_ID_PATTERN.test(id) ? id : null;
}

/** `outcome` folded to lower case, or null. */
function outcomeOf(body: unknown): string | null {
  const outcome = isRecord(body) ? body.outcome : undefined;
  return typeof outcome === "string" && outcome.length <= 64 ? outcome.toLowerCase() : null;
}

/** A code the outbox may store (outboxErrorCode's alphabet), at most 60 characters. */
function asCode(value: string): string | null {
  const code = value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 60);
  return /[A-Za-z0-9]/.test(code) ? code : null;
}

/** At most this many issue codes are carried from one answer (each is an alert). */
export const PRODIGI_MAX_ISSUE_CODES = 10;

/** The code of an issue whose `errorCode` is missing or unreadable. */
export const PRODIGI_UNREADABLE_ISSUE_CODE = "issue_unreadable";

/**
 * CP11 U7 (audit F5): the issue codes an order carries — `order.status.issues
 * [].errorCode` (Prodigi's v4 status object) and a top-level `issues[]` —
 * bounded and stored-safe (asCode), deduplicated, in the order given, at most
 * PRODIGI_MAX_ISSUE_CODES. An issue without a readable code counts as
 * `issue_unreadable`. Codes only: never a description, an object id's
 * neighbour text or anything of the recipient.
 */
export function prodigiIssueCodes(body: unknown): string[] {
  const codes: string[] = [];
  if (!isRecord(body)) {
    return codes;
  }
  const order = isRecord(body.order) ? body.order : body;
  const status = isRecord(order.status) ? order.status : null;
  for (const issues of [status?.issues, body.issues]) {
    if (!Array.isArray(issues)) {
      continue;
    }
    for (const issue of issues as unknown[]) {
      const code =
        isRecord(issue) && typeof issue.errorCode === "string"
          ? (asCode(issue.errorCode) ?? PRODIGI_UNREADABLE_ISSUE_CODE)
          : PRODIGI_UNREADABLE_ISSUE_CODE;
      if (!codes.includes(code) && codes.length < PRODIGI_MAX_ISSUE_CODES) {
        codes.push(code);
      }
    }
  }
  return codes;
}

/**
 * The refusal's code: the first `issues[].errorCode`, else the first key of
 * `failures` (a field path), else `validation_failed`. Only a bounded code
 * leaves this function: never a message, an address or the body.
 */
export function prodigiRejectionCode(body: unknown): string {
  if (isRecord(body)) {
    const order = isRecord(body.order) ? body.order : null;
    const status = order !== null && isRecord(order.status) ? order.status : null;
    for (const issues of [body.issues, status?.issues]) {
      if (Array.isArray(issues)) {
        const first = issues[0] as unknown;
        if (isRecord(first) && typeof first.errorCode === "string") {
          const code = asCode(first.errorCode);
          if (code !== null) {
            return code;
          }
        }
      }
    }
    if (isRecord(body.failures)) {
      const [first] = Object.keys(body.failures);
      const code = first === undefined ? null : asCode(first);
      if (code !== null) {
        return code;
      }
    }
  }
  return "validation_failed";
}

/**
 * The classifier (D6), from the HTTP status and the parsed body (null when it
 * was not JSON). Fail closed: anything that is not a readable acceptance or a
 * readable refusal is `unknown`, and the same idempotency key is re-submitted
 * later — Prodigi's `AlreadyExists` then settles it.
 *
 *   2xx  created | onHold                      → accepted, ref = order.id
 *        createdWithIssues                      → accepted, ref = order.id, AND
 *          its issue codes (CP11 U7, audit F5: the dispatcher raises one
 *          `printer_order_issues` alert per code; the order exists, so it is
 *          never re-submitted under a new key)
 *        alreadyExists                          → duplicate, ref = order.id;
 *          WITHOUT a readable order.id → unknown `duplicate_unreadable`
 *          (CP11 U7, audit F9: a duplicate with no reference would complete
 *          the row with none, and no callback could bind the order again;
 *          the same idempotency key is re-submitted instead)
 *        validationFailed                       → rejected
 *        an unreadable order id, another outcome, no JSON → unknown
 *   400 / 422                                   → rejected (code from the body)
 *   3xx / 401 / 403 / 404 / 408 / 429 / 5xx     → unknown http_<status>
 *          (our configuration, or theirs: the order may or may not exist)
 *   any other 4xx                               → rejected http_<status>
 */
export function classifyProdigiResponse(status: number, body: unknown): PrinterSubmitResult {
  if (status >= 200 && status < 300) {
    const outcome = outcomeOf(body);
    switch (outcome) {
      case "created":
      case "onhold": {
        const ref = prodigiOrderId(body);
        return ref === null
          ? { reason: "malformed_response", status: "unknown" }
          : { printerJobId: ref, status: "accepted" };
      }
      case "createdwithissues": {
        const ref = prodigiOrderId(body);
        if (ref === null) {
          return { reason: "malformed_response", status: "unknown" };
        }
        const codes = prodigiIssueCodes(body);
        return {
          issueCodes: codes.length === 0 ? [PRODIGI_UNREADABLE_ISSUE_CODE] : codes,
          printerJobId: ref,
          status: "accepted",
        };
      }
      case "alreadyexists": {
        const ref = prodigiOrderId(body);
        return ref === null
          ? { reason: "duplicate_unreadable", status: "unknown" }
          : { printerJobId: ref, status: "duplicate" };
      }
      case "validationfailed":
        return { code: prodigiRejectionCode(body), status: "rejected" };
      default:
        return { reason: outcome === null ? "malformed_response" : "unexpected_outcome", status: "unknown" };
    }
  }
  if (status === 400 || status === 422) {
    return { code: prodigiRejectionCode(body), status: "rejected" };
  }
  if (
    (status >= 300 && status < 400) ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 408 ||
    status === 429 ||
    status >= 500
  ) {
    return { reason: `http_${status}`, status: "unknown" };
  }
  return { code: `http_${status}`, status: "rejected" };
}
