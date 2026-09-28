#!/usr/bin/env bash
# guard/deploy.test.sh — proves scripts/cf-deploy.sh deploys in order and refuses what it must.
#
# No network, no Cloudflare, no real credentials, and the project's own repository is never
# touched. Every case runs a COPY of the script inside a throwaway git repository under $TMPDIR
# (its "origin" a bare repository beside it, its review notes recorded locally), with:
#   - a fake scripts/cf-preflight.sh that logs its arguments and fails on request;
#   - a fake cloudflare/web/check-storefront-build.mjs (plain Node) that logs the VITE_ values and
#     the Cloudflare variables it sees, writes cloudflare/web/dist (git-ignored), and on request
#     fails, leaves a stray file, edits a tracked file or moves HEAD;
#   - HOME inside the case, so ~/.config/chopshop/web.<env>.env is the test's.
# Git runs with the user's and the system's configuration shut out (no hooks, no signing), and
# GIT_CEILING_DIRECTORIES keeps every git command inside the throwaway tree. The shell exports
# a VITE_ variable and wrong Cloudflare credentials, which must never reach the build.
#
# Run: bash guard/deploy.test.sh

set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
WORK=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/cf-deploy-test.XXXXXX")" && pwd -P)
trap 'rm -rf "$WORK"' EXIT
ALL_OUT=$WORK/all-output.txt
: >"$ALL_OUT"

# Git: only the throwaway repositories, with no user or system configuration.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES \
  GIT_COMMON_DIR GIT_NAMESPACE
mkdir -p "$WORK/home"
: >"$WORK/gitconfig"
export HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/.config" GIT_CONFIG_NOSYSTEM=1 \
  GIT_CONFIG_GLOBAL="$WORK/gitconfig" GIT_CEILING_DIRECTORIES="$WORK" GIT_TERMINAL_PROMPT=0 \
  GIT_AUTHOR_NAME=deploy-test GIT_AUTHOR_EMAIL=deploy-test@example.invalid \
  GIT_COMMITTER_NAME=deploy-test GIT_COMMITTER_EMAIL=deploy-test@example.invalid

# What the shell holds and the build must never see.
export VITE_SHELL_LEAK=from-the-shell VITE_STRIPE_PUBLISHABLE_KEY=pk_live_FROM_THE_SHELL \
  CLOUDFLARE_API_TOKEN=INHERITED-WRONG-TOKEN CLOUDFLARE_ACCOUNT_ID=0d392e5c79e386966a98a214ac91a133

PK_TEST="pk_test_FAKEdeploy$$"
PK_LIVE="pk_live_FAKEdeploy$$"
SECRET_SK="sk_live_FAKEdeploysecret$$"
SECRET_SK_TEST="sk_test_FAKEdeploysecret$$"
SECRET_RK="rk_live_FAKEdeploysecret$$"
SECRET_WH="whsec_FAKEdeploysecret$$"
SECRET_ANT="sk-ant-FAKEdeploysecret$$"

make_repo() { # make_repo <case dir> — a clean, pushed, attested repository holding the real cf-deploy.sh
  local d=$1
  mkdir -p "$d/repo/scripts" "$d/repo/cloudflare/web" "$d/home/.config/chopshop"
  cp "$REPO/scripts/cf-deploy.sh" "$d/repo/scripts/"
  cat >"$d/repo/scripts/cf-preflight.sh" <<'EOF'
#!/usr/bin/env bash
printf 'preflight %s\n' "$*" >>"$FAKE_LOG"
case " $* " in
  *" --web "*) [ -z "${FAKE_FAIL_WEB:-}" ] || { echo "PREFLIGHT REFUSED: fake web refusal" >&2; exit 1; } ;;
  *) [ -z "${FAKE_FAIL_API:-}" ] || { echo "PREFLIGHT REFUSED: fake API refusal" >&2; exit 1; } ;;
esac
EOF
  cat >"$d/repo/cloudflare/web/check-storefront-build.mjs" <<'EOF'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const log = (line) => appendFileSync(process.env.FAKE_LOG, `${line}\n`);
