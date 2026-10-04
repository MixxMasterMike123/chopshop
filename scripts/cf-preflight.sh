#!/usr/bin/env bash
# scripts/cf-preflight.sh — the ONLY entry point for wrangler against Cloudflare
# (docs/cf-port/PLAN.md §0 "Correct account, always", §6).
#
#   scripts/cf-preflight.sh <staging|production> [--bootstrap] [--web|--admin] -- <wrangler args…>
#
# Runs  cloudflare/node_modules/.bin/wrangler --env <env> <args…>  (cwd cloudflare/) only if
# every check passes; otherwise prints ONE line "PREFLIGHT REFUSED: …" and exits 1.
# With --web the target is the storefront's Worker (chopshop-web, cloudflare/web/) instead of the
# API: the same binary runs as
#   wrangler --env <env> --config <repo>/cloudflare/web/wrangler.jsonc <args…>  (cwd cloudflare/web/)
# — the configuration named explicitly, so no wrangler.json found higher up and no
# .wrangler/deploy redirect can replace the file these checks read.
# With --admin the target is the third Worker (chopshop-admin, cloudflare/admin/), checked check for
# check as --web checks the web Worker (its own pinned adminWorkerName, origins.admin, dist and
# configuration; run as wrangler --env <env> --config <repo>/cloudflare/admin/wrangler.jsonc …, cwd
# cloudflare/admin/). --web and --admin together, and --bootstrap with either, are refused.
# --admin ALSO checks the API's side of the admin origin: cloudflare/wrangler.jsonc env.<env>
# must list origins.admin in AUTH_TRUSTED_ORIGINS (Better Auth refuses every admin sign-in
# otherwise). The plain (API) mode requires the same whenever pinned origins.admin is not null.
# origins.admin is null in production until the real domain exists (D7): --admin REFUSES then.
#   1. credentials file ($CHOPSHOP_CF_ENV_FILE, default ~/.config/chopshop/cloudflare.env) is
#      mode 600 and defines CF_ACCOUNT_ID + CLOUDFLARE_API_TOKEN; CF_ACCOUNT_ID == pinned id;
#   2. cloudflare/pinned.<env>.json has the full shape, stripeMode is sandbox (staging) or
#      live (production), production's dispatchTarget is "snapwear", the two Stripe webhook
#      endpoint ids (platform + connect) are we_ ids or null, origins.api / origins.web and
#      r2.publicBaseUrl (when set; null until D95) are bare https:// origins (no path, query or
#      fragment; origins.admin may be null), and webWorkerName / adminWorkerName are not the API's
#      workerName nor each other's;
#   3. `wrangler whoami --json`, run with THAT token, sees exactly one account, and its id ==
#      CF_ACCOUNT_ID == pinned cloudflareAccountId;
#   4. the configuration's account_id — cloudflare/wrangler.jsonc, or with --web
#      cloudflare/web/wrangler.jsonc — (top level, and env.<env> when set) == pinned id;
#   5. unless --bootstrap: no null left in the pinned file (null = resource not created yet; for
#      r2.publicBaseUrl: the public bucket's address does not exist yet, D95), and
#      API (cloudflare/wrangler.jsonc): env.<env> whose name (or wrangler's effective `<top>-<env>`) ==
#      pinned workerName, whose APP_ENV is <env>, whose bindings are EXACTLY DB / PUBLIC_BUCKET /
#      PRIVATE_BUCKET / PRODUCTION_BUCKET / OUTBOX_QUEUE / EMAIL_QUEUE / RENDER_JOBS_QUEUE (+ the
#      three consumers) each on its own pinned resource (every R2 binding in "eu"), one container
#      RenderContainer (./render/Dockerfile, max_instances 1, EU) bound as RENDER_CONTAINER, whose vars.CANONICAL_ORIGINS deep-equals pinned
#      origins (its `admin` key excluded while pinned origins.admin is null), AUTH_BASE_URL == origins.api,
#      AUTH_TRUSTED_ORIGINS == exactly the set {origins.api, origins.web} plus origins.admin when
#      that is not null, SERVICE_NAME == pinned workerName, R2_PRIVATE_BUCKET_NAME
#      == pinned r2.private, R2_JURISDICTION == "eu", DISPATCH_TARGET == pinned dispatchTarget
#      and PUBLIC_OBJECT_BASE_URL == pinned r2.publicBaseUrl (without that section wrangler silently deploys the top-level config);
#      web (--web, cloudflare/web/wrangler.jsonc): env.<env> whose name (or `<top>-<env>`) ==
#      pinned webWorkerName; assets EXACTLY { directory "./dist", binding ASSETS,
#      run_worker_first true, html_handling "none", not_found_handling "none" }; services EXACTLY
#      one entry { binding API, service == pinned workerName (the API of the SAME env),
#      entrypoint Internal }; vars EXACTLY WEB_ORIGIN == pinned origins.web and
#      PUBLIC_OBJECT_BASE_URL == pinned r2.publicBaseUrl; NO other key in env.<env> (only name,
#      account_id, workers_dev, preview_urls, assets, services, vars, and in production routes,
#      see "addresses" below) nor at the top level (only
#      $schema, name, account_id, main, compatibility_date, compatibility_flags, observability,
#      env; wrangler inherits routes, triggers, workers_dev, assets and build into env.<env>) — so
#      no D1, R2, KV, queue, Durable Object, container, secret-store, AI or any other binding, no
#      route but production's custom domain, no cron trigger: the web Worker holds no data and
#      no secret; production's workers_dev and preview_urls are exactly false (absent, wrangler
#      turns workers_dev on when there is no route);
#      and for `deploy`, cloudflare/web/dist/index.html exists (the storefront was built) and
#      dist holds no source map (no *.map file, no sourceMappingURL comment);
#      admin (--admin, cloudflare/admin/wrangler.jsonc): the same, with adminWorkerName, vars
#      EXACTLY ADMIN_ORIGIN == pinned origins.admin and PUBLIC_OBJECT_BASE_URL, the same key lists
#      and services entry, cloudflare/admin/dist, and the API's AUTH_TRUSTED_ORIGINS as above;
#      addresses (CP7-T3; the API, --web and --admin alike, each by its OWN pinned origin:
#      origins.api, origins.web, origins.admin): no `route` key anywhere, no `routes` at the top
#      level (wrangler inherits it into every env section), no `routes` in env.staging; in
#      env.production, when that origin's host ends in .workers.dev (today's placeholder pins)
#      no `routes` either and nothing else changes; when it does NOT, `routes` is EXACTLY
#      [{"pattern": "<that origin's host>", "custom_domain": true}] — one custom domain, no zone
#      route, no path, wildcard, port, upper case, other host or other key; without it the Worker
#      would deploy with no address — that origin carries no port (a custom domain answers on
#      the https port only), its host is not the host of another pinned origin nor of
#      r2.publicBaseUrl (a second Worker deploying the same custom domain would take it from the
#      first), and the API's workers_dev and preview_urls are exactly false (the web and admin
#      Workers' are in production always, above);
#   6. production without --bootstrap (with --web / --admin too: those Workers are part of the same
#      launch): every launch-gate item of docs/SnapWearDocs/LAUNCH_TODO.md
#      (A1–A7, A9–A11, A13–A14, B1–B10 — PLAN §0) is ☑;
#   7. Stripe (with --web / --admin too), via ~/.config/chopshop/stripe.<env>.env (mode 600,
#      STRIPE_SECRET_KEY; REQUIRED unless --bootstrap): the key prefix matches stripeMode
#      (sk_/rk_ + test_ for sandbox, live_ for live), GET /v1/account id == pinned
#      stripeAccountId, and the pinned stripeWebhookEndpointId (when set) exists on that account.
#
# --bootstrap (creating resources before their ids are pinned) allows only whoami, d1, r2 and
# queues, and never --web or --admin: those Workers create no resource. --web and --admin allow only
# deploy (with no argument but --dry-run: what is deployed is the checked file and the checked
# build), whoami, deployments, rollback, tail and versions list|view|deploy — never `secret`: they
# hold none.
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

