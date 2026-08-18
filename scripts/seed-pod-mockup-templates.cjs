/**
 * seed-pod-mockup-templates.cjs — seed the Design Studio garment mockup templates
 * (settings/podMockupTemplates).
 *
 * The Design Studio (POD add-on, Mode A) composes validated artwork onto garment
 * backgrounds. A template is EITHER a FLAT (SVG flat via `garment`; print-area px in
 * the SVG's 800×900 viewBox) OR a PHOTO (real garment photo per colourway via
 * `photo`; print-area px in the photo's own pixel space) — see the commented photo
 * example at the end of TEMPLATES. Each carries its selectable colourways + the
 * PRINT-AREA GEOMETRY together with the physical print size in millimetres. The
 * compositor uses the px↔mm pair to compute effective DPI per placement.
 *
 * ⚠️ These are PROVISIONAL, generic garment flats (provisional:true) — interim
 * templates until the real print shop delivers photographed garments + exact
 * print-area coordinates (see the handover: mockup quality is bounded by the real
 * garment catalog). The Design Studio surfaces a "preliminära" banner.
 *
 * printAreaMm = the PRINT SHOP'S REAL print areas (docs/POD_PRINT_SPEC.md,
 * 2026-07-27): front 250×350 mm (starts ~a hand's width below the neck seam),
 * back 300×400 mm (a generous hand's width below the seam). The printAreas (px)
 * rects are hand-tuned to sit on the front chest of
 * src/wagons/pod-wagon/studio/garments/TeeFlat.jsx / HoodieFlat.jsx (viewBox
 * 800×900) and MUST share the same aspect ratio as their mm size (front 5:7,
 * back 3:4) — a px/mm aspect mismatch silently skews every preview.
 *
 * Mirrors scripts/seed-pod-profiles.cjs:
 *   - DRY RUN by default — prints the doc it WOULD write, then exits.
 *   - Pass `--commit` to actually write.
 *   - Idempotent: if settings/podMockupTemplates already exists it does NOT
 *     overwrite (pass `--force` to overwrite — e.g. to push updated templates).
 *
 * USAGE (run by Mikael — live data write, STOP-and-surface class):
 *   node scripts/seed-pod-mockup-templates.cjs            # dry run, shows the plan
 *   node scripts/seed-pod-mockup-templates.cjs --commit   # actually write the doc
 *   node scripts/seed-pod-mockup-templates.cjs --commit --force   # overwrite existing
 *
 * Requires Application Default Credentials (gcloud auth application-default login)
 * OR a serviceAccountKey.json — same as the other admin scripts here.
 */

// firebase-admin is installed in functions/node_modules (not the repo root),
// so resolve it from there regardless of where this script is run from.
const path = require('path');
const { createRequire } = require('module');
const functionsRequire = createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const admin = functionsRequire('firebase-admin');
const { getFirestore } = functionsRequire('firebase-admin/firestore');

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const FORCE = args.includes('--force');

// ── Systema-priser: moms-tolkning ────────────────────────────────────────────
// ANTAGANDE (Mikael 2026-08-18, EJ bekräftat av Systema): listpriserna är
// INKL. moms. Kostnadsmodellen (podPricing) räknar EXKL. moms, så listpriser
// divideras med 1,25 vid seedning. Siffrorna nedan står EXAKT som Kim
// citerade dem — ändra ALDRIG dem för momsens skull. När Systema svarar:
// exkl. moms → sätt SYSTEMA_PRICES_INCLUDE_VAT = false och re-seeda; klart.
// ⚠️ Risknot: om antagandet är FEL (priserna är exkl.) ligger golven ~20 %
// för lågt och säljare kan gå under vattnet — motsatt antagande är det säkra.
const SYSTEMA_PRICES_INCLUDE_VAT = true;
const sek = (listPrice) => (SYSTEMA_PRICES_INCLUDE_VAT
  ? Math.round((listPrice / 1.25) * 100) / 100
  : listPrice);

admin.initializeApp(); // default credentials, like scripts/seed-default-shop.cjs
const db = getFirestore('b8s-reseller-db'); // the CORRECT named database
db.settings({ ignoreUndefinedProperties: true });

