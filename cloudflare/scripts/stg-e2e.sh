#!/usr/bin/env bash
# Full authenticated staging e2e: platform admin provisions a tenant + tenant
# admin, the tenant admin builds a priced catalogue (weight, carriage table,
# pickup, discount code) and uploads a private object, and an anonymous buyer
# checks out with shipping, VAT and a discount — with EXACT expected money
# values asserted against the deployed engine.
#
# Credentials are prompted locally and never leave this shell. Safe to re-run:
# tenant/user/code creation treats 409 as "already provisioned"; products and
# idempotency keys are per-run unique.
set -uo pipefail

BASE="https://meteorshop-stg-api.micke-ohlen.workers.dev"
TENANT_ID="demo"
TADMIN_EMAIL="tenant-admin@demo.invalid"
RUN="$(date +%s)"
PJAR="$(mktemp)"; TJAR="$(mktemp)"; TMPD="$(mktemp -d)"
trap 'rm -rf "$PJAR" "$TJAR" "$TMPD"' EXIT

PASS=0; FAIL=0
check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    printf 'PASS  %s (%s)\n' "$1" "$3"; PASS=$((PASS+1))
  else
    printf 'FAIL  %s (expected %s, got %s)\n' "$1" "$2" "$3"; FAIL=$((FAIL+1))
  fi
}
jsonval() { # jsonval <file> <python-expr over d>
  python3 -c "import json,sys; d=json.load(open('$1')); print($2)" 2>/dev/null
}

read -rp  "Platform admin email: " PEMAIL
read -rsp "Platform admin password: " PPASSWORD; echo
read -rsp "Tenant admin password (created on first run, reused after): " TPASSWORD; echo

# JSON built by python with env-var inputs: quotes/backslashes in passwords
# survive, and the secret never appears in argv. Single-quoted python source so
# the shell leaves the braces alone.
credentials_json() { # credentials_json <email> <password>
  J_EMAIL="$1" J_PW="$2" python3 -c \
'import json,os
print(json.dumps({"email": os.environ["J_EMAIL"], "password": os.environ["J_PW"]}))'
}
user_json() { # user_json <email> <password> <accountType>
  J_EMAIL="$1" J_PW="$2" J_KIND="$3" python3 -c \
'import json,os
print(json.dumps({"email": os.environ["J_EMAIL"], "password": os.environ["J_PW"], "accountType": os.environ["J_KIND"]}))'
}

# --- Platform admin session -------------------------------------------------
code=$(curl -s -o /dev/null -w "%{http_code}" -c "$PJAR" -X POST "$BASE/api/auth/sign-in/email" \
  -H "content-type: application/json" -H "origin: $BASE" \
  -d "$(credentials_json "$PEMAIL" "$PPASSWORD")")
check "platform sign-in" 200 "$code"
[ "$code" = 200 ] || { echo "cannot continue"; exit 1; }

# --- Tenant (bound to the worker hostname) ----------------------------------
code=$(curl -s -o "$TMPD/tenant.json" -w "%{http_code}" -b "$PJAR" -X POST "$BASE/v1/platform/tenants" \
  -H "content-type: application/json" -H "origin: $BASE" \
  -d "{\"tenantId\":\"$TENANT_ID\",\"shopName\":\"Demo Shop\",\"hostname\":\"meteorshop-stg-api.micke-ohlen.workers.dev\"}")
case "$code" in
  201|409) printf 'PASS  tenant provisioned or already present (%s)\n' "$code"; PASS=$((PASS+1)) ;;
  *) check "provision tenant" "201 or 409" "$code" ;;
esac

# --- Tenant-admin user (checkpoint 23 surface) ------------------------------
code=$(curl -s -o "$TMPD/user.json" -w "%{http_code}" -b "$PJAR" -X POST "$BASE/v1/platform/users" \
  -H "content-type: application/json" -H "origin: $BASE" \
  -d "$(user_json "$TADMIN_EMAIL" "$TPASSWORD" "tenant_admin")")
case "$code" in
  201|409) printf 'PASS  tenant-admin user created or already present (%s)\n' "$code"; PASS=$((PASS+1)) ;;
  *) check "create tenant-admin user" "201 or 409" "$code" ;;
esac

# --- Tenant-admin session (also yields the userId for the grant) ------------
code=$(curl -s -o /dev/null -w "%{http_code}" -c "$TJAR" -X POST "$BASE/api/auth/sign-in/email" \
  -H "content-type: application/json" -H "origin: $BASE" \
  -d "$(credentials_json "$TADMIN_EMAIL" "$TPASSWORD")")
