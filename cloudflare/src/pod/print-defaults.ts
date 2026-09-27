import type { PlatformPrincipal } from "../auth/live-authorization";
import { isPrinterId } from "./printers";

/**
 * The platform's default printer (CP3; migration 0035 `print_defaults`).
 *
 * The only survivor of Firebase `settings/printRouting` (D52): Cloudflare has
 * no garment → printer routing because a POD mapping names its printer and the
 * printer's SKU directly. NOTHING IN THE WORKER READS THIS VALUE YET — the
 * mapping route requires a printer id (a printer SKU only means something
 * inside one printer's catalogue), and the quote and the checkout price the
 * mapping's own printer. It is stored so the importer can carry and verify the
 * Firebase default, and so the studio (CP6) can preselect a printer.
 *
 * PLATFORM-ONLY: the routes in src/routes/pod-platform.ts.
 */

export interface DefaultPrinterView {
  /** The default printer's status, or null when there is no default. */
  printerActive: boolean | null;
  printerId: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export type SetDefaultPrinterResult =
  | { defaultPrinter: DefaultPrinterView; status: "ok" }
  | { code: "printer_inactive" | "printer_not_found" | "tenant_printer"; status: "refused" };

interface DefaultRow {
  printer_status: "active" | "inactive" | null;
  default_printer_id: string | null;
  updated_at: string;
  updated_by: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{ "printerId": "<id>" }` or `{ "printerId": null }` — nothing else. */
export function parseDefaultPrinterInput(body: unknown): { printerId: string | null } | null {
  if (!isPlainObject(body) || Object.keys(body).length !== 1 || !("printerId" in body)) {
    return null;
  }
  const { printerId } = body;
  if (printerId === null) {
    return { printerId: null };
  }
  return isPrinterId(printerId) ? { printerId } : null;
}

export async function readDefaultPrinter(db: D1Database): Promise<DefaultPrinterView> {
  const row = await db
    .prepare(
      `SELECT d.default_printer_id, d.updated_at, d.updated_by, p.status AS printer_status
       FROM print_defaults AS d
       LEFT JOIN printers AS p ON p.id = d.default_printer_id
       WHERE d.id = 1`,
    )
    .first<DefaultRow>();
  // The migration seeds the row and a trigger forbids deleting it; a missing
  // row reads as "no default" rather than failing the route.
  if (row === null) {
    return { printerActive: null, printerId: null, updatedAt: new Date(0).toISOString(), updatedBy: null };
  }
  return {
    printerActive: row.default_printer_id === null ? null : row.printer_status === "active",
    printerId: row.default_printer_id,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/**
 * Set (or clear, with null) the default printer. The target must exist, be a
 * PLATFORM printer and be ACTIVE at the time of writing.
 *
 * The write re-checks those three facts INSIDE its own statement (so a
 * deactivation racing the pre-check leaves the default untouched and the
 * route answers `printer_inactive`), and the audit row is inserted only when
 * the write took effect — same batch, never an audit row for a write that did
 * not happen.
 */
export async function setDefaultPrinter(
  db: D1Database,
  principal: PlatformPrincipal,
  printerId: string | null,
  now: number,
): Promise<SetDefaultPrinterResult> {
  if (printerId !== null) {
    const printer = await db
      .prepare("SELECT tenant_id, status FROM printers WHERE id = ?")
      .bind(printerId)
      .first<{ status: string; tenant_id: string | null }>();
    if (printer === null) {
      return { code: "printer_not_found", status: "refused" };
    }
    if (printer.tenant_id !== null) {
      return { code: "tenant_printer", status: "refused" };
    }
    if (printer.status !== "active") {
      return { code: "printer_inactive", status: "refused" };
    }
  }

  const iso = new Date(now).toISOString();
  const eligible = `(?1 IS NULL OR EXISTS (
       SELECT 1 FROM printers WHERE id = ?1 AND tenant_id IS NULL AND status = 'active'))`;
  const [written] = await db.batch([
    db
      .prepare(
        `INSERT INTO print_defaults (id, default_printer_id, updated_at, updated_by)
         SELECT 1, ?1, ?2, ?3 WHERE ${eligible}
         ON CONFLICT(id) DO UPDATE SET
           default_printer_id = excluded.default_printer_id,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .bind(printerId, iso, principal.userId),
    db
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type,
           resource_id, request_id, metadata_json, created_at
         )
         SELECT ?4, NULL, ?3, 'pod.printers.default', 'print_defaults', '1', ?5, ?6, ?7
         WHERE EXISTS (
           SELECT 1 FROM print_defaults
           WHERE id = 1 AND default_printer_id IS ?1 AND updated_at = ?2 AND updated_by IS ?3
         )`,
      )
      .bind(
        printerId,
        iso,
        principal.userId,
        crypto.randomUUID(),
        crypto.randomUUID(),
        JSON.stringify({ printerId }),
        now,
      ),
  ]);
  if ((written?.meta.changes ?? 0) === 0) {
    return { code: "printer_inactive", status: "refused" };
  }
  return { defaultPrinter: await readDefaultPrinter(db), status: "ok" };
}
