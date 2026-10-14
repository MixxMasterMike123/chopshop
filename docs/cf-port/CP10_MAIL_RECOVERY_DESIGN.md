# CP10-MR — mail that survives the queue (audit 2026-10-14, F03 + F13). Design, nothing built.

Date: 2026-10-14 · Branch `cf-port` · After `89f38d4e` (the audit's fix-now batch). Decisions MR1–MR12 for Mikael, defaults stated; the unit is built on the defaults when he says so.

## The defect (F03), as it is

- Every mail is a job on the `-email` queue plus a row in `email_deliveries` (the ledger: kind, tenant, `recipient_hash`, status, attempts, `expires_at`, `job_fingerprint`). The ledger holds **no recipient, no body, no link** on purpose (PLAN §10: an operator sees that a delivery was asked for, never whom to).
- The queue is the only carrier of the job. Its consumer has `max_retries: 8`, no dead-letter queue (wrangler.jsonc says D1 makes one unnecessary — true for the outbox, **false for mail**: the outbox row is `done` the moment the job is enqueued, `email-effect.ts:655`, so the sweeper never looks at it again).
- A provider outage, a 5xx streak, or **no mail account at all** (staging today; production until Resend exists) burns the 8 retries — unconfigured delivery retries every 300 s, so in about 40 minutes — and the queue **drops the job**. The ledger row stays `pending` for ever. Nothing re-sends it. Observed on staging (handover 2026-10-05: "a held mail of ANY kind is dropped after about 40 minutes").
- Hit hardest: the invite and the reset (the lockout risk of the pre-launch memo), the confirmation, the shop's new-order notice, status and refund notices, the withdrawal receipt and the alert digest — which is the mail that would have told anyone.

Codex's adjustment (2026-10-14): a dead-letter queue plus an alert only makes the loss visible; the design must **retry recoverable failures by itself** and treat **expired invitation/reset links explicitly**.

## The design

**Two classes of mail, two recoveries.** The ledger row is the authority for both; the queue is a carrier that may lose a message without consequence.

### A. Rebuildable mail: rebuilt from its source rows and re-enqueued by the sweeper

`order_confirmation`, `order_notice_shop`, `order_status_update`, `refund_notice`, `withdrawal_receipt`, `withdrawal_notice`, `alert_digest`, `checkout_reminder` are all **derived** from rows that still exist (the order and its recipient, the withdrawal, the open alerts, the checkout) and their delivery id is already **derived from the source** (the outbox dedupe key, the withdrawal id, the digest bucket), so rebuilding gives the same job, the same ledger row, the same idempotency key at Resend.

1. **Migration 0057:** `email_deliveries` gains `source_kind TEXT` and `source_ref TEXT` (nullable; `NULL` for the auth kinds), written by every producer that enqueues (`email-effect.ts`, `withdrawals.ts`, `alert-digest.ts`, the reminder effect). Existing rows stay `NULL` and are treated as class B at their expiry.
2. **A scheduled step `email_redelivery`** (15-minute cron, after `outbox_sweep`, bounded to N rows per tick): rows `pending` whose `next_attempt_at` has passed, or `processing` whose `lease_until` has passed, with `attempts < max_attempts` and `expires_at` in the future, and `source_ref IS NOT NULL` → the step rebuilds the job from the source by `source_kind` (each effect exposes its builder; the effect modules already hold them) and `queue.send`s it again. **Safe to send twice:** the consumer's claim is lease-guarded, a `sent` row acks a late duplicate without a second send, and Resend dedupes the idempotency key for 24 h. If the source cannot be rebuilt (the order is gone, the checkout was purged) the row is closed `failed` with `last_error_code = source_missing`.
3. **The consumer stops burning queue retries while mail is unconfigured:** no key / no sender → the ledger row's `next_attempt_at` is pushed 15 minutes, the message is **acked**, and the sweeper owns it from there. The 8 queue retries then only ever cover provider 5xx/429 within one hour, which is what they are for.
4. **Attempts:** `max_attempts` stays 8 per row but counts real provider attempts only; the sweeper's re-enqueue does not count. A row still unsent at `expires_at` is closed `expired` (the status already exists).

### B. Auth mail: never rebuilt, expired explicitly, re-issued by the person who can

`email_verification`, `password_reset` (and its `invite` variant) carry a one-time token Better Auth minted; the ledger holds nothing of it on purpose and this design keeps it that way (MR4).

5. The same step closes an auth row that is still `pending`/`processing` past its lifetime as **`expired`** — today it just sits there — and raises **one platform alert per row**, kind `invite_undelivered` or `reset_undelivered`, resource = the ledger's delivery id, no recipient in it (the console's existing alert list shows it; the alert digest mails it too, but the console is the channel that does not depend on mail).
6. **Re-issue is a person's act, where it already exists:** the platform's "Skicka inbjudan igen" (`POST /v1/admin/members/:userId/resend-invite`, CP5-WK) for an invite; the user requesting again for a reset. The alert's text names that action. Nothing automatic mints a new token (MR6).

