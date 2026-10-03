Model: claude-opus-5-5 (Opus 5.5)

# CP5-WG — the POD server pieces for the artwork library, the mapping page and the studio

Working tree only; nothing committed, deployed or run against staging. Every claim below is one I ran.

## Files

Created
- `cloudflare/migrations/0048_pod_artwork_meta.sql`
- `cloudflare/src/routes/pod-artwork.ts`: the artwork PATCH and the failed-render answer. `handleAdminPodRoute` delegates to them; the handlers were not moved out of `app.ts`
- `cloudflare/test/pod-design-quote.test.ts` (32 tests)

Modified
- `cloudflare/src/pod/artwork-routes.ts`: the create body gains `label` and `rightsConfirmed`; new `parsePatchArtworkInput`
- `cloudflare/src/pod/artwork-store.ts`: the three columns are written and read; the summary gains `label`, `rightsConfirmedAt`, `createdBySelf`; new `renameArtwork` and `getFailedArtwork`
- `cloudflare/src/pod/pod-mappings.ts` (quote reuse only): `sellerQuoteForChoice` is now the one seller formula, and `sellerQuoteFor` goes through it; new `parseDesignQuoteQuery` and `designQuote`
- `cloudflare/src/routes/pod-admin.ts`: `ADMIN_POD_DESIGN_QUOTE_PATH` and `handleAdminPodDesignQuoteRoute`
- `cloudflare/src/app.ts`: only the `CP5-IMPORTS-G` and `CP5-ROUTES-G` blocks, plus two minimal edits inside `handleAdminPodRoute`: the GET-miss now goes to `missingArtworkResponse`, and there is a `PATCH` branch before the DELETE check
- `cloudflare/test/pod-artwork.test.ts`: the existing POST bodies now send `rightsConfirmed: true`; three direct `createArtwork` calls pass `label: null`; one audit assertion gains `rightsConfirmed: true`; 26 new tests appended
- `cloudflare/test/slice-harness.ts`: its artwork POST sends `rightsConfirmed: true`

## Routes

### (a) `GET /v1/admin/pod/design-quote?printerId=&sku=&slots=front,back`

- 200 `{ "currency": "SEK", "inkopMinor": 23571, "priceFloorMinor": 42100 }` (the test printer, tee front+back, 25 % VAT). This is the exact shape of `/quote`, and nothing else is in it.
- 400 `invalid_request` when a parameter is missing, repeated or unknown (including `productId`); when the printer id is not 1–128 characters; when the SKU does not match the SKU-key pattern; or when slots are empty, unknown, repeated or more than 5. This is the grammar of `parseCreateMappingInput`.
- 422 `{ error: { code, message: "This choice cannot be produced" } }` with one of these codes:
  - `printer_unavailable`: the printer is unknown, inactive or another shop's own; or the printer prices in another currency than the shop's (`currency_mismatch`, masked).
  - `sku_unavailable`: the SKU is not in the printer's catalogue; or it is listed with no price row (`unpriced`, masked).
  - `slot_not_printable`.
- 404, the opaque answer: no session, no `X-Shop-Id`, a shop the user does not belong to, or any method but GET.

**Why a separate path rather than extending `/quote`.** `/quote`'s refusals mean "this product": 404 is an unknown product, 422 `not_quotable` is a product with no producible mapping. A choice made before any product exists has the mapping write's refusals instead. Putting both on one path would make each refusal ambiguous. The numbers still come from one formula: `designQuote` runs the mapping write's checks in its order (usable printer → SKU in catalogue → frame per slot), then `sellerQuoteForChoice`. That function is `quotePodCost` at quantity 1, then `podPriceFloorMinor` (the D41 floor, with the parcel). It is now the only seller-quote function: `sellerQuoteFor`, which the mapping write and the product quote both use, calls it through the mapping set's routing. The shop's VAT and currency come from `tenants`, as the product quote takes them through the product's tenant join.

**Bounds.** One tenant read, one printer read and one tier read, whatever the input; the parser caps the input. There is no rate limit, as `/quote` has none.

### (b) Artwork metadata

**`POST /v1/admin/pod/artwork`** takes `{ objectId, profileId, rightsConfirmed: true, label? }`.
- `rightsConfirmed` must be literally `true`. A missing key, `false`, `"true"`, `1` or `null` is a 400 and creates nothing. Client-sent `rightsConfirmedAt` or `createdBy` keys are also 400.
- `label` may be absent or null (stored as NULL), or a string. A string is trimmed and must then be 1–120 characters with no control or line-separator characters.
- Stored: `rights_confirmed_at` is the server's `now` in the same INSERT as the row, `created_by` is `principal.userId`, and the audit metadata gains `rightsConfirmed: true`.
- The answer is unchanged otherwise (202 with the processing artwork).

**List and detail.** `GET /v1/admin/pod/artwork` and `GET …/:id` now carry `label: string | null`, `rightsConfirmedAt: number | null` (milliseconds, like `createdAt`) and `createdBySelf: boolean`. No user id appears in any answer; tests check that neither the creator's nor a co-admin's id is in the body.

