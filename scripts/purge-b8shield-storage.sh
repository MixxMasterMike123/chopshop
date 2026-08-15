#!/usr/bin/env bash
# purge-b8shield-storage.sh — delete the legacy b8shield tenant's Storage objects.
#
# Companion to scripts/purge-b8shield-shop.cjs (which handles Firestore). Storage
# paths are shopId-PARTITIONED (Phase B tenant isolation), e.g.
# products/{shopId}/..., branding/{shopId}/..., so removing one tenant is exactly
# "delete the b8shield segment under each partitioned prefix". No other shop's
# objects live under these paths, which is what makes this safe.
#
# DRY RUN by default: lists what WOULD be deleted. Pass --commit to delete.
# Deletion is IRREVERSIBLE.
#
# USAGE (Mikael runs — live data DELETE, STOP-and-surface class):
#   ./scripts/purge-b8shield-storage.sh            # dry run
#   ./scripts/purge-b8shield-storage.sh --commit   # actually delete
set -euo pipefail

BUCKET="gs://b8shield-reseller-app.firebasestorage.app"
SHOP="b8shield"
COMMIT="${1:-}"

# Every shopId-partitioned prefix in storage.rules.
PREFIXES=(
  products branding collections pod-artwork content-studio content-studio-quick
  marketing-materials affiliates admin-documents pages
)

echo "🔥 Purge legacy shop storage — ${SHOP}"
echo "   bucket: ${BUCKET}"
if [ "$COMMIT" = "--commit" ]; then
  echo "   mode:   🔴 COMMIT (will DELETE)"
else
  echo "   mode:   🟡 DRY RUN (no deletes)"
fi
echo ""

TOTAL=0
for p in "${PREFIXES[@]}"; do
  PATH_GS="${BUCKET}/${p}/${SHOP}/"
  # -r so nested objects count; silence the "no matches" stderr for empty prefixes.
  # -r output includes "<prefix>/:" directory-header lines and trailing-slash
  # placeholder entries — neither is an object, so filter both from the count.
  N=$(gsutil ls -r "${PATH_GS}" 2>/dev/null | grep -v '/$' | grep -v ':$' | grep -c . || true)
  if [ "${N}" -gt 0 ]; then
    echo "   ${p}/${SHOP}/: ${N} objects"
    TOTAL=$((TOTAL + N))
    if [ "$COMMIT" = "--commit" ]; then
      gsutil -m rm -r "${PATH_GS}" >/dev/null 2>&1 && echo "      ✅ deleted"
    fi
  fi
done

echo ""
echo "   TOTAL objects: ${TOTAL}"
if [ "$COMMIT" != "--commit" ]; then
  echo ""
  echo "🟡 Dry run complete. Re-run with --commit to delete. IRREVERSIBLE."
fi