check "tenant-admin sign-in" 200 "$code"
[ "$code" = 200 ] || { echo "cannot continue (wrong tenant-admin password for an existing user?)"; exit 1; }

curl -s -b "$TJAR" "$BASE/api/auth/get-session" > "$TMPD/tsession.json"
TUSER_ID="$(jsonval "$TMPD/tsession.json" "d['user']['id']")"
case "$TUSER_ID" in
  "") check "tenant-admin userId from session" "non-empty" "empty" ;;
  *)  printf 'PASS  tenant-admin userId (%s)\n' "$TUSER_ID"; PASS=$((PASS+1)) ;;
esac

# --- Grant membership (idempotent for a duplicate active grant) -------------
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$PJAR" -X POST "$BASE/v1/platform/tenants/$TENANT_ID/admins" \
  -H "content-type: application/json" -H "origin: $BASE" -d "{\"userId\":\"$TUSER_ID\"}")
case "$code" in
  201) printf 'PASS  admin membership granted (201)\n'; PASS=$((PASS+1)) ;;
  *) check "grant admin membership" 201 "$code" ;;
esac

# --- Catalogue: product with weight + carriage table + pickup ---------------
code=$(curl -s -o "$TMPD/product.json" -w "%{http_code}" -b "$TJAR" -X POST "$BASE/v1/admin/products" \
  -H "content-type: application/json" -H "origin: $BASE" \
  -d "{\"sku\":\"SMOKE-$RUN\",\"name\":\"Smoke Tee\",\"description\":null,\"priceMinor\":19900,\"currency\":\"SEK\",\"weightGrams\":40,\"allowPickup\":true,\"shippingRates\":{\"sweden\":{\"cost\":2900}}}")
check "create product" 201 "$code"
PRODUCT_ID="$(jsonval "$TMPD/product.json" "d['product']['productId']")"

code=$(curl -s -o /dev/null -w "%{http_code}" -b "$TJAR" -X PATCH "$BASE/v1/admin/products/$PRODUCT_ID" \
  -H "content-type: application/json" -H "origin: $BASE" -d '{"status":"active"}')
check "activate product" 200 "$code"

code=$(curl -s -o /dev/null -w "%{http_code}" -b "$TJAR" -X POST "$BASE/v1/admin/products/$PRODUCT_ID/publish" \
  -H "origin: $BASE")
check "publish product" 200 "$code"

code=$(curl -s -o "$TMPD/public.json" -w "%{http_code}" "$BASE/v1/products/$PRODUCT_ID")
check "public product detail" 200 "$code"

# --- Discount code: 10% off everything --------------------------------------
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$TJAR" -X POST "$BASE/v1/admin/discount-codes" \
  -H "content-type: application/json" -H "origin: $BASE" \
  -d '{"code":"SMOKE10","type":"percent","percentBp":1000,"scope":"all"}')
case "$code" in
  201|409) printf 'PASS  discount code present (%s)\n' "$code"; PASS=$((PASS+1)) ;;
  *) check "create discount code" "201 or 409" "$code" ;;
esac

# --- Private object: reserve, upload, read back, delete ---------------------
printf 'meteorshop staging smoke %s\n' "$RUN" > "$TMPD/blob.bin"
SIZE=$(wc -c < "$TMPD/blob.bin" | tr -d ' ')
SHA=$(shasum -a 256 "$TMPD/blob.bin" | cut -d' ' -f1)
code=$(curl -s -o "$TMPD/reserve.json" -w "%{http_code}" -b "$TJAR" -X POST "$BASE/v1/admin/objects" \
  -H "content-type: application/json" -H "origin: $BASE" \
  -d "{\"kind\":\"document\",\"fileName\":\"smoke.txt\",\"contentType\":\"text/plain\",\"sha256\":\"$SHA\",\"sizeBytes\":$SIZE}")
check "reserve object" 201 "$code"
OBJECT_ID="$(jsonval "$TMPD/reserve.json" "d['object']['objectId']")"

code=$(curl -s -o /dev/null -w "%{http_code}" -b "$TJAR" -X PUT "$BASE/v1/admin/objects/$OBJECT_ID/content" \
  -H "content-type: text/plain" -H "origin: $BASE" --data-binary @"$TMPD/blob.bin")
check "upload object bytes (R2-verified checksum)" 200 "$code"

