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
env_section() { # env_section <env> <stg|prod> [python on e, p] — an env.<env> block bound to that
  # env's pinned names, worker name and origins (read from the repo's pinned.<env>.json), with
  # D1 id d1-<stg|prod>-uuid (what PIN_STG / PIN_PROD pin); the optional statements edit `e`.
  python3 -c 'import json, sys
env, short, edit, p = sys.argv[1], sys.argv[2], sys.argv[3], json.load(open(sys.argv[4]))
o = p["origins"]
e = {"name": p["workerName"],
     "vars": {"APP_ENV": env, "CANONICAL_ORIGINS": dict(o), "AUTH_BASE_URL": o["api"],
              "AUTH_TRUSTED_ORIGINS": o["api"] + "," + o["web"],
              "SERVICE_NAME": p["workerName"], "R2_PRIVATE_BUCKET_NAME": p["r2"]["private"],
              "R2_JURISDICTION": "eu", "DISPATCH_TARGET": p["dispatchTarget"]},
     "d1_databases": [{"binding": "DB", "database_name": p["d1"]["name"], "database_id": "d1-%s-uuid" % short}],
     "r2_buckets": [{"binding": "PUBLIC_BUCKET", "bucket_name": p["r2"]["public"], "jurisdiction": "eu"},
                    {"binding": "PRIVATE_BUCKET", "bucket_name": p["r2"]["private"], "jurisdiction": "eu"},
                    {"binding": "PRODUCTION_BUCKET", "bucket_name": p["r2"]["production"], "jurisdiction": "eu"}],
     "containers": [{"class_name": "RenderContainer", "image": "./render/Dockerfile", "instance_type": "standard-1",
                     "max_instances": 1, "constraints": {"jurisdiction": "eu"}}],
     "durable_objects": {"bindings": [{"name": "RENDER_CONTAINER", "class_name": "RenderContainer"}]},
     "queues": {"producers": [{"binding": "OUTBOX_QUEUE", "queue": p["queues"]["outbox"]},
                              {"binding": "EMAIL_QUEUE", "queue": p["queues"]["email"]},
                              {"binding": "RENDER_JOBS_QUEUE", "queue": p["queues"]["renderJobs"]}],
                "consumers": [{"queue": p["queues"]["outbox"]}, {"queue": p["queues"]["email"]}, {"queue": p["queues"]["renderJobs"]}]}}
exec(edit)
print(json.dumps({env: e}))' "$1" "$2" "${3:-}" "$REPO/cloudflare/pinned.$1.json"
}
ENV_STAGING=$(env_section staging stg)
ENV_PRODUCTION=$(env_section production prod)
PIN_STG="p['d1']['id'] = 'd1-stg-uuid'; p['stripeWebhookEndpointId'] = 'we_stg'"
PIN_PROD="p['d1']['id'] = 'd1-prod-uuid'; p['stripeAccountId'] = 'acct_PRODTEST'; p['stripeWebhookEndpointId'] = 'we_prod'"

# Inherited credentials the preflight must ignore.
export CLOUDFLARE_API_TOKEN=INHERITED-WRONG-TOKEN CLOUDFLARE_API_KEY=inherited-global-key \
  CLOUDFLARE_EMAIL=inherited@example.com CLOUDFLARE_ACCOUNT_ID=$OTHER CF_API_TOKEN=INHERITED-WRONG-TOKEN \
  CLOUDFLARE_API_BASE_URL=https://inherited.example.test CF_API_BASE_URL=https://inherited-alias.example.test

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
if [ -n "${CLOUDFLARE_API_KEY:-}${CLOUDFLARE_EMAIL:-}${CF_API_TOKEN:-}${CLOUDFLARE_API_BASE_URL:-}${CF_API_BASE_URL:-}" ]; then
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
new_tree; pin "$T" staging "p['d1']['id'] = None; p['stripeWebhookEndpointId'] = None"; run staging -- deploy
expect_refused "null pinned id without --bootstrap → refused" "still has null (not yet created) values: d1.id, stripeWebhookEndpointId"

