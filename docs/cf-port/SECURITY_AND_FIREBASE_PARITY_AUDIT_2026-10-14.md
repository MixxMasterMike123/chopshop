# Cloudflare migration: security and Firebase parity audit

Date: 2026-10-14 · Branch: `cf-port` · Reviewed HEAD: `db32fdd9f2b30c9544278725cd474e9a12e5e818`

## Verdict

**Do not open production checkout yet.** The migration has substantial security improvements and a strong test suite, but there are confirmed security defects, recovery gaps and unfinished launch requirements. In particular, the renderer uses a vulnerable native image dependency, anonymous request bodies are insufficiently bounded, and email delivery can lose its only recoverable job after queue retry exhaustion.

**The current implementation also does not meet the owner's requirement for little to no platform involvement and orders presented under the individual shop's identity.** It remains restricted to Snapwear for production API fulfilment, shipment updates and accepted-job cancellation require people, and most customer emails use the platform's configured sender display name. Printful/Gelato are not implemented alternatives in this checkout/dispatch path.

No application code, configuration, dependency or database changes were made. This report is the only new tracked deliverable. The pre-existing edit to `docs/SnapWearDocs/LAUNCH_TODO.md` was left untouched.

## Scope and evidence limits

Reviewed the API entrypoints and route guards, Better Auth configuration, live tenant authorization, acting-as model, object storage and upload lifecycle, image rendering, checkout/payment/webhook paths, refunds and reconciliation, queues/outbox/email, recovery links, production configuration, deployment guards, import transformations and migration fates, frontend replacement/build boundaries, and the Firebase source and rules for the corresponding behaviour. Used the existing migration inventories and decisions to distinguish intentional removals from accidental regressions. Older checkpoint reports were leads, not proof that their proposals have shipped.

This is a repository and local-runtime audit, **not an authenticated inspection or penetration test of the deployed Cloudflare account**. No live tenant data, credentials or production settings were read; no payments, messages, deployments or remote writes were performed. Live WAF/Access policies, token permissions, bucket exposure, SaaS certificates, Stripe endpoint configuration, Resend deliverability and backups remain deployment-verification items. An absence in this repository does not prove that an account-level control is absent.

Finding labels:

- **Confirmed:** behaviour visible in the implementation, local dependency scan or a local reproduction.
- **Conditional:** impact depends on a race, runtime configuration or input path; prerequisites are stated.
- **Known unfinished:** explicitly deferred in migration decisions; still a launch gap where required.
- **Hardening:** a missing defence, not a demonstrated access bypass.

Severity describes impact, separately from whether a capability is deliberately unfinished. No critical exploit was demonstrated. “Tests pass” does not establish full Firebase parity or production readiness.

## Verification performed

| Check | Result |
|---|---|
| API TypeScript: `npm run build` in `cloudflare` | Passed |
| Web/admin Worker TypeScript: `npx tsc --noEmit -p web` and `-p admin` | Passed |
| Cloudflare runtime tests | **137 files; 4,980 tests passed** |
| Migration/export/import tests | **554 passed** |
| API/client/admin replacement/storefront adapter tests | **1,138 passed** |
| Render container `npm run check` | Typecheck passed; **136 tests passed** |
| Repository migration guard | Passed; baseline 292, one permanent exemption |
| Storefront production build + build scanner | Passed; no Firebase code; all output files servable |
| Admin production build + build scanner | Passed; no Firebase code, source maps or scanner-detected secrets |
| In-memory SQLite object-transition reproduction | Confirmed conditional writes can affect zero rows while caller code returns success |
| npm production dependency audit: Cloudflare package | 3 affected package entries: 1 high, 2 moderate |
| npm production dependency audit: renderer | 1 high: `sharp` |
| npm production dependency audit: root/frontend tree | 20 affected package entries: 6 high, 13 moderate, 1 low; includes legacy dependencies not shipped to Cloudflare |
| Current Workers declarations | Retrieved `@cloudflare/workers-types` 5.20261014.1; relevant `timingSafeEqual`, R2 options and `FixedLengthStream` exist |

The Worker and migration suites initially could not bind local emulator/fake-server ports under the sandbox. They were rerun with local loopback permission and passed. These initial environmental failures are not application defects. Tests use mocked external services; successful builds used the local build environment rather than a production deployment's validated environment file.

## Finding index

