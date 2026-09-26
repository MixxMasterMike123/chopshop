# Variant Feature Audit — 2026-07-02 (HEAD a0653f9)

Two independent Opus audits (code/data correctness × merchant/customer UX) of the
v2.2 "variant rail" feature. Money paths verified clean; findings below are the
gaps, severity-ordered. ✅ = fixed in c226eeb (deployed 2026-07-02).

## Verified solid (no action)

- **Money/order integrity**: server reprices every line from the parent doc by
  variant SKU, rejects unknown products/variants, ignores client prices.
  Total-parity (client ↔ server: prices, discount rounding, shipping, pickup=0)
  holds for all variant shapes.
- Webhook order creation stores full variant info (productId, variantSku, label,
  server price) for fulfillment.
- Cart lineId separation, quantity merge, per-shop cart isolation.
- All three storefront render paths (v2.2 grouped → v2.1 options → v2.0 flat)
  correctly detected; admin migration preserves SKUs/prices and is guarded
  (duplicate labels, nameless groups, delivery modes).
- Storage + Firestore rules accept the new fields; uploads land in the
  tenant-partitioned path.
- Order displays (confirmation, admin detail, pickup export, cart, modal) all
  show `item.label`.

## HIGH

1. ✅ **Stale cart line hard-blocks checkout.** Carts persist in localStorage; if a
   merchant renames a size (per-size SKUs re-derive as `groupSku-sizeSlug`) or
   deletes a variant, a customer's existing cart line throws server-side
   `Unknown variant` → the whole checkout dead-ends with a generic red error,
   no self-service recovery. Fix: client-side cart reconciliation (drop/flag
   lines whose variantSku no longer resolves, with a toast) before PI creation;
   translate the 400 into an actionable cart-pointing message.
2. ✅ **Listing cards mislead on price.** Cards (PublicStorefront, CollectionPage →
   NordProductCard) always show `b2cPrice||basePrice`; variants with differing
   prices (750g > 500g salmon) surprise the customer on the product page. Fix:
   "från {min variant price} kr" when prices span a range.
3. ✅ **JSON-LD schema ignores variants.** `generateProductSchema` emits base
   price/sku/image only → wrong structured data for multi-price products
   (Merchant listing mismatch risk). Fix: AggregateOffer lowPrice/highPrice.

## MEDIUM

4. ✅ **og:image follows the auto-selected variant**, not a stable canonical image
   (share/crawler image depends on rail order). Fix: compute OG image from the
   base product regardless of selection.
5. ✅ **CSV order export drops the variant name** (`orderExport.js` uses only
   legacy color/size fields, never `item.label`/`variantSku`). Fulfillment
   can't tell Svart/M from Vit/L in the export. Fix: include label + sku.
6. ✅ **Original-variant price vs product price = two sources of truth.** Groups
   saved with empty price snapshot a concrete number; a later product-price
   change drifts from the snapshotted Original row until re-touch. Fix: persist
   inherited prices as null and resolve against the current product price at
   each save.
7. ✅ **No swatch/variant hint on listing cards** ("+3 färger" dots) — colorway
   discovery hidden until click-in.
8. ✅ **Selected variant not in URL** — no deep-link to "the RED one", refresh
   resets, one SEO page per product regardless of colorways. Fix: `?v=sku`
   param + init selection from it.
9. ✅ **No confirm/undo on "Ta bort variant"** — one mis-click discards a fully
   configured colorway.
10. ✅ **Cross-product SKU collisions silently auto-suffix** (merchant types
    LAX-500, gets LAX-500-2 with no warning).
11. ✅(help text) **Weight is product-level** — 750g variant ships priced as the product
    weight. For weight-differentiated goods, per-variant weight or explicit
    help-text steering ("olika vikt/pris → egen variant, frakt räknas på
    produktens vikt") is needed.

## LOW

12. `hasVariants=false` with populated `variants` (hand-edits/imports) renders
    no picker while the server still resolves variants — layers disagree.
13. Duplicate row SKUs in legacy/hand-edited data reprice to first match.
14. Sizes can't be reordered; per-size price intentionally unsupported — help
    text should say "olika pris → egen variant, inte en storlek".
15. Variant images can't be reordered (product gallery can — inconsistent).
16. AddedToCartModal has hardcoded English strings (pre-existing i18n gap).
17. No per-variant availability toggle (stock intentionally untracked, POD).

## Status 2026-07-02 (post-remediation, c226eeb)

Fixed: 1-10, 12, 14 (help text), 15, 16. Not built: 11 per-variant weight
(help text added instead), 13 legacy duplicate-sku detection (normalizes on
re-save), 17 per-variant availability (intentional POD choice).

## Recommended fix order

1 (checkout dead-end) → 2 (från-pris) → 6 (price inheritance) → 3+4 (SEO/OG) →
5 (CSV export) → 9 (delete confirm) → rest opportunistically.
