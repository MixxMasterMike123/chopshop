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
 */

import type { ShipTo } from "../commerce/recipient";

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

export const SNAPWEAR_VALIDATION_FAILED_MESSAGE = "Validation Failed";

/**
 * The duplicate-`job_id` 400 body's message. PROVISIONAL (C5): the real text is
 * not known. A client classifies a 400 as "duplicate" ONLY on this marker —
 * any other 400 is a rejection that a human looks at, never an assumed
 * success, because treating an unrecognised 400 as "already accepted" would
 * mark a job printed that the printer never took.
 */
export const SNAPWEAR_DUPLICATE_JOB_MESSAGE = "Job with this job_id already exists";

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
