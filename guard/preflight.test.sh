#!/usr/bin/env bash
# guard/preflight.test.sh — proves scripts/cf-preflight.sh refuses what it must.
#
# No network, no real credentials. Every case runs a COPY of the script inside a throwaway
# tree: fake credentials file (via CHOPSHOP_CF_ENV_FILE), the repo's real pinned files (edited
# per case), a JSONC wrangler.jsonc, a fake wrangler at cloudflare/node_modules/.bin/wrangler
# (the preflight resolves wrangler by path, never via $PATH, so that is where the fake lives),
# a fake `curl` first on PATH, and HOME inside the tree (so ~/.config/chopshop/stripe.*.env is
# the test's). The shell deliberately exports WRONG Cloudflare credentials, which the preflight
# must drop: the fake wrangler rejects the inherited token and fails if the key/email leak.
#
# Run: bash guard/preflight.test.sh

set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/cf-preflight-test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
ALL_OUT=$WORK/all-output.txt
: >"$ALL_OUT"

GOOD=ee213082783ec86585150e876edb6107
OTHER=0d392e5c79e386966a98a214ac91a133
TOKEN="cfut_FAKE-preflight-token-$$-9f2c7e1b"
SKEY_TEST="sk_test_FAKEpreflight$$key"
SKEY_LIVE="sk_live_FAKEpreflight$$key"
RKEY_TEST="rk_test_FAKEpreflight$$key"
STRIPE_STG=acct_1Tp7gtKAaBMOW5AC
ONE_ACCOUNT="[{\"id\": \"$GOOD\", \"name\": \"Kent@meteorpr.se's Account\"}]"
env_section() { # env_section <env> <stg|prod> — an env.<env> block bound to that env's pinned names
  printf '{"%s": {"vars": {"APP_ENV": "%s"},
  "d1_databases": [{"binding": "DB", "database_name": "chopshop-%s", "database_id": "d1-%s-uuid"}],
  "r2_buckets": [{"binding": "PUBLIC", "bucket_name": "chopshop-%s-public"}, {"binding": "PRODUCTION", "bucket_name": "chopshop-%s-production"}],
  "queues": {"producers": [{"binding": "OUTBOX", "queue": "chopshop-%s-outbox"}],
             "consumers": [{"queue": "chopshop-%s-outbox"}, {"queue": "chopshop-%s-render-jobs"}]}}}' \
    "$1" "$1" "$2" "$2" "$2" "$2" "$2" "$2" "$2"
}
ENV_STAGING=$(env_section staging stg)
ENV_PRODUCTION=$(env_section production prod)
PIN_STG="p['d1']['id'] = 'd1-stg-uuid'; p['stripeWebhookEndpointId'] = 'we_stg'"
PIN_PROD="p['d1']['id'] = 'd1-prod-uuid'; p['stripeAccountId'] = 'acct_PRODTEST'; p['stripeWebhookEndpointId'] = 'we_prod'"

# Inherited credentials the preflight must ignore.
export CLOUDFLARE_API_TOKEN=INHERITED-WRONG-TOKEN CLOUDFLARE_API_KEY=inherited-global-key \
  CLOUDFLARE_EMAIL=inherited@example.com CLOUDFLARE_ACCOUNT_ID=$OTHER CF_API_TOKEN=INHERITED-WRONG-TOKEN

write_jsonc() { # write_jsonc <tree> <account_id> [env-section-json] — real JSONC: comments, // in strings, trailing commas
  local envline=
  if [ -n "${3:-}" ]; then envline="\"env\": $3,"; fi
  cat >"$1/cloudflare/wrangler.jsonc" <<EOF
{
  // test config — "quotes" and // inside comments and strings must not confuse the parser
  "name": "chopshop-api",
  "account_id": "$2", /* pinned? */
  "vars": { "AUTH_BASE_URL": "https://example.test/a//b", "APP_ENV": "top-level", },
  $envline
}
EOF
}

pin() { # pin <tree> <env> <python statements on p> — edit a copied pinned file
  python3 -c 'import json, sys
f = sys.argv[1]; p = json.load(open(f)); exec(sys.argv[2]); json.dump(p, open(f, "w"), indent=2)' \
    "$1/cloudflare/pinned.$2.json" "$3"
}

