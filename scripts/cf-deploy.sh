#!/usr/bin/env bash
# scripts/cf-deploy.sh <staging|production> [api|web|admin|all] — the only way to deploy (docs/cf-port/PLAN.md §0, §9).
#
# Deploys the API Worker (cloudflare/), the storefront's web Worker (cloudflare/web/) and the
# admin Worker (cloudflare/admin/), the API first: the other two call the API's Internal
# entrypoint over their service bindings, and the API carries the admin origin in its
# AUTH_TRUSTED_ORIGINS.
#   all  (the default)  a, b, c, d, e below — API, web, admin, in that order;
#   api                 a only;
#   web                 b and c only — a storefront change with no API change;
#   admin               d and e only — an admin change with no API change.
#
# Refuses (one line, "DEPLOY REFUSED: …", exit 1) unless:
#   1. the working tree is clean (no staged, unstaged or untracked changes) — deploy a SHA, not a tree;
#   2. HEAD is on a remote-tracking branch (pushed);
#   3. the review attestation for HEAD — a git note in refs/notes/reviews, i.e. OUTSIDE the
#      reviewed tree, so recording it does not change the SHA it certifies (Codex) — has the
#      lines "codex: PASS" and "fable: PASS"; production additionally "mikael: GO";
#   4. (web, admin, all) the build values are in order (see "Build values" below) — checked BEFORE
#      anything is deployed, so a missing or wrong file never leaves the API deployed alone.
# Then, in this order, each step only once the one before it succeeded:
#   a. scripts/cf-preflight.sh <env> -- deploy           the API Worker (account/resource/Stripe checks);
#   b. node cloudflare/web/check-storefront-build.mjs    the storefront build (Vite → cloudflare/web/dist,
#      git-ignored) and its check (no Firebase code, no source map, only files the Worker serves),
#      with the build values below and nothing else; afterwards the tree must still be clean and
#      HEAD unchanged — the build is made from the committed tree the attestations certify;
#   c. scripts/cf-preflight.sh <env> --web -- deploy     the web Worker;
#   d. node cloudflare/admin/check-admin-build.mjs       the admin build (npx vite build --config
#      vite.admin.config.js → cloudflare/admin/dist, git-ignored) and its check, with the admin's
#      build values and the same clean-tree / HEAD-unchanged re-check as b;
#   e. scripts/cf-preflight.sh <env> --admin -- deploy   the admin Worker (production is refused by
#      the preflight until pinned origins.admin is set).
# A step that fails prints one line, "DEPLOY FAILED: …" (or "DEPLOY REFUSED: …" when the build
# dirtied the tree or HEAD moved), saying what this run DID deploy, and exits 1; nothing after
# it runs.
#
# Build values: ~/.config/chopshop/web.<env>.env for the storefront, ~/.config/chopshop/admin.<env>.env
# for the admin — mode 600 like cloudflare.env and stripe.<env>.env beside them; parsed as the
# preflight parses those (KEY=value, optional `export`, optional quotes), never sourced. The PUBLIC
# values a build is made with: not secrets, but different per environment, so they never come from
# whatever the shell holds.
#   web.<env>.env (REQUIRED):
#     VITE_STRIPE_PUBLISHABLE_KEY=pk_test_…   REQUIRED; pk_test_ for staging, pk_live_ for production
#     VITE_PLATFORM_LEGAL_NAME=…              the platform's legal name
#     VITE_PLATFORM_ORG_NUMBER=…              its organisation number
#   admin.<env>.env (OPTIONAL: the admin build needs no value today, so a missing file means "no
#   build values"; when it exists it is checked as strictly as the other, and no name is required):
#     only VITE_STOREFRONT_ORIGIN (the web Worker's origin: where the admin's "show in the shop" links
#     lead), VITE_PLATFORM_LEGAL_NAME, VITE_PLATFORM_ORG_NUMBER, VITE_STRIPE_PUBLISHABLE_KEY (pk_… of
#     the env, as above) — any other VITE_ name WITH A VALUE is refused, never silently built into
#     public files; any name may be blanked (an empty value), which is how a root .env name is covered.
# Only VITE_ names are handed to a build (any other line is ignored), every VITE_ variable the
# shell holds is dropped first, and a value that looks like a secret key (sk_, sk-, rk_, whsec_)
# is refused: whatever the build reads ends up in public files. Vite ALSO reads .env, .env.local,
# .env.production and .env.production.local at the repository root (git-ignored, so outside the
# attested tree); a variable of the build's environment wins over them, so every VITE_ name one
# of those files defines must be defined in the build's values file too — an empty value blanks it
# — or the deploy is refused (for the admin too when its file is missing: then no name is defined).
#
# Recording attestations (reviewers, after the reviews pass):
#   git notes --ref=reviews add -m "codex: PASS" -m "fable: PASS" HEAD
#   git notes --ref=reviews append -m "mikael: GO" HEAD              # production only
#   git push origin refs/notes/reviews                               # share them
# Never add `set -x` to this file.