USAGE='usage: scripts/cf-preflight.sh <staging|production> [--bootstrap] [--web|--admin] -- <wrangler args…>'
[ $# -ge 1 ] || refuse "$USAGE"
ENV_NAME=$1
shift
case $ENV_NAME in
  staging | production) ;;
  *) refuse "unknown environment '$ENV_NAME' — $USAGE" ;;
esac
BOOTSTRAP=0
WEB=0
ADMIN=0
while [ $# -gt 0 ] && [ "$1" != -- ]; do
  case $1 in
    --bootstrap) BOOTSTRAP=1 ;;
    --web) WEB=1 ;;
    --admin) ADMIN=1 ;;
    *) refuse "unexpected argument '$1' before '--' — $USAGE" ;;
  esac
  shift
done
[ "$BOOTSTRAP$WEB" != 11 ] ||
  refuse "--bootstrap with --web is not allowed — the web Worker creates no resource; --bootstrap exists for the API's resources only"
[ "$WEB$ADMIN" != 11 ] ||
  refuse "--web with --admin is not allowed — one Worker per run; scripts/cf-deploy.sh runs them one after the other"
[ "$BOOTSTRAP$ADMIN" != 11 ] ||
  refuse "--bootstrap with --admin is not allowed — the admin Worker creates no resource; --bootstrap exists for the API's resources only"
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
# --web / --admin: these Workers hold no data and no secret, and a deploy must be the checked
# configuration with the checked build — no --var, --assets, --routes, script path or other
# override of what was checked. Only these subcommands may run with them.
EDGE=
[ "$WEB" = 0 ] || EDGE=web
[ "$ADMIN" = 0 ] || EDGE=admin
if [ -n "$EDGE" ]; then
  case $1 in
    deploy)
      case "$#:${2:-}" in
        1: | 2:--dry-run) ;;
        *) refuse "with --$EDGE, deploy takes no argument but --dry-run — the $EDGE Worker is deployed from cloudflare/$EDGE/wrangler.jsonc and cloudflare/$EDGE/dist exactly as checked" ;;
      esac ;;
    whoami | deployments | rollback | tail) ;;
    versions)
      case ${2:-} in
        list | view | deploy) ;;
        *) refuse "wrangler 'versions ${2:-}' is not allowed with --$EDGE (only versions list, view, deploy) — the $EDGE Worker holds no secret and uploads only through deploy" ;;
      esac ;;
    *) refuse "wrangler subcommand '$1' is not allowed with --$EDGE (only deploy, whoami, deployments, rollback, tail, versions list|view|deploy) — the $EDGE Worker holds no data and no secret" ;;
  esac
