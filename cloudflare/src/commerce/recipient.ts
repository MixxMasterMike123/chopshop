import { isPlainObject, sanitizeStoreIdentity } from "../platform/tenant-config";
import { projectPickupLocations } from "../storefront/identity-projection";
import type { DeliveryMethod } from "./shipping";

/**
 * The recipient of an order (CP4-R, DECISIONS D98): who gets it and where.
 * Tables: migrations/0045_order_recipients.sql.
 *
 *   POST /v1/checkout  takes `recipient`, validated here (parseRecipient), the
 *                      pickup place checked against the shop's own places
 *                      (resolveRecipient) and frozen with the checkout
 *                      (checkoutRecipientStatement) — part of what the
 *                      idempotency key stands for (sameRecipient).
 *   the order          copied from the checkout's row in the batch that
 *                      creates the order (copyRecipientToOrderStatement).
 *   the reads          the buyer's (receipt token), the seller's and the
 *                      platform's order answer `recipient` (readOrderRecipient,
 *                      readOrderRecipients): RecipientView, or null for an
 *                      order made before 0045.
 *   the printer        a shipped order's job carries the address
 *                      (readDispatchShipTo; the wire shape is the
 *                      printer's, src/dispatch/snapwear-wire.ts).
 *
 * PERSONAL DATA (D68). Nothing of a recipient is written to a log line, an
 * audit event, an alert or an outbox payload: those carry ids only. The texts
 * are stored as given (trimmed) and are TEXT wherever they are shown: nothing
 * here is HTML.
 */

// ── the request ─────────────────────────────────────────────────────────────

export interface ShippingRecipientInput {
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  country: string;
  deliveryMethod: "shipping";
  name: string;
  phone: string | null;
  postalCode: string;
}

export interface PickupRecipientInput {
  deliveryMethod: "pickup";
  name: string;
  phone: string | null;
  pickupDate: string | null;
  pickupLocationId: string;
}

export type RecipientInput = PickupRecipientInput | ShippingRecipientInput;

const SHIPPING_KEYS = [
  "addressLine1",
  "addressLine2",
  "city",
  "country",
  "name",
  "phone",
  "postalCode",
] as const;
const PICKUP_KEYS = ["name", "phone", "pickupDate", "pickupLocationId"] as const;

const NAME_MAX = 100;
const ADDRESS_LINE_MAX = 100;
const POSTAL_CODE_MAX = 16;
const CITY_MAX = 100;
const PHONE_MAX = 30;
const PICKUP_LOCATION_ID_MAX = 128;

/** C0, DEL, C1, and the two Unicode line separators: never in a one-line text. */
const FORBIDDEN_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const PHONE_PATTERN = /^[0-9 +()-]*$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Length in code points, as SQLite's length() counts TEXT. */
function lengthOf(value: string): number {
  return Array.from(value).length;
}

/** A trimmed one-line text of `min`–`max` code points, or null. */
function parseText(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  // The control-character test runs on the RAW value: a text that only
  // becomes valid once a trailing line break is trimmed off is refused.
  if (FORBIDDEN_CHARACTERS.test(value)) {
    return null;
  }
  const text = value.trim();
  const length = lengthOf(text);
  return length >= min && length <= max ? text : null;
}

/** Absent, or a text of 1–max. */
function parseOptionalText(
  value: unknown,
  max: number,
): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined) {
    return { ok: true, value: null };
  }
  const text = parseText(value, 1, max);
  return text === null ? { ok: false } : { ok: true, value: text };
}

/** Absent or 0–30 of digits, space, + - ( ); empty is stored as none. */
function parsePhone(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined) {
    return { ok: true, value: null };
  }
  const text = parseText(value, 0, PHONE_MAX);
  if (text === null || !PHONE_PATTERN.test(text)) {
    return { ok: false };
  }
  return { ok: true, value: text === "" ? null : text };
}