log('build');
for (const k of Object.keys(process.env).sort()) {
  if (k.startsWith('VITE_')) log(`build-env ${k}=${process.env[k]}`);
  if (k === 'CLOUDFLARE_API_TOKEN' || k === 'CLOUDFLARE_ACCOUNT_ID') log(`build-cf ${k}`);
  if (k === 'NOT_A_VITE_NAME') log(`build-other ${k}`);
}
if (process.env.FAKE_BUILD_FAIL) process.exit(3);
mkdirSync(new URL('./dist/assets/', import.meta.url), { recursive: true });
writeFileSync(new URL('./dist/index.html', import.meta.url), '<div id="root"></div>\n');
const top = new URL('../../', import.meta.url);
switch (process.env.FAKE_BUILD_DIRTY) {
  case 'untracked': writeFileSync(new URL('stray.txt', top), 'x\n'); break;
  case 'tracked': appendFileSync(new URL('README.md', top), 'x\n'); break;
  case 'head': execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'moved'], { cwd: top }); break;
}
EOF
  chmod 755 "$d/repo/scripts/cf-deploy.sh" "$d/repo/scripts/cf-preflight.sh"
  printf 'dist\n.env\n.env.*\n' >"$d/repo/.gitignore"
  printf 'deploy test\n' >"$d/repo/README.md"
  git init -q --bare "$d/origin.git"
  (
    cd "$d/repo"
    git init -q
    git add -A
    git commit -q -m init
    git remote add origin "$d/origin.git"
    git push -q origin HEAD 2>/dev/null
    git notes --ref=reviews add -m "codex: PASS" -m "fable: PASS" HEAD
  )
  values staging "$d" <<EOF
# public build values of the storefront
VITE_STRIPE_PUBLISHABLE_KEY=$PK_TEST
VITE_PLATFORM_LEGAL_NAME="Test Platform AB"
export VITE_PLATFORM_ORG_NUMBER='556000-0000'
NOT_A_VITE_NAME=never-handed-over
EOF
}

values() { # values <env> [case dir] [mode] — web.<env>.env from stdin
  local f="${2:-$T}/home/.config/chopshop/web.$1.env"
  cat >"$f"
  chmod "${3:-600}" "$f"
}

attest_go() { (cd "$T/repo" && git notes --ref=reviews append -m "mikael: GO" HEAD); }

N=0
new_case() { N=$((N + 1)); T=$WORK/case$N; make_repo "$T"; }

run() { # run <cf-deploy args…> — in case $T; sets RC and OUT; $T/log holds the steps
  OUT=$T/out.txt
  : >"$T/log"
  set +e
  (cd "$WORK" && HOME="$T/home" FAKE_LOG="$T/log" FAKE_FAIL_API="${FAKE_FAIL_API:-}" FAKE_FAIL_WEB="${FAKE_FAIL_WEB:-}" \
    FAKE_BUILD_FAIL="${FAKE_BUILD_FAIL:-}" FAKE_BUILD_DIRTY="${FAKE_BUILD_DIRTY:-}" \
    bash "$T/repo/scripts/cf-deploy.sh" "$@") >"$OUT" 2>&1
  RC=$?
  set -e
  cat "$OUT" "$T/log" >>"$ALL_OUT"
}

steps() { # the order of what ran: api, build, web
  sed -n -e 's/^preflight [a-z]* --web -- deploy$/web/p' -e 's/^preflight [a-z]* -- deploy$/api/p' \
    -e 's/^build$/build/p' "$T/log" | tr '\n' ' ' | sed 's/ $//'
}

PASSED=0 FAILED=0
ok() { PASSED=$((PASSED + 1)); printf 'ok    %s\n' "$1"; }
bad() {
  FAILED=$((FAILED + 1)); printf 'FAIL  %s (exit %s, steps "%s")\n' "$1" "$RC" "$(steps)"
  sed 's/^/      | /' "$OUT"
}
expect_done() { # expect_done <name> <steps>
  if [ "$RC" -eq 0 ] && [ "$(steps)" = "$2" ] && ! grep -qE '^DEPLOY (REFUSED|FAILED): ' "$OUT"; then ok "$1"; else bad "$1"; fi
}
expect_line() { # expect_line <REFUSED|FAILED> <name> <steps> <substring of the one line>
  if [ "$RC" -ne 0 ] && [ "$(steps)" = "$3" ] && [ "$(grep -cE '^DEPLOY (REFUSED|FAILED): ' "$OUT")" = 1 ] &&
    grep "^DEPLOY $1: " "$OUT" | grep -qF -- "$4"; then
    ok "$2"
  else bad "$2"; fi
}
expect_refused() { expect_line REFUSED "$@"; }
expect_failed() { expect_line FAILED "$@"; }

