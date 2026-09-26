#!/bin/bash
# Pixel-diff a re-shoot against the baseline (PLAN §7.3: <= 0.5 % differing pixels, or an explained delta).
#
#   docs/cf-port/baseline/diff-storefront.sh <baseline-dir> <reshoot-dir> [diff-out-dir]
#
# Needs ImageMagick 7 (`magick`). A size change (page got taller/shorter) is reported as SIZE and
# counts as red: layout moved. Writes a highlighted diff PNG per non-identical shot to diff-out-dir.
set -u
BASE_DIR=${1:?baseline dir}; NEW_DIR=${2:?reshoot dir}; DIFF_DIR=${3:-$NEW_DIR/diff}
FUZZ=${FUZZ:-2%}; LIMIT=${LIMIT:-0.5}
mkdir -p "$DIFF_DIR"; red=0
for f in "$BASE_DIR"/*.png; do
  n=$(basename "$f"); g="$NEW_DIR/$n"
  if [ ! -f "$g" ]; then echo "MISSING  $n"; red=1; continue; fi
  a=$(magick identify -format '%wx%h' "$f"); b=$(magick identify -format '%wx%h' "$g")
  if [ "$a" != "$b" ]; then echo "SIZE     $n  $a -> $b"; red=1; continue; fi
  # IM 7 prints "<scaled> (<pixel count>)" for AE; the pixel count is the value in parentheses.
  px=$(magick compare -metric AE -fuzz "$FUZZ" "$f" "$g" "$DIFF_DIR/$n" 2>&1 >/dev/null | sed -nE 's/.*\(([0-9.e+]+)\).*/\1/p')
  if [ -z "$px" ]; then echo "ERROR    $n  could not read magick compare output"; red=1; continue; fi
  pct=$(awk -v p="$px" -v s="$a" 'BEGIN{split(s,d,"x"); printf "%.3f", 100*p/(d[1]*d[2])}')
  if awk -v p="$pct" -v l="$LIMIT" 'BEGIN{exit !(p>l)}'; then echo "RED      $n  $pct %"; red=1
  else echo "ok       $n  $pct %"; [ "$px" = "0" ] && rm -f "$DIFF_DIR/$n"; fi
done
exit $red
