# Affiliate program: specification of the live Firebase implementation

**Status:** written in CP0, before the Firebase affiliate code is retired.
**Owner decision (Mikael, 2026-09-26):** "will be reinstated later, keep and document before deleting". The plan classifies the affiliate program as PORT-LATER with this spec as its source (`docs/cf-port/PLAN.md:106`).
**Line references** point at branch `cf-port`, commit `e24f17a`. None of the affiliate sources changed between the inventory snapshot `a497d32` and `e24f17a`.
**Purpose of this document.** It records what the code actually does today, including the bugs, so that a Cloudflare rebuild can decide what to keep. It is not a design. Where the code and its own comments disagree, the code wins and the disagreement is noted.

---

## 0. Summary

- A shop runs an affiliate (creator/ambassador) program. People apply on the storefront. The shop admin approves them. Each affiliate gets a code, a `?ref=CODE` link, a checkout discount for buyers (default 10%), and a commission on paid orders (default 15% of the net product value). Commission accrues to a ledger balance on the affiliate doc, and the shop pays it out by hand against an uploaded invoice PDF.
- Everything is tenant-scoped by `shopId` and gated by the per-shop add-on flag `shops/{id}.features.affiliate`, which is **default-ON** (`functions/src/config/shopFeatures.ts:22,42-44`, `src/config/addons.js:52-60`).
- There are two campaign layers. The **"Rabattkoder" `discountCodes` add-on** is separate and alive; affiliate codes beat it on a string collision. The **B8shield-era `campaigns` revenue-share layer** is mostly dead: its per-item path is hard-wired off, and it still names KAJJAN/EMMA (§7).
- **One live security defect was found while writing this spec (§8.1):** `approveAffiliate` overwrites the password of any existing Firebase Auth account whose email is on the application, and stores the new password in plaintext on a doc the approving shop admin can read. Any shop admin can use it to take over any account in the project, including a platform super-admin. This is live in production today and does not wait for the port.

---

## 1. Purpose and actors

| Actor | Identity today | What they do |
|---|---|---|
| **Shop admin** | `users/{uid}` with `role=='admin'` and `shopId` (rules helper `isAdminOfShop`, `firestore.rules:73-76`) | Reviews applications, approves or denies them, creates affiliates by hand, edits commission/discount/code/status, sends credentials, views analytics, records payouts with an invoice PDF (§6.1). |
| **Affiliate** | A Firebase Auth account whose uid is normally the doc id of `affiliates/{uid}` (`approveAffiliate.ts:131,166`). No `users/{uid}` doc is written for them, so the rules' `isActiveUser()` is always false for an affiliate (`firestore.rules:62-64`). The portal finds them by `shopId + email + status=='active'` (`AffiliatePortal.jsx:186`). Firebase Auth emails are global, so **one person can be an affiliate of only one shop** (§8.1). | Logs in at the global `/affiliate-login` and is meant to use the per-shop portal `/:shopId/affiliate-portal` and share `?ref=` links. Most of the portal does not work for them today (§6.2). |
| **Applicant** | Anonymous | Submits the public form `/:shopId/affiliate-registration`, which writes `affiliateApplications` (rule: anyone may create, `firestore.rules:613-615`). |
| **Buyer** | Anonymous storefront visitor | Arrives via `?ref=CODE`. The code is kept 30 days in `localStorage` and auto-applied as a cart discount. The buyer pays the discounted total. |
| **Platform** | `users/{uid}.platform==true` | Toggles `features.affiliate` per shop (`src/config/addons.js:25`). As a super-admin, bypasses every shop scope (`isAdminOfShop`, `requireAdminOfShop` `authGuard.ts:78-90`). Receives the admin notification mail only when a shop has no notification address (§5). The platform takes no share of affiliate money: the Connect application fee is independent of the affiliate commission (`stripeWebhook.ts:373-375`). |

The program comes from the B8shield ambassador program. The default commission of 15 and the special-edition revenue share date from that era (`docs/cf-port/INVENTORY_FUNCTIONS.md` §1.6 item 1).

---

## 2. Data model

All collections live in the named Firestore DB `b8s-reseller-db`. Money is **SEK as JS floats, VAT-inclusive** unless noted (`createPaymentIntent.ts:24-29`; the webhook uses `parseFloat` on the PI metadata, `stripeWebhook.ts:449-453`).

### 2.1 `affiliateApplications/{autoId}`: pending applications

| Field | Type | Written by | Notes |
|---|---|---|---|
| `shopId` | string | storefront via `withShopId` (`AffiliateRegistration.jsx:65`) | Taken from the URL shop. **The rules do not validate it** (§8). |
| `name`, `email` | string | storefront | `email` is the only field the rules check: `is string && size() < 200` (`firestore.rules:614-615`). |
| `phone`, `address`, `postalCode`, `city`, `country` (default `'SE'`), `socials{website,instagram,youtube,facebook,tiktok}` (URL inputs), `promotionMethod` (required: blog/youtube/instagram/facebook/tiktok/forum/other), `message`, `preferredLang` (required: sv-SE/en-GB/en-US) | strings / map | storefront (`AffiliateRegistration.jsx:17-35`) | Full form spec in §6.2. |
| `status` | `'pending'` | storefront (`AffiliateRegistration.jsx:66-68`) | `sendAffiliateApplicationEmails` requires `'pending'` (`sendAffiliateApplicationEmails.ts:56-58`). Admin lists query `status=='pending'` (`AdminAffiliates.jsx:67`). The rules do not enforce it. |
| `createdAt` | server timestamp | storefront (`AffiliateRegistration.jsx:68`) | Nothing records consent, terms or privacy acceptance, and no terms version (§6.2). |
| `confirmationEmailsSentAt` | server timestamp | `sendAffiliateApplicationEmails` | Single-shot claim for the confirmation mails (`:62-68`), released again if the applicant mail fails (`:101-111`). |

**Lifecycle:** created → **deleted** on approve (`approveAffiliate.ts:212`) or on deny (`AdminAffiliates.jsx:110`, `AdminAffiliateEdit.jsx:360`). Nothing records who denied an application or why. The `approved` and `denied` labels in `AdminAffiliates.jsx:26-41` are never written.

### 2.2 `affiliates/{id}`: the affiliate record and ledger

Doc id = the affiliate's Firebase Auth uid when created through approval (`approveAffiliate.ts:166`). It is an **auto-id with no Auth account** when created by hand (`AdminAffiliateCreate.jsx:78,107-109`); see §7 for why that path is half-built.

| Field | Type | Default / source | Writers | Read by |
|---|---|---|---|---|
| `id` | string | = doc id | approve (`approveAffiliate.ts:131`), manual create (`AdminAffiliateCreate.jsx:107-109`) | admin UI |
| `shopId` | string | from application (`approveAffiliate.ts:134`) or admin context (`AdminAffiliateCreate.jsx:78`, `withShopId`) | create only (`tenantUnchanged()`, `firestore.rules:600`) | every query |
| `affiliateCode` | string, UPPERCASE | approve: `name[0..3].toUpperCase() + 6 random base36 chars uppercased` (`approveAffiliate.ts:125`); manual create: `FIRSTNAME-###` (`AdminAffiliateCreate.jsx:47-51`); admin edit: a custom code of 3–20 chars `[A-Z0-9-]`, not reserved, unique in the shop (checked client-side, `affiliateCalculations.js:122-174`; applied at `AdminAffiliateEdit.jsx:373-381,418-420`) | approve, create, edit | checkout, click logging, order completion |
| `name`, `email`, `phone`, `address`, `postalCode`, `city`, `country` (default `'SE'`), `socials{…}`, `promotionMethod`, `message`, `preferredLang` (default `'sv-SE'`) | strings | from application; payload overrides allowed (`approveAffiliate.ts:136-149`) | approve, create, edit (`AdminAffiliateEdit.jsx:385-414`) | admin UI, portal, mails |
| `status` | `'active' \| 'inactive' \| 'suspended'` (`'pending'` appears in types only, `affiliate/types.ts:27`) | approve → `active` (`:146`); manual create → `inactive` (`AdminAffiliateCreate.jsx:91`) | edit; toggle cycle active→suspended→inactive→active (`AdminAffiliateEdit.jsx:453-480`) | Only `status=='active'` validates, discounts, logs clicks or earns (`validateDiscountCode.ts:47`, `createPaymentIntent.ts:255`, `logAffiliateClick.ts:42`, `order-processing/functions.ts:665`). |
| `commissionRate` | number, **whole percent** | **15** (`approveAffiliate.ts:147`; `AdminAffiliateCreate.jsx:32,92`); the formula also falls back to 15 (`order-processing/functions.ts:371`) | edit (`AdminAffiliateEdit.jsx:387`) | commission |
| `checkoutDiscount` | number, **whole percent** | **10** (`approveAffiliate.ts:148`, overridable in the approve payload; `AdminAffiliateCreate.jsx:33,93`) | edit (`AdminAffiliateEdit.jsx:388`) | checkout discount |
| `stats.clicks` | int | 0 | `logAffiliateClickV2` `increment(1)` (`logAffiliateClick.ts:77-79`) | admin + portal |
| `stats.conversions` | int | 0 | +1 on award (`order-processing/functions.ts:741`); −1 on reversal (`commissionReversal.ts:58`) | |
| `stats.totalEarnings` | SEK float | 0 | +commission on award (`:742`); −commission on reversal (`commissionReversal.ts:57`) | |
| `stats.balance` | SEK float, **the payable ledger** | 0 | +commission (`:743`); −commission on reversal (`commissionReversal.ts:56`); −payout (`affiliatePayouts.js:132`) | payout form, lists |
| `stats.totalPaidOut`, `stats.lastPayoutDate`, `stats.payoutCount` | SEK float / Timestamp / int | absent until the first payout | payout transaction (`affiliatePayouts.js:130-136`) | |
| `firebaseAuthUid` | string | approve only (`approveAffiliate.ts:156`) | | `AdminAffiliateEdit.jsx:508` decides whether "send credentials" mints a password |
| `credentialsSent`, `credentialsSentAt`, `credentialsSentBy` | bool / Date / uid | false / null / null → set after the welcome mail succeeds (`approveAffiliate.ts:157-159,203-207`) | | `AdminAffiliateEdit.jsx:602-610` |
| **`temporaryPassword`** | **plaintext string** | approve (`approveAffiliate.ts:160`) | **never cleared** (no other writer: `grep temporaryPassword`) | readable by the shop admin and by the affiliate (§8.1) |
| `requiresPasswordChange` | bool | true (`approveAffiliate.ts:161`) | never cleared | |
| `createdAt`, `updatedAt` | Date / serverTimestamp / ISO string, **mixed types** (the toggle writes an ISO string, `AdminAffiliateEdit.jsx:480`) | | | lists are ordered by `createdAt` (`AdminAffiliates.jsx:73`) |

