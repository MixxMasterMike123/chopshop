#!/usr/bin/env bash
# scripts/cf-preflight.sh — the ONLY entry point for wrangler against Cloudflare
# (docs/cf-port/PLAN.md §0 "Correct account, always", §6).
#
#   scripts/cf-preflight.sh <staging|production> [--bootstrap] -- <wrangler args…>
#
# Runs  cloudflare/node_modules/.bin/wrangler --env <env> <args…>  (cwd cloudflare/) only if
# every check passes; otherwise prints ONE line "PREFLIGHT REFUSED: …" and exits 1.
#   1. credentials file ($CHOPSHOP_CF_ENV_FILE, default ~/.config/chopshop/cloudflare.env) is
#      mode 600 and defines CF_ACCOUNT_ID + CLOUDFLARE_API_TOKEN; CF_ACCOUNT_ID == pinned id;
#   2. cloudflare/pinned.<env>.json has the full shape, stripeMode is sandbox (staging) or
#      live (production), production's dispatchTarget is "snapwear", and origins.api /
#      origins.web are bare https:// origins (no path, query or fragment);
#   3. `wrangler whoami --json`, run with THAT token, sees exactly one account, and its id ==
#      CF_ACCOUNT_ID == pinned cloudflareAccountId;
#   4. cloudflare/wrangler.jsonc account_id (top level, and env.<env> when set) == pinned id;
#   5. unless --bootstrap: no null left in the pinned file (null = resource not created yet)
#      and wrangler.jsonc has env.<env> whose name (or wrangler's effective `<top>-<env>`) ==
#      pinned workerName, whose APP_ENV is <env>, whose bindings are EXACTLY DB / PUBLIC_BUCKET /
#      PRIVATE_BUCKET / PRODUCTION_BUCKET / OUTBOX_QUEUE / EMAIL_QUEUE / RENDER_JOBS_QUEUE (+ the
#      three consumers) each on its own pinned resource (every R2 binding in "eu"), one container
#      RenderContainer (./render/Dockerfile, max_instances 1, EU) bound as RENDER_CONTAINER, whose vars.CANONICAL_ORIGINS deep-equals pinned
#      origins, AUTH_BASE_URL == origins.api, AUTH_TRUSTED_ORIGINS == exactly the set
#      {origins.api, origins.web}, SERVICE_NAME == pinned workerName, R2_PRIVATE_BUCKET_NAME
#      == pinned r2.private, R2_JURISDICTION == "eu" and DISPATCH_TARGET == pinned dispatchTarget (without that section wrangler silently deploys the top-level config);
#   6. production without --bootstrap: every launch-gate item of docs/SnapWearDocs/LAUNCH_TODO.md
#      (A1–A7, A9–A11, A13–A14, B1–B10 — PLAN §0) is ☑;
#   7. Stripe, via ~/.config/chopshop/stripe.<env>.env (mode 600, STRIPE_SECRET_KEY; REQUIRED
#      unless --bootstrap): the key prefix matches stripeMode (sk_/rk_ + test_ for sandbox,
#      live_ for live), GET /v1/account id == pinned stripeAccountId, and the pinned
#      stripeWebhookEndpointId (when set) exists on that account.
#
# Secrets: the Cloudflare token is never printed and never put on a command line — it reaches
# wrangler only through the environment; the Stripe key reaches curl only through stdin.
# Inherited Cloudflare credentials are dropped first (inside wrangler a global API key + email
# would take precedence over the token). The wrangler binary is resolved by path, never via
# $PATH. Never add `set -x` to this file.

set -euo pipefail
set +x

refuse() { printf 'PREFLIGHT REFUSED: %s\n' "$*" >&2; exit 1; }
note() { printf 'preflight: %s\n' "$*" >&2; }

USAGE='usage: scripts/cf-preflight.sh <staging|production> [--bootstrap] -- <wrangler args…>'
[ $# -ge 1 ] || refuse "$USAGE"
ENV_NAME=$1
shift
case $ENV_NAME in
  staging | production) ;;
  *) refuse "unknown environment '$ENV_NAME' — $USAGE" ;;
