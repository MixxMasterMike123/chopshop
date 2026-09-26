# Retired items

This is the running ledger of things removed from active use during the
Cloudflare port, per `docs/cf-port/PLAN.md` §3.4 (retirement procedure).

## Procedure (PLAN §3.4)

For each item retired — whether a deferred feature or an outright delete —
before deletion:

1. Routes removed from `App.jsx`, navigation entries and feature flags removed,
   imports deleted (the `guard/` allowlist shrinks accordingly).
2. If the item has live Firestore data, it is **archived first**: a JSON export
   per collection to `chopshop-prod-private/archive/firebase/<collection>/`,
   checksummed, and listed in the manifest (`docs/cf-port/MIGRATION_MANIFEST.md`).
3. A one-line entry is added to this file: what was retired, where it was
   archived, and how to restore it.

This is done per checkpoint and verified by the guard allowlist shrinking
(never growing).

For the CP0 docs-quarantine pass specifically (no Firestore data involved —
these are plain files), "archived" means moved under `docs/_archive/` with an
entry in `docs/_archive/INDEX.md`; "restore" means moving the file back to its
original path.

## Ledger

| Item | Type | Retired on | Where archived | How to restore |
|---|---|---|---|---|
| `src/wagons/ambassador-wagon/README.md` | doc | 2026-09-26 | `docs/_archive/b8shield/src/wagons/ambassador-wagon/README.md` | `mv` back to `src/wagons/ambassador-wagon/README.md` |
| `src/wagons/writers-wagon/README.md` | doc | 2026-09-26 | `docs/_archive/b8shield/src/wagons/writers-wagon/README.md` | `mv` back to `src/wagons/writers-wagon/README.md` |
| `src/wagons/writers-wagon/SETUP.md` | doc | 2026-09-26 | `docs/_archive/b8shield/src/wagons/writers-wagon/SETUP.md` | `mv` back to `src/wagons/writers-wagon/SETUP.md` |
| `src/wagons/writers-wagon/prompts/ai-rules-system/README.md` | doc | 2026-09-26 | `docs/_archive/b8shield/src/wagons/writers-wagon/prompts/ai-rules-system/README.md` | `mv` back to `src/wagons/writers-wagon/prompts/ai-rules-system/README.md` |
| `public/images/README.txt` | doc | 2026-09-26 | `docs/_archive/b8shield/public/images/README.txt` | `mv` back to `public/images/README.txt` |
| `docs/TENANT_ISOLATION_AUDIT_2026-06-18.md` | doc | 2026-09-26 | `docs/_archive/superseded/docs/TENANT_ISOLATION_AUDIT_2026-06-18.md` | `mv` back to `docs/TENANT_ISOLATION_AUDIT_2026-06-18.md` |
| `docs/ADMIN_URL_SHOP_SCOPING_PLAN.md` | doc | 2026-09-26 | `docs/_archive/superseded/docs/ADMIN_URL_SHOP_SCOPING_PLAN.md` | `mv` back to `docs/ADMIN_URL_SHOP_SCOPING_PLAN.md` |
| `docs/VARIANT_AUDIT_2026-07-02.md` | doc | 2026-09-26 | `docs/_archive/superseded/docs/VARIANT_AUDIT_2026-07-02.md` | `mv` back to `docs/VARIANT_AUDIT_2026-07-02.md` |
| `docs/FULL_SECURITY_PRODUCT_AUDIT_2026-08-15.md` | doc | 2026-09-26 | `docs/_archive/superseded/docs/FULL_SECURITY_PRODUCT_AUDIT_2026-08-15.md` | `mv` back to `docs/FULL_SECURITY_PRODUCT_AUDIT_2026-08-15.md` |
| `public/images/Hoddies/` | asset dump | 2026-09-26 | `/Users/mikaelohlen/Cursor Apps/chopshop-quarantine/public-images/Hoddies/` (outside repo; untracked, ~70 MB) | `mv` back to `public/images/Hoddies/` |
| `public/images/LongSleeves/` | asset dump | 2026-09-26 | `/Users/mikaelohlen/Cursor Apps/chopshop-quarantine/public-images/LongSleeves/` (outside repo; untracked, ~53 MB) | `mv` back to `public/images/LongSleeves/` |
| `public/images/tshirts_hanging/` | asset dump | 2026-09-26 | `/Users/mikaelohlen/Cursor Apps/chopshop-quarantine/public-images/tshirts_hanging/` (outside repo; untracked, ~51 MB) | `mv` back to `public/images/tshirts_hanging/` |
| `cloudflare/worker-startup.cpuprofile` | debug artifact | 2026-09-26 | deleted (not archived — a Chrome/V8 CPU profile capture, untracked, ~20 KB, no restore path; re-capture if needed) | not restorable; re-run the profiler if needed |

## Not yet retired (pending)

- `rules-tests/README.md` — QUARANTINE-firebase-only; stays in place until the CF port completes, per `docs/cf-port/INVENTORY_DOCS.md`.
- The 7 UNSURE docs (two `.docx` legal drafts, `juridik.md`, `docs/METEOR_PAKETERING_KENT.pdf`, `OBSOLETE/docs/plattformsoverview.md`, `OBSOLETE/README.md`, `stripe-review-export/`) — pending Mikael's decision (PLAN §11 item 5).
- 82 functions inventory (13 DELETE, 40 PORT-LATER) — retired per-checkpoint as the port proceeds, each with its own ledger entry here.