**Invariants the code intends (none enforced by a unique index):**
- `(shopId, affiliateCode)` is unique. Only the admin edit path checks this, client-side and without a transaction (`affiliateCalculations.js:155-167`). Approval (`approveAffiliate.ts:125`) and manual create (`AdminAffiliateCreate.jsx:66`) do not check at all.
- Codes are stored uppercase and every lookup uppercases the input: `normalizeAffiliateCode` = trim + toUpperCase (`affiliateCalculations.js:92-97`), `validateDiscountCode.ts:24`, `createPaymentIntent.ts:254`. **Exception:** click logging sends the raw `?ref=` value (§3.3).
- `balance = Σ awarded commission − Σ reversed − Σ paid out`. Nothing reconciles it. The "verify" helpers only log a discrepancy (`affiliatePayouts.js:72-88`, `AdminAffiliateAnalytics.jsx:189-260`).

### 2.3 `affiliateClicks/{autoId}`: click log (server-written)

Written only by `logAffiliateClickV2` (`logAffiliateClick.ts:64-74`). Client create is denied (`firestore.rules:607`).

| Field | Value |
|---|---|
| `affiliateCode` | **raw** request value, not normalized (`:65`) |
| `affiliateId` | matched affiliate doc id |
| `shopId` | the **affiliate's** shopId (`:53`), not the storefront's |
| `campaignCode` | `?campaign=` value or null |
| `timestamp` | `Timestamp.now()` |
| `ipAddress` | `rawRequest.ip` (`:70`): **personal data, stored indefinitely** |
| `userAgent`, `landingPage` (= the `Referer` header) | strings |
| `converted` | false → true on commission award |
| `orderId`, `commissionAmount` | set on award (`order-processing/functions.ts:793-803`) |

Nothing deletes or expires click docs. No TTL policy exists in the repo.

### 2.4 `affiliatePayouts/{autoId}` and the invoice files

Written client-side by the shop admin inside a Firestore transaction (`affiliatePayouts.js:90-149`):
`{ shopId, affiliateId, affiliateCode, payoutAmount (SEK float), invoiceNumber (3–50 chars, affiliatePayouts.js:244-258), invoiceUrl (Storage download URL), invoiceFileName, payoutDate, notes, processedBy (admin uid), status: 'completed', createdAt, updatedAt }` (`:109-122,127`).
`status` is only ever `'completed'`. There is no pending, approved or failed state (§3.7).

Invoice PDF: Storage path `affiliates/{shopId}/{affiliateId}/invoices/invoice_{invoiceNumber}_{ts}.pdf` (`affiliatePayouts.js:47-50`). PDF only, max 10 MB on the client (`:37-44`), 25 MB in the rule (`storage.rules:271-279`). A read-only legacy flat path `affiliates/{affiliateId}/invoices/*` exists (`storage.rules:281-287`).

### 2.5 Fields the affiliate path writes onto `orders/{piId}`

| Field | Writer | Meaning |
|---|---|---|
| `affiliate: { code, discountPercentage, clickId } \| null` | webhook, from PI metadata (`stripeWebhook.ts:481-486`) | Attribution. Set **only** when the PI metadata has `affiliateCode`, which the client sends only with a logged click id (§3.4). |
| `discountAmount` (SEK) | webhook (`:452`) | The amount of whichever discount applied. |
| `discount: { source:'campaign', code, codeId }` | webhook, campaign codes only (`:492-498`) | Present means the discount was a Rabattkoder code. |
| `affiliateId`, `affiliateCommission` (SEK), `conversionProcessed`, `conversionProcessedAt` | `processOrderCompletion` (`order-processing/functions.ts:748-753,766`) | The award. |
| `campaignId`, `campaignName`, `campaignShare`, `campaignCommissionBreakdown` | same (`:756-764`) | Only when a `campaigns` doc matched (§2.6). |
| `attributionMethod` | same (`:805-816`) | `'server'` when a clickId existed, else `'cookie'`, else `'discount'`. |
| `affiliateSelfReferralBlocked: true` | same (`:688`) | The buyer email equalled the affiliate email. |
| `completionProcessed`, `completionProcessedAt` | same (`:511-520`) | The idempotency claim for the whole completion engine, not only the affiliate part. |
| `commissionReversed`, `commissionReversedAt` | `reverseAffiliateCommissionOnCancel` (`commissionReversal.ts:62-65`) | Once-only reversal marker. |

Orders have `allow get: if true` (`firestore.rules:476`). The guest confirmation page can therefore read `affiliateCommission`, `affiliateId` and any campaign split.

### 2.6 `campaigns`, `campaignParticipants`, `campaignRevenueTracking` (B8shield revenue-share layer)

*(Field-level detail from the campaign wagon is in §6.3.)* What the backend reads from `campaigns/{id}` (`order-processing/functions.ts:150-184,193-270,330-362`):
`shopId`, `status=='active'`, `startDate`/`endDate` (Timestamp or date string), `selectedAffiliates` (`'selected'` → `affiliateIds[]` must contain the affiliate), `applicableProducts` (`'selected'` → `productIds[]`), `code` (optional), `isRevenueShare` (bool), `revenueShareRate` (percent, default 50), `name['sv-SE']`. Click logging bumps `totalClicks` (`logAffiliateClick.ts:82-102`). The award bumps `totalConversions` and `totalRevenue` (`:773-777`), and the dead universal path would also bump `totalCampaignShare` (`:234-238`).

- `campaignParticipants/{autoId}`: `{ shopId, campaignId, orderId, affiliateId, affiliateCode, campaignShare, orderTotal, participatedAt }` (`order-processing/functions.ts:780-789`). Written only when the campaign share is > 0.
- `campaignRevenueTracking/{autoId}`: per-item revenue split (`:241-259`). Written **only** by the dead universal path (§7.1).
- Both are server-only. They have no rules and fall through to default deny (`firestore.rules:14-17,875-881`). `campaigns` is admin-of-shop CRUD (`firestore.rules:674-679`).

### 2.7 Client-side attribution state (browser)

| Key | Storage | Shape | Writer |
|---|---|---|---|
| `b8s_affiliate_ref` | `localStorage`, **one global key for all shops on the origin** | `{ code (normalized), expiry (ms epoch, now+30d), campaign \| null, clickId? }` | `AffiliateTracker.jsx:77-84,98-101` |
| `b8shield_cart_{shopId}` | `localStorage`, per shop | cart incl. `discountCode`, `discountAmount`, `discountPercentage`, `affiliateClickId`, `discountSource` (`'link' \| 'manual' \| 'campaign' \| null`) | `CartContext.jsx:27-36,536-544` |

A legacy `sessionStorage` copy of `b8s_affiliate_ref` is deleted on sight (`AffiliateTracker.jsx:35-39`).

### 2.8 The add-on flag

`shops/{shopId}.features.affiliate`. Default-ON: enabled unless it is literally `false`. It fails OPEN on a read error (`shopFeatures.ts:33-49`). The client uses the same semantics (`src/config/addons.js:59-60`). Behaviour when OFF (decision locked 2026-06-16, `OBSOLETE/docs/P4_5B_AFFILIATE_ENFORCEMENT_PLAN.md:61-62`): **stop new activity, keep the data**. That means no clicks, no discounts, no awards, no approvals and hidden UI, while payouts stay possible.

---

## 3. Lifecycle

### 3.1 Application
1. The applicant fills in `/:shopId/affiliate-registration` (route gated by `AddonGate feature="affiliate"`, `App.jsx:381`). The client `addDoc`s `affiliateApplications` with `withShopId` (`AffiliateRegistration.jsx:65`).
2. The client then calls `sendAffiliateApplicationEmails({applicationId})` (`AffiliateRegistration.jsx:76`). The server loads the doc, which is the only source for recipient and content (P1-01 hardening, `sendAffiliateApplicationEmails.ts:3-9,45-58`). It rate-limits 10/h per IP (`:41`), claims single-shot (`:62-68`), mails the applicant (`:86-99`), then the shop admins (`:114-128`). A failed admin mail is ignored (`:130-133`).

### 3.2 Approval and code issuance
**Path A: approve an application** (`approveAffiliate` callable, `approveAffiliate.ts:33-235`; callers `AdminAffiliates.jsx:89` and `AdminAffiliateEdit.jsx:333`):
1. `requireAuth`, then `requireAdminOfShop(application.shopId)` (`:51,88`). The add-on must be ON (`:93-95`).
2. Temp password `Math.random().toString(36).substring(2,15)` (`:99`).
3. `auth.createUser({email, password, displayName, emailVerified:true})`. **If the email already exists, it fetches that account and overwrites its password** (`:103-122`). See §8.1.
4. Code = first 3 letters of the name + 6 random chars, uppercase, **not checked for uniqueness** (`:125`).
5. `affiliates/{uid}.set(...)` (full overwrite, not a merge) with `status:'active'`, `commissionRate:15`, `checkoutDiscount: payload || 10`, zeroed stats and the plaintext `temporaryPassword` (`:130-166`).
6. The `AFFILIATE_WELCOME` mail goes out **without a `shopId`**, so it is sent under the platform brand (`:173-194`). On success it stamps `credentialsSent*` (`:203-207`). A failed mail does not fail the approval.
7. The application doc is deleted (`:212`).
Not transactional: a crash after step 3 leaves an Auth account with a changed password and no affiliate doc.

