#!/usr/bin/env bash
# CP13 A4 — the affiliate program's staging smoke, end to end, against the pinned STAGING origins
# (cloudflare/pinned.staging.json). Every step prints the full URL and the ids; the script exits
# non-zero on the FIRST mismatch.
#
#   apply (storefront route, web Worker) → approve (admin) → a `?ref=ANNA10` landing through the web
#   Worker (the click count moves) → a purchase with refCode ANNA10 (seed-staging-slice.mjs
#   --purchase --ref-code) → the order's affiliate member (admin API) → the accrual in the ledger →
#   a partial refund (seed --refund) → the reversal in the ledger → the hold checked against the
#   ledger (held = the commission of the orders inside their 14 days) → payable: a matured accrual
#   of a run 14+ days old, else a +10 kr adjustment as the fallback → a payout request AS THE AFFILIATE (her seeded password) →
#   marked paid by the admin → the payout row in the ledger → the email_deliveries rows of the
#   affiliate kinds since the run started (wrangler d1, read-only; no mail leaves staging).
#
# Prerequisite, once per slice tenant:
#   node scripts/cf-port/seed-staging-slice.mjs --tenant <slice tenant> --affiliate
# (the add-on ON, the affiliate ANNA10 with CHOPSHOP_AFFILIATE_PASSWORD, one pending application).
#
# Usage (from the repository root):
#   CHOPSHOP_API_URL=https://chopshop-api-stg.kent-ee2.workers.dev \
#   CHOPSHOP_PLATFORM_EMAIL=… CHOPSHOP_PLATFORM_PASSWORD=… \
#   CHOPSHOP_AFFILIATE_PASSWORD=… STRIPE_SECRET_KEY=sk_test_… [CHOPSHOP_SLICE_ADMIN_PASSWORD=…] \
#   bash cloudflare/scripts/stg-affiliate-smoke.sh --tenant <slice tenant>
#
# Credentials come only from the environment; none is printed or written to disk (the cookie jars
# live in a temp directory removed on exit). Writes to staging: one application, one approved
# affiliate (code SMK<run>), one order + one partial refund (Stripe TEST mode, through the seed
# script), one +10 kr adjustment unless a matured accrual is payable, one payout marked paid. A payout request left open by an earlier
# failed run is voided first (reason names the smoke).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PINNED="$ROOT/cloudflare/pinned.staging.json"
SEED="$ROOT/scripts/cf-port/seed-staging-slice.mjs"

TENANT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tenant) TENANT="${2:-}"; shift 2 ;;
    *) echo "unknown argument $1 (usage: --tenant <slice tenant>)"; exit 2 ;;
  esac
done
[ -n "$TENANT" ] || { echo "usage: $0 --tenant <slice tenant>"; exit 2; }
case "$TENANT" in *[!a-z0-9-]*) echo "tenant id $TENANT is not a tenant id"; exit 2 ;; esac

for name in CHOPSHOP_PLATFORM_EMAIL CHOPSHOP_PLATFORM_PASSWORD CHOPSHOP_AFFILIATE_PASSWORD STRIPE_SECRET_KEY; do
  [ -n "${!name:-}" ] || { echo "SMOKE REFUSED: $name is not set"; exit 2; }
done

pin() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))' "$PINNED" "$1"; }
API="$(pin "d['origins']['api']")"
WEB="$(pin "d['origins']['web']")"
ADMIN="$(pin "d['origins']['admin']")"
D1="$(pin "d['d1']['name']")"
export CHOPSHOP_API_URL="${CHOPSHOP_API_URL:-$API}"
[ "$CHOPSHOP_API_URL" = "$API" ] || { echo "SMOKE REFUSED: CHOPSHOP_API_URL is not the pinned staging api $API"; exit 2; }