make_tree() { # make_tree <tree> — defaults: staging bootstrap-able, token + account correct
  local d=$1
  mkdir -p "$d/scripts" "$d/cloudflare/node_modules/.bin" "$d/home/.config/chopshop" "$d/bin"
  cp "$REPO/scripts/cf-preflight.sh" "$d/scripts/"
  cp "$REPO/cloudflare/pinned.staging.json" "$REPO/cloudflare/pinned.production.json" "$d/cloudflare/"
  write_jsonc "$d" "$GOOD"
  printf 'CF_ACCOUNT_ID=%s\nCF_ACCOUNT_NAME="Test"\nCLOUDFLARE_API_TOKEN=%s\n' "$GOOD" "$TOKEN" >"$d/cf.env"
  chmod 600 "$d/cf.env"
  printf '%s' "$TOKEN" >"$d/token"
  cat >"$d/cloudflare/node_modules/.bin/wrangler" <<'EOF'
#!/usr/bin/env bash
expected=$(cat "$FAKE_TOKEN_FILE")
if [ -n "${CLOUDFLARE_API_KEY:-}${CLOUDFLARE_EMAIL:-}${CF_API_TOKEN:-}" ]; then
  echo "FAKE-WRANGLER: inherited credentials leaked through" >&2; exit 90
fi
case " $* " in *"$expected"*) echo "FAKE-WRANGLER: token on the command line" >&2; exit 91 ;; esac
if [ "${1:-}" = whoami ] && [ "${2:-}" = --json ]; then
  if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then echo "FAKE-WRANGLER: account id forced during whoami" >&2; exit 92; fi
  if [ "${CLOUDFLARE_API_TOKEN:-}" != "$expected" ]; then echo '{"loggedIn": false}'; exit 1; fi
  printf '{"loggedIn": true, "authType": "User API Token", "accounts": %s}\n' "$FAKE_ACCOUNTS"
  exit 0
fi
tok=wrong; [ "${CLOUDFLARE_API_TOKEN:-}" = "$expected" ] && tok=ok
echo "FAKE-WRANGLER EXEC: $* | account=${CLOUDFLARE_ACCOUNT_ID:-unset} token=$tok cwd=$(basename "$PWD")"
EOF
  cat >"$d/bin/curl" <<'EOF'
#!/usr/bin/env bash
cfg=$(cat)
for a in "$@"; do case $a in *[sr]k_test_* | *[sr]k_live_*) echo "FAKE-CURL: key on the command line" >&2; exit 95 ;; esac; done
case $cfg in *"$FAKE_STRIPE_KEY"*) ;; *) echo "FAKE-CURL: key not received on stdin" >&2; exit 96 ;; esac
out= prev= url=
for a in "$@"; do [ "$prev" = -o ] && out=$a; prev=$a; url=$a; done
case $url in
  https://api.stripe.com/v1/account)
    printf '{"id": "%s", "object": "account"}' "$FAKE_STRIPE_ACCOUNT" >"$out"; printf 200 ;;
  https://api.stripe.com/v1/webhook_endpoints/*)
    if [ "${url##*/}" = "${FAKE_STRIPE_WEBHOOK:-}" ]; then
      printf '{"id": "%s", "object": "webhook_endpoint", "status": "enabled", "url": "https://api.example.test/stripe"}' "${url##*/}" >"$out"; printf 200
    else
      printf '{"error": {"type": "invalid_request_error", "code": "resource_missing"}}' >"$out"; printf 404
    fi ;;
  *) echo "FAKE-CURL: unexpected URL $url" >&2; exit 97 ;;
esac
EOF
  chmod 755 "$d/cloudflare/node_modules/.bin/wrangler" "$d/bin/curl"
  mkdir -p "$d/docs/SnapWearDocs"
  cp "$REPO/docs/SnapWearDocs/LAUNCH_TODO.md" "$d/docs/SnapWearDocs/"
}

launch_todo_all_done() { # launch_todo_all_done <tree> — every gated item ☑; A8, A12, B11 (not gated) left ☐
  local i s
  {
    printf '| # | Item | Owner | Status | Notes |\n|---|---|---|---|---|\n'
    for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14; do
      s='☑'; case $i in 8 | 12) s='☐' ;; esac
      printf '| A%s | item | C | %s | note |\n' "$i" "$s"
    done
    printf '\n| # | Item | Owner | Status |\n|---|---|---|---|\n'
    for i in 1 2 3 4 5 6 7 8 9 10 11; do
      s='☑'; [ "$i" = 11 ] && s='☐'
      printf '| B%s | item | K | %s |\n' "$i" "$s"
    done
  } >"$1/docs/SnapWearDocs/LAUNCH_TODO.md"
}

stripe_file() { # stripe_file <tree> <env> <key> [mode]
  printf 'STRIPE_SECRET_KEY=%s\n' "$3" >"$1/home/.config/chopshop/stripe.$2.env"
  chmod "${4:-600}" "$1/home/.config/chopshop/stripe.$2.env"
}