**`PATCH /v1/admin/pod/artwork/:id { label: string | null }`.**
- 200 `{ artwork: <summary> }`. The summary keys are `artworkId, createdAt, createdBySelf, effectiveDpi, heightPx, label, originalObjectId, profileId, rightsConfirmedAt, status, widthPx`.
- 400 for a malformed body: `label` missing, any other key, a non-string, empty after trimming, over 120 characters, or containing a control character.
- The opaque 404 for no session, a foreign shop, cross-origin or no Origin, a malformed or unknown id, or a sub-path.
- The rename is audited as `pod.artwork.rename` in the same batch, with `{ hadLabel, hasLabel }` (not the text). `updated_at` is set to `MAX(updated_at, now)`.

**Rescreening a label: not done, by the rule in the brief.**
- No public answer carries a label. The storefront's POD fields are print areas and preview paths (`pod-mappings.ts publicPodFields`). The preview route selects only the preview key and hash (`public-catalog.ts findPublicPreview`). The old upload modal calls the field "Namn (intern etikett)".
- `catalog_version` is not bumped, and a test checks that it is unchanged.
- **Parity note (open question 2):** Firebase's `screenProductOnWrite.ts` screened both `fileName` and `label` of mapped artworks (L73) and rescreened on a label change (L221–235). CF's `screening.ts artworkFileNames` reads only the original's file name.

### (c) A failed render

No table rebuild was needed. The render job row survives a terminal failure: `render_jobs.artwork_id` is not a foreign key (0017), and `terminalFailureStatements` removes only the `processing` artwork row. So when `GET /v1/admin/pod/artwork/:id` finds no artwork row, it asks `getFailedArtwork`. That looks for a `render_jobs` row of this tenant and this artwork id in state `failed`, whose `error` is not `artwork_deleted`, with no artwork row present.

If there is one, the answer is 200 `{ "artwork": { "artworkId": "…", "status": "failed", "reason": "render_failed" }, "previewUrl": null }`. Otherwise it is the opaque 404, as before.

The job's own error code (farm codes, `lease_expired`, `outputs_unverified`, …) is not handed out; there is one coarse reason. Unchanged:
- A failed id is not in the list.
- PATCH and DELETE on it are 404.
- Re-posting the same body works, so a replay is still the retry.
- An artwork its admin deleted while it was processing reads 404, not failed.

When a future retention sweep purges old terminal jobs, such an id simply becomes 404 again.

## Migration 0048 and staging's rows

`ALTER TABLE pod_artwork ADD COLUMN`:
- `label TEXT CHECK (NULL or 1–120 characters and = trim(label))`
- `rights_confirmed_at INTEGER CHECK (NULL or > 0)`: integer milliseconds, following 0012's `created_at`/`updated_at` (rule 7)
- `created_by TEXT CHECK (NULL or 1–128 characters)`: deliberately not a foreign key, so removing a user is never blocked by this record and never rewrites it

There is also a trigger, `pod_artwork_rights_immutable`: once set, `rights_confirmed_at` and `created_by` cannot be changed or cleared by an UPDATE. Tested.

**Staging after the migration.** I could not read staging (no network). By construction, every existing `pod_artwork` row gets NULL in all three columns. The routes answer those rows as `label: null`, `rightsConfirmedAt: null`, `createdBySelf: false`. Nothing is backfilled: a confirmation that was never given is not invented. Per HANDOVER, melodie-mc's artworks were not imported, so the rows there are whatever the slice seed script created.

## Printer fields (rule 15, Unit FC's finding)

**`GET /v1/admin/pod/printers`** returns per printer, built field by field (`printers.ts tenantPrinterView`):
- `printerId`
- `name`
- `garments`
- `provisionalAreas`
- `capabilities.models[key] = { garment, name?, printAreasMm: { slot: { w, h, offsetTopMm? } }, provisional? }`
- `capabilities.skus[sku] = { label?, model }`

**`GET /v1/admin/pod/mappings`** returns per mapping, also built field by field (`pod-admin.ts tenantMapping`):
- `artworkId`, `createdAt`, `mappingId`, `printerId`, `productId`, `sku`
- `slots[{ slot, widthMm, heightMm }]`
- `status`, `suspendedReason` (masked)
- `updatedAt`, `variantId`

**Verdict: nothing leaks a cost, tier, job reference or internal note, and nothing was removed.** The existing walk (`printers-platform.test.ts`, every key and value against the hidden figures) covers both answers, and my new walk covers the design quote.

`printerId` is what a seller must send back: on `POST /mappings` and on `/design-quote`. Without it the seller cannot pick a printer. It is the `printers.id` value, a readable slug rather than an opaque token: `fake-printer` on staging, and in production the supplier's own name. It tells the seller nothing that `name` does not already say; the same goes for the catalogue SKUs, which are the supplier's article numbers. If rule 15's "a printer's internal id" is meant to hide which supplier prints, both `printerId`/`name` and the SKU keys would need an alias layer: a schema change, not done (open question 1). The denylist was not extended, because nothing leaks.