CODE_ANNA="ANNA10"
ANNA_EMAIL="anna-affiliate+${TENANT}@example.com"
RUN="$(date +%s)"
RUN_START_MS=$((RUN * 1000))
RUN_ISO="$(python3 -c 'import datetime,sys; print(datetime.datetime.fromtimestamp(int(sys.argv[1]), datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S"))' "$RUN")"
APPLICANT_EMAIL="smoke-applicant+${TENANT}-${RUN}@example.com"
NEW_CODE="SMK${RUN: -6}"

TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT
JAR_P="$TMPD/platform.jar"
JAR_A="$TMPD/affiliate.jar"
CODE=""
BODY=""

step() { printf '\n▸ %s\n' "$*"; }
show() { printf '      %s\n' "$*"; }
pass() { printf 'PASS  %s\n' "$*"; }
fail() {
  printf 'FAIL  %s\n' "$*"
  if [ -n "$BODY" ] && [ -f "$BODY" ]; then printf '      body: %s\n' "$(head -c 400 "$BODY")"; fi
  exit 1
}

# call <name> <METHOD> <url> [curl args…] — the answer lands in $BODY, the status in $CODE.
call() {
  local name="$1" method="$2" url="$3"
  shift 3
  BODY="$TMPD/$name.json"
  printf '  → %s %s\n' "$method" "$url"
  CODE="$(curl -sS -o "$BODY" -w '%{http_code}' -X "$method" "$url" "$@")" || CODE="000"
}
# need <label> <codes…>
need() {
  local label="$1"
  shift
  for allowed in "$@"; do
    if [ "$CODE" = "$allowed" ]; then pass "$label (HTTP $CODE)"; return 0; fi
  done
  fail "$label: HTTP $CODE (expected $*)"
}
# jv <python expression over d = the last answer>
jv() {
  python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
v = eval(sys.argv[2])
print("" if v is None else (json.dumps(v) if isinstance(v, (dict, list, bool)) else v))
' "$BODY" "$1" 2>/dev/null
}
# same <label> <expected> <actual>
same() { [ "$2" = "$3" ] && pass "$1 ($3)" || fail "$1: expected $2, got $3"; }
# body k v k v … — a JSON object of strings (values from this script, never a secret)
body() { python3 -c 'import json,sys; a=sys.argv[1:]; print(json.dumps(dict(zip(a[::2], a[1::2]))))' "$@"; }

API_H=(-H "origin: $API" -H "content-type: application/json")
AS_PLATFORM=(-b "$JAR_P" -c "$JAR_P" "${API_H[@]}")
AS_SHOP=("${AS_PLATFORM[@]}" -H "x-shop-id: $TENANT")
AS_ANNA=(-b "$JAR_A" -c "$JAR_A" "${API_H[@]}" -H "x-shop-id: $TENANT")
WEB_H=(-H "origin: $WEB" -H "content-type: application/json")

# ── 0. preflight ────────────────────────────────────────────────────────────
step "preflight (tenant $TENANT, run $RUN)"
show "api   $API"
show "web   $WEB (storefront routes: $WEB/_api/$TENANT/v1/…)"
show "admin $ADMIN"
call health GET "$API/health"
need "/health" 200
same "environment" staging "$(jv "d.get('environment')")"
call ready GET "$API/ready"
need "/ready" 200
MIGRATION="$(jv "d.get('migration')")"
[ "${MIGRATION:0:4}" \> "0058" ] || fail "/ready is on migration $MIGRATION; the CP13 Worker needs 0059"
pass "migration $MIGRATION"

# ── 1. sessions ─────────────────────────────────────────────────────────────
step "platform sign-in + acting-as"
SIGNIN="$(EMAIL="$CHOPSHOP_PLATFORM_EMAIL" PASSWORD="$CHOPSHOP_PLATFORM_PASSWORD" python3 -c \
  'import json,os; print(json.dumps({"email": os.environ["EMAIL"], "password": os.environ["PASSWORD"]}))')"
