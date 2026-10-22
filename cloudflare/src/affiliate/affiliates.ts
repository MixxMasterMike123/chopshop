import type { TenantAdminPrincipal } from "../auth/live-authorization";
import { auditMetadataJson } from "../auth/live-authorization";
import { normalizeDiscountCode } from "../commerce/discount-codes";
import { readCanonicalOrigins } from "../lib/origins";

/**
 * CP13 — the affiliate rows: codes, rates, the shop's edit, the status, the
 * adjustment (design §3.1, §5.3). The admission (approval, invite) is
 * approval.ts; the money rows are ledger.ts and payouts.ts.
 *
 * NO HARD DELETE (R2-9): "Ta bort" is user-lifecycle.ts
 * revokeAffiliateMembership (inactive + the membership revoked).
 */

// ── codes ───────────────────────────────────────────────────────────────────

/** 0059 affiliates.code: 3–20 of [A-Z0-9-], upper case. */
export const AFFILIATE_CODE_PATTERN = /^[A-Z0-9-]{3,20}$/;

/**
 * Refused as a code app-side (design §3.1): words a link or a support case
 * would confuse, and the shop's own id (upper-cased).
 */
export const RESERVED_AFFILIATE_CODES: readonly string[] = [
  "ADMIN",
  "AFFILIATE",
  "FLIPPINSTUFF",
  "METEORPR",
  "REF",
  "TEST",
];

export type CodeRefusal = "code_invalid" | "code_reserved";

/** A requested vanity code, normalized (trim, upper case), or why it cannot be one. */
export function parseVanityCode(value: unknown, tenantId: string): { code: string } | { refusal: CodeRefusal } {
  if (typeof value !== "string") {
    return { refusal: "code_invalid" };
  }
  const code = normalizeDiscountCode(value);
  if (!AFFILIATE_CODE_PATTERN.test(code)) {
    return { refusal: "code_invalid" };
  }
  if (RESERVED_AFFILIATE_CODES.includes(code) || code === tenantId.toUpperCase()) {
    return { refusal: "code_reserved" };
  }
  return { code };
}

/** Crockford's base32 without I, L, O, U: read aloud, typed back. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A generated code: the first three letters of the name (A–Z after the
 * accents are dropped, padded with X) and six random characters, e.g.
 * `ANN7K2QX9`. Never a reserved word (it always carries the random part).
 */
export function generateAffiliateCode(name: string): string {
  const letters = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  const prefix = (letters + "XXX").slice(0, 3);
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let suffix = "";
  for (const byte of bytes) {
    suffix += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return `${prefix}${suffix}`;
}

/**
 * Was a write refused because the code is taken — by another affiliate of the
 * shop (UNIQUE) or by a Rabattkod (0059's collision trigger pair)?
 */
export function isCodeTaken(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("affiliate code collides with a discount code") ||
    message.includes("UNIQUE constraint failed: affiliates.tenant_id, affiliates.code")
  );
}

// ── rates and fields ────────────────────────────────────────────────────────

/** A whole percent 0–100 (the UI's unit, design §5.3) as basis points, or null. */
export function percentToBp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100 ? value * 100 : null;
}

export const PROMOTION_METHODS = ["blog", "youtube", "instagram", "facebook", "tiktok", "forum", "other"] as const;
export type PromotionMethod = (typeof PROMOTION_METHODS)[number];
export const SOCIAL_KEYS = ["facebook", "instagram", "tiktok", "website", "youtube"] as const;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** A bounded single-line text, trimmed; null for absent/empty; undefined when invalid. */
export function parseText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  if (text === "") {
    return null;
  }
  return text.length <= max && !CONTROL.test(text) ? text : undefined;
}

/** `{ website?, instagram?, youtube?, facebook?, tiktok? }`, each a bounded text; JSON or null. */
export function parseSocials(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!(SOCIAL_KEYS as readonly string[]).includes(key)) {
      return undefined;
    }
    const text = parseText(raw, 300);
    if (text === undefined) {
      return undefined;
    }
    if (text !== null) {
      out[key] = text;
    }
  }
  return Object.keys(out).length === 0 ? null : JSON.stringify(out);
}

export function parsePromotionMethod(value: unknown): PromotionMethod | null {
  return typeof value === "string" && (PROMOTION_METHODS as readonly string[]).includes(value)
    ? (value as PromotionMethod)
    : null;
}