/** A real calendar date YYYY-MM-DD (2026-02-30 is not one). */
function isIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * `recipient` of POST /v1/checkout, or null — one answer (400
 * invalid_request) for every fault, as the route answers any other.
 *
 *   shipping  { name, addressLine1, addressLine2?, postalCode, city, country,
 *               phone? } — `country` two upper-case letters and EQUAL to the
 *               checkout's `shippingCountry` (already normalised upper-case)
 *   pickup    { name, phone?, pickupLocationId, pickupDate? } — the place and
 *               the date are checked against the shop's own places by
 *               resolveRecipient, which needs the database
 *
 * The fields the checkout page requires are required here: a name always; for
 * a parcel the street, the postal code and the city. Unknown keys — including
 * a pickup key on a parcel and the reverse — are refused.
 */
export function parseRecipient(
  value: unknown,
  deliveryMethod: DeliveryMethod,
  shippingCountry: string | null,
): RecipientInput | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const allowed: readonly string[] = deliveryMethod === "shipping" ? SHIPPING_KEYS : PICKUP_KEYS;
  if (!Object.keys(value).every((key) => allowed.includes(key))) {
    return null;
  }

  const name = parseText(value.name, 1, NAME_MAX);
  const phone = parsePhone(value.phone);
  if (name === null || !phone.ok) {
    return null;
  }

  if (deliveryMethod === "shipping") {
    const addressLine1 = parseText(value.addressLine1, 1, ADDRESS_LINE_MAX);
    const addressLine2 = parseOptionalText(value.addressLine2, ADDRESS_LINE_MAX);
    const postalCode = parseText(value.postalCode, 1, POSTAL_CODE_MAX);
    const city = parseText(value.city, 1, CITY_MAX);
    const country =
      typeof value.country === "string" && COUNTRY_PATTERN.test(value.country)
        ? value.country
        : null;
    if (
      addressLine1 === null ||
      !addressLine2.ok ||
      postalCode === null ||
      city === null ||
      country === null ||
      country !== shippingCountry
    ) {
      return null;
    }
    return {
      addressLine1,
      addressLine2: addressLine2.value,
      city,
      country,
      deliveryMethod,
      name,
      phone: phone.value,
      postalCode,
    };
  }

  const pickupLocationId =
    typeof value.pickupLocationId === "string" &&
    value.pickupLocationId.length >= 1 &&
    value.pickupLocationId.length <= PICKUP_LOCATION_ID_MAX &&
    !FORBIDDEN_CHARACTERS.test(value.pickupLocationId)
      ? value.pickupLocationId
      : null;
  let pickupDate: string | null = null;
  if (value.pickupDate !== undefined) {
    if (typeof value.pickupDate !== "string" || !isIsoDate(value.pickupDate)) {
      return null;
    }
    pickupDate = value.pickupDate;
  }
  if (pickupLocationId === null) {
    return null;
  }
  return { deliveryMethod, name, phone: phone.value, pickupDate, pickupLocationId };
}

// ── resolved and frozen ─────────────────────────────────────────────────────

/** What is stored: the input, and for a pickup the place as it is now. */
export type FrozenRecipient =
  | ShippingRecipientInput
  | (PickupRecipientInput & {
      pickupLocationAddress: string | null;
      pickupLocationName: string | null;
    });

/**
 * The recipient as it is frozen, or null when the pickup place is not one of
 * the shop's own (tenant_settings.store_identity_json `pickupLocations`, read
 * through the same projection the storefront shows), or the date is not one of
 * that place's dates. A place that offers dates needs one; a place that offers
 * none takes none. The place's name and address are copied now, so the order
 * keeps them whatever the shop's settings say later.
 */
export async function resolveRecipient(
  db: D1Database,
  tenantId: string,
  input: RecipientInput,
): Promise<FrozenRecipient | null> {
  if (input.deliveryMethod === "shipping") {
    return input;
  }

  const row = await db
    .prepare("SELECT store_identity_json FROM tenant_settings WHERE tenant_id = ? LIMIT 1")
    .bind(tenantId)
    .first<{ store_identity_json: string }>();
  let identity: Record<string, unknown> = {};
  try {
    const parsed: unknown = row === null ? {} : JSON.parse(row.store_identity_json);
    identity = isPlainObject(parsed) ? sanitizeStoreIdentity(parsed) : {};
  } catch {
    identity = {};
  }

  const place = projectPickupLocations(identity.pickupLocations).find(
    (location) => location.id === input.pickupLocationId,
  );
  if (place === undefined) {
    return null;
  }
  // The same list the storefront offers (Checkout.jsx: a place with dates
  // needs one of them).
  const dates = place.dates;
  if (dates.length > 0 ? input.pickupDate === null || !dates.includes(input.pickupDate) : input.pickupDate !== null) {
    return null;
  }

  return {
    ...input,
    pickupLocationAddress: nonEmpty(place.address),
    pickupLocationName: nonEmpty(place.name),
  };
}