# --- the order, and the target argument -------------------------------------------------------
new_case; run staging
expect_done "staging, no target → all: API, then the build, then the web Worker" "api build web"
if [ "$(grep '^preflight ' "$T/log")" = "$(printf 'preflight staging -- deploy\npreflight staging --web -- deploy')" ]; then
  ok "the preflight is called as '<env> -- deploy' and '<env> --web -- deploy'"
else bad "the preflight is called as '<env> -- deploy' and '<env> --web -- deploy'"; fi

new_case; run staging all
expect_done "staging all → API, build, web" "api build web"

new_case; run staging api
expect_done "staging api → the API only, no build" "api"

new_case; rm "$T/home/.config/chopshop/web.staging.env"; run staging api
expect_done "staging api needs no build values file" "api"

new_case; run staging web
expect_done "staging web → the build and the web Worker, no API deploy" "build web"

new_case; attest_go
values production <<EOF
VITE_STRIPE_PUBLISHABLE_KEY=$PK_LIVE
EOF
run production
expect_done "production (mikael: GO) → API, build, web" "api build web"
if grep -qx 'preflight production -- deploy' "$T/log" && grep -qx 'preflight production --web -- deploy' "$T/log"; then
  ok "production: the preflight is called with production"
else bad "production: the preflight is called with production"; fi

new_case; run staging both
expect_refused "unknown target → refused" "" "unknown target 'both'"
new_case; run staging web api
expect_refused "three arguments → refused" "" "usage: scripts/cf-deploy.sh <staging|production> [api|web|all]"
new_case; run qa
expect_refused "unknown environment → refused" "" "unknown environment 'qa'"

# --- a failure stops what follows --------------------------------------------------------------
new_case; FAKE_FAIL_API=1 run staging
expect_failed "the API deploy fails → nothing further runs (no build, no web)" "api" "the API deploy exited 1 — nothing further ran"

new_case; FAKE_BUILD_FAIL=1 run staging
expect_failed "the build fails → no web deploy; the line says the API IS deployed" "api build" "the storefront build or its check exited 3 — the API Worker IS deployed"

new_case; FAKE_FAIL_WEB=1 run staging
expect_failed "the web deploy fails → the line says the API IS deployed and the web Worker is not" "api build web" "the web deploy exited 1 — the API Worker IS deployed"

new_case; FAKE_BUILD_FAIL=1 run staging web
expect_failed "web only, the build fails → the line says nothing was deployed" "build" "exited 3 — nothing was deployed by this run"

# --- the build must leave the committed tree as it was -----------------------------------------
new_case; FAKE_BUILD_DIRTY=untracked run staging
expect_refused "the build leaves an untracked file → web refused" "api build" "the storefront build changed the working tree (1 path(s)"

new_case; FAKE_BUILD_DIRTY=tracked run staging
expect_refused "the build edits a tracked file → web refused" "api build" "the storefront build changed the working tree"

new_case; FAKE_BUILD_DIRTY=head run staging
expect_refused "HEAD moves during the deploy → web refused" "api build" "during the deploy — the build is no longer the attested tree"

new_case; FAKE_BUILD_DIRTY=untracked run staging web
expect_refused "web only, the build dirties the tree → refused" "build" "nothing was deployed by this run; the web Worker was NOT deployed"

# --- the build values -------------------------------------------------------------------------
new_case; rm "$T/home/.config/chopshop/web.staging.env"; run staging
expect_refused "no web.staging.env → refused before ANY deploy" "" "web.staging.env — the storefront's build values"

