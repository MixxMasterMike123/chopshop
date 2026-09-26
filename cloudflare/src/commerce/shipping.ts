/**
 * Shipping and VAT arithmetic for the checkout quote.
 *
 * Every function here is pure and integer-only. No value in this file is ever a
 * float: `Math.ceil` is applied to an integer ratio and the VAT derivation uses
 * an integer round-half-up, so a quote is bit-reproducible from its inputs and
 * an auditor can re-derive any stored total by hand.
 *
 * The behaviour mirrors production (functions/src/payment/createPaymentIntent.ts,
 * `getShippingRegion` and `computeOrderTotalsSek`) deliberately and in detail,
 * including constants that read like implementation accidents — the 10 g
 * substitute weight and the 20 g packaging allowance, both documented at their
 * definitions below. They are reproduced rather than tidied away because during
 * the migration window both systems must quote the same carriage for the same
 * basket: a tidier rule here is a silent price change relative to production,
 * and in the direction that matters it is a systematic undersell.
 */

export type DeliveryMethod = "pickup" | "shipping";

export const DELIVERY_METHODS: readonly DeliveryMethod[] = [
  "pickup",
  "shipping",
];

/**
 * The four carriage regions, mirroring production's `getShippingRegion`. These
 * strings are also the accepted key set of a product's shipping table, so the
 * admin parser and the pricing read agree on the vocabulary by construction.
 */
export const SHIPPING_REGIONS = [
  "eu",
  "nordic",
  "sweden",
  "worldwide",
] as const;

export type ShippingRegion = (typeof SHIPPING_REGIONS)[number];

// Verbatim from production's getShippingRegion. Note that DK and FI appear in
// production's EU list too, but the nordic branch is tested first and wins;
// listing them here in NORDIC_COUNTRIES only preserves that same outcome
// without depending on branch order.
const NORDIC_COUNTRIES = new Set(["DK", "FI", "NO"]);
const EU_COUNTRIES = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR",
  "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO",
  "SE", "SI", "SK",
]);

/**
 * Fallback tariff when the product carries no usable rate for the region.
 * Production expresses these in whole SEK (29 / 49); minor units are the unit
 * of account here, so they are stated as 2900 / 4900.
 */
export const FALLBACK_SHIPPING_MINOR_SE = 2_900;
export const FALLBACK_SHIPPING_MINOR_OTHER = 4_900;

/** Production's weight tier: one unit of carriage per started 50 grams. */
export const WEIGHT_TIER_GRAMS = 50;

/**
 * Substitute weight for a line whose product carries none, mirroring
 * production's `(product.weight?.value || 10) * quantity`.
 *
 * `||` is a FALSY test, not a nullish one, so in production an explicitly
 * configured weight of 0 takes this substitute exactly as a missing weight
 * does. That is reproduced here rather than corrected: `weight_grams` defaults
 * to 0 in the schema, so treating 0 as "unset" is what makes an unconfigured
 * product price the same on both systems during the migration window.
 *
 * The consequence worth stating plainly: a merchant cannot express "this weighs
 * nothing". The lightest a line can be is 10 g per unit.
 */
export const DEFAULT_LINE_WEIGHT_GRAMS = 10;

/**
 * Packaging allowance added ONCE to the summed basket weight, mirroring
 * production's `+ 20` in `computeOrderTotalsSek`.
 *
 * This is not a rounding detail — it moves the tier boundary for EVERY basket,
 * not just light ones. A basket of 40 g is `ceil(60/50) = 2` tiers with it and
 * `ceil(40/50) = 1` without, so omitting it undersells carriage on ordinary
 * orders. It also guarantees the multiplier is never 0: the minimum basket
 * weight is 10 + 20 = 30 g, which is one started tier, so a basket is never
 * shipped free.
 */
export const PACKAGING_GRAMS = 20;

/**
 * A per-region cost must stay inside the same bounded space as every other
 * money column: 10_000_000 minor units (100 000 SEK) is far above any real
 * carriage and keeps `cost × tiers` well inside the safe-integer range.
 */
export const MAX_SHIPPING_COST_MINOR = 10_000_000;

/** Grams. Matches the products.weight_grams CHECK. */
export const MAX_WEIGHT_GRAMS = 1_000_000;

/**
 * The internal form: region → cost in minor units. Deliberately flatter than
 * the wire form (`{region: {cost}}`), because the nesting exists only to match
 * production's document shape and carries no second field. Everything past the
 * parse boundary works with this, and `toShippingRatesWire` puts the nesting
 * back exactly once, on the way out.
 */
export type ShippingRates = Partial<Record<ShippingRegion, number>>;

/** The admin-facing form, matching production's `shipping` document. */
export type ShippingRatesWire = Partial<
  Record<ShippingRegion, { cost: number }>
>;