export function parseLang(value: unknown): "en" | "sv" | null {
  return value === "sv" || value === "en" ? value : null;
}

// ── the links (design §2.1, CX-B9) ──────────────────────────────────────────

/**
 * The address an affiliate shares: the shop's storefront on the canonical
 * web origin with `?ref=<code>` — built from CANONICAL_ORIGINS and nothing
 * else (never a request's host; the reminder mail's own shape, shared host +
 * `/<shop>/`). CP14 changes the storefront's address in ONE place: here.
 * Null without a configured web origin.
 */
export function affiliateRefLink(env: Env, tenantId: string, code: string): string | null {
  const web = readCanonicalOrigins(env)?.web;
  if (web === undefined) {
    return null;
  }
  const url = new URL(`/${tenantId}/`, web);
  url.searchParams.set("ref", code);
  return url.href;
}

/** The affiliate portal on the canonical admin origin, with the shop selected. Null without one. */
export function affiliatePortalUrl(env: Env, tenantId: string): string | null {
  const admin = readCanonicalOrigins(env)?.admin;
  if (admin === undefined) {
    return null;
  }
  const url = new URL("/affiliate", admin);
  url.searchParams.set("shopId", tenantId);
  return url.href;
}

// ── the row ─────────────────────────────────────────────────────────────────

export interface AffiliateRow {
  address_line1: string | null;
  address_line2: string | null;
  affiliate_id: string;
  application_id: string | null;
  city: string | null;
  code: string;
  commission_bp: number;
  country: string;
  created_at: string;
  currency: string;
  discount_bp: number;
  name: string;
  phone: string | null;
  postal_code: string | null;
  preferred_lang: "en" | "sv";
  promotion_method: string | null;
  socials_json: string | null;
  status: "active" | "inactive" | "suspended";
  tenant_id: string;
  terms_accepted_at: string | null;
  terms_version: string | null;
  updated_at: string;
  user_id: string;
}

export const AFFILIATE_COLUMNS = `a.affiliate_id, a.tenant_id, a.user_id, a.code, a.status, a.commission_bp,
  a.discount_bp, a.name, a.phone, a.address_line1, a.address_line2, a.postal_code, a.city, a.country,
  a.socials_json, a.promotion_method, a.preferred_lang, a.terms_version, a.terms_accepted_at,
  a.application_id, a.currency, a.created_at, a.updated_at`;

/** The shop's affiliate `affiliateId`, or null (never another shop's). */
export async function readAffiliate(db: D1Database, tenantId: string, affiliateId: string): Promise<AffiliateRow | null> {
  return db
    .prepare(`SELECT ${AFFILIATE_COLUMNS} FROM affiliates AS a WHERE a.tenant_id = ? AND a.affiliate_id = ? LIMIT 1`)
    .bind(tenantId, affiliateId)
    .first<AffiliateRow>();
}

/** A UUID-shaped path segment (affiliate, application and payout ids), or null. */
export function parseIdSegment(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(decoded) ? decoded : null;
}

// ── the shop's edit (design §5.3) ───────────────────────────────────────────

export interface UpdateAffiliateInput {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  code?: string;
  commissionBp?: number;
  country?: string;
  discountBp?: number;
  name?: string;
  phone?: string | null;
  postalCode?: string | null;
  preferredLang?: "en" | "sv";
  promotionMethod?: PromotionMethod | null;
  socialsJson?: string | null;
  status?: "active" | "inactive" | "suspended";
}

const UPDATE_KEYS = [
  "addressLine1",
  "addressLine2",
  "city",
  "code",
  "commissionPercent",
  "country",
  "discountPercent",
  "name",
  "phone",
  "postalCode",
  "preferredLang",
  "promotionMethod",
  "socials",
  "status",
] as const;

/**
 * The PATCH body: any of the keys above, at least one, nothing else. Rates
 * in whole percent (0–100); a code as the vanity rule says; status one of
 * the three (an explicit toggle, not Firebase's cycle).
 */