function nonEmpty(value: string | undefined): string | null {
  const text = value?.trim();
  return text === undefined || text === "" ? null : text;
}

// ── the rows ────────────────────────────────────────────────────────────────

interface RecipientRow {
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  country: string | null;
  delivery_method: string;
  name: string;
  phone: string | null;
  pickup_date: string | null;
  pickup_location_address: string | null;
  pickup_location_id: string | null;
  pickup_location_name: string | null;
  postal_code: string | null;
}

const RECIPIENT_COLUMNS = `delivery_method, name, phone, address_line1, address_line2,
  postal_code, city, country, pickup_location_id, pickup_location_name,
  pickup_location_address, pickup_date`;

function columnValues(recipient: FrozenRecipient): unknown[] {
  if (recipient.deliveryMethod === "shipping") {
    return [
      "shipping",
      recipient.name,
      recipient.phone,
      recipient.addressLine1,
      recipient.addressLine2,
      recipient.postalCode,
      recipient.city,
      recipient.country,
      null,
      null,
      null,
      null,
    ];
  }
  return [
    "pickup",
    recipient.name,
    recipient.phone,
    null,
    null,
    null,
    null,
    null,
    recipient.pickupLocationId,
    recipient.pickupLocationName,
    recipient.pickupLocationAddress,
    recipient.pickupDate,
  ];
}

