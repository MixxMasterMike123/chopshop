/**
 * Campaign discount codes ("Rabattkoder") on the v2 totals contract.
 *
 * Mirrors production's authority path, functions/src/payment/createPaymentIntent.ts
 * `computeOrderTotalsSek`, which is the only place the discount MATH is trusted
 * there (the validateDiscountCode callable is display-only and never a source of
 * money). Every eligibility predicate and rounding decision below is taken from
 * that function, and each divergence is named at the point it occurs.
 *
 * Everything here is pure integer arithmetic. `resolveDiscount` performs one D1
 * read, and only when the request actually carried a code.
 */

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

export interface ResolvedDiscount {
  /** The normalized code string, echoed so the client can display what applied. */
  code: string;
  /**
   * The resolved row id, or null when nothing eligible matched. Frozen onto the
   * checkout so the PAYMENT checkpoint can increment used_count atomically —
   * see the increment note on `used_count` below.
   */
  discountCodeId: string | null;
  discountMinor: number;
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
 * yields no discount. This is that authoritative check; there is no display-only
 * counterpart on this side yet.
 *
 * The window bounds are INCLUSIVE on both ends, matching production's
 * `now >= startsAt` and `now <= endsAt`.
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
  if (row.max_uses !== null && row.used_count >= row.max_uses) {
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
 * Resolves a buyer-supplied code against a priced basket.
 *
 * AFFILIATE SEAM. Production resolves an AFFILIATE code first and lets it win a
 * collision (functions/src/affiliate/callable/validateDiscountCode.ts step 1,
 * and the `discountSource === null` guard in computeOrderTotalsSek). The
 * affiliate domain is not migrated yet, so this function currently has one
 * branch. When affiliates land, the affiliate lookup goes HERE — above the
 * campaign lookup below, returning early on a hit so a campaign code of the same
 * name is never consulted. The return shape is already the shape an affiliate
 * hit needs (a code string, an amount, and the id of whatever authorized it), so
 * the seam is a new branch rather than a new signature.
 *
 * IT IS NEVER AN ERROR to present a code that does not resolve or is not
 * eligible. Production answers 0 in exactly these cases and the client displays
 * the same 0, with the server's number authoritative. Refusing the request
 * instead would also turn this route into an oracle: a 4xx would confirm which
 * code strings exist on a tenant, and a timing or status difference between
 * "unknown" and "expired" would leak the rest.
 */
export async function resolveDiscount(
  db: D1Database,
  tenantId: string,
  code: string,
  lines: readonly DiscountableLine[],
  subtotalMinor: number,
  now: number,
): Promise<ResolvedDiscount> {
  const none: ResolvedDiscount = {
    code,
    discountCodeId: null,
    discountMinor: 0,
  };

  // --- AFFILIATE BRANCH BELONGS HERE (see the seam note above) ---

  const row = await db
    .prepare(
      `SELECT
         discount_code_id, code, active, type, value_minor, percent_bp,
         starts_at, ends_at, max_uses, used_count, min_spend_minor,
         scope, product_ids_json
       FROM discount_codes
       WHERE tenant_id = ?
         AND code = ?
       LIMIT 1`,
    )
    .bind(tenantId, code)
    .first<DiscountCodeRow>();

  if (row === null || !isEligible(row, subtotalMinor, now)) {
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
    code,
    discountCodeId: row.discount_code_id,
    discountMinor: bounded,
  };
}
