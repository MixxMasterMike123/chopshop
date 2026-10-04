#!/usr/bin/env bash
# guard/preflight.test.sh — proves scripts/cf-preflight.sh refuses what it must.
#
# No network, no real credentials. Every case runs a COPY of the script inside a throwaway
# tree: fake credentials file (via CHOPSHOP_CF_ENV_FILE), the repo's real pinned files (edited
# per case), a JSONC wrangler.jsonc, a JSONC cloudflare/web/wrangler.jsonc and a built
# cloudflare/web/dist (for --web), the same pair under cloudflare/admin/ (for --admin), a fake wrangler at cloudflare/node_modules/.bin/wrangler
# (the preflight resolves wrangler by path, never via $PATH, so that is where the fake lives),
# a fake `curl` first on PATH, and HOME inside the tree (so ~/.config/chopshop/stripe.*.env is
# the test's). The shell deliberately exports WRONG Cloudflare credentials, which the preflight
# must drop: the fake wrangler rejects the inherited token and fails if the key/email leak.
#
# Run: bash guard/preflight.test.sh

set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
# Physical path: the preflight resolves its tree with `pwd -P`, and the fake wrangler reports the
# --config it was given relative to the tree (macOS's $TMPDIR is behind a symlink).
WORK=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/cf-preflight-test.XXXXXX")" && pwd -P)
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
# The public bucket's address (pinned r2.publicBaseUrl, D78/D95): the repo's value once one is
# pinned, until then an invented one (.invalid never resolves). PIN_STG / PIN_PROD pin it, and the
# generated configurations of both Workers carry it as PUBLIC_OBJECT_BASE_URL.
pub_base() { # pub_base <env>
  python3 -c 'import json, sys
print(json.load(open(sys.argv[1]))["r2"]["publicBaseUrl"] or sys.argv[2])' \
    "$REPO/cloudflare/pinned.$1.json" "https://pub-$1.r2.test.invalid"
}
PUB_STG=$(pub_base staging)
PUB_PROD=$(pub_base production)
env_section() { # env_section <env> <stg|prod> [python on e, p] — an env.<env> block bound to that
  # env's pinned names, worker name and origins (read from the repo's pinned.<env>.json), with
  # D1 id d1-<stg|prod>-uuid and the public base PUB_<STG|PROD> (what PIN_STG / PIN_PROD pin);
  # the optional statements edit `e`.
  python3 -c 'import json, sys
env, short, edit, p, base = sys.argv[1], sys.argv[2], sys.argv[3], json.load(open(sys.argv[4])), sys.argv[5]
o = p["origins"]
# CANONICAL_ORIGINS deep-equals the pinned origins (the admin key only once it is pinned);
# AUTH_TRUSTED_ORIGINS lists the admin origin once pinned.
e = {"name": p["workerName"],
     "vars": {"APP_ENV": env, "CANONICAL_ORIGINS": {k: v for k, v in o.items() if v is not None}, "AUTH_BASE_URL": o["api"],
              "AUTH_TRUSTED_ORIGINS": ",".join([o["api"], o["web"]] + ([o["admin"]] if o["admin"] else [])),
              "SERVICE_NAME": p["workerName"], "R2_PRIVATE_BUCKET_NAME": p["r2"]["private"],
              "R2_JURISDICTION": "eu", "DISPATCH_TARGET": p["dispatchTarget"],
              "PUBLIC_OBJECT_BASE_URL": base},
     "d1_databases": [{"binding": "DB", "database_name": p["d1"]["name"], "database_id": "d1-%s-uuid" % short}],
     "r2_buckets": [{"binding": "PUBLIC_BUCKET", "bucket_name": p["r2"]["public"], "jurisdiction": "eu"},
                    {"binding": "PRIVATE_BUCKET", "bucket_name": p["r2"]["private"], "jurisdiction": "eu"},
                    {"binding": "PRODUCTION_BUCKET", "bucket_name": p["r2"]["production"], "jurisdiction": "eu"}],
     "triggers": {"crons": ["*/15 * * * *"]},
     "containers": [{"class_name": "RenderContainer", "image": "./render/Dockerfile", "instance_type": "standard-1",
                     "max_instances": 1, "constraints": {"jurisdiction": "eu"}}],
     "durable_objects": {"bindings": [{"name": "RENDER_CONTAINER", "class_name": "RenderContainer"}]},
     "queues": {"producers": [{"binding": "OUTBOX_QUEUE", "queue": p["queues"]["outbox"]},
                              {"binding": "EMAIL_QUEUE", "queue": p["queues"]["email"]},
                              {"binding": "RENDER_JOBS_QUEUE", "queue": p["queues"]["renderJobs"]}],
                "consumers": [{"queue": p["queues"]["outbox"]}, {"queue": p["queues"]["email"]}, {"queue": p["queues"]["renderJobs"]}]}}
# CP7-T3: once the repo pins production on a custom host, production carries its custom domain (and no workers.dev).
if env == "production" and not o["api"].endswith(".workers.dev"):
    e.update(routes=[{"pattern": o["api"][len("https://"):], "custom_domain": True}], workers_dev=False, preview_urls=False)
exec(edit)
print(json.dumps({env: e}))' "$1" "$2" "${3:-}" "$REPO/cloudflare/pinned.$1.json" "$(pub_base "$1")"
}
ENV_STAGING=$(env_section staging stg)
ENV_PRODUCTION=$(env_section production prod)
PIN_STG="p['d1']['id'] = 'd1-stg-uuid'; p['stripeWebhookEndpointId'] = 'we_stg'; p['stripeConnectWebhookEndpointId'] = 'we_stgc'; p['r2']['publicBaseUrl'] = '$PUB_STG'"
PIN_PROD="p['d1']['id'] = 'd1-prod-uuid'; p['stripeAccountId'] = 'acct_PRODTEST'; p['stripeWebhookEndpointId'] = 'we_prod'; p['stripeConnectWebhookEndpointId'] = 'we_prodc'; p['r2']['publicBaseUrl'] = '$PUB_PROD'"
web_section() { # web_section <env> [python on e, p] [argument] — a correct env.<env> block of the WEB
  # Worker's configuration, bound to the repo's pinned.<env>.json (webWorkerName, workerName,
  # origins.web) and PUB_<STG|PROD>; the optional statements edit `e` (and may read the optional
  # argument as sys.argv[5]).
  python3 -c 'import json, sys
env, edit, p, base = sys.argv[1], sys.argv[2], json.load(open(sys.argv[3])), sys.argv[4]
e = {"name": p["webWorkerName"], "workers_dev": env == "staging", "preview_urls": False,
     "assets": {"directory": "./dist", "binding": "ASSETS", "run_worker_first": True,
                "html_handling": "none", "not_found_handling": "none"},
     "services": [{"binding": "API", "service": p["workerName"], "entrypoint": "Internal"}],
     "vars": {"WEB_ORIGIN": p["origins"]["web"], "PUBLIC_OBJECT_BASE_URL": base}}
if env == "production" and not p["origins"]["web"].endswith(".workers.dev"):  # CP7-T3, as in env_section
    e["routes"] = [{"pattern": p["origins"]["web"][len("https://"):], "custom_domain": True}]
exec(edit)
print(json.dumps({env: e}))' "$1" "${2:-}" "$REPO/cloudflare/pinned.$1.json" "$(pub_base "$1")" "${3:-}"
}
WEB_STAGING=$(web_section staging)
WEB_PRODUCTION=$(web_section production)
# production has no admin domain yet (pinned origins.admin null): the tests that deploy it pin this one,
# a workers.dev placeholder like the pinned api and web origins (runbook §2.5's name for it). A host
# that is not on workers.dev needs its custom-domain route (CP7-T3): those cases are further down.
ADMIN_PROD_ORIGIN=https://chopshop-admin.kent-ee2.workers.dev
PIN_PROD_ADMIN="$PIN_PROD; p['origins']['admin'] = '$ADMIN_PROD_ORIGIN'"
ENV_PRODUCTION_ADMIN=$(env_section production prod "e['vars']['AUTH_TRUSTED_ORIGINS'] += ',$ADMIN_PROD_ORIGIN'")
admin_section() { # admin_section <env> [python on e, p] [argument] — a correct env.<env> block of the ADMIN
  # Worker's configuration, bound to the repo's pinned.<env>.json (adminWorkerName, workerName,
  # origins.admin, or ADMIN_PROD_ORIGIN while production's is null) and PUB_<STG|PROD>.
  python3 -c 'import json, sys
env, edit, p, base, prod_admin = sys.argv[1], sys.argv[2], json.load(open(sys.argv[3])), sys.argv[4], sys.argv[6]
e = {"name": p["adminWorkerName"], "workers_dev": env == "staging", "preview_urls": False,
     "assets": {"directory": "./dist", "binding": "ASSETS", "run_worker_first": True,
                "html_handling": "none", "not_found_handling": "none"},
     "services": [{"binding": "API", "service": p["workerName"], "entrypoint": "Internal"}],
     "vars": {"ADMIN_ORIGIN": p["origins"]["admin"] or prod_admin, "PUBLIC_OBJECT_BASE_URL": base}}
if env == "production" and not e["vars"]["ADMIN_ORIGIN"].endswith(".workers.dev"):  # CP7-T3, as in env_section
    e["routes"] = [{"pattern": e["vars"]["ADMIN_ORIGIN"][len("https://"):], "custom_domain": True}]
exec(edit)
print(json.dumps({env: e}))' "$1" "${2:-}" "$REPO/cloudflare/pinned.$1.json" "$(pub_base "$1")" "${3:-}" "$ADMIN_PROD_ORIGIN"
}
ADMIN_STAGING=$(admin_section staging)
ADMIN_PRODUCTION=$(admin_section production)

# Inherited credentials the preflight must ignore.
export CLOUDFLARE_API_TOKEN=INHERITED-WRONG-TOKEN CLOUDFLARE_API_KEY=inherited-global-key \
  CLOUDFLARE_EMAIL=inherited@example.com CLOUDFLARE_ACCOUNT_ID=$OTHER CF_API_TOKEN=INHERITED-WRONG-TOKEN \
  CLOUDFLARE_API_BASE_URL=https://inherited.example.test CF_API_BASE_URL=https://inherited-alias.example.test

write_jsonc() { # write_jsonc <tree> <account_id> [env-section-json] [top-level lines, each ending in ","] — real JSONC: comments, // in strings, trailing commas
  local envline=
  if [ -n "${3:-}" ]; then envline="\"env\": $3,"; fi
  cat >"$1/cloudflare/wrangler.jsonc" <<EOF
{
  // test config — "quotes" and // inside comments and strings must not confuse the parser
  "name": "chopshop-api",
  "account_id": "$2", /* pinned? */
  "vars": { "AUTH_BASE_URL": "https://example.test/a//b", "APP_ENV": "top-level", },
  ${4:-}
  $envline
}
EOF
}

write_web_jsonc() { # write_web_jsonc <tree> <account_id> [env-section-json] [top-level lines, each ending in ","]
  local envline=
  if [ -n "${3:-}" ]; then envline="\"env\": $3,"; fi
  cat >"$1/cloudflare/web/wrangler.jsonc" <<EOF
{
  // test config of the web Worker — "quotes" and // inside comments and strings
  "name": "chopshop-web-unbound",
  "account_id": "$2", /* pinned? */
  "main": "src/index.ts",
  "compatibility_date": "2026-08-15",
  ${4:-}
  $envline
}
EOF
}

write_admin_jsonc() { # write_admin_jsonc <tree> <account_id> [env-section-json] [top-level lines, each ending in ","]
  local envline=
  if [ -n "${3:-}" ]; then envline="\"env\": $3,"; fi
  cat >"$1/cloudflare/admin/wrangler.jsonc" <<EOF
{
  // test config of the admin Worker — "quotes" and // inside comments and strings
  "name": "chopshop-admin-unbound",
  "account_id": "$2", /* pinned? */
  "main": "src/index.ts",
  "compatibility_date": "2026-08-15",
  ${4:-}
  $envline
}
EOF
}

pin() { # pin <tree> <env> <python statements on p> — edit a copied pinned file
  python3 -c 'import json, sys
f = sys.argv[1]; p = json.load(open(f)); exec(sys.argv[2]); json.dump(p, open(f, "w"), indent=2)' \
    "$1/cloudflare/pinned.$2.json" "$3"
}

