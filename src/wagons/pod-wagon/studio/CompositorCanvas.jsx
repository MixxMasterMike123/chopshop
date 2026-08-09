// CompositorCanvas.jsx — the Design Studio PLACEMENT CANVAS (slice 2).
//
// Renders the garment flat with the artwork placed inside the print area, and lets
// the seller move/resize it with truth-telling feedback — the "inga tryck-
// överraskningar" contract:
//   • drag to move, corner handle to resize — always CLAMPED inside the print
//     area (the dashed safe zone; artwork can never cross it),
//   • centre-snap with guide lines (snap distance constant in SCREEN px so it
//     feels identical at every canvas size),
//   • numeric cm readout + editable cm fields ("4 cm uppifrån · centrerad") —
//     placement in physical centimetres, never inches, never just "looks right",
//   • LIVE DPI verdict on every resize, phrased against the actual print size
//     ("Blir suddigt tryckt i 24×32 cm — …"), thresholds from the print profile.
//
// Placement state is OWNED BY THE PARENT (DesignStudio keeps one placement per
// slot); this component computes a default when the parent has none yet and
// reports every interaction through onPlacementChange. All geometry/DPI math
// lives in placementMath.js (pure, shared with the slice-3 exporter).
//
// Props (CONTRACT with DesignStudio.jsx):
//   • template   — selected mockup template (podMockupTemplates): garment,
//                  colorways, printAreas (viewBox px) + printAreaMm.
//   • colorway   — selected colourway { id, label, hex }.
//   • slot       — active placement slot id ('front' | 'back' | …).
//   • artwork    — selected artwork doc (podArtwork) or null.
//   • profile    — the template's print profile (podProfiles) for DPI thresholds.
//   • placement  — { xMm, yMm, wMm } for THIS slot, or null (→ default used).
//   • onPlacementChange — (placement) => void on every move/resize/nudge.
import React, { useMemo, useRef, useState } from 'react';
import TemplateBackground, { templateViewBox } from './TemplateBackground';
import {
  MIN_ART_WIDTH_MM, SNAP_SCREEN_PX, MAX_ROTATION_DEG,
  pxPerMm, isComposable, maxWidthAtMm, maxWidthForRotationMm, maxWidthForDpiMm, clampRotationDeg,
  clampPlacement, defaultPlacement, containPlacement, snapPlacement, isCenteredX,
  placementToViewBoxRect, rectToPercent,
  formatCm, placementReadout, dpiVerdict,
} from './placementMath';

// DPI banner styling per verdict tier (admin badge tones).
const DPI_TONE = {
  PASS: 'bg-admin-success-bg text-admin-success-text',
  WARN: 'bg-admin-caution-bg text-admin-caution-text',
  FAIL: 'bg-admin-critical-bg text-admin-critical-text',
};

// Parse a Swedish cm string ("8,5" or "8.5") → mm, or null if not a number.
// Empty string is null (an emptied field means "never mind", not 0 cm).
const parseCmToMm = (s) => {
  const t = String(s).trim();
  if (!t) return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n * 10 : null;
};