export function parseUpdateAffiliateInput(
  body: unknown,
  tenantId: string,
): { input: UpdateAffiliateInput } | { refusal: CodeRefusal } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0 || !keys.every((key) => (UPDATE_KEYS as readonly string[]).includes(key))) {
    return null;
  }
  const input: UpdateAffiliateInput = {};
  if ("code" in record) {
    const parsed = parseVanityCode(record.code, tenantId);
    if ("refusal" in parsed) {
      return parsed;
    }
    input.code = parsed.code;
  }
  for (const [key, field] of [
    ["commissionPercent", "commissionBp"],
    ["discountPercent", "discountBp"],
  ] as const) {
    if (key in record) {
      const bp = percentToBp(record[key]);
      if (bp === null) {
        return null;
      }
      input[field] = bp;
    }
  }
  if ("status" in record) {
    const status = record.status;
    if (status !== "active" && status !== "inactive" && status !== "suspended") {
      return null;
    }
    input.status = status;
  }
  if ("name" in record) {
    const name = parseText(record.name, 100);
    if (name === undefined || name === null) {
      return null;
    }
    input.name = name;
  }
  for (const [key, field, max] of [
    ["phone", "phone", 40],
    ["addressLine1", "addressLine1", 200],
    ["addressLine2", "addressLine2", 200],
    ["postalCode", "postalCode", 20],
    ["city", "city", 100],
  ] as const) {
    if (key in record) {
      const text = parseText(record[key], max);
      if (text === undefined) {
        return null;
      }
      input[field] = text;
    }
  }
  if ("country" in record) {
    if (typeof record.country !== "string" || !/^[A-Za-z]{2}$/.test(record.country)) {
      return null;
    }
    input.country = record.country.toUpperCase();
  }
  if ("socials" in record) {
    const socials = parseSocials(record.socials);
    if (socials === undefined) {
      return null;
    }
    input.socialsJson = socials;
  }
  if ("promotionMethod" in record) {
    if (record.promotionMethod === null) {
      input.promotionMethod = null;
    } else {
      const method = parsePromotionMethod(record.promotionMethod);
      if (method === null) {
        return null;
      }
      input.promotionMethod = method;
    }
  }
  if ("preferredLang" in record) {
    const lang = parseLang(record.preferredLang);
    if (lang === null) {
      return null;
    }
    input.preferredLang = lang;
  }
  return { input };
}

const COLUMN_OF: Record<keyof UpdateAffiliateInput, string> = {
  addressLine1: "address_line1",
  addressLine2: "address_line2",
  city: "city",
  code: "code",
  commissionBp: "commission_bp",
  country: "country",
  discountBp: "discount_bp",
  name: "name",
  phone: "phone",
  postalCode: "postal_code",
  preferredLang: "preferred_lang",
  promotionMethod: "promotion_method",
  socialsJson: "socials_json",
  status: "status",
};

export type UpdateAffiliateResult =
  | { status: "code_taken" | "not_addable" | "not_found" }
  | { affiliate: AffiliateRow; status: "ok" };

/**
 * The shop's edit, in ONE batch with its audit row (the fields named, never
 * their values). Rates apply to FUTURE quotes only (frozen at quote time). A
 * code change strands old links (design §5.3, no aliases). Setting `active`
 * also re-activates a REVOKED (never a suspended) `affiliate` membership of this shop while the
 * identity is an active affiliate (so "Ta bort" is undone by "Aktiv"), and is
 * refused (`not_addable`) when the person is no longer an active affiliate
 * identity (suspended by the platform, or converted into a tenant admin,
 * user-lifecycle.ts): no code of theirs is quoted again.
 */