// Shared colourway palette for the apparel flats. hex fills the garment body SVG;
// works from white (#ffffff) through black (#1a1a1a).
const APPAREL_COLORWAYS = [
  { id: 'white', label: 'Vit', hex: '#ffffff' },
  { id: 'black', label: 'Svart', hex: '#1a1a1a' },
  { id: 'navy', label: 'Marinblå', hex: '#1f2a44' },
  { id: 'heather', label: 'Gråmelerad', hex: '#b7b7b7' },
];

// PROVISIONAL templates. Shape consumed by src/config/podMockupTemplates.js +
// src/wagons/pod-wagon/studio/DesignStudio.jsx.
//
// printAreas are SVG viewBox (800×900) pixel rects; printAreaMm is the physical
// print size ↔ podProfiles apparel_dtg (300×400 mm, 3:4). The rects share that 3:4
// aspect so preview scale ↔ physical scale stay consistent.
// ── T-SHIRT: REAL PHOTO TEMPLATE (2026-08-10) ────────────────────────────────
// B&C Exact 150 (TU01T) — Kim's actual blank. Consistently framed hanging-shirt
// photos (1920×2186 originals), front + back per colour, served as optimized WebP
// from hosting /pod-garments/tee-hanging/. The template coordinate space is half
// the asset dimensions so mockupRender's 2× export lands at the native 1920×2186
// resolution instead of upscaling it.
const TEE_PHOTO = '/pod-garments/tee-hanging';
const TEE_COLORWAYS = [
  { id: 'white', label: 'Vit', hex: '#f3f3f3' },
  { id: 'black', label: 'Svart', hex: '#363435' },
  { id: 'navy', label: 'Marinblå', hex: '#3e3f53' },
  { id: 'sport-grey', label: 'Gråmelerad', hex: '#a5a5a5' },
  { id: 'red', label: 'Röd', hex: '#cf0d25' },
  { id: 'royal-blue', label: 'Kungsblå', hex: '#124c8c' },
  { id: 'burgundy', label: 'Vinröd', hex: '#6a3844' },
  { id: 'sand', label: 'Sand', hex: '#d3bda5' },
  // 2026-08-18 — 4 more colourways (designer's second hanging-tee shoot, same
  // base garment/pose/framing as the original 8 — wrinkle-identity confirmed
  // by correlation probe, DM reuse is correct; see scripts commit notes).
  { id: 'lite-blue', label: 'Ljusblå', hex: '#5689ba' },
  { id: 'lite-green', label: 'Ljusgrön', hex: '#b2c085' },
  { id: 'moss-green', label: 'Mossgrön', hex: '#70694c' },
  { id: 'yellow', label: 'Gul', hex: '#eda815' },
];
const teePhotoUrls = (view) =>
  Object.fromEntries(TEE_COLORWAYS.map((c) => [c.id, `${TEE_PHOTO}/${c.id}_${view}.webp`]));

// ── HOODIE photo assets (2026-08-17, designer's hanging-hoodie set) ──────────
// hex sampled from each front photo's chest patch (chip matches the photo).
const HOODIE_PHOTO = '/pod-garments/hoodie-hanging';
const HOODIE_COLORWAYS = [
  { id: 'white', label: 'Vit', hex: '#e9e5eb' },
  { id: 'black', label: 'Svart', hex: '#222023' },
  { id: 'sporty-grey', label: 'Sporty grå', hex: '#8a8380' },
  { id: 'red', label: 'Röd', hex: '#aa1326' },
  { id: 'atoll', label: 'Atoll blå', hex: '#1097b8' },
  { id: 'azure', label: 'Azure blå', hex: '#255070' },
  { id: 'electric', label: 'Electric blå', hex: '#2b3b74' },
  { id: 'gold', label: 'Gold gul', hex: '#c0810d' },
  { id: 'orchid', label: 'Orchid grön', hex: '#97ae41' },
  { id: 'pistachio', label: 'Pistachio grön', hex: '#4f5b25' },
];
const hoodiePhotoUrls = (view) =>
  Object.fromEntries(HOODIE_COLORWAYS.map((c) => [c.id, `${HOODIE_PHOTO}/${c.id}_${view}.webp`]));