call signin POST "$API/api/auth/sign-in/email" -c "$JAR_P" "${API_H[@]}" -d "$SIGNIN"
need "platform sign-in" 200
call acting POST "$API/v1/platform/tenants/$TENANT/acting-as" "${AS_PLATFORM[@]}" -d "$(body reason "CP13 affiliate smoke $RUN")"
need "acting-as" 201
show "grant until $(jv "d.get('expiresAt')")"

step "the seeded affiliate $CODE_ANNA (seed-staging-slice.mjs --affiliate)"
ANNA_ID=""
CURSOR=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  QUERY="status=active&limit=100${CURSOR:+&cursor=$CURSOR}"
  call affiliates GET "$API/v1/admin/affiliates?$QUERY" "${AS_SHOP[@]}"
  need "list affiliates" 200
  ANNA_ID="$(jv "next((a['affiliateId'] for a in d['affiliates'] if a['code'] == '$CODE_ANNA'), None)")"
  CURSOR="$(jv "d.get('nextCursor')")"
  [ -n "$ANNA_ID" ] || [ -z "$CURSOR" ] || continue
  break
done
[ -n "$ANNA_ID" ] || fail "no active affiliate $CODE_ANNA in $TENANT: run seed-staging-slice.mjs --tenant $TENANT --affiliate"
show "affiliateId $ANNA_ID — $API/v1/admin/affiliates/$ANNA_ID"
SIGNIN_A="$(EMAIL="$ANNA_EMAIL" PASSWORD="$CHOPSHOP_AFFILIATE_PASSWORD" python3 -c \
  'import json,os; print(json.dumps({"email": os.environ["EMAIL"], "password": os.environ["PASSWORD"]}))')"
call signin_a POST "$API/api/auth/sign-in/email" -c "$JAR_A" "${API_H[@]}" -d "$SIGNIN_A"
need "affiliate sign-in ($ANNA_EMAIL)" 200
call me GET "$API/v1/affiliate/me" "${AS_ANNA[@]}"
need "GET /v1/affiliate/me as the affiliate" 200
same "portal code" "$CODE_ANNA" "$(jv "d['affiliate']['code']")"
same "portal affiliateId" "$ANNA_ID" "$(jv "d['affiliate']['affiliateId']")"

# ── 2. apply → approve ──────────────────────────────────────────────────────
step "apply (storefront route on the web Worker)"
call terms GET "$WEB/_api/$TENANT/v1/affiliate-terms" "${WEB_H[@]}"
need "GET /v1/affiliate-terms" 200
TERMS_VERSION="$(jv "d['terms']['version']")"
show "terms $TERMS_VERSION sha256 $(jv "d['terms']['sha256'][:12]")…"
APPLY="$(python3 -c 'import json,sys; print(json.dumps({"email": sys.argv[1], "name": "Smoke Sökande", "preferredLang": "sv", "promotionMethod": "blog", "termsAccepted": True, "termsVersion": sys.argv[2]}))' "$APPLICANT_EMAIL" "$TERMS_VERSION")"
call apply POST "$WEB/_api/$TENANT/v1/affiliate-applications" "${WEB_H[@]}" -d "$APPLY"
need "POST /v1/affiliate-applications ($APPLICANT_EMAIL)" 202

step "approve (admin queue)"
call queue GET "$API/v1/admin/affiliates/applications?status=pending&limit=100" "${AS_SHOP[@]}"
need "pending applications" 200
APPLICATION_ID="$(jv "next((a['applicationId'] for a in d['applications'] if a['email'] == '$APPLICANT_EMAIL'), None)")"
[ -n "$APPLICATION_ID" ] || fail "the application from $APPLICANT_EMAIL is not in the pending queue"
show "applicationId $APPLICATION_ID — $API/v1/admin/affiliates/applications/$APPLICATION_ID"
call approve POST "$API/v1/admin/affiliates/applications/$APPLICATION_ID/approve" "${AS_SHOP[@]}" -d "$(body code "$NEW_CODE")"
need "approve" 201
same "application status" approved "$(jv "d['application']['status']")"
same "new affiliate's code" "$NEW_CODE" "$(jv "d['affiliate']['code']")"
show "new affiliateId $(jv "d['affiliate']['affiliateId']") (invited $(jv "d.get('invited')"), mailConfigured $(jv "d.get('mailConfigured')"))"

