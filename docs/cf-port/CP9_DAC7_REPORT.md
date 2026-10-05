# CP9-DAC7: the platform's DAC7 duty (seller due diligence and the yearly report) on Cloudflare

Design only, on branch `cf-port` at HEAD `96edab5c`, tree clean at the start. Nothing else in the tree was edited. No git write, no network request, no deploy, no test or build run. Every claim about code cites the file and the lines I opened on 2026-10-05. Where I could not check something the text says "not verified". **No rule of law is stated as fact here.** A rule is given with its source: the old code, a document of this repository, or the owner's own notes (the brief, and the owner's memory note `dac7_thresholds.md`, which is not in the repository). Where the source is only my own understanding of DAC7, the text says so and marks it "not verified against the law text". Every such point is a question for Mikael's accountant in §10.

## Design (phase 1)

### 0. Read this first

**Nothing of DAC7 exists on Cloudflare.** No table, no route, no page (HANDOVER.md:83, the inventory of 2026-10-05: "nothing exists on Cloudflare for … DAC7 (medium; the old math needs an exchange-rate source; seller data due 31 December)"). The Firebase side holds nine callables, two pages, a pure aggregation module with its tests, and one archived seller record (`MIGRATION_MANIFEST.md:77`: `dac7Sellers`, count 1).

**Three deliveries, because the two deadlines are two months apart.** The repository's documents give the dates: seller due diligence by 31 December 2026 (`DECISIONS.md:42`, D23), the filing by 31 January 2027 (`CP7_RUNBOOK.md:124`, 1.8; `MIGRATION_MANIFEST.md:370`). The owner's notes give the same dates; neither is verified against the law text.

| Delivery | What | Needed by | Migration |
|---|---|---|---|
| **A1. Collection** | The seller supplies and corrects their tax identity in the shop admin; the platform lists, reads, verifies, corrects, resolves correction requests and records the requests it has sent. Identity numbers encrypted. | As early as possible: if the "initial request, two reminders, 60 days" rule applies (my understanding, not verified, §5.3), the first request must reach every seller by about 1 November for the steps to fit before 31 December. | `0056_dac7_due_diligence.sql` |
| **A2. Reminders and the hold** | The request and reminder mails (needs Resend), and a checkout hold the platform can set on a seller who has not supplied the data. | Early December | `0057_dac7_mail_and_hold.sql` (the next free number then) |
| **B. The report** | Exchange rates, the yearly run (per seller, per quarter), the export for the accountant, the Firebase-period orders, the seller's yearly statement and running totals. | Early January, after the accountant has answered §10's legal questions | `0058_dac7_reporting.sql` (the next free number then) |

A1 is fully specified below (SQL, routes, texts). A2 and B are specified to the level a builder needs, and B's table shapes are deliberately left open on the points the accountant decides (gross or net, the fee, the count).

**The most consequential findings**, each detailed later:

1. **The seller-sees-one-number rule constrains the report.** If the accountant says the reported "fees" must be the commission alone, the seller's statement would carry the platform's cut. The design reports the one fee figure the seller already sees per order (§4.3, DAC11).
2. **The old math is per shop; the threshold test is per seller.** A person with two shops is tested on each shop alone today (`functions.ts:356-364`). The design groups shops by an encrypted-identity fingerprint (§5.2, DAC14).
3. **On Cloudflare a cancelled order keeps its money** (`0022_dispatch_state.sql:65-66`: "it moves NO money"), and `orders.status` does not follow a partial refund once the order is fulfilled (`refunds.ts:118-126`). The old status-based exclusion (`aggregate.ts:23`) would miscount if ported as it is. The design reads money columns only (§4.1).
4. **No import can run in production after the first order** (`0052_import_run_kinds.sql:80-106`). So the runbook's "`dac7Sellers` is restored before DAC7 ports" (`CP7_RUNBOOK.md:1324`) cannot be an import run once the shop is live. The one archived record is entered by hand (§3.5, DAC18).
5. **Stripe cannot supply the tax number.** The old code says so itself (`functions.ts:221-222`, and the no-op lines `:255-256`). The Cloudflare gateway reads no identity (`connect-gateway.ts:38-48`, `:103-122`). The design takes the identity from the seller, prefilled from the tenant settings (§1.3, DAC3).

### 1. The old behaviour (Firebase), and what is ported, changed or dropped

#### 1.1 What the old code does

| Rule | Old behaviour | Evidence |
|---|---|---|
| Whose duty | The platform operator's, not the shop's. The authoritative record, the Stripe pull, the aggregation and the export are platform-only. A seller has rights over their own record: view, correct contact fields, request a change of identity fields. | `functions/src/dac7/functions.ts:32-38`; `docs/STRIPE_COMPLIANCE_REMEDIATION_PLAN.md:202-216` |
| Where it is stored | `dac7Sellers/{shopId}` (doc id = shop id), apart from the public `shops` doc so the personal data cannot leak there. | `firestore.rules:407-419`; `functions.ts:6-9` |
| Fields | `sellerType` (individual/company), `legalName`, `taxId` (personnummer or org.nr), `vatNumber`, `address` (one string), `countryOfResidence` (ISO 3166-1 alpha-2), `dateOfBirth` (individuals, YYYY-MM-DD). Plus `verifiedViaStripe`, `stripePulledAt`, `lastSelfCorrectedAt`, `reported[]`, `updatedAt`. | `functions.ts:56-64`, `:261-266`, `:161`, `:399-410` |
| Input cleaning | Only the seven keys, strings trimmed, `sellerType` checked; no length limit, no format check. The VAT shape is checked only in the platform's editor (country code + 2–12 alphanumerics; Swedish = SE + 12 digits). | `functions.ts:66-73`; `src/pages/platform/PlatformDac7.jsx:184-197` |
| Identity vs contact | Identity keys (not self-editable): `taxId`, `dateOfBirth`, `sellerType`, `orgNumber`, `personnummer`. Contact keys (self-correctable): `legalName`, `vatNumber`, `address`, `countryOfResidence`. | `functions.ts:40-43` |
| `saveDac7SellerProfile` | Platform only. Merge-writes the profile; mirrors `sellerType` into `shops/{id}.storeIdentity.sellerType`. | `functions.ts:80-101` |
| `getDac7SellerProfile` | Platform only. Reads the profile; if it has no `sellerType`, falls back to the shop's `storeIdentity.sellerType`. | `functions.ts:107-122` |
| `getOwnDac7` | A shop admin of that shop (the platform may pass any shop). Returns the whole record, **taxId and dateOfBirth in clear**. | `functions.ts:130-137` |
| `correctOwnDac7Contact` | A shop admin of that shop. Writes the contact keys only; any identity key in the input is refused; stamps `lastSelfCorrectedAt`. | `functions.ts:144-165` |
| `requestDac7Correction` | A shop admin of that shop. Creates `dac7CorrectionRequests/{auto}` `{shopId, field, requestedValue, note ≤ 500, status:'pending', requestedBy, createdAt}`; `field` must be one of the five identity keys. No limit on the number of requests. | `functions.ts:172-189` |
| `resolveDac7Correction` | Platform only. Approve: writes `requestedValue` into the record's `field`, request → `approved`. Reject: → `rejected`. A resolved request cannot be resolved again. | `functions.ts:193-216` |
| `pullDac7FromStripe` | Platform only. See §1.3. | `functions.ts:224-279` |
| `aggregateDac7Year` | Platform only, one shop, one year, optional rate. No caller. | `functions.ts:292-305`; `docs/cf-port/INVENTORY_FUNCTIONS.md:84`, `:463`, `:467` |
| The math (`aggregateSellerYear`) | Orders of the shop whose `createdAt` falls in the **UTC** calendar year; status `refunded` or `cancelled` excluded; a total that is not a positive number skipped; a partially refunded order counts what was retained (`total − refundedTotalSek`), and is dropped when that is ≤ 0; count = one per order; gross SEK rounded to 2 decimals; EUR = gross × one rate. **De minimis: fewer than 30 sales AND ≤ EUR 2,000 → excluded**, still computed. | `functions/src/dac7/aggregate.ts:17-23`, `:62-105` |
| The rate | One SEK→EUR rate for the whole year; default `0.087`, a "conservative placeholder". The page pre-fills `0.087`; a blank field sends nothing and the server default applies. | `functions.ts:302`, `:307-310`; `PlatformDac7.jsx:261`, `:270-276` |
| Orders read | Every order of the shop, both `b2c` and `b2b`, fields `total`, `status`, `createdAt`, `source`, `payment.refundedTotalSek`. | `functions.ts:312-326` |
| `exportDac7Report` | Platform only. For every shop: the year aggregate; shops with no activity or below de minimis are skipped unless `includeBelowDeMinimis`; each row `{shopId, shopName, profile, aggregate, profileComplete}`. A plain run writes nothing (a preview). `markReported: true` appends `{year, reportedAt, activity:'sale_of_goods', grossReportedSek, grossReportedEur, txCountReported}` to each REPORTABLE seller's `reported[]`, replacing that year's entry (`mergeReportedRecord`). | `functions.ts:343-411`; `aggregate.ts:115-119` |
| Completeness | Type set; legal name, taxId, address, country present; DOB for an individual. No format check. | `functions.ts:413-419`; `PlatformDac7.jsx:66-72` |
| Platform page | `/dac7` in the dark console: pending correction requests (realtime, `requestedValue` shown in clear), every shop's profile status with an editor (Stripe pull + manual fields), the year report (year defaults to last year, rate, include-excluded, CSV download, "Markera som rapporterad" with a confirm). CSV columns: `shopId, shopName, sellerType, legalName, taxId, vatNumber, countryOfResidence, transactionCount, grossSEK, grossEUR, reportable, profileComplete`. | `PlatformDac7.jsx:27-62`, `:77-156`, `:160-255`, `:257-443`, `:306` |
| Seller page | `/admin/skatteuppgifter` "Mina skatteuppgifter": a transparency notice, the "Du har rapporterats till Skatteverket (DAC7)" list from `reported[]`, the identity fields read-only (type, taxId, DOB for individuals), the contact fields editable, an identity correction request form. | `src/pages/admin/AdminMyTaxData.jsx:18-52`, `:119-207` |
| Tests | `rules-tests/dac7-aggregation.test.cjs` (year filter, exclusions, both boundaries: 29/30 sales, EUR 2,000.00/2,000.01, partial refunds, `mergeReportedRecord`); `rules-tests/firestore-isolation.test.cjs:246-267`, `:374-402` (rules). | files named |
| Contract | The platform terms oblige the seller to supply the DAC7 data on request: "Säljaren ska på begäran lämna de uppgifter som krävs för sådan rapportering." | `src/config/platformTerms.js:129-132` (§6) |
| Production data | 1 `dac7Sellers` doc, 0 `dac7CorrectionRequests` (archived). | `MIGRATION_MANIFEST.md:76-77` |

#### 1.2 Who may read and write what (old)

| Party | `dac7Sellers/{shopId}` | `dac7CorrectionRequests` | Callables |
|---|---|---|---|
| Anyone, a customer, another shop's admin | nothing (`firestore.rules:422-423`; tests `firestore-isolation.test.cjs:374-393`) | nothing (`:450-458`) | none |
| An admin of the shop (every member) | get own (full record, incl. taxId and DOB); update own, only `legalName, vatNumber, address, countryOfResidence, updatedAt, lastSelfCorrectedAt` (`:432-444`); no create, no list | get/list own; create own with `status:'pending'` and `field ∈ {taxId, dateOfBirth, sellerType}` (`:450-458`) | `getOwnDac7`, `correctOwnDac7Contact`, `requestDac7Correction` |
| The platform | everything (`:422-436`) | get, list, update, delete (`:450-462`) | all nine |
| Server (Admin SDK) | bypasses the rules (`firestore.rules:417-418`) | same | — |

#### 1.3 `pullDac7FromStripe`: what it took, and where Cloudflare should read the identity

What it took (`functions.ts:224-279`), from `stripe.accounts.retrieve(shops/{id}.payments.stripeAccountId)` at API version `2023-10-16`:

- `business_type` → `sellerType` (`:239-241`).
- Individual: `first_name + last_name` → `legalName`; `dob {year, month, day}` → `dateOfBirth`; `address.country` → `countryOfResidence`; the address joined as one string (`:245-252`, `:281-283`).
- Company: `name` → `legalName`; address and country as above (`:253-259`). For the tax ids it does nothing: `pulled.taxId = pulled.taxId` and `pulled.vatNumber = pulled.vatNumber` are no-ops; its comment says "Stripe redacts the value; flag only" (`:255-256`), and no flag is written.
- `acct.country` when no address country (`:260`).
- Stamps `verifiedViaStripe: true` and `stripePulledAt` whatever was returned, merges over the record, and mirrors `sellerType` into the shop's `storeIdentity` (`:261-277`).

**So the pull never supplied the tax number**, which is the field the report cannot do without. Its value was a Stripe-verified name, date of birth and address.

Where Cloudflare should read from:

