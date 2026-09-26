# CP0 design baseline: storefront

This is the "before" picture required by PLAN §7.1: full-page screenshots of the **launch-scope storefront pages** on the current Firebase deploy, taken before any Cloudflare-port change. Every later checkpoint re-shoots these pages on staging and diffs them against this set (PLAN §7.3: at most 0.5 % differing pixels, or an explained delta).

- **Source:** `https://shop-meteorpr.web.app/melodie-mc/…` (live Firebase Hosting)
- **Bundle:** `assets/index-EybuBb5L.js` (read from the page's `<script src>` on every shot)
- **Captured:** 2026-09-26, 09:30:41 to 09:34:12 UTC
- **Widths:** 375 (mobile, 375×812 viewport), 768 (tablet, 768×1024), 1440 (desktop, 1440×900). Device scale factor 1, full page, lossless PNG.

## Contents

`storefront/<page>-{mobile,tablet,desktop}.png`: 12 pages × 3 widths = 36 PNGs, 19 MB in total.

| page | path | H1 |
|---|---|---|
| home | `/melodie-mc/` | Merchandise |
| produkter | `/melodie-mc/produkter` | Alla produkter |
| kategori | `/melodie-mc/kategori/melodie-mc-90s-cover-art` (first category link in the nav) | Melodie MC 90s Cover Art |
| product | `/melodie-mc/product/anyone-out-there_anyone-out-there` (first product in the grid; redirects to `?v=anyone-out-there-original-s`) | Anyone Out There |
| cart | `/melodie-mc/cart` (empty) | Din Varukorg |
| checkout | `/melodie-mc/checkout` (empty cart: no redirect, the page renders its own empty state) | Din varukorg är tom |
| legal-kopvillkor | `/melodie-mc/legal/kopvillkor` | Köpvillkor |
| legal-angerratt | `/melodie-mc/legal/angerratt-och-returer` | Ångerrätt & returer |
| legal-integritetspolicy | `/melodie-mc/legal/integritetspolicy` | Integritetspolicy |
| legal-plattformsvillkor | `/melodie-mc/legal/plattformsvillkor` | Plattformsvillkor |
| rapportera-intrang | `/melodie-mc/rapportera-intrang` | Rapportera intrång |
| angra | `/melodie-mc/angra` (guest withdrawal; launch scope per PLAN §3.2) | Ångra avtalet här |

`storefront/manifest.json` has one entry per page: `page, url, finalUrl, title, h1, consoleErrors, files{mobile,tablet,desktop}, sha256{…}, capturedAt, bundle`. It also carries `dimensions`, `failedRequests`, `consoleErrorsAllKnownNoise`, and, only where they apply, `h1All` (more than one H1), `titleByViewport` (title differed between widths) and `layoutWarnings` (horizontal overflow). The sha256 values match `shasum -a 256`. `storefront/capture.jsonl` is the raw per-shot record, one row per page × width.

Scripts:
- `capture-storefront.sh <outdir> [base-url]` takes the shots and writes `manifest.json` through `build-manifest.cjs`.
- `diff-storefront.sh <baseline-dir> <reshoot-dir> [diff-dir]` runs the pixel diff.

## How it was captured

- **Browser:** gstack `browse` (headless Chromium driven by Playwright), `~/.claude/skills/gstack/browse/dist/browse`.
- **Per page and width:** a fresh navigation at that viewport, then a 3 s settle. Next the script scrolls through the whole page in 500 px steps so that lazy images and scroll-reveal content load, and returns to the top. After that it takes the screenshot, then reads the metadata, the console errors and the failed requests.
- **Screenshot method:** `browse screenshot --selector html <file>`, an element screenshot of `<html>`. This is not `browse responsive`, for two reasons:
  - `responsive` shoots desktop at 1280, not 1440.
  - gstack's `screenshot-size-guard` downscales every full-page capture so that its longest side is at most 2000 px (a 375×4668 page becomes 161×2000). Element screenshots skip that guard, so the PNGs are 1:1 at the real CSS width.
- **Read-only:** the target is public. The capture clicked nothing, filled nothing, submitted nothing, and added nothing to the cart.
- **Determinism check:** a full re-shoot about 10 minutes later was diffed against this set:
  - 33 of 36 shots were pixel-identical.
  - `home-*` differed by 0.001–0.003 % with no fuzz, and by 0 % at the diff script's default 2 % fuzz.
  - So the noise floor is effectively zero when the data has not changed.

## Console errors (known noise)

Every page at every width logs the same three entries and nothing else:
- a Cookiebot warning (`The domain SHOP-METEORPR.WEB.APP is not authorized to show the cookie banner…`);
- two `Failed to load resource: 404` errors. One is Cookiebot's `consentcdn.cookiebot.com/consentconfig/…/configuration.js`. The other does not show up in the main-frame network log; it is most likely inside the Cookiebot iframe.

`consentcdn.cookiebot.com/consentconfig/…/configuration.js` is the only 4xx/5xx request in the log. `consoleErrorsAllKnownNoise` is `true` for all 12 pages.

## Capture artefacts to expect in any re-shoot

These are deterministic, so they also appear in every re-shoot and do not cause diffs:

- **`product-mobile`:** the fixed bottom "Lägg i kundvagnen" bar appears where it sits in the first viewport (about y 720–812 in the PNG). There it covers the colourway chips. This is how a full-page capture renders `position: fixed`; it is not a layout bug.
- **`legal-plattformsvillkor-mobile`:** the document is 437 px wide in a 375 px viewport, because the sub-processor table overflows. The capture is clipped at 375, so the overflow itself is not visible. See `layoutWarnings`.
- **Legal pages (köpvillkor, ångerrätt, integritetspolicy):** these print "Senast uppdaterad: <today>" in two places (`legalPageRenderer.js` `formatToday()`), so a re-shoot on a later day always differs in that text. The delta is small and explained; mask it or accept it.
- **Footer:** the footer shows "© <year>".

## Pre-existing drift seen while capturing (recorded, not fixed; PLAN §7.2)

This list feeds the impeccable audit and `DESIGN.md`. None of it was changed.

- **`<title>`:**
  - Product, cart and the three shop legal pages use the placeholder suffix "| My Shop".
  - Checkout is just "Melodie MC".
  - `rapportera-intrang` at 375 showed "Melodie MC" rather than "Rapportera intrång" once, in the baseline run. Seven later loads showed the right title, so this is a title race.
- **Two H1s:** the product page has two ("Anyone Out There" ×2), and so does each shop legal page (the page title, then "<doc> – Melodie MC").
- **Plattformsvillkor:** the page is live with "UTKAST – ej granskat av jurist" and `[BEKRÄFTA: …]` placeholders, and at 375 its table overflows horizontally.
- **Placeholder shop data:**
  - The footer shows "My Company / 123 Main Street / City" and `hello@example.com`.
  - The ångerrätt page shows "Returadress ej angiven".
- **Home:**
  - The "Vad våra kunder säger" heading has an empty body.
  - The Trustpilot card has an empty quote, credited to "Trustpilot User".
- **Catalogue:** one product ("The Ultimate Experiance") shows "från 1.00 kr".

## What is NOT captured

- **Admin and platform pages** (`/admin/*`, platform `/shops`, `/printers`, and so on). They need a logged-in session, so they are a separate step (for example `browse cookie-import-browser` from Mikael's session, run read-only).
- **Admin dark mode.** Dark mode exists only in the admin; the storefront has no dark theme. The "light/dark" requirement in PLAN §7.1 therefore applies to that admin step.
- **Pages that need an order:** order confirmation (`/order-confirmation/:id`) and `/order-return`.
- **Cart and checkout with items in them.** That needs add-to-cart, which was not done here. The cart lives in localStorage, so a later step can seed it without placing an order.
- **Interactive states:** mobile menu open, search open, hover, a switched variant, size guide expanded, account dropdown, and form validation errors.
- **Deferred (PORT-LATER) storefront pages:** account, affiliate, B2B, and the review and recovery token pages. Per PLAN §7.3 these are not shot.
- **Other storefront pages:** `/samling/:handle` and `/tagg/:tag` browse pages (melodie-mc's nav links none of them; `kategori` is the linked taxonomy), 404 / unknown-shop / disabled-shop pages, and other shops or templates.

## Re-shooting for a diff

Requirements: gstack `browse`, `node`, and ImageMagick 7 (`magick`).

```sh
# 1. shoot (default base = live Firebase; pass the staging origin for a checkpoint)
docs/cf-port/baseline/capture-storefront.sh /tmp/reshoot https://<staging-host>

# 2. diff against this baseline (exit 1 = red)
docs/cf-port/baseline/diff-storefront.sh docs/cf-port/baseline/storefront /tmp/reshoot
```

- **Diff statuses:** `ok` / `RED` compare the share of differing pixels against `LIMIT`. `SIZE` means the page height or width changed, which counts as red because the layout moved. `MISSING` means a file is absent.
- **Settings:** `LIMIT` defaults to 0.5 (%), per PLAN, and `FUZZ` to 2 %. Both can be overridden through the environment.
- **Diff images:** a highlighted diff PNG is written for every shot that is not identical.
- **Match the data.** This is a pixel diff, so catalogue or content changes also show up as red: a new product, a price edit, reviews, branding. Shoot staging against data migrated from the same snapshot, or re-baseline Firebase right before comparing.
- **Keep the viewport heights (812 / 1024 / 900).** Short pages such as cart, checkout and angra fill exactly one viewport (for example `cart-desktop` is 1440×900), so a different height changes the PNG size.
- **Change the page list in one place.** The list lives in `capture-storefront.sh` (`PAGES`). If slugs change in the port, update it there and note the change here.
