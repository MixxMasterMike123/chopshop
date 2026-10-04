/**
 * The SnapWear order-submission wire format — as far as it is KNOWN today.
 *
 * There is no SnapWear client to mirror yet: the Firebase side never built one
 * (LAUNCH_TODO A6 waits on Natalia's answers C4/C5). What is confirmed
 * (docs/SnapWearDocs/LAUNCH_TODO.md A6, SnapWear correspondence Sep 2026):
 *   - `POST /api/order/add`, header `x-api-token`;
 *   - a caller-chosen `job_id`, and a DUPLICATE `job_id` answers HTTP 400 —
 *     which is what makes re-submitting the same id after a lost response
 *     safe (PLAN §2.3: job id = `{orderId}-{lineNo}`, stable);
 *   - a validation failure answers `422 {"status":"error","message":
 *     "Validation Failed","errors":{…}}`;
 *   - artwork is delivered by URL, per order: `artworks[].url` (they fetch),
 *     `mockups[].url`, and `layouts[].location` ∈ front | back;
 *   - SKUs are SnapWear's own numbers (docs/SnapWearDocs/snapwear-catalog.json).
 *
 * PROVISIONAL, and to be replaced when A6's API documentation lands: the
 * `items[]` wrapper, the pairing of `artworks[i]` with `layouts[i]`, the exact
 * text of the duplicate-400 body (C5), and the success body (C6 — the fake
 * answers `201 { id, status: "accepted" }`), and the shipping address
 * (`shipping_address`, below: D98 gave orders a recipient; SnapWear's field
 * names are not known). The fake stores unknown top-level fields untouched, so
 * the address reaches it without changing the fake.
 *
 * CP6-PS1: every point still waiting on SnapWear is ONE constant or ONE
 * function in this file or beside the body builder (printer-client.ts
 * toSnapwearJobBody), each with its assumption written beside it and a test
 * in test/snapwear-client.test.ts. docs/cf-port/CP6_PS1_REPORT.md lists them
 * under "To confirm with SnapWear". Where a wrong guess could print wrongly or
 * lose money, the reading fails CLOSED: an unreadable success is `unknown`,
 * an unrecognised 400 is `rejected`, never "accepted".
 */

import type { ShipTo } from "../commerce/recipient";

/** CONFIRMED (LAUNCH_TODO A6): the order-submission path, on SnapWear's host. */
export const SNAPWEAR_ORDER_ADD_PATH = "/api/order/add";

/** CONFIRMED (LAUNCH_TODO A6): the header that carries our API token. */
export const SNAPWEAR_TOKEN_HEADER = "x-api-token";

export type PrintLocation = "back" | "front";

export interface SnapwearJobBody {
  artworks: Array<{ url: string }>;
  items: Array<{ quantity: number; sku: string }>;
  job_id: string;
  layouts: Array<{ location: PrintLocation }>;
  mockups: Array<{ url: string }>;
  /** A shipped order only; absent for a collected one (see below). */
  shipping_address?: SnapwearShippingAddress;
}

/**
 * PROVISIONAL (to be agreed with SnapWear, brief R / CP4_R_REPORT.md): where
 * the printer sends the parcel. The names, whether the name is split into
 * first and last, whether the telephone and the buyer's e-mail address are
 * required (the DPA names both for the carrier), and the address of a
 * COLLECTED order's parcel are all open. The only place the wire shape is
 * built: change it here.
 */
export interface SnapwearShippingAddress {
  address1: string;
  address2: string | null;
  city: string;
  country_code: string;
  name: string;
  phone: string | null;
  zip: string;
}

export function snapwearShippingAddress(shipTo: ShipTo): SnapwearShippingAddress {
  return {
    address1: shipTo.addressLine1,
    address2: shipTo.addressLine2,
    city: shipTo.city,
    country_code: shipTo.country,
    name: shipTo.name,
    phone: shipTo.phone,
    zip: shipTo.postalCode,
  };
}

/**
 * PROVISIONAL (collected orders, CP4_R open question 2): a job WITHOUT a
 * parcel address — a collected (pickup) order, or one made before 0045 — is
 * NOT sent to SnapWear. Where such a parcel goes (the shop? a pickup place?)
 * is not agreed, and a job SnapWear would print and send to a default address
 * is money lost and goods in the wrong place. The real client answers
 * `rejected` (`ship_to_missing`) before any HTTP call, so the dispatch fails
 * with its alert and a human places the job by hand (then resolves it as
 * accepted). The staging fake still takes such jobs: it never ships anything.
 * If SnapWear names an address for these parcels, the client builds it from
 * the order and this becomes true.
 */
export const SNAPWEAR_SUBMIT_WITHOUT_SHIP_TO = false;

export const SNAPWEAR_VALIDATION_FAILED_MESSAGE = "Validation Failed";

/**
 * The duplicate-`job_id` 400 body's message. PROVISIONAL (C5): the real text is
 * not known. A client classifies a 400 as "duplicate" ONLY on this marker —
 * any other 400 is a rejection that a human looks at, never an assumed
 * success, because treating an unrecognised 400 as "already accepted" would
 * mark a job printed that the printer never took. (A 400 that comes back
 * AFTER an attempt whose answer was lost is kept `unknown` by the dispatcher
 * instead — it may be this duplicate in words we cannot read; see
 * dispatch-effect.ts recordSubmitResult.)
 */
export const SNAPWEAR_DUPLICATE_JOB_MESSAGE = "Job with this job_id already exists";

/**
 * PROVISIONAL (C6): SnapWear's SUCCESS body, and the printer's own reference
 * for the job. Assumed: a 2xx whose JSON body is `{ id: "<non-empty string>",
 * status: "accepted" }` — the shape the staging fake answers. Anything else in
 * a 2xx (another shape, a numeric id, no body) is NOT read as accepted: the
 * caller classifies it `unknown`, the same job id is re-submitted later, and
 * SnapWear's duplicate answer settles it — or a human does after 30 minutes.
 * Whether the answer shows that SnapWear's auto-pay charge succeeded is also
 * open (C6); it is not read: a placed but unpaid order is caught by the
 * LAUNCH_TODO B9 runbook (daily glance at SnapWear's unpaid orders).
 * Returns the printer's reference, or null.
 */
export function snapwearAcceptedJobRef(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  return typeof record.id === "string" &&
    record.id.length > 0 &&
    record.id.length <= 200 &&
    record.status === "accepted"
    ? record.id
    : null;
}

const JOB_ID_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([1-9][0-9]{0,3})$/;

/** PLAN §2.3: `{orderId}-{lineNo}`, lineNo counted from 1. */
export function printerJobId(orderId: string, lineNo: number): string {
  return `${orderId}-${lineNo}`;
}

export function parsePrinterJobId(
  jobId: string,
): { lineNo: number; orderId: string } | null {
  const match = JOB_ID_PATTERN.exec(jobId);
  const orderId = match?.[1];
  const lineNo = match?.[2];
  return orderId === undefined || lineNo === undefined
    ? null
    : { lineNo: Number(lineNo), orderId };
}
