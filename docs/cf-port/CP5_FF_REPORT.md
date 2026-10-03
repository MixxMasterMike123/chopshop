Model: claude-opus-5-5 (Opus 5.5)

# CP5-FF report: Payments (`AdminPayments`)

Built in the working tree on `cf-port`. No git command that writes, no network, no wrangler, no deploy. The older build's dev server was not started.

## (a) What leaves the page, control by control

| Control | Admin build | Why |
|---|---|---|
| **The balance block**: the "Saldo & utbetalningsrisk" section with `BalancePanel` (Tillgängligt, Väntande, Reserverat, the negative-balance warning, "Uppdatera saldo") | **leaves** for everyone | No route: `getConnectBalance` has no port (CP3_F_REPORT deviation 8, "No balance read"; gap analysis §2b, WF nice-to-have). The page gates the block on the data module's `BALANCE_READ` (false in this build), so terser drops `BalancePanel` from the bundle. |
| The payout-delay editor | **stays, platform user only**, in its own section | It lived inside `BalancePanel`. Without the balance it is rendered by a small `PayoutDelayPanel` that reads the current delay from `GET /v1/platform/tenants/:id/connect` and writes with `PUT …/connect/payout-delay`, both through `platformRequest` (no `X-Shop-Id`). Same condition as before (account + charges enabled), plus `isPlatform`. |
| "Öppna Stripe-panel" (the login link) | **stays, disabled with the reason** for a platform user | The Worker answers the opaque 404 to an acting-as platform user. The reason shows under the buttons and as the `title`: "Stripe-panelen kan bara öppnas av butikens egen admin, inte i plattformsläge." |
| The platform's bypass of the Connect opt-in (`connectEnabled = … \|\| isPlatform`) | **leaves** | The Worker refuses create and onboarding-link for everyone while the platform has not enabled Connect (CP3_F deviation 2), so the bypass would show buttons that always fail. `connectEnabledFor()` decides per build. |

Nothing else leaves. No commission, fee rate or platform figure was on the page before, and none is on it now.

## What exists

| File | |
|---|---|
| `src/pages/admin/adminPaymentsData.js` (new) | The **older build's** data module. It holds the page's former inline Firebase calls, moved and unchanged: `onSnapshot`, the four callables, `getConnectBalance`, `setConnectPayoutDelay`. |
| `src/admin-app/replacements/adminPaymentsData.js` (new) | The **admin build's** data module. It has the same exports, and the alias row points the old module at it. |
| `src/api/admin/payments.js` (new) | The seven calls: 5 seller, 2 platform. |
| `src/admin-app/adapters/payments.js` (new) | Pure helpers: `toPagePayments`, `notEnabledPayments`, `payoutDelayOf`, `loginLinkRefusal`, `connectErrorMessage`. |
| `src/pages/admin/AdminPayments.jsx` (edited) | Imports and data functions only, plus the three markup changes listed under "Deviations". It imports neither Firebase nor the API client. |
| `vite.admin.config.js` | One alias row: `src/pages/admin/adminPaymentsData.js` → `src/admin-app/replacements/adminPaymentsData.js`. |
| `src/admin-app/dev/dev-api.mjs`, `fixtures.json` | Connect rows and scenarios (below), plus one invented user `platform-acting@example.com` / `dev-password-3` who holds a grant on Test Shop A until 2099. |
| Tests (new) | `src/api/admin/payments.test.mjs` (9), `src/admin-app/adapters/payments.test.mjs` (10), `src/admin-app/dev/dev-api.payments.test.mjs` (4). |

**Data module contract** (both builds export it):
- `BALANCE_READ`
- `subscribeConnect(shopId, onData, onError) → unsubscribe`
- `callConnect(shopId, name)`
- `refreshOnReturn(shopId)`
- `connectEnabledFor(pay, isPlatform)`
- `useLoginLinkRefusal(shopId)`
- `getConnectBalance`, `getPayoutDelay`, `setPayoutDelay`