**Path B: create by hand** (`AdminAffiliateCreate.jsx:53-118`): a client `addDoc` with `status:'inactive'`, code `FIRSTNAME-###`, **no Auth account and no mail**. The admin can later press "send credentials", which mails a client-invented password that is never set anywhere (§7.4).

**Editing** (`AdminAffiliateEdit.jsx:368-433`): the admin can change the rate, discount, status, language, contact data, socials and code (validated, §2.2). A code change strands every existing `?ref=` link, `b8s_affiliate_ref` value and click doc under the old code. Nothing aliases the old code.

### 3.3 Click attribution
- **Capture** (`AffiliateTracker.jsx`, mounted app-wide in every app mode, `App.jsx:255`): when `features.affiliate` is ON (`:22`) and the URL has `?ref=CODE` (optionally `&campaign=X`) (`:25-29`):
  - **Last ref wins.** A different code replaces the stored one and clears the cart's discount fields (`:51-71,76`).
  - It stores `{code: normalized, expiry: now+30 days, campaign}` in `localStorage` (`:77-84`).
  - It calls `logAffiliateClickV2({affiliateCode: refCode, campaignCode})` with the **raw, un-normalized** code (`:91-95`) and saves the returned `clickId` (`:98-101`).
  - It dispatches a synthetic `storage` event so the cart re-applies the code (`:110-114`).
- **Server** (`logAffiliateClick.ts`):
  - Rate limit 240/h per IP. Over the limit, it returns success with an empty clickId (`:35-37`).
  - It finds the affiliate by `affiliateCode == raw && status=='active'`, **without scoping to a shop** (`:41-43`). The first match wins (`:49`).
  - The shop comes from the affiliate (`:53`). The add-on gate uses that shop (`:58-61`).
  - It writes the click (`:64-74`) and increments `stats.clicks` (`:77-79`). With a campaign code, it bumps the campaign's `totalClicks`, scoped to the shop (`:82-102`).
- **TTL:** 30 days from the last `?ref=` visit (`AffiliateTracker.jsx:78`). It is checked when the cart applies the code; an expired ref is deleted and a link-applied discount is removed (`CartContext.jsx:172-186`).
- **Consent (MFL/GDPR as implemented): none.**
  - The code comments say: *"Always use localStorage for affiliate tracking (business-critical attribution). This is not subject to cookie consent as it's legitimate business interest"* (`AffiliateTracker.jsx:73-74`).
  - Cookiebot is mounted in shop mode (`App.jsx:250`). Its consent handler is a `console.log` placeholder (`src/components/shop/CookiebotCMP.jsx:15-21`), and **no code reads `Cookiebot.consent`** before the `localStorage` write or the click call.
  - The server logs IP, UA and referer with no retention limit (§2.3).
  - The privacy-policy template has no affiliate, referral or `localStorage` section. §9 Cookies is generic (`src/config/legalTemplates.js:379-382`, mirrored in `docs/legal-template-files/03-integritetspolicy.md:92-95`).
  - Nothing addresses the marketing-law side (MFL advertising identification by the affiliate). There are no affiliate terms, no acceptance at application, and no disclosure duty is communicated (§6.2).

### 3.4 Discount at checkout
- **Client** (`CartContext.jsx`):
  - An effect on `[cart.items]` (`:163-217`) auto-applies the stored ref code whenever it differs from the cart's code (`:174-177`, `source:'link'`). **It overrides any manually entered code, including a campaign code, on the next cart change.**
  - Without a stored ref, a `'link'` or legacy discount is cleared, while `'manual'` and `'campaign'` codes are kept (`:203-209`).
  - `applyDiscountCode` (`:426-558`): if both `affiliate` and `discountCodes` are OFF, it clears and refuses (`:433-440`). Otherwise it normalizes and calls `validateDiscountCode({code, shopId})` (`:442-453`).
  - Affiliate branch: `discountAmount = Math.ceil(subtotal × checkoutDiscount/100)`, which rounds **up to whole kronor** in the buyer's favour (`:516-521`). It copies the `clickId` from `b8s_affiliate_ref` into the cart (`:523-534`) and records `discountSource = options.source || 'manual'` (`:543`).
  - The discount base is the **whole item subtotal**. Shipping is never discounted (total = subtotal − discount + shipping, `:396-399`).
- **Server** (authoritative, `createPaymentIntent.ts:217-349`): the code is `discountInfo.code || affiliateInfo.code` (`:590`). If `features.affiliate` is ON, it looks up `affiliates where shopId==shop && affiliateCode==CODE && status=='active'` (`:251-258`) and computes the **same `Math.ceil`** (`:259-262`). The Stripe amount is `Math.round(total×100)` öre (`:606`). Client/server parity is an invariant (`OBSOLETE/docs/P4_5B_AFFILIATE_ENFORCEMENT_PLAN.md:8-15`).
- **Carrying attribution to the order.** The client sends `affiliateInfo {code: discountCode, clickId}` **only if the cart has an `affiliateClickId`** (`StripePaymentForm.jsx:376-381`). The server copies `affiliateInfo` to PI metadata **without validating it** (`createPaymentIntent.ts:900-904`). The webhook turns it into `order.affiliate` (`stripeWebhook.ts:481-486`). The consequences:
  - An affiliate code typed by hand with no prior logged click gives the buyer the discount, but **the affiliate earns nothing**, because no clickId means no `affiliateInfo`, so no `order.affiliate`, so no commission.
  - Any click-logging failure has the same effect: a rate limit, a case mismatch (§3.3) or an unscoped code collision.
  - A buyer who clicked affiliate A's link and then types affiliate B's code sends B's code with **A's** clickId. B earns the commission and A's click doc is marked converted (`order-processing/functions.ts:793-803`). The auto-apply effect then flips the cart back to A on the next cart change.

### 3.5 Commission on a paid order
- **Trigger:** `payment_intent.succeeded` (`stripeWebhook.ts:270`) creates the order at status `'confirmed'` (`:403`). It then calls `processOrderCompletion(orderId)` directly (`:683-705`). The unauthenticated HTTP twin `processB2COrderCompletionHttpV2` exists but has no caller (`order-processing/functions.ts:410-476`, INVENTORY §2.6).
- **Idempotency:** a transaction claims `completionProcessed` before any side effect (`:511-525`). Emails come next (`:556-631`). Then the dead universal campaign pass runs (`:633-636`), and then the affiliate block (`:638-820`).
- **Preconditions** (each exits without an award):
  - An affiliate code is on the order (`orderData.affiliateCode || orderData.affiliate?.code`, `:534`) and the order's shop has the add-on ON (`:644-653`).
  - An active affiliate with that code exists **in the order's shop** (`:660-672`), and its shopId matches (defence in depth, `:678-681`).
  - The buyer email is not the affiliate email, case-insensitive. On a match it stamps `affiliateSelfReferralBlocked` and exits. **The buyer keeps the discount** (`:683-690`).
- **Standard formula** (`calculateCommission`, `:365-405`; mirrored for display in `src/utils/affiliateCalculations.js:16-54`):
  ```
  rate         = (campaignRate || affiliate.commissionRate || 15) / 100      // campaignRate is never passed
  base_incVAT  = max(0, order.total − order.shipping)                         // total is already net of the discount
  base_exVAT   = base_incVAT / (1 + vatRate)                                  // vatRate = env VAT_RATE, default 0.25 (config/app-urls.ts:77)
  commission   = round(base_exVAT × rate × 100) / 100                         // rounded to öre, half-up via Math.round
  ```
  - **Base:** the amount the buyer paid, minus shipping, minus VAT at a single global rate. The affiliate's own buyer discount therefore reduces the base (`:373-375`).
  - **VAT treatment:** VAT is always removed at 25% (or the env override). The shop's own `vatRegistered` status (legal readiness gate, `createPaymentIntent.ts:52-65`) and per-product VAT rates are ignored.
  - **Worked example:** cart 500 kr, 10% affiliate discount (50 kr), shipping 29 kr. Total 479 → base (479−29)/1.25 = 360 → commission at 15% = **54.00 kr**.
- **Revenue-share campaign formula** (`calculateComplexCommission`, `:330-362`), used when an active matching campaign has `isRevenueShare` (`:721-730`):
  - The affiliate part uses the same base but falls back to **20%**, not 15, when the rate is missing (`:339`).
  - `campaignShare = round((base_exVAT − affiliateCommission) × revenueShareRate/100)`, with the rate defaulting to 50% (`:349-352`).
  - The campaign share is only recorded (§2.6). No money moves.
- **Writes** (after the claim, **as separate, non-transactional writes**):
  - Affiliate stats +1 / +commission / +commission (`:740-744`).
  - Order award fields (`:748-766`).
  - Campaign stats and `campaignParticipants` when the share is > 0 (`:771-790`).
  - Click doc `converted/orderId/commissionAmount` (`:793-803`). The clickId comes unvalidated from the client, and a missing doc throws.
  - `attributionMethod` (`:805-816`).
- **Failure semantics:** the claim is already committed, so any throw after it loses the rest for good. The webhook swallows the error (`stripeWebhook.ts:696-705`). A crash between the stats write and the order write credits the balance, but the order carries no `affiliateCommission`, so a later cancel **cannot reverse it** (`commissionReversal.ts:39`).

