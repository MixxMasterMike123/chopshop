// podPricing — the seller-economics formulas for POD products, in ONE place.
//
// Model (Kent-briefen 2026-08-15, samma konstruktion som Printful/Printify):
// plattformens bas-intäkt (plagg + tryck + plattformsmarginal = mallens costSek,
// exkl. moms) dras på varje försäljning, plus transaktionsavgiften på slutpriset.
// Säljarens vinst är det som blir kvar, räknat exkl. moms:
//
//   vinst(p) = (p − avgift(p)) / (1 + moms) − costSek
//   avgift(p) = FEE_RATE · p + FEE_FIXED          (på priset INKL. moms)
//
// PRISGOLVET är break-even-punkten där säljaren tjänar exakt 0 kr — plattformens
// intäkt är redan inbakad UNDER golvet, så plattformen tjänar pengar vid varje
// tillåtet pris. Golvet styr bara hur lite SÄLJAREN får tjäna:
//
//   golv = (costSek · (1 + moms) + FEE_FIXED) / (1 − FEE_RATE), avrundat uppåt.
//
// Ex: costSek 140 (tee 60 + tryck 40 + marginal 40) → golv 196 kr; vid 196 kr får
// plattformen 140 + avgiften och säljaren 0 kr — därför prissätter ingen där
// frivilligt. Ett HÖGRE golv än break-even är ett varumärkes-/optikbeslut (jfr
// Kents 230 kr) och medvetet INTE kodat här — rekommenderat pris + marginalmål är
// styrmedlen ovanför golvet.
//
// FEE_RATE/FEE_FIXED = BAS-nivåns transaktionsavgift (pricing-beslut 2026-08:
// BAS 0 kr/mån · 8 % + 5 kr). När per-butik-nivåer (PLUS 5 %) får billing-rails
// ska dessa läsas från butikens konfiguration i stället — byt då EN gång här.
export const FEE_RATE = 0.08;
export const FEE_FIXED = 5;

/** Transaction fee (kr) on a final price INKL. moms. */
export const transactionFee = (priceInkl) =>
  priceInkl > 0 ? FEE_RATE * priceInkl + FEE_FIXED : 0;

/** Seller profit (kr, EXKL. moms) at a price INKL. moms. Null when unknowable. */
export const sellerProfitExVat = (priceInkl, costSek, vatRate = 0.25) => {
  if (!Number.isFinite(costSek) || !(priceInkl > 0)) return null;
  return (priceInkl - transactionFee(priceInkl)) / (1 + vatRate) - costSek;
};

/** Seller margin (0..1) = profit / price exkl. moms. Null when unknowable. */
export const sellerMargin = (priceInkl, costSek, vatRate = 0.25) => {
  const profit = sellerProfitExVat(priceInkl, costSek, vatRate);
  const exVat = priceInkl > 0 ? priceInkl / (1 + vatRate) : 0;
  if (profit == null || !(exVat > 0)) return null;
  return profit / exVat;
};

/** Break-even price floor (kr INKL. moms, rounded UP) — seller profit 0 here. */
export const priceFloor = (costSek, vatRate = 0.25) => {
  if (!Number.isFinite(costSek) || costSek < 0) return null;
  return Math.ceil((costSek * (1 + vatRate) + FEE_FIXED) / (1 - FEE_RATE));
};

/**
 * The price INKL. moms where sellerMargin() lands exactly on `marginFrac` (0..1)
 * — the inverse of the margin formula above, so "jag vill ha 40 %" and the
 * marginal-kolumnen tell the same story instead of two different ones.
 *
 * Derivation (m = marginFrac, r = FEE_RATE, F = FEE_FIXED, c = costSek):
 *   vinst(p) = (p − r·p − F) / (1 + moms) − c
 *   marginal = vinst(p) / (p / (1 + moms)) = (p(1 − r) − F − c(1 + moms)) / p
 *   m·p = p(1 − r) − F − c(1 + moms)
 *   ⇒  p = (c · (1 + moms) + F) / (1 − r − m)
 *
 * Note the denominator: the margin can never reach 1 − FEE_RATE (the fee eats a
 * fixed share of every krona), and p → ∞ as m approaches it. We refuse just
 * short of that asymptote rather than returning an absurd price. NO rounding
 * here — …9-priser är presentation, se roundUpTo9.
 *
 * Returns null when the inputs are unusable or the margin is unreachable.
 */
export const priceForMargin = (costSek, marginFrac, vatRate = 0.25) => {
  if (!Number.isFinite(costSek) || costSek < 0) return null;
  if (!Number.isFinite(marginFrac) || marginFrac < 0) return null;
  if (marginFrac >= 1 - FEE_RATE - 0.005) return null; // asymptote guard
  return (costSek * (1 + vatRate) + FEE_FIXED) / (1 - FEE_RATE - marginFrac);
};

// Round a price UP to the nearest number ending in 9 (…9): 260.75 → 269, 269 → 269.
// Presentation policy, not economics — kept here so the studio and the product
// form round the same way from the same source.
export const roundUpTo9 = (value) => {
  const n = Math.ceil(value);
  const rem = ((n - 9) % 10 + 10) % 10; // distance above the previous …9
  return n + ((10 - rem) % 10);
};
