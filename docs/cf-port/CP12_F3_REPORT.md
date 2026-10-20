Model: claude-opus-5-5

# CP12 F3 — the studio's "Nytt tryck" (framed posters)

Worktree `cp12-prints` on 809d91ad, working tree only (no git write). F2 edited `cloudflare/**` and `scripts/` at the same time; none of my files were touched by anyone else.

## Removed controls

None. The garment studio has every control it had. A flat print has no print surfaces, colour review, per-colour overrides, 3D view or fabric tuning; those were never added to it (design §4).

## What was built

- **Entry.** `DesignStudio.jsx` now default-exports `StudioEntry`. It shows a "Nytt plagg / Nytt tryck" switch only when the build has `STUDIO_FLAGS.flatPrints` and a printer offers a flat model. Both studios stay mounted and hidden, not unmounted. The garment component itself is unchanged. The older build has `flatPrints: false`, so it renders the garment studio alone, as before.
- **The five steps** (`studio/flat/FlatStudio.jsx`):
  1. **Produkt.** Tiles by `garment`. Vykort and Klistermärke are greyed with "Kommer senare". You can choose the finish (ram) and the printer when there are several. Each size shows the server's Inköp from the design quote (`slots=front`).
  2. **Motiv.** The library, each tile saying how many sizes the motif reaches. Each size gets ✓ or "För låg upplösning (minst W×H px)", and only reachable sizes can be ticked (all reachable ones start ticked).
  3. **Placering.** A Pixi sheet (`flat/flatPixi.js`) that falls back to a 2D canvas when WebGL cannot start. An SVG overlay in admin tokens marks the 3 mm bleed and a 10 mm safe area. Choices are Fyll arket / Hela motivet, and for contain a background colour (white by default, three swatches plus a custom colour). There is a size switcher, no rotation, one motif.
  4. **Förhandsvisning.** A **drawn framed preview** (`flat/flatRender.js`), one per ticked size; you pick the main image. It is not the template renderer, because a template has one print area while a poster family has one aspect per size. A photo template needs the mechanism to know per-size areas (a flat kind).
  5. **Publicera.** The existing PublishPanel. The finish is its one colour, the ticked sizes are the variants, and each variant gets its article preselected. The mapping freezes `{fit, background}`.
- **Data layer.**
  - `adapters/studioFlat.js` (new): the families, the per-size check, the geometry and the mapping body. Tested in `studioFlat.test.mjs` (31 tests).
  - `adapters/studio.js`: flat models are kept out of the garment routing, and `planScopeMappings` compares placement.
  - `podPrintRouting.js` returns `flat`; `podStudioData.js` gets `quoteFlatSize` and passes `ctx.flatPlacement`; `podStudioPublish.js` posts flat slots as objects.
  - `PublishPanel.jsx` gets two defaulted props, `sizeOptions` and `allowExisting`.
- **Dev mock.** A poster printer `dev-prints` (four sizes) in `dev/pod-fixtures.json`. `dev/pod-dev.mjs` now projects `kind`, accepts slot objects and applies the reach rule.

## Screens (`docs/cf-port/shots/cp12-f3/`)

These were rendered with the local dev API, not staging: staging has no flat printer yet. The headless browser has no WebGL, so step 3 shows the 2D fallback.

- `00-entry-switch.png`, `00-entry-garment.png`
- `01-produkt.png`
- `02-motiv.png`
- `03-placering-contain.png`, `03b-placering-cover-for-litet.png`, `03c-placering-cover.png`
- `04-forhandsvisning.png`
- `05-publicera.png`, `05b-publicerad.png`

A poster was published end to end on the dev API, and its mappings were stored with `fit: "cover"`.

## Contract: what I assumed, checked against F2's tree at the end

- **Tenant view.** `kind: "flat"` and `printAreasMm.front.px`. F2's `tenantPrinterView` matches.
- **Mapping write.** `slots: [{ slot: "front", fit, background? }]`. I first built top-level `fit`/`background`, then aligned to F2's `parseCreateMappingInput`. The contract text does not fix this shape, and F2's code is now what decides it.
- **Resolution rule.** F2's `flatReachesPx`: contain needs one axis to reach, cover needs both. `flatQualifies` is fit-aware and tested equal to that rule. Step 2 checks at contain; step 3 blocks cover where the motif cannot fill a ticked size.
- **Default fit.** `contain`, matching F2's `DEFAULT_FLAT_FIT`.

