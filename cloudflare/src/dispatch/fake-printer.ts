import { SNAPWEAR_SKUS } from "./snapwear-skus";
import { parsePrinterJobId } from "./snapwear-wire";

/**
 * The staging fake printer: validation and storage behind
 * `/v1/staging/fake-printer/jobs` (src/routes/fake-printer.ts), migration 0018.
 *
 * It behaves like SnapWear where SnapWear's behaviour is known (see
 * src/dispatch/snapwear-wire.ts): 201 for a new `job_id`, 400 for a duplicate,
 * 422 `Validation Failed` for a bad body — including a SKU SnapWear does not
 * sell. It is STRICTER in one place: a `job_id` must name an order that exists
 * in this database, because the fake records per order and a job for an unknown
 * order can only be a dispatcher bug.
 */

export const FAKE_PRINTER_JOBS_PATH = "/v1/staging/fake-printer/jobs";

/** An inbound credential: the same floor as BOOTSTRAP_TOKEN. */
export const MINIMUM_FAKE_PRINTER_TOKEN_LENGTH = 32;

const MAX_ITEMS = 50;
const MAX_QUANTITY = 1_000;
const MAX_URLS = 10;
const MAX_URL_LENGTH = 4_096;
export const MAX_FAKE_PRINTER_PAYLOAD_LENGTH = 65_536;
const LIST_LIMIT = 100;

/**
 * The fake exists ONLY on staging, and only when staging is pointed at it.
 * Production pins `DISPATCH_TARGET = "snapwear"`, so this is false there by two
 * independent conditions; a missing or short token darkens it too.
 */