set -euo pipefail
set +x

refuse() { printf 'DEPLOY REFUSED: %s\n' "$*" >&2; exit 1; }
failed() { printf 'DEPLOY FAILED: %s\n' "$*" >&2; exit 1; }

USAGE='usage: scripts/cf-deploy.sh <staging|production> [api|web|admin|all]'
[ $# -ge 1 ] && [ $# -le 2 ] || refuse "$USAGE"
ENV_NAME=$1
TARGET=${2:-all}
case $ENV_NAME in
  staging | production) ;;
  *) refuse "unknown environment '$ENV_NAME' — $USAGE" ;;
esac
case $TARGET in
  api | web | admin | all) ;;
  *) refuse "unknown target '$TARGET' — $USAGE" ;;
esac

# Nothing here needs a Cloudflare credential (the preflight injects its own token), and the
# storefront build must not see one.
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL CLOUDFLARE_ACCOUNT_ID \
  CLOUDFLARE_API_BASE_URL CF_API_BASE_URL CF_API_TOKEN CF_API_KEY CF_EMAIL CF_ACCOUNT_ID

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$ROOT"
WEB_VALUES=$HOME/.config/chopshop/web.$ENV_NAME.env
ADMIN_VALUES=$HOME/.config/chopshop/admin.$ENV_NAME.env

dirty=$(git status --porcelain --untracked-files=all)
[ -z "$dirty" ] || refuse "working tree is not clean ($(printf '%s\n' "$dirty" | wc -l | tr -d ' ') path(s), see git status) — commit or remove them; only a committed SHA is deployed"

SHA=$(git rev-parse HEAD)
git fetch -q origin 2>/dev/null || refuse "git fetch origin failed — cannot confirm HEAD is pushed"
[ -n "$(git branch -r --contains HEAD 2>/dev/null)" ] ||
  refuse "HEAD $SHA is not on any remote branch — push it first"

# Attestations may have been recorded on another checkout: an ordinary fetch does not bring
# refs/notes/reviews, so fetch it into a SEPARATE ref (never overwriting local notes) and accept
# a line found in either.
# The cached copy is dropped FIRST so a failed fetch can never leave stale remote attestations
# behind to be trusted (Codex P2 on 9b02e24): after a failure only local notes count.
git update-ref -d refs/notes/reviews-origin 2>/dev/null || true
if git fetch -q origin "+refs/notes/reviews:refs/notes/reviews-origin" 2>/dev/null; then
  notes=$( { git notes --ref=reviews show HEAD 2>/dev/null; git notes --ref=reviews-origin show HEAD 2>/dev/null; } || true)
else
  notes=$(git notes --ref=reviews show HEAD 2>/dev/null || true)
fi
has_line() { printf '%s\n' "$notes" | grep -qE "^[[:space:]]*$1[[:space:]]*\$"; }
missing=
has_line 'codex: PASS' || missing="$missing 'codex: PASS'"
has_line 'fable: PASS' || missing="$missing 'fable: PASS'"
[ -z "$missing" ] ||
  refuse "HEAD $SHA has no review attestation line(s)$missing in refs/notes/reviews — once BOTH reviews of this exact SHA pass, record them with: git notes --ref=reviews add -m \"codex: PASS\" -m \"fable: PASS\" HEAD"
if [ "$ENV_NAME" = production ]; then
  has_line 'mikael: GO' ||
    refuse "production needs Mikael's go for HEAD $SHA — when he gives it, record: git notes --ref=reviews append -m \"mikael: GO\" HEAD"
fi

# --- 4. build values ------------------------------------------------------------------------
file_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