### 3.6 Reversal (policy: full refund or cancel only)
- **Trigger:** `reverseAffiliateCommissionOnCancel`, `onDocumentUpdated orders/{id}` (`commissionReversal.ts:22-29`). It fires when the status moves **into** `cancelled` or `refunded` from anything else (`:20,34-38`), and only if the order has `affiliateId` and a truthy `affiliateCommission` and is not yet `commissionReversed` (`:39`).
- **Effect:** one transaction applies `balance −= c`, `totalEarnings −= c`, `conversions −= 1` (skipped if the affiliate doc is gone) and stamps `commissionReversed` (`:47-66`). A throw rethrows, so the trigger retries (`:68-71`).
- **Deliberately not gated on the add-on flag.** The rule is "reverse iff awarded" (`:6-13`). This contradicts the 2026-06-16 plan decision Q3 (`OBSOLETE/docs/P4_5B_AFFILIATE_ENFORCEMENT_PLAN.md:64`) and the stale comment at `order-processing/functions.ts:640-643`. The code comment's reasoning holds, and a rebuild should keep "reverse iff awarded".
- **Policy as implemented:**
  - A **full refund** via `refundOrder` sets `refunded` → the commission reverses (`connectRefund.ts:14-19,99-104`).
  - A **partial refund** sets `partially_refunded`, and the **commission is kept in full** (`connectParams.ts:284-293`).
  - A **cancel** by the shop admin (client status write `cancelled`, allowed by `firestore.rules:504-516`; `OrderContext.jsx:746-871`) reverses the commission even though no money moved.
  - Not covered:
    - **Refunds issued in the Stripe dashboard.** The webhook has no `charge.refunded` handler (`stripeWebhook.ts:270,718,740,793,844`), so the status never changes and nothing reverses.
    - **Lost disputes.** The webhook only stamps `disputeStatus` (`:793-870`).
    - **Un-cancelling.** `cancelled → confirmed` does not re-award, and `commissionReversed` stays true.
  - If the commission was already paid out, the balance goes **negative**. That is an implicit claw-back against future earnings, and the next payout is blocked until the balance is positive again (`affiliatePayouts.js:104-106`).

### 3.7 Payout (manual ledger)
- There is no payout rail and no Stripe transfer. The shop pays the affiliate outside the system (bank transfer or Swish) against the **affiliate's invoice to the shop**, then records it (`AdminAffiliatePayout.jsx`).
- **Form:** the amount is pre-filled with the current balance (`:54-56`). It must be > 0 and ≤ the balance (`:69-78`). An invoice number (3–50 chars) and an invoice PDF of at most 10 MB are required (`:80-92`).
- **Submit** (`:117-140` → `affiliatePayouts.js`):
  1. Upload the PDF first (`uploadInvoicePDF`, `:34-65`). **A failure later in the flow orphans the file.**
  2. A decorative "verify balance" step recomputes the commission from orders. It uses `payoutData.commissionRate`, which is never supplied, so it falls back to 15%. It counts cancelled and reversed orders. It only warns (`:72-88`).
  3. A client transaction re-checks the amount against the balance, creates the `affiliatePayouts` doc with `status:'completed'`, and rewrites the whole `stats` map with `balance −= amount`, `totalPaidOut += amount`, `lastPayoutDate`, `payoutCount+1`. `totalEarnings` is unchanged (`:90-149`).
- **States:** only `completed`. There is no void or undo. Correcting a mistake means a manual doc edit (the rules allow an admin to update or delete payouts and to edit `stats` directly, `firestore.rules:597-601,620-626`).
- **Affiliate visibility:** the rules let an affiliate read their own payouts (`firestore.rules:621-622`) and their invoice files (`storage.rules:272-275`).

### 3.8 Suspension, deletion, add-on off
- `inactive` and `suspended` stop discounts, clicks and awards; every lookup filters `status=='active'`. A reversal still applies to past awards (it is not status-gated).
- **Delete** (`AdminAffiliateEdit.jsx:435-450`) removes only the `affiliates` doc. Clicks, payouts, invoices, the Auth account and order references remain. A later reversal for one of their orders silently skips the ledger (`commissionReversal.ts:54`).
- **Add-on OFF:**
  - Tracker inert (`AffiliateTracker.jsx:22`).
  - Discount ignored on both sides. The server skips the affiliate branch (`createPaymentIntent.ts:251`). The callable rejects the code (`validateDiscountCode.ts:57-59`). The client refuses outright only when `discountCodes` is also OFF (`CartContext.jsx:433-440`).
  - No click logging (`logAffiliateClick.ts:58`); no award (`order-processing/functions.ts:644`); approval refused (`approveAffiliate.ts:93`).
  - Admin routes hidden (`App.jsx:573-610`); storefront registration and portal redirect home (`App.jsx:381-382`).
  - Reversal and payouts still work.

---

## 4. Precedence with the discount-code ("Rabattkoder") add-on

1. **One code per cart.** The cart holds a single `discountCode` (`CartContext.jsx:29-36`), and the server resolves exactly one (`createPaymentIntent.ts:590`). Affiliate and campaign discounts never stack.
2. **An affiliate code wins a string collision.** Resolution order is affiliate first (only when `features.affiliate` is ON and the affiliate is `active` in this shop), then campaign code (only when `features.discountCodes` is ON) (`validateDiscountCode.ts:40-67,69-88`; server `createPaymentIntent.ts:251-273`, `discountSource === null` guard at `:273`). What happens to the same string otherwise:
   - **Inactive affiliate:** the lookup filters `status=='active'`, so the string falls through to the campaign code on both sides.
   - **Affiliate add-on OFF:** the sides disagree. The callable returns `{valid:false}` as soon as it finds the affiliate and **does not try the campaign code** (`validateDiscountCode.ts:51-59`). The server skips the affiliate branch entirely and **would** apply the campaign code (`createPaymentIntent.ts:251,273`). No parity break happens, because the client clears an invalid code and never sends it, but the campaign code is unusable in the storefront.
3. **Nothing prevents a collision at creation time.** The Rabattkoder admin only normalizes the code (`AdminDiscountCodes.jsx:141-142`), and the affiliate code check only looks at `affiliates` (`affiliateCalculations.js:155-167`). A campaign code whose string equals an active affiliate code is silently unusable.
4. **A `?ref=` link beats a typed code, in the client.** The auto-apply effect replaces any typed code with the stored ref code on the next cart change (`CartContext.jsx:174-177`). While a buyer carries a live ref, a campaign code they typed survives only until the cart changes.
5. **Attribution is separate from the discount.** A campaign code carries no affiliate attribution: the cart sets `affiliateClickId:null` (`CartContext.jsx:504`) and the order gets `discount.source='campaign'` (`stripeWebhook.ts:492-498`). The server does not verify that `affiliateInfo.code` is the code that produced the discount (`createPaymentIntent.ts:900-904`). A crafted request can therefore attribute a campaign-discounted order to an affiliate. The commission base is then the campaign-discounted total.
6. **Math is shared.** Both use `Math.ceil` for a percentage discount. An affiliate discount is a percent of the **whole subtotal**. A campaign code may be `fixed` or `percent`, scoped to `all` or selected `products`, with `minSpend` checked against the full subtotal (`createPaymentIntent.ts:290-316`, `CartContext.jsx:466-513`).
7. **The usage counter** exists for campaign codes only (`usedCount++` in the webhook, `stripeWebhook.ts:658-676`). Affiliate codes have no cap, no validity window and no minimum spend.

---

## 5. Emails

All go through `EmailOrchestrator` (Resend). The from-name is the shop name when `shopId` is passed, otherwise the platform `FROM_NAME` (`EmailOrchestrator.ts:289-291,881-897`).

| Email type | Recipient | Trigger | Brand / shop context | Content | Notes |
|---|---|---|---|---|---|
| `AFFILIATE_APPLICATION_RECEIVED` | applicant (from the application doc) | `sendAffiliateApplicationEmails`, called by the storefront right after submitting (`AffiliateRegistration.jsx:76`; `sendAffiliateApplicationEmails.ts:86-99`) | shop (`shopId: application.shopId`) | Subject "Affiliate-ansökan mottagen - {brand}" (`EmailOrchestrator.ts:624-640`). Body: application id plus the four "what happens next" steps (review in 1–3 business days, …) (`templates/affiliateApplicationReceived.ts:34-64`). | Single-shot per application. sv/en by `preferredLang`. |
| `AFFILIATE_APPLICATION_NOTIFICATION_ADMIN` | the shop's notification address, else the shop's active admins, else the platform `ADMIN_RECIPIENTS` (`EmailOrchestrator.ts:338-368`) | same call (`sendAffiliateApplicationEmails.ts:114-128`) | shop, with a "System" suffix on the from-name | Always Swedish. Subject "Ny Affiliate-ansökan: {name}" (`EmailOrchestrator.ts:642-656`). Applicant data, socials, id, button to `${B2B_PORTAL}/admin/affiliates` (`templates/affiliateApplicationNotificationAdmin.ts:53-71`). | A failure is ignored. |
| `AFFILIATE_WELCOME` | new affiliate | `approveAffiliate` (`approveAffiliate.ts:173-194`); also the callable `sendAffiliateWelcomeEmail` (no client caller, INVENTORY §2.12) | **none: platform brand** (no `shopId` passed) | Congratulations; **plaintext temp password** or, for an existing account, "log in with your existing password"; referral link; commission %; portal features; button (`templates/affiliateWelcome.ts:37-116`). | Both links **lack the shop prefix**: portal `${B2C_SHOP}/affiliate-portal` and referral `${B2C_SHOP}/?ref=CODE` (`:42-43`) (§7.5). The existing-account copy is false, because approval changed that account's password (§8.1). |
| `LOGIN_CREDENTIALS` (`accountType:'AFFILIATE'`) | affiliate | "Send credentials" in `AdminAffiliateEdit.jsx:498-537` → `sendLoginCredentialsEmail` (`sendLoginCredentialsEmail.ts:28-137`) | platform brand (no `shopId`) | Login URL `/affiliate-login`, code, referral `/?ref=` (`templates/loginCredentials.ts:42-46`). | The password it mails is never set on any account (§7.4). |
| `PASSWORD_RESET` with `userType:'AFFILIATE'` | affiliate | — | — | Would link to `/affiliate-login` (`templates/passwordReset.ts:29-30`). | **Dead branch:** no client passes `userType:'AFFILIATE'` (`grep "'AFFILIATE'" src`), so affiliates get the default B2C reset link (`sendPasswordResetEmail.ts:74,93`). |
| `ORDER_CONFIRMATION` / `ORDER_NOTIFICATION_ADMIN` | buyer / shop | the completion engine (`order-processing/functions.ts:571-609`) | shop | The discount row is labelled with the affiliate code (`templates/orderConfirmation.ts:105,163`). The admin mail gets an "Affiliate-information" panel (`templates/orderNotificationAdmin.ts:130,221-238`). | Not affiliate emails, but they carry affiliate data. |