export function isFakePrinterEnabled(env: Env): boolean {
  return (
    env.APP_ENV === "staging" &&
    env.DISPATCH_TARGET === "fake-printer" &&
    typeof env.FAKE_PRINTER_TOKEN === "string" &&
    env.FAKE_PRINTER_TOKEN.length >= MINIMUM_FAKE_PRINTER_TOKEN_LENGTH
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The job id, if the body carries one as a string — for the duplicate check. */
export function readSubmittedJobId(body: unknown): string | null {
  return isPlainObject(body) && typeof body.job_id === "string" && body.job_id.length > 0
    ? body.job_id
    : null;
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) {
    return false;
  }
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export type FakePrinterValidation =
  | { errors: Record<string, string[]>; status: "invalid" }
  | { orderId: string; status: "valid" };

/**
 * Field-level validation with Laravel-style messages keyed by field path, the
 * shape SnapWear's 422 `errors` object takes. Unknown top-level fields are
 * accepted and stored untouched (see snapwear-wire.ts on shipping fields).
 */
export function validateSnapwearJob(body: unknown): FakePrinterValidation {
  if (!isPlainObject(body)) {
    return {
      errors: { body: ["The request body must be a JSON object."] },
      status: "invalid",
    };
  }

  const errors: Record<string, string[]> = {};
  const fail = (field: string, message: string) => {
    (errors[field] ??= []).push(message);
  };

  let orderId: string | null = null;
  if (typeof body.job_id !== "string" || body.job_id.length === 0) {
    fail("job_id", "The job id field is required.");
  } else {
    orderId = parsePrinterJobId(body.job_id)?.orderId ?? null;
    if (orderId === null) {
      fail("job_id", "The job id format is invalid.");
    }
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    fail("items", "The items field is required.");
  } else if (body.items.length > MAX_ITEMS) {
    fail("items", `The items may not have more than ${MAX_ITEMS} items.`);
  } else {
    body.items.forEach((item: unknown, index: number) => {
      const entry = isPlainObject(item) ? item : {};
      if (typeof entry.sku !== "string" || !SNAPWEAR_SKUS.has(entry.sku)) {
        fail(`items.${index}.sku`, `The selected items.${index}.sku is invalid.`);
      }
      const quantity = entry.quantity;
      if (typeof quantity !== "number" || !Number.isInteger(quantity)) {
        fail(`items.${index}.quantity`, `The items.${index}.quantity must be an integer.`);
      } else if (quantity < 1) {
        fail(`items.${index}.quantity`, `The items.${index}.quantity must be at least 1.`);
      } else if (quantity > MAX_QUANTITY) {
        fail(
          `items.${index}.quantity`,
          `The items.${index}.quantity may not be greater than ${MAX_QUANTITY}.`,
        );
      }
    });
  }

  const artworks = body.artworks;
  if (!Array.isArray(artworks) || artworks.length === 0) {
    fail("artworks", "The artworks field is required.");
  } else if (artworks.length > MAX_URLS) {
    fail("artworks", `The artworks may not have more than ${MAX_URLS} items.`);
  } else {
    artworks.forEach((artwork: unknown, index: number) => {
      const url = isPlainObject(artwork) ? artwork.url : undefined;
      if (url === undefined || url === null || url === "") {
        fail(`artworks.${index}.url`, `The artworks.${index}.url field is required.`);
      } else if (!isHttpsUrl(url)) {
        fail(`artworks.${index}.url`, `The artworks.${index}.url must be a valid URL.`);
      }
    });
  }

  const layouts = body.layouts;
  if (!Array.isArray(layouts)) {
    fail("layouts", "The layouts field is required.");
  } else if (Array.isArray(artworks) && layouts.length !== artworks.length) {
    fail("layouts", "The layouts must have one entry per artwork.");
  } else {
    layouts.forEach((layout: unknown, index: number) => {
      const location = isPlainObject(layout) ? layout.location : undefined;
      if (location !== "front" && location !== "back") {
        fail(
          `layouts.${index}.location`,
          `The selected layouts.${index}.location is invalid.`,
        );
      }
    });
  }

  if (body.mockups !== undefined) {
    if (!Array.isArray(body.mockups) || body.mockups.length > MAX_URLS) {
      fail("mockups", "The mockups must be an array.");
    } else {
      body.mockups.forEach((mockup: unknown, index: number) => {
        if (!isHttpsUrl(isPlainObject(mockup) ? mockup.url : undefined)) {
          fail(`mockups.${index}.url`, `The mockups.${index}.url must be a valid URL.`);
        }
      });
    }
  }

  if (orderId === null || Object.keys(errors).length > 0) {
    return { errors, status: "invalid" };
  }

  return { orderId, status: "valid" };
}

export async function fakePrinterJobExists(
  db: D1Database,
  jobId: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS present FROM fake_printer_jobs WHERE job_id = ? LIMIT 1")
    .bind(jobId)
    .first<{ present: number }>();
  return row !== null;
}

export type RecordFakePrinterJobResult =
  | { id: string; status: "accepted" }
  | { status: "duplicate" | "unknown_order" };

/**
 * Record one accepted submission. The UNIQUE `job_id` is the arbiter: of two
 * racing submissions of the same id exactly one is accepted and the other is a
 * duplicate, which is the property the dispatcher's retry depends on.
 */
export async function recordFakePrinterJob(
  db: D1Database,
  input: { jobId: string; orderId: string; payloadJson: string; now: number },
): Promise<RecordFakePrinterJobResult> {
  const order = await db
    .prepare("SELECT tenant_id FROM orders WHERE order_id = ? LIMIT 1")
    .bind(input.orderId)
    .first<{ tenant_id: string }>();
  if (order === null) {
    return { status: "unknown_order" };
  }

  const id = crypto.randomUUID();
  try {
    await db
      .prepare(
        `INSERT INTO fake_printer_jobs (id, tenant_id, job_id, order_id, payload_json, received_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        order.tenant_id,
        input.jobId,
        input.orderId,
        input.payloadJson,
        new Date(input.now).toISOString(),
      )
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("UNIQUE constraint failed")) {
      return { status: "duplicate" };
    }
    throw error;
  }

  return { id, status: "accepted" };
}

export interface FakePrinterJob {
  id: string;
  jobId: string;
  orderId: string;
  payload: unknown;
  receivedAt: string;
  tenantId: string;
}

export async function listFakePrinterJobs(
  db: D1Database,
  orderId: string,
): Promise<FakePrinterJob[]> {
  const rows = await db
    .prepare(
      `SELECT id, tenant_id, job_id, order_id, payload_json, received_at
       FROM fake_printer_jobs
       WHERE order_id = ?
       ORDER BY received_at, id
       LIMIT ${LIST_LIMIT}`,
    )
    .bind(orderId)
    .all<{
      id: string;
      job_id: string;
      order_id: string;
      payload_json: string;
      received_at: string;
      tenant_id: string;
    }>();

  return rows.results.map((row) => ({
    id: row.id,
    jobId: row.job_id,
    orderId: row.order_id,
    payload: JSON.parse(row.payload_json) as unknown,
    receivedAt: row.received_at,
    tenantId: row.tenant_id,
  }));
}