fi

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
CF_DIR=$ROOT/cloudflare
WEB_DIR=$CF_DIR/web
ADMIN_DIR=$CF_DIR/admin
PINNED=$CF_DIR/pinned.$ENV_NAME.json
if [ "$WEB" = 1 ]; then
  JSONC=$WEB_DIR/wrangler.jsonc
  RUN_DIR=$WEB_DIR
elif [ "$ADMIN" = 1 ]; then
  JSONC=$ADMIN_DIR/wrangler.jsonc
  RUN_DIR=$ADMIN_DIR
else
  JSONC=$CF_DIR/wrangler.jsonc
  RUN_DIR=$CF_DIR
fi
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
import json, os, re, sys

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
    # The storefront's Worker (cloudflare/web/wrangler.jsonc env.<env>.name), deployed with --web.
    "webWorkerName": str,
    # The admin's Worker (cloudflare/admin/wrangler.jsonc env.<env>.name), deployed with --admin.
    "adminWorkerName": str,
    # origins.admin: null in production until its real domain exists (D7); --admin refuses then.
    "origins": {"api": str, "web": str, "admin": str},
    "d1": {"name": str, "id": str},
    # publicBaseUrl: the origin the PUBLIC bucket is read from (D78) — PUBLIC_OBJECT_BASE_URL of
    # both Workers. Null while that address does not exist (D95: staging's r2.dev address is
    # switched off; production's comes with the real domain at CP7), which refuses every deploy.
    "r2": {"public": str, "private": str, "production": str, "publicBaseUrl": str},
    "queues": {"outbox": str, "email": str, "renderJobs": str},
    "stripeAccountId": str, "stripeMode": str, "stripeWebhookEndpointId": str,
    # The CONNECT endpoint (connect=true): Stripe delivers connected-account events (account.updated)
    # only on an endpoint created with connect=true, and platform events (payments, refunds,
    # disputes) only on one created without it — two endpoints, two signing secrets.
    "stripeConnectWebhookEndpointId": str, "dispatchTarget": str,
}
NULLABLE = {"d1.id", "r2.publicBaseUrl", "origins.admin", "stripeAccountId", "stripeWebhookEndpointId", "stripeConnectWebhookEndpointId"}  # null = not created yet
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