# fill_public_base <tree> <env> — for the "the repo's REAL files agree" cases: while the repo's
# pinned r2.publicBaseUrl is still null (D95), put the SAME invented origin where the project
# owner will put the real one — the copied pinned file and env.<env>.vars of the copied
# wrangler.jsonc of both Workers — and leave every other byte as committed. Once the repo pins
# the address, nothing is filled in and the committed files are checked exactly as they are.
fill_public_base() {
  python3 -c 'import json, sys
tree, env, repo, base = sys.argv[1:5]
if json.load(open(repo + "/cloudflare/pinned." + env + ".json"))["r2"]["publicBaseUrl"] is not None:
    sys.exit(0)
f = tree + "/cloudflare/pinned." + env + ".json"
p = json.load(open(f)); p["r2"]["publicBaseUrl"] = base; json.dump(p, open(f, "w"), indent=2)
def put(path, anchor, replacement):
    text = open(path).read()
    if text.count(anchor) != 1:
        sys.exit("fill_public_base: %r is not exactly once in %s" % (anchor, path))
    open(path, "w").write(text.replace(anchor, replacement))
line = "\"PUBLIC_OBJECT_BASE_URL\": \"%s\"" % base
put(tree + "/cloudflare/wrangler.jsonc", "\"APP_ENV\": \"%s\"," % env, "\"APP_ENV\": \"%s\", %s," % (env, line))
web = "\"WEB_ORIGIN\": \"%s\"" % p["origins"]["web"]
put(tree + "/cloudflare/web/wrangler.jsonc", web, web + ", " + line)' "$1" "$2" "$REPO" "$(pub_base "$2")"
}

make_tree() { # make_tree <tree> — defaults: staging bootstrap-able, token + account correct
  local d=$1
  mkdir -p "$d/scripts" "$d/cloudflare/node_modules/.bin" "$d/home/.config/chopshop" "$d/bin" "$d/cloudflare/web/dist/assets" "$d/cloudflare/admin/dist/assets"
  cp "$REPO/scripts/cf-preflight.sh" "$d/scripts/"
  cp "$REPO/cloudflare/pinned.staging.json" "$REPO/cloudflare/pinned.production.json" "$d/cloudflare/"
  write_jsonc "$d" "$GOOD"
  write_web_jsonc "$d" "$GOOD"
  write_admin_jsonc "$d" "$GOOD"
  printf '<!doctype html><div id="root"></div>\n' >"$d/cloudflare/admin/dist/index.html"
  printf 'console.log("admin");\n' >"$d/cloudflare/admin/dist/assets/index-adm123.js"
  printf '<!doctype html><div id="root"></div>\n' >"$d/cloudflare/web/dist/index.html"
  printf 'console.log("storefront");\n' >"$d/cloudflare/web/dist/assets/index-abc123.js"
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
# --config <path> is reported apart (relative to the tree), so the other args read as typed.
cfg= shown= prev=
for a in "$@"; do
  if [ "$prev" = --config ]; then cfg=$a; elif [ "$a" != --config ]; then shown="$shown${shown:+ }$a"; fi
  prev=$a
done
echo "FAKE-WRANGLER EXEC: $shown | account=${CLOUDFLARE_ACCOUNT_ID:-unset} token=$tok cwd=$(basename "$PWD")${cfg:+ config=${cfg#"$FAKE_TREE"/}}"
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
    case " ${FAKE_STRIPE_WEBHOOK:-} " in *" ${url##*/} "*) hit=1 ;; *) hit=0 ;; esac
    if [ "$hit" = 1 ]; then
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
  HOME="$T/home" PATH="$T/bin:$PATH" CHOPSHOP_CF_ENV_FILE="$T/cf.env" FAKE_TOKEN_FILE="$T/token" FAKE_TREE="$T" \
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
new_tree; pin "$T" staging "p['d1']['id'] = None; p['r2']['publicBaseUrl'] = None; p['stripeWebhookEndpointId'] = None; p['stripeConnectWebhookEndpointId'] = None"; run staging -- deploy
expect_refused "null pinned id without --bootstrap → refused" "still has null (not yet created) values: d1.id, r2.publicBaseUrl, stripeWebhookEndpointId, stripeConnectWebhookEndpointId"

new_tree; pin "$T" production "p['d1']['id'] = None; p['r2']['publicBaseUrl'] = None"; run production -- deploy
expect_refused "production with null ids without --bootstrap → refused" "d1.id, r2.publicBaseUrl, stripeAccountId, stripeWebhookEndpointId, stripeConnectWebhookEndpointId"

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
expect_refused "CANONICAL_ORIGINS.web != pinned origins.web → refused" "env.staging.vars.CANONICAL_ORIGINS is {\"admin\": \"https://chopshop-admin-stg.kent-ee2.workers.dev\", \"api\": \"https://chopshop-api-stg.kent-ee2.workers.dev\", \"web\": \"https://chopshop-web.kent-ee2.workers.dev\"}"

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "e['vars']['CANONICAL_ORIGINS']['platform'] = p['origins']['web']")"; run staging -- deploy
expect_refused "CANONICAL_ORIGINS with an extra key → refused (deep equality)" "\"platform\": \"https://chopshop-web-stg.kent-ee2.workers.dev\""

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

new_tree; pin "$T" staging "p['origins']['platform'] = 'https://platform.example.test'"; run staging --bootstrap -- whoami
expect_refused "unknown pinned origins key → refused (extend the preflight first)" "unknown key(s) origins.platform - extend the preflight first"

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

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "del e['triggers']")"; run staging -- deploy
expect_refused "cron trigger missing → refused" "triggers.crons is None, expected exactly ['*/15 * * * *']"

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

new_tree; pin "$T" staging "p['stripeWebhookEndpointId'] = None; p['stripeConnectWebhookEndpointId'] = None"; stripe_file "$T" staging "$SKEY_TEST"; FAKE_STRIPE_KEY=$SKEY_TEST FAKE_STRIPE_ACCOUNT=$STRIPE_STG run staging --bootstrap -- whoami
expect_exec "matching Stripe sandbox account → execs (webhook not yet pinned, bootstrap)" "FAKE-WRANGLER EXEC: --env staging whoami | account=$GOOD token=ok"

new_tree; pin "$T" staging "$PIN_STG"; write_jsonc "$T" "$GOOD" "$ENV_STAGING"; stripe_file "$T" staging "$SKEY_TEST"
FAKE_STRIPE_KEY=$SKEY_TEST FAKE_STRIPE_ACCOUNT=$STRIPE_STG FAKE_STRIPE_WEBHOOK="we_stg we_stgc" run staging -- deploy
expect_exec "staging fully pinned, bindings + Stripe + webhook match, no --bootstrap → execs" \
  "FAKE-WRANGLER EXEC: --env staging deploy | account=$GOOD token=ok"

new_tree; pin "$T" staging "$PIN_STG"; write_jsonc "$T" "$GOOD" "$ENV_STAGING"; stripe_file "$T" staging "$RKEY_TEST"
FAKE_STRIPE_KEY=$RKEY_TEST FAKE_STRIPE_ACCOUNT=$STRIPE_STG FAKE_STRIPE_WEBHOOK="we_stg we_stgc" run staging -- deploy
expect_exec "restricted rk_test_ key accepted for sandbox" "FAKE-WRANGLER EXEC: --env staging deploy | account=$GOOD token=ok"

new_tree; pin "$T" production "$PIN_PROD"; write_jsonc "$T" "$GOOD" "$ENV_PRODUCTION"; stripe_file "$T" production "$SKEY_LIVE"
launch_todo_all_done "$T"
FAKE_STRIPE_KEY=$SKEY_LIVE FAKE_STRIPE_ACCOUNT=acct_PRODTEST FAKE_STRIPE_WEBHOOK="we_prod we_prodc" run production -- deploy
expect_exec "production fully pinned, launch gate done (A8/A12/B11 open), live Stripe → execs" \
  "FAKE-WRANGLER EXEC: --env production deploy | account=$GOOD token=ok"

new_tree; pin "$T" production "$PIN_PROD"; write_jsonc "$T" "$GOOD" "$(env_section production prod "del e['name']")"
stripe_file "$T" production "$SKEY_LIVE"; launch_todo_all_done "$T"
FAKE_STRIPE_KEY=$SKEY_LIVE FAKE_STRIPE_ACCOUNT=acct_PRODTEST FAKE_STRIPE_WEBHOOK="we_prod we_prodc" run production -- deploy
expect_refused "env.production without a name → wrangler's effective '<top>-production' → refused" "env.production.name is 'chopshop-api-production' (wrangler's effective name: top-level name + '-production'), pinned workerName is 'chopshop-api'"

# --- the repo's REAL wrangler.jsonc agrees with the repo's real pinned files ----------------
# Only the Stripe ids that do not exist yet are filled in (and, while D95 is open, the public
# bucket's address: fill_public_base); every Cloudflare id, name, origin and jurisdiction is the
# committed one, so drift between the two files fails here.
new_tree; cp "$REPO/cloudflare/wrangler.jsonc" "$T/cloudflare/"; cp "$REPO/cloudflare/web/wrangler.jsonc" "$T/cloudflare/web/"
fill_public_base "$T" staging; pin "$T" staging "p['stripeWebhookEndpointId'] = 'we_stg'; p['stripeConnectWebhookEndpointId'] = 'we_stgc'"
stripe_file "$T" staging "$SKEY_TEST"
FAKE_STRIPE_KEY=$SKEY_TEST FAKE_STRIPE_ACCOUNT=$STRIPE_STG FAKE_STRIPE_WEBHOOK="we_stg we_stgc" run staging -- deploy
expect_exec "repo wrangler.jsonc passes every staging check against repo pinned.staging.json" \
  "FAKE-WRANGLER EXEC: --env staging deploy | account=$GOOD token=ok cwd=cloudflare"

new_tree; cp "$REPO/cloudflare/wrangler.jsonc" "$T/cloudflare/"; cp "$REPO/cloudflare/web/wrangler.jsonc" "$T/cloudflare/web/"
fill_public_base "$T" production
pin "$T" production "p['stripeAccountId'] = 'acct_PRODTEST'; p['stripeWebhookEndpointId'] = 'we_prod'; p['stripeConnectWebhookEndpointId'] = 'we_prodc'"
stripe_file "$T" production "$SKEY_LIVE"; launch_todo_all_done "$T"
FAKE_STRIPE_KEY=$SKEY_LIVE FAKE_STRIPE_ACCOUNT=acct_PRODTEST FAKE_STRIPE_WEBHOOK="we_prod we_prodc" run production -- deploy
expect_exec "repo wrangler.jsonc passes every production check against repo pinned.production.json" \
  "FAKE-WRANGLER EXEC: --env production deploy | account=$GOOD token=ok"

new_tree; pin "$T" staging "$PIN_STG"; write_jsonc "$T" "$GOOD" "$ENV_STAGING"; stripe_file "$T" staging "$SKEY_TEST"
FAKE_STRIPE_KEY=$SKEY_TEST FAKE_STRIPE_ACCOUNT=$STRIPE_STG FAKE_STRIPE_WEBHOOK="we_stg" run staging -- deploy
expect_refused "pinned CONNECT webhook endpoint missing on the Stripe account → refused" "stripeWebhookEndpointId we_stgc does not exist"

expect_exec_line() { # expect_exec_line <name> <the fake wrangler's WHOLE exec line>
  if [ "$RC" -eq 0 ] && [ "$(grep '^FAKE-WRANGLER EXEC: ' "$OUT")" = "$2" ] && ! grep -q 'PREFLIGHT REFUSED' "$OUT"; then
    ok "$1"
  else bad "$1"; fi
}
run_stg() { FAKE_STRIPE_KEY=$SKEY_TEST FAKE_STRIPE_ACCOUNT=$STRIPE_STG FAKE_STRIPE_WEBHOOK="we_stg we_stgc" run staging "$@"; }
run_prod() { FAKE_STRIPE_KEY=$SKEY_LIVE FAKE_STRIPE_ACCOUNT=acct_PRODTEST FAKE_STRIPE_WEBHOOK="we_prod we_prodc" run production "$@"; }
web_tree() { # web_tree <staging|production> [web env-section json] — a new tree, fully pinned for a --web deploy
  new_tree
  if [ "$1" = staging ]; then
    pin "$T" staging "$PIN_STG"; write_web_jsonc "$T" "$GOOD" "${2:-$WEB_STAGING}"; stripe_file "$T" staging "$SKEY_TEST"
  else
    pin "$T" production "$PIN_PROD"; write_web_jsonc "$T" "$GOOD" "${2:-$WEB_PRODUCTION}"; stripe_file "$T" production "$SKEY_LIVE"
    launch_todo_all_done "$T"
  fi
}
WEB_EXEC_STG="FAKE-WRANGLER EXEC: --env staging deploy | account=$GOOD token=ok cwd=web config=cloudflare/web/wrangler.jsonc"

# --- the new pinned keys: webWorkerName, r2.publicBaseUrl (CP4-W) --------------------------
new_tree; pin "$T" staging "del p['webWorkerName']"; run staging --bootstrap -- whoami
expect_refused "pinned file without webWorkerName → refused" "webWorkerName is missing"