| Source | What it holds | Fit |
|---|---|---|
| The connected account | Possibly the verified name, DOB and address of an Express individual (not verified: what an Express platform may read was not checked offline); never the full tax number (the old code's own comment). | The Worker's Connect gateway reads only capability facts (`connect-gateway.ts:38-48`); its interface has no identity read (`:103-122`). Seller onboarding is to move to Accounts v2 (D49, `DECISIONS.md:71`), whose adapter is "UNVERIFIED: no call of it has ever reached Stripe" (`connect-gateway.ts:26-28`), and whose identity shape differs from v1's (not verified). A port means two new adapter methods, one of them unproven, for data that still lacks the TIN. |
| The tenant settings | `seller_type` (column), `vat_registered`, `vat_number` (columns), and in `store_identity_json` the seller's `legalName`, `orgNumber`, `address` (free text with `<br>`). All seller-written, unverified, and printed on the adopted legal pages. | `migrations/0032_tenant_config.sql:55-71`; `cloudflare/src/platform/tenant-config.ts:376-410`; `cloudflare/src/legal/legal-identity.ts:59-82` (CP9-OB reads exactly these). |
| The seller | Everything, including the TIN and DOB. | What the platform terms already oblige (`platformTerms.js:129-132`). |

**Recommended (DAC3):** the seller supplies the DAC7 record in the shop admin; the form is prefilled from the tenant settings where a field maps exactly (company name, organisation number, VAT number, seller type); the platform verifies. `pullDac7FromStripe` is **not ported** in this checkpoint. A later, optional, read-only "compare with Stripe" on the platform's seller page (type, name, country match or not, nothing stored) is listed under "left out".

#### 1.4 Ported, changed, dropped

| Rule | Fate | Reason |
|---|---|---|
| The record is the platform's; a seller reads only their own; never another seller's; no listing by a seller | **Ported** | The old access model (§1.2) is right. |
| The seller fills the record | **Changed**: the seller supplies every field (old: the platform typed the identity, the seller corrected contact fields). The platform verifies. | The platform has no source for the TIN but the seller (§1.3); the terms already ask the seller for it. DAC2. |
| Identity vs contact split | **Ported, one change**: the legal name (first and last name for an individual) moves to identity; contact = address, VAT number, permanent establishments. Identity is freely editable until the platform verifies; after that only by a correction request. | A name is what identifies the seller in the report. DAC6. |
| Correction requests | **Ported**, with one pending request per field, a requested TIN or DOB stored encrypted, and a rate limit. | `functions.ts:172-189` had neither limit nor encryption (finding W15). |
| The TIN and DOB in clear, shown in full to every shop admin | **Changed**: encrypted at rest; the seller's page shows the last four characters; the full value only to the platform, on an audited reveal or export. | §2.4. DAC4, DAC5. |
| Address as one string, `countryOfResidence` | **Changed**: structured address (line 1, line 2, postal code, city, country) plus the TIN's issuing country. | The report needs an address per field (not verified which fields); a string with `<br>` cannot be split reliably. |
| `pullDac7FromStripe` | **Dropped** for now | §1.3. DAC3. |
| `aggregateDac7Year` | **Dropped** as a route (PLAN §3.3, D2 signed off); its math ports into the yearly run | §1.5. |
| The aggregation | **Ported with changes**: money columns instead of status; Stockholm year; per quarter; fees; transactions per (order, product); per-payment-date rate; the test per seller across shops; lost disputes subtracted. | §4, §5. Each change is a decision (DAC8–DAC14). |
| `exportDac7Report` preview vs `markReported` | **Changed**: a run is computed and STORED (immutable), the CSV is exported from that stored run, and filing marks that same run. | Old: the CSV and the marked figures were two separate computations (finding W13). |
| `reported[]` on the seller's record | **Changed**: the seller's yearly statement is read from the filed run. | One source for what was filed. |
| Realtime correction queue (`onSnapshot`) | **Changed**: fetched on open and after each action | PLAN §2.9 (`docs/cf-port/PLAN.md:95`). |
| `sellerType` mirrored both ways into the shop | **Changed**: the DAC7 record keeps its own type, prefilled from `tenant_settings.seller_type`; a mismatch is shown to both parties, nothing is written across. | The legal pages read the settings' type (`legal-identity.ts:73`); a DAC7 write must not change the legal pages. |
| B2B orders counted | **Not applicable** | B2B is not ported (PLAN §3.2); Cloudflare has one kind of order. |

#### 1.5 What the plan and the decisions say, and how they fit

- **PLAN §3.2** lists DAC7 as PORT-LATER (`PLAN.md:106`); **§3.3** lists `aggregateDac7Year` under DELETE (`PLAN.md:109`), signed off in **D2** (`DECISIONS.md:9`). They do not conflict: the callable has no caller and `exportDac7Report` runs the same math internally (`INVENTORY_FUNCTIONS.md:84`, `:467`). The callable goes; the math (`aggregate.ts`) ports into the run of §4. The per-shop view the callable would have given is the platform's seller detail (§7.2) and the seller's running totals (§7.1, phase B).
- **D23** (`DECISIONS.md:42`): DAC7 is CP9 in November; `dac7Sellers` archived until then. This design is that checkpoint, written in October. The archive (`MIGRATION_MANIFEST.md:77`, row 23) is entered by hand (§3.5).
- **D10** (`DECISIONS.md:24`): the 9 refunded test orders are archive only, not in DAC7. They retained nothing, so the math of §4 would not count them anyway.
- **D37** (`DECISIONS.md:59`) says the platform "remains VAT merchant of record". Whether that changes who the "seller" is for DAC7 is a legal question (DAC24); the design assumes each shop's legal person is the seller, as the old code did.
- **PLAN §2.7** (`PLAN.md:89`): "Reporting (DAC7, platform stats) reads nightly exports in R2". The export is not built (`docs/cf-port/D1_BACKUP_RESTORE.md:50-53`, "Still to build"). The design reads D1 directly with bounded per-tenant queries (DAC22): one database, a few shops, and the run is a platform action a few times a year.
- **`MIGRATION_MANIFEST.md:370`** (§f Q8) and **`CP7_RUNBOOK.md:124`, `:1324`, `:1351`**: DAC7 must port before December; Firebase stays as an archive past the filing on 31 January 2027. The 2026 report must include the orders taken on Firebase before the cutover (§3.5).
- **`CP5_GAP_ANALYSIS.md:44`**: `AdminMyTaxData` and `PlatformDac7` are PORT-LATER; both left the build (`src/admin-app/replacements/adminShellScope.js:23-26`, `platformLayoutData.js:29`, pinned by `shells.test.mjs:24-25`, `:69-70`).

### 2. What is collected per seller

#### 2.1 The fields, what the platform already holds, what is missing

The field list is the old code's (`functions.ts:56-64`) plus what my understanding of DAC7 adds (marked; not verified against the law text). The accountant confirms the list (DAC9's question set).

| Field | Individual | Company | Already held | Where | Missing / note |
|---|---|---|---|---|---|
| Seller type | yes | yes | yes | `tenant_settings.seller_type` (`0032:68`), seller-written | Prefill; the DAC7 record keeps its own copy. |
| Name | first + last name (my understanding: separately; not verified) | registered name | partly | `store_identity_json.legalName`, free text, seller-written (`tenant-config.ts:361-369` lists what is NOT in the JSON; `legalName` is) | An individual's name is one string there; asked again as two fields. |
| Primary address | yes | yes | as free text | `store_identity_json.address` (HTML, `<br>`) | Asked again, structured. The settings' address is shown as a hint. |
| TIN (personnummer / organisationsnummer) | personnummer | org.nr | company only, free text | `store_identity_json.orgNumber` | **The personnummer is held nowhere.** |
| TIN issuing country | yes | yes | no | — | Default SE. |
| Date of birth | yes | — | no | — | Derived from a Swedish personnummer (shown for confirmation), stored on its own. |
| VAT number | if registered | if registered | yes | `tenant_settings.vat_number`, `vat_registered` (`0032:66-67`) | Prefill. |
| Business registration number | — | my understanding: yes (not verified) | as org.nr | as above | For a Swedish company it is the org.nr; not stored twice. |
| Permanent establishments in other EU states | — | my understanding: yes (not verified) | no | — | A list of country codes, default none. |
| Financial account identifier | my understanding: when available to the platform (not verified) | same | **no** | Stripe holds the bank account | Not collected (left out, §11.2). |
| Place of birth | my understanding: only when no TIN (not verified) | — | no | — | Every seller here has a Swedish TIN (Connect accounts are created with `country: "SE"`, `connect-gateway.ts:445`); not collected. |
| Excluded entity (government, listed) | — | the owner's note names them (not verified) | no | — | Platform-set only (DAC26). |

#### 2.2 How the seller supplies and corrects it

```
no row ──(seller saves)──► draft ──(seller "Skicka in", complete)──► submitted ──(platform "Godkänn")──► verified
                              ▲                                          │
                              └──────────(platform "Skicka tillbaka", reason)┘
verified: contact fields (address, VAT, establishments) editable by the seller at any time;
          identity fields (type, names, TIN, TIN country, DOB) only through a correction request,
          or by a platform edit (which re-stamps the verification).
```

- **Draft.** Saved incomplete at will. Nothing is reported from a draft; the platform sees it as incomplete.
- **Submitted.** Complete by the table's CHECK (§3.1); the seller may still edit it (it stays complete) until the platform verifies.
- **Verified.** The platform has checked the record (format checks pass; a person compared it with what the platform knows). A trigger refuses an identity change on a verified row unless the same write re-stamps `verified_at`, which only the platform's routes do (§3.1).
- **Correction request** (verified rows only): one field, the new value, an optional note. One pending request per field. Approving writes the value and re-stamps the verification in one batch; rejecting leaves the record. The seller sees the request and its outcome.
- **Acting-as.** A platform user acting in the shop may read the seller page (masked) and may not write it, as `maySignForSeller` forbids an acting-as user to sign for the seller (`cloudflare/src/legal/platform-terms.ts:235-237`, `live-authorization.ts:6-18`). The platform writes through its own console routes, audited as the platform.
- **Several admins of one shop.** Every member admin of the shop sees the same masked record and may edit it; each write is audited with the user's id. The seller is the shop's legal person, not the admins.

#### 2.3 Validation (offline only, no network call)

