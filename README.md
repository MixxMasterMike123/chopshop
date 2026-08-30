# Chop Shop

Chop Shop is a multi-tenant storefront platform for small Swedish sellers, with print-on-demand
merch as its primary business. One codebase, many shops: each shop gets its own identity,
config, pages and products; sellers design merch in a built-in Design Studio, publish it to
their shop, and the platform routes every sold garment to a print shop and takes its cut.

It grew out of the B8shield reseller portal, which is why the Firebase project, the
Firestore database (`b8s-reseller-db`) and the npm package are still named `b8shield`.
Those identifiers cannot be renamed; nothing else about the product is B8shield any more.

## What it does

- **Storefronts** — per-shop B2C shop (catalog, variants, cart, Stripe checkout, pickup /
  click & collect, CMS pages, legal footer, cookie consent). Design system in
  [DESIGN.md](DESIGN.md) ("NORD": bento modules, seasonal-commerce states).
- **POD / merch (the `pod-wagon`)** — artwork library, Design Studio with multi-placement
  print areas, colorways, Pixi-based compositor and 3D mockups, publish flow with a price
  floor. Seller economics live in one place:
  [src/wagons/pod-wagon/podPricing.js](src/wagons/pod-wagon/podPricing.js).
- **Print routing** — the platform decides which print shop produces each garment type and
  what it costs, from that printer's tier. Client logic in
  [src/wagons/pod-wagon/printRouting.js](src/wagons/pod-wagon/printRouting.js), server twin
  in [functions/src/print/printRouting.ts](functions/src/print/printRouting.ts), kept in
  step by `rules-tests/print-routing-parity.test.cjs`. Printer cost and uid are frozen per
  production line at payment; each print shop sees only its own lines.
- **Print shop portal** — queue, order detail and artwork views for the printers
  ([src/pages/print/](src/pages/print/)).
- **Platform admin** — shops, users, printers, models, add-ons, leads, DAC7 reporting
  ([src/pages/platform/](src/pages/platform/)).
- **Shop admin** — products, orders, pages, settings, labels ([src/pages/admin/](src/pages/admin/)).
- **Backend (Cloud Functions, TypeScript)** — payment and order processing, print outbox and
  status, POD artwork processing, email orchestrator, affiliates, product reviews, DAC7,
  withdrawal-right handling, checkout recovery ([functions/src/](functions/src/)).

[CAPABILITY_INVENTORY.md](CAPABILITY_INVENTORY.md) is the honest map of what EXISTS /
PARTIAL / MISSING per area — read it before assuming a feature is done.

## Architecture: train + wagons

The core app is the train; optional feature areas are **wagons** under
[src/wagons/](src/wagons/) (`pod-wagon`, `dining-wagon`, `campaign-wagon`, `ambassador-wagon`,
`writers-wagon`). A wagon is self-contained and registers itself through `WagonRegistry.js`;
removing one is deleting its directory. See
[src/wagons/WAGON_ARCHITECTURE.md](src/wagons/WAGON_ARCHITECTURE.md).

Money terms in the POD path (`podCostSek`, printer tiers, snapshot line cost) are stored
**ex moms**; inkl-moms is a display concern on seller-facing surfaces only.

## Stack

React 18 · Vite · Tailwind · React Router · Firebase (Auth, Firestore, Storage, Cloud
Functions on Node 22, Hosting) · Stripe (Connect) · Pixi.js for the studio compositor.

## Layout

```
src/            React app (pages/shop, pages/admin, pages/platform, pages/print, wagons/)
functions/src/  Cloud Functions (TypeScript); functions/lib is compiled output
rules-tests/    Firestore rules + isolation + routing-parity tests (npm run test:isolation)
docs/           design explorations, specs, decisions
scripts/        one-off maintenance scripts
OBSOLETE/       kept for reference only — not part of the product
*-harness.html  standalone browser harnesses for studio/mockup/colorway work
```

## Running it

```
npm install
cp .env.example .env      # Firebase + Stripe keys; never commit .env
npm run dev               # http://localhost:5173
npm run test:isolation    # Firestore rules, tenant isolation, print-routing parity
```

Functions: `cd functions && npm install && npm run build`, then `firebase deploy --only functions`.
Hosting targets are defined in [firebase.json](firebase.json).

## Keys and secrets

Firebase and Stripe keys come from `.env` / function config only. If a key leaks, regenerate
it in the Firebase or Stripe console and rotate every deployment that used it.