new_tree; pin "$T" staging "del p['r2']['publicBaseUrl']"; run staging --bootstrap -- whoami
expect_refused "pinned file without r2.publicBaseUrl → refused (null is a value, absence is not)" "r2.publicBaseUrl is missing"

new_tree; pin "$T" staging "p['webWorkerName'] = p['workerName']"; run staging --bootstrap -- whoami
expect_refused "webWorkerName == the API's workerName → refused (even under --bootstrap)" "webWorkerName 'chopshop-api-stg' is the API's workerName - a web deploy would replace the API Worker"

new_tree; pin "$T" staging "p['r2']['publicBaseUrl'] = 'https://pub-x.r2.dev/objects'"; run staging --bootstrap -- whoami
expect_refused "pinned r2.publicBaseUrl with a path → refused (even under --bootstrap)" "r2.publicBaseUrl 'https://pub-x.r2.dev/objects' is not a bare https:// origin"

new_tree; pin "$T" staging "p['r2']['publicBaseUrl'] = 'http://pub-x.r2.dev'"; run staging --bootstrap -- whoami
expect_refused "pinned r2.publicBaseUrl over http:// → refused" "r2.publicBaseUrl 'http://pub-x.r2.dev' is not a bare https:// origin"

new_tree; pin "$T" staging "p['r2']['publicBaseUrl'] = ''"; run staging --bootstrap -- whoami
expect_refused "pinned r2.publicBaseUrl empty → refused" "r2.publicBaseUrl must be a non-empty string or null"

new_tree; pin "$T" staging "p['r2']['publicBaseUrl'] = None"; run staging --bootstrap -- d1 list
expect_exec "pinned r2.publicBaseUrl null under --bootstrap → allowed (the bucket's address is switched on under it, D95)" \
  "FAKE-WRANGLER EXEC: --env staging d1 list | account=$GOOD token=ok cwd=cloudflare"

# --- PUBLIC_OBJECT_BASE_URL of the API == pinned r2.publicBaseUrl ----------------------------
new_tree; pin "$T" staging "$PIN_STG; p['r2']['publicBaseUrl'] = None"; write_jsonc "$T" "$GOOD" "$ENV_STAGING"; stripe_file "$T" staging "$SKEY_TEST"
run_stg -- deploy
expect_refused "API deploy while pinned r2.publicBaseUrl is null (D95) → refused" "still has null (not yet created) values: r2.publicBaseUrl - create them"

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "e['vars']['PUBLIC_OBJECT_BASE_URL'] = 'https://pub-other.r2.test.invalid'")"; run staging -- deploy
expect_refused "API PUBLIC_OBJECT_BASE_URL != pinned r2.publicBaseUrl → refused" "env.staging.vars.PUBLIC_OBJECT_BASE_URL is 'https://pub-other.r2.test.invalid', pinned r2.publicBaseUrl is '$PUB_STG'"

new_tree; pin "$T" staging "$PIN_STG"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "del e['vars']['PUBLIC_OBJECT_BASE_URL']")"; run staging -- deploy
expect_refused "API PUBLIC_OBJECT_BASE_URL missing while pinned → refused" "env.staging.vars.PUBLIC_OBJECT_BASE_URL is None, pinned r2.publicBaseUrl is '$PUB_STG'"

new_tree; pin "$T" production "$PIN_PROD"
write_jsonc "$T" "$GOOD" "$(env_section production prod "e['vars']['PUBLIC_OBJECT_BASE_URL'] = '$PUB_STG'")"; run production -- deploy
expect_refused "API production PUBLIC_OBJECT_BASE_URL = staging's address → refused" "env.production.vars.PUBLIC_OBJECT_BASE_URL is '$PUB_STG', pinned r2.publicBaseUrl is '$PUB_PROD'"

new_tree; pin "$T" staging "$PIN_STG"; write_jsonc "$T" "$GOOD" "$ENV_STAGING"; stripe_file "$T" staging "$SKEY_TEST"; run_stg -- deploy
expect_exec_line "API without --web, new keys set → execs exactly as before (no --config, cwd cloudflare)" \
  "FAKE-WRANGLER EXEC: --env staging deploy | account=$GOOD token=ok cwd=cloudflare"

# --- --web: arguments -------------------------------------------------------------------------
new_tree; run staging --bootstrap --web -- whoami
expect_refused "--bootstrap with --web → refused" "--bootstrap with --web is not allowed — the web Worker creates no resource"
new_tree; run staging --web --bootstrap -- whoami
expect_refused "--web with --bootstrap (other order) → refused" "--bootstrap with --web is not allowed"
new_tree; run staging --web --web2 -- whoami
expect_refused "unknown flag beside --web → refused" "unexpected argument '--web2' before '--'"
for cmd in "secret put STRIPE_SECRET_KEY" "secret bulk" "d1 list" "r2 bucket list" "kv namespace list" "queues list" "secrets-store store list" "containers list"; do
  new_tree; run staging --web -- $cmd
  expect_refused "--web with '$cmd' → refused" "wrangler subcommand '${cmd%% *}' is not allowed with --web"
done
for cmd in "versions upload" "versions secret put STRIPE_SECRET_KEY" "versions"; do
  second=$(printf '%s\n' "$cmd" | awk '{print $2}')
  new_tree; run staging --web -- $cmd
  expect_refused "--web with '$cmd' → refused" "wrangler 'versions $second' is not allowed with --web"
done
for extra in "--var PUBLIC_OBJECT_BASE_URL:https://evil.example.test" "--assets ./elsewhere" "--routes shop.example.test" \
  "src/other.ts" "--dry-run --keep-vars" "--keep-vars"; do
  new_tree; run staging --web -- deploy $extra
  expect_refused "--web deploy $extra → refused" "with --web, deploy takes no argument but --dry-run"
done
new_tree; run staging --web -- deploy --config=cloudflare/wrangler.jsonc
expect_refused "--web deploy --config smuggled → refused" "'--config=cloudflare/wrangler.jsonc' is not allowed"

# --- --web: the web Worker's configuration (check 4) --------------------------------------------
new_tree; pin "$T" staging "$PIN_STG"; write_web_jsonc "$T" "$OTHER" "$WEB_STAGING"; run staging --web -- deploy
expect_refused "web wrangler.jsonc account_id != pinned → refused" "web/wrangler.jsonc account_id is '$OTHER', pinned cloudflareAccountId is $GOOD"

new_tree; pin "$T" staging "$PIN_STG"; write_web_jsonc "$T" "$GOOD" "$(web_section staging "e['account_id'] = '$OTHER'")"; run staging --web -- deploy
expect_refused "web env.staging.account_id != pinned → refused" "web/wrangler.jsonc env.staging.account_id is '$OTHER'"

# --- --web: env section and name ----------------------------------------------------------------
new_tree; pin "$T" staging "$PIN_STG"; run staging --web -- deploy
expect_refused "web config without env.staging → refused" "web/wrangler.jsonc has no env.staging section"

new_tree; pin "$T" staging "$PIN_STG"; write_web_jsonc "$T" "$GOOD" "$WEB_PRODUCTION"; run staging --web -- deploy
expect_refused "staging --web with only an env.production section → refused" "web/wrangler.jsonc has no env.staging section"

new_tree; pin "$T" staging "$PIN_STG"; write_web_jsonc "$T" "$GOOD" "$(web_section staging "e['name'] = p['workerName']")"; run staging --web -- deploy
expect_refused "web env.staging.name is the API Worker's name → refused" "env.staging.name is 'chopshop-api-stg', pinned webWorkerName is 'chopshop-web-stg'"

new_tree; pin "$T" staging "$PIN_STG"; write_web_jsonc "$T" "$GOOD" "$(web_section staging "e['name'] = 'chopshop-web'")"; run staging --web -- deploy
expect_refused "web env.staging.name is production's web Worker → refused" "env.staging.name is 'chopshop-web', pinned webWorkerName is 'chopshop-web-stg'"

new_tree; pin "$T" staging "$PIN_STG"; write_web_jsonc "$T" "$GOOD" "$(web_section staging "del e['name']")"; run staging --web -- deploy
expect_refused "web env.staging without a name → wrangler's effective '<top>-staging' → refused" "env.staging.name is 'chopshop-web-unbound-staging' (wrangler's effective name: top-level name + '-staging'), pinned webWorkerName is 'chopshop-web-stg'"

# --- --web: assets exactly ------------------------------------------------------------------------
for edit in "e['assets']['run_worker_first'] = False" "e['assets']['run_worker_first'] = ['/_api/*']" "e['assets']['run_worker_first'] = 1" \
  "e['assets']['html_handling'] = 'auto-trailing-slash'" "e['assets']['not_found_handling'] = 'single-page-application'" \
  "e['assets']['directory'] = '../../dist'" "e['assets']['binding'] = 'STATIC'" "e['assets']['headers'] = '_headers'" "del e['assets']"; do
  new_tree; pin "$T" staging "$PIN_STG"; write_web_jsonc "$T" "$GOOD" "$(web_section staging "$edit")"; run staging --web -- deploy
  expect_refused "web assets: $edit → refused" "env.staging.assets is"
done

# --- --web: exactly one service binding, the API of the same env through Internal ----------------
for edit in "e['services'].append({'binding': 'API2', 'service': p['workerName'], 'entrypoint': 'Internal'})" \
  "e['services'][0]['service'] = 'chopshop-api'" "del e['services'][0]['entrypoint']" "e['services'][0]['entrypoint'] = 'default'" \
  "e['services'][0]['binding'] = 'BACKEND'" "e['services'][0]['environment'] = 'production'" "del e['services']"; do
  new_tree; pin "$T" staging "$PIN_STG"; write_web_jsonc "$T" "$GOOD" "$(web_section staging "$edit")"; run staging --web -- deploy
  expect_refused "web services: $edit → refused" "env.staging.services is"
done

# --- --web: vars exactly WEB_ORIGIN + PUBLIC_OBJECT_BASE_URL -------------------------------------
new_tree; pin "$T" staging "$PIN_STG"; write_web_jsonc "$T" "$GOOD" "$(web_section staging "e['vars']['WEB_ORIGIN'] = p['origins']['api']")"; run staging --web -- deploy
expect_refused "web WEB_ORIGIN != pinned origins.web → refused" "env.staging.vars.WEB_ORIGIN is 'https://chopshop-api-stg.kent-ee2.workers.dev', pinned origins.web is 'https://chopshop-web-stg.kent-ee2.workers.dev'"

new_tree; pin "$T" staging "$PIN_STG"; write_web_jsonc "$T" "$GOOD" "$(web_section staging "e['vars']['PUBLIC_OBJECT_BASE_URL'] = 'https://pub-other.r2.test.invalid'")"; run staging --web -- deploy
expect_refused "web PUBLIC_OBJECT_BASE_URL != pinned r2.publicBaseUrl → refused" "env.staging.vars.PUBLIC_OBJECT_BASE_URL is 'https://pub-other.r2.test.invalid', pinned r2.publicBaseUrl is '$PUB_STG'"

new_tree; pin "$T" staging "$PIN_STG"; write_web_jsonc "$T" "$GOOD" "$(web_section staging "del e['vars']['PUBLIC_OBJECT_BASE_URL']")"; run staging --web -- deploy
expect_refused "web PUBLIC_OBJECT_BASE_URL missing → refused" "env.staging.vars are ['WEB_ORIGIN'], expected exactly ['PUBLIC_OBJECT_BASE_URL', 'WEB_ORIGIN']"

new_tree; pin "$T" staging "$PIN_STG"; write_web_jsonc "$T" "$GOOD" "$(web_section staging "e['vars']['API_ORIGIN'] = p['origins']['api']")"; run staging --web -- deploy
expect_refused "web vars with an extra var → refused" "env.staging.vars are ['API_ORIGIN', 'PUBLIC_OBJECT_BASE_URL', 'WEB_ORIGIN'], expected exactly"

new_tree; pin "$T" staging "$PIN_STG"; write_web_jsonc "$T" "$GOOD" "$(web_section staging "del e['vars']")"; run staging --web -- deploy
expect_refused "web vars missing → refused" "env.staging.vars are null, expected exactly"

new_tree; pin "$T" staging "$PIN_STG; p['r2']['publicBaseUrl'] = None"; write_web_jsonc "$T" "$GOOD" "$WEB_STAGING"; stripe_file "$T" staging "$SKEY_TEST"
run_stg --web -- deploy
expect_refused "web deploy while pinned r2.publicBaseUrl is null (D95) → refused" "still has null (not yet created) values: r2.publicBaseUrl - create them"

