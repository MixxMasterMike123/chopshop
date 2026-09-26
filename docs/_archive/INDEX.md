# Archive index

One line per file moved into `docs/_archive/` during the CP0 docs quarantine
pass. See `docs/cf-port/INVENTORY_DOCS.md` for the full classification and
evidence, and `docs/cf-port/PLAN.md` §3.3–3.4 for the retirement procedure.

Date archived: 2026-09-26.

## QUARANTINE-b8shield (5) — reseller-portal-era, fishing-lure content

- `src/wagons/ambassador-wagon/README.md` → `docs/_archive/b8shield/src/wagons/ambassador-wagon/README.md` — class: b8shield; reason: heavy B8Shield/fishing content ("fishing enthusiasts into powerful brand ambassadors"), zero real code references; no superseding doc (dead brand, feature not ported).
- `src/wagons/writers-wagon/README.md` → `docs/_archive/b8shield/src/wagons/writers-wagon/README.md` — class: b8shield; reason: "AI wagon for the B8Shield platform... fishing industry terminology", not referenced by path anywhere; no superseding doc.
- `src/wagons/writers-wagon/SETUP.md` → `docs/_archive/b8shield/src/wagons/writers-wagon/SETUP.md` — class: b8shield; reason: "first AI-powered wagon for the B8Shield platform", fishing industry terminology; only self-reference from `WagonManifest.js`, not live use; no superseding doc.
- `src/wagons/writers-wagon/prompts/ai-rules-system/README.md` → `docs/_archive/b8shield/src/wagons/writers-wagon/prompts/ai-rules-system/README.md` — class: b8shield; reason: ships inside the dead writers-wagon tree, no code references; no superseding doc.
- `public/images/README.txt` → `docs/_archive/b8shield/public/images/README.txt` — class: b8shield; reason: describes a B8Shield logo file/flow predating the ChopShop rebrand, not code-referenced; no superseding doc.

## QUARANTINE-superseded (4)

- `docs/TENANT_ISOLATION_AUDIT_2026-06-18.md` → `docs/_archive/superseded/docs/TENANT_ISOLATION_AUDIT_2026-06-18.md` — class: superseded; reason: zero live code references, findings recorded as fixed across later sessions; superseded by `docs/TENANT_ISOLATION_HARDENING_PLAN.md` (in `OBSOLETE/`) and memory `tenant_isolation_audit.md` / `tenant_isolation_hardening.md`.
- `docs/ADMIN_URL_SHOP_SCOPING_PLAN.md` → `docs/_archive/superseded/docs/ADMIN_URL_SHOP_SCOPING_PLAN.md` — class: superseded; reason: plan-stage doc for a decision now implemented; superseded by the shipped tenancy model, per memory `admin_config_shopid_seam.md` ("FIXED 2026-06-17").
- `docs/VARIANT_AUDIT_2026-07-02.md` → `docs/_archive/superseded/docs/VARIANT_AUDIT_2026-07-02.md` — class: superseded; reason: self-superseding, findings marked fixed inline ("✅ = fixed in c226eeb, deployed 2026-07-02"); superseded by memory `variants_shopify_model.md` ("rail model v2.2 LIVE 2026-07-02").
- `docs/FULL_SECURITY_PRODUCT_AUDIT_2026-08-15.md` → `docs/_archive/superseded/docs/FULL_SECURITY_PRODUCT_AUDIT_2026-08-15.md` — class: superseded; reason: same-day audit whose findings are exhaustively tracked as fixed; superseded by memory `codex_audit_2026_08_15.md` and by `docs/audits/2026-09-26-last-24-hours.md`.

## Not moved (for reference)

- `rules-tests/README.md` — class: QUARANTINE-firebase-only; stays in place until the CF port completes (still actively used per memory `emulator_localdev_gotchas.md`).
- The 7 UNSURE items from the inventory — pending an owner decision (see `docs/cf-port/INVENTORY_DOCS.md`).
- Everything under `OBSOLETE/` — pre-existing quarantine zone, untouched.