| ID | Priority/severity | Finding | Evidence class |
|---|---|---|---|
| F01 | High; block launch | Vulnerable `sharp`/librsvg reached before format rejection | Confirmed dependency; exploit conditional |
| F02 | High | Unbounded anonymous webhook and checkout body reads | Confirmed |
| F03 | High | Email queue exhaustion strands delivery after outbox completion | Confirmed |
| F04 | Launch blocker | Production fulfilment is Snapwear-only and needs manual operations | Confirmed; known unfinished |
| F05 | Medium; business requirement | Customer order mail sender loses shop identity | Confirmed regression |
| F06 | Medium | Object transitions return success after a failed conditional write | Confirmed race |
| F07 | Medium | File audit records omit actor and acting-as grant | Confirmed |
| F08 | High privacy/operational | Personal-data cleanup is not the Firebase retention flow | Confirmed; known unfinished |
| F09 | Medium | Reminder opt-outs are archived instead of carried | Confirmed mapping; affected population unverified |
| F10 | Medium | Receipt token can be irretrievably lost after successful payment | Confirmed failure window |
| F11 | Medium | Suspended-shop withdrawal intake is blocked by shared-host resolution | Confirmed path inconsistency |
| F12 | Medium | Shared renderer has IP limits but no tenant/user work quota | Confirmed hardening gap |
| F13 | Medium | Rotating authentication secret breaks permanent unsubscribe links | Confirmed |
| F14 | High operational | Scheduled independent backups and capacity alert remain unbuilt | Known unfinished |
| F15 | Launch blocker | Production routing, origins and Stripe pins remain incomplete | Confirmed configuration |
| F16 | Medium | Public storefront API switch was never closed after web Worker shipped | Confirmed architecture gap; exposure conditional |
| F17 | Medium | Additional vulnerable dependency entries need reachability triage | Confirmed versions; exploit paths unverified |
| F18 | Medium | Domain “verified” means operator input, not ownership/certificate proof | Confirmed; known unfinished |
| F19 | Medium | Private uploads allow active document types on privileged origin | Confirmed surface; exploit unverified |
| F20 | Medium | Storefront CSP is report-only; privileged login has no MFA | Hardening, not a demonstrated bypass |
| F21 | Functional scope | Several Firebase capabilities remain intentionally absent | Confirmed scope reduction |

## Findings and recommended acceptance criteria

### F01 — Native image dependency has a current high-severity advisory

**Evidence:** `cloudflare/render/package.json` pins `sharp` 0.35.4. The lockfile/install agrees. `cloudflare/render/Dockerfile` uses the official `node:22-bookworm-slim` image, on Linux/glibc. `cloudflare/render/src/pipeline.ts:152` calls Sharp metadata on uploaded bytes; the SVG refusal follows at line 164. Private artwork uploads are not validated with the public-logo SVG refusal scanner. An SVG rejected as a product format has already reached the native image loader.

The current [Sharp maintainer advisory](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) identifies versions below 0.35.5 as affected by a librsvg memory vulnerability, with possible code execution under particular Linux runtime conditions. Its published fix is Sharp 0.35.5; blocking the SVG loader is a documented workaround. **This audit confirms the affected dependency and parser entry, not working code execution in the deployed image.**

**Impact:** A malicious or compromised tenant admin can submit native-parser input to a platform-wide renderer. The process holds `RENDER_FARM_TOKEN`, which can acquire work across tenants. Container compromise therefore has a larger boundary than that tenant's own image library. Running as `node` reduces operating-system privilege but does not protect that token.

**Acceptance:** Update to a patched image dependency, rebuild the deployed container, verify native library versions in that image, and prevent disallowed loaders from processing uploaded formats before application rejection. Repeat render parity tests. Do not rely on the user-facing “SVG unsupported” message as a security control.

### F02 — Body limits are applied after buffering, or not applied at all

**Evidence:** `cloudflare/src/lib/responses.ts:81` calls `request.json()` with no byte limit. Checkout uses this helper (`app.ts`, checkout handler). `app.ts:1580` reads the entire webhook body with `request.text()` before validating its signature. A caller needs only to supply a `Stripe-Signature` header to reach the read; that header has not yet been authenticated. Auth sign-in/reset submission also delegates directly to Better Auth without an application-level byte cap.

**Impact:** Oversized JSON or raw webhook payloads can exhaust isolate memory/CPU before the small-field validation or signature rejection that comments describe as the flood protection. An IP request-count limit does not limit bytes per request. The platform-wide edge request ceiling is not a suitable application payload limit.

A bounded streaming JSON helper already exists in `cloudflare/src/legal/legal-pages.ts:111` and is used by withdrawal intake. This is inconsistent application of an existing protection.

**Acceptance:** Enforce small route-specific byte ceilings before buffering, including chunked bodies with no declared length. Preserve exact raw bytes for webhook signature verification. Test over-limit authenticated and anonymous bodies, missing length, and a deliberately false/large signature header. Return a controlled refusal without database or external-service work.

### F03 — The durable email ledger cannot reconstruct an exhausted queue job

**Evidence:** `cloudflare/src/outbox/email-effect.ts:648` enqueues an email job and then completes the outbox row at line 655. The ledger stores delivery identifiers/fingerprints/status, not the complete auth email job containing its recipient and action token. `cloudflare/src/email/email-queue-consumer.ts:330` retries unconfigured delivery every 300 seconds; configured provider failures also retry. Queue consumers in `cloudflare/wrangler.jsonc` have `max_retries: 8` and no dead-letter queue. `outbox/sweeper.ts` selects unfinished outbox rows; neither it nor the scheduled commerce steps reconstructs/resends pending email deliveries whose source outbox is already done.

**Trigger:** Enqueue succeeds; the mail provider is unavailable, misconfigured or unconfigured long enough for the queue's retries to exhaust. The queue drops its job. The source outbox remains done and the ledger remains pending/processing or failed. Restoring the provider does not recover that missing message. Repeated unconfigured retries exhaust on approximately a tens-of-minutes timescale, before many jobs' stated lifetime.

