# CP10-OB — "Kom igång": the new shop owner's guided start. Design, nothing built.

Date: 2026-10-15 · Branch `cf-port` · Inputs: the 2026-10-14 mocks (`docs/design-explorations/onboarding-2026-10-14/`), Gemini's rework of 2026-10-15 (renders in `~/chopshop-export/onboarding-mocks-2026-10-14/gemini-2026-10-15/`), Codex's interpretation (`CP10_OB_CODEX_REVIEW.md`), the dry run and fixes of CP9-OB (`CP9_OB_REPORT.md`). Mikael's four decisions of 2026-10-15 are taken (OB-D1–D4 below); the rest are defaults for him to overrule.

## What this replaces, and what it keeps

Today a new shop is created in the platform console, the owner is invited by mail, sets a password and lands on the admin dashboard with a six-item checklist in any order. Everything the checklist points at exists and works (CP9-OB). What is missing is the guided start: one thing per screen, the shop visibly taking shape, the gates explained before they bite, and a real end.

This design is a **wizard shell over the existing routes**. Every save goes through the route the admin page already uses; nothing in it has its own data path. The checklist on the dashboard stays as the resumable entry ("Fortsätt där du var") and becomes the wizard's own progress source.

## The four decisions (Mikael, 2026-10-15)

| # | Decision | Taken |
|---|---|---|
| OB-D1 | Who picks the shop type | **The platform, at invitation.** The console's "Ny butik" asks what the shop sells; step 1 shows it read-only with "Fel butikstyp? Hör av dig så ändrar vi." |
| OB-D2 | Digital products and services at launch | **No.** A visible, non-selectable card in the console and a "Kommer senare" card in step 3. Launch = fysiska varor + print on demand. |
| OB-D3 | Who publishes | **The owner requests, the platform publishes.** "Begär publicering" → "Vi förbereder publiceringen" → "Butiken är öppen för köp". Self-publish is a later switch. |
| OB-D4 | Who picks the web address | **The platform assigns it** (agreed in the invite conversation). Step 1 shows it read-only. No availability check, no rename. |

## The shop type becomes a fact of the shop

Today "Butikstyp" in the console is a preset that only flips `features.pod` (D2 of the selector plan), and the Worker reads `features.pod` alone. For a flow that branches on the type everywhere, the type must be one authoritative column:

- **Migration (number taken at build time):** `tenants.shop_type TEXT NOT NULL DEFAULT 'things' CHECK (shop_type IN ('things','pod','digital'))`. Backfill: `pod` where `features.pod` is on, else `things`. `features.pod` stays the capability switch and is derived from the type at provisioning (`pod` ⇒ on); the platform can still flip it by hand for a mixed shop (the console says so).
- **`digital` exists in the CHECK so the console can show the card**, but provisioning refuses it (`shop_type_unavailable`) until the digital product type ships.
- The type rides in `GET /v1/admin/shop` (`shopType`) and in the storefront answer's identity projection (`shopType`), so the wizard, the preview and the copy branch on the same fact.

## The flow

Six steps, resumable, saved through the existing routes. Desktop: form left, preview right. Phone: "Redigera" / "Förhandsvisa" tabs over the same draft. A step is "done" only from saved data and real status, never from having been visited (Codex §7).

The sentence on top of step 1, once: **"Du kan skapa produkter direkt. Innan butiken öppnar behöver du godkänna villkoren och ansluta Stripe. Vi granskar också din första produkt."** (POD) / without the last sentence (things).

### 0. Invitation and password (exists; copy only)
The invite mail and `/reset-password` are what they are (CP5-WK, CP9-OB item 6). New: the password page's heading names the shop ("Välj ditt lösenord för Nattfjäril") and the six steps ahead; after the password the owner lands in the wizard, not the dashboard, while the wizard is not complete. Expired or used link: "Länken har gått ut. Be plattformen om en ny." (the platform's "Skicka inbjudan igen" exists).

