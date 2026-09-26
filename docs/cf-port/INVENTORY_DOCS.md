# Doc inventory — pre-Cloudflare-port quarantine candidates

Read-only inventory. Nothing was moved, edited or deleted. 68 doc-like files found
outside `node_modules`, `dist`, `functions/lib`, `.claude/`, `.git/` (also excluded:
`.firecrawl/`, `.github/`, `.impeccable/`, and `cloudflare/**/node_modules` — all
tool/vendor noise, not project docs).

## Summary

| Class | Count | Size |
|---|---:|---:|
| KEEP-LIVING | 11 | ~150 KB |
| KEEP-REFERENCE | 20 | ~230 KB |
| QUARANTINE-b8shield | 6 | ~29 KB |
| QUARANTINE-superseded | 3 | ~205 KB |
| QUARANTINE-firebase-only | 1 | ~9 KB |
| Already-quarantined (OBSOLETE/, pre-existing) | 20 | ~908 KB (untouched, no action needed) |
| UNSURE | 7 | ~380 KB |
| **Total files** | **68** | |

**Total size that would newly move under `docs/_archive/`** (excluding the
pre-existing `OBSOLETE/` tree, which the owner already treats as archived and
which `README.md` explicitly documents as "kept for reference only — not part
of the product"): **≈ 243 KB** across 9 files (6 b8shield + 3 superseded).
QUARANTINE-firebase-only (1 file, ~9 KB) should stay in place until the CF port
completes, then move too — bringing the eventual total to **≈ 252 KB**.

The old `OBSOLETE/` directory (908 KB, 19 files) is a pre-existing quarantine
zone from 2026-07-02 and doesn't need re-touching — it already matches the
target archive intent, just under a different folder name. Worth a follow-up
rename/merge into `docs/_archive/` for consistency, but that's a decision for
the owner, not this read-only pass.

## Proposed `docs/_archive/` layout

```
docs/_archive/
  b8shield-era/            # reseller-portal-specific docs (dead brand)
  superseded-audits/       # older audits/plans whose findings are recorded
                            # as fixed/absorbed elsewhere
  superseded-plans/        # older plans replaced by a newer doc on the same topic
  firebase-only/           # docs describing Firebase-specific mechanics being
                            # retired by the CF port — archive AFTER port completes
  INDEX.md                 # one line per archived file
```

One-line `docs/_archive/INDEX.md` entry format:

```
- `<original-path>` → `<archive-path>` — <one-line reason> (archived <date>, see <superseding-doc-or-commit>)
```

Example:
```
- `src/wagons/writers-wagon/README.md` → `docs/_archive/b8shield-era/writers-wagon-README.md` — B8Shield-era wagon spec (fishing-lure copy, pre-pivot); not referenced by any code (archived 2026-09-26)
```

---

## Full classification table

Legend: **Date** = last git commit date (`UNTRACKED` = never committed).
**Ref?** = referenced by path/filename from live code or docs (verified with
targeted greps, not just basename matching — basename collisions like the five
different `README.md` files were checked individually and de-duplicated).

### KEEP-LIVING (11)

| Path | Size | Date | Headings | Evidence |
|---|---:|---|---|---|
| `README.md` | 4.4 KB | 2026-08-30 | Chop Shop / What it does / Architecture: train + wagons | Root SSOT; explicitly links DESIGN.md, CAPABILITY_INVENTORY.md, WAGON_ARCHITECTURE.md |
| `DESIGN.md` | 9.2 KB | 2026-06-13 | DESIGN.md — "NORD" storefront design system | Linked from README.md; NORD design system is live per memory (`storefront_templating_direction.md`) |
| `CAPABILITY_INVENTORY.md` | 8.4 KB | 2026-07-02 | Capability Inventory — Storefront Platform | Linked from README.md as "honest map of what EXISTS/PARTIAL/MISSING" |
| `src/wagons/WAGON_ARCHITECTURE.md` | 3.8 KB | 2025-06-29 | B8Shield "Train + Wagons" Architecture | Linked from README.md; describes the still-current train/wagon pattern (uses B8Shield only as an illustrative train analogy, not reseller content — light de-brand of the title recommended, not quarantine) |
| `docs/POD_PRINT_SPEC.md` | 15 KB | 2026-08-30 | POD Print Spec — LÅST 2026-07-27 | 17 code/doc hits (functions/src/pod/*, functions/src/print/*, scripts/seed-pod-profiles.cjs); memory `pod_print_shop_spec.md` calls it SSOT, LOCKED |
| `docs/POD_MOCKUP_TEMPLATES.md` | 4.0 KB | 2026-08-18 | POD mockup templates — new-garment playbook | Referenced by `scripts/seed-pod-mockup-templates.cjs` |
| `docs/legal-template-files/README.md` | 9.2 KB | 2026-09-07 | Per-shop legal pages — auto-generation spec | Referenced by `src/config/store.js`, `src/config/legalTemplates.js`, `src/utils/legalPageReadiness.js` |
| `docs/legal-template-files/01-kopvillkor.md` | 6.4 KB | 2026-08-27 | Köpvillkor – {{shop_name}} | Template source, referenced by README.md above |
| `docs/legal-template-files/02-angerratt-och-returer.md` | 3.4 KB | 2026-08-27 | Ångerrätt & returer | Template source, same as above |
| `docs/legal-template-files/03-integritetspolicy.md` | 4.4 KB | 2026-08-27 | Integritetspolicy | Template source, same as above |
| `docs/legal-template-files/04-plattformsvillkor.md` | 12 KB | 2026-09-07 | Plattformsvillkor – ChopShop | Directly referenced from `src/config/platformTerms.js` |
| `docs/legal-template-files/05-personuppgiftsbitradesavtal.md` | 10 KB | 2026-09-07 | Personuppgiftsbiträdesavtal | Directly referenced from `src/config/platformTerms.js`; cross-linked from SnapWear DPA and LAUNCH_TODO |
| `docs/SnapWearDocs/LAUNCH_TODO.md` | 16 KB | 2026-09-26 | SnapWear launch — ToDo (single source of truth) | Explicitly self-declared SSOT; committed today; cross-referenced by `docs/audits/2026-09-26-last-24-hours.md` |
| `docs/SnapWearDocs/DPA_Meteor_PR_AB_Snapwear.md` | 16 KB | 2026-09-25 | DATA PROCESSING AGREEMENT (SUB-PROCESSING) | Live legal doc for current primary printer (SnapWear); referenced from LAUNCH_TODO |
| `docs/audits/2026-09-26-last-24-hours.md` | 12 KB | 2026-09-26 | Last 24 hours audit — 26 September 2026 | Most recent audit, committed today, cross-references LAUNCH_TODO + juridik.md + a rules-test file |
| `public/robots.txt` | 317 B | 2026-07-08 | (no markdown headings; robots directives) | Live, served asset — not a doc to archive |

(Note: table above has 16 rows though header says 11 — corrected count is **16 KEEP-LIVING**; see corrected summary note at bottom.)

### KEEP-REFERENCE (16)

| Path | Size | Date | Headings | Evidence |
|---|---:|---|---|---|
| `docs/PLATFORM_ARCHITECTURE.md` | 8.6 KB | 2026-06-14 | Platform Architecture — three siloed surfaces | 6 code hits (App.jsx, PlatformLayout.jsx, PlatformLeads/Models/Shops/ShopDetail.jsx) — describes current platform/admin/shop split, still accurate |
| `docs/SUPERADMIN_TENANCY_PLAN.md` | 19 KB | 2026-06-14 | Plan — Multi-tenant + Super Admin platform | 3 code hits (`tenancy.js`/`.ts`); memory confirms Phase 0+1 DONE, tenancy model still in use — plan partially executed, background still accurate, not superseded by a single newer doc |
| `docs/MULTITENANCY_INDUSTRY_COMPARISON_AND_CUSTOM_DOMAINS.md` | 6.1 KB | 2026-06-19 | Multi-Tenancy: Industry Comparison + Custom-Domain Architecture | Background research doc; custom-domains build tracked separately in memory (`custom_domains_cf_saas.md`, not deployed) — still relevant context |
| `docs/JAMFORELSE_SHOPIFY_VS_METEOR.md` | 10 KB | 2026-07-06 | Jämförelse: Shopify vs Meteor-plattformen | Referenced by/cross-linked with METEOR_PAKETERING_KENT.md; pricing/positioning doc, matches memory `business_pricing_icp.md` |
| `docs/METEOR_PAKETERING_KENT.md` | 18 KB | 2026-08-10 | Meteor — Säljhandbok | Sales handbook for Kent; recent (Aug), matches memory `pricing_tiers_two_brand.md` batch |
| `docs/METEOR_PAKETERING_KENT.pdf` | 314 KB | 2026-08-10 | (rendered PDF of the .md above) | Companion export of the .md — keep alongside it |
| `docs/Plattformsvillkor för e-handelsplattform.docx` | 44 KB | 2026-07-02 | (Word doc, platform terms draft) | Predecessor/parallel-track draft to `legal-template-files/04-plattformsvillkor.md`; not code-referenced but likely the lawyer-facing working doc — keep as reference, flag for owner to confirm still needed once .md is final |
| `docs/Tryckeriavtal för merchandise, produktion och fulfillment.docx` | 41 KB | 2026-07-02 | (Word doc, printer agreement template) | Same era as above; not code-referenced, printer-facing legal draft — keep, owner should confirm vs SnapWear DPA |
| `docs/legal-template-files/README.md` already listed above (KEEP-LIVING) | | | | |
| `functions/src/email-orchestrator/TEMPLATE_INVENTORY.md` | 2.7 KB | 2025-09-07 | EMAIL TEMPLATE DESIGN INVENTORY | Not code-referenced, but describes the still-live email-orchestrator module's template inventory (memory: email re-architecture LIVE 2026-07-03); useful design reference, not superseded by anything newer found |
| `rules-tests/README.md` | 972 B | 2026-06-14 | Firestore security-rules tests | Explains `npm run test:isolation`, mentioned in root README.md's "Running it" section (same command) — accurate, still describes the live test setup |
| `stripe-review-export/STRIPE_ARCHITECTURE.md` | 16 KB | 2026-07-02 | Stripe Connect — implementation review bundle (for legal review) | Legal-review export bundle; memory `stripe_compliance_remediation.md` says fixes are LIVE 2026-06-26, this doc predates/documents the reviewed state — keep as the reviewed-artifact record, not superseded (no newer "for legal review" bundle exists) |
| `stripe-review-export/MD_specs/README.md` | 2.7 KB | 2026-07-02 | Stripe + compliance work packages — spec & verification checklist | Index for the 7 spec files below; internally consistent set |
| `stripe-review-export/MD_specs/01-dispute-chargeback-recovery.md` | 2.3 KB | 2026-07-02 | 01 — Dispute / chargeback recovery | Part of the spec/verification set; memory confirms dispute recovery LIVE — this is the historical spec+verification record, keep as reference not superseded |
| `stripe-review-export/MD_specs/02-negative-balance-payout-controls.md` | 1.7 KB | 2026-07-02 | 02 — Negative-balance / payout-risk controls | Same set as above |
| `stripe-review-export/MD_specs/03-platform-fee-refund-config.md` | 1.4 KB | 2026-07-02 | 03 — Platform-fee-on-refund config | Same set |
| `stripe-review-export/MD_specs/04-pod-withdrawal-checkout.md` | 2.1 KB | 2026-07-02 | 04 — POD / right-of-withdrawal at checkout | Same set |
| `stripe-review-export/MD_specs/05-dac7-seller-data-and-reporting.md` | 4.2 KB | 2026-07-02 | 05 — DAC7 seller data + reporting | Same set; cross-referenced by FOLLOWUPS.md |
| `stripe-review-export/MD_specs/06-b2c-individual-sellers.md` | 1.3 KB | 2026-07-02 | 06 — B2C / individual sellers | Same set |
| `stripe-review-export/MD_specs/07-charge-model-decision.md` | 2.7 KB | 2026-07-02 | 07 — Charge model decision: destination vs direct | Same set; documents a still-live architectural decision (destination charges) |
| `stripe-review-export/MD_specs/FOLLOWUPS.md` | 10 KB | 2026-06-30 | DAC7/Stripe compliance — flagged follow-ups (not deploy-blockers) | Cross-referenced by/references VERIFICATION_RESULTS.md and STRIPE_COMPLIANCE_REMEDIATION_PLAN.md; open follow-up items not yet confirmed closed in memory — keep, active |
| `stripe-review-export/MD_specs/VERIFICATION_RESULTS.md` | 14 KB | 2026-06-26 | Acceptance-criteria verification — Stripe + compliance work packages | The verification record for the whole spec set; matches memory's "all live 2026-06-26" — historical acceptance record, keep |
| `stripe-review-export/code/seller-data.md` | 3.1 KB | 2026-07-02 | Seller/shop-owner data the platform persists (for DAC7 due-diligence) | Referenced by / cross-references STRIPE_ARCHITECTURE.md and the 05-dac7 spec; DAC7 thresholds doc in memory (`dac7_thresholds.md`) treats this domain as still-active — keep |
| `docs/STRIPE_COMPLIANCE_REMEDIATION_PLAN.md` | 32 KB | 2026-06-26 | Stripe Connect — Compliance & Financial-Exposure Remediation Plan | 6 hits including from FOLLOWUPS.md and VERIFICATION_RESULTS.md; memory confirms "ALL LIVE 2026-06-26" but this doc is the detailed plan-of-record for those fixes and is actively cross-linked — keep as reference, not superseded (it IS the record; nothing newer replaces it) |

### QUARANTINE-b8shield (6) — reseller-portal-era, fishing-lure content

| Path | Size | Date | Evidence |
|---|---:|---|---|
| `src/wagons/ambassador-wagon/README.md` | 6.0 KB | 2025-08-01 | Heavy B8Shield/fishing content throughout ("fishing enthusiasts into powerful brand ambassadors", "B8Shield Ecosystem"); zero real code references (only matched other README.md files by basename, verified false-positive) |
| `src/wagons/writers-wagon/README.md` | 4.6 KB | 2025-06-29 | "AI wagon for the B8Shield platform... fishing industry terminology"; not referenced by path anywhere |
| `src/wagons/writers-wagon/SETUP.md` | 7.8 KB | 2025-06-29 | "first AI-powered wagon for the B8Shield platform"; "Fishing industry terminology"; only real reference is `WagonManifest.js` pointing to itself as a setup-guide link (self-reference, not evidence of live use) |
| `src/wagons/writers-wagon/prompts/ai-rules-system/README.md` | 9.2 KB | 2025-06-29 | Generic "AI Rules System v2.0" doc but lives entirely inside the b8shield-era writers-wagon tree alongside the above; no code references found; ships with the dead wagon |
| `public/images/README.txt` | 614 B | 2025-04-23 | "The B8Shield logo is now implemented..." — describes a logo file/flow that predates the ChopShop rebrand; not code-referenced |
| `docs/VARIANT_AUDIT_2026-07-02.md` — *(moved here, see note)* | — | — | **Correction: this file is NOT b8shield-era — see UNSURE below; removed from this class.** |

*(Note: `docs/VARIANT_AUDIT_2026-07-02.md` was mis-sorted during drafting; it belongs in QUARANTINE-superseded, see below. Corrected class count for QUARANTINE-b8shield is 5 files, ~28 KB.)*

### QUARANTINE-superseded (4)

| Path | Size | Date | Superseded by | Evidence |
|---|---:|---|---|---|
| `docs/TENANT_ISOLATION_AUDIT_2026-06-18.md` | **164 KB** | 2026-06-18 | `docs/TENANT_ISOLATION_HARDENING_PLAN.md` (already in OBSOLETE/) + memory `tenant_isolation_audit.md` ("55 findings; Phases F/H/B LIVE") + `tenant_isolation_hardening.md` ("Phase A LIVE, ruleset hardened") | Zero live code references; findings explicitly recorded as fixed in memory across three later sessions; largest single doc in the repo by far — high-value quarantine target |
| `docs/ADMIN_URL_SHOP_SCOPING_PLAN.md` | 5.3 KB | 2026-06-17 | Superseded in practice by the shipped tenancy model — memory `admin_config_shopid_seam.md` says "FIXED 2026-06-17: admin reads/writes MANAGED shop (useShopId)" same date, i.e. this plan's proposal is the thing that shipped | Zero code references; plan-stage doc for a decision now implemented and documented elsewhere |
| `docs/VARIANT_AUDIT_2026-07-02.md` | 4.9 KB | 2026-07-02 | Findings marked "✅ = fixed in c226eeb (deployed 2026-07-02)" inline; memory `variants_shopify_model.md` says "rail model v2.2 LIVE 2026-07-02" | Self-superseding — the doc records its own findings as already fixed at time of writing; zero code references; historical record only |
| `docs/FULL_SECURITY_PRODUCT_AUDIT_2026-08-15.md` | 32 KB | 2026-08-15 | Memory `codex_audit_2026_08_15.md` — "ALL Waves 0-3 DEPLOYED 2026-08-15... Remaining = 2 architectural... inside" | Zero code references; same-day audit whose findings are exhaustively tracked as fixed in memory; superseded by its own fix-commits and the later `docs/audits/2026-09-26-last-24-hours.md` which covers current state |

### QUARANTINE-firebase-only (1) — archive-after-port

| Path | Size | Date | Evidence |
|---|---:|---|---|
| `rules-tests/README.md` | 972 B | 2026-06-14 | *(Reconsidered — see correction)* Describes Firestore emulator test setup (`firebase emulators:start`), which is Firebase-specific and will be dead once the CF port completes and rules-tests either retire or get ported to a D1/CF equivalent. **Keep in place until port finishes** (still actively used per memory `emulator_localdev_gotchas.md`), then archive or rewrite for the CF equivalent. *(Moved out of KEEP-REFERENCE where it was double-counted above — see correction note in summary.)* |

### UNSURE (7)

| Path | Size | Date | Why unsure |
|---|---:|---|---|
| `docs/Plattformsvillkor för e-handelsplattform.docx` | 44 KB | 2026-07-02 | Not code-referenced. Could be (a) the original lawyer-facing draft that `legal-template-files/04-plattformsvillkor.md` was distilled from — keep as source-of-truth backup — or (b) a fully superseded predecessor now that the .md exists and is code-wired. Content not diffed against the .md (binary .docx, would need a parse pass). Owner should confirm intent before archiving. |
| `docs/Tryckeriavtal för merchandise, produktion och fulfillment.docx` | 41 KB | 2026-07-02 | Same situation — printer/production agreement template, same date as the platform-terms .docx, not code-referenced. Possibly superseded by the SnapWear DPA (`docs/SnapWearDocs/DPA_Meteor_PR_AB_Snapwear.md`, 2026-09-25) which is printer-specific and current, but this .docx may be a generic multi-printer template still needed for future printers (memory notes Adapt Media AB and Kim as other printer candidates). Needs owner call. |
| `juridik.md` (root, untracked) | 13 KB | UNTRACKED | A Swedish Q&A brainstorm/working note (prompt + AI answer about legal-disclaimer strategy) sitting at repo root, never committed. Content clearly fed into the platform-terms/legal-template build (matches the "tool vendor not party to the transaction" framing used in `04-plattformsvillkor.md` and memory `legal_ownership_platform_terms.md`). Referenced once, from `docs/audits/2026-09-26-last-24-hours.md`. Root-level placement is unusual — likely just a scratch note the owner dropped and forgot to move/delete. Not a doc that belongs long-term at root; recommend the owner decide whether to move it into `docs/` (as reference for the legal-template work) or delete it, since it's untracked anyway. |
| `docs/METEOR_PAKETERING_KENT.pdf` | 314 KB | 2026-08-10 | Not itself referenced by code, but it's a rendered export of the co-located and clearly-live `METEOR_PAKETERING_KENT.md`. Kept as KEEP-REFERENCE above on the assumption it's the distributable/sendable version of the sales handbook — flagging here too since its independent value (vs. just re-exporting the .md on demand) wasn't verified. |
| `OBSOLETE/docs/plattformsoverview.md` | 3.3 KB | UNTRACKED | Sits inside the already-quarantined `OBSOLETE/` tree but is itself untracked (never committed even there) — an oddity within an oddity. No heading text extracted (file may be near-empty or non-standard format). Low priority; already inside a quarantine zone, so no action needed regardless of classification. |
| `OBSOLETE/README.md` | 1.1 KB | UNTRACKED | The manifest for the `OBSOLETE/` folder itself is untracked, meaning `OBSOLETE/`'s own explanatory index was never committed to git despite the folder's 19 other files being committed 2026-07-02. Worth the owner committing this one file for the record, but it needs no archival action — it already IS the archive index for that tree. |
| `stripe-review-export/STRIPE_ARCHITECTURE.md` / whole `stripe-review-export/` tree | 128 KB total | 2026-06-26 to 2026-07-02 | Classified KEEP-REFERENCE above based on internal consistency and memory alignment, but flagging genuine uncertainty: this whole tree reads as a point-in-time "export bundle for legal review" (per its own title) rather than a doc meant to be maintained going forward. If the legal review is complete and its outcomes are fully absorbed into `docs/STRIPE_COMPLIANCE_REMEDIATION_PLAN.md` and memory, the entire `stripe-review-export/` directory (11 files) could reasonably be QUARANTINE-superseded instead. Recommend owner confirm whether legal review is closed before deciding. |

---

## Corrections to the summary counts above

The table-drafting produced two bookkeeping slips, corrected here:

1. **KEEP-LIVING** is actually **16 files** (not 11) — `public/robots.txt` and the
   4 legal-template files plus the README were all placed in that table but the
   header count wasn't updated as rows were added.
2. **`rules-tests/README.md`** was listed once under KEEP-REFERENCE and again
   under QUARANTINE-firebase-only during drafting. Correct final placement:
   **QUARANTINE-firebase-only** (it is Firebase-emulator-specific and should be
   revisited once the CF port lands), removed from KEEP-REFERENCE. KEEP-REFERENCE
   is therefore **19 files** (20 listed minus the rules-tests/README.md double-count,
   minus nothing else — the table above already shows 22 rows including the
   legal-template-files/README.md cross-reference line, which is a duplicate
   pointer not a distinct file).

**Corrected final counts:**

| Class | Files | Approx size |
|---|---:|---:|
| KEEP-LIVING | 16 | ~155 KB |
| KEEP-REFERENCE | 19 | ~225 KB |
| QUARANTINE-b8shield | 5 | ~28 KB |
| QUARANTINE-superseded | 4 | ~206 KB |
| QUARANTINE-firebase-only | 1 | ~1 KB |
| UNSURE | 7 | ~420 KB (dominated by 2 .docx + 1 .pdf) |
| Already-archived (`OBSOLETE/`, pre-existing, no action) | 19 | 908 KB |
| **Total accounted for** | **71*** | |

*71 vs. 68 found is due to the two cross-reference/duplicate-listing rows noted
above (`docs/legal-template-files/README.md` appearing as both a distinct
KEEP-LIVING file and a cross-reference note; the ambassador/writers-wagon
"corrected" row). The authoritative count is the 68-file list produced by the
initial `find` pass (see `/tmp/all_docs.txt` equivalent — reproducible via the
find command in the Method note below); this table's per-row evidence is the
reliable part, the summary arithmetic has the two acknowledged slips above.

**Real quarantine impact if acted on now (excluding OBSOLETE/, excluding
UNSURE pending owner decisions):**
- QUARANTINE-b8shield: 5 files, ~28 KB
- QUARANTINE-superseded: 4 files, ~206 KB (dominated by the 164 KB
  `TENANT_ISOLATION_AUDIT_2026-06-18.md`)
- **Total: 9 files, ~234 KB**

If the owner also resolves the UNSURE items toward archiving (the two .docx
files and the `stripe-review-export/` tree), potential additional quarantine
is up to **~505 KB** more (dominated by the 314 KB PDF and 85 KB of .docx
files, plus 128 KB stripe-review-export if closed).

---

## Other clutter (not doc files, flagged only — not touched)

| Path | Size | Note |
|---|---:|---|
| `cloudflare/` (repo root, untracked) | 355 MB | Untracked directory at repo root; per memory `hosting_deploy_from_main_only.md` this is described as "stale" and known to have caused a prior deploy incident. Almost entirely `node_modules` under it (self-contained CF migration project). Not a doc, huge, untracked — flagging for owner attention only. |
| `public/images/Hoddies/` | 70 MB | Untracked image dump at repo root inside `public/images/`; capitalization ("Hoddies") suggests a quick, unreviewed drop rather than a pipeline-processed asset folder. |
| `public/images/LongSleeves/` | 53 MB | Same pattern as above, untracked. |
| `public/images/tshirts_hanging/` | 51 MB | Same pattern, untracked — matches the "hanging-tee displacement mockups" feature per memory, likely source photography for that work. |
| `cloudflare/worker-startup.cpuprofile` | 20 KB | A Chrome/V8 CPU profile capture, almost certainly a debugging artifact accidentally left in the tree; sits inside the also-untracked `cloudflare/` dir. |
| `OBSOLETE/` | 908 KB | Not clutter — pre-existing, intentional quarantine zone, explicitly documented in root README.md as "kept for reference only." Listed here only for size context, not flagged as a problem. |

Total untracked non-doc clutter at/near repo root: **≈ 355 MB (`cloudflare/`) + 174 MB (three image dirs) ≈ 529 MB**, all untracked and none touched by this pass.

## Method note (for reproducibility)

File discovery:
```
find . \
  -path '*/node_modules' -prune -o \
  -path ./dist -prune -o -path './functions/lib' -prune -o \
  -path './.claude' -prune -o -path './.git' -prune -o \
  -path './.firecrawl' -prune -o -path './.github' -prune -o \
  -path './.impeccable' -prune -o \
  -type f \( -iname "*.md" -o -iname "*.txt" -o -iname "*.rtf" \
             -o -iname "*.docx" -o -iname "*.pdf" \) -print | sort
```
Reference checks used `grep -rl -F "<basename>"` across
`*.md *.js *.jsx *.ts *.tsx *.cjs *.mjs *.json *.sh *.yml`, excluding
`node_modules` and `.claude/worktrees/*` (stale full-repo copies from past
agent runs, which would otherwise inflate every file's reference count by ~35
false hits). Ambiguous basename collisions (five different `README.md` files,
etc.) were re-checked with path-qualified greps (e.g. `writers-wagon/README`)
before being counted as real references — most basename-only "hits" for the
wagon/rules-tests/stripe-export README.md files turned out to be false
positives once verified this way.
