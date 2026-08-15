#!/usr/bin/env bash
#
# Tenant-isolation CI gate — runs ALL rules-test suites and fails on the first red.
#
# This is the single source of truth used BOTH locally and by GitHub Actions
# (.github/workflows/isolation-tests.yml). It manages the Firebase emulators via
# `firebase emulators:exec`, so emulators start clean and are torn down even on
# failure. The Firestore emulator needs JDK 21+ on PATH.
#
# Suites (and why each lives where it does):
#   - firestore-rules.test.cjs      } all three connect to the FIRESTORE emulator
#   - firestore-isolation.test.cjs  } (port 8080); run together in one exec.
#   - functions-isolation.test.cjs  } (Admin-SDK guard matrix against the emulator)
#   - storage-isolation.test.cjs      → STORAGE emulator (port 9199), own exec.
#   - connect-params.test.cjs         } PURE unit tests (no emulator); need
#   - dispute-recovery.test.cjs       } functions/lib compiled (tsc) first.
#
# Local run:
#   JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
#     PATH="$JAVA_HOME/bin:$PATH" bash rules-tests/run-all.sh
#
# Exit 0 = every suite green. Any red → non-zero (the CI gate blocks the merge).

set -euo pipefail

# Resolve repo root from this script's location so it runs from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

PROJECT="demo-rules-test"   # fake project id — never touches prod
FIREBASE="npx --no-install firebase"

echo "==> Tenant-isolation gate (project: $PROJECT)"
echo "    node: $(node --version)"
command -v java >/dev/null 2>&1 && echo "    java: $(java -version 2>&1 | head -1)" || {
  echo "ERROR: java not on PATH — the Firestore emulator needs JDK 21+." >&2
  exit 1
}

# 1) Pure unit test first (fast, no emulator) — fail early if the money-path
#    builders regressed. Requires functions/lib to be compiled.
if [ ! -f functions/lib/payment/connectParams.js ]; then
  echo "==> functions/lib missing — building functions (tsc)…"
  ( cd functions && npm run build )
fi
echo "==> [1/3] connect-params (pure unit test)"
node rules-tests/connect-params.test.cjs
echo "==> [1/3] dispute-recovery (pure unit test)"
node rules-tests/dispute-recovery.test.cjs
echo "==> [1/3] withdrawal-gate (pure unit test, ESM)"
node rules-tests/withdrawal-gate.test.mjs
echo "==> [1/3] dac7-aggregation (pure unit test)"
node rules-tests/dac7-aggregation.test.cjs
echo "==> [1/3] checkout-invariants (pure unit test — P0-03 tenant/SKU/live-shop)"
node rules-tests/checkout-invariants.test.cjs

# 2) The three Firestore-emulator suites in one emulator lifecycle.
echo "==> [2/3] firestore-emulator suites (rules + isolation + functions-guard)"
$FIREBASE emulators:exec --only firestore --project "$PROJECT" \
  'node rules-tests/firestore-rules.test.cjs \
   && node rules-tests/firestore-isolation.test.cjs \
   && node rules-tests/functions-isolation.test.cjs'

# 3) The storage-emulator suite. If a Storage emulator is ALREADY listening on
#    9199 (a dev left one running from a prior `emulators:start`), reuse it —
#    the suite injects its own rules, so any demo-project emulator works. In CI
#    ports are clean, so we start a fresh one via emulators:exec.
echo "==> [3/3] storage-emulator suite (storage isolation)"
if nc -z 127.0.0.1 9199 >/dev/null 2>&1; then
  echo "    (reusing already-running Storage emulator on 9199)"
  node rules-tests/storage-isolation.test.cjs
else
  $FIREBASE emulators:exec --only storage --project "$PROJECT" \
    'node rules-tests/storage-isolation.test.cjs'
fi

echo "==> ✅ ALL isolation suites passed."