new_tree; pin "$T" production "p['d1']['id'] = None"; run production -- deploy
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
expect_refused "env.staging queue is a production queue → refused" "queue producer OUTBOX_QUEUE -> 'chopshop-prod-outbox' is not its pinned queue 'chopshop-stg-outbox'"

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(printf '%s' "$ENV_STAGING" | sed 's/chopshop-stg-production/chopshop-prod-production/')"; run staging -- deploy
expect_refused "env.staging R2 bucket is a production bucket → refused" "R2 binding PRODUCTION_BUCKET -> 'chopshop-prod-production' is not its pinned bucket 'chopshop-stg-production'"

# --- worker name, canonical origins, R2 jurisdiction (CP1) --------------------------------
new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "e['name'] = 'chopshop-api'")"; run staging -- deploy
expect_refused "env.staging.name is the production worker's name → refused" "env.staging.name is 'chopshop-api', pinned workerName is 'chopshop-api-stg'"

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "del e['name']")"; run staging -- deploy
expect_refused "env.staging without a name → wrangler's effective '<top>-staging' → refused" "env.staging.name is 'chopshop-api-staging' (wrangler's effective name: top-level name + '-staging'), pinned workerName is 'chopshop-api-stg'"

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "e['vars']['CANONICAL_ORIGINS']['web'] = 'https://chopshop-web.kent-ee2.workers.dev'")"; run staging -- deploy
expect_refused "CANONICAL_ORIGINS.web != pinned origins.web → refused" "env.staging.vars.CANONICAL_ORIGINS is {\"api\": \"https://chopshop-api-stg.kent-ee2.workers.dev\", \"web\": \"https://chopshop-web.kent-ee2.workers.dev\"}"

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "e['vars']['CANONICAL_ORIGINS']['admin'] = p['origins']['web']")"; run staging -- deploy
expect_refused "CANONICAL_ORIGINS with an extra key → refused (deep equality)" "\"admin\": \"https://chopshop-web-stg.kent-ee2.workers.dev\""

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "del e['vars']['CANONICAL_ORIGINS']")"; run staging -- deploy
expect_refused "CANONICAL_ORIGINS missing → refused" "env.staging.vars.CANONICAL_ORIGINS is null, pinned origins are"

new_tree; pin "$T" staging "p['origins']['web'] = 'http://chopshop-web-stg.kent-ee2.workers.dev'"; run staging --bootstrap -- whoami
expect_refused "pinned origin over http:// → refused (even under --bootstrap)" "origins.web 'http://chopshop-web-stg.kent-ee2.workers.dev' is not a bare https:// origin"

new_tree; pin "$T" staging "p['origins']['api'] = 'https://chopshop-api-stg.kent-ee2.workers.dev/'"; run staging --bootstrap -- whoami
expect_refused "pinned origin with a path → refused" "origins.api 'https://chopshop-api-stg.kent-ee2.workers.dev/' is not a bare https:// origin"

new_tree; pin "$T" staging "p['origins']['web'] = 'https://chopshop-web-stg.kent-ee2.workers.dev?next=x#top'"; run staging --bootstrap -- whoami
expect_refused "pinned origin with a query + fragment → refused" "origins.web 'https://chopshop-web-stg.kent-ee2.workers.dev?next=x#top' is not a bare https:// origin"

new_tree; pin "$T" staging "del p['origins']['web']"; run staging --bootstrap -- whoami
expect_refused "pinned origins without web → refused" "origins.web is missing"

new_tree; pin "$T" staging "p['origins']['admin'] = 'https://admin.example.test'"; run staging --bootstrap -- whoami
expect_refused "unknown pinned origins key → refused (extend the preflight first)" "unknown key(s) origins.admin - extend the preflight first"

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "e['vars']['AUTH_BASE_URL'] = p['origins']['web']")"; run staging -- deploy
expect_refused "AUTH_BASE_URL drifted from origins.api → refused" "env.staging.vars.AUTH_BASE_URL is 'https://chopshop-web-stg.kent-ee2.workers.dev', pinned origins.api is 'https://chopshop-api-stg.kent-ee2.workers.dev'"

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "e['vars']['AUTH_TRUSTED_ORIGINS'] = p['origins']['api']")"; run staging -- deploy
expect_refused "AUTH_TRUSTED_ORIGINS without the web origin → refused" "env.staging.vars.AUTH_TRUSTED_ORIGINS is 'https://chopshop-api-stg.kent-ee2.workers.dev', it must be exactly the pinned origins"

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "e['vars']['AUTH_TRUSTED_ORIGINS'] += ',https://elsewhere.example.test'")"; run staging -- deploy
expect_refused "AUTH_TRUSTED_ORIGINS with an extra origin → refused" "https://elsewhere.example.test', it must be exactly the pinned origins"

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "del e['r2_buckets'][1]['jurisdiction']")"; run staging -- deploy
expect_refused "R2 binding without a jurisdiction → refused" "R2 binding PRIVATE_BUCKET -> 'chopshop-stg-private' has jurisdiction None, every bucket is in 'eu'"

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "e['r2_buckets'][0]['jurisdiction'] = 'fedramp'")"; run staging -- deploy
expect_refused "R2 binding in another jurisdiction → refused" "R2 binding PUBLIC_BUCKET -> 'chopshop-stg-public' has jurisdiction 'fedramp'"