| Field | Check | Refusal (Swedish in §8.4) |
|---|---|---|
| Personnummer | 12 digits `YYYYMMDDNNNC` (a hyphen or space accepted and removed); a valid date, where a day + 60 (samordningsnummer) is accepted; the last digit is the Luhn check over the last ten digits. 10-digit input is refused (the century would be guessed). DOB = the date (day − 60 for a samordningsnummer). | `invalid_tin` |
| Org.nr | 10 digits `NNNNNN-NNNN`, Luhn check digit. | `invalid_tin` |
| VAT (SE) | `SE` + 12 digits (the old editor's rule, `PlatformDac7.jsx:194-197`). That the 10 middle digits equal the TIN and the suffix is `01` is shown to the platform as a warning, not refused (the format beyond the old rule is not verified here). | `invalid_vat_number` |
| VAT (other EU) | 2 letters + 2–12 alphanumerics (`PlatformDac7.jsx:190`). | `invalid_vat_number` |
| Countries | ISO 3166-1 alpha-2, upper case. | `invalid_request` |
| Text fields | Trimmed; no control characters (`tenant-config.ts:354` `CONTROL_CHARACTERS`); lengths as the CHECKs; no HTML (`<`, `>` refused). | `invalid_request` with `fields: [names]` |

Test values that pass: personnummer `19121212-1212` (Luhn: 1·2 + 2 + 1·2 + 2 + … over `1212121212` gives check digit 2); org.nr `556677-8899` (check digit 9; it is the old tests' value, `firestore-isolation.test.cjs:131`); VAT `SE556677889901`. Validation is format only: whether the number belongs to the person is the platform's verification step. An online check (VIES, Skatteverket) is left out (§11.2).

#### 2.4 The identity numbers: storage, key, who reads, logs, audit, retention

**What is encrypted.** The TIN and the date of birth (and a requested TIN or DOB in a correction request). Names, the address, the VAT number and the countries are kept in clear: they are the seller's business identity, mostly printed on the seller's adopted legal pages already (`legal-identity.ts:18-26`). One exception to know: a Swedish sole trader's VAT number contains their personnummer, and `tenant_settings.vat_number` already holds it in clear (finding C6). DAC4 asks whether the DAC7 copy of an individual's VAT number should be encrypted too.

**The key material that exists.** The Worker encrypts nothing at rest today (no AES or `encrypt` anywhere in `cloudflare/src`). The one pattern for purpose-bound keys is the storefront preview grant: an HMAC key derived by HKDF-SHA-256 from the Worker secret `BETTER_AUTH_SECRET`, with a salt and info of its own purpose (`cloudflare/src/storefront/preview.ts:30-37`, `:152-176`; the secret `env.d.ts:56-58`).

| Option | Consequence |
|---|---|
| **K1. A new Worker secret `DAC7_DATA_KEY`** (32 random bytes, base64), with the preview's HKDF pattern: info `dac7-encrypt/v1` → AES-256-GCM key; info `dac7-fingerprint/v1` → HMAC-SHA-256 key; salt `chopshop/dac7`. | The DAC7 data's fate is independent of the auth secret. The secret must be backed up outside Cloudflare (a Worker secret cannot be read back): lose it and every stored TIN is unreadable. A key id (`k1`) on every ciphertext allows a later rotation (a second secret `DAC7_DATA_KEY_PREVIOUS`; rotation not built). |
| K2. Derive from `BETTER_AUTH_SECRET` (no new secret) | Rotating the auth secret (the response to a session compromise, which also ends every preview grant, `preview.ts:36-37`) would make every stored TIN unreadable unless the old secret is kept as well; one secret both forges sessions and decrypts identity numbers. |
| K3. No application-level encryption | Simplest. A D1 export, a Time Travel restore, a `wrangler d1 execute` with the project token (which the scripts and the preflight use, `PLAN.md:130`) shows every personnummer in clear. |

**Recommended: K1 (DAC4).** Ciphertext format `v1.<keyId>.<iv base64url>.<ciphertext+tag base64url>` (about 60 characters for a TIN). The additional authenticated data is `dac7/v1\n<tenantId>\n<table>.<column>\n<rowId>`, so a ciphertext copied to another shop's row, another column or another request does not decrypt. The fingerprint is `HMAC(key, "tin/v1\n<country>\n<normalised TIN>")` in hex. Without the secret, the routes that write or reveal a TIN answer `503 dac7_unavailable` and every read still works (it shows `tin_last4`): fail closed, as the Worker treats an unset Stripe or Resend secret (`env.d.ts:70-75`).

PLAN §2.7 says "no binary/base64 in rows" (`PLAN.md:89`). That rule is about images and blobs; a 60-character ciphertext is text by design. DAC23 asks for the exception explicitly.

**Who can read what.**

| Reader | TIN | DOB | Fingerprint, ciphertext, key id |
|---|---|---|---|
| The seller (every admin of the shop) | last four characters only (`••••••••-1212`) | "sparat" (saved), never the value | never |
| An acting-as platform user in the shop admin | the same masked view | same | never |
| The platform console, lists | last four | — | never in a response |
| The platform, seller detail "Visa" | in full, by `POST …/reveal` (a POST so it is same-origin-checked and never prefetched or cached), audited | in full, same call | never |
| The platform, the yearly export | in full, audited per export | in full | never |
| Buyers, printers, the storefront, mails | never | never | never |

**What is logged and audited.** The Worker keeps invocation logs on (`wrangler.jsonc:20-26`): they record the request line and status. Whether Workers Logs ever capture a request body is not verified, so the rule is: **a TIN or DOB never appears in a URL, a path or a query**, only in a request or response body; DAC7 code logs codes only (the pattern of `app.ts:761-766`); an error answer names fields, never values; rate-limit keys are hashed (`lib/rate-limit.ts:42-55`). `audit_events` (`0001_platform_foundation.sql:46-57`, append-only) gets one row per act, `metadata_json` listing **field names and counts, never values**: `dac7.profile.save`, `dac7.profile.submit`, `dac7.profile.verify`, `dac7.profile.return`, `dac7.profile.platform_edit`, `dac7.profile.reveal`, `dac7.correction.create`, `dac7.correction.resolve`, `dac7.notice.record`, and in B `dac7.fx.write`, `dac7.external.write`, `dac7.run.compute`, `dac7.run.export`, `dac7.run.file`, `dac7.statements.publish`. Under acting-as the grant id is added by the existing `auditMetadataJson` (`live-authorization.ts:20-28`).

**Retention.** How long the platform must or may keep the DAC7 records is a legal question (DAC20); my understanding is a record-keeping duty of several years after the reporting period (not verified against the law text). Default: the profile is kept while the tenant exists (tenants are never deleted, `ON DELETE RESTRICT` everywhere); a filed run and its seller snapshots are kept 10 years; **no deletion path is built now** (as D68 left the evidence tables, `DECISIONS.md:101`). Time Travel and any future D1 export carry ciphertext only. Staging gets its own `DAC7_DATA_KEY`; no production profile is ever copied to staging.

### 3. Data model

#### 3.1 Migration `0056_dac7_due_diligence.sql` (phase A1)

If 0056 is taken when the builder starts, use the next free number. Point `REQUIRED_MIGRATION` (`cloudflare/src/app.ts:492`) at it and update the two tests that pin the latest migration (`cloudflare/test/health.test.ts`, `cloudflare/test/public-catalog.test.ts`, as CP8-DC did, `CP8_DC_REPORT.md:83`). Never edit a migration that has been applied anywhere.

```sql
PRAGMA foreign_keys = ON;

-- ============================================================================
-- 0056 — CP9-DAC7 phase A1: the seller's DAC7 due-diligence record
-- (docs/cf-port/CP9_DAC7_REPORT.md §2-§3). Replaces Firebase dac7Sellers and
-- dac7CorrectionRequests (functions/src/dac7/functions.ts).
--
-- IDENTITY NUMBERS. The TIN (personnummer / organisationsnummer) and the date
-- of birth are ENCRYPTED by the Worker (src/dac7/crypto.ts: AES-256-GCM, key
-- derived from the secret DAC7_DATA_KEY; the tenant, the column and the row
-- are in the additional data). A D1 export or a Time Travel restore holds
-- ciphertext. `tin_last4` is what lists and the seller show; `tin_fingerprint`
-- (HMAC hex) groups one seller's shops. No tenant route returns a ciphertext,
-- a fingerprint or a key id.
--
-- TIME: ISO-8601 UTC TEXT with the strftime round-trip CHECK (0032, 0044).
-- ACTORS: user ids, bounded like tenant_settings.updated_by.
-- ============================================================================

CREATE TABLE dac7_seller_profiles (
  tenant_id TEXT PRIMARY KEY NOT NULL
    REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  seller_type TEXT CHECK (seller_type IS NULL OR seller_type IN ('individual', 'company')),
  legal_name TEXT CHECK (legal_name IS NULL OR length(legal_name) BETWEEN 1 AND 200),
  first_name TEXT CHECK (first_name IS NULL OR length(first_name) BETWEEN 1 AND 100),
  last_name TEXT CHECK (last_name IS NULL OR length(last_name) BETWEEN 1 AND 100),
  address_line1 TEXT CHECK (address_line1 IS NULL OR length(address_line1) BETWEEN 1 AND 200),
  address_line2 TEXT CHECK (address_line2 IS NULL OR length(address_line2) BETWEEN 1 AND 200),
  postal_code TEXT CHECK (postal_code IS NULL OR length(postal_code) BETWEEN 1 AND 20),
  city TEXT CHECK (city IS NULL OR length(city) BETWEEN 1 AND 100),
  country TEXT CHECK (country IS NULL OR (length(country) = 2 AND country GLOB '[A-Z][A-Z]')),
  tin_ciphertext TEXT CHECK (tin_ciphertext IS NULL OR (
    length(tin_ciphertext) BETWEEN 40 AND 400
    AND substr(tin_ciphertext, 1, 3) = 'v1.'
    AND tin_ciphertext NOT GLOB '*[^A-Za-z0-9._-]*')),
  tin_last4 TEXT CHECK (tin_last4 IS NULL OR (length(tin_last4) = 4 AND tin_last4 NOT GLOB '*[^0-9A-Z]*')),
  tin_fingerprint TEXT CHECK (tin_fingerprint IS NULL OR (
    length(tin_fingerprint) = 64 AND tin_fingerprint NOT GLOB '*[^0-9a-f]*')),
  tin_country TEXT CHECK (tin_country IS NULL OR (length(tin_country) = 2 AND tin_country GLOB '[A-Z][A-Z]')),
  dob_ciphertext TEXT CHECK (dob_ciphertext IS NULL OR (
    length(dob_ciphertext) BETWEEN 40 AND 400
    AND substr(dob_ciphertext, 1, 3) = 'v1.'
    AND dob_ciphertext NOT GLOB '*[^A-Za-z0-9._-]*')),
  key_id TEXT CHECK (key_id IS NULL OR (length(key_id) BETWEEN 1 AND 16 AND key_id NOT GLOB '*[^a-z0-9]*')),
  vat_number TEXT CHECK (vat_number IS NULL OR (
    length(vat_number) BETWEEN 4 AND 14
    AND substr(vat_number, 1, 2) GLOB '[A-Z][A-Z]'
    AND vat_number NOT GLOB '*[^0-9A-Z]*')),
  permanent_establishments_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(permanent_establishments_json)
    AND json_type(permanent_establishments_json) = 'array'
    AND length(permanent_establishments_json) <= 200),
  excluded_entity TEXT NOT NULL DEFAULT 'none'
    CHECK (excluded_entity IN ('none', 'government', 'listed')),
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'submitted', 'verified')),
  submitted_at TEXT CHECK (submitted_at IS NULL OR submitted_at IS strftime('%Y-%m-%dT%H:%M:%fZ', submitted_at)),
  verified_at TEXT CHECK (verified_at IS NULL OR verified_at IS strftime('%Y-%m-%dT%H:%M:%fZ', verified_at)),
  verified_by TEXT CHECK (verified_by IS NULL OR length(verified_by) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  updated_by TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128),
  CHECK (updated_at >= created_at),
  -- The TIN's four columns travel together; a ciphertext names its key.
  CHECK ((tin_ciphertext IS NULL) = (tin_last4 IS NULL)
     AND (tin_ciphertext IS NULL) = (tin_fingerprint IS NULL)
     AND (tin_ciphertext IS NULL) = (tin_country IS NULL)),
  CHECK ((tin_ciphertext IS NULL AND dob_ciphertext IS NULL) OR key_id IS NOT NULL),
  -- A company has no personal names and no birth date; an individual no
  -- registered name and no establishments.
  CHECK (seller_type IS NOT 'company'
         OR (first_name IS NULL AND last_name IS NULL AND dob_ciphertext IS NULL)),
  CHECK (seller_type IS NOT 'individual'
         OR (legal_name IS NULL AND permanent_establishments_json = '[]')),
  -- State and stamps.
  CHECK ((state = 'draft') = (submitted_at IS NULL)),
  CHECK ((state = 'verified') = (verified_at IS NOT NULL)),
  CHECK ((verified_at IS NULL) = (verified_by IS NULL)),
  -- Submitted and verified records are complete.
  CHECK (state = 'draft' OR (
    address_line1 IS NOT NULL AND postal_code IS NOT NULL AND city IS NOT NULL
    AND country IS NOT NULL AND tin_ciphertext IS NOT NULL
    AND ((seller_type = 'company' AND legal_name IS NOT NULL)
      OR (seller_type = 'individual' AND first_name IS NOT NULL
          AND last_name IS NOT NULL AND dob_ciphertext IS NOT NULL))))
);

CREATE TRIGGER dac7_seller_profiles_tenant_immutable
BEFORE UPDATE OF tenant_id ON dac7_seller_profiles
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

-- draft → submitted (the seller) · submitted → draft (the platform returns it)
-- · submitted → verified (the platform). A re-verification keeps 'verified'
-- and moves verified_at.
CREATE TRIGGER dac7_seller_profiles_state_transition
BEFORE UPDATE OF state ON dac7_seller_profiles
FOR EACH ROW
WHEN NEW.state IS NOT OLD.state
  AND NOT ((OLD.state = 'draft' AND NEW.state = 'submitted')
        OR (OLD.state = 'submitted' AND NEW.state IN ('draft', 'verified')))
BEGIN
  SELECT RAISE(ABORT, 'dac7 profile state transition refused');
END;

-- The backstop of DAC6: on a verified record the identity changes only in a
-- write that re-stamps the verification (the platform's edit, an approved
-- correction). The seller's route never writes verified_at. A key rotation
-- (not built) must replace this trigger in its own migration.
CREATE TRIGGER dac7_seller_profiles_verified_identity
BEFORE UPDATE ON dac7_seller_profiles
FOR EACH ROW
WHEN OLD.state = 'verified' AND NEW.state = 'verified'
  AND NEW.verified_at IS OLD.verified_at
  AND (NEW.seller_type IS NOT OLD.seller_type
    OR NEW.legal_name IS NOT OLD.legal_name
    OR NEW.first_name IS NOT OLD.first_name
    OR NEW.last_name IS NOT OLD.last_name
    OR NEW.tin_ciphertext IS NOT OLD.tin_ciphertext
    OR NEW.tin_country IS NOT OLD.tin_country
    OR NEW.dob_ciphertext IS NOT OLD.dob_ciphertext)
BEGIN
  SELECT RAISE(ABORT, 'dac7 verified identity changes only with a new verification');
END;

CREATE TRIGGER dac7_seller_profiles_no_delete
BEFORE DELETE ON dac7_seller_profiles
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'dac7 profiles are kept');
END;

CREATE INDEX dac7_seller_profiles_fingerprint_idx
  ON dac7_seller_profiles(tin_fingerprint) WHERE tin_fingerprint IS NOT NULL;
CREATE INDEX dac7_seller_profiles_state_idx ON dac7_seller_profiles(state, updated_at);


-- ----------------------------------------------------------------------------
-- dac7_correction_requests — a seller's request to change an identity field of
-- a VERIFIED record. One pending request per field. A requested TIN or birth
-- date is encrypted like the record's (AAD names this table and request_id).
-- ----------------------------------------------------------------------------
CREATE TABLE dac7_correction_requests (
  request_id TEXT PRIMARY KEY NOT NULL CHECK (length(request_id) BETWEEN 1 AND 64),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  field TEXT NOT NULL CHECK (field IN (
    'sellerType', 'legalName', 'firstName', 'lastName', 'tin', 'tinCountry', 'dateOfBirth')),
  value_text TEXT CHECK (value_text IS NULL OR length(value_text) BETWEEN 1 AND 200),
  value_ciphertext TEXT CHECK (value_ciphertext IS NULL OR (
    length(value_ciphertext) BETWEEN 40 AND 400
    AND substr(value_ciphertext, 1, 3) = 'v1.'
    AND value_ciphertext NOT GLOB '*[^A-Za-z0-9._-]*')),
  value_last4 TEXT CHECK (value_last4 IS NULL OR (length(value_last4) = 4 AND value_last4 NOT GLOB '*[^0-9A-Z]*')),
  key_id TEXT CHECK (key_id IS NULL OR (length(key_id) BETWEEN 1 AND 16 AND key_id NOT GLOB '*[^a-z0-9]*')),
  note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  requested_by TEXT NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 128),
  resolved_by TEXT CHECK (resolved_by IS NULL OR length(resolved_by) BETWEEN 1 AND 128),
  resolution_reason TEXT CHECK (resolution_reason IS NULL OR length(resolution_reason) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  resolved_at TEXT CHECK (resolved_at IS NULL OR resolved_at IS strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at)),
  -- Exactly one form of the value: encrypted for tin and dateOfBirth, clear otherwise.
  CHECK ((field IN ('tin', 'dateOfBirth')) = (value_ciphertext IS NOT NULL)),
  CHECK ((field IN ('tin', 'dateOfBirth')) = (value_text IS NULL)),
  CHECK ((value_ciphertext IS NULL) = (key_id IS NULL)),
  CHECK ((field = 'tin') = (value_last4 IS NOT NULL)),
  CHECK ((status = 'pending') = (resolved_at IS NULL)),
  CHECK (status NOT IN ('approved', 'rejected') OR resolved_by IS NOT NULL),
  CHECK (resolved_at IS NULL OR resolved_at >= created_at)
);

CREATE TRIGGER dac7_correction_requests_tenant_immutable
BEFORE UPDATE OF tenant_id ON dac7_correction_requests
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE TRIGGER dac7_correction_requests_born_pending
BEFORE INSERT ON dac7_correction_requests
FOR EACH ROW
WHEN NEW.status <> 'pending'
  OR NOT EXISTS (SELECT 1 FROM dac7_seller_profiles AS p
                 WHERE p.tenant_id = NEW.tenant_id AND p.state = 'verified')
BEGIN
  SELECT RAISE(ABORT, 'a dac7 correction request is born pending, on a verified record');
END;

-- pending → approved | rejected | withdrawn; nothing leaves a resolution.
CREATE TRIGGER dac7_correction_requests_transition
BEFORE UPDATE OF status ON dac7_correction_requests
FOR EACH ROW
WHEN NEW.status IS NOT OLD.status
  AND NOT (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected', 'withdrawn'))
BEGIN
  SELECT RAISE(ABORT, 'dac7 correction transition refused');
END;

CREATE TRIGGER dac7_correction_requests_facts_immutable
BEFORE UPDATE ON dac7_correction_requests
FOR EACH ROW
WHEN NEW.request_id IS NOT OLD.request_id
  OR NEW.field IS NOT OLD.field
  OR NEW.value_text IS NOT OLD.value_text
  OR NEW.value_ciphertext IS NOT OLD.value_ciphertext
  OR NEW.value_last4 IS NOT OLD.value_last4
  OR NEW.key_id IS NOT OLD.key_id
  OR NEW.note IS NOT OLD.note
  OR NEW.requested_by IS NOT OLD.requested_by
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.status <> 'pending')
BEGIN
  SELECT RAISE(ABORT, 'dac7 correction facts are immutable');
END;

CREATE TRIGGER dac7_correction_requests_no_delete
BEFORE DELETE ON dac7_correction_requests
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'dac7 correction requests are kept');
END;

CREATE UNIQUE INDEX dac7_correction_requests_one_pending_idx
  ON dac7_correction_requests(tenant_id, field) WHERE status = 'pending';
CREATE INDEX dac7_correction_requests_status_idx
  ON dac7_correction_requests(status, created_at);
CREATE INDEX dac7_correction_requests_tenant_idx
  ON dac7_correction_requests(tenant_id, created_at DESC);


-- ----------------------------------------------------------------------------
-- dac7_seller_notices — the platform's requests and reminders to a seller to
-- supply the data, per reporting year (§5.3). Append-only; a reminder follows
-- the request, the second the first. A1 records them by hand (channel
-- 'other' or 'admin_notice'); A2's mails record 'email' themselves.
-- ----------------------------------------------------------------------------
CREATE TABLE dac7_seller_notices (
  notice_id TEXT PRIMARY KEY NOT NULL CHECK (length(notice_id) BETWEEN 1 AND 64),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  reporting_year INTEGER NOT NULL CHECK (reporting_year BETWEEN 2023 AND 2100),
  kind TEXT NOT NULL CHECK (kind IN ('request', 'reminder_1', 'reminder_2')),
  channel TEXT NOT NULL CHECK (channel IN ('admin_notice', 'email', 'other')),
  note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  recorded_by TEXT NOT NULL CHECK (length(recorded_by) BETWEEN 1 AND 128),
  sent_at TEXT NOT NULL CHECK (sent_at IS strftime('%Y-%m-%dT%H:%M:%fZ', sent_at)),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  UNIQUE (tenant_id, reporting_year, kind)
);

-- A second row for the same (tenant, year, kind), plain, OR IGNORE or OR
-- REPLACE, aborts before conflict resolution (the 0046 pattern); the order
-- request → reminder_1 → reminder_2 holds, each later than the one before.
CREATE TRIGGER dac7_seller_notices_once_in_order
BEFORE INSERT ON dac7_seller_notices
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM dac7_seller_notices AS n
             WHERE n.tenant_id = NEW.tenant_id AND n.reporting_year = NEW.reporting_year
               AND (n.kind = NEW.kind OR n.notice_id = NEW.notice_id))
  OR (NEW.kind = 'reminder_1' AND NOT EXISTS (
        SELECT 1 FROM dac7_seller_notices AS n
        WHERE n.tenant_id = NEW.tenant_id AND n.reporting_year = NEW.reporting_year
          AND n.kind = 'request' AND n.sent_at < NEW.sent_at))
  OR (NEW.kind = 'reminder_2' AND NOT EXISTS (
        SELECT 1 FROM dac7_seller_notices AS n
        WHERE n.tenant_id = NEW.tenant_id AND n.reporting_year = NEW.reporting_year
          AND n.kind = 'reminder_1' AND n.sent_at < NEW.sent_at))
BEGIN
  SELECT RAISE(ABORT, 'dac7 notices are recorded once, in order');
END;

CREATE TRIGGER dac7_seller_notices_append_only_update
BEFORE UPDATE ON dac7_seller_notices
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'dac7 notices are append-only');
END;

CREATE TRIGGER dac7_seller_notices_append_only_delete
BEFORE DELETE ON dac7_seller_notices
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'dac7 notices are append-only');
END;
```

Notes for the builder:

- **Not probed on D1.** `IS NOT 'company'` inside a CHECK, the multi-clause trigger `WHEN` and the partial unique index are ordinary SQLite; the migration test proves each CHECK and trigger on the D1 test instance (one refused write per rule), as 0055's did.
- **No row = not started.** Every read treats a missing row as `state: "none"` with every field missing.
- **The verified-identity trigger** compares ciphertexts. A write that re-encrypts the same TIN with a fresh IV changes the ciphertext; the seller's route therefore writes `tin_ciphertext` only when the seller submits a new TIN (the route compares fingerprints first and leaves the column alone when equal).

#### 3.2 Migration `0057_dac7_mail_and_hold.sql` (phase A2, outline)

- `email_deliveries` gains three kinds, `dac7_request`, `dac7_reminder`, `dac7_statement` (the third for B, so the table is rebuilt once), by 0050's recipe (copy, drop, recreate with the same shape plus the kinds, re-declare its triggers and indexes; `0050_email_kinds.sql:19-38`).
- `dac7_checkout_holds(tenant_id PRIMARY KEY, held INTEGER NOT NULL CHECK (held IN (0,1)), reason TEXT NOT NULL CHECK (length BETWEEN 1 AND 500), set_by, set_at, updated_at)`, the platform's switch (§5.3). Its history is in `audit_events`. Tenant immutable.

#### 3.3 Migration `0058_dac7_reporting.sql` (phase B, outline: the shapes follow the accountant's answers)

```sql
-- Exchange rates entered by the platform (§4.5). One row per publication date.
CREATE TABLE dac7_fx_rates (
  rate_date TEXT PRIMARY KEY NOT NULL CHECK (rate_date IS strftime('%Y-%m-%d', rate_date)),
  sek_per_eur_e4 INTEGER NOT NULL CHECK (sek_per_eur_e4 BETWEEN 50000 AND 300000), -- 5.0000 to 30.0000
  source TEXT NOT NULL CHECK (source IN ('ecb', 'riksbank', 'other')),
  entered_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- trigger: no UPDATE or DELETE of a rate whose year has a filed run.

-- Sales taken on Firebase before the cutover (§3.5), one row per source order.
CREATE TABLE dac7_external_sales (
  external_sale_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  origin TEXT NOT NULL CHECK (origin IN ('firebase')),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 128),
  paid_at INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('SEK', 'EUR')),
  consideration_minor INTEGER NOT NULL CHECK (consideration_minor >= 0),
  fee_minor INTEGER NOT NULL CHECK (fee_minor >= 0),
  transactions INTEGER NOT NULL CHECK (transactions BETWEEN 0 AND 999),
  entered_by TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (origin, source_ref)
);  -- immutable; delete refused once a filed run covers its year

-- A computed year, stored. One filed run per year; a filed run is immutable.
CREATE TABLE dac7_runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  reporting_year INTEGER NOT NULL CHECK (reporting_year BETWEEN 2023 AND 2100),
  rules_version TEXT NOT NULL,        -- the decision set the math applied (§4)
  state TEXT NOT NULL CHECK (state IN ('computed', 'filed', 'superseded')),
  computed_at TEXT NOT NULL, computed_by TEXT NOT NULL,
  inputs_sha256 TEXT NOT NULL,        -- canonical JSON of the order facts, external sales, rates, profiles read
  fx_rates_sha256 TEXT NOT NULL,
  seller_count INTEGER NOT NULL, reportable_count INTEGER NOT NULL,
  filed_at TEXT, filed_by TEXT, filing_reference TEXT,
  statements_published_at TEXT,
  CHECK ((state = 'computed') = (filed_at IS NULL))
);
CREATE UNIQUE INDEX dac7_runs_one_filed_idx ON dac7_runs(reporting_year) WHERE state = 'filed';
-- triggers: computed → filed | superseded; filed → superseded only in the batch
-- that files another run of the same year (a correction filing); facts immutable;
-- no delete.

CREATE TABLE dac7_run_sellers (
  run_id TEXT NOT NULL REFERENCES dac7_runs(run_id),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  seller_group TEXT NOT NULL,         -- 'tin:<fingerprint>' or 'tenant:<id>'
  profile_state TEXT NOT NULL CHECK (profile_state IN ('none', 'draft', 'submitted', 'verified')),
  profile_snapshot_json TEXT NOT NULL, -- the clear fields + tin_last4 + the ciphertexts, as read
  transactions INTEGER NOT NULL, consideration_minor INTEGER NOT NULL, fees_minor INTEGER NOT NULL,
  consideration_eur_cents INTEGER,     -- NULL when an order had no usable rate or currency
  group_transactions INTEGER NOT NULL, group_eur_cents INTEGER,
  verdict TEXT NOT NULL CHECK (verdict IN (
    'reportable', 'excluded_de_minimis', 'excluded_entity', 'no_activity', 'needs_review')),
  PRIMARY KEY (run_id, tenant_id)
);
CREATE TABLE dac7_run_quarters (
  run_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
  quarter INTEGER NOT NULL CHECK (quarter BETWEEN 1 AND 4),
  transactions INTEGER NOT NULL, consideration_minor INTEGER NOT NULL, fees_minor INTEGER NOT NULL,
  PRIMARY KEY (run_id, tenant_id, quarter),
  FOREIGN KEY (run_id, tenant_id) REFERENCES dac7_run_sellers(run_id, tenant_id)
);
-- both immutable, no delete; Σ quarters = the seller row (trigger or test).

CREATE INDEX orders_tenant_paid_idx ON orders(tenant_id, paid_at);
```

#### 3.4 Tenant scoping

Every table carries `tenant_id` (immutable by trigger), and every query of a seller route names the principal's tenant (`principal.tenantId`, the `X-Shop-Id` checked against the session's memberships, `routes/legal-admin.ts:86-87`). The platform routes refuse any request that carries `X-Shop-Id` (D70, `DECISIONS.md:103`; `routes/legal-platform.ts:56-64`). The only cross-tenant read is the platform's: the list and the run, which group by `tin_fingerprint`. A fingerprint never leaves the Worker.

#### 3.5 The archived rows

| Archive | Count | What happens |
|---|---|---|
| `dac7Sellers` (`MIGRATION_MANIFEST.md:77`) | 1 | **Entered by hand** (DAC18). The operator reads `archive/firebase/dac7Sellers/` in the private bucket and either types it into the platform's editor (audited `dac7.profile.platform_edit`), or asks the seller to fill in the page and compares. Reasons: one document; its single `address` string must be split by a person; its `taxId` must be encrypted by the Worker, so an offline transform would need the key on the operator's machine; and after the first production order no import run may start (`0052_import_run_kinds.sql:80-92`). `restore-archive.mjs` keeps refusing the collection (`:89-94`). Before the cutover, check whether its `reported[]` holds an entry (not verified): if it does, a filing happened from Firebase and its year belongs in the platform's records. |
| `dac7CorrectionRequests` (`:76`) | 0 | Nothing. The runbook's freeze count must still be 0 (one line added to the runbook: "if above 0, stop"). |
| `orders` (`:93`) | 9 today, all refunded test orders (D10) | **B:** an offline script reads the frozen export bundle's `orders` (`scripts/cf-port/migrate/lib/bundle-reader.mjs`) and writes, per shop, one row per order paid in the reporting year with the old money fields (`total`, `payment.refundedTotalSek`, the Connect fee `connect.applicationFeeAmount`, the lines' product ids, `createdAt`), applying §4's rules; the platform posts them to `POST /v1/platform/dac7/external-sales` (DAC19). The 9 test orders retain nothing and produce no row. How many real orders Firebase takes between the export of 2026-09-27 and the freeze is not known. |