esac
BOOTSTRAP=0
while [ $# -gt 0 ] && [ "$1" != -- ]; do
  case $1 in
    --bootstrap) BOOTSTRAP=1 ;;
    *) refuse "unexpected argument '$1' before '--' — $USAGE" ;;
  esac
  shift
done
[ $# -gt 0 ] || refuse "missing '--' before the wrangler arguments — $USAGE"
shift
[ $# -gt 0 ] || refuse "no wrangler arguments after '--' — $USAGE"
for arg in "$@"; do
  case $arg in
    --env* | --config* | --cwd* | --name* | -[ec]* | -[!-]*[ec]*)
      refuse "wrangler argument '$arg' is not allowed — environment, config file, worker name and credentials are fixed by the preflight" ;;
  esac
done
# --bootstrap exists to CREATE resources before their ids are pinned; it skips the resource,
# launch-gate and Stripe checks, so it must never be able to deploy anything. Only these
# subcommands may run under it.
if [ "$BOOTSTRAP" = 1 ]; then
  case $1 in
    whoami | d1 | r2 | queues) ;;
    *) refuse "wrangler subcommand '$1' is not allowed under --bootstrap (only whoami, d1, r2, queues) — deploys go through scripts/cf-deploy.sh with the full checks" ;;
  esac
fi

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
CF_DIR=$ROOT/cloudflare
PINNED=$CF_DIR/pinned.$ENV_NAME.json
JSONC=$CF_DIR/wrangler.jsonc
WRANGLER=$CF_DIR/node_modules/.bin/wrangler
LAUNCH_TODO=$ROOT/docs/SnapWearDocs/LAUNCH_TODO.md
ENV_FILE=${CHOPSHOP_CF_ENV_FILE:-$HOME/.config/chopshop/cloudflare.env}
STRIPE_FILE=$HOME/.config/chopshop/stripe.$ENV_NAME.env

# Drop every inherited Cloudflare credential/target before anything can reach wrangler.
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL CLOUDFLARE_ACCOUNT_ID \
  CLOUDFLARE_API_BASE_URL CF_API_BASE_URL CF_API_TOKEN CF_API_KEY CF_EMAIL CF_ACCOUNT_ID

command -v python3 >/dev/null 2>&1 || refuse "python3 is required (JSON parsing)"
[ -x "$WRANGLER" ] || refuse "wrangler is not installed at $WRANGLER (run npm ci in cloudflare/)"
[ -f "$PINNED" ] || refuse "pinned identity file $PINNED not found"
[ -f "$JSONC" ] || refuse "$JSONC not found"

file_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

# env_value <file> <KEY>: the value of KEY=… (optional `export`, optional quotes). The file is
# parsed, never sourced, and the value is emitted by a builtin (it never appears in argv).
env_value() {
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
    if [ "$key" = "$2" ]; then
      printf '%s' "$val"
      return 0
    fi
  done <"$1"
}

IFS= read -r -d '' PY <<'PY' || true
import json, re, sys

def refuse(msg):
    print(msg)
    sys.exit(1)

def load_json(path, what):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception as e:
        refuse(f"cannot parse {what}: {e}")

def jsonc_to_json(text):
    """Drop // and /* */ comments and trailing commas; string contents are left untouched."""
    out, i, n, comma = [], 0, len(text), None
    while i < n:
        c = text[i]
        if c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            out.append(text[i : j + 1])
            i, comma = j + 1, None
        elif text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            if j < 0:
                raise ValueError("unterminated /* comment")
            i = j + 2
        else:
            if c in "}]" and comma is not None:
                out[comma] = ""
            if c == ",":
                comma = len(out)
            elif not c.isspace():
                comma = None
            out.append(c)
            i += 1
    return "".join(out)

SHAPE = {
    "cloudflareAccountId": str, "cloudflareAccountName": str, "workerName": str,
    "origins": {"api": str, "web": str},
    "d1": {"name": str, "id": str},
    "r2": {"public": str, "private": str, "production": str},
    "queues": {"outbox": str, "email": str, "renderJobs": str},
    "stripeAccountId": str, "stripeMode": str, "stripeWebhookEndpointId": str, "dispatchTarget": str,
}
NULLABLE = {"d1.id", "stripeAccountId", "stripeWebhookEndpointId"}  # null = not created yet
# A bare https origin exactly as a browser serialises it: lowercase host, optional port, and
# nothing after it — no path (not even "/"), query, fragment or userinfo. Reset/verification
# links are built from these (PLAN §2.1), so anything looser is a link-injection surface.
ORIGIN = r"https://[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[0-9]{1,5})?"