# --- complete binding mapping (Codex P1 on 65f610c) --------------------------------------
new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "e['r2_buckets'][1]['bucket_name'] = p['r2']['public']")"; run staging -- deploy
expect_refused "PRIVATE_BUCKET bound to the public bucket → refused" "R2 binding PRIVATE_BUCKET -> 'chopshop-stg-public' is not its pinned bucket 'chopshop-stg-private'"

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "del e['d1_databases']")"; run staging -- deploy
expect_refused "no D1 binding at all → refused" "d1_databases bindings are [], expected exactly ['DB']"

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "e['queues']['producers'] = [q for q in e['queues']['producers'] if q['binding'] != 'EMAIL_QUEUE']")"; run staging -- deploy
expect_refused "EMAIL_QUEUE producer missing → refused" "queue producer bindings are ['OUTBOX_QUEUE', 'RENDER_JOBS_QUEUE'], expected exactly ['EMAIL_QUEUE', 'OUTBOX_QUEUE', 'RENDER_JOBS_QUEUE']"

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "e['queues']['consumers'].pop()")"; run staging -- deploy
expect_refused "a queue consumer missing → refused" "queue consumers are ['chopshop-stg-email', 'chopshop-stg-outbox'], expected exactly the pinned"

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "e['r2_buckets'].append(dict(e['r2_buckets'][0]))")"; run staging -- deploy
expect_refused "a binding declared twice → refused" "declares binding 'PUBLIC_BUCKET' twice"

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "e['vars']['DISPATCH_TARGET'] = 'snapwear'")"; run staging -- deploy
expect_refused "DISPATCH_TARGET != pinned dispatchTarget → refused" "env.staging.vars.DISPATCH_TARGET is 'snapwear', pinned dispatchTarget is 'fake-printer'"

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "e['containers'][0]['max_instances'] = 3")"; run staging -- deploy
expect_refused "container max_instances != 1 → refused" "container RenderContainer must be image ./render/Dockerfile, max_instances 1"

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "del e['durable_objects']")"; run staging -- deploy
expect_refused "RENDER_CONTAINER binding missing → refused" "durable_objects bindings are {}, expected exactly {'RENDER_CONTAINER': 'RenderContainer'}"

# --- bootstrap can never deploy; the worker name cannot be overridden ---------------------
new_tree; run staging --bootstrap -- deploy
expect_refused "--bootstrap with deploy → refused" "wrangler subcommand 'deploy' is not allowed under --bootstrap"

new_tree; run staging --bootstrap -- versions upload
expect_refused "--bootstrap with versions upload → refused" "wrangler subcommand 'versions' is not allowed under --bootstrap"

new_tree; run staging -- deploy --name other-worker
expect_refused "--name override → refused" "wrangler argument '--name' is not allowed"

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "e['vars']['SERVICE_NAME'] = 'chopshop-api'")"; run staging -- deploy
expect_refused "SERVICE_NAME != pinned workerName → refused" "env.staging.vars.SERVICE_NAME is 'chopshop-api', pinned workerName is 'chopshop-api-stg'"

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "e['vars']['R2_PRIVATE_BUCKET_NAME'] = 'chopshop-prod-private'")"; run staging -- deploy
expect_refused "R2_PRIVATE_BUCKET_NAME != pinned r2.private → refused" "env.staging.vars.R2_PRIVATE_BUCKET_NAME is 'chopshop-prod-private', pinned r2.private is 'chopshop-stg-private'"

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "del e['vars']['R2_JURISDICTION']")"; run staging -- deploy
expect_refused "R2_JURISDICTION var missing while bindings are eu → refused" "env.staging.vars.R2_JURISDICTION is None, every R2 binding is in 'eu'"

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
new_tree; run staging --bootstrap -- d1 list
expect_exec "correct account + --bootstrap → execs wrangler with the file's token and pinned account" \
  "FAKE-WRANGLER EXEC: --env staging d1 list | account=$GOOD token=ok cwd=cloudflare"

