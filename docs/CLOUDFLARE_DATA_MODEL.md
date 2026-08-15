# Cloudflare target data model

**Project:** Chopshop / Meteor
**Plan date:** 2026-08-15
**Status:** Planning specification only. This document does not create Cloudflare resources, apply D1 migrations, or change application code.

## Purpose and design boundary

This is the relational data-model companion to [`CLOUDFLARE_MIGRATION.md`](./CLOUDFLARE_MIGRATION.md). It is based on the current repository, including the server-authoritative checkout fixes, B2B order path, Stripe webhook idempotency, transactional print-job transitions, and production-snapshot work in progress.

The target is one D1 database per environment, with an immutable `tenant_id` (`shopId` in the current code) on every tenant-owned row. The API Worker is the authorization boundary. D1 constraints protect identity and consistency, but they do not replace a trusted tenant context in application code.

The tables below are a planning-level contract, not a copy of the current Firestore documents. Names and columns marked **decision** require confirmation before migrations are written. Existing Firestore names and fields are called out where they are observed in code; fields that are not authoritative are deliberately not guessed.

Repository anchors used for this model include `functions/src/payment/createPaymentIntent.ts`, `functions/src/payment/stripeWebhook.ts`, `functions/src/order-processing/createB2BOrder.ts`, `functions/src/print/printProjection.ts`, `functions/src/print/notifyOutbox.ts`, `functions/src/print/setPrintJobStatus.ts`, `functions/src/pod/processArtwork.ts`, `src/utils/podMappings.js`, `functions/src/checkout-recovery/writeCheckoutDoc.ts`, `functions/src/product-reviews/*`, `functions/src/dac7/functions.ts`, `functions/src/withdrawal/functions.ts`, and `firestore.rules`. These are implementation observations, not a claim that every legacy field is still supported.

## Conventions

- D1/SQLite identifiers use `snake_case`; API compatibility adapters may continue to expose `camelCase` while migration is in progress.
- IDs are opaque text (UUID/ULID or a preserved external ID). Do not infer tenant ownership from an ID or object path.
- All timestamps are UTC ISO text or integer epoch milliseconds, chosen once for the schema. The recommendation is integer epoch milliseconds for ordering and comparisons; the current Firestore `Timestamp` values are conversion input only.
- Monetary values are integer minor units (`amount_minor`) plus an ISO currency code. The current B2C/Stripe path is in Stripe minor units; B2B currently calculates decimal SEK values. The conversion and VAT policy must be fixed before import.
- Booleans are `INTEGER NOT NULL DEFAULT 0` where SQLite needs a concrete type.
- JSON is acceptable for display-only, provider, and legacy payloads. It is not a substitute for columns used for authorization, uniqueness, ordering, state transitions, or reconciliation.
- `created_at` is immutable. `updated_at` is server-maintained. Financial, production, compliance, and audit rows are append-only or soft-retained; do not hard-delete them from normal application flows.
- Every foreign key that crosses a tenant boundary must carry a composite tenant check. Where SQLite cannot express the check conveniently, the repository transaction must perform it before the write.

## Target topology

| Concern | D1 | R2 | Queue/Worker |
|---|---|---|---|
| Tenant, users, catalogue, commerce, fulfilment, audit | Canonical records, relationships, state, hashes, indexes | — | API Worker transactions |
| Public media and shop assets | Artifact metadata and publication state | Public delivery objects | Media/publication jobs |
| Artwork originals, print files, documents, exports | Artifact metadata and ownership | Private objects | Media Container and signed-download API |
| Email, print, payment, media side effects | Outbox records, attempts, provider IDs | — | Queues with deterministic IDs and leases |
| Caches/rate counters | Small, disposable metadata only where needed | — | KV or Durable Object only where appropriate |

R2 keys are never authorization. Every protected object lookup must first validate the D1 owner, tenant, order, role, and artifact reference.

## Core identity and tenant tables

### `tenants` (source: `shops`)

