Model: claude-opus-5-5 (Opus 5.5)

# CP9-OB: what a new shop's onboarding trips over

Built on HEAD `90f4b141`, branch `cf-port`, in the working tree only. No git write, nothing on the network beyond localhost, no wrangler command that reaches Cloudflare, no deploy, staging not touched. At the start `git status --short` was empty.

The defects come from the onboarding dry run of 2026-10-04 (`HANDOVER.md`, update 2026-10-05 01:22; shots `~/chopshop-export/shots-onboarding-2026-10-04/`). Each was checked in the code before anything was built; where it was not as described, the build log says so.

## Design (written before the code of items 2 and 5)

### Item 2: what a placeholder can reach, and the rule for adopting

**Where the placeholders come from.** `src/config/store.js` ships six identity texts as defaults: `shopName` "My Shop", `legalName` "My Company", `tagline` and `companyDescription` "Quality products, delivered.", `supportEmail` "hello@example.com", `address` "My Company<br>123 Main Street<br>City". They reach people by four roads:

| Road | Today | Seen in the dry run |
|---|---|---|
| The admin's settings form: `formFromSaved = { ...STORE, ...saved }` (AdminSettings.jsx) | every field nothing is stored for shows the placeholder as its VALUE | `17-settings.png`: Juridiskt företagsnamn "My Company", Adress, Slogan, Företagsbeskrivning filled in |
| The legal texts the seller adopts are rendered from that form (`renderAcceptedLegalTexts(storeForm)`) | the placeholders are printed into the adopted text | `51-legal-kopvillkor.png`: "Adress: My Company 123 Main Street City", "E-post: hello@example.com", and an empty "Momsregistreringsnummer:" |
| The storefront's settings: `mergeSettings = { ...STORE, ...response }` (src/storefront/providers/StoreSettings.jsx), and the SEO helpers' `STORE.shopName` (src/storefront/replacements/productUrls.js) | every identity key the shop has not set prints the placeholder: footer, product page title "Dry Run Tee \| My Shop", cart, checkout and legal titles | `52-pdp.png`, `50-storefront-home.png`: footer "My Company 123 Main Street City", "Quality products, delivered." |
| The storefront header shows `store.logoUrl`, which defaults to `/images/logo.svg`: an SVG whose drawn text is "My Shop" | every shop without a logo shows "My Shop" in its header, on every page | all storefront shots |
| **Stored** placeholders. The older admin saved its whole form, defaults included, and the import carried them: in the export of 2026-09-27, melodie-mc holds legalName "My Company", address "My Company<br>123 Main Street<br>City", tagline and companyDescription "Quality products, delivered."; ninetone and sillmans hold the tagline (and sillmans the description); three shops hold supportEmail "hello@example.com", which the importer wrote to `tenants.support_email` | the Worker's public answer (`GET /v1/storefront` identity, and the SEO answer built from it: title "Ninetone Group - Quality products, delivered.", JSON-LD e-mail) prints them as the shop's own | not on the dry-run shop; seen in the export |

**The Worker's side.** The adopted legal pages are served verbatim from the adoption's snapshot (`routes/public-legal.ts`): the Worker never fills them, so what they print is fixed at the act of adopting. The public storefront answer and the SEO answer take the identity through the allowlist `projectStoreIdentity` (`storefront/identity-projection.ts`) and the support address from `tenants.support_email`. No Worker code invents a placeholder; it passes on stored ones.

