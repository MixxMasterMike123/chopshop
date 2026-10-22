/**
 * Campaign discount codes ("Rabattkoder") on the v2 totals contract.
 *
 * Mirrors production's authority path, functions/src/payment/createPaymentIntent.ts
 * `computeOrderTotalsSek`, which is the only place the discount MATH is trusted
 * there (the validateDiscountCode callable is display-only and never a source of
 * money). Every eligibility predicate and rounding decision below is taken from
 * that function, and each divergence is named at the point it occurs.
 *
 * Everything here is pure integer arithmetic. `resolveDiscount` performs at
 * most one D1 read per code the request actually carried (CP13: an affiliate
 * lookup per code while the add-on is on, then the campaign read), and none
 * when it carried no code.
 *
 * CP13 (docs/cf-port/CP13_AFFILIATE_DESIGN.md §2.2): the affiliate branch of
 * the seam below. An affiliate hit freezes the affiliate's id in the same
 * `discountCodeId` with `authority` 'affiliate'; holds and burns run only for
 * the campaign authority (checkout.ts, webhook.ts).
 *
 * CP8-DC (docs/cf-port/CP8_DC_REPORT.md): a use is HELD while a buyer pays
 * (migration 0055) and counted when the payment succeeds; the read below
 * counts other buyers' live holds against the cap, by the same predicate as
 * the hold's capacity trigger. The money rule that keeps a discount from
 * leaving the charge under MIN_CHARGE_MINOR or the platform's fee above what
 * the buyer pays is checkout.ts `discountViable`, beside the fee it reads.
 *
 * This module imports nothing: the email templates and the migration
 * tooling's rule bundle (scripts/cf-port/migrate/lib/worker-rules.mjs, by way
 * of the email modules) reach it, and neither may pull the payment client in.
 */

/**
 * How long a checkout holds a use of a capped code (DC3): an hour from the
 * moment the buyer reached payment, never longer than the checkout itself.
 */
export const DISCOUNT_HOLD_TTL_MS = 60 * 60 * 1_000;

/**
 * The least a discounted checkout may charge (DC6): Stripe's minimum charge
 * for SEK, 3,00 kr. One value for every currency, which is conservative for
 * SEK, NOK, DKK and EUR. A discount that would leave less does not apply.
 */
export const MIN_CHARGE_MINOR = 300;

/**
 * The wire form of a code as the buyer typed it, normalized.
 *
 * Production normalizes with `code.trim().toUpperCase()` on every path — the
 * admin write, the validate callable, and the payment recompute — so a lowercase
 * entry resolves the same row as an uppercase one. Trimming is reproduced
 * because a buyer pasting a code very often brings whitespace with it, and
 * production would have found the row.
 */