# --- --web: no other binding of any kind, no route, no cron (env section and top level) ----------
for kv in 'd1_databases=[{"binding": "DB", "database_name": "chopshop-stg", "database_id": "x"}]' \
  'r2_buckets=[{"binding": "PUBLIC_BUCKET", "bucket_name": "chopshop-stg-public", "jurisdiction": "eu"}]' \
  'kv_namespaces=[{"binding": "KV", "id": "abc"}]' \
  'queues={"producers": [{"binding": "OUTBOX_QUEUE", "queue": "chopshop-stg-outbox"}]}' \
  'durable_objects={"bindings": [{"name": "RENDER_CONTAINER", "class_name": "RenderContainer", "script_name": "chopshop-api-stg"}]}' \
  'containers=[{"class_name": "RenderContainer", "image": "./render/Dockerfile"}]' \
  'secrets_store_secrets=[{"binding": "KEY", "store_id": "s", "secret_name": "n"}]' \
  'ai={"binding": "AI"}' \
  'routes=[{"pattern": "shop.example.test/*", "zone_name": "example.test"}]' \
  'route="shop.example.test/*"' \
  'triggers={"crons": ["*/15 * * * *"]}' \
  'secrets={"required": ["STRIPE_SECRET_KEY"]}' \
  'build={"command": "make"}'; do
  key=${kv%%=*}
  new_tree; pin "$T" staging "$PIN_STG"; write_web_jsonc "$T" "$GOOD" "$(web_section staging "e['$key'] = json.loads(sys.argv[5])" "${kv#*=}")"; run staging --web -- deploy
  expect_refused "web env.staging with $key → refused" "web/wrangler.jsonc env.staging has $key - the web Worker holds no data, no secret, no route and no trigger"
done
for top in '"routes": ["shop.example.test/*"],' '"triggers": {"crons": ["* * * * *"]},' '"workers_dev": true,' '"kv_namespaces": [{"binding": "KV", "id": "abc"}],' '"assets": {"directory": "./other"},'; do
  key=${top#\"}; key=${key%%\"*}
  new_tree; pin "$T" staging "$PIN_STG"; write_web_jsonc "$T" "$GOOD" "$WEB_STAGING" "$top"; run staging --web -- deploy
  expect_refused "web top level with $key (inherited into env.staging) → refused" "web/wrangler.jsonc top level has $key - it may only hold"
done

# --- --web: production keeps workers.dev off, explicitly ----------------------------------------
for edit in "e['workers_dev'] = True" "del e['workers_dev']" "e['preview_urls'] = True" "del e['preview_urls']"; do
  key=workers_dev; case $edit in *preview_urls*) key=preview_urls ;; esac
  new_tree; pin "$T" production "$PIN_PROD"; write_web_jsonc "$T" "$GOOD" "$(web_section production "$edit")"; run production --web -- deploy
  expect_refused "web production: $edit → refused" "env.production.$key is"
done

# --- --web: the build (deploy only) ---------------------------------------------------------------
web_tree staging; rm "$T/cloudflare/web/dist/index.html"; run_stg --web -- deploy
expect_refused "web deploy without dist/index.html → refused" "web/dist/index.html not found - the storefront is not built"

web_tree staging; rm -rf "$T/cloudflare/web/dist"; run_stg --web -- deploy
expect_refused "web deploy without dist at all → refused" "web/dist/index.html not found"

web_tree staging; printf '{}' >"$T/cloudflare/web/dist/assets/index-abc123.js.map"; run_stg --web -- deploy
expect_refused "web deploy with a *.map file in dist → refused" "holds a source map: assets/index-abc123.js.map - the storefront ships none"

web_tree staging; printf '//# sourceMappingURL=data:application/json;base64,e30=\n' >>"$T/cloudflare/web/dist/assets/index-abc123.js"; run_stg --web -- deploy
expect_refused "web deploy with an inline source map comment → refused" "holds a source map: assets/index-abc123.js carries a sourceMappingURL comment"

web_tree staging; printf 'body{}\n/*# sourceMappingURL=index.css.map */\n' >"$T/cloudflare/web/dist/assets/index-def456.css"; run_stg --web -- deploy
expect_refused "web deploy with a CSS source map comment → refused" "holds a source map: assets/index-def456.css carries a sourceMappingURL comment"

web_tree staging; printf 'body{color:red}/*# sourceMappingURL=data:application/json;base64,e30= */\n' >"$T/cloudflare/web/dist/assets/index-def456.css"; run_stg --web -- deploy
expect_refused "web deploy with a source map comment behind code on its line → refused" "holds a source map: assets/index-def456.css carries a sourceMappingURL comment"

web_tree staging; printf '//# sourceMappingURL= https://maps.example.test/app.js.map\n' >>"$T/cloudflare/web/dist/assets/index-abc123.js"; run_stg --web -- deploy
expect_refused "web deploy with a space before the source map's address → refused" "holds a source map: assets/index-abc123.js carries a sourceMappingURL comment"

web_tree staging; printf 'var s="//# sourceMappingURL=";\n' >>"$T/cloudflare/web/dist/assets/index-abc123.js"; run_stg --web -- deploy
expect_exec_line "web deploy: the words inside code are not a source map comment → execs" "$WEB_EXEC_STG"

web_tree staging; rm -rf "$T/cloudflare/web/dist"; run_stg --web -- whoami
expect_exec_line "web whoami without a build → execs (the build is the deploy's concern)" \
  "FAKE-WRANGLER EXEC: --env staging whoami | account=$GOOD token=ok cwd=web config=cloudflare/web/wrangler.jsonc"

# --- --web: launch gate (6) and Stripe (7) apply as to the API ----------------------------------
new_tree; pin "$T" production "$PIN_PROD"; write_web_jsonc "$T" "$GOOD" "$WEB_PRODUCTION"; stripe_file "$T" production "$SKEY_LIVE"
run_prod --web -- deploy
expect_refused "web production with the real LAUNCH_TODO (open A/B items) → refused" "production launch gate:"

new_tree; pin "$T" staging "$PIN_STG"; write_web_jsonc "$T" "$GOOD" "$WEB_STAGING"; run staging --web -- deploy
expect_refused "web deploy without a Stripe key file → refused" "a deploy must prove the pinned Stripe account"

web_tree staging; FAKE_STRIPE_KEY=$SKEY_TEST FAKE_STRIPE_ACCOUNT=acct_SOMEBODYELSE run staging --web -- deploy
expect_refused "web deploy with the Stripe key of another account → refused" "belongs to acct_SOMEBODYELSE, pinned stripeAccountId is $STRIPE_STG"

web_tree staging; FAKE_ACCOUNTS="[{\"id\": \"$OTHER\", \"name\": \"Somebody else\"}]" run_stg --web -- deploy
expect_refused "web deploy with a token of another account → refused" "the token's account Somebody else ($OTHER) != CF_ACCOUNT_ID"

# --- --web: the passing paths -------------------------------------------------------------------
web_tree staging; run_stg --web -- deploy
if [ "$RC" -eq 0 ] && [ "$(grep '^FAKE-WRANGLER EXEC: ' "$OUT")" = "$WEB_EXEC_STG" ] &&
  grep -qF 'preflight: OK — web Worker chopshop-web-stg: wrangler --env staging --config cloudflare/web/wrangler.jsonc deploy (cwd cloudflare/web)' "$OUT"; then
  ok "web staging deploy, everything in order → execs in cloudflare/web with --config cloudflare/web/wrangler.jsonc"
else bad "web staging deploy, everything in order → execs in cloudflare/web with --config cloudflare/web/wrangler.jsonc"; fi

web_tree staging; run_stg --web -- deploy --dry-run
expect_exec_line "web deploy --dry-run → execs" \
  "FAKE-WRANGLER EXEC: --env staging deploy --dry-run | account=$GOOD token=ok cwd=web config=cloudflare/web/wrangler.jsonc"

for cmd in "tail" "deployments list" "rollback" "versions list"; do
  web_tree staging; run_stg --web -- $cmd
  expect_exec_line "web '$cmd' → execs" "FAKE-WRANGLER EXEC: --env staging $cmd | account=$GOOD token=ok cwd=web config=cloudflare/web/wrangler.jsonc"
done

web_tree production; run_prod --web -- deploy
expect_exec_line "web production, launch gate done, live Stripe, workers.dev off → execs" \
  "FAKE-WRANGLER EXEC: --env production deploy | account=$GOOD token=ok cwd=web config=cloudflare/web/wrangler.jsonc"

web_tree staging "$(web_section staging "e['workers_dev'] = False")"; run_stg --web -- deploy
expect_exec_line "web staging with workers_dev false → execs (only production is required off)" "$WEB_EXEC_STG"

# --- the repo's REAL cloudflare/web/wrangler.jsonc agrees with the repo's real pinned files ------
new_tree; cp "$REPO/cloudflare/wrangler.jsonc" "$T/cloudflare/"; cp "$REPO/cloudflare/web/wrangler.jsonc" "$T/cloudflare/web/"
fill_public_base "$T" staging; pin "$T" staging "p['stripeWebhookEndpointId'] = 'we_stg'; p['stripeConnectWebhookEndpointId'] = 'we_stgc'"
stripe_file "$T" staging "$SKEY_TEST"; run_stg --web -- deploy
expect_exec_line "repo web wrangler.jsonc passes every staging --web check against repo pinned.staging.json" "$WEB_EXEC_STG"

new_tree; cp "$REPO/cloudflare/wrangler.jsonc" "$T/cloudflare/"; cp "$REPO/cloudflare/web/wrangler.jsonc" "$T/cloudflare/web/"
fill_public_base "$T" production
pin "$T" production "p['stripeAccountId'] = 'acct_PRODTEST'; p['stripeWebhookEndpointId'] = 'we_prod'; p['stripeConnectWebhookEndpointId'] = 'we_prodc'"
stripe_file "$T" production "$SKEY_LIVE"; launch_todo_all_done "$T"; run_prod --web -- deploy
expect_exec_line "repo web wrangler.jsonc passes every production --web check against repo pinned.production.json" \
  "FAKE-WRANGLER EXEC: --env production deploy | account=$GOOD token=ok cwd=web config=cloudflare/web/wrangler.jsonc"

# The committed files as they are: while pinned r2.publicBaseUrl is null (D95), nothing deploys.
if python3 -c 'import json, sys; sys.exit(json.load(open(sys.argv[1]))["r2"]["publicBaseUrl"] is not None)' "$REPO/cloudflare/pinned.staging.json"; then
  for flag in "" --web; do
    new_tree; cp "$REPO/cloudflare/wrangler.jsonc" "$T/cloudflare/"; cp "$REPO/cloudflare/web/wrangler.jsonc" "$T/cloudflare/web/"
    stripe_file "$T" staging "$SKEY_TEST"; run_stg $flag -- deploy
    expect_refused "repo files as committed, ${flag:-API}: refused while pinned r2.publicBaseUrl is null (D95)" "still has null (not yet created) values: r2.publicBaseUrl - create them"
  done
else
  ok "repo pinned.staging.json has r2.publicBaseUrl set: the committed files are checked as they are above"
fi

# =====================================================================================================
# --admin: the third Worker (CP5-W2). Mirrors every --web check against cloudflare/admin/wrangler.jsonc.
# =====================================================================================================
ADMIN_EXEC_STG="FAKE-WRANGLER EXEC: --env staging deploy | account=$GOOD token=ok cwd=admin config=cloudflare/admin/wrangler.jsonc"
admin_tree() { # admin_tree <staging|production> [admin env-section json] [API env-section json] — fully pinned for an --admin deploy
  new_tree
  if [ "$1" = staging ]; then
    pin "$T" staging "$PIN_STG"; write_admin_jsonc "$T" "$GOOD" "${2:-$ADMIN_STAGING}"; write_jsonc "$T" "$GOOD" "${3:-$ENV_STAGING}"; stripe_file "$T" staging "$SKEY_TEST"
  else
    pin "$T" production "$PIN_PROD_ADMIN"; write_admin_jsonc "$T" "$GOOD" "${2:-$ADMIN_PRODUCTION}"; write_jsonc "$T" "$GOOD" "${3:-$ENV_PRODUCTION_ADMIN}"; stripe_file "$T" production "$SKEY_LIVE"
    launch_todo_all_done "$T"
  fi
}

# --- the new pinned keys: adminWorkerName, origins.admin -------------------------------------------
new_tree; pin "$T" staging "del p['adminWorkerName']"; run staging --bootstrap -- whoami
expect_refused "pinned file without adminWorkerName → refused" "adminWorkerName is missing"

new_tree; pin "$T" staging "del p['origins']['admin']"; run staging --bootstrap -- whoami
expect_refused "pinned origins without admin → refused (null is a value, absence is not)" "origins.admin is missing"

new_tree; pin "$T" staging "p['adminWorkerName'] = p['workerName']"; run staging --bootstrap -- whoami
expect_refused "adminWorkerName == the API's workerName → refused (even under --bootstrap)" "adminWorkerName 'chopshop-api-stg' is the API's or the web Worker's name"

new_tree; pin "$T" staging "p['adminWorkerName'] = p['webWorkerName']"; run staging --bootstrap -- whoami
expect_refused "adminWorkerName == the web Worker's name → refused (even under --bootstrap)" "adminWorkerName 'chopshop-web-stg' is the API's or the web Worker's name"

new_tree; pin "$T" staging "p['origins']['admin'] = 'http://chopshop-admin-stg.kent-ee2.workers.dev'"; run staging --bootstrap -- whoami
expect_refused "pinned origins.admin over http:// → refused" "origins.admin 'http://chopshop-admin-stg.kent-ee2.workers.dev' is not a bare https:// origin"

new_tree; pin "$T" staging "p['origins']['admin'] = 'https://chopshop-admin-stg.kent-ee2.workers.dev/platform'"; run staging --bootstrap -- whoami
expect_refused "pinned origins.admin with a path → refused" "origins.admin 'https://chopshop-admin-stg.kent-ee2.workers.dev/platform' is not a bare https:// origin"

new_tree; pin "$T" staging "p['origins']['admin'] = ''"; run staging --bootstrap -- whoami
expect_refused "pinned origins.admin empty → refused" "origins.admin must be a non-empty string or null"

# null origins.admin: refuses --admin ONLY, with its own line; never the API or the web Worker
admin_tree production "$ADMIN_PRODUCTION"; pin "$T" production "p['origins']['admin'] = None"; run_prod --admin -- deploy
expect_refused "production --admin while pinned origins.admin is null → refused with its own line" "origins.admin is null - production has no admin domain yet (D7), so the admin Worker is not deployed there"

admin_tree staging; pin "$T" staging "p['origins']['admin'] = None"; run_stg --admin -- deploy
expect_refused "staging --admin while pinned origins.admin is null → refused too" "origins.admin is null - staging has no admin domain yet"

new_tree; pin "$T" production "$PIN_PROD"; write_jsonc "$T" "$GOOD" "$ENV_PRODUCTION"; stripe_file "$T" production "$SKEY_LIVE"; launch_todo_all_done "$T"; run_prod -- deploy
expect_exec "API production deploy is NOT blocked by a null origins.admin" "FAKE-WRANGLER EXEC: --env production deploy | account=$GOOD token=ok"

new_tree; pin "$T" production "$PIN_PROD"; write_web_jsonc "$T" "$GOOD" "$WEB_PRODUCTION"; stripe_file "$T" production "$SKEY_LIVE"; launch_todo_all_done "$T"; run_prod --web -- deploy
expect_exec "web production deploy is NOT blocked by a null origins.admin" "FAKE-WRANGLER EXEC: --env production deploy | account=$GOOD token=ok cwd=web"

# --- --admin: arguments ---------------------------------------------------------------------------
new_tree; run staging --bootstrap --admin -- whoami
expect_refused "--bootstrap with --admin → refused" "--bootstrap with --admin is not allowed — the admin Worker creates no resource"
new_tree; run staging --admin --bootstrap -- whoami
expect_refused "--admin with --bootstrap (other order) → refused" "--bootstrap with --admin is not allowed"
new_tree; run staging --web --admin -- whoami
expect_refused "--web with --admin → refused" "--web with --admin is not allowed"
new_tree; run staging --admin --web -- whoami
expect_refused "--admin with --web (other order) → refused" "--web with --admin is not allowed"
new_tree; run staging --admin --admin2 -- whoami
expect_refused "unknown flag beside --admin → refused" "unexpected argument '--admin2' before '--'"
for cmd in "secret put STRIPE_SECRET_KEY" "secret bulk" "d1 list" "r2 bucket list" "kv namespace list" "queues list" "secrets-store store list" "containers list"; do
  new_tree; run staging --admin -- $cmd
  expect_refused "--admin with '$cmd' → refused" "wrangler subcommand '${cmd%% *}' is not allowed with --admin"
done
for cmd in "versions upload" "versions secret put STRIPE_SECRET_KEY" "versions"; do
  second=$(printf '%s\n' "$cmd" | awk '{print $2}')
  new_tree; run staging --admin -- $cmd
  expect_refused "--admin with '$cmd' → refused" "wrangler 'versions $second' is not allowed with --admin"
done
for extra in "--var ADMIN_ORIGIN:https://evil.example.test" "--assets ./elsewhere" "--routes admin.example.test" \
  "src/other.ts" "--dry-run --keep-vars" "--keep-vars"; do
  new_tree; run staging --admin -- deploy $extra
  expect_refused "--admin deploy $extra → refused" "with --admin, deploy takes no argument but --dry-run"
done
new_tree; run staging --admin -- deploy --config=cloudflare/wrangler.jsonc
expect_refused "--admin deploy --config smuggled → refused" "'--config=cloudflare/wrangler.jsonc' is not allowed"

# --- --admin: the admin Worker's configuration (check 4) -----------------------------------------
new_tree; pin "$T" staging "$PIN_STG"; write_admin_jsonc "$T" "$OTHER" "$ADMIN_STAGING"; run staging --admin -- deploy
expect_refused "admin wrangler.jsonc account_id != pinned → refused" "admin/wrangler.jsonc account_id is '$OTHER', pinned cloudflareAccountId is $GOOD"

admin_tree staging "$(admin_section staging "e['account_id'] = '$OTHER'")"; run staging --admin -- deploy
expect_refused "admin env.staging.account_id != pinned → refused" "admin/wrangler.jsonc env.staging.account_id is '$OTHER'"

# --- --admin: env section and name ----------------------------------------------------------------
new_tree; pin "$T" staging "$PIN_STG"; run staging --admin -- deploy
expect_refused "admin config without env.staging → refused" "admin/wrangler.jsonc has no env.staging section"

admin_tree staging "$ADMIN_PRODUCTION"; run staging --admin -- deploy
expect_refused "staging --admin with only an env.production section → refused" "admin/wrangler.jsonc has no env.staging section"

admin_tree staging "$(admin_section staging "e['name'] = p['workerName']")"; run_stg --admin -- deploy
expect_refused "admin env.staging.name is the API Worker's name → refused" "env.staging.name is 'chopshop-api-stg', pinned adminWorkerName is 'chopshop-admin-stg'"

admin_tree staging "$(admin_section staging "e['name'] = p['webWorkerName']")"; run_stg --admin -- deploy
expect_refused "admin env.staging.name is the web Worker's name → refused" "env.staging.name is 'chopshop-web-stg', pinned adminWorkerName is 'chopshop-admin-stg'"

admin_tree staging "$(admin_section staging "e['name'] = 'chopshop-admin'")"; run_stg --admin -- deploy
expect_refused "admin env.staging.name is production's admin Worker → refused" "env.staging.name is 'chopshop-admin', pinned adminWorkerName is 'chopshop-admin-stg'"

admin_tree staging "$(admin_section staging "del e['name']")"; run_stg --admin -- deploy
expect_refused "admin env.staging without a name → wrangler's effective '<top>-staging' → refused" "env.staging.name is 'chopshop-admin-unbound-staging' (wrangler's effective name: top-level name + '-staging'), pinned adminWorkerName is 'chopshop-admin-stg'"

# --- --admin: assets exactly ----------------------------------------------------------------------
for edit in "e['assets']['run_worker_first'] = False" "e['assets']['run_worker_first'] = ['/_api/*']" "e['assets']['run_worker_first'] = 1" \
  "e['assets']['html_handling'] = 'auto-trailing-slash'" "e['assets']['not_found_handling'] = 'single-page-application'" \
  "e['assets']['directory'] = '../../dist'" "e['assets']['binding'] = 'STATIC'" "e['assets']['headers'] = '_headers'" "del e['assets']"; do
  admin_tree staging "$(admin_section staging "$edit")"; run_stg --admin -- deploy
  expect_refused "admin assets: $edit → refused" "env.staging.assets is"
done

# --- --admin: exactly one service binding, the API of the same env through Internal ---------------
for edit in "e['services'].append({'binding': 'API2', 'service': p['workerName'], 'entrypoint': 'Internal'})" \
  "e['services'][0]['service'] = 'chopshop-api'" "del e['services'][0]['entrypoint']" "e['services'][0]['entrypoint'] = 'default'" \
  "e['services'][0]['binding'] = 'BACKEND'" "e['services'][0]['environment'] = 'production'" "del e['services']"; do
  admin_tree staging "$(admin_section staging "$edit")"; run_stg --admin -- deploy
  expect_refused "admin services: $edit → refused" "env.staging.services is"
done

# --- --admin: vars exactly ADMIN_ORIGIN + PUBLIC_OBJECT_BASE_URL ----------------------------------
admin_tree staging "$(admin_section staging "e['vars']['ADMIN_ORIGIN'] = p['origins']['web']")"; run_stg --admin -- deploy
expect_refused "admin ADMIN_ORIGIN != pinned origins.admin → refused" "env.staging.vars.ADMIN_ORIGIN is 'https://chopshop-web-stg.kent-ee2.workers.dev', pinned origins.admin is 'https://chopshop-admin-stg.kent-ee2.workers.dev'"

admin_tree staging "$(admin_section staging "e['vars']['PUBLIC_OBJECT_BASE_URL'] = 'https://pub-other.r2.test.invalid'")"; run_stg --admin -- deploy
expect_refused "admin PUBLIC_OBJECT_BASE_URL != pinned r2.publicBaseUrl → refused" "env.staging.vars.PUBLIC_OBJECT_BASE_URL is 'https://pub-other.r2.test.invalid', pinned r2.publicBaseUrl is '$PUB_STG'"

admin_tree staging "$(admin_section staging "del e['vars']['PUBLIC_OBJECT_BASE_URL']")"; run_stg --admin -- deploy
expect_refused "admin PUBLIC_OBJECT_BASE_URL missing → refused" "env.staging.vars are ['ADMIN_ORIGIN'], expected exactly ['ADMIN_ORIGIN', 'PUBLIC_OBJECT_BASE_URL']"

admin_tree staging "$(admin_section staging "e['vars']['WEB_ORIGIN'] = p['origins']['web']")"; run_stg --admin -- deploy
expect_refused "admin vars with an extra var → refused" "env.staging.vars are ['ADMIN_ORIGIN', 'PUBLIC_OBJECT_BASE_URL', 'WEB_ORIGIN'], expected exactly"

admin_tree staging "$(admin_section staging "del e['vars']")"; run_stg --admin -- deploy
expect_refused "admin vars missing → refused" "env.staging.vars are null, expected exactly"

admin_tree staging; pin "$T" staging "p['r2']['publicBaseUrl'] = None"; run_stg --admin -- deploy
expect_refused "admin deploy while pinned r2.publicBaseUrl is null (D95) → refused" "still has null (not yet created) values: r2.publicBaseUrl - create them"

# --- --admin: no other binding of any kind, no route, no cron (env section and top level) ---------
for kv in 'd1_databases=[{"binding": "DB", "database_name": "chopshop-stg", "database_id": "x"}]' \
  'r2_buckets=[{"binding": "PUBLIC_BUCKET", "bucket_name": "chopshop-stg-public", "jurisdiction": "eu"}]' \
  'kv_namespaces=[{"binding": "KV", "id": "abc"}]' \
  'queues={"producers": [{"binding": "OUTBOX_QUEUE", "queue": "chopshop-stg-outbox"}]}' \
  'durable_objects={"bindings": [{"name": "RENDER_CONTAINER", "class_name": "RenderContainer", "script_name": "chopshop-api-stg"}]}' \
  'containers=[{"class_name": "RenderContainer", "image": "./render/Dockerfile"}]' \
  'secrets_store_secrets=[{"binding": "KEY", "store_id": "s", "secret_name": "n"}]' \
  'ai={"binding": "AI"}' \
  'routes=[{"pattern": "admin.example.test/*", "zone_name": "example.test"}]' \
  'route="admin.example.test/*"' \
  'triggers={"crons": ["*/15 * * * *"]}' \
  'secrets={"required": ["STRIPE_SECRET_KEY"]}' \
  'build={"command": "make"}'; do
  key=${kv%%=*}
  admin_tree staging "$(admin_section staging "e['$key'] = json.loads(sys.argv[5])" "${kv#*=}")"; run_stg --admin -- deploy
  expect_refused "admin env.staging with $key → refused" "admin/wrangler.jsonc env.staging has $key - the admin Worker holds no data, no secret, no route and no trigger"
done
for top in '"routes": ["admin.example.test/*"],' '"triggers": {"crons": ["* * * * *"]},' '"workers_dev": true,' '"kv_namespaces": [{"binding": "KV", "id": "abc"}],' '"assets": {"directory": "./other"},'; do
  key=${top#\"}; key=${key%%\"*}
  admin_tree staging; write_admin_jsonc "$T" "$GOOD" "$ADMIN_STAGING" "$top"; run_stg --admin -- deploy
  expect_refused "admin top level with $key (inherited into env.staging) → refused" "admin/wrangler.jsonc top level has $key - it may only hold"
done

# --- --admin: production keeps workers.dev off, explicitly ---------------------------------------
for edit in "e['workers_dev'] = True" "del e['workers_dev']" "e['preview_urls'] = True" "del e['preview_urls']"; do
  key=workers_dev; case $edit in *preview_urls*) key=preview_urls ;; esac
  admin_tree production "$(admin_section production "$edit")"; run_prod --admin -- deploy
  expect_refused "admin production: $edit → refused" "env.production.$key is"
done

# --- --admin: the API's side of the admin origin (AUTH_TRUSTED_ORIGINS) --------------------------
admin_tree staging "" "$(env_section staging stg "e['vars']['AUTH_TRUSTED_ORIGINS'] = p['origins']['api'] + ',' + p['origins']['web']")"; run_stg --admin -- deploy
expect_refused "--admin: the API's AUTH_TRUSTED_ORIGINS lacks the admin origin → refused" "cloudflare/wrangler.jsonc env.staging.vars.AUTH_TRUSTED_ORIGINS is 'https://chopshop-api-stg.kent-ee2.workers.dev,https://chopshop-web-stg.kent-ee2.workers.dev', it must be exactly the pinned origins https://chopshop-api-stg.kent-ee2.workers.dev,https://chopshop-web-stg.kent-ee2.workers.dev,https://chopshop-admin-stg.kent-ee2.workers.dev"

admin_tree staging "" "$(env_section staging stg "e['vars']['AUTH_TRUSTED_ORIGINS'] += ',https://elsewhere.example.test'")"; run_stg --admin -- deploy
expect_refused "--admin: the API's AUTH_TRUSTED_ORIGINS with an extra origin → refused" "https://elsewhere.example.test', it must be exactly the pinned origins"

admin_tree staging; write_jsonc "$T" "$GOOD"; run_stg --admin -- deploy
expect_refused "--admin: the API's config without env.staging → refused" "cloudflare/wrangler.jsonc has no env.staging section - the admin origin cannot be shown"

admin_tree staging; write_jsonc "$T" "$OTHER" "$ENV_STAGING"; run_stg --admin -- deploy
expect_refused "--admin: the API's config on another account → refused" "cloudflare/wrangler.jsonc account_id is '$OTHER'"

admin_tree staging; write_jsonc "$T" "$GOOD" "$(env_section staging stg "e['vars']['AUTH_TRUSTED_ORIGINS'] = p['origins']['api'] + ',' + p['origins']['web']")"; run_stg -- deploy
expect_refused "API deploy: AUTH_TRUSTED_ORIGINS without the pinned admin origin → refused" "env.staging.vars.AUTH_TRUSTED_ORIGINS is 'https://chopshop-api-stg.kent-ee2.workers.dev,https://chopshop-web-stg.kent-ee2.workers.dev', it must be exactly the pinned origins"

admin_tree staging; pin "$T" staging "p['origins']['admin'] = None"; write_jsonc "$T" "$GOOD" "$(env_section staging stg "e['vars']['AUTH_TRUSTED_ORIGINS'] = p['origins']['api'] + ',' + p['origins']['web']; del e['vars']['CANONICAL_ORIGINS']['admin']")"; run_stg -- deploy
expect_exec "API deploy with a null origins.admin: AUTH_TRUSTED_ORIGINS is exactly {api, web} → execs" "FAKE-WRANGLER EXEC: --env staging deploy | account=$GOOD token=ok cwd=cloudflare"

admin_tree staging; pin "$T" staging "p['origins']['admin'] = None"; write_jsonc "$T" "$GOOD" "$(env_section staging stg "del e['vars']['CANONICAL_ORIGINS']['admin']")"; run_stg -- deploy
expect_refused "API deploy with a null origins.admin but the admin origin trusted anyway → refused (exact set)" "env.staging.vars.AUTH_TRUSTED_ORIGINS is 'https://chopshop-api-stg.kent-ee2.workers.dev,https://chopshop-web-stg.kent-ee2.workers.dev,https://chopshop-admin-stg.kent-ee2.workers.dev', it must be exactly the pinned origins https://chopshop-api-stg.kent-ee2.workers.dev,https://chopshop-web-stg.kent-ee2.workers.dev"

# --- CANONICAL_ORIGINS and the admin key ---------------------------------------------------------
admin_tree staging; run_stg -- deploy
expect_exec "CANONICAL_ORIGINS deep-equals the pinned origins including admin → execs" "FAKE-WRANGLER EXEC: --env staging deploy | account=$GOOD token=ok cwd=cloudflare"

admin_tree staging "" "$(env_section staging stg "del e['vars']['CANONICAL_ORIGINS']['admin']")"; run_stg -- deploy
expect_refused "CANONICAL_ORIGINS without the admin key while origins.admin is pinned → refused" "pinned origins are {\"admin\": \"https://chopshop-admin-stg.kent-ee2.workers.dev\", \"api\""

admin_tree staging "" "$(env_section staging stg "e['vars']['CANONICAL_ORIGINS']['admin'] = 'https://elsewhere.example.test'")"; run_stg -- deploy
expect_refused "CANONICAL_ORIGINS.admin != pinned origins.admin → refused" "env.staging.vars.CANONICAL_ORIGINS is {\"admin\": \"https://elsewhere.example.test\""

new_tree; pin "$T" production "$PIN_PROD"; write_jsonc "$T" "$GOOD" "$ENV_PRODUCTION"; stripe_file "$T" production "$SKEY_LIVE"; launch_todo_all_done "$T"; run_prod -- deploy
expect_exec "a null origins.admin needs no admin key in CANONICAL_ORIGINS → execs" "FAKE-WRANGLER EXEC: --env production deploy | account=$GOOD token=ok cwd=cloudflare"

new_tree; pin "$T" production "$PIN_PROD"; write_jsonc "$T" "$GOOD" "$(env_section production prod "e['vars']['CANONICAL_ORIGINS']['admin'] = 'https://chopshop-admin.kent-ee2.workers.dev'")"; stripe_file "$T" production "$SKEY_LIVE"; launch_todo_all_done "$T"; run_prod -- deploy
expect_refused "a null origins.admin with an admin key in CANONICAL_ORIGINS → refused" "env.production.vars.CANONICAL_ORIGINS is {\"admin\""

# --- --admin: the build (deploy only) --------------------------------------------------------------
admin_tree staging; rm "$T/cloudflare/admin/dist/index.html"; run_stg --admin -- deploy
expect_refused "admin deploy without dist/index.html → refused" "admin/dist/index.html not found - the admin is not built"

admin_tree staging; rm -rf "$T/cloudflare/admin/dist"; run_stg --admin -- deploy
expect_refused "admin deploy without dist at all → refused" "admin/dist/index.html not found"

admin_tree staging; printf '{}' >"$T/cloudflare/admin/dist/assets/index-adm123.js.map"; run_stg --admin -- deploy
expect_refused "admin deploy with a *.map file in dist → refused" "holds a source map: assets/index-adm123.js.map - the admin ships none"

admin_tree staging; printf '//# sourceMappingURL=data:application/json;base64,e30=\n' >>"$T/cloudflare/admin/dist/assets/index-adm123.js"; run_stg --admin -- deploy
expect_refused "admin deploy with an inline source map comment → refused" "holds a source map: assets/index-adm123.js carries a sourceMappingURL comment"

admin_tree staging; printf 'body{color:red}/*# sourceMappingURL=data:application/json;base64,e30= */\n' >"$T/cloudflare/admin/dist/assets/index-def456.css"; run_stg --admin -- deploy
expect_refused "admin deploy with a CSS source map comment behind code → refused" "holds a source map: assets/index-def456.css carries a sourceMappingURL comment"

admin_tree staging; printf 'var s="//# sourceMappingURL=";\n' >>"$T/cloudflare/admin/dist/assets/index-adm123.js"; run_stg --admin -- deploy
expect_exec_line "admin deploy: the words inside code are not a source map comment → execs" "$ADMIN_EXEC_STG"

admin_tree staging; rm -rf "$T/cloudflare/admin/dist"; run_stg --admin -- whoami
expect_exec_line "admin whoami without a build → execs (the build is the deploy's concern)" \
  "FAKE-WRANGLER EXEC: --env staging whoami | account=$GOOD token=ok cwd=admin config=cloudflare/admin/wrangler.jsonc"

# --- --admin: launch gate (6) and Stripe (7) apply as to the API ---------------------------------
admin_tree production; rm "$T/docs/SnapWearDocs/LAUNCH_TODO.md"; cp "$REPO/docs/SnapWearDocs/LAUNCH_TODO.md" "$T/docs/SnapWearDocs/"; run_prod --admin -- deploy
expect_refused "admin production with the real LAUNCH_TODO (open A/B items) → refused" "production launch gate:"

new_tree; pin "$T" staging "$PIN_STG"; write_admin_jsonc "$T" "$GOOD" "$ADMIN_STAGING"; write_jsonc "$T" "$GOOD" "$ENV_STAGING"; run staging --admin -- deploy
expect_refused "admin deploy without a Stripe key file → refused" "a deploy must prove the pinned Stripe account"

admin_tree staging; FAKE_STRIPE_KEY=$SKEY_TEST FAKE_STRIPE_ACCOUNT=acct_SOMEBODYELSE run staging --admin -- deploy
expect_refused "admin deploy with the Stripe key of another account → refused" "belongs to acct_SOMEBODYELSE, pinned stripeAccountId is $STRIPE_STG"

admin_tree staging; FAKE_ACCOUNTS="[{\"id\": \"$OTHER\", \"name\": \"Somebody else\"}]" run_stg --admin -- deploy
expect_refused "admin deploy with a token of another account → refused" "the token's account Somebody else ($OTHER) != CF_ACCOUNT_ID"

# --- --admin: the passing paths --------------------------------------------------------------------
admin_tree staging; run_stg --admin -- deploy
if [ "$RC" -eq 0 ] && [ "$(grep '^FAKE-WRANGLER EXEC: ' "$OUT")" = "$ADMIN_EXEC_STG" ] &&
  grep -qF 'preflight: OK — admin Worker chopshop-admin-stg: wrangler --env staging --config cloudflare/admin/wrangler.jsonc deploy (cwd cloudflare/admin)' "$OUT"; then
  ok "admin staging deploy, everything in order → execs in cloudflare/admin with --config cloudflare/admin/wrangler.jsonc"
else bad "admin staging deploy, everything in order → execs in cloudflare/admin with --config cloudflare/admin/wrangler.jsonc"; fi

admin_tree staging; run_stg --admin -- deploy --dry-run
expect_exec_line "admin deploy --dry-run → execs" \
  "FAKE-WRANGLER EXEC: --env staging deploy --dry-run | account=$GOOD token=ok cwd=admin config=cloudflare/admin/wrangler.jsonc"

for cmd in "tail" "deployments list" "rollback" "versions list"; do
  admin_tree staging; run_stg --admin -- $cmd
  expect_exec_line "admin '$cmd' → execs" "FAKE-WRANGLER EXEC: --env staging $cmd | account=$GOOD token=ok cwd=admin config=cloudflare/admin/wrangler.jsonc"
done

admin_tree production; run_prod --admin -- deploy
expect_exec_line "admin production (origins.admin pinned, launch gate done, live Stripe, workers.dev off) → execs" \
  "FAKE-WRANGLER EXEC: --env production deploy | account=$GOOD token=ok cwd=admin config=cloudflare/admin/wrangler.jsonc"

admin_tree staging "$(admin_section staging "e['workers_dev'] = False")"; run_stg --admin -- deploy
expect_exec_line "admin staging with workers_dev false → execs (only production is required off)" "$ADMIN_EXEC_STG"

# --- the repo's REAL cloudflare/admin/wrangler.jsonc agrees with the repo's real pinned files -------
new_tree; cp "$REPO/cloudflare/wrangler.jsonc" "$T/cloudflare/"; cp "$REPO/cloudflare/admin/wrangler.jsonc" "$T/cloudflare/admin/"
fill_public_base "$T" staging; pin "$T" staging "p['stripeWebhookEndpointId'] = 'we_stg'; p['stripeConnectWebhookEndpointId'] = 'we_stgc'"
stripe_file "$T" staging "$SKEY_TEST"; run_stg --admin -- deploy
expect_exec_line "repo admin wrangler.jsonc + the repo API's AUTH_TRUSTED_ORIGINS pass every staging --admin check against repo pinned.staging.json" "$ADMIN_EXEC_STG"

new_tree; cp "$REPO/cloudflare/wrangler.jsonc" "$T/cloudflare/"; cp "$REPO/cloudflare/web/wrangler.jsonc" "$T/cloudflare/web/"; cp "$REPO/cloudflare/admin/wrangler.jsonc" "$T/cloudflare/admin/"
fill_public_base "$T" production
pin "$T" production "p['stripeAccountId'] = 'acct_PRODTEST'; p['stripeWebhookEndpointId'] = 'we_prod'; p['stripeConnectWebhookEndpointId'] = 'we_prodc'"
stripe_file "$T" production "$SKEY_LIVE"; launch_todo_all_done "$T"; run_prod --admin -- deploy
expect_refused "repo files as committed: production --admin refused while pinned origins.admin is null (no domain yet)" "origins.admin is null - production has no admin domain yet"

# =====================================================================================================
# CP7-T3: a production Worker on a real domain (docs/cf-port/CP7_T3_REPORT.md). When a Worker's pinned
# origin is not a workers.dev host, its env.production.routes is EXACTLY that host's custom domain;
# otherwise it has no route. The example domain is the report's, shop-example.test (.test never resolves).
# =====================================================================================================
C_API=https://api.shop-example.test
C_WEB=https://shop.shop-example.test
C_ADMIN=https://admin.shop-example.test
# workers.dev placeholders, written out (the repo's own production pins become custom hosts on the day).
W_API=https://chopshop-api.kent-ee2.workers.dev
W_WEB=https://chopshop-web.kent-ee2.workers.dev
W_ADMIN=$ADMIN_PROD_ORIGIN
PIN_CUSTOM="$PIN_PROD; p['origins'] = {'api': '$C_API', 'web': '$C_WEB', 'admin': '$C_ADMIN'}"
# Each Worker's correct env.production on those hosts (python on e, for env_section / web_section / admin_section).
API_CUSTOM="o = {'api': '$C_API', 'web': '$C_WEB', 'admin': '$C_ADMIN'}; e['vars']['CANONICAL_ORIGINS'] = dict(o); e['vars']['AUTH_BASE_URL'] = o['api']; e['vars']['AUTH_TRUSTED_ORIGINS'] = ','.join(o.values()); e['workers_dev'] = False; e['preview_urls'] = False; e['routes'] = [{'pattern': '${C_API#https://}', 'custom_domain': True}]"
WEB_CUSTOM="e['vars']['WEB_ORIGIN'] = '$C_WEB'; e['routes'] = [{'pattern': '${C_WEB#https://}', 'custom_domain': True}]"
ADMIN_CUSTOM="e['vars']['ADMIN_ORIGIN'] = '$C_ADMIN'; e['routes'] = [{'pattern': '${C_ADMIN#https://}', 'custom_domain': True}]"
custom_tree() { # custom_tree <api|web|admin> [python on e: that Worker's env.production, after its correct block] [python on p]
  # — a new tree: production pinned on the three custom hosts, launch gate done, live Stripe, all three
  # configurations correct for those hosts; then the named Worker's env.production and the pins edited.
  local api=$API_CUSTOM web=$WEB_CUSTOM admin=$ADMIN_CUSTOM
  case $1 in
    api) api="$api; ${2:-pass}" ;;
    web) web="$web; ${2:-pass}" ;;
    admin) admin="$admin; ${2:-pass}" ;;
  esac
  new_tree
  pin "$T" production "$PIN_CUSTOM; ${3:-pass}"
  write_jsonc "$T" "$GOOD" "$(env_section production prod "$api")"
  write_web_jsonc "$T" "$GOOD" "$(web_section production "$web")"
  write_admin_jsonc "$T" "$GOOD" "$(admin_section production "$admin")"
  stripe_file "$T" production "$SKEY_LIVE"; launch_todo_all_done "$T"
}
run_custom() { # run_custom <api|web|admin> -- <wrangler args…> — run_prod for that Worker
  local kind=$1; shift
  if [ "$kind" = api ]; then run_prod "$@"; else run_prod "--$kind" "$@"; fi
}
custom_host() { case $1 in api) printf '%s' "${C_API#https://}" ;; web) printf '%s' "${C_WEB#https://}" ;; admin) printf '%s' "${C_ADMIN#https://}" ;; esac; }
deploy_exec() { # deploy_exec <api|web|admin> — the fake wrangler's whole exec line for a production deploy of that Worker
  if [ "$1" = api ]; then printf 'FAKE-WRANGLER EXEC: --env production deploy | account=%s token=ok cwd=cloudflare' "$GOOD"
  else printf 'FAKE-WRANGLER EXEC: --env production deploy | account=%s token=ok cwd=%s config=cloudflare/%s/wrangler.jsonc' "$GOOD" "$1" "$1"; fi
}
own_origin() { # own_origin <api|web|admin> <suffix> — python on e: that Worker's own origin var(s) get <suffix>, as its pin will
  case $1 in
    api) printf "o = e['vars']['CANONICAL_ORIGINS']; o['api'] += '%s'; e['vars']['AUTH_BASE_URL'] = o['api']; e['vars']['AUTH_TRUSTED_ORIGINS'] = ','.join(o.values())" "$2" ;;
    web) printf "e['vars']['WEB_ORIGIN'] += '%s'" "$2" ;;
    admin) printf "e['vars']['ADMIN_ORIGIN'] += '%s'" "$2" ;;
  esac
}