export async function updateAffiliate(
  db: D1Database,
  principal: TenantAdminPrincipal,
  affiliateId: string,
  input: UpdateAffiliateInput,
  now: number,
): Promise<UpdateAffiliateResult> {
  const fields = (Object.keys(input) as Array<keyof UpdateAffiliateInput>).filter((key) => input[key] !== undefined);
  const nowIso = new Date(now).toISOString();
  const sets = fields.map((key) => `${COLUMN_OF[key]} = ?`);
  // Round 1: the edit's own stamp. The audit row and the membership's
  // re-activation follow the UPDATE only when it applied (a refused identity
  // guard writes nothing at all).
  const changeId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE affiliates SET ${[...sets, "change_id = ?", "updated_at = MAX(updated_at, ?)"].join(", ")}
         WHERE affiliate_id = ? AND tenant_id = ?
           AND (? IS NOT 'active' OR EXISTS (
             SELECT 1 FROM identity_access AS ia
             WHERE ia.user_id = affiliates.user_id AND ia.account_type = 'affiliate' AND ia.status = 'active'
           ))`,
      )
      .bind(...fields.map((key) => input[key] ?? null), changeId, nowIso, affiliateId, principal.tenantId, input.status ?? null),
    db
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type,
           resource_id, request_id, metadata_json, created_at
         )
         SELECT ?, tenant_id, ?, 'affiliate.update', 'affiliate', affiliate_id, ?, ?, ?
         FROM affiliates WHERE affiliate_id = ? AND tenant_id = ? AND change_id = ?`,
      )
      .bind(
        crypto.randomUUID(),
        principal.userId,
        crypto.randomUUID(),
        auditMetadataJson(principal, { fields: [...fields].sort() }),
        now,
        affiliateId,
        principal.tenantId,
        changeId,
      ),
  ];
  if (input.status === "active") {
    statements.push(
      db
        .prepare(
          // Round 1: only a membership "Ta bort" revoked comes back; one the
          // platform suspended stays suspended.
          `UPDATE tenant_memberships
           SET status = 'active', updated_at = MAX(updated_at, ?)
           WHERE tenant_id = ? AND role = 'affiliate' AND status = 'revoked'
             AND user_id = (SELECT user_id FROM affiliates WHERE affiliate_id = ? AND tenant_id = ? AND change_id = ?)
             AND EXISTS (
               SELECT 1 FROM identity_access AS ia
               WHERE ia.user_id = tenant_memberships.user_id
                 AND ia.account_type = 'affiliate' AND ia.status = 'active'
             )`,
        )
        .bind(now, principal.tenantId, affiliateId, principal.tenantId, changeId),
    );
  }
  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    if (isCodeTaken(error)) {
      return { status: "code_taken" };
    }
    throw error;
  }
  const affiliate = await readAffiliate(db, principal.tenantId, affiliateId);
  if (affiliate === null) {
    return { status: "not_found" };
  }
  if ((results[0]?.meta.changes ?? 0) === 0) {
    // The row exists: only the identity guard can have refused it.
    return { status: "not_addable" };
  }
  return { affiliate, status: "ok" };
}

// ── the adjustment (design §7.2 "Lägg till justering") ──────────────────────

export interface AdjustmentInput {
  amountMinor: number;
  reason: string;
}

/** `{ amountMinor (≠ 0, |x| ≤ 100 000 000), reason (1–500) }`. */
export function parseAdjustmentInput(body: unknown): AdjustmentInput | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (!Object.keys(record).every((key) => key === "amountMinor" || key === "reason")) {
    return null;
  }
  const amount = record.amountMinor;
  const reason = parseText(record.reason, 500);
  if (
    typeof amount !== "number" ||
    !Number.isSafeInteger(amount) ||
    amount === 0 ||
    Math.abs(amount) > 100_000_000 ||
    reason === undefined ||
    reason === null
  ) {
    return null;
  }
  return { amountMinor: amount, reason };
}

/**
 * An admin's correction: one `adjustment` ledger row (± amount, with its
 * reason, in the affiliate's currency) and its audit row, in one batch. The
 * ledger is append-only: a correction of a correction is another row.
 */
export async function recordAdjustment(
  db: D1Database,
  principal: TenantAdminPrincipal,
  affiliateId: string,
  input: AdjustmentInput,
  now: number,
): Promise<{ entryId: string; status: "ok" } | { status: "not_found" }> {
  const entryId = crypto.randomUUID();
  const nowIso = new Date(now).toISOString();
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO affiliate_ledger (
           entry_id, tenant_id, affiliate_id, kind, amount_minor, currency, order_id, ref,
           formula_version, available_at, reason, created_by, created_at
         )
         SELECT ?, tenant_id, affiliate_id, 'adjustment', ?, currency, NULL, ?, NULL, NULL, ?, ?, ?
         FROM affiliates WHERE affiliate_id = ? AND tenant_id = ?`,
      )
      .bind(entryId, input.amountMinor, entryId, input.reason, principal.userId, nowIso, affiliateId, principal.tenantId),
    db
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type,
           resource_id, request_id, metadata_json, created_at
         )
         SELECT ?, tenant_id, ?, 'affiliate.adjust', 'affiliate', affiliate_id, ?, ?, ?
         FROM affiliate_ledger WHERE entry_id = ?`,
      )
      .bind(
        crypto.randomUUID(),
        principal.userId,
        crypto.randomUUID(),
        auditMetadataJson(principal, { amountMinor: input.amountMinor, entryId }),
        now,
        entryId,
      ),
  ]);
  return (inserted?.meta.changes ?? 0) === 0 ? { status: "not_found" } : { entryId, status: "ok" };
}
