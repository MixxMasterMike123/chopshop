---
target: POD Design Studio (pod-wagon/studio)
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 2
timestamp: 2026-08-09T14-02-18Z
slug: src-wagons-pod-wagon-studio-designstudio-jsx
---
Method: dual-agent (A: design review sub-agent · B: detector sub-agent). Browser overlay not possible (authenticated admin + emulator data required) — fallback recorded.

# Design Health Score — 23/40 (Acceptable, lower band)

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Great micro-status (DPI verdicts, ✓ ticks); zero macro-status — no phase indicator, review gate invisible until publish |
| 2 | Match System / Real World | 3 | cm units + "sett från bäraren" excellent; "Original" jargon, "Färgväg" vs "Färger" drift |
| 3 | User Control and Freedom | 2 | Template switch silently resets design; no undo on removePrint; tab-switch wiped ALL state (P0) |
| 4 | Consistency and Standards | 3 | Token-clean except 3D section dialect (rounded-xl, bespoke dark button) |
| 5 | Error Prevention | 3 | DPI floor, clamps, combo block strong; destructive template switch unconfirmed |
| 6 | Recognition Rather Than Recall | 1 | Motif assignment = leave context, remember active row, scroll back (P0) |
| 7 | Flexibility and Efficiency | 2 | Arrow nudge + margin pricing good; no drafts/duplicate; serial mockup loop |
| 8 | Aesthetic and Minimalist Design | 2 | One endless page; 11–12px whisper type everywhere; giant Plagg cards vs tiny trycklista |
| 9 | Error Recovery | 3 | Honest, specific Swedish errors throughout |
| 10 | Help and Documentation | 1 | No step framing or onboarding; guidance only as scattered 11px hints |

## Design Specificity Verdict
Authored core (cm/DPI truth system, review gate, margin pricing), scaffolded shell: the layout was generic admin cards ignoring the 4-phase task. Detector: 0 findings both passes, but verified largely blind to Tailwind arbitrary values in JSX — low evidentiary weight. Mechanical scan: 5-step arbitrary font micro-ramp (10–14px), 320px rail + always-2-up template grid, sub-30px touch targets, zero z-index (clean layering).

## Priority Issues
- [P0] Design state destroyed on tab switch (conditional render in PodAdminPage) — following the UI's own advice loses all work. FIXED 2026-08-08: studio stays mounted (CSS hidden).
- [P0] Motif-assignment scroll round-trip to left rail. FIXED: inline motif picker in each trycklista row; rail removed.
- [P1] No row↔garment linkage. FIXED: canvas + trycklista side-by-side, ghost zone outlines (clickable) on the flat.
- [P1] One long page vs 4-phase task. FIXED: numbered sections 1 Plagg · 2 Tryck & placering · 3 Färger & mockuper · 4 Publicera; 3D moved below the colourway strip.
- [P2] Plagg picker scale. FIXED: compact auto-fill 84px grid.
- [P2] Review-gate discoverability. FIXED: "X av Y färger granskade" live counter on the strip header.
- [P3] 3D token/terminology drift. Partially fixed (Färgväg→Färg); rounded-xl dialect remains.

## Persona Red Flags
Alex: per-print scroll tax (fixed), unconfirmed template reset (open), review gate re-click burden (open), serial mockup loop (open), hero-pick silent reassign on regenerate (open).
Jordan: "listan Original" mapping failure (fixed), size opt-out matrix homework (open), review gate last-second scolding (mitigated by counter), tab-switch wipe (fixed).
Sam: pervasive 11px text (open), colour-only review ✓ (open), no aria-live on DPI verdict (fixed, role=status), pointer-only resize w/ cm-field workaround (acceptable).

## Minor Observations
"Förhandsgranskning" mislabel (fixed by numbered sections); provisional disclaimer shows forever; pocket controls materialize based on remote selection (mitigated: now same panel); MockupPanel bridge subtitle is a good pattern; "Detta trycks" receipt is the right idea.

## Questions to Consider
1. Should the studio be a full-screen route (Canva-style) instead of an admin card?
2. Should prints be added by clicking zones on the garment (direct manipulation)?
3. Is the review gate important enough to be a step, not a tick?