/**
 * Re-nests the internal form for an admin response, so a table that is read
 * back is byte-identical to the table that was written. Without this the write
 * and read shapes would differ, and a client that round-tripped its own product
 * would find its carriage table silently reshaped into something the parser
 * would then refuse.
 */
export function toShippingRatesWire(
  rates: ShippingRates,
): ShippingRatesWire {
  const wire: ShippingRatesWire = {};
  for (const region of SHIPPING_REGIONS) {
    const cost = rates[region];
    if (cost !== undefined) {
      wire[region] = { cost };
    }
  }
  return wire;
}

export interface ShippingLine {
  quantity: number;
  weightGrams: number;
}

function isShippingRegion(value: string): value is ShippingRegion {
  return (SHIPPING_REGIONS as readonly string[]).includes(value);
}

/**
 * Country → region, mirroring production exactly. The input is expected to be
 * already-normalized uppercase alpha-2; anything unrecognized is 'worldwide',
 * which is production's behaviour and the safe direction to fail (the most
 * expensive tariff, never the cheapest).
 */
export function getShippingRegion(country: string): ShippingRegion {
  if (country === "SE") {
    return "sweden";
  }
  if (NORDIC_COUNTRIES.has(country)) {
    return "nordic";
  }
  return EU_COUNTRIES.has(country) ? "eu" : "worldwide";
}

/**
 * Reads a product's stored shipping table.
 *
 * The column is free-form TEXT, so this is the only place its shape is trusted,
 * and it trusts nothing: a blob that is not an object, carries an unknown
 * region key, or holds a non-integer/out-of-range cost is rejected WHOLE rather
 * than partially honoured. A half-read table would price carriage from a
 * corrupt row while looking like it worked.
 *
 * Failure is silent and returns null — the caller then falls back to the
 * default tariff. Nothing is logged: the only thing there is to say is that
 * some tenant's product row is malformed, and the blob itself is merchant data.
 */
export function parseShippingRates(value: unknown): ShippingRates | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    return null;
  }

  return normalizeShippingRates(decoded);
}

/**
 * The shape gate shared by the stored-blob reader above and the admin write
 * parser, so a table that can be written is exactly a table that can be read.
 * Accepts `{region: {cost: integer}}` and nothing else.
 */
export function normalizeShippingRates(value: unknown): ShippingRates | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }

  const rates: ShippingRates = {};
  for (const [region, entry] of Object.entries(value)) {
    if (!isShippingRegion(region)) {
      return null;
    }
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry)
    ) {
      return null;
    }

    const keys = Object.keys(entry);
    if (keys.length !== 1 || keys[0] !== "cost") {
      return null;
    }

    const cost = (entry as { cost: unknown }).cost;
    if (
      typeof cost !== "number" ||
      !Number.isSafeInteger(cost) ||
      cost < 0 ||
      cost > MAX_SHIPPING_COST_MINOR
    ) {
      return null;
    }

    rates[region] = cost;
  }

  return rates;
}

/**
 * Carriage for a shipped basket, in minor units, VAT-inclusive.
 *
 * Mirrors production's `computeOrderTotalsSek` shipping branch
 * (functions/src/payment/createPaymentIntent.ts) term for term:
 *
 *   base   = firstLine.product.shipping[region].cost, else 29/49 SEK fallback
 *   weight = Σ ((lineWeight || 10) × quantity) + 20
 *   cost   = base × ceil(weight / 50)
 *
 * Three production behaviours are reproduced deliberately. Each is a
 * PARITY REQUIREMENT, not an inherited quirk to be corrected here: during the
 * migration window both systems must quote the same carriage for the same
 * basket, and any "improvement" made on one side is a silent price change on
 * the other.
 *
 *  1. The base rate comes from the FIRST line's product only. A mixed basket is
 *     charged the first product's tariff for the whole parcel, which is what
 *     the storefront cart displays today.
 *  2. A line weight of 0 counts as DEFAULT_LINE_WEIGHT_GRAMS (10 g per unit).
 *     Production's `|| 10` is a falsy test, so an explicit zero and a missing
 *     weight are the same thing there, and must be here.
 *  3. PACKAGING_GRAMS (20 g) is added ONCE to the summed basket weight, before
 *     tiering. This shifts the tier boundary for every basket, not only light
 *     ones — a 40 g basket is two tiers, not one — so omitting it would
 *     systematically undersell carriage on ordinary orders.
 *
 * Together (2) and (3) put the floor at 30 g, which is one started tier: unlike
 * an earlier version of this function, a basket is never shipped free.
 */
