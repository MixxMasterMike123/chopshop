#!/usr/bin/env bash
# Live money-loop smoke (checkpoint 25): anonymous checkout with discount →
# server-minted PaymentIntent → REAL test-mode confirm with Stripe's test card →
# Stripe delivers payment_intent.succeeded to the staging webhook.
#
# Prompts locally for your TEST-mode secret key (sk_test_...). The key is kept
# out of argv (curl reads it from a 600-permission temp config) and never leaves
# this shell. D1 verification (order row, used_count, payment_events) is done
# separately with wrangler — this script's job ends when Stripe says succeeded.
set -uo pipefail

BASE="https://meteorshop-stg-api.micke-ohlen.workers.dev"
RUN="$(date +%s)"
TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT

PASS=0; FAIL=0
check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    printf 'PASS  %s (%s)\n' "$1" "$3"; PASS=$((PASS+1))
  else
    printf 'FAIL  %s (expected %s, got %s)\n' "$1" "$2" "$3"; FAIL=$((FAIL+1))
  fi
}
jsonval() { python3 -c "import json,sys; d=json.load(open('$1')); print($2)" 2>/dev/null; }

read -rsp "Stripe TEST secret key (sk_test_...): " SK; echo
case "$SK" in
  sk_test_*) ;;
  *) echo "Refusing: not a test-mode key (must start sk_test_)."; exit 1 ;;
esac
AUTH="$TMPD/auth"; ( umask 077; printf 'user = "%s:"' "$SK" > "$AUTH" )
unset SK

# --- published product ------------------------------------------------------
code=$(curl -s -o "$TMPD/products.json" -w "%{http_code}" "$BASE/v1/products")
check "public catalogue" 200 "$code"
PRODUCT_ID="$(jsonval "$TMPD/products.json" "d['products'][0]['productId']")"
[ -n "$PRODUCT_ID" ] || { echo "no published product"; exit 1; }

# --- anonymous pickup checkout with the SMOKE10 discount --------------------
code=$(curl -s -o "$TMPD/checkout.json" -w "%{http_code}" -X POST "$BASE/v1/checkout" \
  -H "content-type: application/json" \
  -d "{\"deliveryMethod\":\"pickup\",\"email\":\"pay-live-$RUN@example.com\",\"idempotencyKey\":\"pay-live-$RUN\",\"discountCode\":\"SMOKE10\",\"items\":[{\"productId\":\"$PRODUCT_ID\",\"quantity\":1}]}")
check "checkout created" 201 "$code"
CHECKOUT_ID="$(jsonval "$TMPD/checkout.json" "d['checkout']['checkoutId']")"
TOTAL="$(jsonval "$TMPD/checkout.json" "d['checkout']['totalMinor']")"
DISCOUNT="$(jsonval "$TMPD/checkout.json" "d['checkout']['discountMinor']")"
printf '      checkoutId %s  totalMinor %s  discountMinor %s\n' "$CHECKOUT_ID" "$TOTAL" "$DISCOUNT"
if [ "${DISCOUNT:-0}" = "0" ]; then
  printf 'NOTE  discount resolved to 0 (SMOKE10 missing?) — used_count assertion will not apply\n'
fi

# --- mint the PaymentIntent -------------------------------------------------
code=$(curl -s -o "$TMPD/pay.json" -w "%{http_code}" -X POST "$BASE/v1/checkout/$CHECKOUT_ID/payment")
check "PaymentIntent minted" 201 "$code"
PI="$(jsonval "$TMPD/pay.json" "d['payment']['paymentIntentId']")"
printf '      paymentIntentId %s\n' "$PI"

# --- confirm with Stripe's test card (the real money moment, test mode) -----
code=$(curl -s -K "$AUTH" -o "$TMPD/confirm.json" -w "%{http_code}" \
  -X POST "https://api.stripe.com/v1/payment_intents/$PI/confirm" \
  -d "payment_method=pm_card_visa" \
  -d "return_url=https://example.com/return")
check "Stripe confirm HTTP" 200 "$code"
check "intent status" succeeded "$(jsonval "$TMPD/confirm.json" "d['status']")"
check "amount matches checkout total" "$TOTAL" "$(jsonval "$TMPD/confirm.json" "d['amount']")"

# --- give the webhook a moment, then probe the worker-side effects ----------
sleep 8

# A checkout whose intent is terminal gets the same opaque 404 as a dead one
# (checkpoint 24's terminal-intent rule) — the payment surface should now
# refuse this checkout.
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/v1/checkout/$CHECKOUT_ID/payment")
check "payment route now refuses the paid checkout (terminal intent)" 404 "$code"

# An identical checkout replay should now 409 (the checkout left 'open')...
# prod parity says replay of a completed checkout is a fresh conflict, so just
# report the code rather than asserting a specific one.
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/v1/checkout" \
  -H "content-type: application/json" \
  -d "{\"deliveryMethod\":\"pickup\",\"email\":\"pay-live-$RUN@example.com\",\"idempotencyKey\":\"pay-live-$RUN\",\"discountCode\":\"SMOKE10\",\"items\":[{\"productId\":\"$PRODUCT_ID\",\"quantity\":1}]}")
printf 'INFO  idempotent checkout replay after completion answers %s\n' "$code"

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
printf '\nHand these two ids to Claude for the D1 readback:\n  checkoutId: %s\n  paymentIntentId: %s\n' "$CHECKOUT_ID" "$PI"
[ "$FAIL" -eq 0 ]