def cmd_pinned(path, env, bootstrap, admin="0"):
    p = load_json(path, path)
    nulls = []
    walk(p, SHAPE, "", nulls, path)
    if not re.fullmatch(r"[0-9a-f]{32}", p["cloudflareAccountId"]):
        refuse(f"{path}: cloudflareAccountId is not a 32-hex account id")
    for key, pat in (("stripeAccountId", r"acct_[A-Za-z0-9]+"), ("stripeWebhookEndpointId", r"we_[A-Za-z0-9]+"), ("stripeConnectWebhookEndpointId", r"we_[A-Za-z0-9]+")):
        if p[key] is not None and not re.fullmatch(pat, p[key]):
            refuse(f"{path}: {key} {p[key]!r} is not a Stripe {pat.split('_')[0]}_ id")
    for key in ("api", "web", "admin"):
        if p["origins"][key] is not None and not re.fullmatch(ORIGIN, p["origins"][key]):
            refuse(f"{path}: origins.{key} {p['origins'][key]!r} is not a bare https:// origin (lowercase host, optional port; no path, query or fragment)")
    base = p["r2"]["publicBaseUrl"]
    if base is not None and not re.fullmatch(ORIGIN, base):
        refuse(f"{path}: r2.publicBaseUrl {base!r} is not a bare https:// origin (lowercase host, optional port; no path, query or fragment)")
    if p["webWorkerName"] == p["workerName"]:
        refuse(f"{path}: webWorkerName {p['webWorkerName']!r} is the API's workerName - a web deploy would replace the API Worker")
    if p["adminWorkerName"] in (p["workerName"], p["webWorkerName"]):
        refuse(f"{path}: adminWorkerName {p['adminWorkerName']!r} is the API's or the web Worker's name - an admin deploy would replace that Worker")
    want_mode = "sandbox" if env == "staging" else "live"
    if p["stripeMode"] != want_mode:
        refuse(f"{path}: stripeMode is {p['stripeMode']!r}, {env} requires {want_mode!r}")
    if env == "production" and p["dispatchTarget"] != "snapwear":
        refuse(f"{path}: production dispatchTarget is {p['dispatchTarget']!r} - only 'snapwear' may be deployed to production")
    # origins.admin is null until the real domain exists: that blocks ONLY the admin Worker's
    # deploy (its own line, not the generic "create it under --bootstrap"), never the API's or the web Worker's.
    if "origins.admin" in nulls:
        nulls.remove("origins.admin")
        if admin == "1":
            refuse(f"{path}: origins.admin is null - {env} has no admin domain yet (D7), so the admin Worker is not deployed there; pin origins.admin together with the admin wrangler.jsonc ADMIN_ORIGIN and the API's AUTH_TRUSTED_ORIGINS")
    if nulls and bootstrap != "1":
        refuse(f"{path} still has null (not yet created) values: {', '.join(nulls)} - create them under --bootstrap, pin the ids, then deploy")
    print("|".join([p["cloudflareAccountId"], p["stripeAccountId"] or "", p["stripeMode"],
                    p["stripeWebhookEndpointId"] or "", p["stripeConnectWebhookEndpointId"] or "", ", ".join(nulls)]))

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

def load_jsonc(jsonc):
    try:
        with open(jsonc) as f:
            return json.loads(jsonc_to_json(f.read()))
    except Exception as e:
        refuse(f"cannot parse {jsonc}: {e}")

