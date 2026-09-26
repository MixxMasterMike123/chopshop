#!/usr/bin/env bash
# Staging platform smoke: signs in as the platform admin (credentials prompted
# locally, never leave this shell), provisions the demo tenant bound to the
# workers.dev hostname, and verifies live tenant resolution, the suspend gate,
# and the one-account-kind boundary. Safe to re-run: provisioning an existing
# tenant answers 409, which the script treats as "already provisioned".
set -uo pipefail

BASE="https://meteorshop-stg-api.micke-ohlen.workers.dev"
TENANT_ID="demo"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

PASS=0; FAIL=0
check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    printf 'PASS  %s (%s)\n' "$1" "$3"; PASS=$((PASS+1))
  else
    printf 'FAIL  %s (expected %s, got %s)\n' "$1" "$2" "$3"; FAIL=$((FAIL+1))
  fi
}

read -rp  "Platform admin email: " EMAIL
read -rsp "Password: " PASSWORD; echo

# JSON built by python so passwords with quotes/backslashes survive intact.
SIGNIN_BODY="$(EMAIL="$EMAIL" PASSWORD="$PASSWORD" python3 -c \
  'import json,os;print(json.dumps({"email":os.environ["EMAIL"],"password":os.environ["PASSWORD"]}))')"

code=$(curl -s -o /tmp/stg-signin.json -w "%{http_code}" -c "$JAR" \
  -X POST "$BASE/api/auth/sign-in/email" \
  -H "content-type: application/json" -H "origin: $BASE" \
  -d "$SIGNIN_BODY")
check "sign-in" 200 "$code"
if [ "$code" != 200 ]; then
  echo "Cannot continue without a session. Response:"; cat /tmp/stg-signin.json; echo
  exit 1
fi

session=$(curl -s -b "$JAR" "$BASE/api/auth/get-session")
case "$session" in
  null|"") check "get-session returns a session" "non-null" "null" ;;
  *)       check "get-session returns a session" "non-null" "non-null" ;;
esac

# Provision the demo tenant, bound to the worker's own hostname so live
# hostname-only tenant resolution has a host it can actually receive.
code=$(curl -s -o /tmp/stg-tenant.json -w "%{http_code}" -b "$JAR" \
  -X POST "$BASE/v1/platform/tenants" \
  -H "content-type: application/json" -H "origin: $BASE" \
  -d "{\"tenantId\":\"$TENANT_ID\",\"shopName\":\"Demo Shop\",\"hostname\":\"meteorshop-stg-api.micke-ohlen.workers.dev\"}")
case "$code" in
  201) check "provision tenant" 201 201 ;;
  409) printf 'PASS  provision tenant (409 = already provisioned, re-run)\n'; PASS=$((PASS+1)) ;;
  *)   check "provision tenant" "201 or 409" "$code" ;;
esac

code=$(curl -s -o /tmp/stg-storefront.json -w "%{http_code}" "$BASE/v1/storefront")
check "storefront resolves on the bound hostname" 200 "$code"
echo "      storefront: $(cat /tmp/stg-storefront.json)"

# Well-formed checkout naming a product that does not exist: the tenant now
# resolves, so this must be the priced route's 422, not the unknown-host 404.
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/v1/checkout" \
  -H "content-type: application/json" \
  -d '{"deliveryMethod":"pickup","email":"smoke@example.com","idempotencyKey":"smoke-e2e-1","items":[{"productId":"missing","quantity":1}]}')
check "checkout resolves tenant, rejects unknown product" 422 "$code"

# One-account-kind boundary: a PLATFORM admin is not a TENANT admin, so the
# tenant-admin surface must stay hidden from this session.
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" \
  -X POST "$BASE/v1/admin/products" \
  -H "content-type: application/json" -H "origin: $BASE" \
  -d '{"sku":"S","name":"N","description":null,"priceMinor":100,"currency":"SEK"}')
check "platform session denied on tenant-admin surface" 404 "$code"

# Suspend gate: storefront 404s while suspended, returns after activate.
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -X POST \
  -H "origin: $BASE" "$BASE/v1/platform/tenants/$TENANT_ID/suspend")
check "suspend tenant" 200 "$code"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/v1/storefront")
check "storefront hidden while suspended" 404 "$code"
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -X POST \
  -H "origin: $BASE" "$BASE/v1/platform/tenants/$TENANT_ID/activate")
check "activate tenant" 200 "$code"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/v1/storefront")
check "storefront restored after activate" 200 "$code"

# Sign out so no session outlives the smoke.
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -X POST \
  -H "origin: $BASE" "$BASE/api/auth/sign-out")
check "sign-out" 200 "$code"

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
