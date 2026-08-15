# Cloudflare cutover checklist

**Project:** Chopshop / Meteor
**Status:** runbook only — it creates no Cloudflare resources and authorizes no cutover.
**Companion design:** [CLOUDFLARE_MIGRATION.md](CLOUDFLARE_MIGRATION.md)
**Scope:** personal Cloudflare account is the non-production account now; a separate, dedicated Cloudflare account is production later.

This is deliberately staged. Complete a stage, capture its evidence, and get the stated approval before proceeding. Never use a Cloudflare Global API Key, never paste a secret into this file, a shell history, source control, a ticket, or chat.

## Stop conditions and approvals

- [ ] Record the source commit SHA, migration owner, a proposed window, and a rollback owner.
- [ ] Confirm that the current Firebase security/outbox work is committed and its required test suite is green. This checklist must be run from a frozen, reviewed commit.
- [ ] Confirm that no customer data needs importing. If this changes, stop: design, test and approve an explicit export/import/reconciliation plan first.
- [ ] Confirm the existing Firebase system remains the sole production side-effect owner until the production cutover stage.
- [ ] **Approval required:** owner approves creating non-production resources in the personal Cloudflare account.
- [ ] **Approval required:** owner approves every external-state action later marked **CUTOVER**, **DNS**, or **DESTRUCTIVE**.

Do not make a production DNS change, register a production Stripe webhook, retire Firebase, delete an R2 object/bucket, or delete a D1 database solely because a preceding checkbox is complete.

## 1. Account and access isolation

### 1.1 Non-production: personal Cloudflare account

- [ ] Enable MFA on every human account with access; retain recovery codes in the approved password manager.
- [ ] Use the `meteorshop-stg-*` prefix for every migration resource. Existing unrelated personal-account resources remain out of scope; naming is an operational guard, not a security boundary.
- [ ] Record the account ID in the team password manager / secure operations record, not in the repository.
- [ ] Use `wrangler login` for interactive local work; verify the selected account before every destructive or remote command with `npx wrangler whoami`.
- [ ] Create a separate non-production CI API token. Limit it to this account and only the permissions needed to deploy the reviewed configuration (Workers, D1, R2, Queues, and Workers Containers as applicable). It must have no zone/DNS permission until a non-production custom domain actually needs it.
- [ ] Store that CI token only in the repository's protected non-production environment/secret store. Do not put it in `.dev.vars`, `.env`, a shell profile, or a CI log.
- [ ] Record token owner, account, purpose, permissions, creation date, review date, and revocation procedure.

### 1.2 Production: dedicated account, created later

- [ ] Do not create this account until the non-production smoke/soak gate passes and the owner approves it.
- [ ] Create **one dedicated `MeteorShop Production` Cloudflare account**, separate from the personal account. This account is the production project-isolation boundary; resource prefixes alone are not a security boundary.
- [ ] Add only named production operators; enforce MFA; remove broad/default membership where practical.
- [ ] Create a distinct production CI token scoped only to the production account. It must not access the personal/non-production account.
- [ ] Store the production token only in a protected CI production environment requiring deployment approval.
- [ ] Create a break-glass procedure with a time-bounded, audited human path. Do not use a standing global token as break-glass access.
- [ ] Verify a non-production token cannot enumerate or mutate the production account, and vice versa.

## 2. Version-controlled deployment contract

- [ ] Add reviewed, non-secret Worker configuration and infrastructure manifests to the application migration branch. Keep resource **names**, binding names, routes, cron schedules, compatibility date and non-secret vars in version control.
- [ ] Declare required Worker secret *names* in Wrangler's `secrets.required`; this makes deploy fail if a required secret is absent. Do not declare secret values in `vars`.
- [ ] Pin the Wrangler version in the migration toolchain and record the exact version used for rehearsal.
- [ ] Provide local-only `.dev.vars.example` with placeholder values only; gitignore the real `.dev.vars`/`.env` files.
- [ ] Generate Worker binding types in CI and fail type-check when a referenced binding is absent.
- [ ] Configure build/deploy so an explicit account ID/environment is required. A command may never infer a production account from the currently logged-in user.
- [ ] Keep routes/configuration in code. Dashboard changes are either prohibited or immediately reconciled into the manifest before the next deploy.

