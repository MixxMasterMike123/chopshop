# POD mockup templates — new-garment playbook

**SSOT for adding a garment/colorway to `settings/podMockupTemplates`.**
Written 2026-08-18 after the tee/hoodie blend recalibration. Read this BEFORE
adding longsleeves or any future garment. Seed source of truth:
`scripts/seed-pod-mockup-templates.cjs` (deploy = `--force --commit` against the
named DB `b8s-reseller-db`).

## THE BLEND RULE (locked 2026-08-18, Mikael)

**`multiply` is honest ONLY on white. Every non-white colorway gets a
`perColorway: { blend: 'normal' }` override — no exceptions, no per-color
probing.**

Why: multiply composites `artwork × garment color`, i.e. it tints the whole
print by the garment. Grey dims it, sand warm-tints it, yellow/gold crush the
artwork's blues to near-black. Real DTG prints on a white underbase, so the
print looks like the artwork on every garment color — `normal` is the honest
render. Multiply survives only on white, where its one job (letting white
artwork backgrounds melt into fabric texture instead of showing a flat white
box) cannot distort anything.

History: the 2026-08-17 calibration probed a light/dark borderline per colorway
(multiply on "light" colors). That missed the tint problem because the test
motifs were red-dominant; Mikael's real album art (blues/violets) exposed it on
gråmelerad/sand/gul (tee) and sporty-grey/gold (hoodie). Superseded in
`f3fc461`. Do not resurrect luminance-based blend probing.

Template shape: keep `blend: 'multiply', alpha: 0.8` as the base and list every
non-white colorway in `perColorway` with `blend: 'normal'` (see tee_bc_e150 /
hoodie_hanging in the seed script).

## Adding a new garment (e.g. longsleeve) — checklist

1. **Photos**: hanging-style front+back per colorway from the designer
   (recent shoots arrive 1920×2208). Source JPGs stay UNTRACKED (drop under
   `public/images/<garment>/` in the primary repo); processed assets are
   COMMITTED as webp under `public/pod-garments/<garment>/` (`cwebp -q 82`,
   one consistent pixel size for the whole garment — crop stragglers to the
   standard size at measured alignment, never scale-squash).
2. **Displacement maps**: ONE map per view IF all colorways are hue-shifts of
   the same base shot — verify with a high-pass wrinkle-correlation probe
   against the white/first colorway before reusing (same range as known-good
   pairs = same shoot). A genuinely new shoot/pose needs its own maps. If raw
   maps are flat (print-area sd < ~20), BAKE them (grayscale → blur σ3 →
   mean-centred stretch to sd≈40) and keep runtime `contrast: 1` — never fix
   flat maps with runtime contrast (8-bit posterization). Target sd≈50 @
   mean~128 when authoring new maps.
3. **Blend**: apply THE BLEND RULE above. No probing needed.
4. **Calibration**: per-view `printAreas` in the photo's half-res coordinate
   space (front area must respect the garment's real print window — e.g.
   hoodie front is 250×320mm because of hood drape + kangaroo pocket);
   `printAreaMm` from `docs/POD_PRINT_SPEC.md`; verify rects with an overlay
   render on the white photos.
5. **Costs**: `blankCostSek` + `printCostSek` per slot from the printshop price
   list (values stored EX moms — see `SYSTEMA_PRICES_INCLUDE_VAT` in the seed).
6. **Hex swatches**: sample median chest-patch pixels from each colorway photo.
7. **Deploy order on schema/asset changes: HOSTING FIRST, seed second** (the
   template references asset URLs — they must resolve before the doc points at
   them). Verify with a read-back of `settings/podMockupTemplates` and a
   regenerated mockup in the studio.

## Verification on this machine

Headless Firefox cannot WebGL. Use headless **Chromium** (Playwright) against a
temporary `src/dev/studioHarness.jsx` bench (`?verify=...` pattern) for contact
sheets; delete the bench before committing. Full recipe + Pixi gotchas
(extract bug, canvas ownership, texture parking): see the
`pod-displacement-mockups` memory and the comments in
`src/wagons/pod-wagon/studio/pixi/displacementCompositor.js`.