**Impact:** Lost order confirmations, shop order notices, status/refund/withdrawal emails and invitations/reset links. This contradicts the config comment that D1 always makes a dead-letter queue unnecessary. Auth jobs are particularly difficult to reconstruct because their token is intentionally absent from the ledger. The same provider sends the alert digest, so a mail failure can also remove its notification channel.

**Acceptance:** Demonstrate recovery after queue retry exhaustion, not just queue-send failure. A durable retry mechanism must retain/reconstruct the required job safely, or a handled dead-letter mechanism must supply it. Respect original token expiry and provider idempotency lifetime. Surface terminal delivery failures and pending backlog through a channel independent of the failed email provider.

### F04 — The implemented fulfilment path conflicts with automatic operation

**Evidence:** `cloudflare/src/commerce/checkout.ts:1006` accepts only `fake-printer` and `snapwear` in production snapshots. It refuses an order split across printers. `cloudflare/src/dispatch/printer-client.ts:355` resolves only those two clients; production configuration pins Snapwear. `snapwearSubmitConfig` requires an explicitly enabled, configured direct API. There is no Printful, Gelato or BaseLinker client in this path.

`cloudflare/src/dispatch/production-status.ts:9` states that the current writer is a **platform operator** recording printer emails. `dispatch/cancellation.ts:20` states that an accepted job's cancellation becomes a human-action alert. Unknown submissions require dashboard inspection and manual resolution. The Snapwear client rejects jobs without a shipping recipient, so POD pickup orders also need an agreed fulfilment route.

**Impact:** Correct automated payment can produce an order held for an unavailable supplier, an order whose shipment needs platform data entry, or a refund whose actual printer job continues until a person cancels it. The owner's statement that Snapwear will not approve a new custom API removes the assumed production route. Alerting is useful but does not make this a business with automatic routine handling.

**Firebase comparison:** Firebase provided an authenticated printer queue/job/status interface (`functions/src/print/functions.ts`, `setPrintJobStatus.ts`). Its operators could advance orders without a platform employee copying supplier emails. Firebase was not itself wholly automatic either; restoring that portal alone would not fulfil the owner's current requirement.

**Acceptance:** Prove an approved real supplier path for submission, payment, tracking and status, with exception/cancellation behaviour. Verify pickup separately. Gate sale of POD products on actual supplier readiness, not merely an active catalogue row. Extend the hardcoded checkout/dispatch model if choosing another provider; changing a price tier alone is insufficient.

### F05 — Most order emails use the platform sender instead of the shop

**Evidence:** `cloudflare/src/email/email-queue-consumer.ts:169` uses `config.from` for every job except a checkout reminder. Shop Reply-To is set for some order emails, but it is not the sender display name. Firebase's `functions/src/email-orchestrator/core/EmailOrchestrator.ts:881` built the From display name from the shop for customer-facing emails.

**Impact:** A customer can receive an order confirmation, status or refund email under the platform's name even though they bought from a shop. Reminder mail already demonstrates a shop-named sender implementation. This is a confirmed branding regression and conflicts with the user's requirement.

The printer request (`printer-client.ts:78`, `snapwear-wire.ts`) carries destination and artwork but no per-shop sender/return identity. **That absence does not prove what appears on a physical label.** Supplier-side sender branding must be separately verified. This audit does not establish that BaseLinker necessarily makes the platform the sender.

**Acceptance:** Check actual From, Reply-To, mail content, packing slip, parcel sender and return address for two different shops using the same platform account. Each must use the intended shop identity without manual changes.

### F06 — Object lifecycle success can disagree with the committed database state

**Evidence:** `cloudflare/src/storage/object-store.ts:299` reads a pending object, performs a conditional activation UPDATE, then returns a synthesized active object without checking whether the UPDATE matched. `deletePendingOrMutableObject` at line 458 similarly does not inspect the write result. Its caller, `object-routes.ts:760`, can delete R2 bytes after this apparent success.

**Local reproduction:** Loaded the foundation/object schema into an in-memory SQLite database. Read a pending object; tombstoned it as a competing request; executed activation's `WHERE status='pending'` update. Result: **0 changed rows, actual state deleted**. In a second interleaving, read a mutable active object; froze it; executed deletion's `WHERE immutable=0` update. Result: **0 changed rows, actual state active and immutable**. Application code nevertheless returns success in these cases.

**Impact:** The upload path's public-object cleanup branch is skipped when activation incorrectly returns success, leaving bytes publicly accessible for a deleted object in that race. In the freeze/deletion interleaving the route can remove bytes while the row remains frozen and active. The latter is a latent boundary defect: `markObjectImmutable` currently has no production callers found in `cloudflare/src`, so this audit does not claim an observed paid-order file loss via that function.

**Acceptance:** Treat the committed conditional transition as authoritative. Return conflict on zero changed rows; write audit evidence only for a real transition; verify byte deletion is authorized by the committed tombstone. Add deterministic overlapping upload/delete/freeze checks. A conditional SQL statement is not sufficient when its result is ignored.