# ── 3. the ?ref= landing ────────────────────────────────────────────────────
step "a ?ref=$CODE_ANNA landing through the web Worker"
# clicks — sets CLICKS to the sum of the affiliate's clicksByDay (admin detail).
clicks() {
  call detail GET "$API/v1/admin/affiliates/$ANNA_ID" "${AS_SHOP[@]}" >/dev/null
  [ "$CODE" = 200 ] || fail "affiliate detail: HTTP $CODE"
  CLICKS="$(jv "sum(day['count'] for day in d['affiliate']['clicksByDay'])")"
  [[ "$CLICKS" =~ ^[0-9]+$ ]] || fail "clicksByDay is not a list of counts"
}
clicks
BEFORE="$CLICKS"
show "landings counted before: $BEFORE"
# -L: a forward keeps ?ref= on its Location (web seo.ts), and the page it leads to counts once.
call landing GET "$WEB/$TENANT/?ref=$CODE_ANNA" -L -H "accept: text/html"
need "GET $WEB/$TENANT/?ref=$CODE_ANNA" 200
AFTER="$BEFORE"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  clicks
  AFTER="$CLICKS"
  [ "$AFTER" -gt "$BEFORE" ] && break
  sleep 2
done
[ "$AFTER" -gt "$BEFORE" ] || fail "the landing was not counted ($BEFORE → $AFTER)"
pass "landing counted ($BEFORE → $AFTER) — $API/v1/admin/affiliates/$ANNA_ID clicksByDay"

# ── 4. purchase with the link code ──────────────────────────────────────────
step "purchase with refCode $CODE_ANNA (seed-staging-slice.mjs --purchase --ref-code)"
show "node $SEED --tenant $TENANT --purchase --ref-code $CODE_ANNA"
node "$SEED" --tenant "$TENANT" --purchase --ref-code "$CODE_ANNA" | tee "$TMPD/purchase.log" || fail "the seed's purchase failed"
ORDER_ID="$(grep -Eo '^  order +[0-9a-f-]{36}' "$TMPD/purchase.log" | tail -1 | awk '{print $2}')"
[ -n "$ORDER_ID" ] || fail "the seed printed no order id (the receipt may have been handed out already: re-run)"
show "orderId $ORDER_ID"

step "the order's affiliate member"
call order GET "$API/v1/admin/orders/$ORDER_ID" "${AS_SHOP[@]}"
need "GET /v1/admin/orders/$ORDER_ID" 200
same "order.affiliate.code" "$CODE_ANNA" "$(jv "d['order']['affiliate']['code']")"
same "order.affiliate.attribution" link "$(jv "d['order']['affiliate']['attribution']")"
same "order.affiliate.selfReferral" false "$(jv "d['order']['affiliate']['selfReferral']")"
ORDER_NUMBER="$(jv "d['order']['orderNumber']")"
CHARGED="$(jv "d['order']['money']['chargedMinor']")"
COMMISSION="$(jv "d['order']['affiliate']['affiliateCommissionMinor']")"
[ "${COMMISSION:-0}" -gt 0 ] || fail "affiliateCommissionMinor is $COMMISSION"
show "order $ORDER_NUMBER charged $CHARGED öre, commission $COMMISSION öre ($(jv "d['order']['affiliate']['ledgerState']"))"