One row per shop/storefront. `tenant_id` is the stable replacement for `shopId` and cannot be changed by a tenant actor.

| Column | Type/constraint | Source or purpose |
|---|---|---|
| `tenant_id` | `TEXT PRIMARY KEY` | Existing `shops/{shopId}` document ID |
| `status` | `TEXT NOT NULL` | Proposed: `active`, `suspended`, `closed`, `provisioning` |
| `shop_name`, `support_email` | `TEXT` | `storeIdentity`/support routing; exact source field names need confirmation |
| `default_locale`, `default_currency` | `TEXT` | Storefront and order defaults |
| `settings_json` | `TEXT` | Non-authoritative presentation/settings until normalized |
| `payments_json` | `TEXT` | Transitional provider/connect data; secrets never belong here |
| `created_at`, `updated_at` | `INTEGER NOT NULL` | Server timestamps |

Indexes: `tenants(status)`, normalized support email if used for routing. Do not index or expose arbitrary nested settings as public data.

### `tenant_domains`

| Column | Type/constraint |
|---|---|
| `domain_id` | `TEXT PRIMARY KEY` |
| `tenant_id` | `TEXT NOT NULL REFERENCES tenants(tenant_id)` |
| `hostname` | `TEXT NOT NULL UNIQUE` |
| `kind` | `TEXT NOT NULL` (`platform`, `custom`, `preview`) |
| `verified_at`, `created_at` | `INTEGER` |
| `status` | `TEXT NOT NULL` (`pending`, `verified`, `disabled`) |

Every host-to-tenant resolution must use a verified, active row. A request body must not override it.

### `users`, `auth_accounts`, `sessions`, `verification_tokens`, `password_reset_tokens`

The current `users/{uid}` documents contain platform/admin/shop/print identity and are read by authorization code. Customer auth and the replacement auth adapter are not yet selected.

Recommended planning shape:

| Table | Required columns and constraints |
|---|---|
| `users` | `user_id TEXT PRIMARY KEY`, `email_norm TEXT UNIQUE`, `display_name`, `status`, `platform_admin INTEGER`, `created_at`, `updated_at`, `deleted_at` |
| `auth_accounts` | `account_id TEXT PRIMARY KEY`, `user_id`, `provider`, `provider_subject`, `UNIQUE(provider, provider_subject)`; no password/token material in `users` |
| `sessions` | `session_id TEXT PRIMARY KEY`, `user_id`, `surface`, `token_hash UNIQUE`, `expires_at`, `revoked_at`, `created_at`, `last_seen_at` |
| `verification_tokens` | `token_id TEXT PRIMARY KEY`, `user_id`, `purpose`, `token_hash UNIQUE`, `expires_at`, `used_at`, `created_at`; store only a hash |
| `password_reset_tokens` | Same token rules; single-use, expiring, hashed, never logged |
| `tenant_memberships` | `membership_id`, `tenant_id`, `user_id`, constrained `role`, `status`, `created_at`, `updated_at`, `UNIQUE(tenant_id,user_id,role)` |
| `print_memberships` | `membership_id`, `tenant_id`, `user_id`, `printer_scope`, `status`, timestamps; printer access is explicit, not inferred from email |

Role values are a **decision**. The current code uses platform/admin/shop/print concepts and Firebase custom claims. Do not import a role string as authority without mapping it to an allowlisted role and tenant membership.

### Security and operator tables

`audit_events` (`event_id`, `actor_user_id`, `tenant_id NULL`, `action`, `resource_type`, `resource_id`, `reason`, `request_id`, `metadata_json`, `created_at`) is append-only and redacted. `impersonation_sessions`/`impersonation_audit` must record target tenant, operator, reason, start/end, and every privileged action. `admin_presence`, `user_wagon_settings`, and similar UI state are non-critical and may be deferred or kept in a separate operational table.

## Catalogue, publication, and POD tables

### Products and public projections