new_tree; pin "$T" staging "p['stripeWebhookEndpointId'] = None"; stripe_file "$T" staging "$SKEY_TEST"; FAKE_STRIPE_KEY=$SKEY_TEST FAKE_STRIPE_ACCOUNT=$STRIPE_STG run staging --bootstrap -- whoami
expect_exec "matching Stripe sandbox account → execs (webhook not yet pinned, bootstrap)" "FAKE-WRANGLER EXEC: --env staging whoami | account=$GOOD token=ok"

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

new_tree; pin "$T" production "$PIN_PROD"; write_jsonc "$T" "$GOOD" "$(env_section production prod "del e['name']")"
stripe_file "$T" production "$SKEY_LIVE"; launch_todo_all_done "$T"
FAKE_STRIPE_KEY=$SKEY_LIVE FAKE_STRIPE_ACCOUNT=acct_PRODTEST FAKE_STRIPE_WEBHOOK=we_prod run production -- deploy
expect_refused "env.production without a name → wrangler's effective '<top>-production' → refused" "env.production.name is 'chopshop-api-production' (wrangler's effective name: top-level name + '-production'), pinned workerName is 'chopshop-api'"

# --- the repo's REAL wrangler.jsonc agrees with the repo's real pinned files ----------------
# Only the Stripe ids that do not exist yet are filled in; every Cloudflare id, name, origin
# and jurisdiction is the committed one, so drift between the two files fails here.
new_tree; cp "$REPO/cloudflare/wrangler.jsonc" "$T/cloudflare/"; pin "$T" staging "p['stripeWebhookEndpointId'] = 'we_stg'"
stripe_file "$T" staging "$SKEY_TEST"
FAKE_STRIPE_KEY=$SKEY_TEST FAKE_STRIPE_ACCOUNT=$STRIPE_STG FAKE_STRIPE_WEBHOOK=we_stg run staging -- deploy
expect_exec "repo wrangler.jsonc passes every staging check against repo pinned.staging.json" \
  "FAKE-WRANGLER EXEC: --env staging deploy | account=$GOOD token=ok"

new_tree; cp "$REPO/cloudflare/wrangler.jsonc" "$T/cloudflare/"
pin "$T" production "p['stripeAccountId'] = 'acct_PRODTEST'; p['stripeWebhookEndpointId'] = 'we_prod'"
stripe_file "$T" production "$SKEY_LIVE"; launch_todo_all_done "$T"
FAKE_STRIPE_KEY=$SKEY_LIVE FAKE_STRIPE_ACCOUNT=acct_PRODTEST FAKE_STRIPE_WEBHOOK=we_prod run production -- deploy
expect_exec "repo wrangler.jsonc passes every production check against repo pinned.production.json" \
  "FAKE-WRANGLER EXEC: --env production deploy | account=$GOOD token=ok"

# --- secrets never surface ----------------------------------------------------------------
RC=0 OUT=$ALL_OUT
if grep -qF -e "$TOKEN" -e "$SKEY_TEST" -e "$SKEY_LIVE" -e "$RKEY_TEST" "$ALL_OUT"; then bad "no token or Stripe key in any stdout/stderr ($N runs)"; else ok "no token or Stripe key in any stdout/stderr ($N runs)"; fi
OUT=$WORK/xtrace.txt
grep -nE '^[^#]*set -(x|o xtrace)' "$REPO/scripts/cf-preflight.sh" >"$OUT" || true
if [ -s "$OUT" ]; then bad "cf-preflight.sh never enables xtrace"; else ok "cf-preflight.sh never enables xtrace"; fi

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
