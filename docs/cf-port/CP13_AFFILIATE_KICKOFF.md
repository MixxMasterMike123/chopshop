# CP13 — Affiliate on the Cloudflare port: kickoff

Written 2026-10-22 on `ed35268c` (branch `cf-port`). **Scope decision (Mikael, 2026-10-22): affiliate is IN for launch** — Kent wants it on day one. This reverses the 2026-10-14 scope (F21: "everything but affiliates + content studio") for affiliate only; the content studio stays out.

This file is the starting point for a NEW context window. Read it whole, then the inputs in §1, then do §4 in order.

## 1. Inputs (read before designing; nothing here is to be re-derived)

| What | Where | Why it matters |
|---|---|---|
| The live Firebase implementation, specified exactly | `docs/cf-port/specs/AFFILIATE.md` (562 lines, CP0) | §2 data model, §3 lifecycle, §4 precedence with Rabattkoder, §5 emails, §6 surfaces, **§7 dead/half-built (do not port), §8 security (🔴 8.1 approveAffiliate = account takeover, 8.2 plaintext credentials — the rebuild must not reproduce either)** |
| The decisions already framed, with recommended defaults | `docs/cf-port/DECISIONS.md` § "Affiliate rebuild (PORT-LATER)" D24–D30 | They were to be answered "before that checkpoint": that is now. §3 below proposes taking every default. |
| Feature keys | `cloudflare/src/platform/tenant-config.ts` `FEATURE_KEYS` / `NOT_PORTED_FEATURE_KEYS` (`affiliate`, `b2b`); D62 | `affiliate` moves from not-ported to the allowlist (opt-in, off by default like the other add-ons; the platform switches it on per shop) |
| The seam the port left open | `cloudflare/src/commerce/discount-codes.ts` ~L314 "AFFILIATE SEAM" + L352 "AFFILIATE BRANCH BELONGS HERE" | Production resolves an affiliate code FIRST and lets it win a collision with a Rabattkod; the return shape is already affiliate-ready |
| Order money facts | `cloudflare/src/commerce/checkout.ts` (frozen totals, VAT lines), `payment-events.ts`, `refunds.ts`, `withholding-release.ts`, `payouts.ts`, `connect-gateway.ts`; migrations `0019_money.sql`, `0010_discount_codes.sql` (`checkouts.discount_code_id`) | Commission base (D25) comes from the order's actual VAT lines; reversal (D26) hooks the refund/dispute path; payout (D29) = Connect transfer where the affiliate has an account, else manual |
| Mail | `cloudflare/src/email/*` (queue, ledger, templates, `auth-email-job.ts`), `CP10_MAIL_RECOVERY_DESIGN.md` | Application received / admin notification / welcome / conversion / payout mails go through the same queue; **no mail leaves staging (no Resend)** |
| Identity | `cloudflare/migrations/0002_auth_identity.sql` (`identity_access.account_type` enum: ordinary, tenant_admin, platform_admin, print_operator), `src/auth/*`, `platform/invites.ts` (password-set links), `tenant-members.ts` | An affiliate needs a login; D30 says per-shop logins. See the open question Q1. |
| The storefront has NO accounts | D81; `cloudflare/web/` (the web Worker holds no sessions) | The affiliate portal cannot live on the storefront host as it does on Firebase. See Q1. |
| Freeze export | `docs/cf-port/MIGRATION_MANIFEST.md` rows 5–8: `affiliates`, `affiliateClicks`, `affiliateApplications`, `affiliatePayouts` = **0 docs** | Nothing to migrate: this is a greenfield build with the spec as the behaviour reference |
| The Firebase UI as a starting point (ports, not copies) | `src/pages/admin/AdminAffiliates.jsx`, `AdminAffiliateEdit.jsx`, `AdminAffiliateCreate.jsx`, `AdminAffiliatePayout.jsx`, `AdminAffiliateAnalytics.jsx`; `src/pages/shop/AffiliateRegistration.jsx`, `AffiliateLogin.jsx`, `AffiliatePortal.jsx`, `AffiliateAnalyticsTab.jsx`; `src/components/AffiliateTracker.jsx`; `src/utils/affiliateCalculations.js`, `affiliatePayouts.js` (7,360 lines in all) | Admin pages follow the admin design (admin-neutral, wrapped in `AppLayout`); the design gate applies: look at every page rendered |
| Rules for builders | `CP11_BRIEFS.md` §0 (→ `CP4_BRIEFS.md` §0 rules 1–12, `CP5_BRIEFS.md` §0 13–19), prefix `CP13` | Working tree only, own files, gate = `tsc` + `vitest` + guards, Codex round per unit, "the seller sees ONE number" |

## 2. What the port must deliver (the launch scope)