def walk(obj, shape, prefix, nulls, where):
    if not isinstance(obj, dict):
        refuse(f"{where}: {prefix or 'top level'} must be an object")
    extra = sorted(set(obj) - set(shape))
    if extra:
        refuse(f"{where}: unknown key(s) {', '.join(prefix + k for k in extra)} - extend the preflight first")
    for key, typ in shape.items():
        path = prefix + key
        if key not in obj:
            refuse(f"{where}: {path} is missing")
        val = obj[key]
        if isinstance(typ, dict):
            walk(val, typ, path + ".", nulls, where)
        elif val is None and path in NULLABLE:
            nulls.append(path)
        elif not isinstance(val, str) or not val:
            refuse(f"{where}: {path} must be a non-empty string" + (" or null" if path in NULLABLE else ""))

def cmd_pinned(path, env, bootstrap):
    p = load_json(path, path)
    nulls = []
    walk(p, SHAPE, "", nulls, path)
    if not re.fullmatch(r"[0-9a-f]{32}", p["cloudflareAccountId"]):
        refuse(f"{path}: cloudflareAccountId is not a 32-hex account id")
    for key, pat in (("stripeAccountId", r"acct_[A-Za-z0-9]+"), ("stripeWebhookEndpointId", r"we_[A-Za-z0-9]+")):
        if p[key] is not None and not re.fullmatch(pat, p[key]):
            refuse(f"{path}: {key} {p[key]!r} is not a Stripe {pat.split('_')[0]}_ id")
    for key in ("api", "web"):
        if not re.fullmatch(ORIGIN, p["origins"][key]):
            refuse(f"{path}: origins.{key} {p['origins'][key]!r} is not a bare https:// origin (lowercase host, optional port; no path, query or fragment)")
    want_mode = "sandbox" if env == "staging" else "live"
    if p["stripeMode"] != want_mode:
        refuse(f"{path}: stripeMode is {p['stripeMode']!r}, {env} requires {want_mode!r}")
    if env == "production" and p["dispatchTarget"] != "snapwear":
        refuse(f"{path}: production dispatchTarget is {p['dispatchTarget']!r} - only 'snapwear' may be deployed to production")
    if nulls and bootstrap != "1":
        refuse(f"{path} still has null (not yet created) values: {', '.join(nulls)} - create them under --bootstrap, pin the ids, then deploy")
    print("|".join([p["cloudflareAccountId"], p["stripeAccountId"] or "", p["stripeMode"],
                    p["stripeWebhookEndpointId"] or "", ", ".join(nulls)]))

def cmd_whoami(path, file_id, pinned_id):
    w = load_json(path, "wrangler whoami --json output")
    if not w.get("loggedIn"):
        refuse("wrangler whoami: the token from the credentials file is not logged in (revoked or expired?)")
    accts = w.get("accounts") or []
    seen = ", ".join("{} ({})".format(a.get("name"), a.get("id")) for a in accts) or "none"
    if len(accts) != 1:
        refuse(f"the token sees {len(accts)} accounts [{seen}] - exactly one is required")
    got = accts[0].get("id")
    if got != file_id:
        refuse(f"the token's account {seen} != CF_ACCOUNT_ID {file_id} in the credentials file")
    if got != pinned_id:
        refuse(f"the token's account {seen} != pinned cloudflareAccountId {pinned_id}")
    print(accts[0].get("name") or "")