export function shippingMinor(
  region: ShippingRegion,
  firstLineRates: ShippingRates | null,
  lines: readonly ShippingLine[],
): number {
  const configured = firstLineRates?.[region] ?? 0;
  const baseCost =
    configured > 0
      ? configured
      : region === "sweden"
        ? FALLBACK_SHIPPING_MINOR_SE
        : FALLBACK_SHIPPING_MINOR_OTHER;

  const totalWeight =
    lines.reduce(
      (sum, line) =>
        sum +
        (line.weightGrams === 0
          ? DEFAULT_LINE_WEIGHT_GRAMS
          : line.weightGrams) *
          line.quantity,
      0,
    ) + PACKAGING_GRAMS;

  // Integer ceiling division. Math.ceil on a float ratio would be correct for
  // these magnitudes, but the money path holds no floats by rule.
  const tiers = Math.trunc(
    (totalWeight + WEIGHT_TIER_GRAMS - 1) / WEIGHT_TIER_GRAMS,
  );

  // Carriage is capped. Multiplied out at the column ceilings this product
  // reaches ~1e16 (10 000 000 per tier × 50 lines × 999 units × 1 000 000 g),
  // which is past the safe-integer range and far past any parcel anyone posts.
  // The cap is not a business rule — no real basket approaches it — it is what
  // keeps the arithmetic exact when a merchant misconfigures a weight by six
  // orders of magnitude. 100 000 SEK of carriage is absurd and still quotable;
  // beyond that the quote would be a rounding artefact, so it stops there.
  //
  // The +20 g packaging allowance does not affect this reasoning: it can add at
  // most one tier to a count already bounded above, so the pre-cap product
  // stays the same order of magnitude and the cap still binds well before the
  // safe-integer limit.
  return Math.min(baseCost * tiers, MAX_SHIPPING_MINOR);
}

/**
 * The most carriage a single basket can be quoted, in minor units. Chosen so
 * subtotal + shipping stays inside `MAX_VAT_SAFE_TOTAL_MINOR` for every basket
 * whose subtotal is itself sane, and so the number is recognisably absurd if it
 * ever appears in a quote.
 */
export const MAX_SHIPPING_MINOR = 10_000_000;

/**
 * The VAT contained in a VAT-inclusive total, in minor units.
 *
 *   vat = total − total / (1 + rate)
 *
 * with the rate in basis points and the division rounded half-up. Written
 * directly this is
 *
 *   net = round(total × 10000 / (10000 + bp)) = (2·total·10000 + d) / (2·d)
 *
 * with d = 10000 + bp — but `2 × total × 10000` is a 20000-fold blow-up, and at
 * this schema's ceilings the product leaves the safe-integer range long before
 * the total itself does. A silently-imprecise VAT is exactly the kind of defect
 * that survives review, so the same value is computed from the REMAINDER
 * instead, where no intermediate is ever larger than about d × total:
 *
 *   q = ⌊total·10000 / d⌋, r = total·10000 − q·d
 *   net = q + (2r ≥ d ? 1 : 0)                     -- the same half-up decision
 *
 * `total × 10000` is still the largest term, so the safe bound is
 * total ≤ 2^53/10000 ≈ 9.0e11 rather than ≈ 4.5e11. The subtotal ceiling alone
 * (50 lines × 999 × 100 000 000 ≈ 5.0e12) exceeds even that, which is why
 * `shippingMinor` caps carriage and why the assertion below is a hard failure
 * rather than a clamp: a total that large is a corrupt catalogue, not a sale,
 * and quoting an imprecise number for it would be worse than refusing.
 *
 * ROUNDING: half-up on the NET, so VAT absorbs the remainder. The alternative —
 * rounding the VAT itself — would let a half-unit land outside the total. This
 * way `net + vat = total` exactly for every input, which is the property an
 * invoice line needs, and 0 ≤ vat ≤ total holds unconditionally, so the
 * schema's containment CHECK can never be tripped by the derivation.
 *
 * At bp = 0 the divisor is 10000, net = total, and VAT is 0 — a zero-rated
 * tenant gets a zero VAT line rather than a special case.
 */
export const MAX_VAT_SAFE_TOTAL_MINOR = Math.floor(
  Number.MAX_SAFE_INTEGER / 10_000,
);

export function vatMinor(totalMinor: number, vatRateBp: number): number {
  if (
    !Number.isSafeInteger(totalMinor) ||
    totalMinor < 0 ||
    totalMinor > MAX_VAT_SAFE_TOTAL_MINOR
  ) {
    throw new RangeError("total is outside the range VAT can be derived for");
  }

  const divisor = 10_000 + vatRateBp;
  const scaled = totalMinor * 10_000;
  const quotient = Math.trunc(scaled / divisor);
  const remainder = scaled - quotient * divisor;
  // Half-up: the remainder rounds the net up exactly when it is at least half
  // the divisor. Comparing 2·remainder to the divisor keeps that decision in
  // integers, and 2·remainder < 2·divisor is tiny by construction.
  const net = quotient + (2 * remainder >= divisor ? 1 : 0);

  return totalMinor - net;
}