**No email** goes to the affiliate on a conversion, a reversal or a payout. **No email** goes to the applicant on a denial; the application is simply deleted.

---

## 6. Admin and storefront surfaces

### 6.1 Shop admin (all routes wrapped in `AddonGate feature="affiliate"` + `AdminRoute`, `App.jsx:573-610`; menu item below the add-on divider, `AppLayout.jsx:222-231`)

| Route | Component | What it does |
|---|---|---|
| `/admin/affiliates` | `AdminAffiliates.jsx` | Shows three metrics: pending applications, total clicks and total conversions (`:50-57,122-126`). The pending applications table (`affiliateApplications where shopId, status=='pending'`, `:67`) supports approve, which calls `approveAffiliate` (`:86-102`), and deny, which **hard-deletes** the application (`:104-116`). The affiliates table (`affiliates where shopId orderBy createdAt desc`, `:73`) shows code, status, rate, discount, clicks, conversions, conversion rate, earnings and unpaid balance. Row actions: manage, payout (visible when balance > 0), and "test link" `${B2C_SHOP}/{lang-country}?ref=CODE`, a legacy `/se` URL (`:306`, §7.5). |
| `/admin/affiliates/create` | `AdminAffiliateCreate.jsx` | Manual create. It writes a client `addDoc` with `status:'inactive'`, the defaults 15/10 and a `FIRSTNAME-###` code, then stamps `id` (`:53-118`). It creates no login (§7.4). |
| `/admin/affiliates/application/:id` and `/admin/affiliates/manage/:id` | `AdminAffiliateEdit.jsx` (one component serves both, `:249-318`) | **Application mode:** shows the application, then approve (with an editable checkout discount, `:330-354`) or deny (delete, `:356-366`). **Affiliate mode:** stats come from `affiliates.stats`, which it treats as authoritative, plus unique clicks by IP from `affiliateClicks` (`:135-203`). Recent orders are fetched by `affiliateCode` and by `affiliate.code` with cancelled orders excluded (`:146-167`), and the table shows `affiliateCommission` per order (`:1077-1095`). Payout history (`:205-247`). Edit form covering rate, discount, status, language, custom code, contact and socials (`:368-433`). Status toggle (`:453-495`). Delete (`:435-451`). "Send credentials" (`:498-537`, §7.4). "View portal as affiliate" opens `${B2C_SHOP}/affiliate-portal?admin_code=…&admin_access=true` (`:571-590`, §7.5, §8.6). |
| `/admin/affiliates/analytics` | `AdminAffiliateAnalytics.jsx` | Program KPIs: total clicks, conversions/rate, total commission, unpaid commission, active affiliates (`:303-307`). It ranks affiliates by a selectable metric, infers each affiliate's "traffic source" from their *profile socials*, not from click data (`:67-78`), and has a per-affiliate "verify" button that compares the "old" (`total × rate`) method, the current method and the stored earnings (`:189-260`). The time-range selector has no effect on the queries (`:15,22,28-43`). |
| `/admin/affiliates/payout/:affiliateId` | `AdminAffiliatePayout.jsx` | Manual payout form with invoice upload (§3.7). |
| `/admin` dashboard | `AdminDashboard.jsx:142-176,290,316` | Sums `order.affiliateCommission` into a tile labelled "Affiliate Intäkt" (it is a commission *cost*, not revenue) and counts active affiliates. |
| `/admin/orders/:id` | `AdminOrderDetail.jsx:535-537,688-689,853-858`; `OrderPaymentCard.jsx:44,58-63` | Shows an affiliate pill and discount % on the order. The commission itself is **not shown**. The payment card labels **any** B2C discount "Affiliate-rabatt (CODE), X%", which mislabels campaign codes too. |
| `/admin/discount-codes` | `AdminDiscountCodes.jsx:141-142` | Rabattkoder admin. It reuses `normalizeAffiliateCode` but **does not check for collisions** with affiliate codes (§4). |
| Platform `/addons` | `src/config/addons.js:25`; `ProvisionShopModal.jsx:31-43` | The platform toggles `features.affiliate` per shop. **New shops are provisioned with `affiliate: true` and `campaigns: true`** (`ProvisionShopModal.jsx:32-33`). |

### 6.2 Storefront and affiliate-facing surfaces

| Route / mount | Component | What it does (and what is broken) |
|---|---|---|
| App-wide, every app mode | `AffiliateTracker.jsx` (`App.jsx:255`) | `?ref=`/`?campaign=` capture and click logging (§3.3). The stored `campaign` value is never read back. |
| `/:shopId/affiliate-registration` (ShopGate + AddonGate, `App.jsx:381`) | `AffiliateRegistration.jsx` | The form fields are listed in §2.1 (`:17-35`). `name`, `email`, `promotionMethod` and `preferredLang` are required (`:57-60`). The default language comes from the B8shield-era key `localStorage 'b8shield-language'` (`:34`). It writes the doc (`:65-69`) and calls the mail callable (`:75-83`). **A mail failure is swallowed and the user still sees success** (`:98-103`). The thank-you copy promises a decision "inom 3-5 arbetsdagar" (`:400`), while the mail says 1–3 (§5). **There is no terms or consent checkbox, no privacy text and no duplicate check.** |
| `/affiliate-login` (shopless, **no gate**, `App.jsx:349`; reserved segment `src/config/tenancy.js:64`) | `AffiliateLogin.jsx` | Embeds `CustomerLogin` (Firebase email/password, `SimpleAuthContext.jsx:75-80`). On success it navigates to `getCountryAwareUrl('affiliate-portal')` (`:87-88`), which returns **`/`, the platform landing page**, on a shopless path (`productUrls.js:136-139`). **The login never reaches the portal.** Both "Bli affiliate" links also go to `/` (`:75,96`). |
| `/:shopId/affiliate-portal` (ShopGate + AddonGate, `App.jsx:382`) | `AffiliatePortal.jsx` | Finds the affiliate by `shopId + email + status=='active'` (`:186`); an "admin view" variant uses a URL param (§8.6). An unauthenticated user is redirected to `/{shopId}/affiliate-login`, which does not exist and bounces to the shop home (`:702-705`; `DynamicRouteHandler.jsx:50`; `App.jsx:183-186`). The tabs are overview, analytics, campaigns, success guide, materials and profile (`:268-299`); none is add-on gated. |
| ↳ Overview | `AffiliatePortal.jsx:303-477` | `stats.*` counters. These are lifetime totals mislabelled "30 dagar" (`:315,327`). "Live stats" is a TODO no-op (`:261-265`). It shows the code with copy and QR, and a link built by `generateAffiliateLink` = `${B2C_SHOP}/{shopId}{/path}?ref=CODE` (`:50-52`; `productUrls.js:228-243`), the only correctly shop-prefixed link in the system. **The affiliate's commission rate and checkout discount are shown nowhere in the portal.** "Begär utbetalning" goes to a non-existent route and bounces home (`:469-474`). The portal never queries `affiliatePayouts`, so there is no payout history. |
| ↳ Analytics | `AffiliateAnalyticsTab.jsx` | Queries `affiliateClicks` and `orders` by code (`:80-112`). **Both are denied for affiliates by the rules** (`firestore.rules:605-606` admin-only; the orders `list` rule at `:479-493` has no affiliate branch), so the tab is always empty (`:141-142`). A side effect switches the site language to `preferredLang` (`:28-33`). |
| ↳ Campaigns | `AffiliatePortalCampaigns.jsx` (rendered at `AffiliatePortal.jsx:679`) | Reads `campaigns` through `useCampaigns`. **The rules deny it** (`campaigns` is admin-only, `firestore.rules:675`), which produces an error toast (`useCampaigns.js:82-87`). Per-campaign stats query `orders` and are also denied (`:70-78`). It advertises per-campaign discount and commission rates that are never applied (`:340-345,449-455`; §7.3). Link: `generateAffiliateLink(...)&campaign=CODE` (`:126-135`). |
| ↳ Success guide | `components/affiliate/AffiliateSuccessGuide.jsx` | Static fishing-era copy. Only the brand is swapped (`:21-24`); ids are `what-is-b8shield` (`:29-34`). Hard-coded terms **"20% on the net price (71.20 SEK excluding VAT)"** (`:73-74`) contradict the real default of 15%. |
| ↳ Materials | `components/AffiliateMarketingMaterials.jsx` | Reads `marketingMaterials where shopId` (`:33`). **The rules deny it for affiliates** (`isActiveUser()` needs a `users` doc, `firestore.rules:662-665`). It is not gated on the opt-in `marketingMaterials` add-on (`src/config/addons.js:43,52`). |
| ↳ Profile | `AffiliatePortal.jsx:479-633` | **`saveProfile` is a TODO that only toasts success** (`:223-226`). It reads `address1`/`address2`, which nothing writes (`:199-200` vs `approveAffiliate.ts:139`). There is no password change, and `requiresPasswordChange` is never read. |
| Shop nav + footer | `ShopNavigation.jsx:64-84,219-243,282-313`; `ShopFooter.jsx:69-98,181-212` | Queries the signed-in user's own `affiliates` doc to swap "Mitt konto" for "Affiliate Portal". Shows "Logga in som affiliate" (to the shopless `/affiliate-login`) and "Ansök som affiliate". The footer's login link resolves to `/{shopId}/affiliate-login` → shop home. |
| Cart / checkout / confirmation | `ShoppingCart.jsx:278-282`; `Checkout.jsx:1226-1230,1279-1296`; `OrderConfirmation.jsx:273-305,366-371`; `PaymentMethods.jsx:338-340` | Labels the discount "Affiliate rabatt, X%" (or the campaign label when `discountSource==='campaign'`). The confirmation page tells the buyer the order "har registrerats för affiliate-provision". |
| Other leftovers | `CustomerLogin.jsx:24,37`; `ResetPassword.jsx:159,289`; `DynamicPage.jsx:342-388` | Plain `/login` defaults to `/affiliate-portal`, which ShopGate treats as an unknown shop and renders the landing page. The reset page's "back to login" goes to `/`. An unreachable payout block contains `mailto:info@jphinnovation.se` and "Minimum utbetalningsbelopp är 100 kr" (`DynamicPage.jsx:362-363,373`). |
| Admin exports | `orderExport.js:187-189,239-241,272-274`; `orderVerification.js:438-450` | The CSV has Affiliatekod / Affiliatekommission / "Affiliaterabatt", where the last one is `discountAmount` and so mislabels campaign discounts. The verification HTML has an affiliate section. |