def cmd_jsonc(jsonc, pinned_path, env, bootstrap):
    try:
        with open(jsonc) as f:
            cfg = json.loads(jsonc_to_json(f.read()))
    except Exception as e:
        refuse(f"cannot parse {jsonc}: {e}")
    p = load_json(pinned_path, pinned_path)
    pid = p["cloudflareAccountId"]
    if cfg.get("account_id") != pid:
        refuse(f"{jsonc} account_id is {cfg.get('account_id')!r}, pinned cloudflareAccountId is {pid}")
    e = (cfg.get("env") or {}).get(env)
    if e is not None and "account_id" in e and e["account_id"] != pid:
        refuse(f"{jsonc} env.{env}.account_id is {e['account_id']!r}, pinned cloudflareAccountId is {pid}")
    if bootstrap == "1":
        return
    if not isinstance(e, dict):
        refuse(f"{jsonc} has no env.{env} section - wrangler would silently deploy the top-level bindings")
    # The deployed name: env.<env>.name, or — when the section sets none — wrangler's
    # effective name `<top-level name>-<env>`.
    name = e.get("name", f"{cfg.get('name')}-{env}")
    if name != p["workerName"]:
        inherited = "" if "name" in e else " (wrangler's effective name: top-level name + '-" + env + "')"
        refuse(f"{jsonc} env.{env}.name is {name!r}{inherited}, pinned workerName is {p['workerName']!r}")
    v = e.get("vars") or {}
    app_env = v.get("APP_ENV")
    if app_env != env:
        refuse(f"{jsonc} env.{env}.vars.APP_ENV is {app_env!r}, expected {env!r}")
    origins = p["origins"]
    if v.get("CANONICAL_ORIGINS") != origins:
        refuse(f"{jsonc} env.{env}.vars.CANONICAL_ORIGINS is {json.dumps(v.get('CANONICAL_ORIGINS'), sort_keys=True)}, pinned origins are {json.dumps(origins, sort_keys=True)}")
    if v.get("AUTH_BASE_URL") != origins["api"]:
        refuse(f"{jsonc} env.{env}.vars.AUTH_BASE_URL is {v.get('AUTH_BASE_URL')!r}, pinned origins.api is {origins['api']!r}")
    if v.get("SERVICE_NAME") != p["workerName"]:
        refuse(f"{jsonc} env.{env}.vars.SERVICE_NAME is {v.get('SERVICE_NAME')!r}, pinned workerName is {p['workerName']!r}")
    if v.get("R2_PRIVATE_BUCKET_NAME") != p["r2"]["private"]:
        refuse(f"{jsonc} env.{env}.vars.R2_PRIVATE_BUCKET_NAME is {v.get('R2_PRIVATE_BUCKET_NAME')!r}, pinned r2.private is {p['r2']['private']!r}")
    if v.get("DISPATCH_TARGET") != p["dispatchTarget"]:
        refuse(f"{jsonc} env.{env}.vars.DISPATCH_TARGET is {v.get('DISPATCH_TARGET')!r}, pinned dispatchTarget is {p['dispatchTarget']!r}")
    if v.get("R2_JURISDICTION") != "eu":
        refuse(f"{jsonc} env.{env}.vars.R2_JURISDICTION is {v.get('R2_JURISDICTION')!r}, every R2 binding is in 'eu' so the presign host var must say 'eu'")
    trusted = v.get("AUTH_TRUSTED_ORIGINS")
    if not isinstance(trusted, str) or {o.strip() for o in trusted.split(",")} != {origins["api"], origins["web"]}:
        refuse(f"{jsonc} env.{env}.vars.AUTH_TRUSTED_ORIGINS is {trusted!r}, it must be exactly the pinned origins {origins['api']},{origins['web']}")
    # Every binding the Worker code reads must exist and point at exactly its pinned resource:
    # a missing binding fails closed at runtime (bad), a binding on the wrong resource does not
    # (worse — PRIVATE_BUCKET on the public bucket would publish private uploads).
    def bindings(items, key_name, target_key):
        seen = {}
        for item in items or []:
            b = item.get(key_name)
            if b in seen:
                refuse(f"{jsonc} env.{env} declares binding {b!r} twice")
            seen[b] = item.get(target_key)
        return seen
    d1 = bindings(e.get("d1_databases"), "binding", "database_name")
    if set(d1) != {"DB"}:
        refuse(f"{jsonc} env.{env} d1_databases bindings are {sorted(d1)}, expected exactly ['DB']")
    db = next(x for x in e["d1_databases"] if x.get("binding") == "DB")
    if (db.get("database_name"), db.get("database_id")) != (p["d1"]["name"], p["d1"]["id"]):
        refuse(f"{jsonc} env.{env} D1 binding DB -> {db.get('database_name')} ({db.get('database_id')}) is not the pinned {p['d1']['name']} ({p['d1']['id']})")
    want_r2 = {"PUBLIC_BUCKET": p["r2"]["public"], "PRIVATE_BUCKET": p["r2"]["private"], "PRODUCTION_BUCKET": p["r2"]["production"]}
    r2 = bindings(e.get("r2_buckets"), "binding", "bucket_name")
    if set(r2) != set(want_r2):
        refuse(f"{jsonc} env.{env} r2_buckets bindings are {sorted(r2)}, expected exactly {sorted(want_r2)}")
    for b, bucket in want_r2.items():
        if r2[b] != bucket:
            refuse(f"{jsonc} env.{env} R2 binding {b} -> {r2[b]!r} is not its pinned bucket {bucket!r}")
    for b in e.get("r2_buckets") or []:
        # Every bucket was created in the EU jurisdiction (docs/cf-port/CP1_BOOTSTRAP.md); a
        # binding without it would address a different, non-existent (or non-EU) bucket.
        if b.get("jurisdiction") != "eu":
            refuse(f"{jsonc} env.{env} R2 binding {b.get('binding')} -> {b.get('bucket_name')!r} has jurisdiction {b.get('jurisdiction')!r}, every bucket is in 'eu'")
    want_q = {"OUTBOX_QUEUE": p["queues"]["outbox"], "EMAIL_QUEUE": p["queues"]["email"], "RENDER_JOBS_QUEUE": p["queues"]["renderJobs"]}
    q = e.get("queues") or {}
    producers = bindings(q.get("producers"), "binding", "queue")
    if set(producers) != set(want_q):
        refuse(f"{jsonc} env.{env} queue producer bindings are {sorted(producers)}, expected exactly {sorted(want_q)}")
    for b, queue in want_q.items():
        if producers[b] != queue:
            refuse(f"{jsonc} env.{env} queue producer {b} -> {producers[b]!r} is not its pinned queue {queue!r}")
    # The render container (D6): exactly one container class bound as RENDER_CONTAINER, one
    # instance, EU-placed, built from the repo's Dockerfile.
    containers = e.get("containers") or []
    if [c.get("class_name") for c in containers] != ["RenderContainer"]:
        refuse(f"{jsonc} env.{env} containers are {[c.get('class_name') for c in containers]}, expected exactly ['RenderContainer']")
    c = containers[0]
    if c.get("image") != "./render/Dockerfile" or c.get("max_instances") != 1 or (c.get("constraints") or {}).get("jurisdiction") != "eu":
        refuse(f"{jsonc} env.{env} container RenderContainer must be image ./render/Dockerfile, max_instances 1, constraints.jurisdiction 'eu' (got {json.dumps(c, sort_keys=True)})")
    do = bindings((e.get("durable_objects") or {}).get("bindings"), "name", "class_name")
    if do != {"RENDER_CONTAINER": "RenderContainer"}:
        refuse(f"{jsonc} env.{env} durable_objects bindings are {do}, expected exactly {{'RENDER_CONTAINER': 'RenderContainer'}}")
    consumers = sorted(item.get("queue") for item in (q.get("consumers") or []))
    if consumers != sorted(want_q.values()):
        refuse(f"{jsonc} env.{env} queue consumers are {consumers}, expected exactly the pinned {sorted(want_q.values())}")