ledger() {
  call ledger GET "$API/v1/admin/affiliates/$ANNA_ID/ledger?limit=100" "${AS_SHOP[@]}" >/dev/null
  [ "$CODE" = 200 ] || fail "ledger: HTTP $CODE"
}
step "the accrual in the ledger"
ledger
show "GET $API/v1/admin/affiliates/$ANNA_ID/ledger"
ACCRUAL="$(jv "[e['amountMinor'] for e in d['entries'] if e['kind'] == 'accrual' and e['orderNumber'] == '$ORDER_NUMBER']")"
same "accrual rows for order $ORDER_NUMBER" "[$COMMISSION]" "$ACCRUAL"
show "entry $(jv "next(e['entryId'] for e in d['entries'] if e['kind'] == 'accrual' and e['orderNumber'] == '$ORDER_NUMBER')"), payable from $(jv "next(e['availableAt'] for e in d['entries'] if e['kind'] == 'accrual' and e['orderNumber'] == '$ORDER_NUMBER')")"

# ── 5. partial refund → reversal ────────────────────────────────────────────
REFUND=$((CHARGED / 2))
step "a partial refund of $REFUND öre (seed-staging-slice.mjs --refund)"
show "node $SEED --tenant $TENANT --refund $ORDER_ID:$REFUND"
node "$SEED" --tenant "$TENANT" --refund "$ORDER_ID:$REFUND" | tee "$TMPD/refund.log" || fail "the seed's refund failed"
REVERSAL=""
for _ in $(seq 1 30); do
  ledger
  REVERSAL="$(jv "sum(e['amountMinor'] for e in d['entries'] if e['kind'] == 'reversal' and e['orderNumber'] == '$ORDER_NUMBER') if any(e['kind'] == 'reversal' and e['orderNumber'] == '$ORDER_NUMBER' for e in d['entries']) else None")"
  [ -n "$REVERSAL" ] && break
  sleep 4
done
[ -n "$REVERSAL" ] || fail "no reversal row for order $ORDER_NUMBER within 120 s (did the refund settle? GET $API/v1/admin/orders/$ORDER_ID)"
python3 -c 'import sys; c, r = int(sys.argv[1]), int(sys.argv[2]); sys.exit(0 if r < 0 and abs(-r - c / 2) <= max(2, c / 100) else 1)' "$COMMISSION" "$REVERSAL" \
  || fail "reversal $REVERSAL is not about half of the commission $COMMISSION"
pass "reversal $REVERSAL öre for order $ORDER_NUMBER (commission $COMMISSION, refund $REFUND of $CHARGED)"
call order2 GET "$API/v1/admin/orders/$ORDER_ID" "${AS_SHOP[@]}"
need "GET /v1/admin/orders/$ORDER_ID after the refund" 200
same "order.affiliate.affiliateCommissionMinor" "$((COMMISSION + REVERSAL))" "$(jv "d['order']['affiliate']['affiliateCommissionMinor']")"

# ── 6. payout: request as the affiliate, paid by the admin ─────────────────
step "the hold: what is held is exactly the commission of the orders still inside their 14 days"
call payouts GET "$API/v1/admin/affiliates/$ANNA_ID/payouts?limit=100" "${AS_SHOP[@]}"
need "admin payouts" 200
for OPEN in $(jv "' '.join(p['payoutId'] for p in d['payouts'] if p['status'] == 'requested')"); do
  call void POST "$API/v1/admin/affiliates/payouts/$OPEN/void" "${AS_SHOP[@]}" -d "$(body reason "Staging-smoke $RUN: en tidigare körnings öppna begäran")"
  need "void the earlier run's open request $OPEN" 200
done
# Every ledger page, so the held sum below sees every accrual of the affiliate.
LEDGER_ALL="$TMPD/ledger-all.json"
echo '[]' > "$LEDGER_ALL"
CURSOR=""
for _ in $(seq 1 50); do
  call ledgerpage GET "$API/v1/admin/affiliates/$ANNA_ID/ledger?limit=100${CURSOR:+&cursor=$CURSOR}" "${AS_SHOP[@]}" >/dev/null
  [ "$CODE" = 200 ] || fail "ledger page: HTTP $CODE"
  python3 -c 'import json,sys; a=json.load(open(sys.argv[1])); a+=json.load(open(sys.argv[2]))["entries"]; json.dump(a, open(sys.argv[1], "w"))' "$LEDGER_ALL" "$BODY"
  CURSOR="$(jv "d.get('nextCursor')")"
  [ -n "$CURSOR" ] || break
