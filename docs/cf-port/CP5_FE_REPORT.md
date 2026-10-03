Model: claude-opus-5-5 (Opus 5.5)

# CP5-FE report: settings and the legal adoption

Built on `cf-port` in the working tree, while other units worked in it too. No git command that writes, no network, no wrangler, no deploy. The older build's dev server was not started.

## (a) What leaves the page, control by control

| Control | Why it leaves | How, in this build |
|---|---|---|
| "Övergiven kassa": the delay field and its "Spara" button | Cart recovery is not ported (D81) | The section renders only when `isEnabled('abandonedCheckout')`, and the API sends `false`. The page is not edited for this. `loadCartRecovery` answers `{}` and `saveCartRecovery` refuses (FA's replacement). |
| "Recensioner": the delay field and its "Spara" button | Reviews are not ported (D81) | Same mechanism: `isEnabled('productReviews')` is `false`. |
| "Redigera texten själv" → a CMS page on the legal slug (`pages` write, `published`), then the page editor | D79: a legal page is not a content page | The button stays. In this build it seeds the seller's own text into the identity (`legal.customTexts[key]`) and opens it on this page. No `pages` write. |
| "Redigera" → `/admin/pages/:id` | Same | The button stays. It opens or closes the text on this page. |
| "Återgå till plattformens mall" → sets the CMS page back to `draft` | Same | The button stays. It clears `legal.custom[key]`; the draft text is kept. |
| "Publicera din egen text först" (refusal of an unpublished CMS page) | No CMS page exists | Never raised in this build. A draft shown on the page is what gets adopted. |
| "Förhandsgranska" → the storefront's legal page | The storefront shows only the ADOPTED snapshot (D79), so before adoption it has nothing to show | The link stays. In this build its click opens the text inline (the same strings the adoption sends). |

**Made read-only (D99), not removed.** Butiksnamn, Support-e-post and Moms keep their markup. Valuta is also read-only: it is a refused identity key, which goes one step past D99's three fields. Each gets `readOnly` plus one helper line in the page's `helpCls` style: "Sätts av plattformen och kan inte ändras här." `saveShopConfig` never sends these fields.

**How each file reaches the new data layer.**

| File | Approach |
|---|---|
| `src/pages/admin/AdminSettings.jsx` | The inline Firebase calls moved verbatim into a data module beside the page, `src/pages/admin/adminSettingsData.js`, which is the older build's implementation. The admin build aliases it to `src/admin-app/replacements/adminSettingsData.js`. The page imports neither Firebase nor the API client. |
| `src/utils/legalAcceptance.js` | Unedited. Aliased to `src/admin-app/replacements/legalAcceptance.js`. |
| `src/config/shopConfig.js` | Unedited. FA's existing alias. `saveShopConfig` is implemented in `src/admin-app/replacements/shopConfig.js`. |
| `src/components/admin/PickupLocationsEditor.jsx` | Unchanged. It has no data layer: it is a controlled component, and its value goes through the same PUT. |

Both data modules export the same names. The ones the two builds really differ on are:
- `LEGAL_TEXTS_IN_SETTINGS`: `false` in the old module, `true` in the new.
- `PLATFORM_OWNED_FIELDS`: `[]` in the old module, the four fields in the new.

With `false` and `[]`, the older build renders and behaves as before. No `readOnly` attribute, no `onClick` and no inline block appear. Its readiness is computed from the form, and its take-over, revert and acceptance follow the CMS-page flow.

## (b) What works against the dev API

| Flow | What I observed |
|---|---|
| Load | Identity from `GET /v1/admin/settings` and `GET /v1/admin/shop`. Legal state from `GET /v1/admin/legal/status` and `GET /v1/admin/legal/pages`. |
| Readiness banner | Driven by the server's gate, re-read after every save and every adoption. It shows the three blockers for a new shop and none for a ready shop. |
| Save | "Spara butiksinställningar" is a read-modify-write. Verified: no platform key in the body, and the gate fields sent at the top level. |
| Take-over | Seeds the template into an editor on the page. A text saved earlier is never overwritten. |
| Draft edits | Saved when the field is left: `legal.customTexts[key]` plus `customUpdatedAt`. Nothing is written when the text is unchanged. |
| Adoption with the default texts | 201. Readiness becomes ✓. |
| Adoption with a custom text | 201, with `custom.angerratt: true`. I hashed the preview's `innerHTML` and the sent `angerratt` text: the preview equals the sent string, and the sent string's SHA-256 equals the adopted `pageSha256.angerratt`. |
| A refused custom text | 400. The refusal is shown under that text (`text-admin-critical-text`) and as a toast. Editing the text clears the refusal. |
| Re-adoption notice | Appears when an own text no longer matches what was adopted, compared by SHA-256 with no clock involved. It also appears for a newer template version, or a page switched between template and own text. It disappears when the edit is undone. |
| Acting-as | The adopt button is disabled. Its reason line reads: "Endast butikens egen administratör kan godkänna villkoren, inte plattformen för butikens räkning." Save, take-over and preview still work, as the API allows an operator to do them. |

### The adoption request, exactly as sent (captured in the browser)

```
POST /_api/v1/admin/legal/accept-pages
accept: application/json
content-type: application/json
x-shop-id: test-shop-c
{ "templateVersion": "2026-09-07",
  "texts": { "kopvillkor": "<h1>Köpvillkor – Test Shop C</h1>…",     (6256 chars)
             "angerratt": "<p>Egen inledning.</p>\n<h1>Ångerrätt…",  (3605 chars, the seller's own)
             "integritetspolicy": "<h1>Integritetspolicy – Test Shop C</h1>…" },
  "pod": false,
  "custom": { "kopvillkor": false, "angerratt": true, "integritetspolicy": false } }
```

Where each value comes from:
- **`texts`**: the strings the page shows, one memo (`shownTexts`).
  - A template page is `renderLegalPage(slug, form, {pod})`, which is markdown-it plus the real DOMPurify.
  - A custom page is `DOMPurify.sanitize(draft)`.
  - The preview is `dangerouslySetInnerHTML={{__html: shownTexts[key]}}`, with no second transformation.
- **`templateVersion`**: `LEGAL_TEMPLATE_VERSION`.
- **`pod`**: `isEnabled('pod')`, the shop's entitlement from `/v1/admin/shop`.
- **`custom`**: the per-page map. A key is `true` exactly when its text is the seller's HTML. The route takes this map form as well as a boolean.

`acceptPagesBody` refuses to build anything but exactly these four keys, three non-empty texts and a valid version. A malformed body is refused before anything is sent.

The order of requests is:
1. The identity is saved first (PUT, read-modify-write), as the older build saved it first.
2. Then the POST.
3. Then the status and the adoption are re-read.

The identity saves are queued per tab, so leaving a text field and then clicking adopt makes two PUTs in order, never a race. That was observed: PUT, PUT, POST.

Errors map to Swedish messages:

| Answer | Message |
|---|---|
| 400 `invalid_request` with custom pages | The refusal, laid at those pages |
| 400 `invalid_request`, no custom page | "Villkoren kunde inte godkännas: förfrågan avvisades." |
| 413 | "Texterna är för långa för att kunna sparas." |
| 429 | "…Försök igen om N min." (from `Retry-After`) |
| 404 | "Endast butikens egen administratör kan godkänna villkoren." |

## (c) The lost-update window of `saveShopConfig`

`saveShopConfig(patch, shopId)` works in three steps:
1. `GET /v1/admin/settings`.
2. Build the body with `settingsPutBody(current, patch)`:
   - The patch's identity keys are merged into the stored identity as Firestore's `merge: true` did: plain objects key by key at every depth; arrays, scalars and null replace.
   - Refused keys are dropped, both the platform's and `legal.acceptance`.
   - The four gate keys are lifted to top-level fields.
3. `PUT` the whole identity.

There is no lock. Four exposures:

1. **Between the GET and the PUT (one round trip).** A write by anyone else that lands in between is overwritten: another tab, another admin, an acting-as operator, or AdminStorefront/AdminMenu in another tab. This is the new window. Saves made by the same tab are queued and do not lose each other.
2. **The keys the form holds.** The page sends every key of its form (the STORE defaults plus what it loaded), each with its value from page load, as the older build did with Firestore's merge. So a key that another page changed after this page loaded is reverted on "Spara butiksinställningar". `accent`, `theme` and `templateId` from AdminStorefront are examples. This is parity with the older build, not new.
3. **The keys the form does not hold** (`menu`, `logoObjectId`, `gallery`, …). These are exposed only to window 1.
4. **The gate fields.** These are columns, and the last write wins, as before.

A later Worker unit's guarded PATCH closes window 1. Window 2 would close if the page sent only the keys it changed. That is a page change, not made here.

## Gate

```
node --test src/api/*.test.mjs src/api/admin/*.test.mjs "src/admin-app/**/*.test.mjs" src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs
  # tests 349  # suites 99  # pass 349  # fail 0      (mine: 31 — adapters/settings 20, api/admin/settings 8, dev-api-settings 3)
npx vite build --config vite.admin.config.js
  ✓ built in 7.94s
node cloudflare/admin/check-admin-build.mjs        (with AdminSettings swapped in, FB's shell in the build)
  admin build: 11 files (7 text) checked, no Firebase code, no source map, no secret, every file servable.
node cloudflare/web/check-storefront-build.mjs
  storefront build: 11 files (7 text) checked, no Firebase code, every file servable.
npx vite build
  ✓ built in 15.08s
node guard/guards.test.mjs
  guard: FAIL  (b) 9 stale guard/allowlist.txt entries
```

The guard fails on stale entries only.
- Eight of the nine are other units' files: CredentialLanguageSwitcher, PlatformTermsGate, ShopPicker, PlatformLayout, AdminOrderDetail, AdminPayments, AdminPlatformTerms, AdminProducts.
- The ninth is `src/pages/admin/AdminSettings.jsx`. That one is mine and expected: it no longer imports Firebase, and I replaced the one earlier-brand word in a code comment with "the default shop". See "Reviewer wiring".

My new files are untracked, so I checked them myself against the guard's three families. The only match is the Firebase import of `src/pages/admin/adminSettingsData.js`. That module is the older build's implementation by design.

No Worker file was touched, so the Worker gate was not run.

## What I looked at

**Setup.** Screenshots are under `/private/tmp/fe-shots/`.
- I used a scratch Vite config outside the repo. It wraps `vite.admin.config.js`, adds `server.watch` ignored, and swaps my page line before I swapped it for real.
- Watching had to be turned off: other builders' edits to `dev-api.mjs` and `vite.admin.config.js` kept restarting the dev server, which wiped the in-memory state.
- I used my own browse daemon instance (`BROWSE_STATE_FILE`). The shared one was being driven by another builder at `:5182`.
- My first few commands went to the shared daemon before I noticed: a viewport change to 1440×900, a navigation to my `:5183`, a sign-in and a select that timed out. They may have disturbed that builder's session.

**Bare, before the shell was in:**
- **Test Shop C, nothing set** (`c-empty-*`): 1440 and 375, light and dark. The caution banner lists the server's three blockers. The adopt button is disabled with "Kan inte godkännas ännu: …". No horizontal scroll at 375 (scrollWidth 375).
- **The flow:** save (`c-preview-template-1440-light`), template preview, take-over with the editor (`c-custom-editor-1440-light`, `c-custom-editor-375-dark`), refused custom text (`c-custom-refused-1440-light`), adoption (`c-adopted-1440-light`).
- **Test Shop A, fully ready** (`a-ready-*`): 1440 and 375, light and dark. ✓ banner, "Godkänn på nytt", the read-only fields with their helper line.
- **Acting-as** (`acting-as-1440-light`): the disabled button with its reason.

**Inside FB's shell, after it was in:**
- `shell-a-1440-light` and `shell-a-1440-dark`, `shell-a-375-light`.
- Acting-as with the banner: `shell-acting-top-1440`, `shell-acting-button-1440`.
- No console errors besides the React Router flag warnings and the expected 401s of `/v1/me` before sign-in.

**What I saw:**
- In dark mode the green ✓ banner keeps its light mint background. The status tokens have no dark overrides yet; this predates this unit and is not mine.
- The preview uses `LEGAL_DOC_TYPO`, the admin's legal typography from PlatformTermsGate. A template's `# Title` shows as body-size text, as on AdminPlatformTerms.

## Deviations from the brief

1. **Where the custom text lives.** The brief says the text "is kept in `storeIdentity.legal.custom`". I keep `legal.custom[key]` as the per-page boolean flags, as before, and put the text in `legal.customTexts[key]`.
   - The flag map is exactly what accept-pages takes as `custom`.
   - Imported identities carry those flags as booleans.
   - The route allows any `legal.*` key except `acceptance`.
2. **New markup, minimal, existing classes and tokens only.**
   - Below each legal row, when it is opened (this build only): a `Din text (HTML)` textarea for an own text (`labelCls`/`inputCls`), a helper line or the refusal line, and the preview box (AdminPlatformTerms' box classes plus `LEGAL_DOC_TYPO`).
   - The "Förhandsgranska" `onClick`.
   - The acting-as reason in the existing reason paragraph.
   - The read-only helper lines.
   - New copy:
     - "Sätts av plattformen och kan inte ändras här."
     - "Din text (HTML)"
     - "Sparas när du lämnar fältet. Det som visas nedan är det som godkänns."
     - The refusal line.
     - The acting-as reason.
     - The error messages listed in (b).
     - The banner label "Plattformsvillkoren är inte godkända": the checkout's gate also needs the platform terms (`checkout.ts`), so the banner would otherwise say ✓ while checkout is closed.
3. **A custom text is sent as DOMPurify leaves it**, because that is what the page shows. A text the seller typed with `<script>` is shown, and sent, without it. The Worker's stricter check still refuses what DOMPurify keeps, for example a `data:` image.
4. **Valuta is read-only too**, beyond D99's three: `currency` is a refused identity key.
5. **`saveShopConfig` merges at every depth, as Firestore did**, not "the changed top-level keys" only. Callers pass narrow `legal` patches (this page, AdminPageEdit), and a top-level replace would drop the other `legal` leaves.
6. **The banner reads the server and the adopt button reads the form.** The banner is the checkout's gate as saved. The adopt button stays gated by the form's return address and VAT answer, as before, because the adoption saves the form first.
7. **One earlier-brand word was removed from a code comment** of AdminSettings.jsx, for the guard (no copy).
8. **Dev API.** My `GET /v1/admin/settings` row sits ahead of FA's identical row in `ADMIN_ROUTES`, so written settings are read back. FA's row is left in place, shadowed. I added Test Shop C and the user `admin-c@example.com` / `dev-password-4`, and `legal` fixtures for shops A and C. I did not add a membership to the existing admin user, so FA's single-shop resolution stays as it is.

## Open questions

1. **Who signed.** `GET /v1/admin/legal/pages` names no person. After a reload the page reads "Godkända av 2026-10-01 11:30:00 · mallversion …"; right after an adoption it shows the signer's address. Should the Worker add the signer's `email` to the view? The column exists.
2. **Which text was refused.** `accept-pages` answers the same 400 for a malformed body and for refused HTML, without naming the page. The page lays the refusal on every custom page; the templates pass the check (staging-legal adopts them unchanged). A `{code: 'html_refused', page, reason}` answer would be exact.
3. **Identity changes after adoption.** With D79 the shop shows the adopted snapshot, so a new return address reaches the public pages only after re-adoption. The re-adoption notice cannot compare a template page's text, because it carries its render date. Should the identity fields the templates read be compared instead?
4. **Copy that is no longer true here.** The revert's confirm and toast ("Plattformens mall visas igen") are only true after the next adoption; the re-adoption notice says so on the page. The adoption toast "Kassan är nu öppen" holds only if the platform terms are accepted too. Kept per rule 17; change them?
5. **A removed branding image blocks every save.** The read-modify-write sends the stored `logoObjectId` back. If that object was removed (D93), the PUT is refused (`unreferencable_images`) until the image is fixed on the Butik page. Should the Worker ignore unchanged references?
6. **The platform-terms functions of the `legalAcceptance` replacement.** `hasAcceptedCurrentPlatformTerms` and `recordPlatformTermsAcceptance` refuse (`not_available`). No file imports them from this module; FB uses `platformTermsData.js` and `src/api/admin/legal.js`.
7. **FA's alias row for `shopConfig`** still says "the save refuses until FE/FG …". That row is FA's; I did not edit it.

## Reviewer wiring

- **`guard/allowlist.txt`.** Remove `src/pages/admin/AdminSettings.jsx`: it is stale now. Add `src/pages/admin/adminSettingsData.js` when it is tracked: it carries the older build's Firebase import, by the brief's own pattern. That is one line out and one in, so the baseline is unchanged. The allowlist header says "never add a line", so this needs the reviewer's decision. FF's `adminPaymentsData.js`, FC's data modules and FB's `platformTermsData.js` are in the same position.

## Files

Created:
- `src/api/admin/settings.js`
- `src/api/admin/settings.test.mjs` (also tests `legal.js` and `saveShopConfig`)
- `src/api/admin/legal.js`: created with my legal-pages section; FB then added its platform-terms section above it
- `src/admin-app/adapters/settings.js`, `src/admin-app/adapters/settings.test.mjs`
- `src/admin-app/replacements/adminSettingsData.js`
- `src/admin-app/replacements/legalAcceptance.js`
- `src/pages/admin/adminSettingsData.js` (the older build's data module)
- `src/admin-app/dev/dev-api-settings.test.mjs`
- `docs/cf-port/CP5_FE_REPORT.md`

Modified:
- `src/pages/admin/AdminSettings.jsx` (data layer, plus the markup listed in deviation 2)
- `src/admin-app/replacements/shopConfig.js` (`saveShopConfig`)
- Shared files, my lines only:
  - `vite.admin.config.js`: 2 alias rows.
  - `src/admin-app/pages.jsx`: the AdminSettings line.
  - `src/admin-app/dev/dev-api.mjs`: `SETTINGS_LEGAL_ROUTES`, spread first into `ADMIN_ROUTES`, and `createHash` imported.
  - `src/admin-app/dev/fixtures.json`: shop A's `legal`, shop C, the user `admin-c`.

`src/components/admin/PickupLocationsEditor.jsx` is unchanged. `src/admin-app/dev/dev-api.test.mjs` shows changes that are not mine.