// A small cm input: local text while typing, commits (onCommit(mm)) on blur/Enter,
// re-syncs from the placement whenever the committed value changes. Commits ONLY
// if the user actually edited the text since focus — pointerdown on the canvas
// preventDefault()s, so a cm field can stay focused THROUGH a drag/resize, and an
// unconditional blur-commit would then revert that gesture with the stale text.
const CmField = ({ label, mm, onCommit, disabled = false }) => {
  const committed = formatCm(mm);
  const [text, setText] = useState(committed);
  const [editing, setEditing] = useState(false);
  const focusTextRef = useRef(committed);
  const shown = editing ? text : committed;

  const commit = () => {
    setEditing(false);
    if (text === focusTextRef.current) return; // untouched → never commit stale text
    const parsed = parseCmToMm(text);
    if (parsed !== null && formatCm(parsed) !== committed) onCommit(parsed);
  };

  return (
    <label className="flex items-center gap-1.5 text-[12px] text-admin-text-muted">
      {label}
      <input
        type="text"
        inputMode="decimal"
        disabled={disabled}
        value={shown}
        onFocus={(e) => { setText(committed); focusTextRef.current = committed; setEditing(true); e.target.select(); }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        className="w-16 rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-2 py-1 text-right text-[12px] text-admin-text focus:outline-none focus:border-admin-info-dot focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)] disabled:opacity-50"
      />
      <span className="text-admin-text-muted">cm</span>
    </label>
  );
};

// Rotation input (degrees, small adjustments): same commit semantics as CmField
// (local text while typing, commit on blur/Enter only if actually edited).
const DegField = ({ label, deg, onCommit, disabled = false }) => {
  const fmtDeg = (v) => {
    const s = (Math.round((v || 0) * 10) / 10).toFixed(1).replace('.', ',');
    return s.endsWith(',0') ? s.slice(0, -2) : s;
  };
  const committed = fmtDeg(deg);
  const [text, setText] = useState(committed);
  const [editing, setEditing] = useState(false);
  const focusTextRef = useRef(committed);
  const shown = editing ? text : committed;

  const commit = () => {
    setEditing(false);
    if (text === focusTextRef.current) return;
    const n = Number(String(text).trim().replace(',', '.'));
    if (Number.isFinite(n) && fmtDeg(clampRotationDeg(n)) !== committed) onCommit(clampRotationDeg(n));
  };

  return (
    <label className="flex items-center gap-1.5 text-[12px] text-admin-text-muted">
      {label}
      <input
        type="text"
        inputMode="decimal"
        disabled={disabled}
        value={shown}
        title={`−${MAX_ROTATION_DEG}° till ${MAX_ROTATION_DEG}°`}
        onFocus={(e) => { setText(committed); focusTextRef.current = committed; setEditing(true); e.target.select(); }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        className="w-14 rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-2 py-1 text-right text-[12px] text-admin-text focus:outline-none focus:border-admin-info-dot focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)] disabled:opacity-50"
      />
      <span className="text-admin-text-muted">°</span>
    </label>
  );
};

const CompositorCanvas = ({
  template, colorway, slot = 'front', artwork = null, profile = null,
  placement = null, onPlacementChange = () => {},
  // locked: fixed-geometry slots (pocket — POD_PRINT_SPEC: discrete position,
  // no free placement). Renders the default placement read-only: no drag,
  // resize, nudge or cm fields; readout + DPI verdict stay.
  locked = false,
  // ghostAreas: other DESIGNED slots on the SAME flat — [{ slot, label, rect }]
  // in viewBox px. Dashed outlines that link the trycklista's rows to their
  // physical zones; clicking one calls onGhostClick(slot) to activate it.
  ghostAreas = [],
  onGhostClick = null,
}) => {
  const wrapRef = useRef(null);
  // Full drag data in a ref (no re-render churn mid-gesture); visual flags in state.
  const dragRef = useRef(null);
  const [dragUi, setDragUi] = useState(null); // { mode, snappedX, snappedY } | null

  const viewBox = templateViewBox(template);
  const areaRect = template?.printAreas?.[slot] || null;
  const areaMm = template?.printAreaMm?.[slot] || null;
  const ppm = template ? pxPerMm(template, slot) : null;

  const composable = isComposable(artwork);
  // Hard resolution floor (docs/POD_PRINT_SPEC.md): the artwork can never be
  // scaled past the width where placement DPI drops below the profile minimum.
  const minDpi = profile?.min_dpi ?? null;

  // The placement we render: locked slots always show the deterministic
  // contain-centred rect (parent placement ignored); free slots show the
  // parent's placement, or the default until first touched.
  const effective = useMemo(() => {
    if (!composable || !template || !ppm) return null;
    if (locked) return containPlacement(template, slot, artwork, minDpi);
    return placement
      ? clampPlacement(placement, template, slot, artwork, minDpi)
      : defaultPlacement(template, slot, artwork, minDpi);
  }, [composable, template, slot, artwork, placement, ppm, minDpi, locked]);

  const verdict = effective ? dpiVerdict(effective, artwork, profile) : null;

  // ── pointer interaction ────────────────────────────────────────────────────
  // Screen px → physical mm at the current render scale (wrapper width ↔ viewBox).
  const screenPxToMm = () => {
    const box = wrapRef.current?.getBoundingClientRect();
    if (!box || !box.width || !ppm) return null;
    const vbPerScreenPx = viewBox.w / box.width;
    return { x: vbPerScreenPx / ppm.x, y: vbPerScreenPx / ppm.y };
  };

  const startDrag = (e, mode) => {
    if (!effective || locked) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return; // primary button only
    e.preventDefault();
    e.stopPropagation();
    // Capture can throw if the pointer vanished between down and here (and for
    // synthetic test events) — the drag still works without capture, so ignore.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
    dragRef.current = {
      mode,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      start: effective,
    };
    setDragUi({ mode, snappedX: false, snappedY: false });
  };

  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const scale = screenPxToMm();
    if (!scale) return;
    const dxMm = (e.clientX - d.startClientX) * scale.x;
    const dyMm = (e.clientY - d.startClientY) * scale.y;

    if (d.mode === 'move') {
      let next = { ...d.start, xMm: d.start.xMm + dxMm, yMm: d.start.yMm + dyMm };
      // x-axis scale for both axes: templates keep px:mm uniform (aspect-matched
      // rects), and snap only ever equalizes to the exact centre — a skewed
      // threshold can nudge feel, never the numbers.
      const thresholdMm = SNAP_SCREEN_PX * scale.x;
      const snapped = snapPlacement(next, template, slot, artwork, thresholdMm);
      next = clampPlacement(snapped.placement, template, slot, artwork, minDpi);
      setDragUi({ mode: 'move', snappedX: snapped.snappedX, snappedY: snapped.snappedY });
      onPlacementChange(next);
    } else {
      // Resize from the bottom-right handle: top-left stays ANCHORED (the artwork
      // never slides during a resize), so the max width is bounded by the space
      // remaining from the anchor — not the whole area. A rotated motif is also
      // capped by its ROTATED bounding box fitting the area (clamp fixes residue).
      const wCap = Math.min(
        maxWidthAtMm(d.start, template, slot, artwork),
        maxWidthForRotationMm(template, slot, artwork, d.start.rotationDeg || 0),
        maxWidthForDpiMm(artwork, minDpi) // hard DPI floor
      );
      const wMm = Math.min(Math.max(d.start.wMm + dxMm, Math.min(MIN_ART_WIDTH_MM, wCap)), wCap);
      onPlacementChange({ ...d.start, wMm });
    }
  };

  // pointerup / pointercancel / lostpointercapture all end the gesture — touch
  // scrolling or a revoked capture must never leave a stuck drag.
  const endDrag = (e) => {
    const d = dragRef.current;
    if (!d || (e && e.pointerId !== d.pointerId)) return;
    dragRef.current = null;
    setDragUi(null);
  };

  // Keyboard nudge on the focused artwork: arrows = 1 mm, Shift+arrows = 10 mm.
  const onKeyDown = (e) => {
    if (!effective || locked) return;
    const step = e.shiftKey ? 10 : 1;
    const delta = {
      ArrowLeft: { xMm: -step }, ArrowRight: { xMm: step },
      ArrowUp: { yMm: -step }, ArrowDown: { yMm: step },
    }[e.key];
    if (!delta) return;
    e.preventDefault();
    onPlacementChange(clampPlacement(
      { ...effective, xMm: effective.xMm + (delta.xMm || 0), yMm: effective.yMm + (delta.yMm || 0) },
      template, slot, artwork, minDpi
    ));
  };

  // Commit helpers for the numeric cm fields (parse → clamp → parent).
  const commitField = (patch) => {
    if (!effective) return;
    onPlacementChange(clampPlacement({ ...effective, ...patch }, template, slot, artwork, minDpi));
  };
  const centerX = () => {
    if (!effective || !areaMm) return;
    onPlacementChange(clampPlacement(
      { ...effective, xMm: (areaMm.w - effective.wMm) / 2 },
      template, slot, artwork, minDpi
    ));
  };

  // ── render ─────────────────────────────────────────────────────────────────
  if (!template || !viewBox) {
    return (
      <div className="grid aspect-[8/9] w-full max-w-[520px] place-items-center rounded-[var(--radius-admin)] border border-dashed border-admin-border bg-admin-surface-2 text-[13px] text-admin-text-muted">
        Välj en mall för att förhandsgranska.
      </div>
    );
  }

  // Artwork rect in viewBox px (placement mm → px via the template's px↔mm map).
  const artVb = effective ? placementToViewBoxRect(effective, template, slot, artwork) : null;

  const dragging = Boolean(dragUi);

  return (
    <div>
      <div ref={wrapRef} className="relative mx-auto w-full max-w-[520px] select-none">
        {/* Garment background — SVG flat or per-colourway photo (placeholder when
            a photo colourway has no photo yet; artwork placement still works). */}
        <TemplateBackground template={template} colorway={colorway} slot={slot} />

        {/* Print area (safe zone) with its physical size labelled in cm. */}
        {areaRect && (
          <div
            className="pointer-events-none absolute rounded-[4px] border-2 border-dashed border-admin-info-dot/70"
            style={rectToPercent(areaRect, viewBox)}
          >
            {areaMm && (
              <span className="absolute -top-6 right-0 whitespace-nowrap rounded-[6px] bg-admin-surface/85 px-1.5 py-0.5 text-[11px] text-admin-text-muted">
                Tryckyta {formatCm(areaMm.w)} × {formatCm(areaMm.h)} cm
              </span>
            )}
            {/* Hints INSIDE the zone when there is nothing to place. */}
            {!artwork && (
              <div className="flex h-full w-full items-center justify-center p-2 text-center">
                <span className="rounded-[6px] bg-admin-surface/85 px-2 py-1 text-[11px] font-medium text-admin-text-muted shadow-[var(--shadow-admin)]">
                  Lägg till ett tryck och välj motiv i trycklistan
                </span>
              </div>
            )}
            {artwork && !composable && (
              <div className="flex h-full w-full items-center justify-center p-3 text-center">
                <span className="rounded-[6px] bg-admin-surface/90 px-2.5 py-1.5 text-[11px] text-admin-text-muted shadow-[var(--shadow-admin)]">
                  Originalet kan inte förhandsgranskas i studion (bildmått saknas för formatet).
                  Använd PNG eller JPEG för mockuper.
                </span>
              </div>
            )}
          </div>
        )}

        {/* Ghost zones — other designed prints on this flat, as clickable
            dashed outlines (the row↔garment linkage). */}
        {ghostAreas.map((g) => (
          <button
            key={g.slot}
            type="button"
            onClick={onGhostClick ? () => onGhostClick(g.slot) : undefined}
            title={`Visa ${g.label}`}
            aria-label={`Visa trycket: ${g.label}`}
            className={`absolute rounded-[4px] border border-dashed border-admin-text-faint/60 ${
              onGhostClick ? 'cursor-pointer hover:border-admin-info-dot hover:bg-admin-info-bg/20' : 'pointer-events-none'
            }`}
            style={rectToPercent(g.rect, viewBox)}
          >
            <span className="absolute left-1 top-1 rounded-[4px] bg-admin-surface/85 px-1 py-0.5 text-[11px] text-admin-text-muted">
              {g.label}
            </span>
          </button>
        ))}

        {/* Centre guides — visible only while a drag is snapped to that axis. */}
        {dragUi?.snappedX && areaRect && (
          <div
            className="pointer-events-none absolute w-px bg-admin-info-dot"
            style={{
              left: `${((areaRect.x + areaRect.w / 2) / viewBox.w) * 100}%`,
              top: `${(areaRect.y / viewBox.h) * 100}%`,
              height: `${(areaRect.h / viewBox.h) * 100}%`,
            }}
          />
        )}
        {dragUi?.snappedY && areaRect && (
          <div
            className="pointer-events-none absolute h-px bg-admin-info-dot"
            style={{
              top: `${((areaRect.y + areaRect.h / 2) / viewBox.h) * 100}%`,
              left: `${(areaRect.x / viewBox.w) * 100}%`,
              width: `${(areaRect.w / viewBox.w) * 100}%`,
            }}
          />
        )}

        {/* The placed artwork: drag to move, corner handle to resize, arrows to
            nudge. touch-action:none so touch drags aren't hijacked by scrolling. */}
        {artVb && (
          <div
            role={locked ? 'img' : 'button'}
            tabIndex={locked ? -1 : 0}
            aria-label={locked
              ? `Motiv: ${placementReadout(effective, template, slot, artwork)}. Fast yta — placeringen kan inte ändras.`
              : `Motiv: ${placementReadout(effective, template, slot, artwork)}. Flytta med piltangenterna (Skift = 1 cm steg).`}
            className={`absolute outline-none ring-admin-info-dot/60 focus-visible:ring-2 ${
              locked ? 'cursor-default' : `touch-none ${dragging && dragUi.mode === 'move' ? 'cursor-grabbing' : 'cursor-grab'}`
            }`}
            style={{
              ...rectToPercent(artVb, viewBox),
              transform: `rotate(${effective.rotationDeg || 0}deg)`,
              transformOrigin: 'center',
            }}
            onPointerDown={(e) => startDrag(e, 'move')}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
            onKeyDown={onKeyDown}
          >
            <img
              src={artwork.previewUrl}
              alt=""
              draggable={false}
              className="h-full w-full object-fill"
            />
            {/* Hairline so a white artwork on a white tee still shows its bounds. */}
            <div className="pointer-events-none absolute inset-0 border border-admin-info-dot/50" />
            {/* Resize handle (bottom-right): generous hit target, small visual. */}
            {!locked && (
              <div
                role="presentation"
                className="absolute -bottom-4 -right-4 grid h-8 w-8 cursor-nwse-resize touch-none place-items-center"
                onPointerDown={(e) => startDrag(e, 'resize')}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onLostPointerCapture={endDrag}
              >
                <div className="h-2.5 w-2.5 rounded-[2px] border border-admin-info-dot bg-admin-surface shadow-[var(--shadow-admin)]" />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Placement panel: cm readout + numeric fields + live DPI verdict ── */}
      {effective && (
        <div className="mx-auto mt-3 w-full max-w-[520px]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12px] font-medium text-admin-text">
              {placementReadout(effective, template, slot, artwork)}
            </span>
            <span className="text-[11px] text-admin-text-muted">Mått inom tryckytan</span>
          </div>

          {locked ? (
            <p className="mt-2 text-[12px] text-admin-text-muted">
              Fast tryckyta — motivet placeras automatiskt (contain, centrerat). Välj position ovan.
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
              <CmField
                label="Bredd"
                mm={effective.wMm}
                onCommit={(mm) => commitField({ wMm: mm })}
              />
              <CmField
                label="Uppifrån"
                mm={effective.yMm}
                onCommit={(mm) => commitField({ yMm: mm })}
              />
              <CmField
                label="Från vänster"
                mm={effective.xMm}
                onCommit={(mm) => commitField({ xMm: mm })}
              />
              <DegField
                label="Rotation"
                deg={effective.rotationDeg || 0}
                onCommit={(deg) => commitField({ rotationDeg: deg })}
              />
              <button
                type="button"
                onClick={centerX}
                disabled={isCenteredX(effective, template, slot)}
                className="rounded-[var(--radius-admin-el)] border border-admin-border px-2.5 py-1 text-[12px] text-admin-text hover:bg-admin-surface-2 disabled:cursor-default disabled:opacity-40"
              >
                Centrera
              </button>
            </div>
          )}

          {verdict && (
            // role="status": a screen-reader user editing the cm fields hears
            // the DPI verdict change ("Blir suddigt tryckt") without refocusing.
            // Suspended DURING drags — announcing every pointermove frame would
            // queue dozens of readouts; the final verdict announces on release.
            <div role={dragging ? undefined : 'status'} className={`mt-3 rounded-[var(--radius-admin-el)] px-3 py-2 text-[12px] ${DPI_TONE[verdict.tier]}`}>
              {verdict.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default CompositorCanvas;
