import type { PlatformPrincipal } from "../auth/live-authorization";
import {
  blockedCount,
  loadScreeningConfig,
  readRescreenBacklog,
  type RescreenSummary,
  screeningInputChangeStatements,
} from "../catalog/screening";
import { FEE_RATE_BP } from "../pod/pod-quote";

/**
 * Platform settings (CP3-D) — the one `platform_settings` row (migration 0034),
 * the Cloudflare home of Firebase `settings/platform`
 * (functions/src/payment/platformConfig.ts) and of the scalar half of
 * `settings/contentScreening`.
 *
 *   GET   /v1/platform/settings   every value
 *   PATCH /v1/platform/settings   defaultCommissionBps, reviewFirstProducts,
 *                                 screeningHardBlock
 *
 * PLATFORM-ONLY ("the seller sees one number"): no tenant route reads this
 * module, and the only tenant-facing effect of a value here is the fee frozen
 * onto a checkout's PaymentIntent (src/commerce/payment.ts), which no seller
 * or buyer response itemises.
 *
 * `refundApplicationFee` and `reverseDisputeOnCreated` are READ-ONLY here: the
 * code constants REFUND_APPLICATION_FEE (src/commerce/refunds.ts, D9/D36) and
 * REVERSE_DISPUTE_ON_CREATED (src/commerce/stripe-events.ts) are what runs; the
 * columns exist for the go-live verification, and a PATCH naming either is
 * refused with `setting_not_editable`.
 */

/**
 * The migration's column defaults, for a deployment whose row is absent (the
 * migration seeds it; nothing deletes it in normal operation). The payment
 * path does NOT use this: it falls back to its own DEFAULT_COMMISSION_BPS, and
 * a test pins the two equal.
 */
export const SETTINGS_DEFAULTS = {
  defaultCommissionBps: 500,
  refundApplicationFee: false,
  reverseDisputeOnCreated: true,
  reviewFirstProducts: 2,
  screeningHardBlock: false,
} as const;

/**
 * D45: the PRISGOLV floor (src/pod/pod-quote.ts) assumes the seller pays at
 * most the 8 % BAS fee. A platform default above it would make a product
 * priced at its floor un-payable (fee > gross ⇒ the payment is refused), so
 * the route refuses it. The column itself admits 0..10000 (like
 * tenants.commission_bps).
 */
export const MAX_DEFAULT_COMMISSION_BPS = FEE_RATE_BP;
/** D8 on a sane scale; the column CHECK is the same 0..100. */
export const MAX_REVIEW_FIRST_PRODUCTS = 100;