### 1. "Din butik" — ca 1 min
Fields: butikens namn (prefilled from provisioning), logga (upload; the public image route), accentfärg (five suggestions from the logo's palette, computed in the browser; the existing `accent`), butikstyp and webbadress read-only. Preview: the storefront header with name, logo and colour; placeholder hero and three placeholder cards. Gate: a saved name. Logo and colour never block. Routes: `PATCH /v1/admin/settings` (store identity), the object routes.

### 2. "Välj utseende" — ca 2 min
Fields: mall (Nord / Sport, the thumbnails that exist), rubrik, en rad om dig. Preview: the full hero. Gate: a template (default Nord, so "Fortsätt" always works). Routes: `PATCH /v1/admin/settings`.

### 3. "Din första produkt" — the branch
The title, the form and the preview follow `shopType`:

| | things: "Ladda upp din första produkt" | pod: "Designa din första t-shirt" | digital |
|---|---|---|---|
| Form | the product form's minimum: bilder, namn, beskrivning, pris (inkl. moms), lagersaldo, leverans (frakt / hämtning as the product form has them) | motiv (upload with the 300-DPI gate's verdict for the chosen frame, not for the pixel size alone), plagg (the supported models with real garment images and **Inköp** per garment — the one number per product the seller may see), färger, ditt pris with "Du får ca X kr per såld tröja" from the real quote, "Öppna designstudion" for placement | one card: "Digitala produkter och tjänster — kommer senare" |
| Preview | the product card with the uploaded image, in a shop whose nav, hero and copy say varor, not plagg | the garment mockup with the motif, "Ny" badge | — |
| Gate | one product saved (published or not) | one product saved; **review is a waiting state, not a barrier**: "Vi granskar din första produkt. Du kan fortsätta." | — |
| Routes | `POST /v1/admin/products` + images | the studio's publish (artwork, mapping, publish) — the wizard opens the studio's eight pages inside its shell for "Öppna designstudion"; the quick path uses the studio's defaults (centred, default size) | — |

### 4. "Uppgifter och villkor" — ca 3 min
Fields: jag säljer som (enskild firma / aktiebolag; privatperson stays off until the platform wants it), namn, organisationsnummer (for an enskild firma this is the personnummer and the law requires it on the legal pages; the field says so), adress, postnummer och ort, momsregistrerad (ja/nej) + VAT number when yes, returadress (same as above / another), e-post för kundfrågor shown read-only as the platform's support address (D99). Preview: the three pages (köpvillkor, integritetspolicy, ångerrätt) rendered live from the template and the form, the seller's values highlighted; tabs. **Copy rule (Kent, 2026-10-15): the platform never says it writes the seller's terms.** The pages are a template the seller fills, reads, adopts and is responsible for — their contract with their customers (the legal design's copy-on-write adoption). The lede says so: "Dina köpvillkor … utgår från en mall och fylls i med de här uppgifterna. Du läser igenom, godkänner och ansvarar för dem." The adoption checkbox reads "Jag har läst … och godkänner dem som mina." Gate: identity complete (the server's `identityMissing` list) and the pages adopted ("Godkänn och fortsätt" = `POST /v1/admin/legal/accept-pages`); the platform terms, if not yet accepted, are a separate box above ("Plattformens villkor för säljare", the existing gate). Routes: `PATCH /v1/admin/settings`, `GET /v1/admin/legal/pages`, `POST /v1/admin/legal/accept-pages`.

### 5. "Ta betalt med Stripe" — ca 5 min
**Kent and Mikael, 2026-10-15: the owner never leaves our page.** Stripe's **embedded account-onboarding component** (Connect.js, `account_sessions` with `components.account_onboarding`) renders Stripe's own form inside the step's left panel. Stripe documents it for accounts with the Express dashboard, which is what we create. The fields are Stripe's, inside Stripe's iframe: personnummer, legitimation and bank account go to Stripe directly and **never touch our Worker** — the same compliance line as the hosted flow, with the person staying on our page. Verification runs in the background: Stripe's `account.updated` webhook (already handled, `commerce/stripe-events.ts`) updates the account columns, and the step shows one of four states on every visit: **Klart** (charges and payouts enabled), **Stripe granskar dina uppgifter** (details submitted, not enabled), **Stripe behöver mer från dig** (requirements due; the component reopens at the missing field), **Inte påbörjat** (the component, fresh). The adapter gains `payoutsEnabled`; "Klart" needs both flags (Codex's catch: today the copy keys on charges alone). New on the Worker: `POST /v1/admin/connect/account-session` (an Account Session for the shop's own account, platform-key-signed, short-lived); the hosted link route stays as the fallback for a browser that blocks the iframe. Preview: "Så går pengarna" with the seller's real first product and the real quote: Kunden betalar / Avgift (plattform och produktion) / Till dig — three lines, nothing else. Gate: none to continue; the state shows in step 6.

To verify at build time: the component's Terms-of-Service URLs (`setFullTermsOfServiceUrl`, `setPrivacyPolicyUrl`) must be ours (the generated pages exist); the CSP of the admin Worker must allow `connect-js.stripe.com` and the Stripe iframe origins; Connect.js loads on the admin origin only.

### 6. "Granska och begär publicering"
The summary with "Ändra" per step, the full preview, and the list of what is still open and **who holds it**: "Behöver göras av dig" / "Granskas av Stripe" / "Granskas av ChopShop" / "Klart". The button "Begär publicering" is live when everything the owner owns is done (product saved, identity and pages adopted, Stripe at least submitted). It writes `tenants.publication_requested_at` and raises a platform alert `publication_requested` (resource = tenant), which lands in the console's existing alert list and shop page as a queue. After it: "Vi förbereder publiceringen" with the open items. The platform's existing publish action closes the request (`publication_requested_at` cleared, the alert resolved) and the owner's next visit shows **"Butiken är öppen för köp"**: the real link, "Kopiera länk", "Öppna butiken", "Till adminen". QR and the Instagram image are a later unit (C's chips).