def check_account(cfg, jsonc, env, pid):
    """Check 4: the configuration targets the pinned account; returns env.<env> (or None)."""
    if cfg.get("account_id") != pid:
        refuse(f"{jsonc} account_id is {cfg.get('account_id')!r}, pinned cloudflareAccountId is {pid}")
    e = (cfg.get("env") or {}).get(env)
    if e is not None and "account_id" in e and e["account_id"] != pid:
        refuse(f"{jsonc} env.{env}.account_id is {e['account_id']!r}, pinned cloudflareAccountId is {pid}")
    return e

def check_trusted(jsonc, env, v, origins):
    """Better Auth trusts exactly the pinned api and web origins, plus the admin origin once pinned."""
    want = [origins["api"], origins["web"]] + ([origins["admin"]] if origins["admin"] is not None else [])
    trusted = v.get("AUTH_TRUSTED_ORIGINS")
    if not isinstance(trusted, str) or {o.strip() for o in trusted.split(",")} != set(want):
        refuse(f"{jsonc} env.{env}.vars.AUTH_TRUSTED_ORIGINS is {trusted!r}, it must be exactly the pinned origins {','.join(want)}")

def cmd_apitrust(jsonc, pinned_path, env):
    """For --admin: the API's own configuration trusts the admin origin (the same check as the API's deploy)."""
    cfg = load_jsonc(jsonc)
    p = load_json(pinned_path, pinned_path)
    e = check_account(cfg, jsonc, env, p["cloudflareAccountId"])
    if not isinstance(e, dict):
        refuse(f"{jsonc} has no env.{env} section - the admin origin cannot be shown to be in the API's AUTH_TRUSTED_ORIGINS")
    check_trusted(jsonc, env, e.get("vars") or {}, p["origins"])

def cmd_jsonc(jsonc, pinned_path, env, bootstrap):
    cfg = load_jsonc(jsonc)
    p = load_json(pinned_path, pinned_path)
    e = check_account(cfg, jsonc, env, p["cloudflareAccountId"])
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
    want_canonical = dict(origins)
    if want_canonical["admin"] is None:  # no admin host pinned yet (production before its domain)
        del want_canonical["admin"]
    if v.get("CANONICAL_ORIGINS") != want_canonical:
        refuse(f"{jsonc} env.{env}.vars.CANONICAL_ORIGINS is {json.dumps(v.get('CANONICAL_ORIGINS'), sort_keys=True)}, pinned origins are {json.dumps(want_canonical, sort_keys=True)}")
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
    # Public objects' addresses are built from this var (D78); the web Worker holds the same one.
    if v.get("PUBLIC_OBJECT_BASE_URL") != p["r2"]["publicBaseUrl"]:
        refuse(f"{jsonc} env.{env}.vars.PUBLIC_OBJECT_BASE_URL is {v.get('PUBLIC_OBJECT_BASE_URL')!r}, pinned r2.publicBaseUrl is {p['r2']['publicBaseUrl']!r}")
    check_trusted(jsonc, env, v, origins)
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
    crons = (e.get("triggers") or {}).get("crons")
    if crons != ["*/15 * * * *"]:
        refuse(f"{jsonc} env.{env}.triggers.crons is {crons!r}, expected exactly ['*/15 * * * *'] (the sweeper/reconciliation schedule the 30-min alert SLA depends on)")
    consumers = sorted(item.get("queue") for item in (q.get("consumers") or []))
    if consumers != sorted(want_q.values()):
        refuse(f"{jsonc} env.{env} queue consumers are {consumers}, expected exactly the pinned {sorted(want_q.values())}")
    # The API's address (CP7-T3). On its custom domain it has no other: no workers.dev, no
    # preview URL, written out as for the web and admin Workers.
    if check_route(jsonc, cfg, e, env, "api", p, pinned_path):
        for key in ("workers_dev", "preview_urls"):
            if e.get(key) is not False:
                refuse(f"{jsonc} env.production.{key} is {canon(e.get(key))}, production on a custom domain requires false (the API answers on its pinned origin only, nothing of it on workers.dev)")