### Routes used (shapes from `connect-admin.ts`, `connect-platform.ts`, CP3_F_REPORT)

| Page action (old callable) | Request | What the page gets |
|---|---|---|
| status (`onSnapshot`) | `GET /v1/admin/payments/connect` | `toPagePayments(connect)`: `connectEnabled`, `connectStatus`, `stripeAccountId` (a **boolean**, never the id), `chargesEnabled`, `requirementsDue`. Nothing else is passed on. A 404 (session alive) → `notEnabledPayments()`. |
| `createConnectAccount` | `POST …/account`, then `POST …/onboarding-link` | `{url}`. A 202 `pending` is asked again after `Retry-After` (capped at 10 s), at most 3 rounds, then a Swedish "try again" message. |
| `createConnectAccountLink` | `POST …/onboarding-link` | `{url, expiresAt}` |
| `refreshConnectStatus` | `POST …/refresh` | The page shape (`chargesEnabled` drives the notice). The view is also pushed to the page, since there is no listener. |
| `createConnectLoginLink` | `POST …/login-link` | `{url}` |
| current delay (platform) | `GET /v1/platform/tenants/:id/connect` | `payoutDelayOf()`: days, or `'minimum'` for the API's `null` |
| set delay (platform) | `PUT /v1/platform/tenants/:id/connect/payout-delay {delayDays}` | the same |

Error codes are mapped to Swedish in `connectErrorMessage`, since the API's own messages are English: `connect_unavailable`, `connect_account_missing`, `connect_onboarding_incomplete`, `connect_account_refused`, `connect_account_conflict`, `connect_payout_delay_refused`, `invalid_request`, `rate_limited`, `not_found`.

### The listener, replaced (no polling)

The status is read at these moments:
- **On mount.**
- **On every window `focus`**, for example when the seller comes back from Stripe's tab.
- **On arrival with `?return=1` or `?refresh=1`**: `POST /refresh` runs first, then the read.
  - It runs once per shop per page load. If the address names another `shopId`, it does not run.
  - The page's own return effect reuses that same refresh (`refreshOnReturn`), so the return costs one POST.
- **After every action that answers a view** (create, refresh): that view is shown.

Ordering: a read is counted from when it was **sent**, and an action's answer from when it **arrived**. Only a higher count is shown, so a slow read never overwrites a newer refresh.

Failures: only a failure of the first read reaches the page's error block. A later focus read that fails leaves the last view in place. A 404 whose `/v1/me` re-read is a 401 is the session-lost path of the client.

## What works against the dev API, and what I looked at

**Setup**
- Dev server on port 5184, own headless browser daemon.
- Screenshots: 44 in `/private/tmp/ff-shots/`. Each state at 1440 and 375, light and dark (`.dark` on `<html>`).
- **The shell is not in the build** (see "Open questions" 1). I looked at the page through a scratch-only Vite config (in my scratchpad, not the repo) that does two things:
  - replaces `AppLayout` with a bare wrapper that uses AppLayout's own main-area classes (`bg-admin-bg`, `max-w-[1200px] px-4 py-4 sm:px-6`);
  - swaps my `pages.jsx` line in memory.

**Scenarios.** Pick one with the cookie `admin_dev_connect=<name>`. Shots are named `<scenario>-<light|dark>-<width>.png`.