N=0
new_tree() { N=$((N + 1)); T=$WORK/case$N; make_tree "$T"; }

run() { # run <preflight args…> — in tree $T; sets RC and OUT
  OUT=$T/out.txt
  set +e
  HOME="$T/home" PATH="$T/bin:$PATH" CHOPSHOP_CF_ENV_FILE="$T/cf.env" FAKE_TOKEN_FILE="$T/token" \
    FAKE_ACCOUNTS="${FAKE_ACCOUNTS:-$ONE_ACCOUNT}" FAKE_STRIPE_KEY="${FAKE_STRIPE_KEY:-}" \
    FAKE_STRIPE_ACCOUNT="${FAKE_STRIPE_ACCOUNT:-}" FAKE_STRIPE_WEBHOOK="${FAKE_STRIPE_WEBHOOK:-}" \
    bash "$T/scripts/cf-preflight.sh" "$@" >"$OUT" 2>&1
  RC=$?
  set -e
  cat "$OUT" >>"$ALL_OUT"
}

PASSED=0 FAILED=0
ok() { PASSED=$((PASSED + 1)); printf 'ok    %s\n' "$1"; }
bad() { FAILED=$((FAILED + 1)); printf 'FAIL  %s (exit %s)\n' "$1" "$RC"; sed 's/^/      | /' "$OUT"; }
expect_refused() { # expect_refused <name> <substring of the refusal line>
  if [ "$RC" -ne 0 ] && [ "$(grep -c '^PREFLIGHT REFUSED: ' "$OUT")" = 1 ] &&
    grep '^PREFLIGHT REFUSED: ' "$OUT" | grep -qF -- "$2" && ! grep -q 'FAKE-WRANGLER EXEC' "$OUT"; then
    ok "$1"
  else bad "$1"; fi
}
expect_exec() { # expect_exec <name> <substring of the fake wrangler's exec line>
  if [ "$RC" -eq 0 ] && grep -qF -- "$2" "$OUT" && ! grep -q 'PREFLIGHT REFUSED' "$OUT"; then
    ok "$1"
  else bad "$1"; fi
}

# --- identity -----------------------------------------------------------------------------
new_tree; FAKE_ACCOUNTS="[{\"id\": \"$OTHER\", \"name\": \"Somebody else\"}]" run staging --bootstrap -- whoami
expect_refused "wrong account visible to the token → refused" "the token's account Somebody else ($OTHER) != CF_ACCOUNT_ID"

new_tree; FAKE_ACCOUNTS="[{\"id\": \"$GOOD\", \"name\": \"Kent\"}, {\"id\": \"$OTHER\", \"name\": \"Mikael\"}]" run staging --bootstrap -- whoami
expect_refused "two accounts visible → refused" "the token sees 2 accounts"

new_tree; FAKE_ACCOUNTS="[]" run staging --bootstrap -- whoami
expect_refused "no account visible → refused" "the token sees 0 accounts"

new_tree; printf '%s' "some-other-token" >"$T/token"; run staging --bootstrap -- whoami
expect_refused "token rejected by whoami → refused" "wrangler whoami failed (exit 1)"

new_tree; sed -i.bak "s/^CF_ACCOUNT_ID=.*/CF_ACCOUNT_ID=$OTHER/" "$T/cf.env"; run staging --bootstrap -- whoami
expect_refused "credentials file CF_ACCOUNT_ID != pinned → refused" "CF_ACCOUNT_ID $OTHER in"

new_tree; pin "$T" staging "p['cloudflareAccountId'] = '$OTHER'"; FAKE_ACCOUNTS="[{\"id\": \"$OTHER\", \"name\": \"x\"}]" run staging --bootstrap -- whoami
expect_refused "pinned id != credentials file → refused" "!= pinned cloudflareAccountId $OTHER"

new_tree; chmod 644 "$T/cf.env"; run staging --bootstrap -- whoami
expect_refused "credentials file mode 644 → refused" "has mode 644"

new_tree; grep -v '^CLOUDFLARE_API_TOKEN=' "$T/cf.env" >"$T/cf.tmp"; mv "$T/cf.tmp" "$T/cf.env"; chmod 600 "$T/cf.env"; run staging --bootstrap -- whoami
expect_refused "no token in the file → refused (inherited token never used)" "defines no CLOUDFLARE_API_TOKEN"

new_tree; write_jsonc "$T" "$OTHER"; run staging --bootstrap -- whoami
expect_refused "wrangler.jsonc account_id != pinned → refused" "account_id is '$OTHER'"

