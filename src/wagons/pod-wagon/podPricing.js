// podPricing — the seller-economics formulas for POD products, in ONE place.
//
// Model (Kent-briefen 2026-08-15, samma konstruktion som Printful/Printify):
// plattformens bas-intäkt (plagg + tryck per designad yta + plattformsmarginal =
// produktens costSek, exkl. moms) dras på varje försäljning, plus transaktions-
// avgiften på slutpriset. Säljarens vinst är det som blir kvar, räknat exkl. moms:
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
// Ex: en tee med ETT stort tryck fram → costSek 150 (plagg 60 + tryck 40 +
// plattformsuttag 50) → golv 210 kr; vid 210 kr får plattformen 150 + avgiften
// och säljaren 0 kr — därför prissätter ingen där frivilligt. Ett HÖGRE golv än
// break-even är ett varumärkes-/optikbeslut (jfr Kents 230 kr) och medvetet INTE
// kodat här — rekommenderat pris + marginalmål är styrmedlen ovanför golvet.
//
// costSek är INTE längre en konstant per mall: den beror på hur många ytor som
// faktiskt trycks (fram+bak kostar ett tryck mer än bara fram). podCostForSlots()
// nedan är den enda platsen som räknar ihop den.
//
// FEE_RATE/FEE_FIXED = BAS-nivåns transaktionsavgift (pricing-beslut 2026-08:
// BAS 0 kr/mån · 8 % + 5 kr). När per-butik-nivåer (PLUS 5 %) får billing-rails
// ska dessa läsas från butikens konfiguration i stället — byt då EN gång här.
export const FEE_RATE = 0.08;
export const FEE_FIXED = 5;

// Flat platform cut per garment (Mikael 2026-08-18) — plattformens del av varje
// tryckt plagg, en post i costSek vid sidan av plagget och trycken. Detta är den
// "plattformsmarginal" modellen ovan alltid beskrivit men som seed-datan aldrig
// innehöll. Kollektions-rälsen (3-vägsdelningen) är en SEPARAT sak; den här
// konstanten driver bara säljarens ekonomi (golv, vinst, marginal).
export const PLATFORM_CUT_SEK = 50;

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

/**
 * The seller's total cost (kr, EXKL. moms) for a product built on `template`
 * that actually prints `slots` — plagget + ett tryckpris per DESIGNAD yta +
 * plattformsuttaget. Fram+bak kostar alltså ett tryck mer än bara fram, vilket
 * är hela poängen med per-yta-prissättningen (beslut 3).
 *
 *   cost = blankCostSek + Σ printCostSek[slot] + PLATFORM_CUT_SEK
 *
 * `slots` får vara tom → plagg + uttag (en produkt utan tryck kostar inget tryck).
 * En yta som saknas i printCostSek räknas som 0 kr hellre än att sänka hela
 * kalkylen till null — en okänd tryckyta ska inte tysta golvet.
 *
 * LEGACY-FALLBACK: äldre cachade mall-dokument bär bara `costSek` (plagg + ETT
 * stort tryck, utan uttaget). De får costSek + PLATFORM_CUT_SEK — uttaget gäller
 * även dem, och per-yta-detaljen finns helt enkelt inte att hämta. Null när
 * varken blankCostSek eller costSek går att lita på.
 */
export const podCostForSlots = (template, slots) => {
  if (!Number.isFinite(template?.blankCostSek)) {
    return Number.isFinite(template?.costSek) ? template.costSek + PLATFORM_CUT_SEK : null;
  }
  const printCost = template.printCostSek || {};
  const prints = (Array.isArray(slots) ? slots : []).reduce(
    (sum, slot) => sum + (Number.isFinite(printCost[slot]) ? printCost[slot] : 0),
    0
  );
  return template.blankCostSek + prints + PLATFORM_CUT_SEK;
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