| Table | Planning columns |
|---|---|
| `products` (source `products`) | `product_id PK`, `tenant_id`, `status`, `sku`, `name_json`, `description_json`, `b2c_price_minor`, `b2b_price_minor`, `currency`, `availability_json`, `is_pod`, `is_active`, `internal_json`, timestamps |
| `product_variants` | `variant_id PK`, `tenant_id`, `product_id`, `sku`, `label_json`, `price_minor`, `active`, `attributes_json`, `UNIQUE(tenant_id,sku)` |
| `product_publications` (source `productsPublic`) | `product_id PK/FK`, `tenant_id`, `published`, `public_json`, `published_at`, `projection_version`, `updated_at` |
| `collections` | `collection_id PK`, `tenant_id`, `slug`, `title_json`, `status`, `sort_order`, timestamps; `UNIQUE(tenant_id,slug)` |
| `collection_products` | `tenant_id`, `collection_id`, `product_id`, `sort_order`, `PRIMARY KEY(collection_id,product_id)` plus tenant check |
| `pages` | `page_id PK`, `tenant_id`, `slug`, `status`, `title_json`, `body_json`, `published_at`, timestamps; `UNIQUE(tenant_id,slug)` |
| `product_groups` | `group_id PK`, `tenant_id`, `name_json`, `status`, `metadata_json`; exact use is unclear |
| `translations` | `tenant_id NULL`, `locale`, `translation_key`, `value_json`, `PRIMARY KEY(locale,translation_key,tenant_id)` |

`products_public` must be a server-maintained projection, never a client-writable mirror. It must exclude wholesale cost, internal availability, supplier/routing data, draft fields, private R2 keys, and moderation metadata. The API should still field-select public responses even if the projection table is accidentally queried by an internal route.

### POD artwork

| Table | Planning columns and invariant |
|---|---|
| `pod_artworks` (source `podArtwork`) | `artwork_id PK`, `tenant_id`, `purpose`, `status` (`draft`,`ready`,`rejected`,`archived`), `current_version_id NULL`, `created_by`, timestamps |
| `pod_artwork_versions` | `version_id PK`, `artwork_id`, `tenant_id`, `pipeline_version`, `original_object_key`, `print_object_key`, `preview_object_key`, dimensions/DPI, `validation_json`, `file_name`, `created_at`; all object keys immutable |
| `pod_mappings` (source `podMappings`) | `mapping_id PK`, `tenant_id`, `sku_or_prefix`, `placement_slot`, `artwork_id`, `profile_id`, `placement_json`, `position_json`, `slot_label`, timestamps; uniqueness on `(tenant_id,sku_or_prefix,placement_slot)` |
| `pod_profiles` | `profile_id PK`, `tenant_id NULL`, profile/pipeline constraints; source currently partly in `settings/podProfiles`, so ownership is a decision |

The current processor writes an original under a tenant prefix and generates versioned print/preview paths. A reprocess must create a new `pod_artwork_versions` row and new object keys. It must never overwrite the print object referenced by a paid order. A legacy document with only `originalStoragePath` must be represented explicitly as a legacy artifact and may only be used under an approved fallback policy.

### Immutable production snapshots

Do not resolve a paid order through live `pod_mappings` or the current `pod_artwork` row. Use child rows so the snapshot is queryable and protected from later mapping/artwork mutation.

`production_snapshots`:

| Column | Type/constraint |
|---|---|
| `snapshot_id` | `TEXT PRIMARY KEY` |
| `tenant_id`, `order_id` | `TEXT NOT NULL`; `UNIQUE(order_id)` |
| `version` | `INTEGER NOT NULL` |
| `created_at` | `INTEGER NOT NULL` |
| `state` | `TEXT NOT NULL` (`pending`,`complete`,`blocked`) |
| `unresolved_count` | `INTEGER NOT NULL DEFAULT 0` |
| `created_by_event_id` | `TEXT` |

`production_snapshot_lines`:

`line_id PK`, `snapshot_id`, `tenant_id`, `item_index`, `product_name`, `sku`, `variant_label`, `quantity`, `placement_slot`, `slot_label`, `placement_json`, `profile_id`, `mapping_id`, `artwork_id`, `artwork_version_id`, `print_object_key`, `print_fallback_key`, `preview_object_key`, `file_name`, `tier`, `unresolved_reason`, `created_at`.

Constraints/indexes: `UNIQUE(snapshot_id,item_index,placement_slot)`, index `(tenant_id,order_id)` through the parent, and no update/delete API for a complete snapshot. A line must either have a valid same-tenant artifact reference and private print object, or an explicit unresolved reason. It must not silently fall back to a changed live mapping.

Snapshot creation is a single transaction with the order state transition into the production-ready lifecycle (for B2C payment success and B2B invoice payment). Until complete, print queue/job/download APIs fail closed. `checkout` snapshots are separate pre-payment records and must not be promoted to an order without validating tenant, item, and payment identity.

## Customers, checkout, and orders

### Customers and checkout recovery

| Table | Planning columns |
|---|---|
| `customers` (source `b2cCustomers`) | `customer_id PK`, `tenant_id`, `auth_user_id NULL`, `email_norm`, encrypted/contact fields, `status`, timestamps; `UNIQUE(tenant_id,email_norm)` unless cross-tenant identity is intentionally centralized |
| `b2b_customers` | `customer_id PK`, `tenant_id`, `firebase_auth_uid` legacy mapping, company/contact/org/VAT/address fields, `active`, `status`, timestamps |
| `customer_addresses` | `address_id PK`, `customer_id`, `tenant_id`, address fields, `kind`, `is_default`, timestamps |
| `checkouts` (source `checkouts`) | `checkout_id/payment_intent_id PK`, `tenant_id`, customer email/name/language, consent flags, totals in minor units, `status`, `recovery_token_hash`, `production_snapshot_json` or child snapshot ID, `remind_at`, `expires_at`, timestamps |
| `checkout_suppressions` | `suppression_id PK`, `tenant_id`, `email_norm`, `reason`, `expires_at`, timestamps; `UNIQUE(tenant_id,email_norm,reason)` |

The current recovery document is server-only and includes email, cart snapshot, totals, a recovery token, and reminder/expiry state. Store only a hash of a recovery capability in the target. Never put the raw token in logs or a public projection.

### Orders and order items

`orders` (source `orders`) is the aggregate root:

| Column | Type/constraint |
|---|---|
| `order_id` | `TEXT PRIMARY KEY`; B2C may preserve Stripe PaymentIntent ID as an external key, but do not require all order IDs to be Stripe IDs |
| `tenant_id` | `TEXT NOT NULL REFERENCES tenants` |
| `order_number` | `TEXT NOT NULL`; `UNIQUE(tenant_id,order_number)` |
| `source` | `TEXT NOT NULL` (`b2c`,`b2b`) |
| `customer_id`, `b2b_customer_id`, `user_id` | Nullable FKs with same-tenant validation |
| `status` | Allowlisted order state; see state machine below |
| `currency` | `TEXT NOT NULL` |
| `subtotal_minor`, `shipping_minor`, `vat_minor`, `discount_minor`, `total_minor` | `INTEGER NOT NULL` |
| `customer_snapshot_json`, `shipping_snapshot_json`, `delivery_json` | Immutable checkout-time snapshots; avoid live customer/address joins for historical fulfilment |
| `production_snapshot_required` | `INTEGER NOT NULL DEFAULT 0` |
| `production_snapshot_id` | Nullable unique FK |
| `created_at`, `updated_at`, `paid_at`, `cancelled_at` | Server timestamps |

`order_items`:

`order_item_id PK`, `order_id`, `tenant_id`, `item_index`, `product_id NULL`, `variant_id NULL`, `variant_sku`, `sku`, `name`, `label`, `quantity`, `unit_price_minor`, `line_total_minor`, `image_object_key/url`, `is_personalized`, `is_pod_product`, `metadata_json`.