export interface PlatformSettingsView {
  defaultCommissionBps: number;
  refundApplicationFee: boolean;
  reverseDisputeOnCreated: boolean;
  reviewFirstProducts: number;
  screeningHardBlock: boolean;
  /** Bumped by every blocklist / global-hard-block change (0034). */
  screeningTermsVersion: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface SettingsRow {
  default_commission_bps: number;
  refund_application_fee: number;
  reverse_dispute_on_created: number;
  review_first_products: number;
  screening_hard_block: number;
  screening_terms_version: number;
  updated_at: string;
  updated_by: string | null;
}

const SELECT_SETTINGS = `SELECT default_commission_bps, refund_application_fee,
     reverse_dispute_on_created, review_first_products, screening_hard_block,
     screening_terms_version, updated_at, updated_by
   FROM platform_settings WHERE id = 1 LIMIT 1`;

export async function readPlatformSettings(db: D1Database): Promise<PlatformSettingsView> {
  const row = await db.prepare(SELECT_SETTINGS).first<SettingsRow>();
  if (row === null) {
    return {
      ...SETTINGS_DEFAULTS,
      screeningTermsVersion: 0,
      updatedAt: null,
      updatedBy: null,
    };
  }
  return {
    defaultCommissionBps: row.default_commission_bps,
    refundApplicationFee: row.refund_application_fee === 1,
    reverseDisputeOnCreated: row.reverse_dispute_on_created === 1,
    reviewFirstProducts: row.review_first_products,
    screeningHardBlock: row.screening_hard_block === 1,
    screeningTermsVersion: row.screening_terms_version,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/**
 * The platform's default commission for the payment path, or null when the
 * row is absent (the caller falls back to DEFAULT_COMMISSION_BPS). A shop's
 * own `tenants.commission_bps` still wins (resolveCommissionBps).
 */
export async function readDefaultCommissionBps(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare("SELECT default_commission_bps FROM platform_settings WHERE id = 1 LIMIT 1")
    .first<{ default_commission_bps: number }>();
  return row?.default_commission_bps ?? null;
}

// ── PATCH ───────────────────────────────────────────────────────────────────

export interface PlatformSettingsPatch {
  defaultCommissionBps?: number;
  reviewFirstProducts?: number;
  screeningHardBlock?: boolean;
}

/** Named on purpose: fixed in code in CP3 (see the module comment). */
const PINNED_FIELDS = ["refundApplicationFee", "reverseDisputeOnCreated"] as const;
const EDITABLE_FIELDS = ["defaultCommissionBps", "reviewFirstProducts", "screeningHardBlock"];

export type SettingsPatchParse =
  | { patch: PlatformSettingsPatch; status: "ok" }
  | { code: "invalid_request" | "setting_not_editable"; field: string | null; status: "invalid" };

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export function parsePlatformSettingsPatch(body: unknown): SettingsPatchParse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { code: "invalid_request", field: null, status: "invalid" };
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  const pinned = PINNED_FIELDS.find((field) => keys.includes(field));
  if (pinned !== undefined) {
    return { code: "setting_not_editable", field: pinned, status: "invalid" };
  }
  const unknown = keys.find((key) => !EDITABLE_FIELDS.includes(key));
  if (unknown !== undefined || keys.length === 0) {
    return { code: "invalid_request", field: unknown ?? null, status: "invalid" };
  }

  const patch: PlatformSettingsPatch = {};
  if ("defaultCommissionBps" in record) {
    if (!isIntegerIn(record.defaultCommissionBps, 0, MAX_DEFAULT_COMMISSION_BPS)) {
      return { code: "invalid_request", field: "defaultCommissionBps", status: "invalid" };
    }
    patch.defaultCommissionBps = record.defaultCommissionBps;
  }
  if ("reviewFirstProducts" in record) {
    if (!isIntegerIn(record.reviewFirstProducts, 0, MAX_REVIEW_FIRST_PRODUCTS)) {
      return { code: "invalid_request", field: "reviewFirstProducts", status: "invalid" };
    }
    patch.reviewFirstProducts = record.reviewFirstProducts;
  }
  if ("screeningHardBlock" in record) {
    if (typeof record.screeningHardBlock !== "boolean") {
      return { code: "invalid_request", field: "screeningHardBlock", status: "invalid" };
    }
    patch.screeningHardBlock = record.screeningHardBlock;
  }
  return { patch, status: "ok" };
}

export type SettingsUpdateResult =
  | { rescreen: RescreenSummary | null; settings: PlatformSettingsView; status: "ok" }
  | { status: "conflict" };

/**
 * One audited batch. Each field is written only when named (COALESCE), so two
 * operators editing different fields never undo each other.
 *
 * `screeningHardBlock` is screening input for every live product: when it is
 * named, the batch also moves screening_terms_version (the fence) and carries
 * the same safety + fast-forward statements as a term change
 * (src/catalog/screening.ts), so switching it ON takes every public product
 * with any blocklist hit off the storefront in this batch. A concurrent term
 * change trips the fence: re-planned once from fresh reads, then `conflict`.
 *
 * `reviewFirstProducts` needs no re-screen: D8 decides requires_approval once,
 * at a product's first screening, so the new N applies to first screenings
 * from now on (a product already pending stays pending until approved).
 */
export async function updatePlatformSettings(
  db: D1Database,
  principal: PlatformPrincipal,
  patch: PlatformSettingsPatch,
  now: number,
): Promise<SettingsUpdateResult> {
  const screening = patch.screeningHardBlock !== undefined;

  for (let round = 0; round < 2; round += 1) {
    const attemptNow = round === 0 ? now : Math.max(now, Date.now());
    const iso = new Date(attemptNow).toISOString();
    const before = await readPlatformSettings(db);
    // Version FIRST, then the terms (loadScreeningConfig) — see there.
    const config = screening ? await loadScreeningConfig(db) : null;
    const nextVersion = config === null ? null : config.termsVersion + 1;

    // screening_terms_version is named in the SET only when it moves: its
    // forward-only trigger fires on any UPDATE OF it, even to the same value.
    const statements: D1PreparedStatement[] = [
      db
        .prepare(
          `INSERT INTO platform_settings (
             id, default_commission_bps, review_first_products, screening_hard_block,
             screening_terms_version, updated_at, updated_by
           ) VALUES (1, COALESCE(?1, 500), COALESCE(?2, 2), COALESCE(?3, 0), COALESCE(?4, 1), ?5, ?6)
           ON CONFLICT(id) DO UPDATE SET
             default_commission_bps = COALESCE(?1, platform_settings.default_commission_bps),
             review_first_products = COALESCE(?2, platform_settings.review_first_products),
             screening_hard_block = COALESCE(?3, platform_settings.screening_hard_block),
             ${nextVersion === null ? "" : "screening_terms_version = ?4,"}
             updated_at = max(?5, platform_settings.updated_at),
             updated_by = ?6`,
        )
        .bind(
          patch.defaultCommissionBps ?? null,
          patch.reviewFirstProducts ?? null,
          patch.screeningHardBlock === undefined ? null : patch.screeningHardBlock ? 1 : 0,
          nextVersion,
          iso,
          principal.userId,
        ),
    ];
    if (config !== null) {
      statements.push(
        ...screeningInputChangeStatements(
          db,
          config.blocklist,
          patch.screeningHardBlock === true,
          config.termsVersion,
          attemptNow,
        ),
      );
    }

    const changed: Record<string, { after: unknown; before: unknown }> = {};
    for (const [field, value] of Object.entries(patch)) {
      changed[field] = { after: value, before: before[field as keyof PlatformSettingsView] };
    }
    statements.push(
      db
        .prepare(
          `INSERT INTO audit_events (
             event_id, tenant_id, actor_user_id, action, resource_type,
             resource_id, request_id, metadata_json, created_at
           ) VALUES (?, NULL, ?, 'platform_settings.update', 'platform_settings', '1', ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), principal.userId, crypto.randomUUID(), JSON.stringify(changed), attemptNow),
    );

    let results: D1Result[];
    try {
      results = await db.batch(statements);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("screening terms changed")) {
        continue;
      }
      throw error;
    }

    return {
      rescreen:
        config === null
          ? null
          : { blockedNow: blockedCount(results[1]), ...(await readRescreenBacklog(db)) },
      settings: await readPlatformSettings(db),
      status: "ok",
    };
  }
  return { status: "conflict" };
}