# --- accepted: exactly one route, the pinned host's custom domain ------------------------------------
for kind in api web admin; do
  custom_tree "$kind"; run_custom "$kind" -- deploy
  expect_exec_line "$kind production on its custom domain, routes EXACTLY [{pattern: $(custom_host "$kind"), custom_domain: true}] → execs" "$(deploy_exec "$kind")"
done
custom_tree api "e['routes'] = [{'custom_domain': True, 'pattern': '${C_API#https://}'}]"; run_prod -- deploy
expect_exec_line "API custom-domain route with its keys in the other order → execs (key order is free)" "$(deploy_exec api)"
custom_tree web "e['vars']['WEB_ORIGIN'] = '$W_WEB'; del e['routes']" "p['origins']['web'] = '$W_WEB'"; run_prod --web -- deploy
expect_exec_line "web production on a workers.dev pin, no route, while the API's and admin's pins are custom hosts → execs (each Worker by its own pinned origin)" "$(deploy_exec web)"
custom_tree api "del e['routes']"; run_prod --bootstrap -- d1 list
expect_exec "production --bootstrap, custom-host pins, no route → execs (--bootstrap deploys nothing; check 5 is not run)" "FAKE-WRANGLER EXEC: --env production d1 list | account=$GOOD token=ok cwd=cloudflare"