new_case; rm "$T/home/.config/chopshop/web.staging.env"; run staging web
expect_refused "web only, no web.staging.env → refused" "" "web.staging.env — the storefront's build values"

new_case; chmod 644 "$T/home/.config/chopshop/web.staging.env"; run staging
expect_refused "web.staging.env mode 644 → refused" "" "web.staging.env has mode 644 — it must be 600"

for secret in "$SECRET_SK" "$SECRET_SK_TEST" "$SECRET_RK" "$SECRET_WH" "$SECRET_ANT" "\"$SECRET_SK\"" "'$SECRET_WH'"; do
  new_case
  values staging <<EOF
VITE_STRIPE_PUBLISHABLE_KEY=$PK_TEST
VITE_PAYMENT_KEY=$secret
EOF
  run staging
  expect_refused "a secret-looking VITE_ value ($(printf '%s' "$secret" | cut -c1-8)…) → refused before any deploy" "" "VITE_PAYMENT_KEY starts with '"
done

new_case
values staging <<EOF
VITE_STRIPE_PUBLISHABLE_KEY=$SECRET_SK_TEST
EOF
run staging
expect_refused "a SECRET key as the publishable key → refused" "" "VITE_STRIPE_PUBLISHABLE_KEY starts with 'sk_', a secret key"

new_case
values staging <<EOF
VITE_STRIPE_PUBLISHABLE_KEY=$PK_LIVE
EOF
run staging
expect_refused "staging built with a pk_live_ key → refused" "" "VITE_STRIPE_PUBLISHABLE_KEY starts with 'pk_live_', staging requires a pk_test_… key"

new_case; attest_go
values production <<EOF
VITE_STRIPE_PUBLISHABLE_KEY=$PK_TEST
EOF
run production
expect_refused "production built with a pk_test_ key → refused" "" "production requires a pk_live_… key"

new_case
values staging <<EOF
VITE_PLATFORM_LEGAL_NAME=Test Platform AB
EOF
run staging
expect_refused "no VITE_STRIPE_PUBLISHABLE_KEY → refused" "" "defines no VITE_STRIPE_PUBLISHABLE_KEY"

new_case
values staging <<EOF
VITE_STRIPE_PUBLISHABLE_KEY=$PK_TEST
VITE_BAD-NAME=x
EOF
run staging
expect_refused "a VITE_ name that is no variable name → refused" "" "'VITE_BAD-NAME' is not a variable name"

new_case; run staging
if grep -qx "build-env VITE_STRIPE_PUBLISHABLE_KEY=$PK_TEST" "$T/log" &&
  grep -qx 'build-env VITE_PLATFORM_LEGAL_NAME=Test Platform AB' "$T/log" &&
  grep -qx 'build-env VITE_PLATFORM_ORG_NUMBER=556000-0000' "$T/log" &&
  [ "$(grep -c '^build-env ' "$T/log")" = 3 ] && ! grep -q '^build-cf ' "$T/log" &&
  ! grep -q '^build-other ' "$T/log"; then
  ok "the build sees exactly the file's VITE_ values: not the shell's VITE_, not a non-VITE_ line, no Cloudflare variable"
else bad "the build sees exactly the file's VITE_ values: not the shell's VITE_, not a non-VITE_ line, no Cloudflare variable"; fi

# --- VITE_ names in the repository root's .env files (Vite reads them too) ----------------------
new_case; printf 'VITE_FIREBASE_API_KEY=root-value\nOTHER=1\n' >"$T/repo/.env"; run staging
expect_refused "root .env defines a VITE_ name web.staging.env does not → refused before any deploy" "" \
  "/.env defines VITE_FIREBASE_API_KEY, which"

new_case; printf 'export VITE_SHOP_URL=https://x.example.test\nVITE_PORTAL_URL: y\n' >"$T/repo/.env.production.local"; run staging
expect_refused "root .env.production.local (export, colon syntax) → refused, naming both" "" \
  "/.env.production.local defines VITE_SHOP_URL VITE_PORTAL_URL, which"