new_tree; write_jsonc "$T" "$GOOD" "{\"staging\": {\"account_id\": \"$OTHER\"}}"; run staging --bootstrap -- whoami
expect_refused "wrangler.jsonc env.staging.account_id != pinned → refused" "env.staging.account_id is '$OTHER'"

# --- arguments ----------------------------------------------------------------------------
new_tree; run staging --bootstrap -- deploy --env production
expect_refused "--env smuggled into wrangler args → refused" "'--env' is not allowed"
new_tree; run staging --bootstrap -- deploy -e production
expect_refused "-e smuggled into wrangler args → refused" "'-e' is not allowed"
new_tree; run staging --bootstrap -- deploy --config=other.jsonc
expect_refused "--config smuggled into wrangler args → refused" "'--config=other.jsonc' is not allowed"
new_tree; run staging --bootstrap deploy
expect_refused "wrangler args without '--' → refused" "unexpected argument 'deploy' before '--'"
new_tree; run staging --bootstrap
expect_refused "no '--' at all → refused" "missing '--'"
new_tree; run qa --bootstrap -- whoami
expect_refused "unknown environment → refused" "unknown environment 'qa'"

# --- pinned resources ---------------------------------------------------------------------
new_tree; run staging -- deploy
expect_refused "null pinned id without --bootstrap → refused" "still has null (not yet created) values: d1.id, stripeWebhookEndpointId"

new_tree; run production -- deploy
expect_refused "production with null ids without --bootstrap → refused" "d1.id, stripeAccountId, stripeWebhookEndpointId"

new_tree; pin "$T" production "p['dispatchTarget'] = 'fake-printer'"; run production --bootstrap -- whoami
expect_refused "production dispatchTarget != snapwear → refused (even under --bootstrap)" "only 'snapwear' may be deployed to production"

new_tree; pin "$T" staging "p['stripeMode'] = 'live'"; run staging --bootstrap -- whoami
expect_refused "staging pinned to live Stripe → refused" "staging requires 'sandbox'"

new_tree; pin "$T" staging "del p['queues']"; run staging --bootstrap -- whoami
expect_refused "pinned file missing a key → refused" "queues is missing"

new_tree; pin "$T" staging "$PIN_STG"; run staging -- deploy
expect_refused "fully pinned but no env.staging section → refused" "has no env.staging section"

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(printf '%s' "$ENV_STAGING" | sed 's/d1-stg-uuid/d1-PROD-uuid/')"; run staging -- deploy
expect_refused "env.staging D1 id != pinned → refused" "D1 binding DB -> chopshop-stg (d1-PROD-uuid) is not the pinned"

new_tree; pin "$T" staging "$PIN_STG"; write_jsonc "$T" "$GOOD" "$ENV_PRODUCTION"; run staging -- deploy
expect_refused "staging deploy with only an env.production section → refused" "has no env.staging section"

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(printf '%s' "$ENV_STAGING" | sed 's/chopshop-stg-outbox/chopshop-prod-outbox/g')"; run staging -- deploy
expect_refused "env.staging queue is a production queue → refused" "queue 'chopshop-prod-outbox' is not a pinned staging queue"

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(printf '%s' "$ENV_STAGING" | sed 's/chopshop-stg-production/chopshop-prod-production/')"; run staging -- deploy
expect_refused "env.staging R2 bucket is a production bucket → refused" "'chopshop-prod-production' is not a pinned staging bucket"

# --- production launch gate ---------------------------------------------------------------
new_tree; pin "$T" production "$PIN_PROD"; write_jsonc "$T" "$GOOD" "$ENV_PRODUCTION"; run production -- deploy
expect_refused "production with the real LAUNCH_TODO (open A/B items) → refused" "production launch gate:"

new_tree; pin "$T" production "$PIN_PROD"; write_jsonc "$T" "$GOOD" "$ENV_PRODUCTION"
launch_todo_all_done "$T"; sed -i.bak 's/^| B10 | item | K | ☑ |/| B10 | item | K | ☐ |/' "$T/docs/SnapWearDocs/LAUNCH_TODO.md"
run production -- deploy
expect_refused "production with exactly one gated item open (B10) → refused, naming it" "items not marked done: B10"

new_tree; run production --bootstrap -- whoami
expect_exec "production --bootstrap is not blocked by the launch gate" "FAKE-WRANGLER EXEC: --env production whoami | account=$GOOD token=ok"

# --- Stripe -------------------------------------------------------------------------------
new_tree; stripe_file "$T" staging "$SKEY_LIVE"; run staging --bootstrap -- whoami
expect_refused "live Stripe key for the sandbox env → refused" "requires sk_test_ or rk_test_"