// ── LONGSLEEVE photo assets (2026-08-18, designer's hanging-longsleeve set) ──
// hex sampled from each front photo's chest patch (chip matches the photo).
const LONGSLEEVE_PHOTO = '/pod-garments/longsleeve-hanging';
const LONGSLEEVE_COLORWAYS = [
  { id: 'white', label: 'Vit', hex: '#e8e5ed' },
  { id: 'black', label: 'Svart', hex: '#2b262d' },
  { id: 'red', label: 'Röd', hex: '#ab2031' },
  { id: 'sporty-grey', label: 'Sporty grå', hex: '#a29e9f' },
  { id: 'atoll', label: 'Atoll blå', hex: '#257aa9' },
  { id: 'azure', label: 'Azure blå', hex: '#58739d' },
  { id: 'electric', label: 'Electric blå', hex: '#27326a' },
  { id: 'gold', label: 'Gold gul', hex: '#f2aa20' },
  // Fixes the designer's filename typo "Orcid grön" -> Orchid grön.
  { id: 'orchid', label: 'Orchid grön', hex: '#9fbf3b' },
  { id: 'pistachio', label: 'Pistachio', hex: '#939d70' },
  { id: 'bottle-green', label: 'Bottle grön', hex: '#3f5341' },
  { id: 'green', label: 'Grön', hex: '#969e62' },
];
const longsleevePhotoUrls = (view) =>
  Object.fromEntries(LONGSLEEVE_COLORWAYS.map((c) => [c.id, `${LONGSLEEVE_PHOTO}/${c.id}_${view}.webp`]));
// THE BLEND RULE (docs/POD_MOCKUP_TEMPLATES.md, locked 2026-08-18): multiply is
// honest ONLY on white — every non-white colourway renders 'normal', no
// per-color probing.
const LONGSLEEVE_NORMAL_COLORWAYS = {
  black: { blend: 'normal' },
  red: { blend: 'normal' },
  'sporty-grey': { blend: 'normal' },
  atoll: { blend: 'normal' },
  azure: { blend: 'normal' },
  electric: { blend: 'normal' },
  gold: { blend: 'normal' },
  orchid: { blend: 'normal' },
  pistachio: { blend: 'normal' },
  'bottle-green': { blend: 'normal' },
  green: { blend: 'normal' },
};
// RULE (revised 2026-08-18, Mikael's live-mockup verdict): multiply tints the
// WHOLE print by the garment colour, so it is honest ONLY on white — real DTG
// prints on a white underbase and looks like the artwork on every colour.
// Every NON-WHITE colourway therefore renders 'normal'; only white rides the
// multiply base (its job there: white artwork backgrounds melt into the
// fabric texture instead of showing a flat white box). Supersedes the
// 2026-08-17 light/dark borderline probing — sporty-grey dimmed the print,
// gold crushed its blues on Mikael's real artwork.
const HOODIE_DARK_COLORWAYS = {
  black: { blend: 'normal' },
  red: { blend: 'normal' },
  azure: { blend: 'normal' },
  electric: { blend: 'normal' },
  pistachio: { blend: 'normal' },
  atoll: { blend: 'normal' },
  'sporty-grey': { blend: 'normal' },
  gold: { blend: 'normal' },
  orchid: { blend: 'normal' },
};