def cmd_stripe(path, code, pinned_acct, key_file):
    s = load_json(path, "Stripe /v1/account response")
    if code != "200":
        err = s.get("error") or {}
        refuse(f"Stripe GET /v1/account with the key in {key_file} returned HTTP {code} ({err.get('type')}/{err.get('code')})")
    if s.get("id") != pinned_acct:
        refuse(f"the Stripe key in {key_file} belongs to {s.get('id')}, pinned stripeAccountId is {pinned_acct or 'null'}")
    print(s["id"])

def cmd_webhook(path, code, wid, key_file):
    w = load_json(path, "Stripe webhook endpoint response")
    if code != "200" or w.get("id") != wid:
        err = w.get("error") or {}
        refuse(f"pinned stripeWebhookEndpointId {wid} does not exist for the key in {key_file} (HTTP {code}, {err.get('code')})")
    print("{} -> {}".format(w.get("status"), w.get("url")))

LAUNCH_REQUIRED = ["A%d" % i for i in (1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 13, 14)] + ["B%d" % i for i in range(1, 11)]

def cmd_launch(path):
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except Exception as e:
        refuse(f"cannot read the launch checklist {path}: {e}")
    status, header = {}, None
    for line in lines:
        if not line.startswith("|"):
            header = None
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if header is None:
            header = cells
            continue
        if not "".join(cells).strip("-: ") or not re.fullmatch(r"[AB]\d+", cells[0]):
            continue
        col = next((i for i, h in enumerate(header) if h.lower() == "status"), None)
        if cells[0] in status:
            refuse(f"{path}: launch item {cells[0]} appears twice")
        status[cells[0]] = cells[col] if col is not None and col < len(cells) else ""
    not_done = [i for i in LAUNCH_REQUIRED if not status.get(i, "").startswith("\u2611")]  # BALLOT BOX WITH CHECK
    if not_done:
        refuse(f"production launch gate: {path} items not marked done: {', '.join(not_done)}")

