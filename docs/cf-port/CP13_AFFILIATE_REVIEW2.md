# CP13 — second adversarial review of the affiliate design (v1 → v2)

Date: 2026-10-22 · Reviewer: an Opus subagent with fresh context, read-only on branch `cp13-affiliate` (Codex's own round is owed: its quota ran out mid-review, back 2026-10-23 02:18). Verdict on v1: **READY WITH FIXES** — 30 findings, two blockers in the money/migration path. Every finding is folded into `CP13_AFFILIATE_DESIGN.md` v2 and `CP13_BRIEFS.md`, marked `[R2-n]`; this file is the index of what changed and why.

| # | Sev | Finding (v1) | Resolution in v2 |
|---|---|---|---|
| 1 | blocker | `reversal < 0` CHECK aborts the refund batch on `succeeded → failed` | `reversal` admits either sign (§3.5) |
| 2 | blocker | `discount_authority` iff-CHECK fails on existing rows; burn re-gated on `= 'campaign'` skips pre-deploy checkouts | add → backfill `'campaign'` → triggers; burn gated on `IS NOT 'affiliate'` (§2.3, §2.2) |
| 3 | high | refund-only target ignores a lost dispute | `fraction_bp = 10000` when `dispute_status = 'lost'` (§4.2) |
| 4 | high | `ref` named two ways | `ref = transition_id` everywhere (§3.5) |
| 5 | high | dispute guard on the value the UPDATE just changed | guard on the stored post-state + NOT EXISTS (§4.2) |
| 6 | high | address squatting by "bjud in" | an unaccepted affiliate identity may be converted by a seller's/platform's invite (§1.3, §13.7) |
| 7 | high | three readers join `discount_codes` by the id | `COALESCE(dc.code, o.affiliate_code)` in receipts, email-effect, admin-orders; assigned to A1 (§2.2) |
| 8 | high | attribution tied to `discount_minor > 0` | attribution independent of the amount; 0 % allowed; viability discard keeps the facts (§2.2) |
| 9 | medium | delete-without-history orphans a paying checkout | no hard delete (§3.1) |
| 10 | medium | `held` counts the gross accrual and double-counts | held per ORDER net, once; cancelled-unrefunded released after 44 days (§4.4) |
| 11 | medium | no currency | `currency` on ledger, payouts, affiliates; balances per (affiliate, currency) (§3) |
| 12 | medium | invoice deletable / unbound to the affiliate | `affiliate_invoice_objects` + immutable at request (§3.6b) |
| 13 | medium | login bounces affiliates; trees are chosen by path | third path tree `/affiliate/*`; LoginPage + AdminRoute changed (§1.2, A3) |
| 14 | medium | new outbox kinds unroutable; wrong files | email-effect/effects/nudge/email-delivery-store assigned to A1 (§9) |
| 15 | medium | `shopSenderName` reads frozen content, not a tenant id | freeze `shopName`/`supportEmail` in each job (§9) |
| 16 | medium | provisioning presets `affiliate: true` | `OFF_AT_PROVISION` + the key lists (A4) |
| 17 | medium | OFF contradicts "payouts still work" | the reachable routes/pages named; detail + payout pages ungated with a banner (§4.5) |
| 18 | medium | "no accrual when OFF" vs frozen facts | reworded: no NEW quotes (A12, §4.5) |
| 19 | medium | staging affiliate has no password | the seed sets one through the reset-token recipe (A4) |
| 20 | medium | click route named three ways, unthrottled, prefix clash | `ref` on the `/v1/seo` call, hashed-visitor limiter, storefront routes flat, portal under `/v1/affiliate/*` (§2.1, §7.1) |
| 21 | medium | terms text in the frontend, sha seeded before the text exists | canonical module `src/affiliate/terms.ts` in A1 (§8) |
| 22 | low | `INSERT OR REPLACE` bypasses DELETE triggers; no `formula_version` | displacement trigger + column (§3.5) |
| 23 | low | `A × R` overflows int64 in SQL | basis-point formula, integer-only (§4.2) |
| 24 | low | campaign lookup could use the ref code | typed only (§2.2) |
| 25 | low | no `ExecutionContext` in `servePage`; 301 drops `ref`; HEAD counts | moot via the SEO call; `ref` kept on the Location; HEAD excluded (§2.1) |
| 26 | low | re-approval hits UNIQUE; wrong surface name; "set your password" to someone who has one | re-activate; surface `admin`; `affiliate_welcome` (§5.2, §9) |
| 27 | low | stale "not built: guide, materials" sentence | fixed (§7.3) |
| 28 | low | wrong/missing paths and assignments | fixed in the briefs |
| 29 | low | rule 17 vs impeccable; the portal shell | decided in A2's brief; §13.9 |
| 30 | low | literal hostname in a mail; "active admins" vs D99 | canonical origins; `shopNoticeAddress` (§9) |

Unanswered-audit items the reviewer listed (A §3.7/C4/C7 currency, A §8.8/B7 invoice binding, A §8.4 REPLACE, A §2.8/C8 tombstones, B1 readers, B3/C6 dispute overlap, B5 console list, B8 sender, C2 D30 reading for Mikael, C12 durable invite) are each closed by the rows above or by §13.