Suggested resource names (same bindings, different account):

| Purpose | Non-production | Production |
|---|---|---|
| Static surface Worker | `meteorshop-stg-web` | `meteorshop-prod-web` |
| API Worker | `meteorshop-stg-api` | `meteorshop-prod-api` |
| Jobs/queue Worker | `meteorshop-stg-jobs` | `meteorshop-prod-jobs` |
| Media Container Worker | `meteorshop-stg-media` | `meteorshop-prod-media` |
| D1 | `meteorshop-stg-db` | `meteorshop-prod-db` |
| Public R2 | `meteorshop-stg-public` | `meteorshop-prod-public` |
| Private R2 | `meteorshop-stg-private` | `meteorshop-prod-private` |
| Temporary R2 | `meteorshop-stg-temp` | `meteorshop-prod-temp` |
| Email queue / DLQ | `meteorshop-stg-email` / `meteorshop-stg-email-dlq` | `meteorshop-prod-email` / `meteorshop-prod-email-dlq` |
| Commerce queue / DLQ | `meteorshop-stg-commerce` / `meteorshop-stg-commerce-dlq` | `meteorshop-prod-commerce` / `meteorshop-prod-commerce-dlq` |
| Print queue / DLQ | `meteorshop-stg-print` / `meteorshop-stg-print-dlq` | `meteorshop-prod-print` / `meteorshop-prod-print-dlq` |
| Media queue / DLQ | `meteorshop-stg-media-jobs` / `meteorshop-stg-media-jobs-dlq` | `meteorshop-prod-media-jobs` / `meteorshop-prod-media-jobs-dlq` |
| Maintenance queue / DLQ | `meteorshop-stg-maintenance` / `meteorshop-stg-maintenance-dlq` | `meteorshop-prod-maintenance` / `meteorshop-prod-maintenance-dlq` |

Use the names only after the relevant manifest/design is approved. The documented commands below are templates; replace placeholders only in the approved terminal/CI context.

## 3. Non-production foundation — personal account

### 3.1 Workers and domains

- [ ] Create a non-production Worker deployment with no production route. Use the generated `workers.dev` hostname or an explicitly approved staging domain.
- [ ] Deploy the static app as `meteorshop-stg-web`; deploy API routes as `meteorshop-stg-api`; begin `meteorshop-stg-jobs` separately if its bindings/release cadence justify it. The media worker owns Container invocation only, not a public render endpoint.
- [ ] Configure four non-production surfaces before production: Platform, Shop Admin, Storefront, and Print.
- [ ] Use host-only `Secure`, `HttpOnly` cookies with distinct names per surface and no `Domain` attribute. Apply CSRF protection to cookie-authenticated state changes.
- [ ] Add strict origin allowlists, request IDs, redacted structured logs, CSP in report-only mode initially, and rate limiting/Turnstile for anonymous abuse-prone flows.
- [ ] Attach only the bindings required by each Worker. In particular, the public web Worker must not receive private R2, D1 administration, or Stripe secret bindings.

Example, **illustrative only** (this is a remote deploy; do not run until Stage 3 has approval):

```sh
npx wrangler deploy --config workers/api/wrangler.jsonc
npx wrangler whoami
```

### 3.2 Authentication and application authorization