export function normalizeDiscountCode(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Production bounds the code at 50 characters in the validate callable
 * (`rawCode.length > 50` is an invalid-argument there) and the admin form
 * imposes no shape beyond non-empty. The bound is reproduced; the shape is not
 * narrowed further, because a merchant who has run "SOMMAR-2026 ✨" in
 * production must still be able to run it here.
 *
 * What IS excluded is whitespace and control bytes anywhere in the normalized
 * value. A code containing a newline is not a code a merchant can communicate,
 * and admitting one would mean the same logical code could be written twice
 * under names that render identically.
 */
export const MAX_DISCOUNT_CODE_LENGTH = 50;
// Written as escapes, never as literal bytes: checkpoint 15 shipped a class
// containing real control characters, which rendered as an empty-looking range
// and was unreviewable. \s covers space/tab/newline; the two ranges are C0 and
// DEL plus C1.
const CODE_FORBIDDEN_PATTERN = /[\s\u0000-\u001f\u007f-\u009f]/;

export function isValidDiscountCode(normalized: string): boolean {
  return (
    normalized.length >= 1 &&
    normalized.length <= MAX_DISCOUNT_CODE_LENGTH &&
    !CODE_FORBIDDEN_PATTERN.test(normalized)
  );
}

export type DiscountType = "fixed" | "percent";
export type DiscountScope = "all" | "products";

export const DISCOUNT_TYPES: readonly DiscountType[] = ["fixed", "percent"];
export const DISCOUNT_SCOPES: readonly DiscountScope[] = ["all", "products"];

/** Matches the value_minor CHECK and the product price ceiling. */
export const MAX_DISCOUNT_VALUE_MINOR = 100_000_000;
/** 10 000 basis points is 100%, the ceiling production's admin form enforces. */
export const MAX_DISCOUNT_PERCENT_BP = 10_000;
/**
 * How many product ids a scoped code may name. Production has no explicit cap —
 * the admin picker lists a shop's active products — so this is a containment
 * bound rather than a mirrored rule: the list is read into memory and matched
 * against at most 50 basket lines on a hot anonymous path.
 */
export const MAX_DISCOUNT_PRODUCT_IDS = 500;
/** Same bound the checkout uses for a product id. */
export const MAX_PRODUCT_ID_LENGTH = 128;

export interface DiscountCodeRow {
  active: number;
  code: string;
  discount_code_id: string;
  ends_at: number | null;
  max_uses: number | null;
  min_spend_minor: number | null;
  percent_bp: number | null;
  product_ids_json: string | null;
  scope: DiscountScope;
  starts_at: number | null;
  type: DiscountType;
  used_count: number;
  value_minor: number | null;
}

/** One priced basket line, as much of it as the discount base needs. */
export interface DiscountableLine {
  lineTotalMinor: number;
  productId: string;
}

/**
 * CP13: which family authorized a frozen discount id (migration 0059
 * `discount_authority`). A campaign id names a `discount_codes` row; an
 * affiliate id names an `affiliates` row. Every reader of the frozen id
 * branches on this, never on the id's shape.
 */
export type DiscountAuthority = "affiliate" | "campaign";

/** How an affiliate code reached the checkout (design §2.2). */
export type AffiliateAttribution = "code" | "link";

/** The affiliate facts a checkout freezes beside its discount (0059). */
export interface ResolvedAffiliate {
  affiliateId: string;
  attribution: AffiliateAttribution;
  /** The code as stored (upper case). */
  code: string;
  commissionBp: number;
  discountBp: number;
}

export interface ResolvedDiscount {
  /** CP13: the affiliate that authorized the discount, or null. */
  affiliate: ResolvedAffiliate | null;
  /** CP13: which family `discountCodeId` belongs to; null when it is null. */
  authority: DiscountAuthority | null;
  /** The normalized code string, echoed so the client can display what applied. */
  code: string;
  /**
   * The resolved row id, or null when nothing eligible matched. Frozen onto the
   * checkout so the PAYMENT checkpoint can increment used_count atomically —
   * see the increment note on `used_count` below. CP13: for an affiliate hit
   * it is the AFFILIATE's id (`authority` says so), and nothing increments.
   */
  discountCodeId: string | null;
  discountMinor: number;
  /**
   * CP13: present (and "link") only when the buyer typed a code and the
   * link's affiliate code was used instead (design §2.2 step 1).
   */
  overriddenBy?: "link";
}

/** The two code strings a request may carry, each normalized or null. */
export interface DiscountCodes {
  /** The `?ref=` code the storefront carried from a landing (design §2.1). */
  ref: string | null;
  /** The code the buyer typed. */
  typed: string | null;
}

/** The shop's two switches, each gating its own branch (design §2.2). */
export interface DiscountGates {
  affiliate: boolean;
  discountCodes: boolean;
}

/** The grammar of an affiliate code (0059 affiliates.code). */
export const AFFILIATE_CODE_PATTERN = /^[A-Z0-9-]{3,20}$/;

export function isAffiliateCode(normalized: string): boolean {
  return AFFILIATE_CODE_PATTERN.test(normalized);
}

/** A resolution that applies nothing, echoing `code`. */
export function noDiscount(code: string): ResolvedDiscount {
  return { affiliate: null, authority: null, code, discountCodeId: null, discountMinor: 0 };
}

/**
 * `ceil(base × bp / 10000)`, exact for every value either column can hold.
 *
 * Production computes `Math.ceil(base * (value / 100))` in floating point, and
 * the client computes the same expression — the rounding is CLIENT-PARITY
 * CRITICAL, so the ceiling is reproduced exactly rather than rounded half-up
 * like VAT. What is NOT reproduced is the float: basis points make a fractional
 * percent exact, and the money path holds no floats by rule.
 *
 * OVERFLOW DISCIPLINE. The naive integer form `(base*bp + 9999) / 10000` cannot
 * be used at this schema's ceilings. The subtotal bound is 50 lines × 999 units
 * × 100 000 000 minor ≈ 5.0e12, and 5.0e12 × 10 000 = 5.0e16, past
 * Number.MAX_SAFE_INTEGER (≈9.007e15) — the product would silently lose
 * precision and quote a discount that is off by a few minor units, which is
 * exactly the class of defect that survives review.
 *
 * The same REMAINDER technique the VAT derivation uses avoids it, and here it
 * needs no range refusal at all. Splitting the base at the divisor,
 *
 *   base = qHi·10000 + rem,  0 ≤ rem < 10000
 *   base·bp = qHi·bp·10000 + rem·bp
 *
 * every intermediate stays bounded: `rem·bp` is at most 9 999 × 10 000 ≈ 1.0e8,
 * and `qHi·bp` is at most `base` itself (because bp ≤ 10000), so nothing here
 * ever exceeds the base — which the caller has already bounded by construction.
 * A hard range guard is kept anyway, as an assertion rather than a policy: if a
 * caller ever hands this a base outside the safe-integer range the arithmetic
 * is meaningless, and throwing is better than returning a plausible number.
 *
 * Differentially tested against the naive form across the range where the naive
 * form is still exact; see test/discount-codes.test.ts.
 */
export function percentDiscountMinor(baseMinor: number, percentBp: number): number {
  if (
    !Number.isSafeInteger(baseMinor) ||
    baseMinor < 0 ||
    !Number.isSafeInteger(percentBp) ||
    percentBp < 0 ||
    percentBp > MAX_DISCOUNT_PERCENT_BP
  ) {
    throw new RangeError("discount base is outside the exact-arithmetic range");
  }

  const divisor = 10_000;
  const highQuotient = Math.trunc(baseMinor / divisor);
  const remainder = baseMinor - highQuotient * divisor;
  const lowProduct = remainder * percentBp;
  const lowQuotient = Math.trunc(lowProduct / divisor);
  const lowRemainder = lowProduct - lowQuotient * divisor;
  const floored = highQuotient * percentBp + lowQuotient;

  // Ceiling: round up exactly when the division was not exact.
  return lowRemainder > 0 ? floored + 1 : floored;
}

/**
 * The stored product-id list, or an empty list when there is none or the blob
 * is malformed.
 *
 * A corrupt list yields NO matching lines, so a products-scoped code with a
 * broken blob discounts nothing. That is the safe direction — the alternative,
 * treating an unreadable scope as 'all', would turn a corrupt row into an
 * unbounded discount.
 */
function parseStoredProductIds(value: string | null): string[] {
  if (value === null) {
    return [];
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    return [];
  }

  return Array.isArray(decoded)
    ? decoded.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * The discountable base for a code, from the ALREADY-RESOLVED lines. No extra
 * product query is issued: the basket has been priced against the tenant's own
 * catalogue by this point, and re-reading it would both cost D1 work on an
 * anonymous path and risk disagreeing with the numbers being stored.
 *
 *   scope 'all'      → the whole subtotal
 *   scope 'products' → the sum of lines whose productId is in the code's list
 *
 * An id in the list that matches no line — a product the merchant has since
 * deleted, or one simply not in this basket — contributes nothing. That is
 * production's behaviour with a loose id array and it is deliberate here: the
 * merchant's scope is a filter, not a promise that every named product exists.
 */
export function discountBaseMinor(
  row: DiscountCodeRow,
  lines: readonly DiscountableLine[],
  subtotalMinor: number,
): number {
  if (row.scope === "all") {
    return subtotalMinor;
  }

  const productIds = new Set(parseStoredProductIds(row.product_ids_json));
  return lines.reduce(
    (total, line) =>
      total + (productIds.has(line.productId) ? line.lineTotalMinor : 0),
    0,
  );
}

/**
 * Every eligibility predicate, checked server-side at quote time.
 *
 * Production checks the same five things in `computeOrderTotalsSek`, and checks
 * them AGAIN there after the validate callable already did — deliberately, so a
 * code that expired, was deactivated, or filled up between display and payment
 * yields no discount. This is that authoritative check; the storefront's
 * preview (discount-preview.ts) is the display-only counterpart and calls it
 * with no holds.
 *
 * The window bounds are INCLUSIVE on both ends, matching production's
 * `now >= startsAt` and `now <= endsAt`.
 *
 * The cap counts the uses already paid AND `heldByOthers`, the distinct other
 * buyers holding a live use (0055): the same sum the capacity trigger refuses
 * at, so a read that says "available" and an insert that says "exhausted"
 * can disagree only when another buyer's batch committed in between.
 *
 * min_spend is compared against the FULL basket subtotal, never the scoped
 * base. Production does this even for a products-scoped code, and the client
 * does the same, so a scoped code with a minimum spend behaves identically on
 * both systems.
 */
export function isEligible(
  row: DiscountCodeRow,
  subtotalMinor: number,
  now: number,
  heldByOthers = 0,
): boolean {
  if (row.active !== 1) {
    return false;
  }
  if (row.starts_at !== null && now < row.starts_at) {
    return false;
  }
  if (row.ends_at !== null && now > row.ends_at) {
    return false;
  }
  if (row.max_uses !== null && row.used_count + heldByOthers >= row.max_uses) {
    return false;
  }
  if (row.min_spend_minor !== null && subtotalMinor < row.min_spend_minor) {
    return false;
  }

  return true;
}

/**
 * The discount a code is worth against a base, in minor units.
 *
 *   fixed   → min(value, base), so a code worth more than the basket cannot
 *             discount more than the basket. Production clamps identically.
 *   percent → ceil(base × bp / 10000), the exact integer form of production's
 *             `Math.ceil(base * value / 100)`.
 */
export function discountAmountMinor(
  row: DiscountCodeRow,
  baseMinor: number,
): number {
  if (row.type === "fixed") {
    return Math.min(row.value_minor ?? 0, baseMinor);
  }

  return percentDiscountMinor(baseMinor, row.percent_bp ?? 0);
}

/**
 * Resolves the codes a request carries against a priced basket (CP13: design
 * §2.2, the seam this function's header promised).
 *
 * THE ORDER, each branch under its own switch (`gates`):
 *   1. `ref` (the link's code) names an ACTIVE affiliate of this shop → that
 *      affiliate wins, attribution 'link'. A typed code is set aside, and the
 *      answer says so (`overriddenBy: 'link'`).
 *   2. `typed` names an active affiliate → it wins, attribution 'code'
 *      (D24: a typed affiliate code earns).
 *   3. `typed` names an eligible campaign code → the campaign, as before
 *      (resolveCampaignDiscount). Never `ref`: a `?ref=<campaign>` link
 *      applies nothing (R2-24).
 *   4. nothing applies.
 * Production resolves an AFFILIATE code first and lets it win a collision
 * (functions/src/affiliate/callable/validateDiscountCode.ts step 1); D30's
 * collision triggers (0059) keep the two families from sharing a string, and
 * this order is the defensive precedence if they ever did.
 *
 * AN AFFILIATE HIT: `discountMinor = ceil(subtotal × discount_bp / 10 000)`
 * (percentDiscountMinor, the whole subtotal, never carriage; no cap, window or
 * minimum spend), `discountCodeId` = the affiliate's id and `authority`
 * 'affiliate' — the seam's "id of whatever authorized it", which satisfies
 * 0010/0011's "discounted money was authorized by something". It is a hit
 * even when the discount is 0 (`discount_bp` 0, a commission-only affiliate,
 * R2-8): attribution never depends on the amount.
 *
 * IT IS NEVER AN ERROR to present a code that does not resolve, for either
 * family (see resolveCampaignDiscount). An inactive or suspended affiliate,
 * another shop's, or the add-on off falls through to the campaign branch, on
 * the preview and the checkout alike: one function serves both.
 */
export async function resolveDiscount(
  db: D1Database,
  tenantId: string,
  codes: DiscountCodes,
  lines: readonly DiscountableLine[],
  subtotalMinor: number,
  now: number,
  holds: { buyerKey: string } | null,
  gates: DiscountGates,
): Promise<ResolvedDiscount> {
  if (gates.affiliate) {
    for (const [code, attribution] of [
      [codes.ref, "link"],
      [codes.typed, "code"],
    ] as const) {
      if (code === null || !isAffiliateCode(code)) {
        continue;
      }
      const affiliate = await findActiveAffiliate(db, tenantId, code);
      if (affiliate === null) {
        continue;
      }
      const resolved: ResolvedDiscount = {
        affiliate: {
          affiliateId: affiliate.affiliate_id,
          attribution,
          code: affiliate.code,
          commissionBp: affiliate.commission_bp,
          discountBp: affiliate.discount_bp,
        },
        authority: "affiliate",
        code: affiliate.code,
        discountCodeId: affiliate.affiliate_id,
        discountMinor: Math.min(percentDiscountMinor(subtotalMinor, affiliate.discount_bp), subtotalMinor),
      };
      return attribution === "link" && codes.typed !== null && codes.typed !== affiliate.code
        ? { ...resolved, overriddenBy: "link" }
        : resolved;
    }
  }

  if (gates.discountCodes && codes.typed !== null) {
    return resolveCampaignDiscount(db, tenantId, codes.typed, lines, subtotalMinor, now, holds);
  }

  return noDiscount(codes.typed ?? codes.ref ?? "");
}

interface AffiliateCodeRow {
  affiliate_id: string;
  code: string;
  commission_bp: number;
  discount_bp: number;
}

/** (tenant, code) exact, ACTIVE only: the one read of an affiliate code. */
async function findActiveAffiliate(
  db: D1Database,
  tenantId: string,
  code: string,
): Promise<AffiliateCodeRow | null> {
  return db
    .prepare(
      `SELECT affiliate_id, code, commission_bp, discount_bp
       FROM affiliates
       WHERE tenant_id = ? AND code = ? AND status = 'active'
       LIMIT 1`,
    )
    .bind(tenantId, code)
    .first<AffiliateCodeRow>();
}

/**
 * CP13 (design §4.3): is this checkout a self-referral? The buyer's address
 * (as the checkout parser lowercased it) is the affiliate's own login
 * address, or the address of an ACTIVE admin of the shop. Decided at quote
 * time and frozen (`affiliate_self_referral`): a profile change between quote
 * and payment cannot change the award. A cheap guard, not a proof: two
 * addresses of one person cannot be told apart; the terms forbid
 * self-purchase and the shop can correct by adjustment.
 */
export async function isAffiliateSelfReferral(
  db: D1Database,
  tenantId: string,
  affiliateId: string,
  buyerEmail: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM affiliates AS a
       INNER JOIN "user" AS u ON u."id" = a.user_id
       WHERE a.affiliate_id = ?1 AND a.tenant_id = ?2 AND lower(u."email") = ?3
       UNION ALL
       SELECT 1 AS hit FROM tenant_memberships AS m
       INNER JOIN identity_access AS ia ON ia.user_id = m.user_id
       INNER JOIN "user" AS u ON u."id" = m.user_id
       WHERE m.tenant_id = ?2 AND m.role = 'admin' AND m.status = 'active'
         AND ia.account_type = 'tenant_admin' AND ia.status = 'active'
         AND lower(u."email") = ?3
       LIMIT 1`,
    )
    .bind(affiliateId, tenantId, buyerEmail)
    .first<{ hit: number }>();
  return row !== null;
}

/**
 * Resolves a buyer-typed CAMPAIGN code against a priced basket (the CP8-DC
 * branch, step 3 of resolveDiscount).
 *
 * IT IS NEVER AN ERROR to present a code that does not resolve or is not
 * eligible. Production answers 0 in exactly these cases and the client displays
 * the same 0, with the server's number authoritative. Refusing the request
 * instead would also turn this route into an oracle: a 4xx would confirm which
 * code strings exist on a tenant, and a timing or status difference between
 * "unknown" and "expired" would leak the rest.
 *
 * `holds`: the checkout passes its buyer's key (sha256 of tenant and email),
 * and the cap then counts every OTHER buyer's live hold, each buyer once, in
 * the same single read (a subquery). The buyer's own holds never count
 * against them, so a reloaded payment page or a ticked box (a new checkout)
 * still gets the code. The preview passes null: it counts paid uses only.
 */
export async function resolveCampaignDiscount(
  db: D1Database,
  tenantId: string,
  code: string,
  lines: readonly DiscountableLine[],
  subtotalMinor: number,
  now: number,
  holds: { buyerKey: string } | null,
): Promise<ResolvedDiscount> {
  const none = noDiscount(code);

  // The hold count is the capacity trigger's predicate (0055), word for word.
  const heldByOthers =
    holds === null
      ? "0"
      : `(SELECT COUNT(DISTINCT h.buyer_key)
          FROM discount_code_holds AS h
          WHERE h.discount_code_id = d.discount_code_id
            AND h.state = 'held'
            AND h.expires_at > ?3
            AND h.buyer_key <> ?4)`;
  const statement = db.prepare(
    `SELECT
       d.discount_code_id, d.code, d.active, d.type, d.value_minor,
       d.percent_bp, d.starts_at, d.ends_at, d.max_uses, d.used_count,
       d.min_spend_minor, d.scope, d.product_ids_json,
       ${heldByOthers} AS held_by_others
     FROM discount_codes AS d
     WHERE d.tenant_id = ?1
       AND d.code = ?2
     LIMIT 1`,
  );
  const row = await (holds === null
    ? statement.bind(tenantId, code)
    : statement.bind(tenantId, code, now, holds.buyerKey)
  ).first<DiscountCodeRow & { held_by_others: number }>();

  if (row === null || !isEligible(row, subtotalMinor, now, row.held_by_others)) {
    return none;
  }

  const base = discountBaseMinor(row, lines, subtotalMinor);
  const amount = discountAmountMinor(row, base);

  // The base is a subset of the subtotal by construction and both branches
  // clamp to it, so this cannot bind for any row the parsers admit. It is kept
  // because the schema states the same bound: if the two ever disagreed, the
  // failure should be a zero discount rather than a rejected INSERT on a route
  // a buyer is waiting on.
  const bounded = Math.min(amount, subtotalMinor);
  if (bounded <= 0) {
    // A code that is worth nothing against this basket — a products-scoped code
    // matching no line, or a 0-value one — resolves to no code at all. Storing
    // an id beside a zero discount would tell the payment checkpoint to burn a
    // use on a code that discounted nothing.
    return none;
  }

  return {
    affiliate: null,
    authority: "campaign",
    code,
    discountCodeId: row.discount_code_id,
    discountMinor: bounded,
  };
}

/**
 * The capacity trigger's refusal (0055 discount_code_holds_capacity): another
 * buyer's batch took the last use between this checkout's read and its write.
 */
export function isDiscountExhausted(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("discount code exhausted");
}