1. **Application → approval → code.** A public application form on the shop's storefront (anonymous, rate-limited, no open-create abuse: §8.3), the shop admin's queue, approve/deny, a vanity or random code issued at approval, collisions with Rabattkoder refused at creation (D30), affiliate terms with a stored version accepted at first login (D28, MFL ad-marking duty).
2. **Attribution.** Code-only by default (D27): the code typed at checkout earns the commission; a `?ref=` link sets the code for the session and wins over a typed code (D24); a 30-day cookie ONLY behind consent, and no raw IPs stored. Precedence over Rabattkoder as in spec §4 and the seam in `discount-codes.ts`.
3. **Commission ledger.** On a PAID order: base = paid total − shipping, ex VAT from the order's actual VAT lines (D25); default rates kept (15 % affiliate discount / 10 % commission — confirm the pair in spec §3.2/§3.5); held through the 14-day withdrawal window; reversed pro-rata on partial refunds, fully on dashboard refunds and lost disputes (D26). Append-only ledger rows; the order carries the attribution (spec §2.5's fields, as D1 columns on `orders`/`checkouts`).
4. **Payout.** Connect transfer where the affiliate has a Connect account, manual (invoice) otherwise; no platform cut at first (D29). Payout rows + status; the affiliate's "Begär utbetalning".
5. **Surfaces.** Shop admin: Affiliates list, detail/edit, create, payout, analytics (behind the `affiliate` feature key, below the add-on divider). Affiliate-facing: registration page, login, portal (stats, code, link, payouts, terms). Platform: the add-on toggle only.
6. **Mails.** Application received (applicant), application notification (shop admin), welcome with the password-set link (the invite mechanism of `invites.ts`, never a plaintext password: §8.2), conversion / payout / denial notifications (D30).
7. **Not ported, by decision:** campaigns layer, campaign revenue share, ambassador CRM (D30, spec §7); the "send credentials" manual path (§7.4, §8.2); `approveAffiliate`'s takeover shape (§8.1).

## 3. Decisions — CONFIRMED 2026-10-22 (Mikael)

**The rule:** keep the Firebase behaviour (`specs/AFFILIATE.md`) as close as possible; deviate only where the spec shows a gap (§7 dead/half-built, §8 security) or where a clearly better solution exists, and say so in the design, per deviation. The D24–D30 defaults below are such deviations and are TAKEN; where a default and the Firebase behaviour differ, the design names both and keeps the default.

| # | Proposal (= DECISIONS.md default) |
|---|---|
| D24 | Typed code earns; `?ref=` link wins over a typed code |
| D25 | Base = paid − shipping, ex VAT from the order's VAT lines |
| D26 | Pro-rata reversal on partial refund; reverse on dashboard refund + lost dispute; hold 14 days |
| D27 | Code-only attribution; cookie only with consent; no raw IPs |
| D28 | Affiliate terms + MFL duty, stored terms version |
| D29 | Connect transfer where possible, manual otherwise; no platform cut at first |
| D30 | Per-shop logins; collisions refused; vanity codes allowed; notifications on; 15 % / 10 % kept; campaigns + ambassador CRM dropped |

## 4. Open questions the design must answer (new, not in DECISIONS.md)

- **Q1 — DECIDED 2026-10-22 (Mikael: "I trust your decision on this and auth") → option (a): the admin host, a new `identity_access.account_type = 'affiliate'`, Better Auth sessions, the invite/password-set machinery, one membership row per shop. The storefront keeps the public application form and the `?ref=` landing only.** Original question kept for the record:
- **Q1 (as asked) — where does an affiliate log in?** The storefront has no sessions (D81) and the web Worker holds none. Options: (a) the admin host (`admin.flippinstuff.se/affiliate/…`) with a new `identity_access.account_type = 'affiliate'` (migration; the enum is CHECKed) and Better Auth sessions as for tenant admins, the portal being a third surface of the admin Worker beside shop admin and platform; (b) a token link per mail with no password. **Recommend (a)**: real sessions, the invite/password-set machinery exists, "per-shop logins" (D30) maps to one membership row per shop. The shop's storefront keeps only the public application form and the `?ref=` landing.
- **Q2 — the order's attribution columns.** Spec §2.5 lists what Firebase wrote on `orders`; the port freezes money on `checkouts` and copies to `orders`. Decide the columns (affiliate id, code, commission base/amount/status, ledger id) and which table owns them; the tenant projections must not leak another affiliate's data.
- **Q3 — the storefront `?ref=` landing** on `<shop>.flippinstuff.se` (CP14's URL shape): the web Worker sets the session code without a cookie unless consent (D27) — define the storage (URL-carried into the checkout vs a first-party cookie behind consent).
- **Q4 — staging mail.** The application and welcome mails cannot be sent on staging; the smoke must read the queue ledger instead, as CP10 does.

## 5. Order of work (sizes in builder units; no human timelines)

1. **Codex audit of the spec + the seams** (½): a reviewer reads `specs/AFFILIATE.md` §7–§8 against the port's money and identity code and lists what the rebuild must NOT inherit and which seams it touches. Mikael's standing method ("first run a Codex audit").
2. **Design** (Opus, ½–1): `CP13_AFFILIATE_DESIGN.md` — data model (migration **0058** or the next free number; check `HANDOVER.md` for the current one), routes, the ledger's state machine, the attribution rule, Q1–Q4 answered, the admin and portal page list with Swedish copy. Codex round. Mikael's go.
3. **Build** (Opus; money + tenancy, so never Sonnet): A1 Worker data + routes + ledger + reversal + payout (≈2); A2 shop-admin pages (≈1, design gate); A3 application form + `?ref=` + portal (≈1, design gate); A4 mails + feature key + platform toggle (≈½). Codex round per unit, attestation, staging deploy, smoke with full URLs.
4. **Parity check** against spec §3 lifecycle, step by step, on staging with a test shop; the fake printer and the Stripe sandbox as today.

Total ≈ 4–5 units plus reviews. Depends on nothing else, but Q1 touches the identity enum, so it should land before the cutover's rename unit (CP14) rather than after.

## 6. Prompt to open the new window with

> Read `docs/cf-port/CP13_AFFILIATE_KICKOFF.md`, then `docs/cf-port/specs/AFFILIATE.md` and DECISIONS.md D24–D30. Mikael's answers are in the kickoff §3 (Firebase parity as the baseline, the D24–D30 defaults taken, deviate only for gaps or clearly better solutions) and §4 Q1 (admin host + `affiliate` account type). Start with step 1 of §5: a Codex audit of the spec against the port's money and identity seams, then write the design.