done
call me_hold GET "$API/v1/affiliate/me" "${AS_ANNA[@]}"
need "GET /v1/affiliate/me (balance before any adjustment)" 200
HOLD="$(python3 -c '
import datetime, json, sys
entries = json.load(open(sys.argv[1]))
balance = json.load(open(sys.argv[2]))["affiliate"]["balance"]
balance = balance[0] if isinstance(balance, list) else balance
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
held = matured = 0
for accrual in (e for e in entries if e["kind"] == "accrual"):
    net = accrual["amountMinor"] + sum(e["amountMinor"] for e in entries if e["kind"] == "reversal" and e["orderNumber"] == accrual["orderNumber"])
    if accrual["availableAt"] > now:
        held += max(0, net)
    else:
        matured += 1
print(held, balance["heldMinor"], matured, balance["payableMinor"])
' "$LEDGER_ALL" "$BODY")"
read -r EXPECTED_HELD HELD_MINOR MATURED PAYABLE_BEFORE <<< "$HOLD"
same "heldMinor = the commission of the orders still inside their 14 days" "$EXPECTED_HELD" "$HELD_MINOR"
show "matured accruals: $MATURED, payable now: $PAYABLE_BEFORE öre"
# A MATURED accrual (one from a run 14+ days ago) is payable by itself: no adjustment then.
# Making today's accrual mature instead (moving its available_at into the past) is not
# possible even on staging: affiliate_ledger is append-only (0059's no-update trigger), and
# disarming a money trigger is not something a smoke does. Until a run is 14 days old, a +10 kr
# adjustment stands in for the matured commission (clearly a staging-smoke entry).
if [ "$MATURED" -gt 0 ] && [ "${PAYABLE_BEFORE:-0}" -gt 0 ]; then
  pass "a matured accrual is payable without an adjustment ($PAYABLE_BEFORE öre)"
  ADJUSTED=0
else
  step "no matured commission yet: the fallback, an adjustment of +1000 öre"
  call adjust POST "$API/v1/admin/affiliates/$ANNA_ID/adjustments" "${AS_SHOP[@]}" \
    -d "{\"amountMinor\":1000,\"reason\":\"Staging-smoke $RUN: utbetalningsbart belopp (provisionen hålls i 14 dagar)\"}"
  need "adjustment +1000" 201
  show "entryId $(jv "d['entry']['entryId']")"
  ADJUSTED=1000
fi

step "the payout request, as the affiliate"
call me2 GET "$API/v1/affiliate/terms" "${AS_ANNA[@]}"
need "GET /v1/affiliate/terms" 200
if [ "$(jv "d['terms']['accepted']")" != "true" ]; then
  call accept POST "$API/v1/affiliate/terms/accept" "${AS_ANNA[@]}" -d "$(body version "$(jv "d['terms']['version']")")"
  need "accept the terms $TERMS_VERSION" 200
fi
call profile PATCH "$API/v1/affiliate/profile" "${AS_ANNA[@]}" \
  -d "$(body name "Anna Affiliate" addressLine1 "Provgatan 2" postalCode "852 30" city "Provstad" country "SE")"
need "PATCH /v1/affiliate/profile (name + postal address)" 200
call me3 GET "$API/v1/affiliate/me" "${AS_ANNA[@]}"
need "GET /v1/affiliate/me" 200
same "payout blockers" "[]" "$(jv "d['affiliate']['payoutBlockers']")"
PAYABLE="$(jv "next(b['payableMinor'] for b in d['affiliate']['balance']) if isinstance(d['affiliate']['balance'], list) else d['affiliate']['balance']['payableMinor']")"
[ "${PAYABLE:-0}" -ge $((PAYABLE_BEFORE + ADJUSTED)) ] && [ "${PAYABLE:-0}" -gt 0 ] \
  || fail "payable is $PAYABLE öre, expected $PAYABLE_BEFORE + $ADJUSTED"