## Deviations

- The flat UI imports the pure `admin-app/adapters/studioFlat.js` directly from `src/wagons`. It is lazy-loaded, so the older build only emits a chunk for it.
- I edited `dev/pod-dev.mjs` and `dev/pod-fixtures.json` (the studio's dev harness). The 139 dev tests stay green.
- Variant sizes are written without the unit ("30 × 40"). `variantDerivation` upper-cases sizes, so "cm" would have become "CM".
- Only one product image is published per product: the chosen size's preview.

## Open questions

1. The price is per finish row, not per size. The floor shown is the strictest over the ticked sizes (for example 352 kr over 238–263 kr Inköp). Should each size get its own price? (F4)
2. "Uppdatera befintlig produkt" is hidden for prints.
3. Should the bleed/safe values (3/10 mm) and a photographic poster template be confirmed with Prodigi?

## Gates

- `node --test src/admin-app/adapters/*.test.mjs`: 438 pass, 0 fail.
- Adapters, replacements and dev together: 730 pass, 0 fail.
- `node cloudflare/admin/check-admin-build.mjs`: "no Firebase code, no source map, no secret, every file servable".
- `npx vite build` (the older build): built.
- `node guard/guards.test.mjs`: PASS.
- The `node_modules` link is removed.

## Follow-up (after F2's report)

- **Refusal texts.** `adapters/pod.js` has `placement_unsupported` (new) and `resolution_too_low` (reworded to cover a sheet size). `adapters/product.js` has `pod_resolution_too_low`. Each has a test line. The dev mock now refuses with `resolution_too_low`, as the Worker does.
- **Re-post on a placement change.**
  - `planScopeMappings` now treats a mapping as unchanged only when fit AND background match. An absent background counts as white, the Worker's default.
  - A mapping that differs in either is deleted and posted again; F2 says a re-post re-activates the mapping and overwrites its slots.
  - Under cover the studio now freezes `background: "#ffffff"` explicitly, which is what the studio draws, because F2 stores a background under both fits.
- **Gates re-run.**
  - Adapter tests: 441 pass, 0 fail.
  - Replacements and dev tests: 290 pass, 0 fail.
  - `check-admin-build`: clean.
  - The `node_modules` link is removed again.

## Codex round 1

**P1, a failed draft could be continued by the other studio.**
- **Drafts per design.** `podStudioPublish.js` remembers a failed publish's draft per shop and design. The garment studio keeps one key per tab; "Nytt tryck" uses `flat:<id>`, made once per FlatStudio mount and passed through `podStudioData` as `ctx.runKey`. A poster publish therefore never continues the garment studio's draft, and the reverse holds too.
- **One save per shop.** Both studios now refuse to start a save while another runs in the same shop, with `PUBLISH_BUSY_MSG`. This applies to `publishNewDesign` and `updateExistingFromDesign`.
- **When the hold ends.** It is released when the save settles. It is also released as soon as the tab is seen on another shop, because a save whose shop the tab left never settles (`readForShop` drops its answers).
- **Tests.** Two new cases in `podStudioPublish.test.mjs`: a garment draft stays untouched while a poster is published as its own product, and a second save while one runs is refused without sending any request.

**P2, a stale preview could be published.**
- `FlatStudio` now keeps a design revision (`createRevision` in `adapters/studioFlat.js`, with a test).
- Every design change (fit, background, motif, sizes, finish) bumps the revision. A framed-preview render keeps the revision it started at and installs its images only if that revision is still current; otherwise it revokes them.
- Step 4 then renders again from the current design.

**Gates.**
- Adapter, replacement and dev tests together: 734 pass, 0 fail.
- `check-admin-build`: clean.
- Older `vite build`: built.
- Guards: PASS.
- The `node_modules` link is removed.