new_tree; stripe_file "$T" staging "$SKEY_TEST" 644; run staging --bootstrap -- whoami
expect_refused "Stripe key file mode 644 → refused" "stripe.staging.env has mode 644"

new_tree; stripe_file "$T" staging "$SKEY_TEST"; FAKE_STRIPE_KEY=$SKEY_TEST FAKE_STRIPE_ACCOUNT=acct_SOMEBODYELSE run staging --bootstrap -- whoami
expect_refused "Stripe key of another account → refused" "belongs to acct_SOMEBODYELSE, pinned stripeAccountId is $STRIPE_STG"

new_tree; pin "$T" staging "$PIN_STG"; write_jsonc "$T" "$GOOD" "$ENV_STAGING"; run staging -- deploy
expect_refused "deploy without a Stripe key file → refused (only --bootstrap may skip Stripe)" "a deploy must prove the pinned Stripe account"

new_tree; pin "$T" staging "$PIN_STG"; write_jsonc "$T" "$GOOD" "$ENV_STAGING"; stripe_file "$T" staging "$SKEY_TEST"
FAKE_STRIPE_KEY=$SKEY_TEST FAKE_STRIPE_ACCOUNT=$STRIPE_STG FAKE_STRIPE_WEBHOOK=we_somethingelse run staging -- deploy
expect_refused "pinned webhook endpoint missing on the Stripe account → refused" "stripeWebhookEndpointId we_stg does not exist"

# --- the happy paths ----------------------------------------------------------------------
new_tree; run staging --bootstrap -- deploy --dry-run
expect_exec "correct account + --bootstrap → execs wrangler with the file's token and pinned account" \
  "FAKE-WRANGLER EXEC: --env staging deploy --dry-run | account=$GOOD token=ok cwd=cloudflare"

new_tree; stripe_file "$T" staging "$SKEY_TEST"; FAKE_STRIPE_KEY=$SKEY_TEST FAKE_STRIPE_ACCOUNT=$STRIPE_STG run staging --bootstrap -- whoami
expect_exec "matching Stripe sandbox account → execs" "FAKE-WRANGLER EXEC: --env staging whoami | account=$GOOD token=ok"

new_tree; pin "$T" staging "$PIN_STG"; write_jsonc "$T" "$GOOD" "$ENV_STAGING"; stripe_file "$T" staging "$SKEY_TEST"
FAKE_STRIPE_KEY=$SKEY_TEST FAKE_STRIPE_ACCOUNT=$STRIPE_STG FAKE_STRIPE_WEBHOOK=we_stg run staging -- deploy
expect_exec "staging fully pinned, bindings + Stripe + webhook match, no --bootstrap → execs" \
  "FAKE-WRANGLER EXEC: --env staging deploy | account=$GOOD token=ok"

new_tree; pin "$T" staging "$PIN_STG"; write_jsonc "$T" "$GOOD" "$ENV_STAGING"; stripe_file "$T" staging "$RKEY_TEST"
FAKE_STRIPE_KEY=$RKEY_TEST FAKE_STRIPE_ACCOUNT=$STRIPE_STG FAKE_STRIPE_WEBHOOK=we_stg run staging -- deploy
expect_exec "restricted rk_test_ key accepted for sandbox" "FAKE-WRANGLER EXEC: --env staging deploy | account=$GOOD token=ok"

new_tree; pin "$T" production "$PIN_PROD"; write_jsonc "$T" "$GOOD" "$ENV_PRODUCTION"; stripe_file "$T" production "$SKEY_LIVE"
launch_todo_all_done "$T"
FAKE_STRIPE_KEY=$SKEY_LIVE FAKE_STRIPE_ACCOUNT=acct_PRODTEST FAKE_STRIPE_WEBHOOK=we_prod run production -- deploy
expect_exec "production fully pinned, launch gate done (A8/A12/B11 open), live Stripe → execs" \
  "FAKE-WRANGLER EXEC: --env production deploy | account=$GOOD token=ok"

# --- secrets never surface ----------------------------------------------------------------
RC=0 OUT=$ALL_OUT
if grep -qF -e "$TOKEN" -e "$SKEY_TEST" -e "$SKEY_LIVE" -e "$RKEY_TEST" "$ALL_OUT"; then bad "no token or Stripe key in any stdout/stderr ($N runs)"; else ok "no token or Stripe key in any stdout/stderr ($N runs)"; fi
OUT=$WORK/xtrace.txt
grep -nE '^[^#]*set -(x|o xtrace)' "$REPO/scripts/cf-preflight.sh" >"$OUT" || true
if [ -s "$OUT" ]; then bad "cf-preflight.sh never enables xtrace"; else ok "cf-preflight.sh never enables xtrace"; fi

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