- [ ] Implement the approved application identity layer (the migration design proposes Better Auth + D1); do not treat Cloudflare Access as customer/shop/print authentication.
- [ ] Create D1-backed users, identities, sessions, membership/role, verification and reset-token tables.
- [ ] Ensure every request derives tenant context from host plus authenticated membership or audited platform impersonation — never from a body/query `shop_id` alone.
- [ ] Add an explicit platform impersonation session with actor, reason, target shop, expiry, and immutable audit event.
- [ ] If Cloudflare Access is added, limit it to the workforce-facing Platform perimeter as defence in depth. It cannot replace application authorization.
- [ ] Test revoked session, cross-surface cookies, foreign-shop object IDs, tenant re-homing attempts, and unauthenticated private-object access.

### 3.3 D1

- [ ] Design initial D1 migrations from the domain model and invariants in `CLOUDFLARE_MIGRATION.md`; do not auto-convert Firestore documents table-for-table.
- [ ] Add immutable `shop_id` to every tenant-owned table and tenant-relative unique/index constraints such as `(shop_id, sku)`.
- [ ] Add unique constraints for Stripe event IDs, PaymentIntent IDs, refund IDs, idempotency keys, and asynchronous outbox/event keys.
- [ ] Create the non-production database only after review. Capture its database ID in the non-secret Wrangler manifest.
- [ ] Apply migrations locally first; inspect schema and run authorization/integration tests.
- [ ] **Approval required for remote state:** apply migrations to `meteorshop-stg-db`; capture the migration list and schema/version evidence.
- [ ] Use expand/contract migrations only. A release that stops reading an old column/table must not delete it in the same deployment.
- [ ] Before production, rehearse restore/rebuild from migrations and tested fixtures; no application route is permitted to execute arbitrary SQL.

Illustrative remote commands — **state-changing; do not run without the preceding approval**:

```sh
npx wrangler d1 create meteorshop-stg-db
npx wrangler d1 migrations apply meteorshop-stg-db --remote
```

### 3.4 R2

- [ ] Create three non-production buckets: public, private, and temporary (names in the resource table). R2 buckets are private by default; keep the private and temporary buckets private.
- [ ] Store the canonical bucket/key, owner/shop, media type, immutable version, and authorization metadata in D1. A key prefix such as `shops/{shop_id}/...` is a routing convention, not authorization.
- [ ] Public media is served through a tightly controlled public/custom-domain projection. Protected artwork, print files, customer documents, and exports are delivered only after a Worker validates tenant/role/order/artifact scope.
- [ ] Add lifecycle expiry to temporary staging/render/import objects and test that no active artifact uses a temporary key.
- [ ] Upload only synthetic fixtures to non-production. Verify guessed keys, wrong-shop keys, stale signed URLs, and direct bucket access fail.
- [ ] Configure R2 object-create notifications only for the specific private staging prefixes that should enqueue media work. Consumers must be idempotent.

Illustrative remote commands — **state-changing; do not run without approval**:

```sh
npx wrangler r2 bucket create meteorshop-stg-public
npx wrangler r2 bucket create meteorshop-stg-private
npx wrangler r2 bucket create meteorshop-stg-temp
npx wrangler r2 bucket notification create meteorshop-stg-private --event-type object-create --queue meteorshop-stg-media-jobs --prefix 'staging/'
```

### 3.5 Queues, outbox, cron, and Container

- [ ] Create the five non-production queues and their dead-letter queues. Configure explicit retry policy, batch/concurrency limits, monitoring, and operator replay/repair procedure.
- [ ] Port the current durable print-notification behavior to a D1 transactional outbox plus Queue message. A queue message is at-least-once: use deterministic event keys, a D1 unique constraint, a claim/lease, and a visible terminal failure state.
- [ ] Route email, commerce/Stripe secondary effects, print work, media work, and maintenance work through separate queue contracts. Do not enqueue raw customer/Stripe payloads when a resource ID and server-side re-load is sufficient.
- [ ] Make cron handlers enqueue deterministic maintenance work; they must not make non-idempotent side effects directly.
- [ ] Configure the media Container as queue-triggered/internal only. It reads private R2, runs Sharp/FFmpeg/FFprobe, writes versioned results to R2, and records status in D1. No direct public Container route.
- [ ] Require golden-image tests for the print pipeline and a bounded FFmpeg/FFprobe smoke test before enabling production media jobs.
- [ ] Demonstrate retry, duplicate delivery, lease expiry, DLQ arrival, alert, and safe operator replay with synthetic events.