| Scenario | What the page shows |
|---|---|
| `none` (enabled, no account) | "Ej aktiverat", the three steps, the checklist, "Aktivera utbetalningar" |
| **Walk**: click Aktivera → `account` 201 → `onboarding-link` → back at `/admin/payments?return=1` | Network: exactly one `POST /refresh`, then the reads. Shows "Åtgärd krävs" (restricted, as a new account reads after its first refresh), "Status uppdaterad från Stripe.", three humanised requirements, and the address cleaned (`restricted-after-return`). |
| **Walk**: "Fortsätt hos Stripe" → return | Shows "Aktivt" and the success notice. **No balance section for the seller.** "Öppna Stripe-panel" opens the link (`active-after-return`). A dispatched `focus` → one GET. |
| `disabled` (status 200 `enabled:false`) and `notfound` (status 404) | Both show "Ej aktiverat" + "Utbetalningar är inte aktiverade för din butik ännu. Kontakta oss för att komma igång." No buttons. |
| `pending` | "Granskas av Stripe" + "Uppdatera status" |
| `restricted` (preset) | Four lines, the unmapped code folded into "Övriga uppgifter (visas hos Stripe)" |
| `stripedown`, then "Uppdatera status" (502) | The error block "Stripe kunde inte nås just nu. Försök igen om en stund." over the unchanged status (`stripedown-error`) |
| **Acting-as** (`platform-acting@example.com`, `active`) | "Öppna Stripe-panel" disabled (`is disabled` → true) with the reason line under it. Below it, the "Saldo & utbetalningsrisk" section holds only the delay editor, "Nuvarande: 7 dagar" (`acting-active`). |
| Acting-as: delay 14 | `PUT` 200 → "Sparat." "Nuvarande: 14 dagar" |
| Acting-as: delay 1 | Dev 422 → "Stripe godtog inte fördröjningen." (`acting-delay-refused`) |
| Acting-as: "Återställ till minimum" | → "Nuvarande: minimum" |

The `PUT` succeeding proves no `X-Shop-Id` was sent: the dev API, like the Worker, answers 404 to a platform request that carries it.

**Rendering findings**
- Light and dark, 375 and 1440: no overflow. The steps row wraps at 375, as its `flex-wrap` intends.
- The disabled button and the reason line read correctly in both themes.
- **One fix after looking**: the delay editor's divider (`mt-3 border-t … pt-3`, meant to separate it from the balance) sat as a stray line at the top of the section once it stood alone. It now takes `standalone`; the older build passes nothing, so its class is byte-identical.

## Gate

```
node --test src/api/*.test.mjs src/api/admin/*.test.mjs "src/admin-app/**/*.test.mjs" src/storefront/adapters/*.test.mjs src/storefront/dev/*.test.mjs
  # tests 258  # suites 75  # pass 258  # fail 0        (mine: 23)
npx vite build --config vite.admin.config.js
  ✓ built in 2.48s
node cloudflare/admin/check-admin-build.mjs
  admin build: 10 files (6 text) checked, no Firebase code, no source map, no secret, every file servable.
node cloudflare/web/check-storefront-build.mjs
  storefront build: 11 files (7 text) checked, no Firebase code, every file servable.
npx vite build
  ✓ built in 11.46s
node guard/guards.test.mjs
  guard: FAIL
    (b) 2 stale guard/allowlist.txt entries — remove it: the allowlist only shrinks:
        src/pages/admin/AdminPayments.jsx      ← mine (see Reviewer wiring 1)
        src/pages/admin/AdminProducts.jsx      ← unit FC's, not mine
```