{"pinned": cmd_pinned, "whoami": cmd_whoami, "jsonc": cmd_jsonc, "stripe": cmd_stripe,
 "webhook": cmd_webhook, "launch": cmd_launch}[sys.argv[1]](*sys.argv[2:])
PY

# --- 1. credentials file -----------------------------------------------------------------
[ -f "$ENV_FILE" ] || refuse "credentials file $ENV_FILE not found"
mode=$(file_mode "$ENV_FILE") || refuse "cannot stat $ENV_FILE"
[ "$mode" = 600 ] || refuse "credentials file $ENV_FILE has mode $mode — it must be 600 (chmod 600 it)"
FILE_ACCOUNT_ID=$(env_value "$ENV_FILE" CF_ACCOUNT_ID)
TOKEN=$(env_value "$ENV_FILE" CLOUDFLARE_API_TOKEN)
[ -n "$FILE_ACCOUNT_ID" ] || refuse "$ENV_FILE defines no CF_ACCOUNT_ID"
[ -n "$TOKEN" ] || refuse "$ENV_FILE defines no CLOUDFLARE_API_TOKEN"

# --- 2. pinned identity -------------------------------------------------------------------
out=$(python3 -c "$PY" pinned "$PINNED" "$ENV_NAME" "$BOOTSTRAP") || refuse "${out:-python3 helper failed on $PINNED}"
IFS='|' read -r PINNED_ID STRIPE_ACCT STRIPE_MODE WEBHOOK_ID NULLS <<<"$out"
[ "$FILE_ACCOUNT_ID" = "$PINNED_ID" ] ||
  refuse "CF_ACCOUNT_ID $FILE_ACCOUNT_ID in $ENV_FILE != pinned cloudflareAccountId $PINNED_ID"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/cf-preflight.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

# --- 3. who does the token belong to? -----------------------------------------------------
rc=0
(cd "$CF_DIR" && CLOUDFLARE_API_TOKEN=$TOKEN "$WRANGLER" whoami --json) >"$TMP/whoami.json" 2>"$TMP/whoami.err" || rc=$?
if [ "$rc" -ne 0 ]; then
  err=$(cat "$TMP/whoami.err" "$TMP/whoami.json" | grep -v '^[[:space:]]*$' | tail -n 1 || true)
  refuse "wrangler whoami failed (exit $rc) with the token from $ENV_FILE: ${err//"$TOKEN"/<redacted>}"
fi
out=$(python3 -c "$PY" whoami "$TMP/whoami.json" "$FILE_ACCOUNT_ID" "$PINNED_ID") || refuse "${out:-python3 helper failed on whoami output}"
ACCOUNT_NAME=$out
note "token sees exactly one account: $ACCOUNT_NAME ($PINNED_ID) = pinned"