Constraints: `UNIQUE(order_id,item_index)`, positive integer quantity, non-negative monetary columns, and no updates to product/price/name/SKU snapshots after order creation. Product foreign keys are informational after creation; deleting a product must not break historical orders. Never trust client item prices, SKU, names, or print identity.

`order_status_history` is append-only: `history_id`, `order_id`, `tenant_id`, `from_status`, `to_status`, `actor_user_id/event_id`, `reason`, `metadata_json`, `created_at`, with an index `(tenant_id,order_id,created_at)`.

### Payments, refunds, and Stripe events

| Table | Planning columns and constraints |
|---|---|
| `payments` | `payment_id PK`, `tenant_id`, `order_id`, `provider`, `payment_intent_id`, `charge_id`, `method`, `status`, `amount_minor`, `currency`, `captured_minor`, `connect_json`, `provider_json`, timestamps; `UNIQUE(provider,payment_intent_id)` |
| `refunds` | `refund_id PK`, `tenant_id`, `order_id`, `payment_id`, `provider_refund_id UNIQUE`, `amount_minor`, `status`, `reason`, `provider_json`, timestamps |
| `payment_events` | `event_id PK` (Stripe event ID), `tenant_id NULL`, `provider`, `event_type`, `object_id`, `payload_hash`, `received_at`, `processed_at`, `status`, `error`; unique provider event ID |
| `connect_accounts` | `tenant_id PK`, provider account ID UNIQUE, onboarding/charges/payout status, commission policy, timestamps |
| `connect_transfers` | `transfer_id PK`, `tenant_id`, `order_id`, provider transfer/reversal IDs, amounts, status, idempotency key UNIQUE, timestamps |

The webhook transaction must insert `payment_events` first (or observe the unique existing row), then create/update the payment and order exactly once. Stripe signature verification uses the raw body before parsing. Duplicate `payment_intent.succeeded`, refund, dispute, account, and transfer events must be safe. Cumulative refunds must not exceed captured amount; all provider IDs and reversal idempotency keys are unique.

## State machines

Application code must implement an allowlisted transition table and compare the expected prior state inside one D1 transaction. A rejected transition writes no partial history or outbox row.

### Order/fulfilment status

The exact UI vocabulary is still a decision because current code uses `pending`, `invoiced`, `confirmed`, `processing`, `paid`, `partially_refunded`, `printed`, `shipped`, `delivered`, `completed`, `ready_for_pickup`, `cancelled`, and `refunded`. The proposed safe graph is:

```text
pending  -> invoiced | confirmed | paid | cancelled
invoiced -> paid | cancelled
confirmed -> processing | paid | cancelled | partially_refunded
paid -> processing | printed | shipped | partially_refunded | cancelled
processing -> printed | shipped | partially_refunded | cancelled
partially_refunded -> processing | printed | shipped | delivered | completed
printed -> shipped | ready_for_pickup | cancelled
shipped -> delivered | completed
ready_for_pickup -> completed
delivered -> completed
cancelled -> refunded (only when payment reversal/refund is complete)
refunded -> terminal
completed -> terminal
```

Do not use `paid` as proof that a production snapshot exists. The payment transition and snapshot transaction must either complete together or leave an observable `production_snapshot_required=1` blocked state. B2B `invoiced` is external invoice state; its payment confirmation is an authorized server/admin action, not a customer write.

### Payment/refund status

`requires_payment_method -> requires_action -> processing -> succeeded | failed`; `succeeded -> partially_refunded -> refunded`. Provider event processing may repeat a state but may not move backwards without an explicit reconciliation operation.

### Artwork and production

Artwork: `draft -> processing -> ready | rejected`; `ready -> processing` creates a new version, never mutates a version referenced by a production snapshot; `rejected` is terminal for that version. Production snapshot: `pending -> complete | blocked`; complete is immutable. Print delivery/outbox: see below.

## Outbox, email, queue, and idempotency model

### Generic outbox

`outbox_events`:

`outbox_id PK`, `tenant_id NULL`, `event_type`, `aggregate_type`, `aggregate_id`, `dedupe_key UNIQUE`, `payload_json`, `status` (`pending`,`processing`,`sent`,`skipped`,`failed`), `attempts`, `next_attempt_at`, `lease_token`, `lease_until`, `last_attempt_at`, `resolved_at`, `last_error`, `created_at`.

The aggregate transaction inserts the state change and its outbox event together. A dispatcher claims rows with a compare-and-set lease, sends a deterministic queue message, and resolves only if it still owns the lease. Expired leases are reclaimable. Backoff is bounded; exhausted attempts become visible `failed` rows and dead-letter/operator work, never silent loss.

### Print notification compatibility

The current `printNotifications/{orderId}` document maps to an outbox event with `dedupe_key = print-notification:{order_id}` and an immutable line payload. Preserve `shop_id`, order number, delivery method, SKU, quantity, and placement in the event. Do not rebuild the email from live mapping/artwork state. `sent`, `skipped`, and `failed` are terminal for that event; a deliberate resend creates a new event ID with an auditable reason.

### Email delivery

`email_deliveries`:

`delivery_id PK`, `tenant_id`, `event_id`, `order_id NULL`, `email_type`, `recipient_ref` (resource/customer reference, not arbitrary request email), `recipient_hash`, `template_version`, `provider_message_id`, `status`, `attempts`, lease/backoff fields, `last_error`, timestamps; `UNIQUE(event_id,email_type,recipient_hash)`.

The recipient and template are derived server-side from the resource and tenant. Customer-facing email payloads contain the minimum required snapshot. Duplicate concurrent sends claim the same delivery row; provider idempotency keys are deterministic. Email failures are visible in D1 and do not roll back an already-created order.

### Request/provider idempotency

`idempotency_keys`:

`scope PK`, `tenant_id`, `actor_user_id NULL`, `key_hash`, `operation`, `request_hash`, `response_status`, `response_json`, `state`, `expires_at`, timestamps; unique on `(tenant_id,operation,key_hash)`.

The stored request hash prevents a caller from reusing a key with a different payload. Retain provider event IDs independently: an application idempotency key is not a substitute for Stripe's event ID or PaymentIntent ID.

## Public projections and read models

The following are server-maintained projections, not client-writable Firestore mirrors:

- `product_publications` / `products_public`: published product name, images, variants, public prices, availability, SEO/display fields only.
- `shop_publications`: verified storefront name, branding object keys, locale/currency, and public policy/contact fields.
- `collection_publications` and `page_publications`: published, tenant-scoped content only.
- `product_reviews_public`: approved review text/rating and safe display metadata; no private customer email, moderation notes, or suppression tokens.
- Optional `order_public_status`: a narrowly scoped status projection if the storefront needs order lookup. It must not expose full customer/address/payment/production data.

Projection writes happen in the same transaction where practical or through idempotent outbox consumers. A stale projection is preferable to a private-field leak. Every public query includes tenant and publication/status predicates.

## Other observed domain tables

These are lower-priority but must have an explicit destination rather than disappearing during migration.