Publishing by the platform re-checks what checkout checks (`isCheckoutLegallyOpen`, destination charges) and that at least one product is visible; a shop that fails stays unpublished with the reason on the console.

## The owner's draft preview

The existing preview grant (`POST /v1/admin/preview`, 30 min, `X-Storefront-Preview`) bypasses publication only and keeps product eligibility, so a held first POD product does not show in it. The wizard needs the owner to see their pending product. Design: the grant gains a second purpose `owner-draft/v1` (same key derivation, own info string, same lifetime), and the storefront reads under it relax eligibility to **the owner's own tenant's products in `pending` review** (never `blocked`, never taken down), with a ribbon on each: "Förhandsvisning · inväntar granskning". The public preview purpose is untouched. Checkout under either grant stays refused (it already is).

The preview is the real storefront bundle in an iframe on the web host (`/<shop>/?preview=…` as today), with the grant handed over as it is today; the wizard posts the changed settings and reloads the frame. No second renderer.

## Branching beyond step 3

| Area | things | pod |
|---|---|---|
| Hero and nav placeholders | "Välkommen till <butik>", "Produkter", "Om oss" | "Motiv för …" style placeholder stays only until the owner writes their own; "Kläder", "Om mig" |
| Legal pages | the non-POD branch of the templates | the POD branch (production on order, the printer as data recipient, the catalogue-vs-personalised withdrawal distinction preserved — POD does NOT remove ångerrätt by itself) |
| Money example | the real product, three lines | the real garment quote, three lines |
| Step 3 copy | "Ladda upp en bild, beskriv din produkt och sätt ett pris." | "Ladda upp ett motiv så lägger vi det på ett plagg. Inget lager — vi trycker när någon köper." |
| Publication checks | one visible product with stock or made-to-order | one approved product with a valid mapping |

## Recovery states (both candidates lacked them)

Save failed ("Kunde inte spara. Försök igen." with the retry, the draft kept in the form); upload interrupted (the pending object is reserved again); Stripe "save for later" return (the four states above); product rejected by screening ("Vi kunde inte godkänna motivet: <reason>. Ladda upp ett annat."); waiting for the platform (step 6's list, no time promise unless the console can keep it); status read failed ("Kunde inte läsa status" with retry — absence is never "done").

## What exists vs what is new

| Exists (reused as is) | New |
|---|---|
| provisioning, invites, password set, platform terms gate, settings PATCH, object upload, templates, product form and route, the studio and its publish, screening hold, legal identity rule + generated pages + adoption, Connect hosted link/refresh/status, the checklist's facts (`adapters/onboarding.js`), preview grant, platform publish/unpublish, alerts list | `tenants.shop_type` + console choice + the digital card; the wizard shell (`/admin/start`, six step pages, resumable, phone tabs) and the first-login redirect; the draft-preview purpose and the pending ribbon; `payoutsEnabled` in the adapter + four Stripe states + the embedded onboarding component and its Account Session route; `publication_requested_at` + alert kind + console queue entry + the "öppen för köp" page; the branching copy; the password page's heading |

## Units and order

1. **OB-1 (Opus, ~1 unit): the facts.** Migration `shop_type` + backfill, console choice and the digital card, `shopType` in the shop and storefront answers, `publication_requested_at` + alert kind + platform resolve on publish, `payoutsEnabled` in the adapter, the owner-draft preview purpose. Tests on each.
2. **OB-2 (Sonnet, ~1.5 units): the wizard.** The shell, six steps on the existing routes, the preview frame, phone tabs, recovery states, the first-login redirect, the dashboard entry. Looked at rendered on desktop and phone (design gate #5).
3. **OB-3 (later): QR, Instagram image, self-publish switch, the digital track.**

Smoke on staging: a fresh invited shop of each type walked end to end by the reviewer (the mail leg needs Resend; until then the invite link is read from the console as today).

## Decisions for Mikael (defaults in bold)

| # | Decision | Default |
|---|---|---|
| OB1 | Privatperson as a seller category in step 4 | **off** (as today) |
| OB2 | The quick POD path's default placement | **centred, the frame's default size; "Öppna designstudion" for anything else** |
| OB3 | A held first product visible in the owner's draft preview | **yes, with the ribbon** |
| OB4 | "Begär publicering" needs Stripe | **submitted at least; enabled is the platform's publish check** |
| OB5 | Time promise after the request | **none; "Vi hör av oss när butiken är öppen"** |
| OB6 | The wizard for shops that already exist (the first artists invited before it ships) | **the dashboard shows "Kom igång" leading into the wizard at the first unfinished step** |
| OB7 | QR + Instagram image | **OB-3, after launch** |