# --- refused: a custom-host pin with any other routes (none, more, another shape, host or key) --------
for kind in api web admin; do
  want="expected exactly [{\"custom_domain\": true, \"pattern\": \"$(custom_host "$kind")\"}] - pinned origins.$kind"
  for edit in "del e['routes']" "e['routes'] = []" "e['routes'] = None" "e['routes'] = e['routes'][0]" \
    "e['routes'].append(dict(e['routes'][0]))" "e['routes'].append({'pattern': 'www.shop-example.test', 'custom_domain': True})" \
    "e['routes'] = [e['routes'][0]['pattern']]" \
    "e['routes'] = [{'pattern': e['routes'][0]['pattern'] + '/*', 'zone_name': 'shop-example.test'}]" \
    "e['routes'] = [{'pattern': e['routes'][0]['pattern'] + '/*', 'zone_id': '0123456789abcdef0123456789abcdef'}]" \
    "e['routes'][0]['zone_name'] = 'shop-example.test'" \
    "e['routes'][0]['pattern'] += '/'" "e['routes'][0]['pattern'] += '/*'" "e['routes'][0]['pattern'] += '/platform'" \
    "e['routes'][0]['pattern'] = '*.shop-example.test'" "e['routes'][0]['pattern'] = '*' + e['routes'][0]['pattern']" \
    "e['routes'][0]['pattern'] += ':443'" "e['routes'][0]['pattern'] = 'https://' + e['routes'][0]['pattern']" \
    "e['routes'][0]['pattern'] = e['routes'][0]['pattern'].upper()" "e['routes'][0]['pattern'] = e['routes'][0]['pattern'].capitalize()" \
    "e['routes'][0]['pattern'] += '.'" "e['routes'][0]['pattern'] = 'www.shop-example.test'" \
    "e['routes'][0]['custom_domain'] = False" "e['routes'][0]['custom_domain'] = 1" "e['routes'][0]['custom_domain'] = 'true'" \
    "del e['routes'][0]['custom_domain']" "e['routes'][0]['enabled'] = True" "e['routes'][0]['previews_enabled'] = False"; do
    custom_tree "$kind" "$edit"; run_custom "$kind" -- deploy
    expect_refused "$kind production on a custom host, routes: $edit → refused" "$want"
  done