# The web and admin Workers (cloudflare/web/wrangler.jsonc, cloudflare/admin/wrangler.jsonc) hold no
# data, no secret, no route and no trigger: these are the ONLY keys their configurations may have. Anything else — any binding kind wrangler
# knows today or adds later, a route, a cron trigger, a build command — is refused until the
# preflight is extended for it. The top level counts too: wrangler inherits routes, triggers,
# workers_dev, assets and build from it into every env section. The one route there is:
# env.production.routes, the custom domain of the pinned origin (CP7-T3, check_route).
WEB_TOP_KEYS = {"$schema", "name", "account_id", "main", "compatibility_date", "compatibility_flags", "observability", "env"}
WEB_ENV_KEYS = {"name", "account_id", "workers_dev", "preview_urls", "assets", "services", "vars"}
WEB_ASSETS = {"directory": "./dist", "binding": "ASSETS", "run_worker_first": True,
              "html_handling": "none", "not_found_handling": "none"}

def canon(value):
    """Exact JSON equality: key order is free, but true is not 1 and "1" is not 1."""
    return json.dumps(value, sort_keys=True)

def check_route(jsonc, cfg, e, env, kind, p, pinned_path):
    """The Worker's address (CP7-T3), by its own pinned origin (origins.<kind>). Returns True when
    env.production carries that origin's custom domain, False when the Worker takes no route
    (staging, or a pinned workers.dev host: exactly as before)."""
    for key in ("routes", "route"):
        if key in cfg:
            refuse(f"{jsonc} top level has {key} - wrangler inherits it into every env section; the only route allowed is env.production.routes, the custom domain of the pinned origin")
    if "route" in e:
        refuse(f"{jsonc} env.{env}.route is {canon(e['route'])} - the only route allowed is env.production.routes, the custom domain of the pinned origin")
    origin = p["origins"][kind]
    host = origin[len("https://"):]  # check 2: a bare https origin, so this is its host (a port as written)
    if env != "production" or host.split(":")[0].endswith(".workers.dev"):
        if "routes" in e:
            why = "staging takes no route" if env == "staging" else f"pinned origins.{kind} {origin!r} is a workers.dev host, so the {kind} Worker takes no route"
            refuse(f"{jsonc} env.{env}.routes is {canon(e['routes'])} - {why} (a route is only the custom domain of a pinned production origin that is not on workers.dev)")
        return False
    if ":" in host:
        refuse(f"{pinned_path}: origins.{kind} {origin!r} has a port - its Worker is reached through a custom domain, which answers on the https port only; pin the origin without one")
    others = {f"origins.{k}": p["origins"][k] for k in ("api", "web", "admin") if k != kind}
    others["r2.publicBaseUrl"] = p["r2"]["publicBaseUrl"]
    for key, other in others.items():
        if other is not None and other[len("https://"):].split(":")[0] == host:
            refuse(f"{pinned_path}: origins.{kind} {origin!r} has the host of {key} {other!r} - each production Worker's custom domain is a host of its own (wrangler, run without a terminal, moves a custom domain that another Worker holds to the one it deploys)")
    want = [{"pattern": host, "custom_domain": True}]
    if canon(e.get("routes")) != canon(want):
        refuse(f"{jsonc} env.production.routes is {canon(e.get('routes'))}, expected exactly {canon(want)} - pinned origins.{kind} {origin!r} is not a workers.dev host, so the {kind} Worker is reached only through that custom domain (without it, it deploys with no address)")
    return True