## Tests and gate

Refusals come first in both new suites, then the happy paths:

- **Design quote**
  - no session, no `X-Shop-Id`, a foreign shop
  - 4 wrong methods
  - 14 malformed queries
  - unknown, foreign-owned and inactive printers
  - an unlisted SKU, a missing frame
  - the masked `unpriced` and `currency_mismatch`, with the precise codes asserted on the function
- **Artwork creation**
  - the old body, `false`, `"true"`, `1`, `null`
  - bad labels
  - client-sent time or creator
  - cross-origin
- **PATCH**
  - no session, a foreign shop (three ways), cross-origin, no Origin
  - malformed ids, a sub-path, an unknown id
  - 9 bad bodies
  - other methods
- **One formula:** a product is mapped to the same choice for 4 SKU/slot sets, and the design quote is asserted `toStrictEqual` to the product's `/quote`. This is repeated at a changed tenant VAT, and checked against `quotePodCost` + `podPriceFloorMinor` over the hidden figures.
- **One-number walk:** `expectHandHidden` with `hiddenPrinter()`'s distinctive figures, over every design-quote answer (success and each refusal), for a tenant session and an acting-as session.
- **Failed render:** three real farm failures, then the poll answers `failed`; plus the foreign shop / no session, list / PATCH / DELETE, replay, deleted-while-processing, and unknown-id cases.

Gate as run:
- `cd cloudflare && npx tsc --noEmit`: clean.
- `npx vitest run`: `Test Files  99 passed (99)` / `Tests  4222 passed (4222)`. New: `pod-design-quote.test.ts` 32, `pod-artwork.test.ts` 106 → 132.
- `node guard/guards.test.mjs` (repo root): `guard: PASS`. My new files are untracked, so the guard does not scan them yet; a manual grep of every file I touched for both forbidden families finds nothing.

## Deviations

1. **The handlers were not moved out of `app.ts`.** `handleAdminPodRoute` keeps its gate, guards and id parse, and delegates the two new answers to `routes/pod-artwork.ts`. It is the smaller, behaviour-identical change the brief allows.
2. **`label` is optional on create** (absent or null means none). The brief listed it among the body's keys but did not say it was required. The old modal falls back to the file name, and requiring it would refuse uploads where the seller typed nothing.
3. **PATCH answers the summary, not the full detail**, so the rename answer carries no sha or byte fields; the detail GET still has them.
4. **The rename's audit row** is a plain INSERT in the same batch. If the row vanishes between the read and the UPDATE, the route answers 404 but the audit row remains. This is harmless and matches how the artwork delete audits.

## Not done

- No label rescreen; see (b) and open question 2.
- No `failed` artwork status; none was needed.
- No rate limit on the design quote.

## Open questions

1. **Supplier identity.** Should a seller see which supplier prints (`printerId`/`name` and the supplier's SKU keys)? Today they do, on both `/printers` and `/mappings`.
2. **Label screening parity with Firebase.** Firebase screened the artwork label and rescreened on rename. If that should hold here, `screening.ts artworkFileNames` (not my file) must also read `pod_artwork.label`, and `renameArtwork` must then rescreen the products whose live mappings name the artwork, through `screeningStatementsFor`.
3. **What a sequence of quotes reveals.** Any per-choice quote lets a seller difference two answers: inköp(front+back) − inköp(front) = the back print price, and two SKUs differ by their blank. The product quote with mapping juggling already allows this, and so did Firebase's `quotePodCost`. It cannot be closed without dropping the per-choice number. A rate limit would not stop a derivation that needs three calls. This is noted for the rule-15 owner, not acted on.

## Reviewer wiring

1. **`REQUIRED_MIGRATION`** in `cloudflare/src/app.ts` and its two tests (`test/health.test.ts:36`, `test/public-catalog.test.ts:572`): move it to `0048_pod_artwork_meta.sql` once 0047 (the other unit's) is in. The routes read the new columns, so a Worker without 0048 applied would fail every artwork list and detail.
2. **`scripts/cf-port/seed-staging-slice.mjs:682-683`**: its `POST /v1/admin/pod/artwork` sends `{ objectId, profileId: PROFILE.profileId }` and will now get 400. It needs `rightsConfirmed: true` (and optionally a `label`). This is the only script that sends the old body. The in-repo test callers (`test/pod-artwork.test.ts`, `test/slice-harness.ts`) are already updated.
3. **The frontend (unit FM).** `ArtworkUploadModal` must send `rightsConfirmed: true` from its rights box and `label` from its "Namn" field. A failed poll now reads `{ artwork: { status: "failed", reason: "render_failed" } }` instead of a 404. The library reads `label`/`createdBySelf`; studio pages use `/v1/admin/pod/design-quote`.
4. **Nothing needed** in `wrangler.jsonc`, `env.d.ts` or `vitest.config.ts`. The admin Worker's allowlist already passes `/v1/admin/` and therefore `/v1/admin/pod/design-quote`.