# each_entry <file> <function>: calls <function> KEY VALUE for every KEY=VALUE line of the file,
# read as the preflight's env_value reads its files (optional `export`, optional quotes). The
# file is parsed, never sourced, and no value is ever printed.
each_entry() {
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    line=${line#"${line%%[![:space:]]*}"}
    case $line in '' | '#'*) continue ;; esac
    key=${line%%=*}
    [ "$key" != "$line" ] || continue
    val=${line#*=}
    key=${key#export }
    key=${key%"${key##*[![:space:]]}"}
    val=${val#"${val%%[![:space:]]*}"}
    val=${val%"${val##*[![:space:]]}"}
    case $val in
      \"*\") val=${val#\"} && val=${val%\"} ;;
      \'*\') val=${val#\'} && val=${val%\'} ;;
    esac
    "$2" "$key" "$val"
  done <"$1"
}

if [ "$ENV_NAME" = production ]; then PK=pk_live_; else PK=pk_test_; fi
VALUE_NAMES=' '
VALUES=
WHAT=
ALLOWED= # empty: any VITE_ name; else the names (space-separated, spaces around) the file may define
check_entry() { # check_entry KEY VALUE — refuses; records the VITE_ names in VALUE_NAMES
  case $1 in VITE_*) ;; *) return 0 ;; esac
  case $1 in *[!A-Za-z0-9_]*) refuse "$VALUES: '$1' is not a variable name" ;; esac
  # An EMPTY value of any name is a blank, not a value: it is how a name the repository's own
  # .env files define is kept out of the build, so the allowlist asks only about names with a value.
  if [ -n "$ALLOWED" ] && [ -n "$2" ]; then
    case $ALLOWED in
      *" $1 "*) ;;
      *) refuse "$VALUES: $1 is not one of the $WHAT's build values (only${ALLOWED% }) — an unknown public value is not built into the $WHAT" ;;
    esac
  fi
  local prefix=
  case $2 in
    sk_* | sk-* | rk_*) prefix=${2:0:3} ;;
    whsec_*) prefix=whsec_ ;;
  esac
  [ -z "$prefix" ] ||
    refuse "$VALUES: $1 starts with '$prefix', a secret key — the $WHAT's build is public; only public values belong there"
  if [ "$1" = VITE_STRIPE_PUBLISHABLE_KEY ]; then
    case $2 in
      "$PK"?*) ;;
      *) refuse "$VALUES: VITE_STRIPE_PUBLISHABLE_KEY starts with '${2:0:8}', $ENV_NAME requires a ${PK}… key" ;;
    esac
  fi
  VALUE_NAMES="$VALUE_NAMES$1 "
}
export_entry() { # export_entry KEY VALUE — in the build's subshell only
  case $1 in VITE_*) export "$1=$2" ;; esac
}

# check_build_values <file> <what> <required: 1|0> <allowed names or empty> — refuses before anything is deployed
check_build_values() {
  VALUES=$1 WHAT=$2 ALLOWED=$4 VALUE_NAMES=' '
  if [ -f "$VALUES" ]; then
    local mode
    mode=$(file_mode "$VALUES") || refuse "cannot stat $VALUES"
    [ "$mode" = 600 ] || refuse "$VALUES has mode $mode — it must be 600 (chmod 600 it)"
    each_entry "$VALUES" check_entry
  elif [ "$3" = 1 ]; then
    refuse "no $VALUES — the $WHAT's build values (VITE_STRIPE_PUBLISHABLE_KEY, VITE_PLATFORM_LEGAL_NAME, VITE_PLATFORM_ORG_NUMBER; mode 600) are read from it, never from the shell"
  fi
  if [ "$3" = 1 ]; then
    case $VALUE_NAMES in
      *" VITE_STRIPE_PUBLISHABLE_KEY "*) ;;
      *) refuse "$VALUES defines no VITE_STRIPE_PUBLISHABLE_KEY — the $WHAT cannot take a payment without it (${PK}…)" ;;
    esac
  fi
  # The files Vite reads for a production build (vite loadEnv: .env, .env.local, .env.[mode],
  # .env.[mode].local). Only their VITE_ names are read here, never a value.
  local f name unset_names
  for f in .env .env.local .env.production .env.production.local; do
    [ -f "$ROOT/$f" ] || continue
    unset_names=
    for name in $(sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?(VITE_[A-Za-z0-9_.-]*)[[:space:]]*[=:].*$/\2/p' "$ROOT/$f"); do
      case $VALUE_NAMES in *" $name "*) ;; *) unset_names="$unset_names $name" ;; esac
    done
    [ -z "$unset_names" ] ||
      refuse "$ROOT/$f defines$unset_names, which $VALUES does not — Vite would build that file's value into the $WHAT; give each a line in $VALUES (an empty value blanks it) or remove it from $f"
  done
}
if [ "$TARGET" = web ] || [ "$TARGET" = all ]; then
  check_build_values "$WEB_VALUES" storefront 1 ""