### 6.3 Related wagons (admin add-ons that touch the affiliate data)

Wagons are discovered by glob and mounted when the manifest says `enabled` (`src/wagons/WagonRegistry.js:66,119-128`). Their routes are wrapped in `AddonGate` on their **own** feature key, not `affiliate` (`App.jsx:681-706`; `src/config/addons.js:11-17`).

**Campaign wagon** (`src/wagons/campaign-wagon/`)
- Setup: `enabled: true` (`CampaignWagonManifest.js:8`). Flag `campaigns`, default-ON; new shops are provisioned `campaigns: true` (`ProvisionShopModal.jsx:33`).
- Routes: `/admin/campaigns`, `/create`, `/:id`, and `/:id/analytics` (a placeholder, "kommer snart", `CampaignAnalytics.jsx:40-42`) (`CampaignWagonManifest.js:36-65`).
- CRUD on `campaigns` through `useCampaigns` (shop-scoped, `useCampaigns.js:38-41,108-113,129`). Campaign code: auto-generated as lowercase slug + 4 digits (`campaignUtils.js:277-287`). Uniqueness is checked on create only, and not in a transaction.
- Fields written (defaults at `campaignUtils.js:454-520`): i18n `name`/`description`/`affiliateInfo`, `code`, `type`, `status`, `selectedAffiliates` + `affiliateIds`, `applicableProducts` + `productIds`, `customAffiliateRate` (15), `customerDiscountRate` (10), `isRevenueShare` (false), `revenueShareRate` (50), `isLottery`, `banners`, `startDate`/`endDate`, counters.
- **No UI sets `isRevenueShare`** (grep over the wagon components). The backend never reads `customAffiliateRate` or `customerDiscountRate` (§7.3).
- The status toggle turns any non-active campaign active, including completed or cancelled ones (`useCampaigns.js:195`). `createdBy` is always `'system'` because the hook reads `user` from an auth context that exposes only `currentUser` (`useCampaigns.js:29,125`).

**Ambassador wagon** (`src/wagons/ambassador-wagon/`): an influencer-recruiting CRM.
- Setup: `enabled: true` (`AmbassadorWagonManifest.js:9`). Flag `ambassador`; new shops are provisioned `false` (`ProvisionShopModal.jsx:35`).
- **Its "contacts" are `affiliates` documents.** It lists every affiliate of the shop (`useAmbassadorContacts.js:32-36`) and creates prospects as `affiliates` docs with `contactType:'ambassador', active:false, status:'prospect', category:'fishing'` (`:136-188`). Ambassador prospects therefore appear in the affiliate admin list.
- **Its delete button hard-deletes any affiliate doc, real affiliates included** (`AmbassadorContactList.jsx:508-509`, `useAmbassadorContacts.js:252`).
- "Convert" writes `status:'converted'`, a code `NAME8CHARS##`, tier-table rates (nano 10/5 … mega 25/20, `AmbassadorWagonManifest.js:208-245`) and a fake `affiliateId:'affiliate_{id}'`, but **no `status:'active'`, no Auth account and no mail** (`AmbassadorConversionCenter.jsx:134-157`). "Aktivera" sets `status:'active'` without a code (`useAmbassadorContacts.js:270-279`). Only Convert followed by Activate yields a working code, and even then there is no login.
- Activity logging writes the legacy `ambassadorContacts` collection, which the default-deny rule rejects, so `addActivity` always throws after creating the activity (`useAmbassadorActivities.js:177`). `ambassadorActivities` has no `shopId` and is platform-only (`firestore.rules:783-785`).
- The `services` in `index.js` are TODO stubs (`index.js:38-56`).

---

## 7. Dead or half-built

### 7.1 Campaign revenue share (the inventory's claim, verified exactly)
`processUniversalCampaignRevenue` (`order-processing/functions.ts:193-270`) runs on **every** completed order (`:633-636`). It is dead code by construction:
- `const specialEditionItems: any[] = [];` (`:196`), then `if (specialEditionItems.length === 0) return;` (`:198-200`). The comment says v2 order items have no `group` field and the B8Shield brand is retired (`:186-192`).
- Everything after the return is unreachable:
  - the `campaigns where shopId, status=='active', isRevenueShare==true` query (`:205-210`)
  - the per-item split (`calculateItemRevenue`, `:273-304`). It hard-codes a **20%** affiliate share ("Assume 20% commission rate", `:287-290`) and reads `orderData.discountPercentage`, which webhook orders do not have at top level (`stripeWebhook.ts:449-453`).
  - the `totalCampaignShare` bump (`:234-238`)
  - **all writes to `campaignRevenueTracking`** (`:241-259`). That collection is therefore never written.
- `shouldCampaignTrackProduct` (`:307-327`) hard-codes the B8shield creator editions: `campaignName.includes('KAJJAN') && itemName.includes('KAJJAN')` (`:312-314`), `…'EMMA'…` (`:316-318`), and the default `item.group === 'B8Shield-special-edition'` (`:326`).

### 7.2 Campaign-matched commission (reachable, but inert through the UI)
- The award path looks for any active campaign of the shop that matches (`:692-716`, `checkCampaignMatch` `:150-184`). The first match wins (`:713`).
- The `code` check in `checkCampaignMatch` compares the order's affiliate code with the affiliate code derived from **the same order** (`:177-181` vs `:534,709`), so it is always true. The `?campaign=` parameter never takes part in order matching.
- A match stamps `campaignId`/`campaignName` (`:756-758`). Money changes only if the campaign has `isRevenueShare` (`:721-730`), which no UI can set (§6.3). `campaignParticipants` (`:780-789`) and the campaign `totalConversions`/`totalRevenue` (`:773-777`) are written only when the share is > 0, so in practice they are never written.
- `calculateComplexCommission`'s 20% fallback (`:339`) differs from the standard 15% (`:371`).

### 7.3 Per-campaign rates promised but never applied
- `customAffiliateRate` and `customerDiscountRate` are edited in the campaign UI (`CampaignEdit.jsx:711-741`) and shown to affiliates as "Kundrabatt X%" and "Din provision X%" (`AffiliatePortalCampaigns.jsx:340-345,449-455`).
- The backend never reads them. `calculateCommission`'s `campaignRate` parameter (`order-processing/functions.ts:365,371`) is never passed (`:733`), and the checkout discount always comes from `affiliates.checkoutDiscount` (`createPaymentIntent.ts:259`).

### 7.4 Manual affiliate + "send credentials"
- `AdminAffiliateCreate` creates no Auth account (`:78-109`).
- "Send credentials" invents a password in the browser (`AdminAffiliateEdit.jsx:508,518`) and mails it through `sendLoginCredentialsEmail`. That callable never creates an account or sets a password (`sendLoginCredentialsEmail.ts:70-118`). **The mailed password works nowhere.**
- The result panel reads `credentialsResult.temporaryPassword`/`.isExistingUser`, which the callable never returns (`AdminAffiliateEdit.jsx:672-681` vs `sendLoginCredentialsEmail.ts:122-126`).
- A manual affiliate's doc id is not a uid, so the rules' own-uid branches for payouts and invoices (`firestore.rules:622`, `storage.rules:274`) can never match.

### 7.5 Links that go nowhere
Routes: `/` = platform landing page (`App.jsx:341`); the shopless `/affiliate-login` (`:349`); everything else is `/:shopId/...` (`:355-382`).

| Link | Where | Result |
|---|---|---|
| `${B2C_SHOP}/affiliate-portal` | welcome mail (`templates/affiliateWelcome.ts:42`) | treated as shop "affiliate-portal" → landing page (`ShopGate.jsx:82-84`) |
| `${B2C_SHOP}/?ref=CODE` | welcome mail (`:43`); credentials mail (`templates/loginCredentials.ts:46`) | platform landing page. The tracker still stores the ref, but the buyer is not in a shop. |
| `${B2C_SHOP}/se?ref=CODE` | admin "test link" (`AdminAffiliates.jsx:306`) | legacy `/se` segment |
| `${B2C_SHOP}/affiliate-portal?admin_…` | admin "view portal" (`AdminAffiliateEdit.jsx:586`) | landing page |
| post-login target | `AffiliateLogin.jsx:88` | `/` |
| `/{shopId}/affiliate-login` | portal redirect (`AffiliatePortal.jsx:704`), footer | shop home |
| `affiliates/begar-utbetalning` | portal (`AffiliatePortal.jsx:470`) | shop home |

