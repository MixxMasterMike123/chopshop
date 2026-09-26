# Cloudflare port — handover log

One entry per checkpoint (PLAN §9): what exists, how it was verified, both review notes, open gaps. Newest first. Branch `cf-port`.

## CP0 — Hygiene + baseline (approved 2026-09-26, in progress)

**Done (all on `cf-port`, each verified by Fable before commit):**
- `83080ed` `cloudflare/` worker tree + `docs/CLOUDFLARE_HANDOVER.md` + `RENDER_FARM_CONTRACT.md` brought over from `cloudflare-migration` @ `2b13d05`, unchanged.
- `e24f17a` **test gate green**: the six test-only POD env values cp27 forgot (`vitest.config.ts`, `test/env.d.ts`) + regenerated `worker-configuration.d.ts` — recovered from `stash@{0}`. `npm run check` → types up to date, tsc 0, **vitest 916/916** (independent run).
- `ea74f4e` docs quarantine: 9 files → `docs/_archive/{b8shield,superseded}` with `INDEX.md`; `docs/cf-port/RETIRED.md` ledger; 173 MB image dumps moved to `~/Cursor Apps/chopshop-quarantine/`; cpuprofile deleted; zero live references (verified).
- `8cd7466` `MIGRATION_MANIFEST.md` — 75 rows (22 carry / 46 archive / 7 drop), read-only prod census, 15 open questions (→ DECISIONS D9–D23).
- `b2a8ba9` `specs/AFFILIATE.md` — live program specified from source; found the `approveAffiliate` takeover hole → **hotfix `f807625` on `main`** (merged `65628e1`), deploy pending Mikael (DECISIONS D1).
- `d882b00` storefront **design baseline** — 12 launch-scope pages × 375/768/1440 on bundle `index-EybuBb5L.js`, manifest with sha256, re-shoot script + ImageMagick diff script (0.5 % gate); re-shoot 10 min later: 33/36 identical, 3 within 0.003 %.
- `5a0fe32` PLAN v3 (Codex rounds 1–3 folded in); `b1e8c97` `DECISIONS.md`.
- (this commit) **guards + preflight + deploy gate** — see commit message. Real preflight run authenticates to Kent's account and refuses on the still-old `wrangler.jsonc` account id (expected until CP1).
- `main` `a497d32` hotfix: `run-all.sh` always rebuilds; Firebase freeze announced in LAUNCH_TODO.

**Reviews:** Fable reviewed every builder diff line by line (this file's author). Codex reviewed the PLAN (3 rounds); Codex review of the CP0 *code* (guards/preflight/deploy) is **pending** — CP0 has no deploy, so the `cf-deploy.sh` gate is not yet exercised for real.

**Open in CP0:**
1. Hono router (replace the if-chain in `cloudflare/src/index.ts`) — can slide into CP1 with the routing contract.
2. Impeccable audit → design contract in `DESIGN.md` (PLAN §7.2).
3. Admin/platform baseline screenshots — needs a logged-in browser session handed off by Mikael.
4. Compromised-secret revocation (DECISIONS D4) — Mikael runs; Claude verifies unused first.
5. Code retirement of the DELETE list (DECISIONS D2) — wagons/dead callables removed from `src/` + `functions/src`, allowlist shrinks.
6. Codex review of the CP0 tooling.
7. **Token scopes** (DECISIONS D5b): the project token lacks R2 (`Workers R2 Storage: Edit`) and `DNS: Edit` — required before CP1 creates buckets/zones.

**Known gaps carried into CP1:** `wrangler.jsonc` must be retargeted (Kent's `account_id`, `env.staging`/`env.production` with the pinned names); `cloudflare/package.json` scripts call wrangler directly (bypass the preflight) — remove them; `cf-deploy.sh` does not itself enforce clean-checkout CI (CI does); git notes need `git push origin refs/notes/reviews`.
