# POD (Print-on-Demand) Add-on

POD is **one add-on among many** — the platform is not POD-exclusive. It is enabled
**per shop** through the existing add-on (wagon) system. A shop owner who enables it
can upload their own print artwork, validate it against print specs, publish a product
through Design Studio with its print connection created automatically, and an external print shop downloads print-ready files + production
metadata per order.

Out of scope (separate builds): customer-facing product customization/upload and
automated printer-API fulfilment + tracking.

## Architecture

| Piece | Where | Notes |
|---|---|---|
| Add-on registration | `src/wagons/pod-wagon/` + `src/config/addons.js` | `pod-wagon` (manifest `enabled:true`); `WAGON_FEATURE_KEY['pod-wagon']='pod'`; per-shop gate `shops/{id}.features.pod` (default-ON; new shops opt in via `ProvisionShopModal`). Route + gated menu auto-wire (App.jsx `wagonRoutes` + `AddonGate`). |
| Print profiles (config) | `settings/podProfiles` + `src/config/podProfiles.js` (cached loader) + `scripts/seed-pod-profiles.cjs` | 4 **provisional** profiles. Thresholds derive from this doc — change size/DPI/formats in config → validation changes, no code. Seeded by an Admin-SDK script (settings write is platform-only). |
| Artwork library | `src/utils/podUpload.js`, `src/utils/podArtwork.js`, `src/wagons/pod-wagon/components/ArtworkLibrary.jsx` + `ArtworkUploadModal.jsx` | Originals stored **byte-for-byte** at `pod-artwork/{shopId}/originals/…` (NEVER through `imageUpload.js` compression). A separate ~800px webp preview is generated for the UI. |
| Validation engine | `src/utils/podValidation.js` (pure fn) | 3-tier PASS/WARN/FAIL + effective DPI. **Advisory** — WARN/FAIL never blocks; the printer decides. |
| SKU→artwork mapping | `src/utils/podMappings.js`, Design Studio, `…/ProductMapping.jsx` | `podMappings/{id}` keyed `(shopId, sku, placementSlot)`. Design Studio creates these automatically on publish; the manual UI is an advanced repair path. **Products are a separate entity.** |
| Print-shop access | `functions/src/print/` callables + `print.*` surface (`src/pages/print/`, `PrintShopRoute`, `PrintShopLayout`) + `PlatformPrinters` | See **Print-shop = callable projection** below. |

## LEGAL FIREWALL (non-negotiable)

A POD product where the **seller** supplied the artwork and the buyer only picks
size/colour is a **standard product** — the buyer keeps the 14-day right of
withdrawal. `isPersonalized` (in `src/utils/withdrawal.js` + Checkout + the server
re-derivation in `createPaymentIntent.ts`) removes withdrawal and is **only** for
customer-supplied input, which this add-on does not do.

Design Studio explicitly writes `isPersonalized: false` on every product it creates.
The buyer never supplies artwork in this flow, so the cart and checkout keep the
ordinary withdrawal-right behavior.

## The order ↔ artwork join (products stay separate)

There is **no** `pod` field on products or order line items. The bridge is the SKU:

```
order.items[].sku  →  podMappings (scoped to the order's shop)  →  podArtwork  →  original file
```

The print-shop callable resolves this at view time. If a seller renames a SKU or
deletes a mapped artwork, the join breaks — so breakage is made **visible** (never a
silent printer-no-file): `ProductMapping.jsx` flags orphaned rows; `getPrintJob`
returns the line with `artwork:{unresolved:true,reason}`; `deleteArtwork` soft-guards
against still-mapped artwork.

Normal sellers never create this bridge manually. Publishing a new or existing
product from Design Studio upserts one mapping per print position, plus any
colour-specific override mappings. Existing products must have a unique SKU;
missing or shared SKUs block Studio publishing so two products cannot resolve to
the same artwork. The manual mapping view remains under **Avancerat** for legacy
products and repair only.

## Print-shop = callable projection (zero direct DB/Storage access)

Firestore/Storage rules are **document-level** — they can't field-scope. The `orders`
rule is `get: true` (unguessable id), which returns the **whole** order doc
(customer email/phone/payment). Granting the `print_shop` role any `orders` read
would expose all of that regardless of what the UI renders. The printer is an
external **sub-processor**; GDPR data-minimisation means it gets ship-to +
production fields only.

So the `print_shop` role has **zero** direct DB/Storage access. Everything flows
through `functions/src/print/`:

- `getPrintQueue` — minimal list (order #, date, shop, line count, ship-to city/country).
- `getPrintJob` — per-resource shop check (`order.shopId ∈ printShopShops`); returns
  ship-to (name + address — **no email/phone**) + per-line product/SKU/variant/qty/
  placement/purpose + a short-lived **signed download URL** for the original.
- `getPrintQueueExport` — production rows for the CSV (`src/utils/podExport.js` builds
  it client-side; never from raw orders).
- `createPrintShopUser` — platform-only; provisions a `users/{uid}` doc with
  `role:'print_shop'` + `printShopShops:[…]`. **No custom claim** is set.

Scope is enforced off the **live user doc** every call (`printGuard`), so deactivating
or re-roling a printer takes effect immediately (no token-TTL window). Signed URLs
(30 min TTL) replace any Storage grant. **No `print_shop` branch exists in
firestore.rules or storage.rules.**

## Provisional specs

`settings/podProfiles.provisional:true` drives a "preliminära trycksparametrar"
banner in the POD admin page and the upload modal. The seeded values are
industry-typical placeholders; the real numbers come from the print shop later.
Because thresholds are config-driven, replacing them is a `seed-pod-profiles.cjs
--commit --force` (or a doc edit), no code change.

## Deploy prerequisites (STOP-and-surface)

- **`print-meteorpr` Hosting site** must be created in the Firebase console before
  `firebase deploy --only hosting:print` works (target is wired in
  `firebase.json` + `.firebaserc`).
- **`roles/iam.serviceAccountTokenCreator`** on the Functions service account is
  needed to sign download URLs; without it the callable falls back to the stored
  Firebase download URL.
- `node scripts/seed-pod-profiles.cjs --commit` (run by the operator) to seed the
  profiles.
- Rules (`firestore.rules` + `storage.rules`) and the `functions/src/print/`
  callables must be deployed for the add-on to function. **Do not deploy without
  explicit go.**

## Isolation tests (follow-up)

The `podArtwork` / `podMappings` rules are live but their cross-shop-deny tests are a
dedicated follow-up pass in `rules-tests/` (audit-now-tests-later). The print path is
covered by the callables' per-resource scope checks; an emulator/integration test for
`getPrintJob` cross-shop deny should be added alongside.