### 3.6 Transactional email

- [ ] Keep the current mail provider as the non-production/production fallback until a canary passes; do not remove it during the first Cloudflare release.
- [ ] Onboard only an approved non-production sending domain/subdomain to Cloudflare Email Service. Add and verify its required SPF/DKIM/DMARC records.
- [ ] Configure `send_email` bindings with the narrowest allowed sender addresses. Use a fixed/allowlisted destination binding for operational notifications; do not grant a broad send binding to unrelated Workers.
- [ ] Send only synthetic recipient mail in non-production. Verify verification, reset, order, printer, admin, bounce/failure, and retry behavior.
- [ ] Record delivery evidence, headers, SPF/DKIM/DMARC result, and fallback-provider switch procedure.
- [ ] A no-printer result must be an explicit, visible terminal state or operator action; it must not disappear as a silent successful delivery.

### 3.7 Stripe

- [ ] Use only Stripe **test mode** in non-production. Keep all test keys/webhook secrets in Worker secrets, never frontend `vars`.
- [ ] Implement `POST /stripe/webhook` with raw-body signature verification before parsing; persist/unique-constrain Stripe event IDs before side effects.
- [ ] Recreate checkout, PaymentIntent idempotency, destination-charge/Connect behavior, refunds, disputes, DAC7 and order-state transitions from server-owned data.
- [ ] Register the staging endpoint in Stripe test mode only after the endpoint returns a health/smoke response and the owner approves this external configuration change.
- [ ] Use Stripe CLI/test events or the dashboard to prove duplicate event, delayed event, signature rejection, refund, dispute, and failure/retry behavior.
- [ ] Confirm that Firebase remains the only live-mode webhook side-effect owner during all non-production work.

## 4. Non-production dry-run and acceptance gate

- [ ] Start from a clean local database and synthetic R2 fixtures; run all D1 migrations.
- [ ] Run Worker unit, integration, and browser/surface tests locally, then against the non-production account.
- [ ] Run two synthetic shops through adversarial tenant tests: wrong host, wrong membership, guessed object/order/artwork IDs, cross-shop query, forged shop ID, and object key re-homing.
- [ ] Exercise: signup/verification/reset; admin and print access; product/design/POD mapping; checkout; Stripe test webhook; order; print job; status transition; email; refund; dispute; withdrawal/compliance paths required for launch.
- [ ] Verify that no public API leaks cost, wholesale, internal routing, private media, payment payloads, secrets, or raw error stacks.
- [ ] Verify Worker logs/analytics use request ID + actor/shop context and redact tokens, secrets, card/payment payloads and customer PII.
- [ ] Run queue/DLQ/Container smoke tests and verify failed work is visible and recoverable.
- [ ] Run accessibility/responsive smoke checks for Platform, Shop Admin, Storefront, and Print.
- [ ] Produce evidence: deploy version IDs, D1 migration list, binding inventory (names only), test results, Stripe test dashboard event IDs, Email Service canary headers, and rollback rehearsal result.
- [ ] **GO/NO-GO approval:** owner signs that non-production parity/security gates are met and authorizes creation of the dedicated production account.

## 5. Production preparation — dedicated account