done

# --- refused: the custom-host pin itself carries a port, or another pinned address's host ------------
for kind in api web admin; do
  custom_tree "$kind" "$(own_origin "$kind" :8443); e['routes'][0]['pattern'] += ':8443'" "p['origins']['$kind'] += ':8443'"; run_custom "$kind" -- deploy
  expect_refused "$kind production pinned on a custom host with a port (and the route's pattern with it) → refused" "origins.$kind 'https://$(custom_host "$kind"):8443' has a port - its Worker is reached through a custom domain"
  custom_tree "$kind" "$(own_origin "$kind" :443)" "p['origins']['$kind'] += ':443'"; run_custom "$kind" -- deploy
  expect_refused "$kind production pinned on a custom host with an explicit :443 (the route without it, as new URL() gives) → refused" "origins.$kind 'https://$(custom_host "$kind"):443' has a port"
done
custom_tree api "e['vars']['CANONICAL_ORIGINS']['web'] = '$C_API'; e['vars']['AUTH_TRUSTED_ORIGINS'] = ','.join(e['vars']['CANONICAL_ORIGINS'].values())" "p['origins']['web'] = '$C_API'"; run_prod -- deploy
expect_refused "API production: pinned origins.web is the API's custom host → refused" "origins.api '$C_API' has the host of origins.web '$C_API' - each production Worker's custom domain is a host of its own"
custom_tree web "e['vars']['WEB_ORIGIN'] = '$C_ADMIN'; e['routes'][0]['pattern'] = '${C_ADMIN#https://}'" "p['origins']['web'] = '$C_ADMIN'"; run_prod --web -- deploy
expect_refused "web production: pinned on the admin Worker's custom host → refused" "origins.web '$C_ADMIN' has the host of origins.admin '$C_ADMIN'"
custom_tree admin "e['vars']['ADMIN_ORIGIN'] = '$C_WEB'; e['routes'][0]['pattern'] = '${C_WEB#https://}'" "p['origins']['admin'] = '$C_WEB'"; run_prod --admin -- deploy
expect_refused "admin production: pinned on the web Worker's custom host → refused" "origins.admin '$C_WEB' has the host of origins.web '$C_WEB'"
custom_tree web "e['vars']['PUBLIC_OBJECT_BASE_URL'] = '$C_WEB'" "p['r2']['publicBaseUrl'] = '$C_WEB'"; run_prod --web -- deploy
expect_refused "web production: pinned r2.publicBaseUrl is the web Worker's custom host → refused" "origins.web '$C_WEB' has the host of r2.publicBaseUrl '$C_WEB'"
custom_tree api "e['vars']['PUBLIC_OBJECT_BASE_URL'] = '$C_API:8443'" "p['r2']['publicBaseUrl'] = '$C_API:8443'"; run_prod -- deploy
expect_refused "API production: pinned r2.publicBaseUrl on the API's custom host, another port → refused (one host, one custom domain)" "origins.api '$C_API' has the host of r2.publicBaseUrl '$C_API:8443'"

# --- refused: workers.dev stays off on a custom domain (the API newly, web and admin as always) --------
for kind in api web admin; do
  for edit in "e['workers_dev'] = True" "del e['workers_dev']" "e['preview_urls'] = True" "del e['preview_urls']"; do
    key=workers_dev; case $edit in *preview_urls*) key=preview_urls ;; esac
    val=true; case $edit in del*) val=null ;; esac
    custom_tree "$kind" "$edit"; run_custom "$kind" -- deploy
    expect_refused "$kind production on its custom domain: $edit → refused" "env.production.$key is $val, production"
  done
done