/** The checkout's row, for the batch that creates the checkout. */
export function checkoutRecipientStatement(
  db: D1Database,
  tenantId: string,
  checkoutId: string,
  recipient: FrozenRecipient,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO checkout_recipients (
         checkout_id, tenant_id, ${RECIPIENT_COLUMNS}, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(checkoutId, tenantId, ...columnValues(recipient), new Date(now).toISOString());
}

export async function readCheckoutRecipient(
  db: D1Database,
  tenantId: string,
  checkoutId: string,
): Promise<RecipientRow | null> {
  return db
    .prepare(
      `SELECT ${RECIPIENT_COLUMNS}
       FROM checkout_recipients
       WHERE tenant_id = ? AND checkout_id = ?
       LIMIT 1`,
    )
    .bind(tenantId, checkoutId)
    .first<RecipientRow>();
}

/**
 * The idempotency fingerprint's recipient half: the stored row against the
 * freshly frozen one, column by column — including the pickup place's name and
 * address, so a place renamed between two attempts conflicts just as a
 * renamed product does. No row and no recipient (an engine-level checkout, or
 * one made before 0045) match each other and nothing else.
 */
export function sameRecipient(stored: RecipientRow | null, fresh: FrozenRecipient | null): boolean {
  if (stored === null || fresh === null) {
    return stored === null && fresh === null;
  }
  const values = columnValues(fresh);
  const storedValues = [
    stored.delivery_method,
    stored.name,
    stored.phone,
    stored.address_line1,
    stored.address_line2,
    stored.postal_code,
    stored.city,
    stored.country,
    stored.pickup_location_id,
    stored.pickup_location_name,
    stored.pickup_location_address,
    stored.pickup_date,
  ];
  return values.every((value, index) => value === storedValues[index]);
}

/**
 * The order's row, copied from the checkout's in the batch that creates the
 * order. INSERT … SELECT: a checkout without a row (every one made before
 * 0045) copies nothing, and the order is created and read as before.
 */
export function copyRecipientToOrderStatement(
  db: D1Database,
  tenantId: string,
  checkoutId: string,
  orderId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO order_recipients (order_id, tenant_id, ${RECIPIENT_COLUMNS}, created_at)
       SELECT ?, tenant_id, ${RECIPIENT_COLUMNS}, ?
       FROM checkout_recipients
       WHERE tenant_id = ? AND checkout_id = ?`,
    )
    .bind(orderId, new Date(now).toISOString(), tenantId, checkoutId);
}

// ── the reads ───────────────────────────────────────────────────────────────

/**
 * `recipient` of the three order reads. Every key is always present; a key
 * that does not apply to the delivery method is null.
 *
 *   shipping  { deliveryMethod: "shipping", name, phone, addressLine1,
 *               addressLine2, postalCode, city, country,
 *               pickupLocationId: null, pickupLocationName: null,
 *               pickupLocationAddress: null, pickupDate: null }
 *   pickup    { deliveryMethod: "pickup", name, phone, addressLine1: null, …,
 *               pickupLocationId, pickupLocationName, pickupLocationAddress,
 *               pickupDate } — the place as it was when the checkout was made
 */
export interface RecipientView {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  country: string | null;
  deliveryMethod: "pickup" | "shipping";
  name: string;
  phone: string | null;
  pickupDate: string | null;
  pickupLocationAddress: string | null;
  pickupLocationId: string | null;
  pickupLocationName: string | null;
  postalCode: string | null;
}

function toView(row: RecipientRow): RecipientView {
  return {
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    country: row.country,
    deliveryMethod: row.delivery_method === "pickup" ? "pickup" : "shipping",
    name: row.name,
    phone: row.phone,
    pickupDate: row.pickup_date,
    pickupLocationAddress: row.pickup_location_address,
    pickupLocationId: row.pickup_location_id,
    pickupLocationName: row.pickup_location_name,
    postalCode: row.postal_code,
  };
}

/** One order's recipient, of `tenantId` only; null when it has none. */
export async function readOrderRecipient(
  db: D1Database,
  tenantId: string,
  orderId: string,
): Promise<RecipientView | null> {
  const row = await db
    .prepare(
      `SELECT ${RECIPIENT_COLUMNS}
       FROM order_recipients
       WHERE tenant_id = ? AND order_id = ?
       LIMIT 1`,
    )
    .bind(tenantId, orderId)
    .first<RecipientRow>();
  return row === null ? null : toView(row);
}

/** D1 bound-parameter budget (PLAN §2.7): IN (…) lists are chunked. */
const IN_CHUNK = 90;

/** A page of orders' recipients, of `tenantId` only, by order id. */
export async function readOrderRecipients(
  db: D1Database,
  tenantId: string,
  orderIds: readonly string[],
): Promise<Map<string, RecipientView>> {
  const recipients = new Map<string, RecipientView>();
  for (let start = 0; start < orderIds.length; start += IN_CHUNK) {
    const ids = orderIds.slice(start, start + IN_CHUNK);
    const rows = await db
      .prepare(
        `SELECT order_id, ${RECIPIENT_COLUMNS}
         FROM order_recipients
         WHERE tenant_id = ? AND order_id IN (${ids.map(() => "?").join(", ")})
         LIMIT ${IN_CHUNK}`,
      )
      .bind(tenantId, ...ids)
      .all<RecipientRow & { order_id: string }>();
    for (const row of rows.results) {
      recipients.set(row.order_id, toView(row));
    }
  }
  return recipients;
}

// ── the printer ─────────────────────────────────────────────────────────────

/** Where the printer ships a parcel: the recipient of a SHIPPED order. */
export interface ShipTo {
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  country: string;
  name: string;
  phone: string | null;
  postalCode: string;
}

/**
 * The address the printer's job of `orderId` carries: the order's recipient
 * when the order is shipped, else null (a collected order, or an order made
 * before 0045). Tenant-scoped like every read.
 */
export async function readDispatchShipTo(
  db: D1Database,
  tenantId: string,
  orderId: string,
): Promise<ShipTo | null> {
  const row = await db
    .prepare(
      `SELECT r.name, r.phone, r.address_line1, r.address_line2, r.postal_code,
              r.city, r.country
       FROM order_recipients AS r
       JOIN orders AS o ON o.order_id = r.order_id AND o.tenant_id = r.tenant_id
       WHERE r.tenant_id = ? AND r.order_id = ?
         AND r.delivery_method = 'shipping' AND o.delivery_method = 'shipping'
       LIMIT 1`,
    )
    .bind(tenantId, orderId)
    .first<RecipientRow>();
  if (
    row === null ||
    row.address_line1 === null ||
    row.postal_code === null ||
    row.city === null ||
    row.country === null
  ) {
    return null;
  }
  return {
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    country: row.country,
    name: row.name,
    phone: row.phone,
    postalCode: row.postal_code,
  };
}