- [ ] Repeat Stages 1–3 in the dedicated production account using only `meteorshop-prod-*` resources and a separate production CI identity.
- [ ] Do not copy databases/buckets manually from non-production. Recreate from reviewed migrations/configuration; production begins empty unless a separately approved data migration says otherwise.
- [ ] Load production secrets interactively or via protected production CI. Confirm secret *names* only using an inventory; never print values.
- [ ] Recreate all D1 schema/indexes, R2 lifecycle policies, Queue/DLQ bindings, cron schedules, Container configuration, email sender restrictions, observability and alerts.
- [ ] Run production-account smoke tests on an unrouted `workers.dev` or approved hidden production URL using synthetic data only.
- [ ] Confirm API Worker version, static Worker version, Container image/version, D1 migration version, and configuration revision are the exact approved release candidates.
- [ ] Configure production email domain but do not remove the existing provider. Send owner-approved real inbox canaries before sending customers.
- [ ] Create production Stripe webhook endpoint configuration only in a planned cutover window. Keep it disabled/inactive for side effects until the webhook switch checklist is reached.

### Secret inventory (names only)

Record which Worker needs each secret; populate only the actual current set during implementation. Typical current migration candidates include:

| Secret category | Example secret name (placeholder/name only) | Intended binding |
|---|---|---|
| Stripe server key | `STRIPE_SECRET_KEY` | API/commerce Worker only |
| Stripe webhook verification | `STRIPE_WEBHOOK_SECRET` | API webhook route only |
| Existing email fallback | `RESEND_API_KEY` or provider equivalent | email consumer only, temporary |
| Auth/session encryption | `AUTH_SECRET` | API Worker only |
| AI/provider keys, if retained | `ANTHROPIC_API_KEY` etc. | dedicated server workload only |
| Admin maintenance/legacy keys | rotate or retire; never carry forward blindly | only after explicit need review |

Client-visible Stripe publishable keys and non-secret public configuration may be deployed as non-secret vars only after review. Firebase configuration must not be carried forward as a runtime dependency.

## 6. Production cutover runbook

### 6.1 T-7 to T-1 days — read-only preparation

- [ ] **DNS approval required:** owner approves the migration of/changes to the authoritative zone and the exact host inventory.
- [ ] Export/document existing DNS records, DNSSEC state, registrar settings, email records, redirects, verification records, and Firebase custom-domain mappings. Independently compare the imported Cloudflare zone before changing nameservers or proxy status.
- [ ] Onboard the production zone to the dedicated production account without deleting the old configuration. Validate certificates and all required non-web records.
- [ ] Add Cloudflare Email Service records without overwriting unrelated mail-provider records unless their coexistence has been explicitly verified.
- [ ] Lower DNS TTL only after the owner approves the cutover window. Record old values and rollback values.
- [ ] Prepare a precise route map: Platform, Admin, Print, primary storefront, shop/custom domains, `/api/*`, Stripe webhook, static SPA fallback, redirects, and legacy Firebase fallback hosts.
- [ ] Freeze schema-destructive work, Firebase feature changes, and unrelated production deployments.
- [ ] Complete a production dry-run using the prepared release version and synthetic traffic.

### 6.2 Cutover window — **explicit owner go/no-go required**

- [ ] Announce start, change owner, rollback owner, and expected observation period.
- [ ] Confirm both old Firebase and new Cloudflare versions/URLs are known and reachable to operators.
- [ ] Take/record the final Firebase configuration, Hosting release IDs, Functions inventory, Firestore/Storage export decision, Stripe endpoint state, DNS record set, and email-provider state. This is rollback evidence, not Firebase deletion.
- [ ] Apply only backward-compatible D1 migrations already reviewed.
- [ ] Deploy Queue consumers/cron disabled or safely gated, then API, then static Worker assets. Record immutable Worker version/deployment IDs.
- [ ] Run pre-route production smoke tests with a synthetic shop and Stripe test-safe path.
- [ ] **Stripe switch approval required:** enable exactly one live side-effect webhook destination at a time. Verify raw-signature success for a live-safe test event; do not leave Firebase and Cloudflare both processing the same live event class.
- [ ] **DNS/CUTOVER approval required:** switch only the approved host routes/DNS records to the Cloudflare deployment. Do not change unrelated records.
- [ ] Purge only the explicitly approved application cache paths if necessary; do not use a broad zone purge by default.
- [ ] Verify certificate, redirects, host routing, CSP, session cookie scope, checkout, Stripe webhook receipt, transactional email receipt, print queue, private download authorization, and operator access from an external network.
- [ ] Monitor Workers errors, Queue/DLQ depth, D1 errors/latency, R2 access failures, Container failures, Stripe delivery log, email delivery and customer support signals continuously for the first two hours.