| Current Firestore collection/path | D1 target or disposition |
|---|---|
| `affiliates`, `affiliateApplications` | `affiliates`, `affiliate_applications`; tenant-scoped status and identity |
| `affiliateClicks` | `affiliate_clicks`; append-only click/referrer metadata with rate-limit/privacy policy |
| `affiliatePayouts` | `affiliate_payouts`; immutable finance rows and reconciliation IDs |
| `campaigns`, `campaignParticipants`, `campaignRevenueTracking` | `campaigns`, `campaign_participants`, `campaign_revenue`; aggregate writes transactionally tied to order events |
| `discountCodes` | `discount_codes`, optional `discount_redemptions`; atomic usage cap and tenant/expiry checks |
| `socialPosts`, handoff package reads | `social_posts`, `content_handoff_packages`; media object metadata in R2 |
| `leads` | `leads`; anonymous intake with strict rate limits and retention policy |
| `productReviews`, `reviewRequests`, `reviewSuppressions` | `product_reviews`, `review_requests`, `review_suppressions`; request tokens hashed and server-only |
| `order.withdrawal` / `order.withdrawalRequest` (no standalone collection writer was found) | `withdrawal_requests`; immutable legal/finance state, with the exact standalone-table decision still open |
| `dac7Sellers`, `dac7CorrectionRequests` | `dac7_sellers`, `dac7_correction_requests`; restricted platform access and append-only corrections |
| `customerDocuments`, `adminCustomerDocuments` | `customer_documents`; D1 metadata + private R2 object; separate operator authorization |
| `marketingMaterials` and `users/{uid}/marketingMaterials` | `marketing_materials`; decide whether user-owned rows are tenant-owned or platform-owned |
| `settings`, `appSettings` | `platform_settings` plus `tenant_settings`; secrets and credentials excluded |
| `orderStatuses` | Usually `order_status_history`/configuration; exact use must be confirmed before importing |
| `adminUIDs` | `platform_roles` or `tenant_memberships`; do not preserve as an independent authorization source |
| `impersonationAudit`, `auditLogs` | `audit_events` with source metadata |
| `migrations` | `migration_runs`/`migration_items`; operational and append-only |
| `passwordResets`, `emailVerifications` | `password_reset_tokens`, `verification_tokens`; only hashed single-use tokens |
| `checkoutSuppressions`, `reviewSuppressions` | Dedicated suppression tables with expiry and normalized lookup keys |
| `rateLimits` | Prefer a distributed limiter; if persisted, `rate_limit_buckets` is disposable and never an authorization record |
| `adminPresence`, activities/follow-ups/mentions | Defer or model as non-critical operational tables after product requirements are confirmed |

Collections with no explicit current server writer or whose exact shape was not found are listed as decisions, not silently assigned a guessed schema.

## Firestore-to-D1 mapping rules

| Firestore source | Target relationship | Migration rule |
|---|---|---|
| `shops/{shopId}` | `tenants`, `tenant_domains`, settings/connect child tables | Preserve `shopId` as `tenant_id`; normalize only known fields; quarantine unknown nested data in JSON |
| `users/{uid}` | `users`, memberships/roles, auth account | Map claims to allowlisted membership rows; do not let legacy claims remain authoritative |
| `products/{productId}` | `products`, `product_variants`, media | Preserve product ID; reject/quarantine rows with missing or cross-tenant shop ID |
| `productsPublic/{productId}` | `product_publications` | Rebuild projection from canonical product; do not trust public mirror as source of truth |
| `orders/{orderId}` | `orders`, `order_items`, `order_status_history`, payments, snapshots | Keep historical item/customer/payment snapshots; never recompute from current product/customer docs |
| `podArtwork/{artworkId}` | `pod_artworks`, `pod_artwork_versions` | Preserve every known print/preview path as a version; flag legacy `originalStoragePath` fallback |
| `podMappings/{mappingId}` | `pod_mappings` | Enforce tenant + SKU/prefix + slot uniqueness; mapping changes affect only future snapshots |
| `checkouts/{paymentIntentId}` | `checkouts`, optional checkout snapshot child | Hash recovery capability; retain payment identity and expiry, not raw token |
| `printNotifications/{orderId}` | `outbox_events`, `email_deliveries` | Preserve status/attempt/error history and immutable lines; do not duplicate on trigger retries |
| `productReviews`/review collections | review tables/projections | Keep private request/suppression data separate from approved public reviews |
| private storage paths | R2 object metadata | Copy objects under tenant-owned keys; verify source ownership and record content hash before activation |

Migration import should produce a report for: missing tenant, cross-tenant foreign key, duplicate `(tenant,sku,slot)`, non-positive money/quantity, invalid state, unknown role, missing production artifact, and malformed/expired secret token. A quarantined row must not become publicly or operationally active.

## Required transaction boundaries