### F07 — File operations erase the acting user's audit identity

**Evidence:** `cloudflare/src/storage/object-routes.ts` converts a `TenantAdminPrincipal` into a `TenantContext`. The lower-level `object-store.ts:191` inserts `actor_user_id = NULL` and no `actingAsGrantId` for reserve, activation, deletion and freezing. Its generated `request_id` is a new random value per event rather than shared request correlation.

**Impact:** Investigators can see which shop's file changed, but cannot distinguish its seller admin, another member or a platform user acting as that shop. This contradicts the documented guarantee in `auth/live-authorization.ts` that acting-as mutations are traceable to their grant. F06 also permits audit records for transitions that did not occur.

**Acceptance:** Preserve actor/grant context through the storage boundary, audit only actual writes and correlate a request's events. Verify a seller action and an acting-as action produce distinguishable evidence without logging file bytes or credentials.

### F08 — Checkout retention clears the print snapshot, not buyer data

**Evidence:** `cloudflare/src/commerce/crons.ts:113` implements retention by clearing `production_snapshot_json` (line 227). It does not remove/anonymize checkout email, checkout recipients or related retained cart records. `0045_order_recipients.sql` freezes recipient rows against update. Withdrawals are append-only with a delete-blocking trigger (`0044_withdrawals.sql:124`). Reminder decisions/suppressions also have no-delete triggers (`0056_checkout_reminders.sql`). User deactivation is suspension/session revocation, not erasure.

**Firebase comparison:** `functions/src/checkout-recovery/sweep.ts` deletes stale checkout documents at its retention boundary rather than only clearing a production snapshot. The new relational persistence can retain abandoned buyer data indefinitely. The migration itself acknowledges the unresolved broader retention/erasure work as decision D68.

**Impact:** More personal data persists than the visible “retention sweep” name suggests; account closure does not provide a data lifecycle. Immutable accounting evidence and retained anonymous opt-outs may be appropriate, but immutability cannot be the entire policy for address/name/email content. No legal conclusion about statutory retention periods is made here.

**Acceptance:** Define record-class retention, erasure/anonymization and backup/archive treatment. Prove abandoned checkout PII ages out, legitimate accounting evidence is preserved, and immutable-table rules allow the approved lifecycle. Separate buyer privacy cleanup from production-snapshot safety.

### F09 — Firebase reminder opt-outs will not survive the current import

**Evidence:** `scripts/cf-port/migrate/lib/manifest-fates.mjs:48` sets `checkoutSuppressions` to archive. Cloudflare's live suppression reader uses `checkout_reminder_suppressions`, not that archive. The reminder feature was subsequently implemented, but this collection fate remains the original deferred-feature decision.

**Impact:** A buyer who opted out in Firebase may receive a new reminder after migration and seller activation. Opt-out hashes can be carried without importing old payment capabilities or open carts. The September census reported no suppression rows, but that is historical evidence; the source can change before freeze.

**Acceptance:** At cutover, count and carry tenant/email suppression records, or document evidence that the frozen source contains none. Test an old Firebase opt-out against a fresh Cloudflare checkout for the same normalized address. Do not treat “zero in September” as a cutover guarantee.

### F10 — Receipt handoff is consumed before reliable delivery to the browser

**Evidence:** `cloudflare/src/commerce/receipts.ts:117` hands off the raw receipt token using `DELETE ... RETURNING`. Only its hash remains on the order. `src/api/orders.js` stores the returned credential in tab `sessionStorage`; a later poll returns `issued` without a replacement credential. There is no mounted buyer reissue/recovery route.

**Trigger:** Database deletion commits, then the response is lost, the tab closes or browser storage fails before saving the token. Payment and order creation remain successful. Replaying the request cannot recover the raw token. A webhook delayed beyond the 90-second UI poll adds another recovery scenario to test.

**Impact:** The paid buyer loses automatic online access to confirmation/order details. Customer accounts were intentionally removed, but guest purchases still need recoverable receipts. An order email is not proof of a working recovery link, especially with F03.

**Acceptance:** Demonstrate recovery from response loss and a new device without exposing the order to an unauthenticated caller. Use an appropriately verified buyer capability/reissue flow; merely resending order details by platform staff does not meet the automation requirement.

### F11 — Withdrawal availability differs between backend and shared storefront

**Evidence:** `cloudflare/src/routes/storefront-withdrawals.ts` deliberately resolves a verified domain regardless of tenant status. However, `Internal.fetchForShop` uses `cloudflare/src/tenancy/shop-hostname.ts:44`, which requires an active tenant before forwarding. The shared-host path `/_api/<shop>/v1/withdrawals` therefore cannot reach the permissive withdrawal handler for a suspended/closed shop. Reminder unsubscribe also resolves an active tenant (`routes/storefront-checkout-recovery.ts`), blocking old links while that shop is suspended.

**Impact:** Backend tests of the intake's permissive rule do not prove buyer access through the actual web Worker. A buyer is sent to manual support when the shop is closed—the moment self-service is most valuable. D97 documents the withdrawal issue, but it remains open in the implemented shared-host route.