### 7.6 Attribution that silently fails
- **Case bug.** The tracker sends the **raw** `?ref=` value to `logAffiliateClickV2` (`AffiliateTracker.jsx:93`), and the server matches it case-sensitively against uppercase codes (`logAffiliateClick.ts:42`). For a link like `?ref=anna-123`, no click is logged and no clickId is stored, so **no commission is paid**. The buyer still gets the discount, because validation uppercases.
- **Rate limiting** returns an empty clickId (`logAffiliateClick.ts:35-37`), which again means no commission.
- **Typed codes.** An affiliate code typed at checkout without a prior logged click earns no commission (§3.4, `StripePaymentForm.jsx:376`).
- **Unreachable attribution branches.** `attributionMethod` values `'cookie'` and `'discount'` cannot occur for webhook orders (`order-processing/functions.ts:805-813`), because the webhook never writes a top-level `affiliateCode` or `discountCode` (`stripeWebhook.ts:481-498`).

### 7.7 Other dead or stale pieces
- `processB2COrderCompletionHttpV2`: an unauthenticated CORS-`*` HTTP twin with no caller (`order-processing/functions.ts:410-476`; INVENTORY §2.6 → DELETE).
- `sendAffiliateWelcomeEmail`: no client caller (INVENTORY §2.12). It mails a **caller-supplied** temp password (`sendAffiliateWelcomeEmail.ts:88`).
- `PASSWORD_RESET` `userType:'AFFILIATE'` branch: never passed (§5).
- **Stale comments:** `order-processing/functions.ts:640-643` says the reversal is gated on the flag, which it is not (`commissionReversal.ts:6-13`). `App.jsx:573-576`, `src/config/addons.js:21-23` and `PlatformAddons.jsx:139-140` say storefront enforcement is "not yet", but it is enforced (§3.8).
- **"Verify" helpers:** `affiliatePayouts.js:72-88` (undefined rate → 15%, counts cancelled orders, only warns) and `AdminAffiliateAnalytics.jsx:189-260` (compares against a legacy "old method", `total × rate`). The analytics time-range select changes nothing (`:15,22`).
- **Debug leftovers:** the payout-history fallback in `AdminAffiliateEdit.jsx:214-238`, and the Checkout debug panel `showDebug`, which is never rendered (`Checkout.jsx:189-199`).
- **Unused exports:** `affiliateCalculations.js` exports `isValidAffiliateCodeFormat` (`:105-113`), `generateRandomAffiliateCode` (`:206-216`), `compareCalculations` (`:69-84`) and `validateOrderForCommission` (`:57-66`), none of them used. The reserved code list still contains `'B8SHIELD'` (`:149`).
- **Never-written statuses:** `approved`/`denied` application statuses (`AdminAffiliates.jsx:26-41`), and `'pending'` affiliate status (`affiliate/types.ts:27`).
- **Compiled leftovers** of removed functions in `functions/lib/affiliate/http/logAffiliateClickHttp.*` and `functions/lib/affiliate/triggers/processAffiliateConversion.*` (INVENTORY_FUNCTIONS.md:533-534).
- **Portal stubs** (§6.2): profile save, live stats, payout request, and "30 dagar" labels on lifetime counters.
- **Fishing copy and wrong terms** in the success guide (`AffiliateSuccessGuide.jsx:73-74`).
- **Unused campaign-wagon utilities:** `generateCampaignURL`, `doesOrderMatchCampaign`, `findMatchingCampaigns`, a client copy of `calculateComplexCommission`, and others (`campaignUtils.js:109-447`). Manifest-declared collections and banner storage were never built (`CampaignWagonManifest.js:76-142`).

---

## 8. Security and isolation notes

### 8.1 🔴 LIVE: `approveAffiliate` is an account-takeover primitive for any shop admin
**How it works.** The code is on `main`, which `cf-port` branched from. `approveAffiliate` is a live export (`functions/src/index.ts:16`; INVENTORY §2.12). The deploy state was not re-verified for this spec. The attacker only needs a shop-admin login and the victim's email address.
1. Anyone can create `affiliateApplications` with any `email` and `shopId` (`firestore.rules:613-615`). A shop admin creates one for their own shop, with the victim's email. The victim can be any Firebase Auth account in the project, **including a platform super-admin**.
2. The admin approves it. `requireAdminOfShop(application.shopId)` passes (`approveAffiliate.ts:88`), and the add-on is default-ON (`:93`).
3. `auth.createUser` fails with `auth/email-already-exists`. The function then **fetches the victim's account and sets its password to a new random value** (`approveAffiliate.ts:112-118`).
4. The new password is written in **plaintext** to `affiliates/{victimUid}.temporaryPassword` with `shopId` = the attacker's shop (`:130-166`).
5. The rules let a shop admin read any `affiliates` doc of their shop (`firestore.rules:592`). The attacker reads the password and signs in as the victim. For a platform admin, the victim's `users/{uid}` doc (`platform:true`) is untouched, so the attacker gets full platform rights.

**Side effects:**
- The victim is locked out (their old password is gone), and the welcome mail tells them to "log in with your existing password" (`templates/affiliateWelcome.ts:47-51`).
- `affiliates/{uid}.set(...)` is a full overwrite, not a merge (`approveAffiliate.ts:166`). Approving the same person in shop B **wipes their shop A affiliate record**, including its unpaid `balance`, and re-homes it to shop B. The Admin SDK bypasses the `tenantUnchanged()` rule.

**Contrast:** `createShopUser` has a deny-by-default guard for exactly this case (`createShopUser.ts:68-89`); approval has none.

**Needs Mikael's decision now, independent of the port** (§10 Q1). Options:
- add the same reuse guard
- stop storing `temporaryPassword`
- purge existing `temporaryPassword` fields from prod `affiliates` docs
- flip `features.affiliate=false` on shops that don't use it

### 8.2 Plaintext credentials at rest
`temporaryPassword` and `requiresPasswordChange` are written at approval and **never cleared** (`approveAffiliate.ts:160-161`; no other writer). Both the affiliate and the shop's admins can read them (`firestore.rules:592-596`). The password stays valid until the affiliate changes it, and there is no in-app way to change it (§6.2).

### 8.3 Open application create
`affiliateApplications` create checks only `email` (`firestore.rules:613-615`). The rule does not check:
- whether the `shopId` refers to a real shop
- a field allowlist
- field sizes, except `email`
- a rate limit on the create itself (only the mail callable is limited, `sendAffiliateApplicationEmails.ts:41`)

Anyone can therefore fill any shop's review queue.

### 8.4 Ledger integrity
- `affiliates` update is any-field for the shop admin (`firestore.rules:597-601`), so `stats.balance`, `totalEarnings` and the other counters can be edited by hand with no audit.
- Payouts are client-side transactions (`affiliatePayouts.js:90-149`); admins can update or delete payout docs (`firestore.rules:623-625`).
- Server awards and reversals are `FieldValue.increment`s on counters. Commission is a float SEK amount rounded to öre (`order-processing/functions.ts:383`). No append-only ledger exists.

### 8.5 Attribution integrity and cross-tenant writes
- **Buyer-forgeable attribution.** `affiliateInfo {code, clickId}` goes from the client into PI metadata unvalidated (`createPaymentIntent.ts:900-904`). The code is re-validated against the order's shop at award time (`order-processing/functions.ts:660-681`). The **clickId is not**: completion writes `converted/orderId/commissionAmount` into whatever `affiliateClicks/{clickId}` the buyer supplied, in any shop (`:793-803`).
- **Unscoped click lookup.** `logAffiliateClickV2` looks codes up without a shop (`logAffiliateClick.ts:41-43`), so a code that exists in two shops credits the first match's clicks.
- **Global ref key.** The `b8s_affiliate_ref` key is global across shops on the shared origin (`AffiliateTracker.jsx:84`), so shop A's ref is auto-applied to shop B's cart. Validation there fails harmlessly unless shop B has the same code.
- **Weak self-referral guard.** It is exact email equality only (`order-processing/functions.ts:683-690`).

### 8.6 Admin "view portal" by URL parameter
- The portal trusts `?admin_access=true&admin_code=X` and skips its own auth requirement (`AffiliatePortal.jsx:139-149,169,698-706`), then queries `affiliates where shopId, affiliateCode==X` (`:181-183`). It also honours a `sessionStorage 'b8s_admin_impersonation'` key that nothing writes (`:150-166,700`).
- The **rules block it** for anyone who is not an admin of that shop: a code-only list query cannot satisfy the uid or email branches (`firestore.rules:592-596`).
- The admin button is broken anyway (§7.5). The admin and shop hosts are also separate origins with separate Auth sessions.
- Do not port this pattern; use the platform impersonation mechanism instead.

### 8.7 Personal data
- **Clicks.** Click docs keep the raw IP, UA and referer forever (`logAffiliateClick.ts:70-72`), with no consent (§3.3).
- **Applications.** They hold name, address, phone and socials. They are deleted on decision (good), but nothing states a retention period.
- **Orders.** Orders have `allow get: if true` (`firestore.rules:476`), which exposes `affiliateId` and `affiliateCommission` to anyone who holds the order id.

### 8.8 Storage
- The per-shop invoice path is correctly scoped (`storage.rules:271-279`).
- The **legacy flat path** `affiliates/{affiliateId}/invoices/*` is readable by **any** admin of **any** shop (`isAdmin()` is only `token.role=='admin'`, `storage.rules:21-23,282-287`). This is a cross-tenant read of legacy invoices.

### 8.9 Rules are too tight for the affiliate role
The affiliate's own portal needs clicks, orders, campaigns and materials, and the rules deny all four (§6.2).