fi
if [ "$TARGET" = admin ] || [ "$TARGET" = all ]; then
  check_build_values "$ADMIN_VALUES" admin 0 " VITE_PLATFORM_LEGAL_NAME VITE_PLATFORM_ORG_NUMBER VITE_STRIPE_PUBLISHABLE_KEY VITE_STOREFRONT_ORIGIN "
fi

printf 'deploy: %s %s — HEAD %s reviewed (codex: PASS, fable: PASS%s)\n' "$ENV_NAME" "$TARGET" "$SHA" \
  "$([ "$ENV_NAME" = production ] && printf ', mikael: GO')" >&2

# --- a. the API Worker ----------------------------------------------------------------------
DONE="nothing was deployed by this run"
if [ "$TARGET" = api ] || [ "$TARGET" = all ]; then
  rc=0
  "$ROOT/scripts/cf-preflight.sh" "$ENV_NAME" -- deploy || rc=$?
  [ "$rc" = 0 ] ||
    failed "the API deploy exited $rc — nothing further ran (no storefront build, no web deploy, no admin build, no admin deploy)"
  DONE="the API Worker IS deployed (HEAD $SHA)"
  printf 'deploy: %s — API Worker deployed\n' "$ENV_NAME" >&2
fi
[ "$TARGET" != api ] || exit 0

# build_with <values file> <checker script> — a subshell: the build sees the file's VITE_ values
# (if the file exists) and no other VITE_ variable
build_with() (
  for name in $(compgen -e); do
    case $name in VITE_*) unset "$name" ;; esac
  done
  VALUES=$1
  if [ -f "$VALUES" ]; then each_entry "$VALUES" export_entry; fi
  # A production build whatever the shell holds: with NODE_ENV=development Vite ships the
  # development build of the libraries and the page's development-only notes.
  export NODE_ENV=production
  exec node "$2"
)
# after_build <what> <not deployed> — the tree must still be the committed one
after_build() {
  dirty=$(git status --porcelain --untracked-files=all)
  [ -z "$dirty" ] ||
    refuse "the $1 build changed the working tree ($(printf '%s\n' "$dirty" | wc -l | tr -d ' ') path(s), see git status) — the build must be the committed tree's; $DONE; $2"
  [ "$(git rev-parse HEAD)" = "$SHA" ] ||
    refuse "HEAD moved from $SHA during the deploy — the build is no longer the attested tree; $DONE; $2"
}
NO_ADMIN=
[ "$TARGET" != all ] || NO_ADMIN="; the admin Worker was NOT deployed"

if [ "$TARGET" = web ] || [ "$TARGET" = all ]; then
  # --- b. the storefront build, from the committed tree -------------------------------------
  rc=0
  build_with "$WEB_VALUES" "$ROOT/cloudflare/web/check-storefront-build.mjs" || rc=$?
  [ "$rc" = 0 ] || failed "the storefront build or its check exited $rc — $DONE; the web Worker was NOT deployed$NO_ADMIN"
  after_build storefront "the web Worker was NOT deployed$NO_ADMIN"

  # --- c. the web Worker ---------------------------------------------------------------------
  rc=0
  "$ROOT/scripts/cf-preflight.sh" "$ENV_NAME" --web -- deploy || rc=$?
  [ "$rc" = 0 ] || failed "the web deploy exited $rc — $DONE; the web Worker was NOT deployed$NO_ADMIN"
  printf 'deploy: %s — web Worker deployed\n' "$ENV_NAME" >&2
  if [ "$TARGET" = all ]; then DONE="the API Worker and the web Worker ARE deployed (HEAD $SHA)"; fi
fi

if [ "$TARGET" = admin ] || [ "$TARGET" = all ]; then
  # --- d. the admin build, from the committed tree ------------------------------------------
  rc=0
  build_with "$ADMIN_VALUES" "$ROOT/cloudflare/admin/check-admin-build.mjs" || rc=$?
  [ "$rc" = 0 ] || failed "the admin build or its check exited $rc — $DONE; the admin Worker was NOT deployed"
  after_build admin "the admin Worker was NOT deployed"

  # --- e. the admin Worker -------------------------------------------------------------------
  rc=0
  "$ROOT/scripts/cf-preflight.sh" "$ENV_NAME" --admin -- deploy || rc=$?
  [ "$rc" = 0 ] || failed "the admin deploy exited $rc — $DONE; the admin Worker was NOT deployed"
  printf 'deploy: %s — admin Worker deployed\n' "$ENV_NAME" >&2
fi
