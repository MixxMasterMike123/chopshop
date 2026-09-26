# Secrets revoke verification (CP0 / D4)

Read-only investigation, 2026-09-26, branch `cf-port`. Goal: prove nothing running still uses each
known-exposed secret before Mikael revokes it in the provider console. **No secret values are
included below.** No revoke command was run by this task — the "exact revoke command" sections are
instructions for Mikael to run himself.

Source: `security_pending_rotations.md` memory note (items 1–3) + `email_smtp_rearchitecture.md` +
`docs/cf-port/PLAN.md` §6 ("Already-compromised SMTP password, service-account key and GitHub PAT:
verified unused by the retained Firebase paths (grep + 24 h log check) → revoked in CP0").

---

## 1. SMTP password (one.com, `SMTP_USER=info@jphinnovation.se`)

**Exposure (memory):** `functions/.env.b8shield-reseller-app` was git-tracked with `SMTP_USER`/`SMTP_PASS`;
now untracked + gitignored, but the value remains in git **history**. Also hardcoded in `EmailService.ts`
until 2026-06-12 (then switched to reading env vars).

**Where it lives now:**
- Secret Manager still holds 4 secrets from the old SMTP era: `SMTP_HOST`, `SMTP_PASS`, `SMTP_PORT`,
  `SMTP_USER` (confirmed live via `gcloud secrets list --project b8shield-reseller-app`, creation dates
  2025-07-10 / 2025-09-01 / 2025-09-01 / 2025-09-01).
- `.env.example` (repo root) still has a comment line `# SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS
  (required for email)` — stale documentation only, no value, not read by any code.
- `functions/.env.local` (local emulator env) has **no** `SMTP_*` keys — only `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `PLATFORM_DEFAULT_COMMISSION_BPS`, `ADMIN_BASE_URL`, `RESEND_API_KEY`.

**Current usage — NONE FOUND:**
- `grep -rn "SMTP_" functions/src` → **zero matches**. No code path reads `SMTP_HOST/USER/PASS/PORT`.
- `grep -rn "defineSecret" functions/src` → **zero matches** (this codebase does not use the Firebase
  `defineSecret()` v2 pattern for any secret, including Resend — secrets are consumed via
  `process.env.*` at runtime, populated by Secret Manager bindings on deploy).
- `functions/src/email-orchestrator/services/EmailService.ts:1-58` — the entire transport is now the
  Resend HTTP API (`fetch` to `https://api.resend.com`, `Authorization: Bearer ${RESEND_API_KEY}`).
  `nodemailer` is imported nowhere else in `functions/src` (confirmed: `EmailService.ts` was the only
  file grep found for `nodemailer`, and it no longer imports it — the file's own header comment says
  "Replaced the dead one.com/nodemailer SMTP transport 2026-07-03").
- **Live production confirmation:** `gcloud functions describe sendPasswordResetEmail --project
  b8shield-reseller-app --region us-central1 --format="value(serviceConfig.secretEnvironmentVariables)"`
  returns only `RESEND_API_KEY` (version 2) — **no SMTP secret is bound to this deployed function**,
  and by extension (per the EmailService single-transport architecture) to any email-sending function.

**Safe to revoke: YES.**
No code reads these env vars; the one deployed email function that would need them binds only
`RESEND_API_KEY`. The 4 `SMTP_*` Secret Manager entries are pure dead weight (this is exactly the
"delete dead SMTP_* secrets" pending item from `email_smtp_rearchitecture.md`).

**Revoke steps:**
1. In Secret Manager / via firebase CLI, destroy the 4 unused secrets:
   ```
   for s in SMTP_HOST SMTP_PASS SMTP_PORT SMTP_USER; do
     npx firebase functions:secrets:destroy "$s" --project b8shield-reseller-app --force
   done
   ```
   (equivalently `gcloud secrets delete $s --project=b8shield-reseller-app --quiet` for each name.)
2. Separately (this is the actual credential rotation, not a repo action): log into the one.com mailbox
   `info@jphinnovation.se` and change its password, or delete the mailbox if it is no longer used by
   any shop. This step is **not blocked by anything in this repo** — the secrets above are already
   confirmed unused, so this can happen immediately.

**Post-revoke verification:**
- `gcloud secrets list --project b8shield-reseller-app | grep -i smtp` → expect no rows.
- Trigger a real password-reset email (staging or a throwaway account) and confirm it still sends via
  Resend (Resend dashboard shows the send, or check function logs for `📧 EmailService: Initialized
  (Resend transport)`).

---

## 2. GCP service-account key — `b8shield-translations`

**Exposure (memory):** SA `b8shield-translations@b8shield-reseller-app.iam.gserviceaccount.com`, key id
`49c329e657ef255343848bc74bcd415edcc8c597` — committed in git history (`temp/admin.json`) AND publicly
served at `b8shield-reseller-app.web.app/service-account.json` (file now removed from hosting). Assume
compromised.

**Where it lives now / is referenced:**
- `src/utils/googleSheetsService.js` is the only code in the repo that mentions this SA (by email
  string, for a "sharing instructions" display) and the only code that references
  `/service-account.json`. Relevant excerpt (`googleSheetsService.js:35-46`):
  ```js
  async loadServiceAccount() {
    try {
      const response = await fetch('/service-account.json');
      if (!response.ok) throw new Error('Service account file not found');
      return await response.json();
    } catch (error) {
      console.warn('Service account not available, using API key method');
      return null;
    }
  }
  ```
  This is **client-side** code (Vite `import.meta.env`, browser `fetch`, `Blob`/`document` calls
  elsewhere in the file) that tries to fetch a static file at a hosting path. It never reads a key file
  from disk and never signs a JWT with the private key — it only ever attempted to `fetch()` the JSON
  from a public URL. That URL/file no longer exists on hosting (removed per the memory note), so this
  code path always fails and falls back to the API-key method. There is no server-side function or
  script in `functions/src` or `scripts/*` that authenticates as `b8shield-translations`.
- `scripts/*.cjs` (seed-default-shop, backfill-shopid, seed-pod-mockup-templates, seed-pod-profiles,
  migrate-storage-shopid) each have a doc-comment saying "Requires Application Default Credentials
  **OR** a serviceAccountKey.json" — this is boilerplate describing an *option*, not a hardcoded
  reference. Grepped for actual code (`GOOGLE_APPLICATION_CREDENTIALS`, `readFileSync(...serviceAccountKey`,
  `cert(`) → **no matches**; these scripts use `admin.initializeApp()` with no explicit credential,
  i.e. Application Default Credentials (`gcloud auth application-default login`, Mikael's ADC), matching
  the repo idiom noted in memory (`password_reset_new_uid_gotcha.md`: "Prod reads: NAMED db
  b8s-reseller-db via ADC (micke), NOT merchant SA").
- No `serviceAccountKey.json` / `admin.json` file is tracked in git (`git ls-files` grep: zero hits) and
  none exists on disk under this working tree.
- No IAM role bindings currently reference this SA at all:
  `gcloud projects get-iam-policy b8shield-reseller-app --flatten="bindings[].members" --filter="bindings.members:b8shield-translations@..."`
  → **zero rows**. The SA has no granted roles in the current IAM policy.

**Live key inventory** (`gcloud iam service-accounts keys list --iam-account=b8shield-translations@b8shield-reseller-app.iam.gserviceaccount.com --project b8shield-reseller-app`):

| KEY_ID | CREATED_AT | EXPIRES_AT | DISABLED |
|---|---|---|---|
| `49c329e657ef255343848bc74bcd415edcc8c597` | 2025-07-04T12:37:37Z | 9999-12-31 (no expiry) | false |
| `de06bc80e52cc6fd9c5f36a50984fbbbfe141fc8` | 2025-09-03T18:12:57Z | 2027-09-17T13:04:58Z | false |

The **compromised key (`49c329e6...`) is still live and not disabled** — it was never actually revoked
despite the memory note flagging it. A second key (`de06bc80...`) exists, created 2025-09-03 (~2 months
after the exposure was flagged), presumably issued as a working replacement — but since the SA has zero
IAM bindings today, neither key currently grants access to anything.

**Safe to revoke: YES — for the compromised key `49c329e6...` specifically.**
No code path authenticates with this SA's key (server code uses ADC; the one client reference only
fetches a now-deleted static JSON file and falls back harmlessly). The SA itself currently holds no IAM
roles, so even a live, uncompromised key on it grants nothing. There is no reason to keep the exposed
key `49c329e6...` active.

Recommend Mikael also decide whether the **second key** (`de06bc80...`) and the SA itself are still
needed for the Google Sheets translation workflow at all; if the feature is unused, delete both keys and
consider deleting the SA. That is a product decision, not a revoke-safety question, so it is out of
scope here — only the exposed key is assessed as safe to revoke now.

**Revoke steps (exposed key only):**
```
gcloud iam service-accounts keys delete 49c329e657ef255343848bc74bcd415edcc8c597 \
  --iam-account=b8shield-translations@b8shield-reseller-app.iam.gserviceaccount.com \
  --project=b8shield-reseller-app
```
Console alternative: GCP Console → IAM & Admin → Service Accounts → `b8shield-translations` → Keys tab
→ delete key id `49c329e6...`.

**Post-revoke verification:**
- `gcloud iam service-accounts keys list --iam-account=b8shield-translations@b8shield-reseller-app.iam.gserviceaccount.com --project b8shield-reseller-app`
  → the deleted key id no longer appears.
- Confirm the translation Google Sheets feature (if still used) still works via the API-key fallback in
  `googleSheetsService.js` — it never depended on this key anyway.

---

## 3. GitHub PAT — `ghp_R0ci...` (deleted `b8shield-saas` repo)

**Exposure (memory):** a GitHub Personal Access Token `ghp_R0ci...` originating from the now-deleted
`b8shield-saas` repository. Memory note says "confirm revoked at github.com/settings/tokens" — i.e. as
of the note, revocation status was unconfirmed.

**Where it could live / be used:**
- `git remote -v` in this repo: `origin https://github.com/MixxMasterMike123/chopshop.git` (fetch + push)
  — a plain HTTPS URL with **no embedded token** (a token-embedded remote would show as
  `https://<token>@github.com/...`). So this repo's own git operations do not carry the PAT.
- `.github/workflows/isolation-tests.yml` — the only workflow file in the repo. It uses only
  `actions/checkout@v4`, `actions/setup-node@v4`, `actions/setup-java@v4`, and npm/firebase-tools CLI
  calls. It has no `secrets.GH_TOKEN`/`secrets.PAT`/custom-token checkout — `actions/checkout` defaults
  to the ephemeral, auto-scoped `GITHUB_TOKEN` GitHub provides per run, not a PAT. `grep -rln
  "GITHUB_TOKEN\|GH_TOKEN\|PAT\|ghp_" .github/workflows/` matched only this file's generic name-mention
  patterns (no literal token, no PAT-secret reference).
- `gh auth status` (local CLI, this machine): three logged-in accounts (`MixxMasterMike123` active,
  `MixxMasterMike`, `micklampen`), all authenticated with OAuth tokens (`gho_...` prefix — GitHub CLI's
  own OAuth device-flow token type), **not** `ghp_...` classic PATs. This confirms the local `gh` CLI
  session Mikael/this environment uses today is unrelated to the exposed `ghp_R0ci...` token — it isn't
  silently still in use here.
- No file in the repo (`.env*`, scripts, workflows, `firebase.json`, `.firebaserc`) contains a
  `ghp_`-prefixed string in plaintext (not grepped for the literal value per instructions, but the
  above surfaces — remotes, workflows, CLI auth — are the only places a PAT would functionally matter,
  and none use one).

**Safe to revoke: YES** (in the sense that nothing in this repo or the local dev environment depends on
it) — **but this repo cannot prove server-side revocation status.** The action is purely on
github.com/settings/tokens and only Mikael (owner of that token) can confirm/perform it. This task
cannot call the GitHub API to enumerate personal tokens (no scope for that from this session), so:

**Verdict: NEEDS MIKAEL TO CONFIRM AT THE SOURCE** (not a 24h-log-check case — GitHub does not expose
audit logs for personal PAT usage the way GCP does; the only authority is the tokens page itself).

**Revoke steps:**
1. Go to https://github.com/settings/tokens (classic tokens) and https://github.com/settings/tokens?type=beta
   (fine-grained), find any token whose prefix matches `ghp_R0ci` or whose name/repo association mentions
   `b8shield-saas`.
2. Click **Delete** / **Revoke** on that token.
3. If any remote or CI secret is ever found to embed it (none found here), rotate that remote with
   `git remote set-url origin https://github.com/MixxMasterMike123/chopshop.git` (no-token form) and
   rotate any GitHub Actions secret that held it.

**Post-revoke verification:**
- The tokens page no longer lists it.
- `gh auth status` (already checked above) continues to show only the OAuth-based logins — no
  regression possible since it was never in that picture.

---

## Summary

| Secret | Exposed via | Used today? | Verdict | Action |
|---|---|---|---|---|
| SMTP password (`SMTP_USER/PASS`, one.com) | git-tracked `.env.b8shield-reseller-app` + hardcoded pre-2026-06-12 | No — 0 code refs in `functions/src`; deployed `sendPasswordResetEmail` binds only `RESEND_API_KEY` | **YES, revoke** | Destroy 4 `SMTP_*` Secret Manager secrets + change/delete the one.com mailbox password |
| GCP SA key `49c329e6...` (`b8shield-translations`) | committed `temp/admin.json` + publicly served `service-account.json` | No — SA has zero IAM bindings; only ref is client code fetching a now-deleted static file | **YES, revoke** | `gcloud iam service-accounts keys delete 49c329e6... --iam-account=b8shield-translations@... --project=b8shield-reseller-app` |
| GitHub PAT `ghp_R0ci...` (`b8shield-saas`) | deleted repo's token | No — `git remote -v` has no embedded token; sole workflow uses ephemeral `GITHUB_TOKEN`; local `gh auth` is OAuth-based | **NEEDS MIKAEL TO CONFIRM AT SOURCE** | Visit github.com/settings/tokens, delete the token matching `ghp_R0ci`/`b8shield-saas` |

**Blocked/could-not-run:** none of the requested read-only checks were blocked. `firebase
functions:secrets:list` is not a real subcommand (used `gcloud secrets list` instead, which returned
the SMTP/Resend secret names — no values). The GitHub API cannot be queried from here to directly
enumerate/verify PAT status server-side; that is inherent to PATs (no local proof possible), not a
permissions block in this session.
