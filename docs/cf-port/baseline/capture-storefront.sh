#!/bin/bash
# CP0 storefront design baseline — capture (PLAN §7.1). Read-only: navigates and screenshots, never clicks or submits.
#
#   docs/cf-port/baseline/capture-storefront.sh <outdir> [base-url]
#
# base-url defaults to the live Firebase storefront. For a checkpoint re-shoot pass the staging
# origin (URL grammar must stay /{shopId}/...). Writes <outdir>/<page>-{mobile,tablet,desktop}.png,
# <outdir>/capture.jsonl (one row per shot) and <outdir>/manifest.json.
#
# Why not `browse responsive`: it shoots desktop at 1280 (PLAN wants 1440) and every full-page
# capture is downscaled to <=2000px by gstack's screenshot-size-guard. An element screenshot of
# <html> is not guarded, so it gives a 1:1 full-page PNG at the real width.
set -u
B=${B:-$HOME/.claude/skills/gstack/browse/dist/browse}
OUT=${1:?usage: capture-storefront.sh <outdir> [base-url]}
BASE=${2:-https://shop-meteorpr.web.app}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"; JSONL="$OUT/capture.jsonl"; : > "$JSONL"

PAGES=(
  home                    /melodie-mc/
  produkter               /melodie-mc/produkter
  kategori                /melodie-mc/kategori/melodie-mc-90s-cover-art
  product                 /melodie-mc/product/anyone-out-there_anyone-out-there
  cart                    /melodie-mc/cart
  checkout                /melodie-mc/checkout
  legal-kopvillkor        /melodie-mc/legal/kopvillkor
  legal-angerratt         /melodie-mc/legal/angerratt-och-returer
  legal-integritetspolicy /melodie-mc/legal/integritetspolicy
  legal-plattformsvillkor /melodie-mc/legal/plattformsvillkor
  rapportera-intrang      /melodie-mc/rapportera-intrang
  angra                   /melodie-mc/angra
)

SETTLE='new Promise(r=>setTimeout(()=>r("ok"),3000))'
# Scroll through the page so lazy images and reveal-on-scroll content load, then return to the top.
SCROLL='(async()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));let y=0;while(y<document.documentElement.scrollHeight){window.scrollTo(0,y);y+=500;await s(120);}window.scrollTo(0,0);await s(1000);return "scrolled"})()'
META='JSON.stringify({finalUrl:location.href,title:document.title,h1:(document.querySelector("h1")||{}).innerText||null,h1All:[...document.querySelectorAll("h1")].map(h=>h.innerText.trim()),docHeight:document.documentElement.scrollHeight,docWidth:document.documentElement.scrollWidth,innerWidth:window.innerWidth,incompleteImages:[...document.images].filter(i=>!i.complete).length,bundle:([...document.querySelectorAll("script[src]")].map(s=>s.src.split("/").pop()).find(n=>/^index-.*\.js$/.test(n))||null)})'
tojson='let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(s.split("\n").filter(Boolean))))'

set -- "${PAGES[@]}"
while [ $# -gt 0 ]; do
  PAGE="$1"; P="$2"; shift 2
  for spec in mobile:375x812 tablet:768x1024 desktop:1440x900; do
    NAME=${spec%%:*}; VP=${spec#*:}
    $B console --clear >/dev/null; $B network --clear >/dev/null
    $B viewport "$VP" >/dev/null
    $B goto "$BASE$P" >/dev/null
    $B js "$SETTLE" >/dev/null
    $B js "$SCROLL" >/dev/null
    FILE="$OUT/$PAGE-$NAME.png"
    SHOT=$($B screenshot --selector html "$FILE" 2>&1)
    META_OUT=$($B js "$META" | grep '^{')
    ERRS=$($B console --errors | grep -E '^\[' | sed -E 's/^\[[^]]*\] //' | node -e "$tojson")
    FAILED=$($B network | grep -E '→ (4|5)[0-9][0-9] ' | sed -E 's/ \([^)]*\)$//' | node -e "$tojson")
    node -e 'const [page,path,vp,name,file,shot,meta,errs,failed]=process.argv.slice(1);console.log(JSON.stringify({page,path,viewport:vp,name,file,shot,meta:JSON.parse(meta||"{}"),consoleErrors:JSON.parse(errs),failedRequests:JSON.parse(failed),capturedAt:new Date().toISOString()}))' \
      "$PAGE" "$P" "$VP" "$NAME" "$FILE" "$SHOT" "$META_OUT" "$ERRS" "$FAILED" >> "$JSONL"
    echo "$PAGE $NAME: $SHOT"
  done
done

node "$HERE/build-manifest.cjs" "$JSONL" "$OUT" "$BASE"