code=$(curl -s -o "$TMPD/download.bin" -w "%{http_code}" -b "$TJAR" "$BASE/v1/admin/objects/$OBJECT_ID/content")
check "download object" 200 "$code"
if cmp -s "$TMPD/blob.bin" "$TMPD/download.bin"; then
  printf 'PASS  downloaded bytes identical\n'; PASS=$((PASS+1))
else
  printf 'FAIL  downloaded bytes differ\n'; FAIL=$((FAIL+1))
fi

code=$(curl -s -o /dev/null -w "%{http_code}" -b "$TJAR" -X DELETE "$BASE/v1/admin/objects/$OBJECT_ID" \
  -H "origin: $BASE")
check "delete object" 204 "$code"

# --- Anonymous checkout: shipping + VAT + discount, EXACT money -------------
# Expected (engine parity math):
#   subtotal 19900; weight 40g + 20g packaging = 60g -> 2 tiers x 2900 = 5800
#   discount ceil(19900 x 1000 / 10000) = 1990
#   total 19900 + 5800 - 1990 = 23710
#   vat  23710 - round(23710 x 10000 / 12500) = 23710 - 18968 = 4742
code=$(curl -s -o "$TMPD/checkout.json" -w "%{http_code}" -X POST "$BASE/v1/checkout" \
  -H "content-type: application/json" \
  -d "{\"deliveryMethod\":\"shipping\",\"shippingCountry\":\"SE\",\"email\":\"buyer-$RUN@example.com\",\"idempotencyKey\":\"e2e-ship-$RUN\",\"discountCode\":\"SMOKE10\",\"items\":[{\"productId\":\"$PRODUCT_ID\",\"quantity\":1}]}")
check "shipped checkout created" 201 "$code"
check "  subtotalMinor" 19900 "$(jsonval "$TMPD/checkout.json" "d['checkout']['subtotalMinor']")"
check "  shippingMinor (40g+20g pack = 2 tiers)" 5800 "$(jsonval "$TMPD/checkout.json" "d['checkout']['shippingMinor']")"
check "  discountMinor (10%)" 1990 "$(jsonval "$TMPD/checkout.json" "d['checkout']['discountMinor']")"
check "  totalMinor" 23710 "$(jsonval "$TMPD/checkout.json" "d['checkout']['totalMinor']")"
check "  vatMinor (25% contained)" 4742 "$(jsonval "$TMPD/checkout.json" "d['checkout']['vatMinor']")"

# Pickup: carriage zeroed, total 19900 - 1990 = 17910; vat 17910 - round(17910x0.8=14328) = 3582
code=$(curl -s -o "$TMPD/pickup.json" -w "%{http_code}" -X POST "$BASE/v1/checkout" \
  -H "content-type: application/json" \
  -d "{\"deliveryMethod\":\"pickup\",\"email\":\"buyer-$RUN@example.com\",\"idempotencyKey\":\"e2e-pickup-$RUN\",\"discountCode\":\"SMOKE10\",\"items\":[{\"productId\":\"$PRODUCT_ID\",\"quantity\":1}]}")
check "pickup checkout created" 201 "$code"
check "  pickup shippingMinor" 0 "$(jsonval "$TMPD/pickup.json" "d['checkout']['shippingMinor']")"
check "  pickup totalMinor" 17910 "$(jsonval "$TMPD/pickup.json" "d['checkout']['totalMinor']")"
check "  pickup vatMinor" 3582 "$(jsonval "$TMPD/pickup.json" "d['checkout']['vatMinor']")"

# Replay: identical body answers 200 with the same checkout, not a duplicate.
code=$(curl -s -o "$TMPD/replay.json" -w "%{http_code}" -X POST "$BASE/v1/checkout" \
  -H "content-type: application/json" \
  -d "{\"deliveryMethod\":\"pickup\",\"email\":\"buyer-$RUN@example.com\",\"idempotencyKey\":\"e2e-pickup-$RUN\",\"discountCode\":\"SMOKE10\",\"items\":[{\"productId\":\"$PRODUCT_ID\",\"quantity\":1}]}")
check "identical replay answers 200" 200 "$code"
check "  replay returns the same checkout" \
  "$(jsonval "$TMPD/pickup.json" "d['checkout']['checkoutId']")" \
  "$(jsonval "$TMPD/replay.json" "d['checkout']['checkoutId']")"

# --- Sign out both sessions -------------------------------------------------
curl -s -o /dev/null -b "$PJAR" -X POST -H "origin: $BASE" "$BASE/api/auth/sign-out"
curl -s -o /dev/null -b "$TJAR" -X POST -H "origin: $BASE" "$BASE/api/auth/sign-out"

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