### C. Visibility that does not depend on mail

7. One alert kind **`email_backlog`** raised (and resolved) by the step when more than MR8's threshold of rows are `pending` older than one hour, or when any row expired undelivered in the tick. It shows in the platform console like the money alerts. The alert digest keeps going by mail; when mail is the thing that is down, the console still says so.
8. The `/ready` answer is not touched (it is public).

### D. F13 — long-lived links survive a secret rotation

9. `checkout-recovery-token.ts` derives its HMAC keys from `BETTER_AUTH_SECRET`; rotating the auth secret kills every mailed unsubscribe link. Design: a secret **`LINK_SIGNING_KEYS`** (JSON: `{"current":"k2","keys":{"k2":"…","k1":"…"}}`), the token's version field becomes `v2.<kid>`, verification picks the key by `kid`, `v1` tokens keep verifying against the derived key until MR11's date. Rotation = add a key, move `current`, keep the old key for the longest link life (the reminder's unsubscribe: unlimited by promise → keep 13 months, then drop; a dropped key's links answer the existing 404). No migration; tokens are stateless. Preflight pins that the secret exists and parses.

## What this does NOT do

- No dead-letter queue (MR2): the ledger plus the step IS the dead letter, and a DLQ would be a second copy of a job the ledger refuses to hold for auth mail.
- No stored job bodies (MR4): the ledger stays recipient-free; class A rebuilds, class B expires.
- No new mail provider, no SMS, no Slack. Visibility is the console.

## Decisions for Mikael (defaults in bold)

| # | Decision | Default |
|---|---|---|
| MR1 | Build this before the first real invitations go out? | **Yes** — the invite is the lockout path |
| MR2 | Dead-letter queue as well? | **No** (ledger + step) |
| MR3 | Sweeper cadence and bound | **every 15 min, 200 rows per tick** |
| MR4 | Store job bodies in the ledger for the auth kinds? | **No** — class B expires and is re-issued |
| MR5 | Auth row lifetime before `expired` | **the job's own `expires_at`** (reset 1 h, invite 72 h) |
| MR6 | Auto-re-issue an undelivered invite (new token) once mail is back? | **No** — the platform clicks "Skicka inbjudan igen"; the alert says so |
| MR7 | Unconfigured mail: ack and hand to the sweeper (3) vs. keep queue retries | **ack + sweeper** |
| MR8 | `email_backlog` threshold | **more than 0 rows pending older than 1 h, or any expiry in the tick** |
| MR9 | Count a rebuilt send against `max_attempts`? | **Only real provider attempts count** |
| MR10 | Build F13 in the same unit? | **Yes** (small; the rotation runbook is the larger part) |
| MR11 | Old `v1` recovery tokens stay valid until | **2027-11-14** (13 months), then dropped |
| MR12 | Legacy ledger rows with `source_ref NULL` (non-auth, from before 0057) | **expire at their `expires_at`, alert once in total** |

## Size and order

About one builder unit (Opus: money-adjacent effects, the ledger, migration 0057) plus a half unit for F13 and its runbook; the reviewer reads the step, the consumer change and 0057 whole. Tests: a queue that drops the message (never calls the consumer) → the row is re-enqueued and sent on the next tick; an auth row past lifetime → `expired` + alert; mail unconfigured for two hours then configured → every class-A row sent exactly once; an old `v1` unsubscribe token still verifying after a rotation.

Blockers: none in code. The Resend account (Mikael) is what makes the staging proof end to end; the tests prove it without.