show "payable $PAYABLE öre"
call request POST "$API/v1/affiliate/payouts" "${AS_ANNA[@]}" -d '{}'
need "POST /v1/affiliate/payouts" 201
PAYOUT_ID="$(jv "d['payout']['payoutId']")"
PAYOUT_AMOUNT="$(jv "d['payout']['amountMinor']")"
same "payout status" requested "$(jv "d['payout']['status']")"
same "payout amount (the whole payable)" "$PAYABLE" "$PAYOUT_AMOUNT"
show "payoutId $PAYOUT_ID"

step "marked paid, by the admin"
call paid POST "$API/v1/admin/affiliates/payouts/$PAYOUT_ID/paid" "${AS_SHOP[@]}" -d "$(body reference "Swish staging-smoke $RUN")"
need "POST /v1/admin/affiliates/payouts/$PAYOUT_ID/paid" 200
same "payout status" paid "$(jv "d['payout']['status']")"
ledger
same "the payout's ledger row" "[-$PAYOUT_AMOUNT]" "$(jv "[e['amountMinor'] for e in d['entries'] if e['kind'] == 'payout' and e['createdAt'] >= '$RUN_ISO']")"

# ── 7. the mail ledger ──────────────────────────────────────────────────────
step "email_deliveries rows of the affiliate kinds since the run started (wrangler d1, read-only)"
SQL="SELECT kind, status, attempts, delivery_id, strftime('%Y-%m-%dT%H:%M:%SZ', created_at / 1000, 'unixepoch') AS created
FROM email_deliveries
WHERE created_at >= $RUN_START_MS AND (tenant_id = '$TENANT' OR kind = 'password_reset')
  AND (kind LIKE 'affiliate_%' OR kind = 'password_reset')
ORDER BY created_at"
show "npx wrangler d1 execute $D1 --env staging --remote --json --command \"…\""
REQUIRED="affiliate_application_received affiliate_conversion affiliate_reversal affiliate_payout"
MISSING="$REQUIRED"
for _ in $(seq 1 8); do
  (cd "$ROOT/cloudflare" && npx wrangler d1 execute "$D1" --env staging --remote --json --command "$SQL") > "$TMPD/mails.json" 2>"$TMPD/mails.err" \
    || fail "wrangler d1 execute: $(head -c 300 "$TMPD/mails.err")"
  MISSING="$(python3 -c '
import json, sys
rows = json.load(open(sys.argv[1]))[0]["results"]
kinds = {r["kind"] for r in rows}
print(" ".join(k for k in sys.argv[2].split() if k not in kinds))
' "$TMPD/mails.json" "$REQUIRED")"
  [ -z "$MISSING" ] && break
  sleep 15
done
python3 -c '
import json, sys
rows = json.load(open(sys.argv[1]))[0]["results"]
for r in rows:
    print("      {created}  {kind:<32} {status:<10} attempts {attempts}  {delivery_id}".format(**r))
' "$TMPD/mails.json"
[ -z "$MISSING" ] || fail "no email_deliveries row of kind(s): $MISSING"
pass "the mail ledger holds $REQUIRED (pending until Resend is configured)"
show "shop-facing kinds (affiliate_application_notice, affiliate_payout_requested) appear only when the shop has a support address"

step "summary"
show "tenant          $TENANT"
show "affiliate       $ANNA_ID ($CODE_ANNA) — $API/v1/admin/affiliates/$ANNA_ID"
show "approved        $APPLICATION_ID → code $NEW_CODE"
show "order           $ORDER_ID ($ORDER_NUMBER) — $API/v1/admin/orders/$ORDER_ID"
show "commission      $COMMISSION öre, reversal $REVERSAL öre"
show "payout          $PAYOUT_ID ($PAYOUT_AMOUNT öre, paid)"
show "portal          $ADMIN/affiliate (sign in as $ANNA_EMAIL)"
echo
echo "affiliate smoke: all steps passed"