def check_edge(kind, jsonc, pinned_path, env):
    """kind is "web" or "admin": the same checks, bound to that Worker's pinned name, origin and var."""
    cfg = load_jsonc(jsonc)
    p = load_json(pinned_path, pinned_path)
    name_key, origin_var = kind + "WorkerName", kind.upper() + "_ORIGIN"
    e = check_account(cfg, jsonc, env, p["cloudflareAccountId"])
    if not isinstance(e, dict):
        refuse(f"{jsonc} has no env.{env} section - wrangler would silently deploy the top-level config")
    extra = sorted(set(cfg) - WEB_TOP_KEYS)
    if extra:
        refuse(f"{jsonc} top level has {', '.join(extra)} - it may only hold {', '.join(sorted(WEB_TOP_KEYS))} (wrangler inherits routes, triggers, workers_dev, assets and build into env.{env}; the {kind} Worker holds no data, no secret, no route and no trigger)")
    # Production may hold routes (check_route below decides which); staging never.
    env_keys = WEB_ENV_KEYS | ({"routes"} if env == "production" else set())
    extra = sorted(set(e) - env_keys)
    if extra:
        holds = "no data, no secret, no route and no trigger" if env == "staging" else "no data, no secret, no trigger and no route but its pinned custom domain"
        refuse(f"{jsonc} env.{env} has {', '.join(extra)} - the {kind} Worker holds {holds}: env.{env} may only hold {', '.join(sorted(env_keys))}")
    name = e.get("name", f"{cfg.get('name')}-{env}")
    if name != p[name_key]:
        inherited = "" if "name" in e else " (wrangler's effective name: top-level name + '-" + env + "')"
        refuse(f"{jsonc} env.{env}.name is {name!r}{inherited}, pinned {name_key} is {p[name_key]!r}")
    if canon(e.get("assets")) != canon(WEB_ASSETS):
        refuse(f"{jsonc} env.{env}.assets is {canon(e.get('assets'))}, expected exactly {canon(WEB_ASSETS)}")
    # The API of the SAME environment, through the entrypoint that carries fetchForShop (D77).
    want_services = [{"binding": "API", "service": p["workerName"], "entrypoint": "Internal"}]
    if canon(e.get("services")) != canon(want_services):
        refuse(f"{jsonc} env.{env}.services is {canon(e.get('services'))}, expected exactly {canon(want_services)} (pinned workerName, entrypoint Internal)")
    want_vars = {origin_var: p["origins"][kind], "PUBLIC_OBJECT_BASE_URL": p["r2"]["publicBaseUrl"]}
    v = e.get("vars")
    if not isinstance(v, dict) or set(v) != set(want_vars):
        refuse(f"{jsonc} env.{env}.vars are {sorted(v) if isinstance(v, dict) else canon(v)}, expected exactly {sorted(want_vars)}")
    if v[origin_var] != want_vars[origin_var]:
        refuse(f"{jsonc} env.{env}.vars.{origin_var} is {v[origin_var]!r}, pinned origins.{kind} is {want_vars[origin_var]!r}")
    if v["PUBLIC_OBJECT_BASE_URL"] != want_vars["PUBLIC_OBJECT_BASE_URL"]:
        refuse(f"{jsonc} env.{env}.vars.PUBLIC_OBJECT_BASE_URL is {v['PUBLIC_OBJECT_BASE_URL']!r}, pinned r2.publicBaseUrl is {want_vars['PUBLIC_OBJECT_BASE_URL']!r}")
    if env == "production":
        # Absent is not off: without a route wrangler turns workers_dev on.
        for key in ("workers_dev", "preview_urls"):
            if e.get(key) is not False:
                refuse(f"{jsonc} env.production.{key} is {canon(e.get(key))}, production requires false (nothing of the production {kind} Worker on workers.dev; absent, wrangler turns workers_dev on when there is no route)")
    check_route(jsonc, cfg, e, env, kind, p, pinned_path)
    print(p[name_key])

def cmd_webjsonc(jsonc, pinned_path, env):
    check_edge("web", jsonc, pinned_path, env)

def cmd_adminjsonc(jsonc, pinned_path, env):
    check_edge("admin", jsonc, pinned_path, env)

def cmd_dist(dist, what="the storefront", builder="check-storefront-build.mjs"):
    """For `deploy --web` / `--admin`: the build exists, and ships no source map."""
    if not os.path.isfile(os.path.join(dist, "index.html")):
        refuse(f"{dist}/index.html not found - {what} is not built (node {builder}; scripts/cf-deploy.sh builds it)")
    for d, dirs, files in os.walk(dist):
        dirs.sort()
        for f in sorted(files):
            full = os.path.join(d, f)
            rel = os.path.relpath(full, dist)
            if f.endswith(".map"):
                refuse(f"{dist} holds a source map: {rel} - {what} ships none")
            if f.endswith((".js", ".mjs", ".css", ".html")):
                with open(full, "rb") as fh:
                    # Anywhere on a line (a comment may follow code), and with an address behind the
                    # "=": the bare words inside a string of the code are no source map.
                    if re.search(rb"(?://|/\*)[#@][ \t]*sourceMappingURL=[ \t]*[^\s\"'`$\\]", fh.read()):
                        refuse(f"{dist} holds a source map: {rel} carries a sourceMappingURL comment - {what} ships none")

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