1. **Create checkout:** validate tenant/product/variant/price/shipping/pickup/consent, reserve idempotency key, create Stripe intent metadata, and persist the immutable checkout/production graph before returning the client secret.
2. **Stripe success:** insert unique provider event, create order and item snapshots, create payment, create/complete production snapshot, append status history, and emit outbox events in one D1 transaction where provider calls are not required.
3. **B2B paid transition:** authorize the customer/shop/platform actor, compare expected status, create the production snapshot from the current mapping/artwork graph, append history, and emit print/email outbox events atomically.
4. **Refund:** insert unique refund, enforce cumulative amount, update payment/order derived state, append history, and emit commission/notification events exactly once.
5. **Print status:** authorize printer membership and tenant/order scope, compare expected prior state, verify snapshot completeness, update job/order state, append history, and emit status email event.
6. **Outbox claim/resolve:** lease by token, increment attempts, send using deterministic provider key, then resolve only if the lease is still owned.

## Ambiguities to resolve before migration SQL

- **Authentication provider and customer identity:** the current repository is Firebase Auth-centric; the Cloudflare plan names an application-owned adapter but does not select its final provider or password/passkey model.
- **Money semantics:** B2C/Stripe minor units and B2B decimal SEK currently coexist. Confirm currency policy, VAT-inclusive/exclusive display, rounding, and historic conversion.
- **Order transition vocabulary:** UI/status strings are spread across rules and functions. Freeze the canonical transition table before implementing constraints and print filters.
- **Production snapshot timing:** the code currently marks B2B orders `productionSnapshotRequired` before payment and builds snapshots on the paid lifecycle. Confirm whether B2C checkout snapshot promotion and B2B paid snapshot creation share one versioned format.
- **Legacy artwork fallback:** some artwork documents may have an `originalStoragePath` without a current generated print path. Decide whether those orders are blocked, manually remediated, or allowed through a clearly marked legacy pipeline.
- **SKU mapping semantics:** current print resolution supports exact SKU/per-slot and boundary-aware prefix matching. Confirm collision precedence and whether variant SKU, base SKU, or both are canonical.
- **Product/variant shape:** legacy products mix localized names, variant fields, images, and availability objects. Define normalized variant and media ownership before importing.
- **Tenant versus platform ownership:** settings, translations, marketing materials, activities, DAC7, and customer documents have mixed scopes. Do not infer scope from collection name alone.
- **Order/payment retention and PII:** define retention, encryption/key management, export, and deletion behavior for customer snapshots, addresses, provider payloads, and legal documents.
- **Email provider and template versioning:** the current orchestrator has resource-derived recipient logic; map each email type to a versioned template and deterministic dedupe key before queue migration.
- **Firestore timestamps and IDs:** choose one D1 timestamp/ID normalization policy and keep a source ID column for every imported record needed for audit/reconciliation.

## Acceptance tests for the data model

- Two tenants cannot read, write, attach, or download each other’s product, customer, order, mapping, artwork, document, or outbox rows—even when a valid foreign ID is supplied.
- A tenant actor cannot change `tenant_id`, order identity, item snapshots, payment amount/currency/provider ID, production snapshot lines, artifact object keys, or audit history.
- Duplicate Stripe event deliveries create one payment/order and one set of downstream outbox effects; duplicate provider callbacks are harmless.
- Two concurrent print workers cannot claim or transition the same job; an expired lease is recoverable, and an owned lease cannot be resolved by another worker.
- A failed email delivery remains visible and retryable, while a successful provider send cannot be duplicated by a concurrent retry due to the delivery idempotency key.
- Mapping/artwork edits after payment do not change an existing order’s placement, artwork version, print object key, or notification lines.
- Orders with an incomplete/legacy/unresolved production snapshot cannot be printed or downloaded until explicitly remediated.
- Partial refunds cannot exceed captured amount, and duplicate refund/dispute events do not double reverse transfers or commissions.
- Public projections contain no wholesale prices, internal costs, customer PII, private R2 keys, draft content, or routing/authorization fields.
- Tokens, secrets, provider payloads, and customer PII are absent from structured logs and are retained only under the approved retention policy.
