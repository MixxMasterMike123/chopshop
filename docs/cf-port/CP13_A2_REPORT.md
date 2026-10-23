claude-opus-5-5

# CP13 A2 — the shop-admin affiliate pages (admin build, Admin-Neutral)

Worktree `.claude/worktrees/cp13-affiliate`, branch `cp13-affiliate`. Working tree only: no deploy, no wrangler, no network. Read before writing: CP13_BRIEFS §0/§1/A2, CP13_A1_REPORT §4 (the contract) + §4.4, CP13_AFFILIATE_DESIGN §0 A14, §4.5, §7.1b, §7.1c, §7.2, CP5_BRIEFS §0 rules 13–19 and the frontend common part, CP4_BRIEFS §0 rules 1–12, the admin build (AdminApp, pages.jsx, the alias list, providers, the discount-code and order-detail replacements, src/api/admin/*), the five Firebase pages, AdminDiscountCodes + components/admin/ui, AppLayout, AdminOrderDetail, AdminDashboard. A1's server code (`routes/affiliate-admin.ts`, `affiliate/projections.ts`, the parsers) was read to check every shape and refusal the pages depend on.

One slip, stated: I ran `git mv` once on my own untracked `affiliateCopy.js`. Git refused it (the file is not tracked), so the index is unchanged; the file was renamed with plain `mv` to `affiliateView.js`.

## 1. Removals and copy changes (rule 17, listed first)

The design's copy (§7.2) wins over byte-for-byte (R2-29). Where the design is silent, the ported page keeps its own words: the titles "Affiliate-hantering", "Affiliate Analytics" and the button "Detaljerad Analytics" stay.

### AdminAffiliates (`/admin/affiliates`)
- **Removed:** the unused inline approve/deny handlers (deny deleted the application). The affiliate column's avatar initials, e-mail and website link go, because the list route carries none of them. The "Konv.grad" column goes, and so does the "Status" column of the applications table, which always read "Väntar".
- **Changed:**
  - "Intjäning" with its "obetalt" sub-line becomes two columns, **Intjänat** and **Att betala**. The status column's commission and discount sub-lines become the columns **Provision** and **Rabatt**.
  - The payout icon is always shown, not only when the balance is above 0, because an open request can exist with nothing left payable.
  - The eye icon "Testa länk", which opened `B2C_SHOP/<lang>?ref=`, becomes a link icon **"Kopiera testlänk"**. It copies the server's `links.refLink`.
- **Copy:**
  - KPIs: "Väntande ansökningar", "Klick (30 dagar)", "Konverteringar (30 dagar)", "Upplupen provision". They were "Väntande Ansökningar", "Totalt antal klick" and "Totala Konverteringar".
  - "Lägg till Affiliate" → **"Bjud in affiliate"**.
  - "Inkomna Ansökningar" → "Inkomna ansökningar". "Alla Affiliates (n)" → "Alla affiliates (n)".
  - "Besök" → "Klick". Status labels: "Inte Aktiv" → "Inaktiv", "Suspenderad" → "Avstängd".
  - The applications table gains **Kanal** and **Inkom**.
  - Empty text: "Inga affiliates ännu. Godkänn en ansökan eller bjud in någon."

### AdminAffiliateEdit (`/admin/affiliates/:id`)
- **Application mode leaves** for the new AdminAffiliateApplication page. The older build still routes `/admin/affiliates/application/:id` to this file, which hands it on.
- **Removed:**
  - **"Skicka inloggningsuppgifter"** and the card that displayed a temporary password. Replaced by "Skicka inbjudan igen" (A3).
  - **"Visa Portal"**, the `admin_code` URL trick. The orders projection is shown inline instead (A13).
  - **"Radera"**, a hard delete that lost the history. It is now **"Ta bort som affiliate"**: revoke, with nothing deleted.
  - The **status cycle button** (Suspendra → Inaktivera → Aktivera). It is now an explicit **Aktiv / Inaktiv / Avstängd** three-way control.
  - The MetricsBar "Totalt antal besök / **Unika besökare** (by IP) / Konverteringsgrad / Provision". No IP is stored (A4).
  - The **"Meddelande"** field. The affiliate row has no message; the application page keeps it.
  - The **"Auto"** code generator button.
  - The **"Senaste ordrar"** rail, which showed 5 orders.
  - The "Utbetalningshistorik" summary boxes.
- **Changed:**
  - The language options sv-SE / en-GB / en-US become **Svenska / Engelska** (the API takes `sv` or `en`).
  - The free-text "Primär kanal" becomes a **Kanal** select of the API's values.
  - The **e-mail is read-only**. It is the login, and the PATCH has no email key.
  - The address is now **Adress, Adressrad 2, Postnummer, Ort, Land**.
  - The code field shows the current code. Changing it shows **"Gamla länkar med den tidigare koden slutar fungera."**
  - The rates are labelled "Gäller nya köp."
- **New, per the design:**
  - **Statistik**: a click-per-day graph over 30 days, then Konverteringar, Intjänat, Återfört, Utbetalt and Saldo.
  - **Beställningar**: the projection, with columns Order, Betald, Belopp, Via (länk/kod), **Affiliate-provision** and Status, or **"Självköp – ingen provision"**.
  - **Reskontra**: Provision / Återföring / Utbetalning / Återkallad utbetalning / Justering, plus **"Lägg till justering"** (an amount ± and a reason).
  - **Utbetalningar**: a list, plus "Hantera" linking to the payout page.
  - **Konto**: "Inbjudan skickad, lösenord ej satt", then **"Skicka inbjudan igen"**, the portal login state and the terms state.
  - **Affiliatelänk** with "Kopiera länk".
  - **The OFF banner.**

### AdminAffiliateCreate → the invite page (`/admin/affiliates/new`)
- **Removed:**
  - Telefon, Land, Adress, Postnummer, Stad, the five social fields, "Marknadsföringsmetod" and "Meddelande". The invite route takes `name, email, code?, rates, preferredLang` only, and the affiliate fills in their own profile in the portal.
  - The "Status: skapas som inaktiv" card. An invited affiliate is active.
  - The client code generator `NAME-123`. The server generates a code when none is given.
- **Copy:**
  - "Skapa ny affiliate" → **"Bjud in affiliate"**; "Skapa affiliate" → **"Bjud in"**.
  - New fields **Kod (valfri)** and **Språk**.
  - The rate inputs go from 1–50 / 0–50 to whole percent 0–100.
  - The subtitle says the mail carries a password-set link.

### AdminAffiliatePayout (`/admin/affiliates/:id/payout`)
- **Removed:**
  - The **required** invoice number and PDF. Both are optional now, per the design.
  - The client-side balance re-verification (`processAffiliatePayout`'s recompute). The server guards instead.
  - The "Viktigt att veta" box. One muted line replaces it.
  - The "eller dra och släpp" label (a native file input).
- **Copy:**
  - Title "Betala Affiliate" → **"Utbetalning"**; "Bekräfta betalning" → **"Registrera utbetalning"**.
  - The rail "Intäktsöversikt" becomes **"Saldo"**: Att betala, Under ångerfrist, Begärt, Utbetalt, Intjänat totalt.
- **New:**
  - The **open request** card: the amount, "Faktura (PDF)", and **"Markera som betald"** with Referens and Anteckning, or **"Avvisa"** with Orsak.
  - A **Referens (valfritt)** field on the record form. The design lists four fields; the API accepts `reference`, and the payment evidence needs it (§6).
  - **Historik.**
  - **The OFF banner.**

### AdminAffiliateAnalytics (`/admin/affiliates/analytics`)
- **Removed:**
  - **"Trafikkällor"**, a source guessed from the socials.
  - The **"Topprestanda"** top-5 card.
  - The **"Verify"** column and the "Earnings Verification" panels (A13).
  - The columns Trafikkälla and Obetalt.
  - The period option "7 dagar". The sort option "Konverteringsgrad".
- **Changed:**
  - The period is now **real** (30 / 90 / 1 år, sent as `since`).
  - Metrics: **Klick, Konverteringar, Konverteringsgrad, Provision, Obetald provision, Aktiva affiliates**.
  - There is one table, **"Topplista"**, sortable by Konverteringar / Provision / Klick.

### AdminOrderDetail, AdminDashboard, PlatformUsers
- **Order detail:**
  - The pill "CODE" + "%" becomes **"Affiliate: CODE (länk/kod)"**.
  - A new row **"Affiliate-provision 54,00 kr"** with the ledger state (Under ångerfrist / Att betala / Återförd / Ingen provision), or **"Självköp – ingen provision"**.
  - The payment card's code is unchanged. In the admin build it already labels a discount "Rabatt (KOD)", because the API's `totals.discountCode` is `COALESCE(campaign, affiliate)` (A1 §4.4). Its "Affiliate-rabatt" fallback is reachable only in the older build.
- **Dashboard:** "Affiliate Intäkt" → **"Affiliate-provision (30 dagar)"**; "Aktiva Affiliates" → **"Aktiva affiliates"**. The older build now sums the last 30 days too, so the label holds there.
- **Platform users:**
  - A new **Administratörer | Affiliates** filter.
  - The subtitle gains ", och butikernas affiliates".
  - A new role pill "Affiliate · <shops>". The "Butiksadmins" divider is not drawn for affiliate rows.

## 2. Files

**New (mine):**
- `src/api/admin/affiliates.js` + `affiliates.test.mjs` (12 tests). Every `/v1/admin/affiliates/*` route of §4.3, X-Shop-Id, the 409/400/404/429/503 codes mapped to Swedish (`affiliateRefusalMessage`), and `downloadInvoice` (the private object read with X-Shop-Id, handed over as a blob).
- `src/admin-app/adapters/affiliate.js` + `affiliate.test.mjs` (16 tests). Form → body (`approveBodyOf`, `inviteBodyOf`, `affiliatePatchOf` sends only changed keys, `adjustmentBodyOf`, `recordPayoutBodyOf`, `invoiceFileProblem`), `orderAffiliateOf` and `sinceForDays`. Also tests the order adapter's affiliate fields and the platform user filter.
- `src/admin-app/replacements/adminAffiliateData.js`: the admin build's data module for all six pages.
- `src/pages/admin/adminAffiliateData.js`: the older build's (Firebase) module, with the pages' former inline code moved and mapped to the same shapes.
- `src/pages/admin/affiliateView.js`: pure, used by both builds. The Swedish labels, `formatMinor` / `formatSignedMinor` / `formatBp` / `formatDay`, and the layout helpers `clickSeries`, `balanceOf`, `conversionRate`, `editFormOf`, `kronorText`.
- `src/pages/admin/AdminAffiliateApplication.jsx` (new page).
- The dev API: `src/admin-app/dev/affiliates-dev.mjs` + `affiliates-fixtures.json` (invented) + `affiliates-dev.test.mjs` (6 tests).
- `docs/cf-port/shots/cp13-a2/*.png` (20 screenshots), this report.

**Modified (mine):**
- The five pages, `AdminOrderDetail.jsx`, `AdminDashboard.jsx`.
- `adminOrderDetailData.js` and its replacement (+ test), `adminDashboardData.js` and its replacement.
- `PlatformUsers.jsx`, `platformUsersData.js` (older: `ACCOUNT_FILTERS = []`), `replacements/platformUsersData.js`.
- `adapters/platformConsole.js`: users section only (`USER_FILTERS`, `accountTypesOf`, the `affiliate` flag in `userRowOf`). A4's add-on key edits in the same file are untouched.
- `AdminApp.jsx` (routes), `pages.jsx` (six lines).

**Shared files, only my lines (re-read before each edit):**
- `vite.admin.config.js`: one alias row.
- `adapters/order.js`: the `affiliate` member and `affiliateCommission` (kr), present only on an attributed order.
- `dev/dev-api.mjs`: import + two route rows.
- `dev/fixtures.json`: Test Shop A `affiliate: true`.
- `dev/platform-rest-dev.mjs`: `affiliate` admitted in `ACCOUNT_TYPES`.
- `dev/platform-rest-fixtures.json`: one invented affiliate user.

`AppLayout.jsx` is unchanged: the menu item was already gated on `affiliate`, and it rendered so.

None of my files changed under me. A3 and A4 edited other files in the same tree; their changes are not touched.

## 3. Routes (AdminApp.jsx)

| Path | Page | Gate |
|---|---|---|
| `/admin/affiliates` | AdminAffiliates | `feature: 'affiliate'` |
| `/admin/affiliates/new` | AdminAffiliateCreate (the invite) | `feature: 'affiliate'` |
| `/admin/affiliates/analytics` | AdminAffiliateAnalytics | `feature: 'affiliate'` |
| `/admin/affiliates/applications/:id` | AdminAffiliateApplication | `feature: 'affiliate'` |
| `/admin/affiliates/:id` | AdminAffiliateEdit | **not gated**; OFF banner |
| `/admin/affiliates/:id/payout` | AdminAffiliatePayout | **not gated**; OFF banner |

- With the program OFF, the detail page's back link goes to "Ordrar", because the list is gated away.
- The older build keeps its own addresses (App.jsx is not mine). The data modules export `PATHS` per build, so every link stays inside its build: `/manage/:id`, `/payout/:affiliateId`, `/application/:id`, `/create`.

## 4. The data layer (one module, same exports in both builds)

- `PATHS` and `CAPABILITIES`. CAPABILITIES is `{ ledger, adjustments, invites, payoutRequests, revoke }`; in the older build `ledger`, `adjustments`, `invites` and `payoutRequests` are false and their cards leave. `PERIODS` is `[30, 90, 365]`.
- `loadAffiliatesOverview(shopId)` → `{ applications, moreApplications, affiliates, nextCursor, kpis: { pending, clicks, conversions, accruedMinor, currency } }`. Three calls: pending applications (limit 100), the first page of affiliates (50), and analytics since 30 days. `accruedMinor` is `analytics.unpaidMinor`.
- `loadMoreAffiliates(shopId, cursor)`; `testLinkOf(shopId, row)` reads the detail and returns `links.refLink`.
- `loadApplication`; `approveApplication(shopId, application, form)` → `{ affiliateId, notice }`; `denyApplication(shopId, id, reason)`.
- `inviteAffiliate(shopId, form)` → `{ affiliateId, notice }`. `notice` is the members' "Inget mejl skickades…" when `mailConfigured === false`, or a re-send hint when `inviteError` is set.
- `loadAffiliate` (the API's AdminAffiliateDetail, or null), `loadAffiliateOrders`, `loadAffiliateLedger` and `loadAffiliatePayouts` (each paged, 50 per page).
- `saveAffiliate(shopId, affiliate, form)` (PATCH of changed keys only), `setAffiliateStatus`, `removeAffiliate` (revoke), `resendInvite`, `addAdjustment`.
- `recordPayout(shopId, id, form, payableMinor)`. An optional PDF is uploaded first as a private `document` object (`uploadObject`), then `invoiceObjectId` is sent.
- `markPayoutPaid`, `voidPayout`, `downloadInvoice`, `loadAnalytics(shopId, days)`.
- **Refusals** are thrown as an Error whose `message` is Swedish and whose `code` is the API's.
- **Money:** the pages show öre via `formatMinor` and never compute a commission, balance or payable. `recordPayoutBodyOf` compares the typed amount with the server's last `payableMinor` only to refuse early; the server decides. The conversion rate (clicks ÷ conversions) is the only derived figure.
- **Order detail** (`adminOrderDetailData.orderAffiliateOf(order)`, both builds) → `{ code, attribution, affiliateCommissionMinor, ledgerState, selfReferral, discountPercent, detailPath }`.
- **Dashboard** (replacement): `affiliateRevenue` (kr) and `activeAffiliates`, from the analytics route since 30 days, read only when `GET /v1/admin/shop` says `features.affiliate`. Otherwise null, and the tiles leave.
- **Platform users:** `ACCOUNT_FILTERS` and `loadUsers(filter)`. `'affiliate'` reads the directory with `accountType=affiliate`.

## 5. Rendered check

Staging could not be used: no network, no credentials. I ran the admin build's own dev server (`npx vite --config vite.admin.config.js --port 5193`), which serves the dev API with invented fixtures and needs no network. I added the affiliate routes to that dev API, in the Worker's shapes and with its main refusals. I drove it with gstack browse and looked at every screenshot in `docs/cf-port/shots/cp13-a2/`:

| Screens | What they show |
|---|---|
| 01, 15, 18 | The list (1440 light, 1440 dark, 375 dark) |
| 02, 08, 16, 19 | The detail: a full affiliate; a freshly approved one with the invite pill; dark; 375 |
| 03, 04, 17 | The payout page: the open request with the mark-paid form, after "Markera som betald", and the record form (dark) |
| 05, 06, 07 | Application, invite, analytics |
| 09, 10 | **The OFF banner** on detail and payout, with the flag switched off in the dev fixture. The list and the application addresses then redirected to `/admin`, and the menu item was gone. |
| 11, 13, 14 | The order-detail affiliate row and the dashboard tiles. Then the platform console's Affiliates filter, signed in as the dev platform user. |
| 12, 20 | The self-referral order, and the not-found state |

Two behaviours were exercised live:
- Approving with a taken code showed "Koden används redan…". The successful approve landed on the new affiliate's page with the "Inget mejl skickades…" notice.
- Mark-paid moved the request into Historik with its reference.

What was not looked at:
- A 5xx error state. The dev API cannot fail these routes; the error card is in the code but was not rendered.
- The invoice download. The dev API has no `/objects/:id/content` route.

**`impeccable`** (Admin-Neutral, review pass):
- The detector (`impeccable detect --json` on the six pages) found nothing.
- My review of the screenshots changed four things:
  - A blocked record form now shows only its reason, not a disabled form.
  - A self-referral's commission cell shows "–".
  - The Konto card no longer says "Kan logga in" beside "lösenord ej satt".
  - The OFF back link now goes to Ordrar.
- This was a single-context pass. The skill's full critique protocol (two isolated sub-agents, a persisted snapshot, questions to the user) was not run, because a builder cannot ask the user. The ponytail rule held: no new components, only `components/admin/ui`.

## 6. What was NOT done

- ~~**The CSV export's headers.**~~ Done in round 1 (§10, item 8). Original note: `src/utils/orderExport.js` is not in A2's list. The columns "Affiliatekod" and "Affiliatekommission (kr)" now fill in the admin build, because the order adapter passes `affiliate.code` and `affiliateCommission`. Renaming "Affiliatekommission" → "Affiliate-provision" and "Affiliaterabatt" → "Rabatt" (§7.1b) is the owner's.
- **AdminOrders (the list)** does not show the `affiliate` member. That page is not in A2's scope.
- **Applications beyond 100 pending.** The KPI says "100+"; there is no "Visa fler" for applications.
- **The older build**, a rollback artifact: it builds and maps Firestore into the new shapes. Ledger, adjustments, invite links and payout requests are switched off there, and its analytics period is not applied (Firestore keeps all-time counters, as stated in the module).

## 7. Deviations, with reasons

1. **One data module for the six pages** (`adminAffiliateData.js`, matching the brief's `adminAffiliate*Data.js`) instead of one per page. The pages share `PATHS`, `CAPABILITIES` and every call, and six pairs of files would have repeated them.
2. **`src/pages/admin/affiliateView.js`** is a new pure module. The words and formats must be the same in both builds, and the admin adapter re-exports its layout helpers.
3. **Files beyond the explicit list:**
   - `adapters/order.js`: without it, the order detail never receives the `affiliate` member.
   - The `vite.admin.config.js` alias row.
   - The dev API files, so the pages could be looked at rendered.
4. **"Referens (valfritt)"** was added to the record form (§1). The design lists four fields.
5. **Status labels:** Avstängd for `suspended`, Avslagen for a denied application, Under ångerfrist for `held`. The design names the buttons Aktiv/Inaktiv/Avstängd; I derived the rest from its vocabulary.
6. **After "Godkänn och bjud in"** the page goes to the new affiliate, not back to the list. The re-send lives on the affiliate's page if the mail failed.

## 8. Gate (rule 19), on the final tree

```
node --test src/api/*.test.mjs src/api/admin/*.test.mjs src/admin-app/**/*.test.mjs
    → # tests 1120 · # suites 316 · # pass 1120 · # fail 0
npx vite build --config vite.admin.config.js     → ✓ built
node cloudflare/admin/check-admin-build.mjs      → admin build: 28 files (22 text) checked, no Firebase code, no source map, no secret, every file servable.
node cloudflare/web/check-storefront-build.mjs   → storefront build: 11 files (7 text) checked, no Firebase code, every file servable.
npx vite build   (the older build)               → ✓ built in 9.59s
node guard/guards.test.mjs                       → guard: PASS
cd cloudflare && npx tsc --noEmit -p admin       → clean (exit 0)
```

- The guard reads tracked files only. I grepped my new, untracked files for its two name families myself and found no hit.
- The Worker vitest suite was not run, because I touched nothing in `cloudflare/`.

## 9. Reviewer wiring

1. **Corrected in round 1:** the API already sends `affiliateId` on the order views' `affiliate` member (`projections.ts` `OrderAffiliateView`, `affiliateId: row.affiliate_id`); I misread it. There is no contract gap. The adapter passes it on, the pill links to the affiliate's page, and the dev overlay now carries it too (looked at rendered, §10).
2. **Optional:** `refLink` on the list row of `GET /v1/admin/affiliates`. "Kopiera testlänk" currently costs one detail read.
3. **Optional:** a pending count on `GET /v1/admin/affiliates/applications`, so the KPI is exact beyond 100.
4. **`src/utils/orderExport.js`:** done in round 1 (§10, item 8).
5. **Commit together:**
   - The shared dev changes: `dev-api.mjs`, `fixtures.json` (Test Shop A `affiliate: true`), `platform-rest-dev.mjs`, `platform-rest-fixtures.json`.
   - My alias row in `vite.admin.config.js`.
6. **The staging look** (the design gate) is owed after deploy. These pages were looked at against the dev API only.

## 10. Round 1 fixes (review round 1: mergeable with fixes)

Working tree only, own files only. A1's `projections.ts` and `public-storefront.ts` and A3/A4's work were not touched.

### MUST

1. **Line breaks would have been a 400.**
   - **Problem:** the void reason and the record notes are textareas, but the server's `parseText` refuses every control character, including `\n`.
   - **Fix:**
     - New `oneLine()` in `adapters/affiliate.js` collapses line breaks to one space (`.replace(/\s*[\r\n]+\s*/g, ' ')`), trimmed.
     - `recordPayoutBodyOf` applies it to invoiceNumber, reference and notes.
     - The replacement's `voidPayout` and `markPayoutPaid` apply it as well.
   - **Deliberately unchanged:** the denial reason keeps its line breaks. The server's `parseMessage` admits `\n` and `\r`.
   - **Dev API:** `text()` now refuses control characters as the server does, and the denial uses the server's `parseMessage` rule.
   - **Tests:**
     - Adapter: "a textarea's line breaks are sent as one line" (a two-line note goes out as one line).
     - Data module: "the void reason's line breaks become spaces".
     - Dev: a note or void reason with `\n` is a 400; a two-line denial is a 200.

### SHOULD

2. **Orphaned invoice.**
   - **Fix:** `recordPayout` now deletes the PDF it uploaded (`deleteObject`; not frozen yet) when the record is refused for any reason (409, 400, …), then throws the Swedish refusal.
   - **Tests:** new `src/admin-app/replacements/adminAffiliateData.test.mjs`:
     - a refused record deletes the object;
     - a recorded payout keeps it;
     - with no invoice, nothing is uploaded or deleted.
3. **Dev API divergences** (`affiliates-dev.mjs`, `affiliates-fixtures.json`):
   - `conversions30d` now counts the accruals of the last 30 days.
   - list, applications, ledger, orders and payouts validate their keys, `limit` (1–100), `cursor` and `status` as the server does. A malformed query is a 400.
   - `since` follows `parseAnalyticsSince`: an ISO date or date-time, not in the future, at most 400 days back.
   - The order overlay carries `affiliateId`. The order-detail pill "Affiliate: ANNA10 (länk)" rendered as a link and led to `/admin/affiliates/af…01` (shot 21).
   - **Tests:** dev tests for the 400s and for `conversions30d`.
4. **Dark-mode links on the application page.**
   - **Problem:** `text-admin-info-text` has no `.dark` override.
   - **Fix:** the e-mail and the social links now use `text-admin-text underline underline-offset-2 hover:text-admin-text-muted`, tokens the dark overrides cover.
   - Looked at in dark mode (shot 22).
5. **Payout paging.** The detail page's "Utbetalningar" and the payout page's "Historik" now follow `nextCursor` with "Visa fler", the same pattern as orders and ledger.
6. **OFF back links.**
   - **Detail page:** the loading, not-found and error states pick their back link the same way the loaded page does. While the affiliate is unread, `useShopFeatures().isEnabled('affiliate')` decides; "Ordrar" when OFF.
   - **Payout page:** the loading and not-found states use the same rule, and the not-found button says "Tillbaka" with that target. The loaded payout page still goes back to the affiliate, which is never gated.
7. **429 copy.**
   - `affiliateRefusalMessage(error, { invite })`: `rate_limited` is "För många försök, vänta en stund." in general.
   - "För många inbjudningar…" is used only on the invite calls (approve, "Bjud in", re-send), which pass `{ invite: true }`.
   - **Tests:** an API test and a data-module test.
8. **CSV export** (`src/utils/orderExport.js`).
   - "Affiliatekommission (kr)" → **"Affiliate-provision (kr)"**. "Affiliatekod" is kept.
   - **Deviation from the review, with reason:** "Affiliaterabatt (kr)" was NOT renamed to "Rabatt". The file already has a "Rabatt (kr)" column carrying the same figure (`order.discountAmount`, any code's discount). A rename would have produced two identical "Rabatt (kr)" headers in an export meant for accounting imports. The redundant column was removed instead, header and value together. The design's intent ("it is any discount") is what "Rabatt (kr)" already says.
   - Both builds use this file.
9. **Analytics at 375 px.** The six metrics are now two MetricsBars of three (counts, then money), stacked on a phone and side by side from `lg` (shots 23 and 24).

### Not changed (per the review's NOTE)
- The "Affiliate" label beside the "Affiliate: CODE" pill: it is the design's literal copy.
- The light status pills on dark: the known darkmode backlog.

### New screenshots (`docs/cf-port/shots/cp13-a2/`)
- `21-order-detail-pill-link-1440-light.png`: the pill as a link, followed to the affiliate's page.
- `22-application-1440-dark.png`
- `23-analytics-375-dark.png`
- `24-analytics-1440-dark.png`

### Gate after round 1

```
node --test src/api/*.test.mjs src/api/admin/*.test.mjs src/admin-app/**/*.test.mjs
    → # tests 1128 · # pass 1128 · # fail 0
npx vite build --config vite.admin.config.js     → ✓ built
node cloudflare/admin/check-admin-build.mjs      → admin build: 28 files (22 text) checked, no Firebase code, no source map, no secret, every file servable.
npx vite build   (the older build)               → ✓ built in 8.62s
node guard/guards.test.mjs                       → guard: PASS
cd cloudflare && npx tsc --noEmit -p admin       → clean (exit 0)
```

My new and changed files contain no hit for the guard's two name families; checked by hand, since the guard reads tracked files only.