- The admin build above holds AdminPayments only as a stand-in (its `pages.jsx` line is still pending, see "Open questions" 1).
- **Page in, look shell:** a scratch build with my page swapped in and the look-only bare layout built clean. Its bundle has no `firebase`, `firestore`, `httpsCallable` or `onSnapshot`, and none of the balance panel's text.
- **Page in, real shell:** a scratch build with my page swapped in and the **real** `AppLayout` (FB's work in progress at the time) still pulls the wagons and Firebase. That is why the line stays pending.
- The guard reads tracked files only, so I scanned my new and edited files myself for the two forbidden name families: none found. A Firebase import appears only in `src/pages/admin/adminPaymentsData.js`, which is the older build's module and is never in the admin build.

## Deviations from the brief

1. **"Connect not enabled → the route answers 404" is not what the Worker does.** `GET /v1/admin/payments/connect` answers **200 with `enabled: false`** when the platform has not enabled Connect. Only `account` and `onboarding-link` answer 404 then. The status route 404s only for a guard failure or an unknown tenant (`connect-admin.ts` `handleAdminConnectStatusRoute`). Both cases are handled and look the same: a 404 with a live session reads as "not enabled, no account". The dev API has both (`disabled`, `notfound`).
2. **Three markup changes beyond the data layer**, each required by the brief or by the loss of the balance:
   - the login link's `disabled`/`title` and the reason line (acting-as);
   - the new `PayoutDelayPanel` section, platform only, under the same title "Saldo & utbetalningsrisk";
   - the editor's `standalone` prop.

   In the older build all three render exactly as before: the reason is `''`, `BALANCE_READ` is true, and `standalone` is not passed.
3. **The data module is one module per page** (`adminPaymentsData.js` beside the page), as the brief asks. It also carries two small policy values that differ per build (`BALANCE_READ`, `connectEnabledFor`), so the page needs no build check of its own.
4. **New copy**:
   - the acting-as reason;
   - the Swedish error messages per API code;
   - one "try again" line for a creation still pending after 3 rounds.

   No new colour, font or spacing token (`mt-2`, `text-[12px]`, `text-admin-text-muted` are already in use on the page).

## Open questions

1. **The shell.** `AppLayout` is not yet Firebase-free in the admin build. FB is editing it now, and a scratch build with the real shell still pulled the wagons and Firebase. So `pages.jsx` still has `export const AdminPayments = pending('AdminPayments');`. Once FB's shell is in, the swap is that one line:
   `export { default as AdminPayments } from '../pages/admin/AdminPayments.jsx';`
   It was proven clean with a bare layout.
2. **`?shopId=` on the return from Stripe.** The return URL is `<admin origin>/admin/payments?return=1&shopId=<t>`, which is this page's route. `ActiveShop` honours `?shopId=`, but nothing strips it in this build: `AdminShopIdIntake` is FB's and is not mounted yet. Until it is:
   - the arrival refresh still runs (it is in the data module);
   - the page's own return effect waits for the param to go, so the "Status uppdaterad / Klart!" notice does not show and the address keeps `?return=1&shopId=…`;
   - a reload refreshes once more.
3. **The section title "Saldo & utbetalningsrisk"** now holds no balance for the platform user. I kept the existing copy (byte for byte). Rename it, or wait for WF's balance route?
4. **The "pending" copy says "Statusen uppdateras automatiskt".** In this build the page re-reads on focus, mount and return, not live. A webhook still updates D1, and the seller sees it on the next focus. Fine as is?

## Reviewer wiring

1. **`guard/allowlist.txt`** (not mine to edit): replace the line `src/pages/admin/AdminPayments.jsx` with `src/pages/admin/adminPaymentsData.js` when the new file is committed. The page no longer imports Firebase; the older build's data module does. The size stays 298 = baseline. Until the file is tracked, the guard calls either line stale.
2. Nothing for the Worker. Every route used exists (`connect-admin.ts`, `connect-platform.ts`), and the return URL already prefers `origins.admin` (`onboardingReturnUrls`).

## Files created or modified

Created:
- `src/pages/admin/adminPaymentsData.js`
- `src/admin-app/replacements/adminPaymentsData.js`
- `src/api/admin/payments.js`
- `src/api/admin/payments.test.mjs`
- `src/admin-app/adapters/payments.js`
- `src/admin-app/adapters/payments.test.mjs`
- `src/admin-app/dev/dev-api.payments.test.mjs`
- `docs/cf-port/CP5_FF_REPORT.md`

Modified:
- `src/pages/admin/AdminPayments.jsx`
- `vite.admin.config.js` (one alias row)
- `src/admin-app/dev/dev-api.mjs` (Connect rows)
- `src/admin-app/dev/fixtures.json` (`connectScenarios`, one acting-as user)