**What the legal templates print** (`src/config/legalTemplates.js`, all three pages, both seller branches): `{{shop_name}}` (the shop's name, always set at provisioning), `{{seller_legal_name}}` (identity `legalName`), `{{seller_address}}` (identity `address`; köpvillkor §1 and the integritetspolicy), `{{contact_email}}` (`tenants.support_email`, platform-owned by D99), `{{return_address}}` (already a checkout condition), `{{org_number}}` only in the company branch (`sellerType` = company), `{{vat_number}}` only inside the company branch AND when VAT-registered (köpvillkor §1), and the phone as a whole line or nothing.

**The rule (exactly what the templates print):** adopting the legal pages requires a legal name, a postal address and a contact e-mail; for a company also the organisation number; for a VAT-registered company also the VAT number. A value is missing when it is empty after trimming, or a placeholder: one of the six texts above (compared without tags, spaces and case), or an e-mail address at `example.com/.org/.net/.se` (the rule `realShopAddress` already applies to the order mails).

**Where it is enforced:**
1. **The adopt control** (AdminSettings.jsx): the same list as the return address and the VAT answer already use ("Kan inte godkännas ännu: …"); the button stays disabled and says what is missing. The support address is the platform's: its line says so ("Support-e-post saknas. Plattformen lägger in den.").
2. **The server, at the act of adopting**: `POST /v1/admin/legal/accept-pages` reads the stored identity, the VAT columns and `tenants.support_email`, and refuses with 409 `legal_identity_incomplete` and `missing: [...]` (field names only) before the rate limit and before writing anything. The page saves the identity right before it adopts (as it does today), so the stored identity is the one the texts were rendered from. This is the backstop for a tab opened before the deploy, which would still render placeholders.
3. **Not retroactive.** `readLegalReadiness` (the checkout's gate) is not touched: a shop that has adopted keeps its open checkout. Only a NEW adoption is refused. A re-adoption is a new act, so a shop that adopted placeholders must fill its identity before it can adopt again.
4. **The status answer** (`GET /v1/admin/legal/status`) gains one additive member, `identityMissing: string[]` (the same field names), so the dashboard's checklist (item 3) reads the server's own verdict.

**The other roads:** `STORE`'s six texts become empty (the hint texts are written separately, in Swedish); the admin form treats a stored placeholder as empty; the storefront's footer, header and SEO titles print the shop's own value or nothing (no empty label); the public projection drops a stored placeholder value. The last one changes the `GET /v1/storefront` body without a catalog bump, so `STOREFRONT_BODY_REVISION` is raised (item 5 raises it anyway).

**For the platform (proposed, not built):** which shops would have adopted placeholder text, and how to show it (see "Item 2: shops that adopted placeholder text" below).

**The support address has no editor.** D99 makes it the platform's, and the console has no control for it (`CP5_FI_REPORT.md` 5: `patchTenant` takes it, no markup). Once adopting requires it, every new shop would wait on an API call. So the platform's shop page gets one small field for it (PATCH `/v1/platform/tenants/:id { supportEmail }`, the route that exists). The seller still cannot set it (D99 stands).

### Item 5: the storefront knows whether the shop can take an order

**The fact.** A checkout is refused (opaque 404) unless `isCheckoutLegallyOpen` (the terms gate and the legal readiness, `legal/legal-pages.ts`); a payment is refused (opaque 404) unless the shop's account can take a destination charge (`stripe_account_id` set and `stripe_charges_enabled = 1`, `commerce/payment.ts loadConnectAccount`). The storefront answer carries one boolean, `ordersOpen`, = both, computed with the SAME two predicates (the Connect test is exported from payment.ts, so the two cannot drift). The routes' own refusals stay as the backstop. A buyer is told only "the shop cannot take orders yet", never why.

**The cache.** The answer's ETag is `"<catalog_version>[-c]-r<n>"`. The new fact changes without a catalog bump: a Connect webhook or refresh writes the account columns (no trigger), and the terms gate can close with no write at all (the D47 grace ends by the clock). So the ETag names the fact, as it names the canvas switch: `-x` is appended while the shop cannot take orders. A body kept from before a change never matches after it: a full answer, never a stale 304. The revision is raised to 2 because every body gains a member (and item 2 drops stored placeholders), so every ETag kept from before the deploy misses once. Preview answers carry no ETag (unchanged).

**The cost.** Two more reads per storefront answer (the terms status and the readiness, as checkout reads them) and one column pair; they run in parallel with the reads the answer already makes after its batch.

**Where the buyer sees it.** The cart page: when `ordersOpen` is false, the checkout button is replaced by one neutral sentence ("Butiken tar inte emot beställningar just nu. Försök igen senare."); the checkout page shows the same block before any field is asked for, instead of after the payment step. The checkout's old block stays for the server's refusal (its text corrected: it no longer blames the köpvillkor).

## Build log

1. **Item 1 (shop-id autofill): done.** Verified: `ProvisionShopModal.jsx:67` `.replace(/[ö ø]/g, 'o')` replaces every space with "o" before the space rule runs. Moved to `src/components/platform/shopIdSlug.js` (`slugifyShopId`): Swedish and other letters by decomposition plus a table for æ ø œ ß ð þ ł đ ı, an apostrophe joins, every other run of non-letters is one hyphen, edges trimmed, cut at 30 and trimmed again (the old function could leave a hyphen at the cut, which the form refuses). Test `src/admin-app/adapters/shopIdSlug.test.mjs` (9).
2. **Item 2 (placeholders, the rule of adopting): done.** Verified as the design's table says (the header's "My Shop" is the generic logo's drawn text, not a text field: a road the brief did not name). Built: `cloudflare/src/legal/legal-identity.ts` (the placeholder list, `isPlaceholderText`, `isPlaceholderAddress`, `readLegalIdentityGaps`); `acceptLegalPages` refuses with `identity_incomplete` before the rate limit; the route answers 409 `legal_identity_incomplete` + `missing`; `GET /v1/admin/legal/status` gains `identityMissing`; the projection drops the five keys' placeholders (`ownText`, `ownAddress`). Frontend: `STORE`'s six texts are empty; `src/utils/placeholderIdentity.js` (the same list, pinned to the Worker's by a test that reads the TS file), `src/utils/legalIdentity.js` (`legalIdentityGaps`, the labels); the settings form blanks stored placeholders and shows Swedish hints; the adopt control lists the identity gaps; the 409 is said in Swedish (`legalAcceptance.js`, `identityGapLabels`); the footer prints each line only when the shop has it; the header shows the shop's name instead of the generic drawing; the SEO titles take the page's `store` (both builds' `productUrls.js`; `DynamicPage` and `ShoppingCart` now read `useStoreSettings`). The platform's shop page gets a support-address field (`SUPPORT_EMAIL_EDITABLE`, `setShopSupportEmail` in both data modules; PATCH exists). Tests: `test/onboarding-identity.test.ts` (Worker), `src/admin-app/adapters/placeholderIdentity.test.mjs`, `src/storefront/adapters/seoTitles.test.mjs`. Existing tests changed: the two `makeLegallyReady` helpers now give the identity (`SLICE_LEGAL_IDENTITY`, `giveSupportAddress`, `giveLegalIdentity`); status shapes gain `identityMissing` (the SQL-fixture shops read `FIXTURE_IDENTITY_MISSING`: adopted without the identity, still open, the non-retroactive case); the vertical slice's shop notice now goes to the support address it has.
3. **Item 5 (the buyer is told at the cart): done.** Verified: `Checkout.jsx` shows "Butiken håller på att färdigställa sina köpvillkor" for any 404 of the payment form, also the payment route's for a missing account. Built: `ordersOpen` in `GET /v1/storefront` = `isCheckoutLegallyOpen` && `takesDestinationCharges` (exported from payment.ts, used by `loadConnectAccount`); the account columns are read in the answer's batch, the legal gate beside the image reads; ETag `-x` while closed, revision 2. Storefront: `settingsFromStorefront` carries `ordersOpen`; the cart replaces "Gå till kassan" with the block; the checkout returns the same block before its first step; the server-refusal block's text is the same neutral one. ETag tests changed: four shops seeded without an account now read `-x`.
4. **Item 3 (Kom igång): done.** Every fact was already readable: the legal status (terms, readiness, and now `identityMissing`), `GET /v1/admin/shop` (`published`, `features.pod`), the Connect view (404 = not opened), one page of `GET /v1/admin/products` (`published`, `takenDown`, `screeningStatus`). No new route. `src/admin-app/adapters/onboarding.js` (pure: six steps, states `done`/`todo`/`platform`/`waiting`, `note` "Plattformen gör det här steget." on platform rows), `loadOnboarding` in the admin build's dashboard data module (null when done or when any read fails), `loadOnboarding` → null in the older build's, `src/components/admin/OnboardingChecklist.jsx` above the metrics. Test `onboarding.test.mjs` (8).
5. **Item 4 (payments truth): done.** The shop's page: "Plattformen har inte öppnat betalningar …" instead of "Kontakta oss". The platform's shop page: `connectLabel` names each state with one sentence (`step`); "Av" became "Väntar på inbjudan" in amber and the card turns amber while it waits for "Bjud in" (onboarding moved from amber to sky, so amber means "waits for you").
6. **Item 6 (invite truth): done.** Verified: on staging the invite route answered 202 (the queue and the allowlist exist) while no Resend key exists; the consumer holds such a mail (`email-queue-consumer.ts readEmailDeliveryConfig`), so "skickade" was false. Built: `isInviteMailConfigured(env)` (invites.ts); `mailConfigured` beside the invite in `POST /v1/platform/users/:id/invite` (202), `POST /v1/admin/members` (201), `…/resend-invite` (202). The clients pass the boolean on; the console's add-admin modal, the users page's "Bjud in" and the shop's members page (add and resend) say "Inget mejl skickades: e-post är inte inställd här ännu. X kan inte logga in förrän e-posten fungerar och inbjudan skickas igen." In the admin build a failed invite is said by the data layer too (`emailNotice`: "Inget mejl skickades (…). X kan inte logga in förrän en inbjudan har gått fram. Skicka den igen under Användare."), not "Skicka uppgifter manuellt" (there are no credentials to send); the older build's branch is unchanged. Tests: one no-mail case per route; two shape assertions extended.
7. **Item 7 (review, both sides): done.** (a) The studio's publish result carries `held` (`pending`) and `blocked`; the panel says "Produkten är sparad och visas i butiken när plattformen har granskat den." for a held product, nothing about the shop for a blocked one, and "LIVE" only otherwise; the duplicate pending notice is not shown under it. The plain product form makes no such claim ("Produkt tillagd" plus the server's screening notice): unchanged. (b) The nav badge "Anmälningar" adds the products waiting for review (`GET /v1/platform/screening?status=pending`); flagged products, already live, are not counted.
8. **Looked at it rendered** (dev servers on 127.0.0.1, the dev APIs, Playwright's headless Chromium; shop admin light, console dark, storefront NORD). Fixed after looking: the checklist's to-do ring sat 4 px left of the icons (a 20 px box now), its link squeezed the sentence to a narrow column on a phone (a grid: the link goes under the sentence below `sm`), the support field's ✕ wrapped to a second line on a phone (the input fills the row). The design's one cart sentence became a title and a body (the checkout's existing block has the same two lines). The dev APIs were taught the new fields (`identityMissing`, the 409, `mailConfigured` with the cookie `admin_dev_mail=off`, `ordersOpen`, an invented new shop `nybutiken`), and the admin dev fixture's shop A got the identity its adoption now needs.
9. **Mutations, gates, report.** Three mutations survived the first round (M3, M11b, M16): two tests were strengthened (a company that is not VAT-registered; another placeholder-domain address); M11b's file does not test the account columns, and the payment route's own suite (`payment-connect.test.ts`) catches the same mutation (M11c).

## What was built, and what a user now sees

| Item | As found | Built | What a user sees now |
|---|---|---|---|
| 1 | `[ö ø]` holds a space: "Dry Run Artist" → `dryorunoartisto`; a cut at 30 could end in "-" (refused by the form) | `slugifyShopId` in its own module, with a test | "Dry Run Artist & Söner" suggests `dry-run-artist-soner` (`ob-provision-slug-*.png`) |
| 2 | Placeholders as form values, in the footer, the header (the logo drawing), the titles, and inside adopted legal texts; stored placeholders in the imported identities and served publicly | Empty defaults; stored placeholders treated as empty and not served; the adoption requires the identity the pages print (client control + server 409); a support-address field for the platform | Empty fields with Swedish hints; "Kan inte godkännas ännu: …, Juridiskt namn saknas, Adress saknas." under the adopt button; a storefront with no default text anywhere (`ob-settings-*`, `ob-sf-home-*`, `ob-sf-pdp-*`: title "Linnetröja \| Ny Butik") |
| 3 | No checklist | "Kom igång" on the dashboard from existing reads | Six rows, each one sentence and a link, platform rows marked; gone when all is done (`ob-dashboard-*`) |
| 4 | "Kontakta oss"; the console's Connect card says the same sentence in every state and "Av" in grey | A truthful sentence on the shop's page; one sentence per state and an amber "Väntar på inbjudan" on the console | `ob-payments-not-opened-*`, `ob-platform-shop-*`, `ob-platform-shop-waiting-1440` |
| 5 | The buyer fills the whole checkout, then the payment's 404 says the köpvillkor are unfinished | `ordersOpen` in the storefront answer, named in its ETag; the cart and the checkout say so first | "Butiken tar inte emot beställningar just nu" in place of "Gå till kassan" and as the checkout page (`ob-sf-cart-closed-*`, `ob-sf-checkout-closed-*`); an open shop is unchanged (`ob-sf-cart-open-provbutiken-*`) |
| 6 | "Inloggningsuppgifter skickade" although no mail can leave staging | `mailConfigured` on the three invite answers; four messages | "Inget mejl skickades: e-post är inte inställd här ännu. X kan inte logga in förrän …" (`ob-platform-add-admin-no-mail-*`, `ob-platform-users-invite-no-mail-*`, `ob-members-invite-no-mail-*`) |
| 7 | "nu LIVE i butiken" for a held product; the badge counts reports only | `held`/`blocked` on the result; the badge adds pending reviews | The held sentence instead of LIVE; "Anmälningar 2" with one new report and one product waiting in the dev fixtures (checked against the dev API: newCount 1, pending 1) (`ob-platform-badge-*`). The publish result itself was NOT looked at rendered (see Unfinished) |

## Item 2: shops that adopted placeholder text (staging-shaped), and a proposal

Not retroactive, as briefed: `readLegalReadiness` is untouched, so every shop that adopted keeps its open checkout. Which adoptions would the new rule have refused, read from the export of 2026-09-27 and the handover's account of how staging's adoptions were made (staging itself was not read):

| Shop | How it adopted on staging | What its adopted texts print |
|---|---|---|
| `dryrun-20261004` | the tester in the admin | "Adress: My Company 123 Main Street City", "E-post: hello@example.com", an empty "Momsregistreringsnummer:" (`51-legal-kopvillkor.png`) |
| melodie-mc | `scripts/cf-port/staging-legal.mjs` renders the templates from the shop's IMPORTED identity | its imported "My Company", "My Company<br>123 Main Street<br>City" and the support address (imported "hello@example.com", unless the importer's e-mail map rewrote it on staging) |
| ninetone | the same script | its real name and address, but the support address "hello@example.com" (imported) and an empty "Organisationsnummer:" (company, `orgNumber` "") |
| sillmans | the same script | real name, address, org and VAT numbers; the support address "hello@example.com" |
| gif-sundsvall | the same script | no legal name, address or support address in the identity: three empty lines |
| `slice-20260927`, `slice-connect-20260927` | `seed-staging-slice.mjs`, fixture texts (no template) | no placeholder, but no identity either |

**In production none of this exists yet**: no shop in the source has adopted its pages (no `legal.acceptance` in the export), so every shop adopts after the cutover under the new rule. That makes the platform's part of the runbook's §6.5/§6.6 larger (see Follow-ups).

**Proposed, not built:** (a) the platform's shop detail (`GET /v1/platform/tenants/:id` `legal.pagesAdoption`) gains `placeholders: string[]`: the latest adoption's snapshot scanned for the placeholder texts (`PLACEHOLDER_IDENTITY_TEXTS`, normalised) and for an empty identity line (`<li>Adress: </li>`, `E-post: `, `Organisationsnummer: `, `Momsregistreringsnummer: ` with nothing after); the console shows a red pill "Antagna sidor innehåller platshållare" with the list, and the seller's settings page says "Dina antagna sidor innehåller … Fyll i uppgifterna och godkänn på nytt." The checkout stays open. (b) A read-only report over every tenant before the cutover's §6.6 (a script under `scripts/cf-port/`, a later unit).

## Decisions for Mikael (built on the first option; the alternative beside it)

| # | Decision | Alternative |
|---|---|---|
| OB1 | The adopt rule is exactly what the templates print: legal name, postal address, support address; a company's org number; a VAT-registered company's VAT number. `sellerType` is not required (unset prints the individual branch, which has no hole) | Also require `sellerType`, and the VAT number of every VAT-registered seller (what `legalPageReadiness.js missing` lists) |
| OB2 | The rule holds even when all three pages are the seller's own text | Skip it for a page the seller wrote |
| OB3 | The support address stays the platform's (D99); the console gets a field for it on the shop page | Let the seller set it (a seller route, a D99 reversal), or ask for it in "Ny butik" |
| OB4 | A stored placeholder is not shown publicly. Visible on the imported shops at the cutover: ninetone's and sillmans' tagline "Quality products, delivered." and sillmans' description leave the hero, the footer and the SEO title; three shops' support address leaves the footer and the JSON-LD until the platform sets a real one | Show stored values until the seller saves |
| OB5 | An address at `example.com/.org/.net/.se` is no address (the order mails' rule). Staging's test shops use `@example.com` addresses as admins, and a new staging shop needs a real-looking support address to adopt | Also `example.test`, or no domain rule |
| OB6 | `ordersOpen` in `GET /v1/storefront`, `-x` in its ETag, two more reads per answer | A separate route (needs the web Worker's allowlist) |
| OB7 | The cart keeps working (lines, the code box); only the checkout button is replaced; the checkout is one block | Also refuse "Lägg i kundvagnen" on a closed shop |
| OB8 | The checklist reads one page (100) of products | A count route |
| OB9 | The checklist disappears when all is done, and on any failed read | Collapse to one line ("Butiken är igång") |
| OB10 | The badge adds products waiting for review to "Anmälningar"; flagged ones (already live) are not counted | A badge of its own |
| OB11 | Staging will now say "Inget mejl skickades" for every invite until Resend exists: true | Hide the console's invite until mail works |
| OB12 | The "Logotyp-URL" field still shows `/images/logo.svg` (the Butik page owns the logo; blanking it would write a key on every save) | Blank it like the six texts |
| OB13 | The console's "Onboarding" pill moved from amber to sky, so amber means "waits for the operator" | Keep amber for both |

## Deviations from the brief

1. **A support-address field on the platform's shop page** (not asked). Without it the new adopt rule would leave every new shop waiting on a hand-made API call: the address is platform-owned (D99) and the console had no control for it.
2. **The shop's own members page** (add and resend) also says when no mail can leave, beside the console: the same false "skickad" was there.
3. **`GET /v1/admin/legal/status` gains `identityMissing`** (additive), so the checklist reads the server's verdict.
4. **The older build changes with the shared files**: `STORE`'s six texts are empty there too, its `productUrls.js` titles drop the dangling " | ", the footer and the header are shared. It compiles (`npx vite build`); it is not deployed from this branch.
5. **The dev APIs and fixtures** (`src/admin-app/dev`, `src/storefront/dev`) mirror the new fields; the admin fixture's shop A now has a legal name, an address and an org number.
6. **Existing tests changed**: listed under Files. The harness gives every slice shop an identity and a support address, so the vertical slice's shop notice now goes to that address (the fallback to the oldest admin stays covered by `order-emails.test.ts`).
7. No migration, no config file, nothing under `scripts/`, `guard/`, `cloudflare/render/` or `cloudflare/web/src`. The guard's allowlist did not change.

## Every new or changed Swedish text

| Where | Text |
|---|---|
| Settings, hints (placeholders) | "Butikens namn" · "T.ex. Mitt Företag AB, eller ditt namn om du säljer som privatperson" · "T.ex. Tryck och merch från Sundsvall" · "Inte angiven ännu" (support) · "T.ex. Storgatan 1<br>123 45 Sundsvall" · "En eller två meningar om butiken. Visas i sidfoten." |
| Settings, Juridik & moms lead | "… Juridiskt namn, adress, support-e-post, returadress och momsstatus måste finnas innan du kan godkänna sidorna." |
| Adopt control gaps (`legalIdentity.js`) | "Juridiskt namn saknas" · "Adress saknas" · "Support-e-post saknas" · "Support-e-post saknas (plattformen lägger in den)" · "Organisationsnummer saknas" · "Momsregistreringsnummer saknas" |
| Adopt refused by the server (409) | "Villkoren kan inte godkännas ännu: {fält}. Fyll i uppgifterna, spara och godkänn igen." · "Villkoren kan inte godkännas ännu: butikens uppgifter är inte kompletta." |
| Kom igång (title, counter) | "Kom igång" · "{n} av {m} klara" |
| Kom igång rows | "Plattformsvillkor" / "Läs och godkänn plattformens villkor." / "Öppna villkoren" / "Godkända." · "Butikens uppgifter" / "Fyll i {lista} under Inställningar." (+ " Support-e-posten lägger plattformen in.") / "Plattformen lägger in butikens support-e-post." / "Ifyllda." / "Öppna Inställningar" · "Juridiska sidor" / "Läs igenom och godkänn köpvillkor, ångerrätt och integritetspolicy längst ned på sidan Inställningar." · "Betalningar" / "Plattformen öppnar betalningar för butiken." / "Fyll i Stripes formulär under Utbetalningar så att butiken kan ta betalt." / "Fyll i det som saknas i Stripes formulär under Utbetalningar." / "Stripe granskar dina uppgifter. Du behöver inte göra något just nu." / "Butiken kan ta betalt." / "Öppna Utbetalningar" · "Första produkten" / "Skapa din första produkt i designstudion under Print on demand och publicera den." / "Lägg upp din första produkt och publicera den." / "Produkten är sparad och visas i butiken när plattformen har granskat den." / "Plattformen godkände inte produkten. Öppna den under Produkter för att se varför." / "Publicerad." / "Öppna Print on demand" / "Öppna Produkter" · "Butiken publiceras" / "Plattformen publicerar butiken när stegen ovan är klara." · "Butiken är publicerad" / "Köpare kan hitta butiken." · note "Plattformen gör det här steget." · list words "juridiskt namn", "adress", "organisationsnummer", "momsregistreringsnummer", "returadress", "om butiken är momsregistrerad" |
| Payments page (shop) | "Plattformen har inte öppnat betalningar för din butik ännu. När den har gjort det fyller du i Stripes formulär här, och sedan kan butiken ta betalt. Du behöver inte göra något förrän dess." (was "Utbetalningar är inte aktiverade för din butik ännu. Kontakta oss för att komma igång.") |
| Console, Connect pill and sentence | "Väntar på inbjudan" (was "Av") · "Butiken kan inte ta betalt förrän du bjuder in den. Klicka på Bjud in, sedan fyller butiken i Stripes formulär." · "Inbjuden. Butiken behöver nu fylla i Stripes formulär under Utbetalningar i sin admin." · "Butiken har börjat fylla i Stripes formulär men är inte klar. Den kan inte ta betalt förrän Stripe har godkänt kontot." · "Butiken kan ta betalt." (all replace "Bjud in butiken att aktivera Stripe Connect. Butiken slutför onboarding själv innan den kan ta betalt.") |
| Console, support card | "Support-e-post" · "Adressen köparna når butiken på. Den står i butikens juridiska sidor och sidfot." · "Saknas. Butiken kan inte godkänna sina juridiska sidor förrän du har lagt in den: sidorna skriver ut den." · "Lägg in adress" · "Spara" · "Ange en giltig e-postadress." · "En adress på example.com räknas inte. Ange butikens riktiga adress." · "Support-e-post sparad: {adress}" · "Support-e-post borttagen" · "Kunde inte spara support-e-posten." |
| Invites, no mail can leave | "Inget mejl skickades: e-post är inte inställd här ännu. {e-post} kan inte logga in förrän e-posten fungerar och inbjudan skickas igen." (alone, after "Admin tillagd för {butik}. ", or after "Administratören lades till. ") · failed invite: "Inget mejl skickades ({orsak}). {e-post} kan inte logga in förrän en inbjudan har gått fram. Skicka den igen under Användare." |
| Studio publish result | "Produkten är sparad och visas i butiken när plattformen har granskat den." (instead of "den är nu LIVE i butiken." while held) |
| Storefront, cart and checkout | "Butiken tar inte emot beställningar just nu" · "Du kan fortfarande titta på produkterna. Försök igen lite senare." (also replaces the checkout's "Butiken tar inte emot beställningar ännu" / "Butiken håller på att färdigställa sina köpvillkor. Försök igen lite senare.") |
| Storefront footer | "Följ oss" (only when the shop has no name) |

No em dash and no exclamation mark in any of them (checked by grep and, for the checklist and the gap labels, by tests). The storefront's SEO descriptions keep their existing en dash ("{produkt} – {butik}").

## Files

Worker (`cloudflare/src`): new `legal/legal-identity.ts`; changed `legal/legal-pages.ts`, `routes/legal-admin.ts`, `storefront/identity-projection.ts`, `storefront/public-storefront.ts`, `storefront/public-routes.ts`, `commerce/payment.ts` (the account test extracted, behaviour identical), `platform/invites.ts`, `routes/platform-users.ts`, `routes/admin-members.ts`.

Worker tests (`cloudflare/test`): new `onboarding-identity.test.ts` (18); changed `slice-harness.ts`, `tenant-fixtures.ts` (the identity in `makeLegallyReady`, `giveSupportAddress`, `giveLegalIdentity`, `SLICE_LEGAL_IDENTITY`), `legal-pages.test.ts`, `public-legal.test.ts`, `pages.test.ts`, `legal.test.ts`, `legal-grace.test.ts`, `slice/vertical-slice.test.ts`, `public-storefront.test.ts`, `discount-storefront.test.ts`, `pod-publish.test.ts`, `stand-in-frames-seller-storefront.test.ts`, `web-worker.test.ts`, `invites.test.ts`, `member-resend-invite.test.ts`, `admin-members.test.ts`.

Frontend (`src`): new `components/platform/shopIdSlug.js`, `utils/placeholderIdentity.js`, `utils/legalIdentity.js`, `admin-app/adapters/onboarding.js`, `components/admin/OnboardingChecklist.jsx`, tests `admin-app/adapters/shopIdSlug.test.mjs`, `admin-app/adapters/placeholderIdentity.test.mjs`, `admin-app/adapters/onboarding.test.mjs`, `storefront/adapters/seoTitles.test.mjs`; changed `config/store.js`, `components/platform/ProvisionShopModal.jsx`, `pages/admin/AdminSettings.jsx`, `admin-app/adapters/settings.js`, `admin-app/replacements/legalAcceptance.js`, `components/shop/ShopFooter.jsx`, `components/shop/ShopNavigation.jsx`, `storefront/replacements/productUrls.js`, `utils/productUrls.js`, `pages/shop/PublicProductPage.jsx`, `pages/shop/DynamicPage.jsx`, `pages/shop/ShoppingCart.jsx`, `pages/shop/Checkout.jsx`, `storefront/providers/StoreSettings.jsx`, `pages/platform/PlatformShopDetail.jsx`, `pages/platform/shopCells.jsx`, `pages/platform/platformShopDetailData.js`, `admin-app/replacements/platformShopDetailData.js`, `pages/admin/AdminDashboard.jsx`, `pages/admin/adminDashboardData.js`, `admin-app/replacements/adminDashboardData.js`, `pages/admin/AdminPayments.jsx`, `api/admin/platform.js`, `api/admin/members.js`, `admin-app/adapters/member.js`, `admin-app/replacements/addShopUserData.js`, `admin-app/replacements/platformUsersData.js`, `admin-app/replacements/adminUsersData.js`, `admin-app/replacements/memberResendData.js`, `components/platform/AddShopUserModal.jsx`, `pages/platform/PlatformUsers.jsx`, `pages/admin/AdminUsers.jsx`, `admin-app/replacements/podStudioPublish.js`, `wagons/pod-wagon/studio/PublishPanel.jsx`, `admin-app/replacements/platformLayoutData.js`; dev: `admin-app/dev/{dev-api.mjs, fixtures.json, fp-dev.mjs, members-dev.mjs, platform-dev.mjs, platform-rest-dev.mjs}`, `storefront/dev/fixtures.json`; changed tests `admin-app/dev/dev-api-settings.test.mjs`, `admin-app/dev/dev-api.shells.test.mjs`, `admin-app/pages/new/fpData.test.mjs`, `admin-app/replacements/podStudioPublish.test.mjs`, `admin-app/replacements/shells.test.mjs`, `storefront/dev/dev-api.test.mjs`.

## Mutations (28 runs on 26 mutations: every mutation caught; every file restored and `cmp`-identical)

Each: the file copied aside, mutated, the named test run, the copy put back with `cp`, compared with `filecmp.cmp` (byte for byte). Runner: `ob-mutate.py` in this session's scratchpad.

| # | File | Mutation | Caught by |
|---|---|---|---|
| M1 | shopIdSlug.js | the old `[ö ø]` replace put back | shopIdSlug.test |
| M2 | shopIdSlug.js | no trim after the cut | shopIdSlug.test |
| M3 | legal-identity.ts | the VAT number required without "VAT-registered" | onboarding-identity (after strengthening) |
| M4 | legal-identity.ts | "My Company" dropped from the list | onboarding-identity |
| M4b | legal-identity.ts | same | placeholderIdentity.test (the pin) |
| M5 | legal-pages.ts | the identity check off | onboarding-identity |
| M6 | legal-pages.ts | refused only for two or more gaps | onboarding-identity |
| M7 | identity-projection.ts | `ownText` keeps placeholders | onboarding-identity |
| M8 | identity-projection.ts | `ownAddress` keeps example.com | onboarding-identity |
| M9 | public-routes.ts | no `-x` in the ETag | onboarding-identity |
| M10 | public-storefront.ts | `ordersOpen` ignores the legal gate | onboarding-identity |
| M11 | payment.ts | `takesDestinationCharges` ignores `charges_enabled` | onboarding-identity |
| M11b | payment.ts | same | `payment.test.ts`: NOT caught (it does not test the column) |
| M11c | payment.ts | same | payment-connect.test (the payment route's own) |
| M12 | public-routes.ts | revision back to 1 | onboarding-identity |
| M13 | invites.ts | `isInviteMailConfigured` always true | invites.test |
| M14 | legal-admin.ts | `identityMissing` dropped from the status | onboarding-identity |
| M15 | legalIdentity.js | no org number for a company | placeholderIdentity.test |
| M16 | placeholderIdentity.js | example-domain addresses kept | placeholderIdentity.test (after strengthening) |
| M17 | onboarding.js | "not opened" as the seller's to-do | onboarding.test |
| M18 | onboarding.js | a held product counted as live | onboarding.test |
| M19 | storefront productUrls.js | the suffix back with "My Shop" | seoTitles.test |
| M20 | platformLayoutData.js | the badge counts every queue row | shells.test |
| M21 | podStudioPublish.js | `held` on `flagged` | podStudioPublish.test |
| M22 | member.js | the resend message ignores `mailConfigured` | fpData.test |
| M23 | settings.js | the support gap not labelled as the platform's | placeholderIdentity.test |
| M24 | admin-members.ts | `mailConfigured` always true | admin-members.test |
| M25 | store.js | `legalName: 'My Company'` back | placeholderIdentity.test |

(M11b is listed as the one run that did not catch: the mutation is caught by M11 and M11c; nothing was left uncovered.)

## Looked at it rendered

Shots: `~/chopshop-export/shots-cp9-ob-2026-10-05/` (35 files, each at 1440 and 390 px unless named): `ob-dashboard-disabled-*` and `ob-dashboard-none-*` (Kom igång, payments not opened / opened), `ob-settings-*`, `ob-payments-not-opened-*`, `ob-members-invite-no-mail-*`, `ob-platform-shop-*`, `ob-platform-shop-waiting-1440`, `ob-platform-support-edit-*`, `ob-platform-support-missing-*`, `ob-platform-add-admin-no-mail-*`, `ob-platform-users-invite-no-mail-*`, `ob-platform-badge-*`, `ob-provision-slug-*`, `ob-sf-home-*`, `ob-sf-pdp-*`, `ob-sf-cart-closed-*`, `ob-sf-checkout-closed-*`, `ob-sf-cart-open-provbutiken-*`. Read in the browser: the PDP's title "Linnetröja | Ny Butik", the legal page's "Köpvillkor | Ny Butik"; the suggested id `dry-run-artist-soner`. Console: only the login page's 401 before sign-in and the dev API's 409 for an address used by an earlier run of the script. Only each surface's existing tokens and components are used (`CardSection`, the admin status tokens; the console's `Card`, pills and inline editor of `CommissionCell`; the storefront's `rounded-tile`, `text-ink`, `font-display`).

## Gates (final, on the tree as delivered)

- `cd cloudflare && npx tsc --noEmit && npx tsc --noEmit -p web && npx tsc --noEmit -p admin`: all three clean.
- `cd cloudflare && npx vitest run`: **Test Files 127 passed (127), Tests 4803 passed (4803)** (baseline 126 / 4782; +1 file, +21 tests); the two known "Network connection lost" lines.
- `cd cloudflare && npm run types:check`: "Types at worker-configuration.d.ts are up to date."
- Frontend `node --test …`: **tests 1114, pass 1114, fail 0** (baseline 1079; +35).
- `npx vite build --config vite.admin.config.js && node cloudflare/admin/check-admin-build.mjs`: "admin build: 28 files (22 text) checked, no Firebase code, no source map, no secret, every file servable."
- `npx vite build && node cloudflare/web/check-storefront-build.mjs`: the older build exit 0; "storefront build: 11 files (7 text) checked, no Firebase code, every file servable."
- `node guard/guards.test.mjs`: "allowlist size = 294 … baseline = 294 … PASS". Added lines and new files grepped for the guard's families: none.
- `node --test "scripts/cf-port/migrate/test/*.test.mjs"`: **tests 554, pass 554** (baseline 554).
- Seen once in the first full Worker run, not caused here: `money-followups.test.ts` failed because a random UUID in an alert happened to contain "12300" (its assertion `not.toContain(String(WITHHELD))`); a flake of that test.

## Follow-ups (not built), proposed

1. **The staging scripts will now be refused**: `scripts/cf-port/staging-legal.mjs:363` and `seed-staging-slice.mjs:928` adopt through the route and get 409 `legal_identity_incomplete` for a shop without a legal name, an address and a real support address. They need to set them first (outside this unit's paths).
2. **Runbook §6.5/§6.6**: before Kent's step, the operator sets a real support address for every shop (three hold "hello@example.com", gif-sundsvall none), and melodie-mc's "My Company" texts must be replaced by Kent's real ones before he can adopt; ninetone needs its org number.
3. The surfacing of placeholder text in existing adoptions (proposal above).
4. The provision form could ask for the support address at creation (OB3's other alternative).

## Seen, outside scope (not fixed)

- `index.storefront.html` keeps `<title>My Shop</title>` and `public/manifest.json` "My Shop" / "Quality products, delivered." (the web Worker replaces the title per shop; the manifest is not per shop).
- `src/components/shop/PaymentMethods.jsx` (imported nowhere) would now label `" Order"`.
- The cart page's tab title is the shop's name, not "Varukorg | …": the settings provider's `document.title` effect runs after the page's Helmet (both builds, before this unit).
- The dry run's other small defects not in this unit: the doubled product handle (`dry-run-tee_dry-run-tee`) and the 3600 px upload shown as 3000 px.

## Unfinished

- **The studio's publish result (item 7a) was not looked at rendered**: reaching it in the dev server takes the whole studio walk; the result's flags are tested (`podStudioPublish.test.mjs`) and the JSX change is the one line of text plus the hidden duplicate notice. Look at it on staging when a new shop's first product is published.
- Everything else in items 1 to 7 is built, tested and looked at.