The fix is not to widen the rules. Rules cannot field-scope a document, so an affiliate must not get raw `orders` reads (they contain buyer PII). The pattern that fits is **server projections**: an endpoint that returns only the affiliate's own attributed orders, with an allowlisted field set (order number, date, net amount, commission, status).

### 8.10 Wagon hazards
- The ambassador wagon can delete real affiliates (§6.3).
- `ambassadorActivities` has no tenant field (`firestore.rules:783-785`).
- Campaign-code lookups in click logging are correctly shop-scoped (`logAffiliateClick.ts:86`). Campaign codes themselves are unique only by a non-transactional check at create time (`useCampaigns.js:108-118`).

---

## 9. Rebuild notes for Cloudflare

**Principle.** Rebuild the *behaviour worth keeping* on the CF spine (`docs/cf-port/PLAN.md` §2.2–2.3) rather than port this code. INVENTORY §2.12 already recommends rebuilding on `discountCodes` + an attribution column on orders rather than porting the ledger. This section fills in that recommendation.

### 9.1 Data (D1, integer minor units, basis points, tenant-scoped, immutable `tenant_id` like every other table)
- **`affiliates`**
  - Columns: `id`, `tenant_id`, `user_id` (better-auth), `code`, `status IN ('active','inactive','suspended')`, `commission_bp`, `discount_bp`, contact fields, `created_at`.
  - Constraints: `UNIQUE(tenant_id, code)` and `CHECK(code = upper(code))`, mirroring `cloudflare/migrations/0010_discount_codes.sql` for `discount_codes`.
- **Code namespace.** Decide between two options (§10 Q10):
  - reject codes that collide with `discount_codes` at write time, e.g. with a shared `tenant_codes(tenant_id, code) UNIQUE` table, or
  - keep today's "affiliate wins" at the seam already reserved in `cloudflare/src/commerce/discount-codes.ts:283-314`.
- **`affiliate_applications`**: a pending/approved/denied state machine (not deletion), `decided_by`, `decided_at`, `terms_version`, `consent_at`, and a retention purge.
- **`affiliate_clicks`**: tenant-scoped, **no raw IP** (a salted hash or nothing), `expires_at` for a retention sweep.
- **`affiliate_ledger`** replaces the mutable `stats` counters, as an **append-only** table:
  - Columns: `(id, tenant_id, affiliate_id, kind IN ('accrual','reversal','payout','adjustment'), amount_minor, order_id NULL, payout_id NULL, created_by, created_at)`.
  - `UNIQUE(order_id, kind)` makes accrual and reversal idempotent.
  - Balance = `SUM(amount_minor)`. Clicks and conversions are derived with `COUNT`s.
- **`affiliate_payouts`**: `(id, tenant_id, affiliate_id, amount_minor, invoice_number, invoice_r2_key, notes, recorded_by, recorded_at, voided_at NULL)`. The invoice goes in the private R2 bucket and is served by signed URL.
- **`orders` / `checkouts`**: freeze the attribution at checkout. Columns: `affiliate_id`, `affiliate_code`, `attribution IN ('link','code')`, `affiliate_commission_bp`, `affiliate_discount_bp`, `click_id`. The award amount is then a pure function of frozen facts.

### 9.2 Handlers (one handler per operation, one D1 batch each)
| Operation | Shape | External effect → outbox? |
|---|---|---|
| Apply | `POST /s/:tenant/affiliate/apply`: Workers rate-limit binding, validate, insert the application (with terms version and consent) + `outbox(email: applicant)` + `outbox(email: shop admins)` in one batch | yes, email ×2 |
| Approve / deny | `POST /admin/affiliates/applications/:id/{approve,deny}`: `requireAdminOfTenant` from the application's tenant. **Invite** the better-auth user with a set-password link, no plaintext password (INVENTORY §2.1 note). **Refuse an existing account unless it is already this tenant's affiliate**, mirroring `createShopUser.ts:68-89`. Insert the affiliate and mark the application decided, all in one batch | yes, invite/welcome email with **tenant-prefixed** links |
| Click | on a storefront `?ref=` request, the Worker normalizes the code (uppercase), resolves it **scoped to the tenant host**, inserts the click and sets a first-party cookie `aff=<clickId>` (`HttpOnly; Secure; SameSite=Lax`, 30 d, per hostname, as in the cookie rule in `PLAN.md` §2.1), **only after consent** if Q6 decides so | no (internal write) |
| Quote / discount | inside the existing checkout pricing (`resolveDiscount` seam). Attribution comes **from the server-side cookie and the validated code, never from client metadata**. The checkout row freezes `affiliate_id` and the rates | no |
| Award | inside the **webhook batch** that creates the order (PLAN §2.3): add `affiliate_ledger(accrual)` computed from the frozen checkout facts. The self-referral check goes here. No trigger and no second pass, so it is atomic with the order | no. It is a D1 row in the same batch. An optional "you earned" mail would be an outbox email. |
| Reverse | in the **refund settlement batch** (PLAN §2.3 reserve-first refunds): when `refund_succeeded_total == charged`, insert `ledger(reversal)`; do the same in the cancel endpoint. Settlements of dashboard-originated refunds go through the same path, which closes today's gap (§3.6). Keep "reverse iff accrued", not flag-gated | no |
| Payout | `POST /admin/affiliates/:id/payouts`: the invoice is uploaded to R2 first (key recorded), then one batch inserts the payout + `ledger(payout)` with a conditional guard `balance >= amount`. A void is a compensating ledger row, never a delete | optional notification email → outbox |
| Portal reads | `GET /s/:tenant/affiliate/me`: a projection of the affiliate's rates, balance, ledger, payouts and attributed orders (allowlisted fields) and click aggregates | no |

### 9.3 Simplify or drop
- **Drop:**
  - the whole `campaigns` revenue-share layer, including `campaignParticipants`, `campaignRevenueTracking`, the universal special-edition pass and KAJJAN/EMMA
  - the `?campaign=` parameter; if wanted, keep it only as a free-text `utm` tag on the click
  - the ambassador wagon's use of `affiliates`
  - manual create and "send credentials", replaced by invite
  - `sendAffiliateWelcomeEmail`
  - the HTTP completion twin
  - client-side commission recomputation and the "verify" helpers
  - the admin `?admin_access` portal view
  - the global `localStorage` ref key
- **Keep:**
  - add-on OFF = "stop new activity, keep data, payouts still allowed" (`OBSOLETE/docs/P4_5B_AFFILIATE_ENFORCEMENT_PLAN.md:62`)
  - the server-authoritative total (total-parity: the client shows the server quote)
  - one code per cart
  - reversal only for what was accrued
  - the self-referral guard (strengthen it, §10)
  - per-affiliate rates with tenant defaults
- **Test first:**
  - lowercase `?ref=`
  - the same code in two tenants
  - forged attribution
  - a typed code without a click, once Q3 is decided
  - full refund → reversal; partial refund per the Q5 policy; dashboard refund
  - payout > balance race
  - approval of an existing account's email is refused
  - an affiliate's portal read never returns buyer PII

---

## 10. Open questions for Mikael

1. **(Urgent, live) The §8.1 takeover.** Patch Firebase now despite the freeze, by adding the `createShopUser`-style reuse guard and dropping `temporaryPassword` storage? Or set `features.affiliate=false` on every shop that does not use affiliates? Should existing `temporaryPassword` fields be purged from prod? A read-only prod count of `affiliates` docs with `temporaryPassword` would size this.
2. **Live data before retirement.** How many affiliates, unpaid balances (a liability), pending applications and clicks exist per shop in prod? Is `features.affiliate` effectively ON for live shops? New shops get `affiliate: true` (`ProvisionShopModal.jsx:32`). Unpaid balances must be settled or migrated before the Firebase code is deleted.
3. **Should a typed affiliate code, with no link click, earn commission?** Today it does not, by accident (§3.4). Should the link win over a typed code (today: it does, on the next cart change)?
4. **Commission base and VAT.** Today the base is `(paid total − shipping) / 1.25`, after the affiliate's own buyer discount, at a single global VAT rate. Keep this? What should happen for shops that are not VAT-registered, and for mixed VAT rates?
5. **Reversal policy.** Full refund or cancel → full reversal; a partial refund keeps the whole commission. Pro-rata instead? Stripe-dashboard refunds and lost disputes do not reverse today; should they? Should a payout wait for the 14-day withdrawal period before commission is payable?
6. **Consent.** Should the 30-day attribution storage be consent-gated? My assessment, not legal advice: ePrivacy Art. 5(3) / LEK 9 kap. 28 § covers `localStorage`, and "legitimate interest" is not a basis there. Or should it be cookieless (code-only attribution)? And should raw click IPs be stored at all? The owner's current position is that ChopShop runs no trackers, so no consent banner is needed. Affiliate link tracking would break that.
7. **Affiliate terms and MFL.** Should applicants accept program terms (commission, payout conditions, the duty to mark posts as advertising), with a stored terms version? Nothing exists today.
8. **Payout rail.** Keep the manual payout recorded against the affiliate's invoice? Private-person affiliates cannot invoice, and paying a private person has tax-reporting consequences for the shop. Or use Stripe Connect transfers? Should the platform take a cut?
9. **One login, many shops?** Today one email can be an affiliate of only one shop, and approval in a second shop destroys the first record (§8.1). Should an affiliate identity span tenants?
10. **Code collisions** with Rabattkoder codes: reject at creation, or keep "affiliate wins"? Should approval issue random codes (today `ABC` + 6 chars) or vanity codes?
11. **Campaigns and the ambassador CRM.** Confirm that both are dropped, not respecified. If per-campaign commission or discount is wanted, it needs a real spec; the UI promised it but it was never applied (§7.3).
12. **Notifications.** Should affiliates be mailed on conversion, reversal and payout, and should applicants be mailed on denial? None of these exist today.
13. **Defaults.** Commission 15% and buyer discount 10% (B8shield era): keep them as tenant-level defaults?