const TEMPLATES = [
  {
    id: 'tee_bc_e150',
    label: 'T-shirt',
    profileId: 'apparel_dtg',
    // Kim's price list 2026-08-10: blank tee 60:-, stort tryck (fram/bak) 40:-,
    // pocket 20:-. The seller's cost is summed per DESIGNED slot in podPricing's
    // podCostForSlots (+ the flat platform cut), so front+back costs one print more.
    blankCostSek: sek(60),
    printCostSek: {
      front: sek(40),
      back: sek(40),
      pocket: sek(20),
      // PROVISORISKT: ärmpris ej bekräftat av tryckeriet
      left_sleeve: sek(20),
      // PROVISORISKT: ärmpris ej bekräftat av tryckeriet
      right_sleeve: sek(20),
    },
    photo: {
      w: 960,
      h: 1093,
      urls: teePhotoUrls('front'),
      backUrls: teePhotoUrls('back'),
      // Full-resolution maps registered to the 1920×2186 source photos. The
      // renderer scales the existing printAreas into this map coordinate space;
      // physical front/back dimensions and placement remain unchanged.
      displacement: {
        w: 1920,
        h: 2186,
        urls: {
          front: `${TEE_PHOTO}/white_front_dm.webp`,
          back: `${TEE_PHOTO}/white_back_dm.webp`,
        },
        // 2026-08-17 recalibration to the 3D-view keeper look (blend sheet
        // probed on white/grey/red/black): scale 30 + contrast 2 gives this
        // map (print-area sd≈24, weak) the same effective fold strength as
        // the reference 3D map (sd≈54) — ≈11px typical warp.
        scale: 30,
        blur: 6,
        contrast: 2,
        // Base = LIGHT garments: multiply inks into the fabric and vanishes
        // white artwork backgrounds (the 3D-view look). Dark/saturated
        // colourways override to 'normal' — multiply erases prints there,
        // and real DTG darks carry an opaque white underbase anyway.
        blend: 'multiply',
        alpha: 0.8,
        // RULE (revised 2026-08-18, Mikael's live-mockup verdict): multiply is
        // honest ONLY on white — it tints the whole print by the garment
        // colour (gråmelerad dimmed the artwork, sand warm-tinted it, gul
        // crushed its blues on the real album art). Every NON-WHITE colourway
        // renders 'normal' (matches DTG's white underbase); only white rides
        // the multiply base so white artwork backgrounds melt into the fabric.
        perColorway: {
          black: { blend: 'normal' },
          navy: { blend: 'normal' },
          red: { blend: 'normal' },
          'royal-blue': { blend: 'normal' },
          burgundy: { blend: 'normal' },
          'lite-blue': { blend: 'normal' },
          'lite-green': { blend: 'normal' },
          'moss-green': { blend: 'normal' },
          'sport-grey': { blend: 'normal' },
          sand: { blend: 'normal' },
          yellow: { blend: 'normal' },
        },
      },
    },
    colorways: TEE_COLORWAYS,
    // CALIBRATION (measured on the 960×1093 half-resolution coordinate space):
    // the front/back zones sit below the collar and remain inside the torso on
    // every uniformly framed colourway. Each px rect matches its mm aspect.
    printAreas: {
      // front y 365→411 (2026-08-17): Mikael's calibration — the zone sat too
      // close under the collar; +46 px = +5 cm at this template's 0.92 px/mm.
      front: { x: 365, y: 411, w: 230, h: 322 },  // 250×350 mm (5:7)
      back: { x: 340, y: 340, w: 280, h: 373 },   // 300×400 mm (3:4), back photo
      pocket: { x: 535, y: 365, w: 92, h: 92 },   // 100×100 mm
      left_sleeve: { x: 725, y: 365, w: 74, h: 74 },  // wearer LEFT = viewer right
      right_sleeve: { x: 160, y: 365, w: 74, h: 74 }, // wearer RIGHT = viewer left
    },
    // Discrete pocket positions (wearer's perspective): x offsets only, same y/w/h.
    pocketPositions: { left: { x: 535 }, center: { x: 434 }, right: { x: 333 } },
    printAreaMm: {
      front: { w: 250, h: 350 },
      back: { w: 300, h: 400 },
      pocket: { w: 100, h: 100 },
      left_sleeve: { w: 80, h: 80 },
      right_sleeve: { w: 80, h: 80 },
    },
  },
  // ── HOODIE: REAL PHOTO TEMPLATE (2026-08-17) ─────────────────────────────
  // Hanging-hoodie photos from the designer (public/images/hoddies originals),
  // 1920×2208 per view, 10 colourways, front + back. FRAMING GOTCHA: the front
  // garment is shot ~30% larger in frame than the back (front torso ≈1134 px
  // ≈ 58 cm → ~1.96 px/mm; back ≈897 px → ~1.55 px/mm) — each view's printArea
  // rect is calibrated to ITS OWN photo, so the mm math stays honest per view.
  // FRONT print band is squeezed between the hood drape and the kangaroo
  // pocket → 250×320 mm (the apparel 350 mm height physically does not fit
  // above the pocket on this garment). Back takes the full 300×400 mm.
  {
    id: 'hoodie_hanging',
    label: 'Hoodie',
    profileId: 'apparel_dtg',
    // Kim's price list 2026-08-10: blank hoodie 380:-, stort tryck 40:-, pocket 20:-.
    blankCostSek: sek(380),
    printCostSek: {
      front: sek(40),
      back: sek(40),
      pocket: sek(20),
      // PROVISORISKT: ärmpris ej bekräftat av tryckeriet
      left_sleeve: sek(20),
      // PROVISORISKT: ärmpris ej bekräftat av tryckeriet
      right_sleeve: sek(20),
    },
    photo: {
      w: 960,
      h: 1104,
      urls: hoodiePhotoUrls('front'),
      backUrls: hoodiePhotoUrls('back'),
      // Maps BAKED from the white garment (grayscale → blur σ3 → mean-centred
      // stretch to print-area sd≈40, mean 128) — the raw fleece field was far
      // too flat (sd 5 front / 13 back): a runtime contrast of ×8-10 would
      // posterize 8-bit steps into stair-step warp, so the strength lives in
      // the file and contrast stays 1. Regenerate: scratchpad hoodie-dm.mjs.
      displacement: {
        w: 1920,
        h: 2208,
        urls: {
          front: `${HOODIE_PHOTO}/white_front_dm.webp`,
          back: `${HOODIE_PHOTO}/white_back_dm.webp`,
        },
        scale: 30,
        blur: 4,
        contrast: 1,
        blend: 'multiply',
        alpha: 0.8,
        perColorway: HOODIE_DARK_COLORWAYS,
      },
    },
    colorways: HOODIE_COLORWAYS,
    // CALIBRATION (960×1104 half-res coords; overlay-verified on the white
    // photos): front centred between hood drape and kangaroo pocket.
    printAreas: {
      front: { x: 361, y: 387, w: 245, h: 313 },      // 250×320 mm
      back: { x: 366, y: 350, w: 228, h: 304 },       // 300×400 mm
      pocket: { x: 542, y: 387, w: 98, h: 98 },       // 100×100 mm
      left_sleeve: { x: 735, y: 410, w: 78, h: 78 },  // wearer LEFT = viewer right
      right_sleeve: { x: 155, y: 410, w: 78, h: 78 }, // wearer RIGHT = viewer left
    },
    pocketPositions: { left: { x: 542 }, center: { x: 434 }, right: { x: 327 } },
    printAreaMm: {
      front: { w: 250, h: 320 },
      back: { w: 300, h: 400 },
      pocket: { w: 100, h: 100 },
      left_sleeve: { w: 80, h: 80 },
      right_sleeve: { w: 80, h: 80 },
    },
  },
  // ── LONGSLEEVE: REAL PHOTO TEMPLATE (2026-08-18) ─────────────────────────
  // Hanging-longsleeve photos from the designer (public/images/LongSleeves
  // originals), 1920×2208 per view (4 of 24 shot at 2210 — symmetric 1px
  // top+bottom crop to the standard size; content-edge measurement confirmed
  // the extra rows were even head/footroom, not a framing shift), 12
  // colourways, front + back. Same hanging B&C-style shoot/framing as the
  // tee (torso extent measured at ~0.92 px/mm, matching the tee exactly).
  // Front print band sits below the collar AND the brand tag (tag runs
  // ~y245–305 on the half-res photo) — 250×350 mm fits comfortably above the
  // hem, same as the tee (this garment has no kangaroo pocket to dodge).
  {
    id: 'longsleeve_hanging',
    label: 'Långärmad',
    profileId: 'apparel_dtg',
    // Kim's price list 2026-08-10: stort tryck (fram/bak) 40:-, pocket 20:-.
    // PROVISORISKT: blank longsleeve saknas i Systemas prislista — 72:- är en
    // grov uppskattning (mellan tee 60:- och sweatshirt 159:-, ≈90 kr inkl
    // moms). Mikael bekräftar blank-pris.
    blankCostSek: 72,
    printCostSek: {
      front: sek(40),
      back: sek(40),
      pocket: sek(20),
      // PROVISORISKT: ärmpris ej bekräftat av tryckeriet
      left_sleeve: sek(20),
      // PROVISORISKT: ärmpris ej bekräftat av tryckeriet
      right_sleeve: sek(20),
    },
    photo: {
      w: 960,
      h: 1104,
      urls: longsleevePhotoUrls('front'),
      backUrls: longsleevePhotoUrls('back'),
      // Maps BAKED from the white garment (grayscale → blur σ3 → mean-centred
      // stretch to print-area sd≈45 front / 41 back, mean 128) — the raw
      // fabric field was extremely flat (sd 3.5 both views): a runtime
      // contrast multiplier would posterize 8-bit steps into stair-step warp,
      // so the strength lives in the file and contrast stays 1 (same recipe
      // as the hoodie). Same-shoot correlation probe (bandpass high-pass,
      // print-area only) confirmed all 12 colourways match the white base's
      // fold structure (front 0.44–0.82, back 0.75–0.86) EXCEPT sporty-grey
      // back (-0.03) — visually confirmed identical pose/hanger/framing; the
      // melange fabric's own dense fleck texture swamps the low-amplitude
      // fold signal at this probe sensitivity (same failure mode as the
      // tee's sport-grey and hoodie's melange colourway). Shipped as one
      // shared map — not a real shoot mismatch.
      displacement: {
        w: 1920,
        h: 2208,
        urls: {
          front: `${LONGSLEEVE_PHOTO}/white_front_dm.webp`,
          back: `${LONGSLEEVE_PHOTO}/white_back_dm.webp`,
        },
        scale: 30,
        blur: 4,
        contrast: 1,
        blend: 'multiply',
        alpha: 0.8,
        perColorway: LONGSLEEVE_NORMAL_COLORWAYS,
      },
    },
    colorways: LONGSLEEVE_COLORWAYS,
    // CALIBRATION (960×1104 half-res coords; overlay-verified on the white
    // photos; px/mm≈0.92, measured off the torso extent — matches the tee's
    // shoot exactly). Front sits below the collar seam AND the brand tag;
    // sleeve rects sit on the upper arm, clear of both the torso seam and
    // the background (axis-aligned rects fit cleanly despite the sleeve's
    // diagonal taper — verified by overlay, no need to drop the slots).
    // Fable review 2026-08-18: front/back tops LOWERED to match the tee's
    // CALIBRATED placement (Mikael's +5cm front rule: print starts a hand's
    // width below the neck seam — collar bottom ≈y300 half-res, +~92px≈100mm
    // → front y≈400; back seam ≈y230, generous hand → y≈340, matching the
    // tee's back proportion). Pocket tracks ~45px above the front top like
    // the tee (365 vs 411).
    printAreas: {
      front: { x: 360, y: 400, w: 230, h: 322 },      // 250×350 mm
      back: { x: 342, y: 340, w: 276, h: 368 },       // 300×400 mm
      pocket: { x: 530, y: 355, w: 92, h: 92 },       // 100×100 mm
      left_sleeve: { x: 700, y: 415, w: 74, h: 74 },  // wearer LEFT = viewer right
      right_sleeve: { x: 186, y: 415, w: 74, h: 74 }, // wearer RIGHT = viewer left
    },
    pocketPositions: { left: { x: 530 }, center: { x: 429 }, right: { x: 328 } },
    printAreaMm: {
      front: { w: 250, h: 350 },
      back: { w: 300, h: 400 },
      pocket: { w: 100, h: 100 },
      left_sleeve: { w: 80, h: 80 },
      right_sleeve: { w: 80, h: 80 },
    },
  },
  {
    id: 'sweatshirt_flat',
    label: 'Sweatshirt',
    garment: 'sweatshirt',
    profileId: 'apparel_dtg',
    // PROVISORISKT: sweatshirt-plagget saknas i Kims prislista — 159:- är den
    // gamla schablonen 199 minus ett stort tryck (40). Tryckpriserna delas med
    // tee/hoodie (samma ytor, samma DTG-process).
    blankCostSek: sek(159),
    printCostSek: {
      front: sek(40),
      back: sek(40),
      pocket: sek(20),
      // PROVISORISKT: ärmpris ej bekräftat av tryckeriet
      left_sleeve: sek(20),
      // PROVISORISKT: ärmpris ej bekräftat av tryckeriet
      right_sleeve: sek(20),
    },
    colorways: APPAREL_COLORWAYS,
    // Same print surfaces as the tee (spec §1: t-shirt/hoodie/sweatshirt share
    // areas). Front sits slightly lower (heavier collar), sleeves on the long
    // sleeves' upper arm. Renders on SweatshirtFlat / SweatshirtBackFlat.
    printAreas: {
      front: { x: 280, y: 230, w: 240, h: 336 },
      back: { x: 280, y: 206, w: 240, h: 320 },
      pocket: { x: 440, y: 225, w: 80, h: 80 },
      left_sleeve: { x: 644, y: 290, w: 56, h: 56 },
      right_sleeve: { x: 100, y: 290, w: 56, h: 56 },
    },
    pocketPositions: { left: { x: 440 }, center: { x: 360 }, right: { x: 280 } },
    printAreaMm: {
      front: { w: 250, h: 350 },
      back: { w: 300, h: 400 },
      pocket: { w: 100, h: 100 },
      left_sleeve: { w: 80, h: 80 },
      right_sleeve: { w: 80, h: 80 },
    },
  },

  // ── Accessories (single front surface each; spec §1) ──────────────────────
  {
    id: 'bag_flat',
    label: 'Tygkasse',
    garment: 'bag',
    // The apparel slot vocabulary calls 'front' \"Bröst\" — wrong on this
    // garment (Kent bug 2026-08-11). Studio prefers this per-template label.
    slotLabels: { front: 'Framsida' },
    profileId: 'bag_dtg',
    blankCostSek: sek(25), // Systema-prislistan 2026-08-10: Tygkasse standard 25:-
    printCostSek: { front: sek(40) }, // stort tryck
    colorways: APPAREL_COLORWAYS,
    printAreas: { front: { x: 250, y: 330, w: 300, h: 300 } }, // 1:1 ↔ 250×250 mm
    printAreaMm: { front: { w: 250, h: 250 } },
  },
  {
    id: 'cap_flat',
    label: 'Keps',
    garment: 'cap',
    // The apparel slot vocabulary calls 'front' \"Bröst\" — wrong on this
    // garment (Kent bug 2026-08-11). Studio prefers this per-template label.
    slotLabels: { front: 'Framsida' },
    profileId: 'cap_dtg',
    blankCostSek: sek(50), // Systema-prislistan 2026-08-10: Keps 50:-
    printCostSek: { front: sek(40) }, // stort tryck
    colorways: APPAREL_COLORWAYS,
    printAreas: { front: { x: 330, y: 330, w: 140, h: 100 } }, // 7:5 ↔ 70×50 mm
    printAreaMm: { front: { w: 70, h: 50 } },
  },
  {
    id: 'beanie_flat',
    label: 'Mössa',
    garment: 'beanie',
    // The apparel slot vocabulary calls 'front' \"Bröst\" — wrong on this
    // garment (Kent bug 2026-08-11). Studio prefers this per-template label.
    slotLabels: { front: 'Framsida' },
    profileId: 'beanie_dtg',
    blankCostSek: sek(50), // Systema-prislistan 2026-08-10: Mössa 50:- (Beanie-raden 40:- är en annan produkt)
    printCostSek: { front: sek(40) }, // stort tryck
    colorways: APPAREL_COLORWAYS,
    printAreas: { front: { x: 265, y: 560, w: 270, h: 120 } }, // 9:4 ↔ 90×40 mm (on the cuff)
    printAreaMm: { front: { w: 90, h: 40 } },
  },
  {
    id: 'flatcap_flat',
    label: 'Flat mössa',
    garment: 'flatcap',
    // The apparel slot vocabulary calls 'front' \"Bröst\" — wrong on this
    // garment (Kent bug 2026-08-11). Studio prefers this per-template label.
    slotLabels: { front: 'Framsida' },
    profileId: 'flatcap_dtg',
    blankCostSek: sek(59), // PROVISORISKT: flat mössa saknas i Systemas prislista
    printCostSek: { front: sek(40) }, // stort tryck
    colorways: APPAREL_COLORWAYS,
    printAreas: { front: { x: 250, y: 470, w: 300, h: 120 } }, // 10:4 ↔ 100×40 mm
    printAreaMm: { front: { w: 100, h: 40 } },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // PHOTO TEMPLATE — real photographed blank garment per colourway (later: AI-
  // generated blanks). Example only; NO photos exist yet, so it stays COMMENTED
  // OUT. A photo template has `photo` INSTEAD OF `garment`; the compositor swaps
  // only the background layer — placement math is unchanged.
  //
  // CALIBRATION (do this ONCE per photographed garment):
  //   1. Photograph the blank garment flat/front-on, SAME framing for every
  //      colourway, and upload each to Storage → note the download URL per colour.
  //      photo.w/h = the pixel dimensions of those photos (all colours share them);
  //      this IS the template's coordinate space.
  //   2. Open ONE photo in an image editor. Measure the rectangle where the print
  //      goes (chest print area) in PHOTO PIXELS: x,y of its top-left + w,h. That
  //      is printAreas.front — in photo coords, NOT the 800×900 SVG viewBox.
  //   3. printAreaMm.front = the SAME rectangle's PHYSICAL size in mm (the tryckyta
  //      the printer prints, ↔ podProfiles apparel_dtg print_area_mm). The px rect's
  //      w:h aspect MUST match the mm w:h aspect (e.g. 300×400 mm = 3:4) so preview
  //      scale ↔ physical scale stay consistent, or the artwork previews skewed.
  //   4. Every colourway needs its own photo url. A colourway without one renders a
  //      "Foto saknas" placeholder in the studio and mockup generation REJECTS it.
  // /*
  // {
  //   id: 'tee_photo_stanley',
  //   label: 'T-shirt (foto)',
  //   profileId: 'apparel_dtg',
  //   photo: {
  //     w: 2000, h: 2250,                 // photo pixel dims = coordinate space
  //     urls: {
  //       white: 'https://firebasestorage.googleapis.com/…/tee_white.jpg',
  //       black: 'https://firebasestorage.googleapis.com/…/tee_black.jpg',
  //       // navy, heather, … one url per colourway id below
  //     },
  //   },
  //   colorways: APPAREL_COLORWAYS,       // hex still drives the colour-dot chips
  //   printAreas: {                       // px rect IN PHOTO COORDS (calibrated)
  //     front: { x: 700, y: 560, w: 600, h: 800 },  // 600×800 = 3:4 ↔ 300×400 mm
  //   },
  //   printAreaMm: {
  //     front: { w: 300, h: 400 },
  //   },
  // },
  // */
];

async function main() {
  console.log('🌱 Seed POD mockup templates — settings/podMockupTemplates');
  console.log(`   templates: ${TEMPLATES.map((t) => t.id).join(', ')}`);
  console.log(`   mode:      ${COMMIT ? '🔴 COMMIT (will write)' : '🟡 DRY RUN (no write)'}`);
  console.log('');

  const ref = db.collection('settings').doc('podMockupTemplates');
  const snap = await ref.get();
  if (snap.exists && !FORCE) {
    console.log('✅ settings/podMockupTemplates already exists — nothing to do.');
    console.log('   (Pass --force to overwrite, e.g. to push updated templates.)');
    return;
  }

  const docData = {
    version: 3, // v3 2026-07-27: + pocket/sleeve areas, sweatshirt + 4 accessories (step 3)
    provisional: true, // flats are still generic drawings (mm sizes are real now)
    templates: TEMPLATES,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  console.log(`📝 ${COMMIT ? 'Writing' : 'WOULD write'} settings/podMockupTemplates:`);
  console.log(JSON.stringify({ ...docData, updatedAt: '<serverTimestamp>' }, null, 2));
  console.log('');

  if (!COMMIT) {
    console.log('🟡 Dry run complete. Re-run with --commit to write.');
    return;
  }

  await ref.set(docData, { merge: true });
  console.log('🔴 Wrote settings/podMockupTemplates.');
  console.log('   The Design Studio will now read these templates.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  });