**Acceptance:** Through the web Worker, verify withdrawal and unsubscribe for active, unpublished, suspended and closed shops. Keep those limited buyer-service routes available without reopening the shop catalogue or checkout.

### F12 — Rendering and uploads lack quotas at the identity/tenant boundary

**Evidence:** POD submission at `cloudflare/src/app.ts:1731` limits raw client IP to five jobs/minute. `wrangler.jsonc` allows one render instance; the container processes one job at a time. The reviewed storage reservation/upload route has per-file ceilings, but no cumulative tenant bytes/work quota. No per-user/per-tenant render quota or queue-backlog admission gate was found.

**Impact:** One authenticated tenant can occupy the shared renderer and grow storage using many requests/objects. Rotating source IPs, including IPv6 addresses within a subscriber prefix, bypasses this raw-IP work limit. Even an honest five-per-minute allowance can enqueue work faster than a serialized long-running renderer drains it. Every tenant then waits behind the same backlog.

**Acceptance:** Limit admitted outstanding work and cumulative cost/bytes per tenant/user, normalize IPv6 flood keys consistently and alert on backlog/storage capacity. Test one tenant exhausting its allowance while another still makes progress. Do not label the unused Firebase budget-monitor module as a previously effective control: searches found its declaration, not active callers.

### F13 — Authentication secret rotation invalidates long-lived unsubscribe

**Evidence:** `cloudflare/src/commerce/checkout-recovery-token.ts:66` derives recovery/unsubscribe HMAC keys from the current `BETTER_AUTH_SECRET`. Tokens have a version but no key identifier/keyring. Verification supports only the current derived key. The module explicitly acknowledges rotation breaks mailed links. Firebase recovery tokens were independent random values stored with their checkout.

**Impact:** Routine auth-key rotation or an incident breaks every old unsubscribe URL, despite the product promise that unsubscribing works regardless of link age. Purpose separation and tenant binding are correctly implemented; the missing property is rotation continuity.

**Acceptance:** Separate long-lived link signing from session secret rotation, with key versioning/retirement and a tested incident procedure. Verify an old unsubscribe still works after a normal auth-secret rotation, and decide explicitly which compromised capabilities must instead be revoked.

### F14 — Backup plan is documented but not implemented end to end

**Evidence:** `docs/cf-port/D1_BACKUP_RESTORE.md:49` still lists weekly export to private R2 and a database-capacity alert as “Still to build”. The scheduled handler contains outbox, reconciliation, snapshot retention, screening, onboarding, reminders and digest steps, not those backup/capacity tasks. The recorded restore drill was on staging and D1; it does not demonstrate restoring D1 plus the exact R2 print files referenced by paid orders.

**Impact:** An account incident, deleted bucket/object or mismatch between database rollback and external payment/printing actions cannot be solved by the D1 drill alone. Replaying restored money/outbox state against already executed external operations needs a reconciliation plan.

**Acceptance:** Evidence of scheduled protected backups, failure notifications, consistent database/object inventory, and a full isolated restore drill. Verify restored payment/refund/dispatch dedupe against external facts before resuming consumers. If account-level backups already exist, attach that evidence rather than duplicating them.

### F15 — Repository production configuration cannot support launch yet

**Evidence:** `cloudflare/pinned.production.json` has null admin origin, public object base URL, Stripe account and webhook endpoint IDs. API/web/admin production configs disable workers.dev but still name workers.dev canonical hosts, with no real production domain routes. API production origins omit admin; renderer calls the canonical API over public HTTPS. Public image base is absent.

**Impact:** The repository's production deployment gates should correctly refuse this state. Bypassing them would leave unreachable API/render/reset paths, missing images and unverified live payment configuration. This is unfinished configuration, not evidence that the guards themselves are insecure.

**Acceptance:** Complete the same pinned domain/origin/account/bucket/webhook values everywhere; keep workers.dev/preview URLs disabled; run the normal preflight/build/deploy checks. Prove sign-in/reset, rendering, public media, payment and verified webhook delivery on the actual production domains before checkout is opened.

### F16 — Public storefront API remains enabled contrary to the intended boundary

**Evidence:** `cloudflare/src/app.ts:2143` leaves `PUBLIC_STOREFRONT_ALLOWED = true`. Its adjacent TODO says to turn it off when the web Worker ships. The web Worker and Internal binding now exist. The public router therefore still accepts storefront routes on a resolving hostname without requiring the web Worker's method/path allowlist.

**Impact:** The web proxy allowlist is not the sole boundary described in the architecture. Exploitability depends on which public hostnames/routes the deployed API actually receives: tenant resolution still blocks arbitrary hosts, and this is **not a confirmed tenant-isolation bypass**. The switch also makes later API additions easier to expose unintentionally.

**Acceptance:** Inventory all intended public routes and external collection consumers. Close this temporary storefront switch, preserving deliberately public integration endpoints explicitly where needed. Test the deployed public API directly, not only calls through the proxy.

### F17 — Dependency findings extend beyond the renderer, but require exposure triage