### 4. The yearly figures

#### 4.1 Which orders count, and from which columns

An `orders` row exists only for a verified `payment_intent.succeeded` (`0011_orders.sql:3-8`). Per order, read: `paid_at`, `currency`, `charged_minor`, `refund_succeeded_minor`, `dispute_status`, `dispute_amount_minor`, `application_fee_minor`, `withholding_released_minor` (`0011:76,124`; `0019_money.sql:212-264`; `0028_withholding_release.sql:53`), and the number of distinct `order_items.product_id` of the order (`0011:228`).

| Question | Rule (default) | Columns | Source of the rule |
|---|---|---|---|
| Paid | every order row | — | `0011:3-8` |
| By which date | `paid_at` in the reporting year, **Stockholm time** (§4.2) | `paid_at` | Old: UTC year of `createdAt` (`aggregate.ts:73`). DAC8. Note: `paid_at` is the webhook's clock (`webhook.ts:533`, `:565-567` bind `now`), not Stripe's charge time. |
| Refunds, full and partial | subtract every refund **settled by the time of the run**; an order retaining 0 is not a sale | `refund_succeeded_minor` | Old: cumulative `refundedTotalSek` at export time (`aggregate.ts:78-83`). The status is not read: it does not follow a partial refund of a fulfilled order (`refunds.ts:118-126`). DAC9. |
| Cancelled orders | ignored as such: a cancellation moves no money (`0022:65-66`); a cancelled order without a refund keeps its consideration | — | Old: status `cancelled` excluded (`aggregate.ts:23`). DAC9. |
| Disputes | a **lost** dispute subtracts `dispute_amount_minor`; open, won, prevented and warning-closed subtract nothing | `dispute_status`, `dispute_amount_minor` | Old: ignored. DAC9. The platform-internal recovery columns (`transfer_reversed_minor`, `dispute_retransferred_minor`) are not read. |
| Discounts (CP8-DC) | already inside the charge: `total = subtotal + shipping − discount` (`0011:129`), `charged = total` (`webhook.ts:570-575`) | `charged_minor` | — |
| Shipping | included | `charged_minor` | Old: `total` included it. DAC9 (legal question). |
| VAT | included (VAT is contained in the total, `0011:127-130`) | `charged_minor` | Old: `total` included it. DAC9. |
| The platform's fee | not deducted (gross), stated separately per quarter as the ONE fee figure | `application_fee_minor − withholding_released_minor` = `netFeeMinor` (`payouts.ts:113-115`) | Old: neither deducted nor stated. DAC10, DAC11. |
| Fees of a fully refunded order | counted in its quarter's fees (the platform kept it: D9, `refunds.ts:51-53`) | same | DAC11. |
| Currency | SEK; an EUR order converts at 1; any other currency makes the seller `needs_review` | `currency` | Checkout takes the currency of the publication (`checkout.ts:549`, `:673-683`). |
| Per quarter | Q1–Q4 by Stockholm date of `paid_at` | `paid_at` | My understanding: the report wants consideration, transactions and fees per quarter (not verified against the law text; the repo's documents do not say). The old code had no quarters. |

Per order (TypeScript, pure, in `cloudflare/src/dac7/aggregate.ts`):

```
retained     = max(0, charged − refund_succeeded − (dispute_status = 'lost' ? dispute_amount : 0))
fee          = netFeeMinor(order)                    // the seller's one number
transactions = retained > 0 ? listings : 0           // listings = COUNT(DISTINCT product_id)
```

The read, per tenant, bounded (PLAN §2.7):

```sql
SELECT o.order_id, o.paid_at, o.currency, o.charged_minor, o.refund_succeeded_minor,
       o.dispute_status, o.dispute_amount_minor,
       o.application_fee_minor, o.withholding_released_minor,
       (SELECT COUNT(DISTINCT i.product_id) FROM order_items AS i
        WHERE i.order_id = o.order_id AND i.tenant_id = o.tenant_id) AS listings
FROM orders AS o
WHERE o.tenant_id = ?1 AND o.paid_at >= ?2 AND o.paid_at < ?3
  AND (o.paid_at > ?4 OR (o.paid_at = ?4 AND o.order_id > ?5))
ORDER BY o.paid_at, o.order_id
LIMIT 500
```

#### 4.2 The year and the quarters

Stockholm time is UTC+1 in winter and UTC+2 in summer; the EU switches on the last Sunday of March and of October at 01:00 UTC (a fixed rule, so no time-zone library is needed). The four quarter starts are always on the same side of a switch: 1 January is winter, 1 April, 1 July and 1 October are summer (the March switch is on or before 31 March, the October switch on or after 25 October). So for year Y:

| Quarter | From (inclusive), UTC | To (exclusive), UTC |
|---|---|---|
| Q1 | (Y−1)-12-31 23:00 | Y-03-31 22:00 |
| Q2 | Y-03-31 22:00 | Y-06-30 22:00 |
| Q3 | Y-06-30 22:00 | Y-09-30 22:00 |
| Q4 | Y-09-30 22:00 | Y-12-31 23:00 |

A pure function returns these instants; a test pins 2026 and 2027 and cross-checks them against Node's `Intl` with `Europe/Stockholm`. The Stockholm DATE of a payment (for the rate) uses the same rule.

#### 4.3 Gross or net, and the fee: the one-number rule

My understanding (not verified against the law text; the repository's documents do not state it) is that DAC7 defines "consideration" net of the platform's fees and asks for the fees separately. The old code reports gross and no fee (`aggregate.ts:5-9`, `:33-41`). The run stores both figures per quarter, so either reading can be reported without recomputing: `consideration_minor` (gross) and `fees_minor`. The default (DAC10) keeps the old meaning, gross, for the test and the report, with fees in their own column; the alternative is net = gross − fees (it can be negative for a quarter full of refunds, clamped at 0 per quarter).

**The fee is the one number the seller already sees** (DAC11): the application fee net of a released production withholding, `netFeeMinor` (`payouts.ts:113-115`), the same figure `GET /v1/admin/orders/:id` answers as `money.feeMinor` (`commerce/admin-orders.ts:244-246`). It contains the production cost the platform withholds to pay the printer (`0019:176-180`). If the accountant says only the commission is a "fee", the seller's statement would show the commission as its own figure: a "cut" figure on a shop route, which the hard rule forbids ("the seller sees one number", `admin-orders.ts:11-21`). That answer would make DAC11 a business decision for Mikael, not a builder's.

#### 4.4 The number of transactions

The owner's note says a transaction is keyed by (listing, buyer): several goods are one transaction only if offered together, by the same seller, and bought by the same buyer; Skatteverket's example "10 books in one ad bought by two buyers = 2 transactions" (owner's memory `dac7_thresholds.md`, not verified against the law text). The old code counts orders (`aggregate.ts:84`). The default (DAC12): **one transaction per distinct product in an order that retained money**. Variants of one product are one listing; one order has one buyer; the same product bought again in another order is another transaction. Refunds on Cloudflare are amounts on the order, not lines (`0019:364-388`), so a partially refunded order counts all its products (stated in the seller's statement as "antal försäljningar" without the subtlety; flagged in §11.1).

#### 4.5 The exchange rate

The threshold is in EUR, the orders are in SEK. The owner's note says each payment converts at the rate of its payment date and the results are summed, with Skatteverket's example `11 000 / 11.34 + 8 000 / 11.84 = €1,646` (not verified against the law text). The old code used one rate for the year (`aggregate.ts:88-90`; FU-3 in `stripe-review-export/MD_specs/FOLLOWUPS.md:59-94` names the gap). My understanding (not verified) is that the report states amounts in the currency paid (SEK), so the rate matters for the threshold test.

| Option | What it takes | Consequence |
|---|---|---|
| **R-a. One yearly rate, entered by the operator** (old) | one number | Simple; not the owner's per-payment rule; can flip a verdict near EUR 2,000. |
| **R-b. A daily table entered by the operator** (recommended) | The operator downloads the year's daily reference rates from the central bank's site outside the Worker and pastes them (date and SEK per EUR) into the console in January; about 255 rows a year. Each order converts at the rate of its Stockholm payment date, or the latest earlier published date within 7 days (weekends, holidays); a missing rate makes the run refuse with the dates listed. | Matches the owner's rule; no network call; every rate is visible and audited; rows are frozen once a year is filed. |
| R-c. A rate frozen on each order at payment | A rate available at payment time: a network call on the money path (no such pattern exists in the Worker: its outbound calls are Stripe, Resend, the printer and the render farm), or a table kept filled daily in advance. | Immutable per order, but a new dependency inside checkout or a daily chore; worthless for the orders already taken. |
| R-d. Stripe's figures | A SEK charge to a SEK account involves no conversion, so Stripe has no SEK→EUR figure for it (not verified). Stripe's own DAC7 product was "early access, not self-serve" in the old evaluation (`STRIPE_COMPLIANCE_REMEDIATION_PLAN.md:210`, not re-verified). | Not usable today. |

**Recommended: R-b with the European Central Bank's daily reference rate (DAC13).** The source is the accountant's call.

**The arithmetic, integer only.** A rate is stored as SEK per EUR × 10 000 (`11.4500` → `114500`). An order's EUR in cents: `eur_cents = round_half_up(retained_öre × 10 000 / rate_e4)` (öre ÷ 100 = SEK; ÷ rate = EUR; × 100 = cents; so öre × 10 000 / rate_e4). With retained ≤ 10^9 öre the product stays below 2^53. A seller's EUR total is the sum of the rounded order amounts (the rounding error is at most half a cent per order; it matters only below 30 transactions, so at most 15 cents; the owner's example rounds the final sum to whole euros). A refund converts at its order's rate (DAC13).

#### 4.6 Worked examples

The rates below are **invented for the examples**. Fees are given as the seller sees them; the split in brackets is the platform's own and never shown to the seller.

**Example 1: an individual, one shop, 2026.** Rates: 2026-03-10 `110000` (11.0000), 2026-06-02 `115000` (11.5000).

| Order | Paid (Stockholm) | Charged | Refunded / dispute | Retained | Listings → transactions | Fee (seller's one number) | Quarter | EUR cents |
|---|---|---|---|---|---|---|---|---|
| A1 tee | 2026-03-10 14:00 | 34 900 (32 000 + shipping 2 900) | 0 | 34 900 | 1 → 1 | 15 000 (2 792 commission + 12 208 production) | Q1 | 34 900 × 10 000 / 110 000 = 3 172.73 → **3 173** |
| A2 tee + hoodie, 20 % code | 2026-06-02 | 67 700 (81 000 − 16 200 + 2 900) | hoodie refunded 39 200 (settled 2026-06-20) | 28 500 | 2 → 2 | 35 416 | Q2 | 28 500 × 10 000 / 115 000 = 2 478.26 → **2 478** |
| A3 | 2026-11-20 | 50 000 | refunded 50 000; production cancelled, withholding 20 000 released (D36) | 0 | 1 → 0 | 24 000 − 20 000 = 4 000 | Q4 | — |
| A4 | 2027-01-01 00:30 (2026-12-31 23:30 UTC) | 20 000 | 0 | — | — | — | 2027 Q1 | — |

2026 totals: **3 transactions** (Q1 1, Q2 2); consideration **63 400 öre = 634,00 kr** (Q1 34 900, Q2 28 500); fees **54 416 öre** (Q1 15 000, Q2 35 416, Q4 4 000); EUR **5 651 cents = €56.51**. 3 < 30 and €56.51 ≤ €2,000 → **excluded (de minimis)**. Net of fees (DAC10's alternative): 63 400 − 54 416 = 8 984 öre.

The old code on the same orders (UTC year, status exclusion, one rate 0.087): A1, A2, A4 counted (A4 is 2026 in UTC; A3 excluded by status `refunded`) → 3 orders, gross 83 400 öre = 834,00 kr, 834 × 0.087 = €72.56.

**Example 2: the EUR boundary.** A company, 5 orders paid 2026-05-15, rate `114500` (11.4500). Each order 458 000 öre: 458 000 × 10 000 / 114 500 = 40 000 exactly → 5 × 40 000 = **200 000 cents = €2,000.00** → 5 < 30 and ≤ €2,000 → **excluded**. One order of 458 010 öre instead: 40 000.87 → 40 001 → 200 001 cents = **€2,000.01 → reportable**. One order of 458 005 öre: 40 000.44 → 40 000 → €2,000.00 → excluded (the rounding is per order, half up).

**Example 3: the count boundary.** 29 orders of one product, 10 000 öre each, rate `110000`: each 909.09 → 909 cents, total 26 361 cents = €263.61 → **excluded**. A 30th such order → 30 is not fewer than 30 → **reportable** whatever the amount (`aggregate.ts:18`, `:93-94`; old test `dac7-aggregation.test.cjs` "exactly 30"). One order of 30 different products is 30 transactions under DAC12 (reportable), 1 under the old rule.

**Example 4: one seller, two shops.** Shops C and D carry the same TIN fingerprint. C: 20 transactions, €1,200.00; D: 15 transactions, €900.00. Per shop (old) both are excluded. Per seller (DAC14): 35 transactions → **reportable**; one seller row with both shops' figures. With C 20 / €1,200 and D 9 / €900: 29 transactions but €2,100.00 > €2,000 → **reportable**.

**Example 5: a lost dispute and a cancellation.** Order X charged 40 000, dispute lost for 40 000 → retained 0, no transaction; its fee counts in its quarter. Order Y cancelled by the seller (`cancelled_at` set), never refunded, charged 25 000 → retained 25 000, counted (the old status rule would have dropped a Firebase order marked `cancelled`).

### 5. Who is reportable

#### 5.1 The test and its boundary cases

`reportable` unless one of: (a) the seller group has **fewer than 30 transactions AND at most €2,000.00** in the year (`aggregate.ts:17-19`, `:92-94`, the owner's note; not verified against the law text); (b) the platform marked the seller an excluded entity (government, listed: the owner's note names them; not verified); (c) no transaction at all (`no_activity`). `needs_review` when an order's currency is neither SEK nor EUR, or a rate is missing (the run refuses then, §7.3), or two shops share a fingerprint but not the same identity.

| Case | Result | Note |
|---|---|---|
| Exactly 30 transactions | reportable | 30 is not "fewer than 30". |
| Exactly €2,000.00, under 30 | excluded | "at most" (≤). |
| €2,000.01, 1 transaction | reportable | Old test `dac7-aggregation.test.cjs` "> EUR 2000 → NOT below". |
| Active only part of the year (opened in November, closed in June) | no proration: the year's figures as they are | The old code prorates nothing; the owner's notes say nothing; not verified. |
| A shop with several admins | one seller: the shop's legal person | The admins are not sellers. |
| Several people behind one individual-type shop | one seller per shop; joint owners register as a company or name one person | Legal question (DAC25). |
| One person, several shops | grouped by TIN fingerprint, tested once (§5.2) | DAC14. |
| A shop with no profile but above the thresholds | `reportable`, profile `none`: the export marks it "Uppgifter saknas" | The platform must act (§5.3). |
| A closed or suspended shop | included for its year | Its orders and profile are kept (`ON DELETE RESTRICT`). |

#### 5.2 Grouping a seller's shops

`seller_group = 'tin:' || tin_fingerprint` when the profile has a TIN, else `'tenant:' || tenant_id`. The test runs on the group's sums; each shop keeps its own row and quarters; the export writes one row per group with the shops listed. Two shops in one group whose clear identity differs (type, name, address) are `needs_review`. The fingerprint is never returned to any route; the console shows "Samma säljare som: {shop names}".

#### 5.3 A seller who has not supplied the data by the deadline

**The old code:** nothing but a flag. The export marks a reportable seller without a complete profile "Komplettera" and shows a red notice (`PlatformDac7.jsx:401-420`); there is no request, reminder, block or deadline anywhere.

**What I understand DAC7 to require** (not verified against the law text; the repo's documents do not state it): after the initial request and two reminders, and not before 60 days have passed, the platform closes the seller's account or withholds the consideration until the data is supplied. The owner's note gives 31 December for the due diligence (not verified).

**What this platform can enforce:**

| Option | How | Consequence |
|---|---|---|
| N1. Notice | A banner on the seller's dashboard and DAC7 page, a "Kom igång" row (`src/admin-app/adapters/onboarding.js`), and the platform's recorded requests (A1); mails (A2). | Free; required in any case. Whether an in-admin notice counts as a "request" is a legal question (DAC15). |
| N2. Block selling (a checkout hold) | `dac7_checkout_holds` read beside the legal gate: `ordersOpen` false (`storefront/public-storefront.ts:182`, `:200`) and the checkout refused with the same opaque 404 as the legal gate (`legal/legal-pages.ts:588`). The buyer sees "Butiken tar inte emot beställningar just nu" (CP9-OB's text). | Stops new consideration; the shop stays visible. The pattern exists. |
| N3. Withhold payouts | On a destination charge the money is in the seller's Stripe account at charge time (`payouts.ts:4-9`); the platform could set the account's payout schedule to manual (a new gateway call beside `updatePayoutDelay`, `connect-gateway.ts:498-507`). | Touches the seller's money; the platform terms say payouts follow Stripe's terms and that the platform does not answer for Stripe's holds (`platformTerms.js:121-124`): a contract and legal question. |
| N4. Close the account | Suspension exists (tenant status `suspended`, `0001:5`); the terms allow suspension for "annat väsentligt brott mot dessa villkor" (`platformTerms.js:192-203`), and §6 obliges the seller to supply the data (`:129-132`). | The heaviest; exists today. |

**Recommended (DAC15):** A1 builds N1 with the platform recording each request and reminder (date, channel) and the page counting down to 31 December; A2 adds the mails and N2 as a **platform-set** hold (a person decides, after the recorded steps: never automatic at a date, because whether the steps were met is a legal judgement); N3 is not built; N4 is used as today. Timing, if the 60-day rule holds: the first request by about 1 November, reminder 1 about three weeks later, reminder 2 by early December, the hold possible from about 31 December.

### 6. The report, and the seller's yearly statement

**The old export** (`functions.ts:385-390`): `{year, sekToEurRate, reportableCount, markedReported?, rows: [{shopId, shopName, profile, aggregate, profileComplete}]}`, and a CSV built in the browser with 12 columns (`PlatformDac7.jsx:304-322`): no address, no date of birth, no quarters, no fees.

**Options for what the platform operator gets:**

| Option | Consequence |
|---|---|
| **E1. A spreadsheet (CSV) and JSON from a stored run** (recommended) | The accountant files from it (by hand in the authority's e-service, or with their own tool). Nothing is invented. |
| E2. The authority's XML file | I could not see the authority's technical description offline (not verified which schema, which version, which channel). Building it from memory would be inventing a file format. Possible later once the description is in the repository. |
| E3. Stripe's DAC7 product | Not available as of the old evaluation (`STRIPE_COMPLIANCE_REMEDIATION_PLAN.md:210`); not re-verified. |

**Recommended: E1 (DAC16).** One row per seller group: run id, year, computed and filed times, rules version, rate source; shop ids and names; seller type; names; address parts; TIN in full; TIN country; date of birth; VAT number; permanent establishments; for Q1–Q4 transactions, consideration (kr, 2 decimals) and fees (kr, 2 decimals); year totals; EUR total; verdict; profile state; "verified" yes/no. The CSV is built in the browser from `POST /v1/platform/dac7/runs/:runId/export` (audited; `Cache-Control: no-store`), as the old page built its CSV (`PlatformDac7.jsx:304-322`): every cell quoted, UTF-8. Nothing is stored server-side but the run itself.

**The seller's statement.** My understanding (not verified against the law text) is that each reportable seller must receive the information reported about them, by the same 31 January. The old code wrote `reported[]` and showed it in the seller's admin (`AdminMyTaxData.jsx:131-146`). The design (DAC17): when the platform files a run it publishes the statements; each reportable seller's DAC7 page shows "Rapporterat till Skatteverket för {år}" with exactly the reported fields: their identity as reported (TIN masked), each quarter's transactions, consideration and fees, the year's totals, the EUR total, and the date filed. The `dac7_statement` mail (A2's kind) says only that a statement is available in the admin: no figure, no identity number. A closed shop has no session (D60), so its statement is sent by the platform by hand (flagged). Excluded sellers get nothing, as before.

### 7. Routes and their contracts

Common rules, all DAC7 routes: JSON bodies; strict keys (an unknown key is `400 invalid_request`); `fields: [names]` on a validation refusal, never a value; writes are same-origin (`lib/same-origin.ts`); `404` for no session, the wrong kind of session, a foreign shop, a cross-origin write, an acting-as write; `503 dac7_unavailable` when a write or reveal needs `DAC7_DATA_KEY` and it is not set. The admin Worker passes `/v1/admin/*` and `/v1/platform/*` already (`cloudflare/admin/src/allowlist.ts:10-13`); the storefront Worker gets nothing.

#### 7.1 The seller (tenant admin of the shop; `X-Shop-Id`)

| Route | Contract |
|---|---|
| `GET /v1/admin/dac7` (an acting-as platform user may read) | `200 { state: "none"\|"draft"\|"submitted"\|"verified", profile: { sellerType, legalName, firstName, lastName, address: { line1, line2, postalCode, city, country }, tin: { saved: bool, last4, country }, dateOfBirthSaved: bool, vatNumber, permanentEstablishments: [cc] } \| null, missing: [field], settingsSellerType, sellerTypeMismatch: bool, prefill: { legalName, orgNumber, vatNumber, sellerType, addressText } , submittedAt, verifiedAt, corrections: [{ requestId, field, status, createdAt, resolvedAt, reason, valueLast4? }], notices: [{ year, kind, sentAt }], deadline: "YYYY-12-31", hold: bool (A2), statements: [{ year, filedAt }] (B), running: {…} (B) }`. Never: a full TIN, a date of birth, a ciphertext, a fingerprint, a key id, `verified_by`. |
| `PUT /v1/admin/dac7/profile` | Body: any of `sellerType, legalName, firstName, lastName, address{…}, tin, tinCountry, vatNumber, permanentEstablishments` and `submit: bool`. `tin` is write-only: absent = keep; DOB is derived from a Swedish personnummer, or `dateOfBirth` for a foreign TIN. `200` = the GET body. Refusals: `400 invalid_request {fields}`, `400 invalid_tin`, `400 invalid_vat_number`; `409 dac7_profile_incomplete {missing}` when `submit` and something is missing; `409 dac7_identity_verified {fields}` when an identity field of a verified record is in the body ("use a correction request"); `409 dac7_profile_submitted` never (a submitted record may be edited, it stays complete or the write is refused as incomplete); `429` (30 writes per hour per shop); `404` acting-as. Audit `dac7.profile.save` / `dac7.profile.submit` with field names. |
| `POST /v1/admin/dac7/corrections` | Body `{ field, value, note? }`, `field` ∈ the seven of the table. `201 { correction }`. `409 dac7_not_verified` (edit the record instead); `409 dac7_correction_pending` (one per field); `400 invalid_tin` etc.; `429` (10 per 24 h per shop). Audit `dac7.correction.create`. |
| `POST /v1/admin/dac7/corrections/:requestId/withdraw` | `200`; `409` when not pending. |
| `GET /v1/admin/dac7/statements/:year` (B) | `200` the filed statement (§6), masked TIN; `404` when none is published. |

`running` (B, DAC21): `{ year, provisional: true, transactions, considerationMinor, feesMinor, quarters: [{ quarter, transactions, considerationMinor, feesMinor }] }` for the current year, from the same per-order rules, in SEK, with no verdict.

#### 7.2 The platform, phase A (platform session; no `X-Shop-Id`)

| Route | Contract |
|---|---|
| `GET /v1/platform/dac7/sellers?cursor=` | `200 { sellers: [{ tenantId, shopName, tenantStatus, chargesEnabled, state, sellerType, name, tinLast4, missing, sameSellerAs: [tenantId], pendingCorrections, notices: { request, reminder1, reminder2 }, hold (A2), updatedAt }], next }`, every tenant (a row without a profile is `state: "none"`), 100 per page. |
| `GET /v1/platform/dac7/sellers/:tenantId` | `200` the seller view plus `excludedEntity`, `verifiedBy`, `vatWarning` (the VAT digits do not match the TIN), `settingsIdentity` (the tenant settings' name, address, org.nr, VAT, for comparison). Masked. |
| `POST /v1/platform/dac7/sellers/:tenantId/reveal` | Body `{}` or `{ reason }`. `200 { tin, tinCountry, dateOfBirth }`, `Cache-Control: no-store`. Audit `dac7.profile.reveal`. `429` (60 per hour per platform user). |
| `PUT /v1/platform/dac7/sellers/:tenantId/profile` | The seller's body plus `excludedEntity`, and a required `reason`. On a verified record the write re-stamps the verification (the platform's edit is a verification). `expectedUpdatedAt` fence: `409 dac7_stale` with the current view. Audit `dac7.profile.platform_edit`. |
| `POST /v1/platform/dac7/sellers/:tenantId/verify` | `{ expectedUpdatedAt }` → `submitted → verified`. `409 dac7_profile_incomplete` / `dac7_not_submitted` / `dac7_stale`. |
| `POST /v1/platform/dac7/sellers/:tenantId/return` | `{ reason, expectedUpdatedAt }` → `submitted → draft`; the reason is shown to the seller. |
| `POST /v1/platform/dac7/sellers/:tenantId/notices` | `{ year, kind, channel, sentAt?, note? }` → `201`. `409 dac7_notice_out_of_order` / `dac7_notice_exists` (the trigger's message). In A2 the `email` channel queues the mail in the same batch. |
| `GET /v1/platform/dac7/corrections?status=pending` | `200 { corrections: [{ requestId, tenantId, shopName, field, valueText \| valueLast4, note, createdAt }] }`. |
| `POST /v1/platform/dac7/corrections/:requestId/resolve` | `{ approve: bool, reason? }`. Approve: one batch: the record's field (a TIN: decrypt the request's ciphertext, re-encrypt under the record's AAD, last 4, fingerprint), `verified_at = now`, the request `approved`, the audit row. `409 dac7_correction_resolved` when not pending. |
| `PUT /v1/platform/dac7/sellers/:tenantId/hold` (A2) | `{ held: bool, reason }` → `200`. Audit `dac7.hold.set`. |

#### 7.3 The platform, phase B

| Route | Contract |
|---|---|
| `GET /v1/platform/dac7/fx-rates?year=` / `PUT /v1/platform/dac7/fx-rates` | GET: the rows and the year's coverage (dates with orders but no rate within 7 days). PUT: `{ source, rates: [{ date, sekPerEur }] }`, ≤ 400 rows, `sekPerEur` a decimal string with at most 4 decimals in 5–30; `409 dac7_year_filed`. Audit `dac7.fx.write` with the count. |
| `GET /v1/platform/dac7/external-sales?year=` / `POST …/external-sales` | ≤ 100 rows per call, idempotent by `(origin, sourceRef)`; `409 dac7_year_filed`. Audit with the count. |
| `POST /v1/platform/dac7/runs` | `{ year }` → computes every tenant and stores a `computed` run. `201 { run }` (counts, verdicts, no identity numbers). `409 dac7_fx_rates_missing { dates }`; `409 dac7_year_not_closed` before 1 January of the next year in Stockholm (a preview is still possible with `{ year, preview: true }`, which stores nothing). Bounded: tenants processed in pages; above 200 tenants or 20 000 orders in one call, `413 dac7_run_too_large` (a queue job is left out). Audit `dac7.run.compute`. |
| `GET /v1/platform/dac7/runs?year=` / `GET …/runs/:runId` | The run and its rows, masked. |
| `POST /v1/platform/dac7/runs/:runId/export` | `200` the rows with TIN and DOB in full, `no-store`. Audit `dac7.run.export`. `429` (as reveal). |
| `POST /v1/platform/dac7/runs/:runId/file` | `{ filedAt?, filingReference? }` → `computed → filed`; a previously filed run of the year becomes `superseded` in the same batch (a correction filing). |
| `POST /v1/platform/dac7/runs/:runId/publish-statements` | Statements visible to the reportable sellers; the mails queued. Idempotent. |

### 8. What each party sees, the pages, the Swedish texts

#### 8.1 Who sees what

| Party | Sees | Never sees |
|---|---|---|
| Seller (any admin member of the shop) | its own record (TIN masked, DOB "sparat"), its state, what is missing, the deadline, its correction requests and their outcome, the requests and reminders the platform recorded, the hold; in B its running totals and its filed statements | another shop's anything; its own full TIN or DOB; fingerprints, ciphertexts, key ids; who in the platform revealed what; the commission, the withholding, the printer's cost, any split of the fee |
| Acting-as platform user in the shop admin | the seller's view, read-only | the same as the seller |
| Platform | everything, the full TIN and DOB on an audited reveal or export | — |
| Buyer | when a hold is set: "Butiken tar inte emot beställningar just nu" | anything about DAC7 |
| Printer | nothing | everything |

#### 8.2 The seller-facing figures, and why none is platform-internal

The seller sees per year and per quarter: **transactions**, **consideration (öre)**, **fees (öre)**, and on the statement the **EUR total**. For every order, each input is a field the seller's own order view already answers (`GET /v1/admin/orders/:id`, `commerce/admin-orders.ts:235-255`):

| DAC7 input | The order view's field |
|---|---|
| `charged_minor` | `money.chargedMinor` |
| `refund_succeeded_minor` | `money.refundedMinor` |
| `dispute_status`, `dispute_amount_minor` | `money.dispute.status`, `money.dispute.amountMinor` |
| `netFeeMinor(order)` | `money.feeMinor` (the same function, `admin-orders.ts:244-246`) |
| `paid_at` | `paidAt` |
| distinct products | `items` (the shop's own catalogue) |
| the rate | public reference data entered by the platform, not a platform figure |

So every seller-facing DAC7 figure is a sum of figures the seller already sees order by order. The code proves it the same way the order view does: the seller routes select those named columns only and reduce the fee pair to `netFeeMinor` before any other use; `withheld_minor`, `commission_bps`, `production_snapshot_json`, `order_items.production_json`, `transfer_reversed_minor`, `dispute_retransferred_minor` and `connect_account_id` are never selected. Tests: `expectNoCostKeys` over every seller body (`cloudflare/test/pod-fixtures.ts:270-290`); a fixture with a distinctive withholding (`hiddenPrinter`, `pod-fixtures.ts:300`) whose figure must not appear in any seller body (the one-number walk of `test/money-followups.test.ts:371-397`); and an equality test: the running totals equal the sums over the seller's own order views of the same orders.

#### 8.3 The pages

| Old file | New | How |
|---|---|---|
| `src/pages/admin/AdminMyTaxData.jsx` (rollback build only) | `src/admin-app/pages/new/AdminTaxData.jsx` + `taxData.js`, at `/admin/skatteuppgifter` | A new admin-build page, as `PlatformPrintJobs.jsx` is (`src/admin-app/pages.jsx:51`). The fields, the states and the masking differ from the old page throughout; a data-module swap would rewrite the shared page whole and break the rollback build's callables. Wraps `<AppLayout>` with the admin components (`Page`, `Card`, `CardSection`, `Button`), as the old page (`AdminMyTaxData.jsx:14-15`, `:119-121`). |
| `src/pages/platform/PlatformDac7.jsx` (rollback build only) | `src/admin-app/pages/new/PlatformDac7.jsx` + `platformDac7Data.js`, at `/platform/dac7` | New page in the dark console with `PlatformLayout` and `platformKit.jsx`; four sections: Begärda rättelser, Säljare (list, editor, Visa, Godkänn, Skicka tillbaka, requests and reminders), and in B Valutakurser and Årsrapport. |
| — | `src/api/admin/dac7.js` (+ test) | The client calls, as `src/api/admin/discountCodes.js`. |
| — | `src/admin-app/adapters/dac7.js` (+ test) | Pure: the masks, the missing-field labels, the personnummer/org.nr/VAT checks for instant feedback (pinned to the Worker's by a test that reads the TS file, as `placeholderIdentity.test.mjs` does, `CP9_OB_REPORT.md:54`). |
| `src/admin-app/replacements/adminShellScope.js:25`, `platformLayoutData.js:29`, `shells.test.mjs:24-25`, `:69-70` | the two lines removed, the tests updated | The menu entries come back ("Mina skatteuppgifter" is renamed "Skatteuppgifter" in the admin's data, not in `AppLayout.jsx:203-206`). |
| `src/admin-app/AdminApp.jsx:32-51`, `PlatformApp.jsx:20-33`, `src/admin-app/pages.jsx` | one route and one page line each | — |
| `src/admin-app/adapters/onboarding.js` | a seventh step "Skatteuppgifter (DAC7)" | Reads `GET /v1/admin/dac7` (`state`); done when submitted or verified. |
| `src/admin-app/dev/` | a DAC7 dev API and fixtures (an individual draft, a verified company, a pending correction) | As every unit. |

No alias row in `vite.admin.config.js` is needed (new pages import the API client directly). The older build is untouched.

#### 8.4 Swedish texts (no em dash, no exclamation mark)

| Where | Text |
|---|---|
| Menu | "Skatteuppgifter" · description "Uppgifter till Skatteverket (DAC7)" |
| Page title, subtitle | "Skatteuppgifter (DAC7)" · "Uppgifter som plattformen samlar in och rapporterar till Skatteverket" |
| Intro | "Enligt EU:s regler om rapportering från digitala plattformar (DAC7) ska plattformen samla in uppgifter om dig som säljer här och varje år rapportera din försäljning till Skatteverket. Fyll i uppgifterna senast den 31 december {år}. Bara du och plattformen ser dem." |
| Deadline banner (page and dashboard) | "Fyll i dina skatteuppgifter (DAC7) senast den 31 december {år}." · link "Öppna Skatteuppgifter" |
| States | "Inte ifyllt" · "Utkast" · "Inskickat. Plattformen granskar uppgifterna." · "Granskat {datum}" · returned: "Plattformen har skickat tillbaka uppgifterna: {orsak}" |
| Type | "Jag säljer som" · "Privatperson" · "Företag" · mismatch "Säljartypen här skiljer sig från den under Inställningar ({typ}). Kontrollera vilken som stämmer." |
| Individual fields | "Förnamn" · "Efternamn" · "Personnummer" (hint "ÅÅÅÅMMDD-XXXX") · "Födelsedatum" (shown read-only: "{datum}, från personnumret") |
| Company fields | "Företagets namn" · "Organisationsnummer" (hint "NNNNNN-NNNN") · "Fast driftställe i andra EU-länder" · "Inget" |
| Shared fields | "Adress" · "Adressrad 2 (valfritt)" · "Postnummer" · "Ort" · "Land" · "Momsregistreringsnummer (om du har ett)" · "Landet som utfärdat numret" |
| Saved TIN | "Sparat: {mask}" · "Ändra" · DOB "Sparat" |
| Prefill hint | "Hämtat från Inställningar. Kontrollera att det stämmer." · address hint "Under Inställningar står: {adress}" |
| Buttons | "Spara" · "Skicka in uppgifterna" · confirm "Jag intygar att uppgifterna är riktiga." |
| Verified lock | "Identitetsuppgifterna är granskade. Vill du ändra dem skickar du en begäran om rättelse." |
| Correction | "Begär rättelse" · "Uppgift" · "Nytt värde" · "Kommentar (valfritt)" · "Skicka begäran" · "Begäran skickad {datum}. Plattformen granskar ändringen." · "Återkalla" · "Godkänd {datum}" · "Avvisad {datum}: {orsak}" |
| Notices list | "Plattformen bad om uppgifterna {datum}" · "Påminnelse {n} {datum}" |
| Hold (A2) | "Butiken tar inte emot beställningar förrän dina skatteuppgifter är ifyllda och granskade." |
| Refusals | "Personnumret stämmer inte. Kontrollera siffrorna (ÅÅÅÅMMDD-XXXX)." · "Organisationsnumret stämmer inte. Kontrollera siffrorna." · "Momsregistreringsnumret ska vara SE följt av 12 siffror, t.ex. SE556677889901." · "Fyll i {fält}." · "Uppgifterna är granskade. Skicka en begäran om rättelse för att ändra {fält}." · "Du har redan en begäran om den här uppgiften som väntar." · "Skatteuppgifterna kan inte sparas just nu. Försök igen senare." (503) |
| Running totals (B) | "Din försäljning {år} hittills" · "Antal försäljningar" · "Ersättning" · "Avgift till plattformen" · "Preliminära siffror. Det som rapporteras fastställs i januari." · "Plattformen rapporterar inte en säljare som under året har färre än 30 försäljningar och högst 2 000 euro i ersättning." |
| Statement (B) | "Rapporterat till Skatteverket för {år}" · "Lämnat {datum}" · "Kvartal {n}" · "Totalt" · "Ersättning i euro" · "Frågor om uppgifterna? Skriv till plattformen." |
| Console | "DAC7: säljare och årsrapport" · "Begärda rättelser ({n})" · "Säljare" · "Butik" · "Säljartyp" · "Namn" · "Status" · "Saknas" · "Påminnelser" · "Samma säljare som: {butiker}" · "Visa personnummer" / "Visa organisationsnummer" · "Godkänn uppgifterna" · "Skicka tillbaka" · "Orsak" · "Registrera begäran" · "Registrera påminnelse 1" · "Registrera påminnelse 2" · "Spärra kassan" / "Häv spärren" · "Momsnumret matchar inte organisationsnumret. Kontrollera." · B: "Valutakurser" · "Klistra in kurser (datum;SEK per EUR)" · "Saknade datum: {lista}" · "Årsrapport" · "Beräkna {år}" · "Ladda ner CSV" · "Markera som inlämnad" · "Publicera årsbesked till säljarna" · confirm "Markera {år} som inlämnad till Skatteverket? Säljarna med rapporterad försäljning får sitt årsbesked när du publicerar det." |
| Mails (A2/B) | request: subject "Fyll i dina skatteuppgifter (DAC7)", body "Hej. Enligt EU:s regler om rapportering från digitala plattformar behöver vi några uppgifter om dig som säljer i {butik}. Logga in och fyll i dem under Skatteuppgifter senast den 31 december {år}." · reminder: subject "Påminnelse: dina skatteuppgifter (DAC7)" · statement: subject "Ditt årsbesked för {år} (DAC7)", body "Uppgifterna som plattformen har rapporterat om din försäljning {år} finns under Skatteuppgifter i din admin." No figure and no identity number in any mail. |

### 9. Build plan

Every step: a test per rule, the gates (below), the reviewer reads the diff, Codex, attest, staging. Production never by a builder.

**Phase A1: collection (target: on staging and ready for production in October)**

1. **Migration 0056** (`cloudflare/migrations/0056_dac7_due_diligence.sql`, §3.1); `REQUIRED_MIGRATION` (`app.ts:492`); `test/health.test.ts`, `test/public-catalog.test.ts`. Test `test/dac7-migration.test.ts`: one refused write per CHECK and trigger (draft without stamps, submitted incomplete, company with a DOB, the TIN columns apart, every forbidden state transition, a verified identity change without a re-stamp, a re-stamped one accepted, a second pending request per field, a request on an unverified record, a request transition out of a resolution, any request fact changed, notices out of order, a second notice by OR REPLACE, every delete).
2. **`cloudflare/src/dac7/crypto.ts`** (HKDF from `DAC7_DATA_KEY` as `preview.ts:152-176`; encrypt, decrypt, fingerprint, mask) and `env.d.ts` (`DAC7_DATA_KEY?: string`). Tests `test/dac7-crypto.test.ts`: round trip; a ciphertext moved to another tenant, column or row fails; an unknown key id fails; no secret → null and the routes 503; the same TIN gives the same fingerprint across tenants and a different one per country.
3. **`cloudflare/src/dac7/identity.ts`** (normalise and validate personnummer, samordningsnummer, org.nr, VAT, countries; derive the DOB). Test `test/dac7-identity.test.ts` with the values of §2.3 and one wrong check digit each.
4. **`cloudflare/src/dac7/profiles.ts`, `corrections.ts`, `notices.ts`; `routes/dac7-admin.ts`, `routes/dac7-platform.ts`; `app.ts` registration.** Tests `test/dac7-admin.test.ts`, `test/dac7-platform.test.ts`: shop A cannot read or write B (404); acting-as reads, cannot write; a request with `X-Shop-Id` to a platform route is 404; the seller's bodies never contain the TIN digits, the DOB, a ciphertext prefix `v1.`, 64-hex strings or `key`; audit rows exist and their `metadata_json` holds no TIN digit; reveal and export write their audit row; rate limits; the stale fence; the resolve batch (the record, the stamp, the request, the audit row together or nothing).
5. **Frontend** (§8.3): API client, adapters, the two new pages, the routes, the menu, the checklist step, the dev API; tests for the client calls (`src/api/admin/dac7.test.mjs`), the adapters (masks, labels, the pinned validators), the shells, the checklist.
6. **Runbook and docs**: one line in `CP7_RUNBOOK.md` §9.3 (the archived record entered by hand; the freeze count of `dac7CorrectionRequests` must be 0); `RETIRED.md` keeps its rows. (A later unit edits these; this design names them.)
7. **Look at it rendered** (shop admin light, console dark; 1440 and 390 px).

Mutations for A1 (each run against the named test; restored with `cp` and compared byte for byte, as CP9-OB did):

| # | Mutation | Must be caught by |
|---|---|---|
| A-M1 | AAD without the tenant | dac7-crypto |
| A-M2 | The masked view returns the whole TIN | dac7-admin (body walk) |
| A-M3 | The seller's PUT accepts an identity field on a verified record | dac7-admin |
| A-M4 | The verified-identity trigger dropped | dac7-migration |
| A-M5 | Luhn check skipped | dac7-identity |
| A-M6 | Samordningsnummer day not reduced by 60 for the DOB | dac7-identity |
| A-M7 | Audit metadata carries the value | dac7-admin |
| A-M8 | Acting-as may write | dac7-admin |
| A-M9 | Reveal not audited | dac7-platform |
| A-M10 | Resolve applies without re-stamping `verified_at` | dac7-platform (the trigger refuses: the test expects 200) |
| A-M11 | One-pending index removed | dac7-migration |
| A-M12 | Notice order trigger dropped | dac7-migration |
| A-M13 | The fingerprint ignores the country | dac7-crypto |
| A-M14 | The admin adapter's validator drifts from the Worker's | the pin test |

**Phase A2: reminders and the hold (target: early December; needs Resend)**

8. Migration 0057 (§3.2), the three mail kinds by 0050's recipe; `src/email/dac7-email.ts` and the outbox effect; the `email` channel of the notices route queues the mail in the notice's batch.
9. The hold: read beside `isCheckoutLegallyOpen` in the storefront answer (`public-storefront.ts:182`, `:200`) and the checkout refusal (the same predicate, one place); the console switch; the seller's banner. Tests: hold → `ordersOpen` false, ETag `-x` (CP9-OB's naming), checkout 404, payment of an open checkout refused or not (decide with D48's reasoning, `DECISIONS.md:70`: the checkout row is the contract; default not refused); mails carry no identity number and no figure (a body walk).
10. Mutations: the hold ignored by `ordersOpen`; ignored by checkout; a mail with the TIN's last four.

**Phase B: the report (target: early January, after the accountant's answers to §10)**

11. Migration 0058 (§3.3) shaped by the answers; `cloudflare/src/dac7/aggregate.ts` (pure: §4.1's per-order rule, §4.2's boundaries, §4.5's conversion, §5's test and grouping). Test `test/dac7-aggregate.test.ts`: every worked example of §4.6 to the öre and the cent; the old test file's cases ported (`rules-tests/dac7-aggregation.test.cjs`); Stockholm boundaries at 2026-12-31 22:59:59.999Z / 23:00:00.000Z; refunds, lost and won disputes, a cancelled unrefunded order, a D36 release; non-SEK currency; a missing rate.
12. Rates, external sales, runs, export, file, statements: `dac7/fx-rates.ts`, `dac7/runs.ts`, `dac7/external-sales.ts`, routes; the seller's running totals and statement. Tests: the run equals the pure function over the same rows; a filed run is immutable; one filed per year; export audited; the seller's running totals equal the sums over their order views (the one-number equality, §8.2); `expectNoCostKeys` on every seller body.
13. `scripts/cf-port/dac7-firebase-sales.mjs` (reads the bundle, applies §4 to the old fields, writes the rows file outside the repo; refuses an unverified bundle as the importer does) + `scripts/cf-port/migrate/test/dac7-firebase-sales.test.mjs`.
14. The console's rates, run and export sections; the seller's statement section.

Mutations for B: `< 30` → `<= 30`; `≤ 2000` → `< 2000`; refunds not subtracted; UTC year; one transaction per order; one yearly rate; lost dispute not subtracted; per-tenant test instead of per group; the fee from `application_fee_minor` without the release; `withheld_minor` selected into a seller body; rounding down instead of half up; a filed run's row updatable; export not audited. Each must be caught.

**Gates (each phase, on the tree as delivered):** `cd cloudflare && npx tsc --noEmit && npx tsc --noEmit -p web && npx tsc --noEmit -p admin`; `npx vitest run`; `npm run types:check`; the frontend `node --test …`; `npx vite build --config vite.admin.config.js && node cloudflare/admin/check-admin-build.mjs`; `npx vite build && node cloudflare/web/check-storefront-build.mjs`; `node guard/guards.test.mjs`; `node --test "scripts/cf-port/migrate/test/*.test.mjs"` (the gates CP9-OB ran, `CP9_OB_REPORT.md:189-198`).

**Staging smoke, A1** (after the reviewer's yes; staging only): set `DAC7_DATA_KEY` on the staging API Worker through the preflight (a fresh random value, written to `~/.config/chopshop/secrets.staging.env` first); a Time Travel bookmark; apply 0056; deploy API and admin. Then, as the dry-run shop's admin at `https://chopshop-admin-stg.kent-ee2.workers.dev/admin/skatteuppgifter`: save a draft as an individual with personnummer `19121212-1212` (the page shows `Sparat: ••••••••-1212` and the derived date 1912-12-12), submit; read the D1 row with a read-only query (ciphertext `v1.k1.…`, no digits of the number in any column but `tin_last4`); open `https://chopshop-admin-stg.kent-ee2.workers.dev/platform/dac7` as the platform user: the list, "Visa personnummer" (full value; one `dac7.profile.reveal` audit row), "Godkänn uppgifterna"; as the seller, try to change the personnummer (refused with the lock text), send a correction request; as the platform, approve it (the record changes, re-verified); record a request and two reminders, and a reminder out of order (refused); as another shop's admin, `GET /v1/admin/dac7` with the dry-run shop's `X-Shop-Id` (404); as an acting-as platform user in the dry-run shop, read (masked) and write (404). Not exercised there: a second shop with the same personnummer (`Samma säljare som`), which a test covers.

**Staging smoke, B:** paste a month of invented rates; sandbox orders on the slice shop with a partial refund; compute 2026 as a preview; compute; export (audited); file and publish on staging; the seller's statement page.

### 10. Decisions for Mikael (yes/no; "defaults" accepts all). [L] = a legal question for the accountant.

| # | Decision (recommended default) | Alternative |
|---|---|---|
| DAC1 | Three deliveries: A1 collection in October, A2 reminders and hold in December, B the report in January. | One delivery in November. |
| DAC2 | The seller supplies the record in the shop admin, prefilled from Inställningar; the platform verifies and may edit. | The platform types everything (the old way). |
| DAC3 | `pullDac7FromStripe` is not ported; a read-only comparison with Stripe may come later. | Port the pull (two new gateway calls, the v2 one unproven; still no tax number). |
| DAC4 | A new Worker secret `DAC7_DATA_KEY`; the TIN and the date of birth encrypted (AES-256-GCM), a keyed fingerprint for grouping; the secret backed up outside Cloudflare. Also encrypt an individual's VAT number? Default no. | Derive from `BETTER_AUTH_SECRET`; or no application-level encryption. |
| DAC5 | The seller sees their own TIN as its last four characters only; the full value only to the platform, audited. | Every admin of the shop sees it in full (the old way). |
| DAC6 | The identity (type, names, TIN, its country, DOB) locks when the platform verifies; after that a correction request. The name is identity (the old code let the seller change it). | The old split: the name self-editable. |
| DAC7 | Ask every shop that can take payments, from the first request; DAC7 is a checklist step, not a gate before payments open. [L: may the platform collect a personnummer from a seller who ends below the thresholds?] | Required before payments open. |
| DAC8 | The year and the quarters by Stockholm time of the payment. [L] | UTC (the old way). |
| DAC9 | Consideration = what was charged, minus refunds settled by the time of the run, minus lost disputes; VAT and shipping included; a cancelled order that was not refunded counts. [L: refunds after year end; VAT; shipping] | Only refunds settled within the year; VAT excluded. |
| DAC10 | Report and test on the gross figure, fees in their own column. [L: my understanding is that "consideration" is net of fees, not verified] | Net of fees. |
| DAC11 | The reported fee is the one fee figure the seller already sees (incl. the production cost), counted for every order paid in the quarter, refunded or not. [L, and business: if only the commission counts, the statement breaks the one-number rule] | The commission alone. |
| DAC12 | One transaction per distinct product in an order that kept money (the owner's (listing, buyer) note). [L] | One per order (the old way). |
| DAC13 | Daily ECB reference rates pasted by the platform in January; each order at its payment date's rate (the latest earlier date within 7 days); refunds at their order's rate; per-order rounding to the cent; SEK and EUR only. [L: the rate source] | One rate for the year (the old way). |
| DAC14 | The exclusion test per seller, across their shops (same TIN). [L] | Per shop (the old way). |
| DAC15 | Missing data: the request and two reminders recorded by the platform (and mailed from A2); after them, a checkout hold the platform switches on by hand; no payout withholding; suspension as today. [L: what counts as a request; the 60 days; close vs withhold] | An automatic hold at a date; payout withholding through Stripe. |
| DAC16 | The accountant gets a CSV (and JSON) from a stored run; no XML. | Build the authority's XML once its technical description is in the repository; or Stripe's product. |
| DAC17 | Each reportable seller's statement in the admin, plus a mail without figures or identity numbers; a closed shop's by hand. [L: by when, and whether in-admin suffices] | A mail with the figures, or a PDF. |
| DAC18 | The one archived `dac7Sellers` record is entered by hand. | An import transform (needs the key offline; impossible after the first production order). |
| DAC19 | Firebase-period 2026 orders enter through a platform route, fed by an offline script over the frozen export. | Through the cutover's platform import (needs 0058 before the cutover). |
| DAC20 | Profiles kept while the tenant exists; filed runs 10 years; no deletion path built now. [L] | A shorter period and a deletion job. |
| DAC21 | The seller sees provisional running totals (SEK, no verdict) during the year. | Nothing until the statement (the old way). |
| DAC22 | The run reads D1 directly with bounded queries, not the R2 export PLAN §2.7 names (not built). | Build the export first. |
| DAC23 | The ciphertext is text in the row (about 60 characters), an explicit exception to PLAN §2.7's "no base64 in rows". | Ciphertexts as objects in the private bucket. |
| DAC24 | [L only] With the platform as "VAT merchant of record" (D37), are the shops the DAC7 sellers at all? The design assumes yes, as the old code did. | — |
| DAC25 | [L only] Several individuals behind one shop: one seller per shop; joint owners register a company or name one person. | — |
| DAC26 | Excluded entities (government, listed) are set by the platform only. [L: which entities] | Not modelled. |

### 11. Risks, what is left out, and what is wrong in the existing code

#### 11.1 Risks

1. **The legal rules are not verified.** Thresholds, quarters, gross or net, the fee, the count, the rate, the deadlines, the 60-day rule, the statement and the retention all come from the old code, the repository's plans or my understanding (each marked). Phase B waits for the accountant; A1 does not depend on those answers.
2. **The calendar.** If the 60-day rule holds, the first request must reach every seller by about 1 November. If the cutover slips into November, the request can go out from the Firebase page (still live, `AdminMyTaxData.jsx`) and the answers be entered by hand on Cloudflare (four shops).
3. **Losing `DAC7_DATA_KEY` loses every stored TIN.** It cannot be read back from Cloudflare. It must sit in the secrets file and one offline copy before the first write.
4. **No mail exists** (Resend is not set up, HANDOVER.md:82); A1's requests are in-admin plus whatever the platform sends by hand, and recorded.
5. **`paid_at` is the webhook's clock** (`webhook.ts:565-567`): a payment at 23:59 on 31 December whose webhook runs after midnight lands in the next year.
6. **A partially refunded order counts all its products**, because refunds are amounts, not lines.
7. **Grouping needs the TIN**: a seller who never supplies it is tested per shop.
8. **The platform's registration** with the tax authority as a reporting platform operator is a business item outside the code (the old plan says so, `functions.ts:331-333`).

#### 11.2 Left out

The authority's XML; Stripe's DAC7 product; the Stripe pull or comparison; payout withholding; an online TIN or VAT check; the financial account identifier; the place of birth; sellers outside Sweden; activities other than the sale of goods (services and rental have other rules per the owner's note); a queue for runs above 200 tenants or 20 000 orders; key rotation; deletion; a PDF statement; the closed shop's statement; the PLUS plan's monthly fee as a reported fee (there is no billing).

#### 11.3 Found wrong in the existing code

Old code (Firebase; the rollback build only, so nothing is fixed there):

| # | What | Where |
|---|---|---|
| W1 | An approved correction of `orgNumber` or `personnummer` writes a field nothing reads (completeness and the export read `taxId`). The callable accepts five identity keys; the rules only three. | `functions.ts:41`, `:205-209`, `:413-419`; `firestore.rules:458` |
| W2 | The Stripe pull stamps `verifiedViaStripe: true` whatever Stripe returned; the tax-id lines are no-ops. | `functions.ts:255-256`, `:261`, `:266` |
| W3 | The pull overwrites contact fields the seller corrected with Stripe's values. | `functions.ts:263-268` |
| W4 | Approving a `sellerType` correction does not update the shop's `storeIdentity.sellerType` (save and pull do). | `functions.ts:203-212` vs `:94-99`, `:272-277` |
| W5 | The year is the UTC year: an order in the first hour of 1 January (Stockholm) counts in the previous year. | `aggregate.ts:73` |
| W6 | One rate for the year, a placeholder `0.087` pre-filled and silently used when the field is blank. | `functions.ts:302`, `:310`; `PlatformDac7.jsx:261`, `:270-272` |
| W7 | A `cancelled` status excludes the order whatever money was kept. Ported as is, it would be wrong on Cloudflare, where a cancellation moves no money. | `aggregate.ts:23`; `0022_dispatch_state.sql:65-66` |
| W8 | A lost dispute is counted as consideration. | `aggregate.ts:71-86` |
| W9 | The exclusion test is per shop, not per seller. | `functions.ts:356-364` |
| W10 | One transaction per order, against the owner's (listing, buyer) note. | `aggregate.ts:84` |
| W11 | No quarters and no fees anywhere. | `aggregate.ts:33-41`; `functions.ts:376-383` |
| W12 | The CSV has no address and no date of birth, yet carries every full `taxId` in a downloaded file, with no audit of the download. | `PlatformDac7.jsx:304-322` |
| W13 | "Markera som rapporterad" recomputes at click time: nothing ties the CSV that was filed to the figures marked. | `functions.ts:343-391`; `PlatformDac7.jsx:299-302` |
| W14 | Every admin of a shop reads the full TIN and date of birth. | `functions.ts:130-137`; `AdminMyTaxData.jsx:154-166` |
| W15 | A requested TIN is stored and listed in clear (`requestedValue`); no limit on requests and no one-pending rule. | `functions.ts:172-189`; `PlatformDac7.jsx:52` |
| W16 | No format check of the TIN; the seller's contact correction accepts any VAT string (only the platform's editor checks it). | `functions.ts:66-73`, `:149-153`, `:413-419`; `PlatformDac7.jsx:184-197` |
| W17 | Each export loads every order of every shop. | `functions.ts:312-326`, `:353-360` |

Cloudflare side and the documents:

| # | What | Where |
|---|---|---|
| C1 | PLAN §2.7 says reporting reads nightly R2 exports; no export exists (not even the weekly backup). | `PLAN.md:89`; `D1_BACKUP_RESTORE.md:50-53` |
| C2 | The runbook says `dac7Sellers` is restored before DAC7 ports; after the first production order no import run may start, so it cannot be an import then. | `CP7_RUNBOOK.md:1324`; `0052_import_run_kinds.sql:80-106` |
| C3 | `orders.status` does not follow a partial refund of a fulfilled order: any report that reads status miscounts. Not a bug of the refunds (by design); a trap. | `refunds.ts:115-126` |
| C4 | `paid_at` equals the webhook's processing time, not the charge's. | `webhook.ts:565-567` |
| C5 | D37's wording ("VAT merchant of record") mixes card settlement and VAT, and has a DAC7 consequence nobody has asked about (DAC24). | `DECISIONS.md:59` |
| C6 | A sole trader's VAT number (which contains the personnummer) is kept in clear in `tenant_settings.vat_number` and returned to every admin of the shop. Their own data, but it is the personnummer in clear. | `0032_tenant_config.sql:66`; `tenant-config.ts:403-410` |
| C7 | The platform terms oblige the seller to supply the DAC7 data (§6), but §12's reasons for suspension do not name a failure to supply it (only "annat väsentligt brott"). For the accountant together with DAC15. | `platformTerms.js:129-132`, `:192-203` |