# --- 4 + 5. wrangler.jsonc targets the pinned account and resources -----------------------
out=$(python3 -c "$PY" jsonc "$JSONC" "$PINNED" "$ENV_NAME" "$BOOTSTRAP") || refuse "${out:-python3 helper failed on $JSONC}"

# --- 6. production launch gate (PLAN §0) ----------------------------------------------------
if [ "$ENV_NAME" = production ] && [ "$BOOTSTRAP" = 0 ]; then
  out=$(python3 -c "$PY" launch "$LAUNCH_TODO") || refuse "${out:-python3 helper failed on $LAUNCH_TODO}"
fi

# --- 7. Stripe account + webhook endpoint ---------------------------------------------------
# stripe_get <api path> <outfile>: prints the HTTP status; the key travels on curl's stdin only.
stripe_get() {
  printf 'user = "%s:"\n' "$SKEY" |
    curl -sS --max-time 20 -K - -o "$2" -w '%{http_code}' "https://api.stripe.com$1" 2>"$TMP/stripe.err"
}
if [ -f "$STRIPE_FILE" ]; then
  smode=$(file_mode "$STRIPE_FILE") || refuse "cannot stat $STRIPE_FILE"
  [ "$smode" = 600 ] || refuse "$STRIPE_FILE has mode $smode — it must be 600 (chmod 600 it)"
  SKEY=$(env_value "$STRIPE_FILE" STRIPE_SECRET_KEY)
  [ -n "$SKEY" ] || refuse "$STRIPE_FILE defines no STRIPE_SECRET_KEY"
  if [ "$STRIPE_MODE" = live ]; then want=live_; else want=test_; fi
  case $SKEY in
    sk_"$want"* | rk_"$want"*) ;;
    *) refuse "the key in $STRIPE_FILE starts with ${SKEY:0:8}, stripeMode $STRIPE_MODE requires sk_$want or rk_$want" ;;
  esac
  command -v curl >/dev/null 2>&1 || refuse "curl is required for the Stripe checks"
  code=$(stripe_get /v1/account "$TMP/stripe.json") || refuse "Stripe GET /v1/account failed: $(tail -n 1 "$TMP/stripe.err")"
  out=$(python3 -c "$PY" stripe "$TMP/stripe.json" "$code" "$STRIPE_ACCT" "$STRIPE_FILE") || refuse "${out:-python3 helper failed on the Stripe response}"
  note "Stripe key belongs to the pinned $STRIPE_MODE account $out"
  if [ -n "$WEBHOOK_ID" ]; then
    code=$(stripe_get "/v1/webhook_endpoints/$WEBHOOK_ID" "$TMP/webhook.json") ||
      refuse "Stripe GET /v1/webhook_endpoints failed: $(tail -n 1 "$TMP/stripe.err")"
    out=$(python3 -c "$PY" webhook "$TMP/webhook.json" "$code" "$WEBHOOK_ID" "$STRIPE_FILE") || refuse "${out:-python3 helper failed on the webhook response}"
    note "pinned Stripe webhook endpoint $WEBHOOK_ID exists: $out"
  fi
  unset SKEY
elif [ "$BOOTSTRAP" = 0 ]; then
  refuse "no $STRIPE_FILE (STRIPE_SECRET_KEY, mode 600) — a deploy must prove the pinned Stripe account and webhook endpoint"
else
  note "no $STRIPE_FILE — Stripe checks SKIPPED (bootstrap)"
fi

# --- all checks passed --------------------------------------------------------------------
rm -rf "$TMP"
trap - EXIT
if [ "$BOOTSTRAP" = 1 ]; then
  note "OK (BOOTSTRAP: unset ids and env.$ENV_NAME bindings not enforced${NULLS:+; null: $NULLS}) — wrangler --env $ENV_NAME $*"
else
  note "OK — wrangler --env $ENV_NAME $*"
fi
cd "$CF_DIR"
export CLOUDFLARE_API_TOKEN=$TOKEN CLOUDFLARE_ACCOUNT_ID=$PINNED_ID
exec "$WRANGLER" --env "$ENV_NAME" "$@"