new_case; printf 'VITE_FIREBASE_API_KEY=root-value\n' >"$T/repo/.env.local"
values staging <<EOF
VITE_STRIPE_PUBLISHABLE_KEY=$PK_TEST
VITE_FIREBASE_API_KEY=
EOF
run staging
if [ "$RC" -eq 0 ] && [ "$(steps)" = "api build web" ] && grep -qx 'build-env VITE_FIREBASE_API_KEY=' "$T/log"; then
  ok "a root .env.local name blanked in web.staging.env → deploys, and the build sees it empty"
else bad "a root .env.local name blanked in web.staging.env → deploys, and the build sees it empty"; fi

new_case; printf 'NODE_OPTIONS=--max-old-space-size=4096\n# VITE_COMMENTED=x\n' >"$T/repo/.env"; run staging
expect_done "a root .env without VITE_ names → deploys" "api build web"

new_case; printf 'VITE_ONLY_IN_API_RUN=x\n' >"$T/repo/.env"; run staging api
expect_done "root .env is not read for an api-only deploy (no build)" "api"

# --- the three refusals that come first ---------------------------------------------------------
new_case; printf 'x\n' >"$T/repo/untracked.txt"; run staging
expect_refused "untracked file before the deploy → refused, nothing ran" "" "working tree is not clean (1 path(s)"

new_case; (cd "$T/repo" && git commit -q --allow-empty -m local); run staging
expect_refused "HEAD not pushed → refused" "" "is not on any remote branch — push it first"

new_case; (cd "$T/repo" && git notes --ref=reviews remove HEAD 2>/dev/null); run staging
expect_refused "no attestation → refused" "" "has no review attestation line(s) 'codex: PASS' 'fable: PASS'"

new_case
values production <<EOF
VITE_STRIPE_PUBLISHABLE_KEY=$PK_LIVE
EOF
run production
expect_refused "production without mikael: GO → refused" "" "production needs Mikael's go"

# --- discipline -------------------------------------------------------------------------------
RC=0 OUT=$ALL_OUT
if grep -qF -e "$SECRET_SK" -e "$SECRET_SK_TEST" -e "$SECRET_RK" -e "$SECRET_WH" -e "$SECRET_ANT" "$ALL_OUT"; then
  bad "no secret-looking value in any output or build log ($N runs)"
else ok "no secret-looking value in any output or build log ($N runs)"; fi
OUT=$WORK/xtrace.txt
grep -nE '^[^#]*set -(x|o xtrace)' "$REPO/scripts/cf-deploy.sh" >"$OUT" || true
if [ -s "$OUT" ]; then bad "cf-deploy.sh never enables xtrace"; else ok "cf-deploy.sh never enables xtrace"; fi
OUT=$WORK/bash4.txt
grep -nE 'declare -A|typeset -A|local -A|mapfile|readarray|coproc|\$\{[A-Za-z_][A-Za-z0-9_]*(,,?|\^\^?)\}|\$\{[A-Za-z_][A-Za-z0-9_]*@[QEPAa]\}|&>>|\|&' \
  "$REPO/scripts/cf-deploy.sh" "$REPO/scripts/cf-preflight.sh" >"$OUT" || true
if [ -s "$OUT" ]; then bad "no bash-4-only construct in cf-deploy.sh / cf-preflight.sh"; else ok "no bash-4-only construct in cf-deploy.sh / cf-preflight.sh"; fi
# bash 3.2 (macOS) in a UTF-8 locale reads the first byte of a multibyte character into the name:
# $PK written right before an ellipsis is the variable "PK\xe2". Such a variable is braced: ${PK}.
OUT=$WORK/unbraced.txt
LC_ALL=C grep -nE '\$[A-Za-z_][A-Za-z0-9_]*[^ -~[:space:]]' "$REPO/scripts/cf-deploy.sh" "$REPO/scripts/cf-preflight.sh" \
  "$REPO/guard/deploy.test.sh" "$REPO/guard/preflight.test.sh" >"$OUT" || true
if [ -s "$OUT" ]; then bad "no unbraced \$VAR directly before a non-ASCII character (bash 3.2)"; else ok "no unbraced \$VAR directly before a non-ASCII character (bash 3.2)"; fi

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