**Evidence:** `npm audit --omit=dev --json` against the installed trees on the audit date. Cloudflare's production dependency path includes `better-auth -> vitest -> @vitest/mocker` and `vite -> postcss -> source-map-js`; `npm ls --omit=dev` confirms these are not merely root dev entries. The audit identifies [source-map-js event-loop denial of service](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) and [Vitest mock-redirect arbitrary file read](https://github.com/advisories/GHSA-82fw-gwwq-j7x9).

The root/frontend tree reports 20 affected package entries, including `@xmldom/xmldom` 0.8.13 via Pixi, `dompurify` 3.4.13, `quill` 1.3.7 via React Quill, React Router, markdown-it, fflate, qs and legacy Firebase dependencies. [Quill's advisory is disputed](https://github.com/advisories/GHSA-4943-9vgg-gr5r); the [DOMPurify advisory](https://github.com/advisories/GHSA-6688-9rhm-gjv2) requires an IN_PLACE path, which the source search did not find. [xmldom's advisory](https://github.com/advisories/GHSA-965w-775f-mr7g) and [React Router's backslash redirect advisory](https://github.com/advisories/GHSA-wrjc-x8rr-h8h6) need application-path checks.

**Impact and qualification:** Confirmed affected versions are not automatically confirmed remotely exploitable Worker code. The Cloudflare bundles pass the Firebase-exclusion scanners; the legacy Firebase advisory entries must not be counted as deployed Cloudflare vulnerabilities. Test-server tools and source-map parsers need bundler/reachability inspection before assigning their npm severity to this API. The renderer's F01 is materially different because uploaded input demonstrably reaches its native parser.

**Acceptance:** Patch reachable dependencies, review the unexpected test-tool production dependency chain, recheck lockfiles and inspect final bundles. Do not apply npm's suggested React Quill/Firebase downgrades blindly. Maintain a documented reachability decision for disputed/unused entries and scan the legacy rollback artifact separately if it remains deployable.

### F18 — Domain ownership and lifecycle are not proven by the verified flag

**Evidence:** `cloudflare/src/platform/provision-tenants.ts:260` writes new domains immediately as verified and names the platform operator as its verification authority. No DNS ownership/certificate proof is performed by that function. Domain movement carries existing status/verification facts to another tenant. D89 explicitly defers Cloudflare for SaaS/custom hostname integration.

**Impact:** The data model alone cannot prove a customer controls a custom domain or that an enabled domain still points to the correct shop. The route is platform-admin-only, so this is not an anonymous domain-takeover finding; the risk is administrative misassignment, stale domain ownership and missing reconciliation with Cloudflare's certificate/hostname lifecycle.

**Acceptance:** Verify ownership/certificate/routing before treating customer domains as verified; reconcile disable/move/reassignment with the edge. Test a removed DNS record and a domain changing owner. Keep placeholder internal shop hostnames distinct from externally verified customer domains.

### F19 — Private upload types need a safer download boundary

**Evidence:** Private reservation accepts any syntactically valid MIME type (`storage/object-routes.ts`, `object-store.ts:110`), unlike the narrow public image list. `deliverAdminObject` at `object-routes.ts:725` returns that declared type inline, with nosniff/no-store but no attachment disposition or restrictive content sandbox. The admin proxy adds its enforced HTML policy only to `text/html` responses, not SVG/XHTML. Requests remain session/membership-protected and require `X-Shop-Id`.

**Impact:** Active document content has a privileged-origin delivery surface if the admin UI or a future preview opens it in a browser document context. **No complete stored-XSS exploit through the current UI was demonstrated**, and a plain top-level link cannot supply `X-Shop-Id`; those restrictions reduce immediate reachability. Nonetheless, syntactically valid MIME plus nosniff does not make declared HTML/SVG safe.

**Acceptance:** Force untrusted documents to download or serve them from an isolated/sandboxed document origin; tightly constrain inline types. Test HTML, SVG, XHTML and MIME deception in actual preview/download flows. Keep private file authorization intact.

### F20 — Browser and privileged-account hardening remains incomplete

**Evidence:** `cloudflare/web/src/headers.ts` sends `Content-Security-Policy-Report-Only`, not an enforced policy, and no reporting endpoint is specified there. This mirrors the Firebase storefront policy, so it is inherited exposure rather than a new migration regression. The admin policy is enforced. Better Auth mounts password authentication without a second factor; `create-auth.ts:110` allows seven-day sessions and `requireEmailVerification` is false. Signup is not public, and invited password setup verifies access to the mailbox.

**Impact:** A future storefront sanitization bypass lacks CSP containment. A phished platform password can control tenant permissions, money-related settings and acting-as access. This audit found no public registration escalation or confirmed session theft.

**Acceptance:** Exercise checkout and storefront under an enforced compatible policy, remove unused permitted third parties and use actionable CSP reporting. Require appropriate MFA or an equivalent verified gateway for platform operations; confirm it also covers direct auth/API access. Decide on reauthentication for sensitive operations. Do not mistake these recommendations for claims that Firebase had stronger MFA.

### F21 — Complete Firebase functionality has not been carried

**Evidence:** Migration function/client inventories; `src/admin-app/replacements/adminShellScope.js`; `PlatformMigrateModal.jsx` returns null; storefront Vite aliases replace reviews with an empty implementation. `cloudflare/src/app.ts` requires migration 0056, with no shipped review or DAC7 route set. CP9 review/DAC7 documents are plans/reports, not proof of mounted endpoints. Feature entitlements still include `productReviews`, `contentStudio` and `marketingMaterials`, although the shipped launch projections/build exclude their functionality. Product reviews are still default-enabled at the raw feature-setting layer.

**Impact:** Turning an entitlement on cannot recover a missing feature. A functionally successful POD pilot is not complete feature parity. These are mostly approved deferrals (D81 etc.), but they must be visible when deciding whether the functional Firebase version can be retired.

**Acceptance:** Keep unsupported capabilities unavailable in effective feature projections and customer promises. Record the owner's launch scope and restore only features actually required. For seller/tax history and prior purchases, archive access must be usable and owned, not just checksummed storage.

## Firebase parity matrix

| Capability | Firebase baseline | Current Cloudflare result | Classification/action |
|---|---|---|---|
| Tenant separation | Firestore/Storage rules plus callable checks | Server-mediated D1 reads, live memberships and tenant-keyed objects | Strong port; no cross-tenant bypass confirmed in reviewed paths |
| Role revocation/impersonation | User docs and impersonation mechanisms | Live identity/membership queries, session revocation, expiring acting-as grants | Improvement; storage audit exception F07 |
| Checkout pricing, shipping, VAT, recipient | Server recomputation and production snapshot flow | Server-priced immutable checkout, recipient rows and order copies | Implemented; covered by existing tests; oversized-body issue F02 |
| Payment-to-order creation | Stripe signed webhook + Firestore writes | Signed webhook, D1 batch, payment-event dedupe, atomic outbox | Implemented; actual live Stripe version/event contract still needs proof |
| Refunds/disputes/Connect | Existing callable/webhook settlement | Reservations, dedupe, deferred-event replay and reconciliation | Substantial port; money-path tests pass; no real-provider integration was run |
| Platform fee on refund | Firebase default returns fee | Cloudflare keeps platform commission; production release rules apply separately | **Approved deliberate policy change D9**, not an accidental regression |
| Printer routing | Garment/line routing to printer UIDs | Snapshot accepts one printer per order, only fake/Snapwear | Narrowed architecture; F04; tiers alone cannot add Printful/Gelato |
| Printer status and tracking | Printer-authenticated queue and status callable | Platform enters supplier email status; automatic buyer mail follows committed state | Operational regression against self-service/automation requirement |
| Cancellation after printer acceptance | Existing manual supplier constraints | Human-action outbox/alert | Explicit manual exception; automation requirement unresolved |
| Customer-facing email branding | Shop-named From, logo/support identity | Global From for most jobs; some shop Reply-To; reminders shop-named | F05; verify whole message and physical parcel |
| Email durability | Firebase trigger/email flows | Durable outbox + queue/ledger | Improvement before enqueue; unrecovered exhaustion after enqueue F03 |
| Buyer accounts/order history | Customer accounts and customer pages | Guest-only; tab-held receipt capability | Approved removal D81; reliability gap F10 remains |
| Discounts | Affiliate/campaign codes | Campaign discount codes and reservation/usage holds | Implemented campaign path; affiliates deliberately absent |
| Abandoned checkout | Recovery, suppression and old-document purge | Consent-controlled reminders, separate link purposes, seller activation date | Improved consent/abuse model; F03/F08/F09/F11/F13 |
| Product reviews | Verified-buyer requests, submission, moderation, aggregates | Replaced/absent; CP9-RV proposal not shipped in reviewed HEAD | Deferred, not feature-complete |
| Seller tax/DAC7 | Seller data, corrections and reporting functions | Source seller data archived; no implemented corresponding route/UI set found | Known deferral; agree accountable reporting/data continuity before retiring baseline |
| Customer/shop imports | Shopify/Woo migration callables and UI | UI replacement is null; no equivalent launch migrator | Deferred; affects onboarding promise |
| B2B/affiliate/content studio/marketing | Existing optional modules | Reduced launch scope; several UI routes removed | Approved deferral/removal; not full parity |
| Artwork processing | Firebase farm pipeline/validation | Streamed container pipeline and fenced jobs | Strong port; current native dependency F01 |
| Private originals/print masters | Private rules-controlled objects | Tenant rows, private R2, short-lived signed URLs and fenced promotion | Strong boundary; lifecycle/audit issues F06/F07; verify deployed buckets |
| Public images | Firebase Storage URLs | Separate public origin, hash/type checks, immutable keys | Implemented; production origin absent F15 |
| Shop pages/SEO/old paths | Browser pages and source-system URLs | Server head/content sanitization, collections, redirect/sitemap routes | Added capability; build tests pass |
| Withdrawal intake | Order lookup/contact matching | Recorded intake/outbox and per-visitor limit | Implemented; actual closed-shop web access F11 |
| Realtime admin updates | Firestore subscriptions | Request/focus refresh and selective polling | Intentional change; test two-session edits and stale-state conflicts live |
| Historical orders/users | Present in source stores | Orders archived; selected active/admin identities recreated via invitations | Approved archive decision, subject to fresh freeze checks and useful archive retrieval |

## Controls that are working and should be preserved

- The public entrypoint strips forged tenant headers; Internal service calls strip them too. The admin proxy uses a forwarded-header allowlist. `X-Shop-Id` is a claim checked against live membership, not authorization by itself.
- Platform routes refuse shop-context requests. Acting-as requires a live platform identity and a current grant; it does not silently convert the platform session into the seller's identity.
- Cookie-authenticated mutations use strict Origin checks. Better Auth trusts canonical origins and uses edge client-IP information rather than arbitrary forwarded addresses. Auth routes are allowlisted; signup is not mounted.
- Object IDs are looked up with tenant ownership. Public/private/production bindings are separated. Presigned URLs are limited to purpose/key/lifetime; rendered outputs have lease fencing and hash-verified promotion.
- Checkout totals and production costs are calculated server-side. Payment completion creates the order, history and outbox effects in a database batch. Payment/refund dedupe and deferred-event replay have extensive tests.
- Recovery link signatures bind tenant and purpose. Unsubscribe headers cannot be reused as recovery tokens. Reminder consent, frequency caps, current availability and suppression are rechecked.
- HTML/SVG write refusal, storefront sanitization, JSON output allowlists and admin CSP provide meaningful defences. The report did not demonstrate a sanitizer bypass.
- Preflight pins account/environment/resources; production is deliberately blocked while pins are incomplete. Deployment checks isolate public build values and require a clean reviewed commit. Tests and build scanners confirm the Cloudflare outputs exclude Firebase code.

## Remaining live verification needed for a complete cutover sign-off

These are evidence requests for the release process, not claims of a confirmed exploit:

1. **Account boundaries:** actual token scopes, environment-specific secrets, minimum admin permissions and independent account MFA/recovery. Verify R2 private/production buckets have no public/custom-domain exposure and that presign credentials cannot write unrelated buckets.
2. **Edge protection:** WAF/body limits/bot or rate controls on anonymous writes and authentication; direct API/render/webhook access; behaviour through Workers service calls. Repository D1 rate counters alone are not a volumetric attack strategy.
3. **Real-domain session behaviour:** cookie flags, expiry, sign-out, password reset, membership revoke, suspension and acting-as expiry in a browser on actual origins. Check direct API host and preview URLs as well as the admin proxy.
4. **Stripe contract:** `stripe-client.ts` pins `2026-07-29.dahlia`; Firebase uses `2023-10-16`. Verify configured platform and Connect endpoints, subscribed events and actual refund/dispute/account payload shapes. An SDK-request version does not automatically change a webhook endpoint version. Run a small controlled real-provider staging sequence; do not describe mocks as provider proof.
5. **Supplier workflow:** order acknowledgement/deduplication, print geometry, supplier cost/payment, stock exceptions, pickup, tracking, cancellation, multiple-line parcel cost and both shop identities. Current Snapwear-shaped fake is not evidence of an approved real integration.
6. **Mail:** verified sender domain, actual shop display name/Reply-To, unsubscribe POST, password/invite expiry, provider retry exhaustion, failure alerts and operational delivery ledger visibility.
7. **Freeze/import:** re-census all collections at the actual freeze; prove no unpaid/unfulfilled/refundable obligations are stranded by archiving orders; reconcile public catalogue IDs, recipient and legal identity, open tokens/opt-outs and the legacy UID map. September's refunded test orders do not describe October's cutover state.
8. **Recovery/retirement:** restore database and object files together; reconcile external money/print effects before replay. Disable old Firebase writes/webhooks only after queue drain/reconciliation. Keep the rollback artifact's dependencies, secrets and operational ownership controlled.
9. **Logs/privacy:** inspect actual Workers invocation/request logs for recovery/reset tokens carried in URL paths/query strings, expiry/retention and who can read them. Application logs avoiding PII does not establish that platform request metadata does. Do not include example real credentials in the proof.

## Recommended order of work

1. Resolve the reachable renderer advisory and payload-size defect before broader exposed staging use.
2. Make mail failures recoverable and visible; fix object transition results and storage audit attribution.
3. Implement/prove the approved automated fulfilment provider and restore shop identity for customer communications. Keep POD checkout closed while no usable supplier exists.
4. Close the buyer recovery, closed-shop self-service, suppression import and personal-data lifecycle gaps.
5. Complete production pins, independent backup/restore and real-provider/domain evidence.
6. Have the owner approve an explicit parity scope. Customer accounts, reviews, DAC7, imports and optional modules must each be restored, deferred with an operational alternative, or deliberately retired.

The evidence supports continuing the migration, but it does not support describing this HEAD as a secure, fully automatic, feature-equivalent replacement ready for production cutover.

## External reference methodology

Platform-specific review used the current [Cloudflare Workers best-practices documentation](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) and downloaded Workers declarations. Vulnerability versions were checked against npm's advisory service and the linked advisory pages on 2026-10-14. Advisory severity and installed-version matches are reported separately from application exploitability. Temporary test/build/advisory logs are in `/tmp/chopshop-*-audit*` and `/tmp/chopshop-*-dependency-audit.json`; they are session evidence, not durable production records.