{"pinned": cmd_pinned, "whoami": cmd_whoami, "jsonc": cmd_jsonc, "webjsonc": cmd_webjsonc,
 "adminjsonc": cmd_adminjsonc, "apitrust": cmd_apitrust, "dist": cmd_dist, "stripe": cmd_stripe, "webhook": cmd_webhook, "launch": cmd_launch}[sys.argv[1]](*sys.argv[2:])
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
out=$(python3 -c "$PY" pinned "$PINNED" "$ENV_NAME" "$BOOTSTRAP" "$ADMIN") || refuse "${out:-python3 helper failed on $PINNED}"
IFS='|' read -r PINNED_ID STRIPE_ACCT STRIPE_MODE WEBHOOK_ID CONNECT_WEBHOOK_ID NULLS <<<"$out"
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
if [ "$WEB" = 1 ]; then
  out=$(python3 -c "$PY" webjsonc "$JSONC" "$PINNED" "$ENV_NAME") || refuse "${out:-python3 helper failed on $JSONC}"
  WEB_WORKER=$out
  if [ "$1" = deploy ]; then
    out=$(python3 -c "$PY" dist "$WEB_DIR/dist" "the storefront" "cloudflare/web/check-storefront-build.mjs") || refuse "${out:-python3 helper failed on $WEB_DIR/dist}"
  fi
elif [ "$ADMIN" = 1 ]; then
  out=$(python3 -c "$PY" adminjsonc "$JSONC" "$PINNED" "$ENV_NAME") || refuse "${out:-python3 helper failed on $JSONC}"
  ADMIN_WORKER=$out
  # The API's side of the admin origin: without it in AUTH_TRUSTED_ORIGINS every admin sign-in is refused.
  out=$(python3 -c "$PY" apitrust "$CF_DIR/wrangler.jsonc" "$PINNED" "$ENV_NAME") || refuse "${out:-python3 helper failed on $CF_DIR/wrangler.jsonc}"
  if [ "$1" = deploy ]; then
    out=$(python3 -c "$PY" dist "$ADMIN_DIR/dist" "the admin" "cloudflare/admin/check-admin-build.mjs") || refuse "${out:-python3 helper failed on $ADMIN_DIR/dist}"
  fi
else
  out=$(python3 -c "$PY" jsonc "$JSONC" "$PINNED" "$ENV_NAME" "$BOOTSTRAP") || refuse "${out:-python3 helper failed on $JSONC}"
fi

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
  if [ -n "$CONNECT_WEBHOOK_ID" ]; then
    code=$(stripe_get "/v1/webhook_endpoints/$CONNECT_WEBHOOK_ID" "$TMP/webhook.json") ||
      refuse "Stripe GET /v1/webhook_endpoints failed: $(tail -n 1 "$TMP/stripe.err")"
    out=$(python3 -c "$PY" webhook "$TMP/webhook.json" "$code" "$CONNECT_WEBHOOK_ID" "$STRIPE_FILE") || refuse "${out:-python3 helper failed on the webhook response}"
    note "pinned Stripe CONNECT webhook endpoint $CONNECT_WEBHOOK_ID exists: $out"
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
elif [ "$WEB" = 1 ]; then
  note "OK — web Worker $WEB_WORKER: wrangler --env $ENV_NAME --config cloudflare/web/wrangler.jsonc $* (cwd cloudflare/web)"
elif [ "$ADMIN" = 1 ]; then
  note "OK — admin Worker $ADMIN_WORKER: wrangler --env $ENV_NAME --config cloudflare/admin/wrangler.jsonc $* (cwd cloudflare/admin)"
else
  note "OK — wrangler --env $ENV_NAME $*"
fi
cd "$RUN_DIR"
export CLOUDFLARE_API_TOKEN=$TOKEN CLOUDFLARE_ACCOUNT_ID=$PINNED_ID
if [ "$WEB" = 1 ] || [ "$ADMIN" = 1 ]; then
  exec "$WRANGLER" --env "$ENV_NAME" --config "$JSONC" "$@"
fi
exec "$WRANGLER" --env "$ENV_NAME" "$@"