# --- refused: a production route while the Worker's pin is a workers.dev host (today's placeholders) ---
W_PINS="p['origins'] = {'api': '$W_API', 'web': '$W_WEB', 'admin': '$W_ADMIN'}"
W_API_VARS="o = {'api': '$W_API', 'web': '$W_WEB', 'admin': '$W_ADMIN'}; e['vars']['CANONICAL_ORIGINS'] = dict(o); e['vars']['AUTH_BASE_URL'] = o['api']; e['vars']['AUTH_TRUSTED_ORIGINS'] = ','.join(o.values())"
custom_tree api "$W_API_VARS; e['routes'][0]['pattern'] = '${W_API#https://}'" "$W_PINS"; run_prod -- deploy
expect_refused "API production on a workers.dev pin with a custom-domain route on that host → refused" "env.production.routes is [{\"custom_domain\": true, \"pattern\": \"${W_API#https://}\"}] - pinned origins.api '$W_API' is a workers.dev host, so the api Worker takes no route"
custom_tree api "$W_API_VARS; e['routes'] = []" "$W_PINS"; run_prod -- deploy
expect_refused "API production on a workers.dev pin with routes [] → refused (absent means absent)" "env.production.routes is [] - pinned origins.api '$W_API' is a workers.dev host"
custom_tree api "$W_API_VARS; del e['routes']" "$W_PINS"; run_prod -- deploy
expect_exec_line "API production on a workers.dev pin with no route → execs (workers_dev false and no address, exactly as before CP7-T3)" "$(deploy_exec api)"
custom_tree web "e['vars']['WEB_ORIGIN'] = '$W_WEB'; e['routes'][0]['pattern'] = '${W_WEB#https://}'" "p['origins']['web'] = '$W_WEB'"; run_prod --web -- deploy
expect_refused "web production on a workers.dev pin with a custom-domain route on that host → refused" "pinned origins.web '$W_WEB' is a workers.dev host, so the web Worker takes no route"
custom_tree admin "e['vars']['ADMIN_ORIGIN'] = '$W_ADMIN'; e['routes'][0]['pattern'] = '${W_ADMIN#https://}'" "p['origins']['admin'] = '$W_ADMIN'"; run_prod --admin -- deploy
expect_refused "admin production on a workers.dev pin with a custom-domain route on that host → refused" "pinned origins.admin '$W_ADMIN' is a workers.dev host, so the admin Worker takes no route"

# --- refused: any route in staging -------------------------------------------------------------------
for edit in "e['routes'] = [{'pattern': p['origins']['api'][8:], 'custom_domain': True}]" "e['routes'] = []" \
  "e['routes'] = [{'pattern': 'api.shop-example.test/*', 'zone_name': 'shop-example.test'}]" "e['route'] = 'api.shop-example.test/*'"; do
  new_tree; pin "$T" staging "$PIN_STG"; write_jsonc "$T" "$GOOD" "$(env_section staging stg "$edit")"; stripe_file "$T" staging "$SKEY_TEST"; run_stg -- deploy
  expect_refused "API env.staging: $edit → refused" "cloudflare/wrangler.jsonc env.staging.route"
done
# (Each edit goes through a variable: bash 3.2 brace-expands a literal "{a, b}" nested in "$(… "…")".)
S_API=https://api-stg.shop-example.test
edit="e['vars']['CANONICAL_ORIGINS']['api'] = e['vars']['AUTH_BASE_URL'] = '$S_API'; e['vars']['AUTH_TRUSTED_ORIGINS'] = ','.join(e['vars']['CANONICAL_ORIGINS'].values()); e['routes'] = [{'pattern': '${S_API#https://}', 'custom_domain': True}]"
new_tree; pin "$T" staging "$PIN_STG; p['origins']['api'] = '$S_API'"; stripe_file "$T" staging "$SKEY_TEST"
write_jsonc "$T" "$GOOD" "$(env_section staging stg "$edit")"; run_stg -- deploy
expect_refused "API staging pinned on a custom host, with exactly that custom-domain route → refused (only production takes a route)" "env.staging.routes is [{\"custom_domain\": true, \"pattern\": \"api-stg.shop-example.test\"}] - staging takes no route"
edit="e['routes'] = [{'pattern': p['origins']['web'][8:], 'custom_domain': True}]"
web_tree staging "$(web_section staging "$edit")"; run_stg --web -- deploy
expect_refused "web env.staging with a custom-domain route on its pinned host → refused" "web/wrangler.jsonc env.staging has routes - the web Worker holds no data, no secret, no route and no trigger"
edit="e['routes'] = [{'pattern': p['origins']['admin'][8:], 'custom_domain': True}]"
admin_tree staging "$(admin_section staging "$edit")"; run_stg --admin -- deploy
expect_refused "admin env.staging with a custom-domain route on its pinned host → refused" "admin/wrangler.jsonc env.staging has routes - the admin Worker holds no data, no secret, no route and no trigger"

# --- refused: route (singular), and routes at the top level (inherited into every env) --------------
for edit in "e['route'] = e.pop('routes')[0]" "e['route'] = e.pop('routes')[0]['pattern']" "e['route'] = e['routes'][0]['pattern']"; do
  custom_tree api "$edit"; run_prod -- deploy
  expect_refused "API env.production: $edit → refused (route, singular, is never accepted)" "cloudflare/wrangler.jsonc env.production.route is"
done
for kind in web admin; do
  custom_tree "$kind" "e['route'] = e.pop('routes')[0]"; run_custom "$kind" -- deploy
  expect_refused "$kind env.production with route (singular) → refused" "$kind/wrangler.jsonc env.production has route - the $kind Worker holds no data, no secret, no trigger and no route but its pinned custom domain: env.production may only hold account_id, assets, name, preview_urls, routes, services, vars, workers_dev"
done
custom_tree web "e['kv_namespaces'] = [{'binding': 'KV', 'id': 'abc'}]"; run_prod --web -- deploy
expect_refused "web env.production on its custom domain with a KV binding → refused (a route is the only key production adds)" "web/wrangler.jsonc env.production has kv_namespaces - the web Worker holds no data"
for top in "\"routes\": [{\"pattern\": \"${C_API#https://}\", \"custom_domain\": true}]," "\"route\": {\"pattern\": \"${C_API#https://}\", \"custom_domain\": true}," '"routes": [],'; do
  key=${top#\"}; key=${key%%\"*}
  custom_tree api; write_jsonc "$T" "$GOOD" "$(env_section production prod "$API_CUSTOM")" "$top"; run_prod -- deploy
  expect_refused "API top level with ${top%,}, env.production on its custom domain → refused" "cloudflare/wrangler.jsonc top level has $key - wrangler inherits it into every env section"
done
new_tree; pin "$T" staging "$PIN_STG"; stripe_file "$T" staging "$SKEY_TEST"
write_jsonc "$T" "$GOOD" "$ENV_STAGING" '"routes": [{"pattern": "chopshop-api-stg.kent-ee2.workers.dev", "custom_domain": true}],'; run_stg -- deploy
expect_refused "API top level with routes, staging → refused" "cloudflare/wrangler.jsonc top level has routes - wrangler inherits it into every env section"
custom_tree web; write_web_jsonc "$T" "$GOOD" "$(web_section production "$WEB_CUSTOM")" "\"routes\": [{\"pattern\": \"${C_WEB#https://}\", \"custom_domain\": true}],"; run_prod --web -- deploy
expect_refused "web top level with routes, env.production on its custom domain → refused" "web/wrangler.jsonc top level has routes - it may only hold"
custom_tree admin; write_admin_jsonc "$T" "$GOOD" "$(admin_section production "$ADMIN_CUSTOM")" "\"routes\": [{\"pattern\": \"${C_ADMIN#https://}\", \"custom_domain\": true}],"; run_prod --admin -- deploy
expect_refused "admin top level with routes, env.production on its custom domain → refused" "admin/wrangler.jsonc top level has routes - it may only hold"

# --- the repo's REAL files, edited as CP7_T3_REPORT.md "The day the domain exists" says ----------------
# Copies of the three committed configurations and the committed pins, with exactly the report's edits
# (pins, vars, one routes line per Worker; the Stripe ids as above). With the routes lines all three
# deploys pass; without them all three are refused for the missing route. Once the repo is on its
# domain, the real-file cases above check it as committed.
day_of_domain() { # day_of_domain <tree> <with|without> — the report's edits, each anchor exactly once
  python3 -c 'import json, sys
tree, routes, api, web, admin, img = sys.argv[1:7]
f = tree + "/cloudflare/pinned.production.json"
p = json.load(open(f)); old = p["origins"]
def edit(path, *pairs):
    text = open(path).read()
    for anchor, new in pairs:
        if text.count(anchor) != 1:
            sys.exit("day_of_domain: %r is not exactly once in %s" % (anchor, path))
        text = text.replace(anchor, new)
    open(path, "w").write(text)
def name(worker, origin):
    line = "\"name\": \"%s\"," % worker
    return (line, line + (" \"routes\": [{ \"pattern\": \"%s\", \"custom_domain\": true }]," % origin[len("https://"):] if routes == "with" else ""))
base = "\"PUBLIC_OBJECT_BASE_URL\": \"%s\"" % img
edit(tree + "/cloudflare/wrangler.jsonc", name(p["workerName"], api),
     ("\"api\": \"%s\"," % old["api"], "\"api\": \"%s\"," % api),
     ("\"web\": \"%s\"" % old["web"], "\"web\": \"%s\", \"admin\": \"%s\"" % (web, admin)),
     ("\"AUTH_BASE_URL\": \"%s\"," % old["api"], "\"AUTH_BASE_URL\": \"%s\"," % api),
     ("\"AUTH_TRUSTED_ORIGINS\": \"%s,%s\"," % (old["api"], old["web"]), "\"AUTH_TRUSTED_ORIGINS\": \"%s,%s,%s\"," % (api, web, admin)),
     ("\"APP_ENV\": \"production\",", "\"APP_ENV\": \"production\", %s," % base))
edit(tree + "/cloudflare/web/wrangler.jsonc", name(p["webWorkerName"], web),
     ("\"WEB_ORIGIN\": \"%s\"" % old["web"], "\"WEB_ORIGIN\": \"%s\", %s" % (web, base)))
edit(tree + "/cloudflare/admin/wrangler.jsonc", name(p["adminWorkerName"], admin),
     ("\"ADMIN_ORIGIN\": \"https://chopshop-admin.kent-ee2.workers.dev\"", "\"ADMIN_ORIGIN\": \"%s\", %s" % (admin, base)))
p["origins"] = {"api": api, "web": web, "admin": admin}; p["r2"]["publicBaseUrl"] = img
p["stripeAccountId"], p["stripeWebhookEndpointId"], p["stripeConnectWebhookEndpointId"] = "acct_PRODTEST", "we_prod", "we_prodc"
json.dump(p, open(f, "w"), indent=2)' "$1" "$2" "$C_API" "$C_WEB" "$C_ADMIN" https://img.shop-example.test
}
if python3 -c 'import json, sys; sys.exit(not json.load(open(sys.argv[1]))["origins"]["api"].endswith(".workers.dev"))' "$REPO/cloudflare/pinned.production.json"; then
  for routes in with without; do
    new_tree; cp "$REPO/cloudflare/wrangler.jsonc" "$T/cloudflare/"; cp "$REPO/cloudflare/web/wrangler.jsonc" "$T/cloudflare/web/"; cp "$REPO/cloudflare/admin/wrangler.jsonc" "$T/cloudflare/admin/"
    day_of_domain "$T" "$routes"; stripe_file "$T" production "$SKEY_LIVE"; launch_todo_all_done "$T"
    for kind in api web admin; do
      run_custom "$kind" -- deploy
      if [ "$routes" = with ]; then
        expect_exec_line "repo $kind config + the report's day-of-domain edits → passes every production check" "$(deploy_exec "$kind")"
      else
        expect_refused "repo $kind config + the report's edits WITHOUT its routes line → refused (no address)" "env.production.routes is null, expected exactly [{\"custom_domain\": true, \"pattern\": \"$(custom_host "$kind")\"}]"
      fi
    done
  done
else
  ok "repo pinned.production.json is already on its custom domain: the real-file cases above check it as committed"
fi

# --- secrets never surface ----------------------------------------------------------------
RC=0 OUT=$ALL_OUT
if grep -qF -e "$TOKEN" -e "$SKEY_TEST" -e "$SKEY_LIVE" -e "$RKEY_TEST" "$ALL_OUT"; then bad "no token or Stripe key in any stdout/stderr ($N runs)"; else ok "no token or Stripe key in any stdout/stderr ($N runs)"; fi
OUT=$WORK/xtrace.txt
grep -nE '^[^#]*set -(x|o xtrace)' "$REPO/scripts/cf-preflight.sh" >"$OUT" || true
if [ -s "$OUT" ]; then bad "cf-preflight.sh never enables xtrace"; else ok "cf-preflight.sh never enables xtrace"; fi

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