### 6.3 Immediate rollback — no debate if a stop condition occurs

Trigger rollback if tenant isolation, auth, payment/webhook integrity, private-object access, print fulfillment, or severe error-rate gates fail.

- [ ] Stop or gate Cloudflare consumers first so retries cannot create duplicate side effects.
- [ ] **Stripe rollback approval required:** disable the Cloudflare live webhook side-effect destination before re-enabling the Firebase destination; verify only one is active.
- [ ] **DNS/CUTOVER approval required:** restore the documented Firebase DNS/host route and previous TTL values.
- [ ] Roll API/static Workers back to the recorded last known-good version if DNS rollback is not the appropriate fix.
- [ ] Do not down-migrate D1. The Firebase rollback path must tolerate any expand-only Cloudflare schema work.
- [ ] Preserve logs, event IDs, queue/DLQ messages and exact timings for reconciliation; do not delete evidence.
- [ ] Tell the owner when rollback is complete and open an incident/reconciliation record before another attempt.

## 7. Seven-day observation and Firebase retirement

- [ ] Keep Firebase fully available as the rollback target for at least seven stable production days. Do not run parallel live Stripe side effects.
- [ ] Daily, reconcile Stripe events/orders/refunds, email failures, print/production jobs, queue/DLQ depth, media jobs, tenant authorization failures, and support incidents.
- [ ] Verify Cloudflare backups/export/rebuild capability, D1 migration recovery, R2 object recovery policy, Worker rollback, and alert routing.
- [ ] Remove every Firebase package/import/call, Firebase environment variable, Firebase CSP endpoint, Hosting rewrite and legacy fallback only after the Cloudflare replacement test passes.
- [ ] Add a CI detector that fails on runtime Firebase imports and require the full Cloudflare authorization/commerce/media test matrix.
- [ ] **Retirement approval required:** owner signs retention/compliance requirements, confirms rollback is no longer needed, and separately authorizes each Firebase shutdown/deletion action.
- [ ] Disable Firebase scheduled jobs and Functions only after Cloudflare jobs have been observed running correctly; revoke Firebase runtime and CI credentials; rotate any migrated secret.
- [ ] Archive required Firebase audit/configuration evidence according to the approved retention policy.
- [ ] **DESTRUCTIVE — separate approval per target:** only then delete Firebase Hosting, Functions, Auth/Firestore/Storage data, projects, or Cloudflare replacement resources. Record exact targets, confirmation, and recovery status.

## Reference commands and documentation

Commands here are examples, not authorization. `wrangler secret put` performs a Worker deployment/version change; do not use it casually. Prefer versioned/gradual deployment workflows and protected CI for production.

- Cloudflare Workers [configuration](https://developers.cloudflare.com/workers/wrangler/configuration/) and [secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- Cloudflare [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- Cloudflare [R2 bucket creation](https://developers.cloudflare.com/r2/buckets/create-buckets/) and [event notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/)
- Cloudflare Email Service [send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/) and [Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
- Cloudflare [Workers deploy/rollback commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/)

## Completion record

| Item | Owner | Date/time (UTC) | Evidence / version IDs | Approval |
|---|---|---|---|---|
| Non-production foundation complete |  |  |  |  |
| Non-production security/parity gate |  |  |  |  |
| Production account isolated |  |  |  |  |
| Production dry-run complete |  |  |  |  |
| DNS/Stripe cutover go decision |  |  |  |  |
| Two-hour smoke/monitoring gate |  |  |  |  |
| Seven-day observation complete |  |  |  |  |
| Firebase retirement decision |  |  |  |  |
