// BeanieFlat.jsx — front-view flat illustration of a knit beanie.
//
// Garment flat (technical product drawing) used as the mockup base. The compositor
// overlays the artwork print area; the SVG draws NO print area itself.
//
// A classic cuffed beanie: a knitted dome with subtle vertical knit lines, sitting
// on a WIDE folded cuff band at the bottom. The cuff is the interesting part here —
// it is where embroidery/print actually goes on a beanie, so it is drawn generously
// tall and the print area lands squarely on it.
//
// Props:
//   • color   — the beanie fill (white #ffffff → black #1a1a1a). A subtle grey
//               stroke + soft inner shadow keeps a white beanie visible on a white
//               admin canvas.
//   • className / style / ...rest — passed to the root <svg>.
//
// viewBox is 800×900 (BEANIE_VIEWBOX). Silhouette coordinate ranges:
//   • dome spans x230..570 at the cuff line and rises to y≈196 at the crown
//   • cuff fold line (dome bottom / cuff top) at y=540
//   • cuff band spans x222..578 and runs y540..710, with slightly rounded corners
//   • vertical knit lines run down the dome only (y≈230..535), stopping at the cuff
// Print area {x:265, y:560, w:270, h:120} → spans x265..535, y560..680.
//   • Vertically: 20 below the cuff fold line (y540) and 30 above the cuff bottom
//     (y710) — fully inside the band.
//   • Horizontally: the cuff spans x222..578, so there are 43 units of margin per
//     side. Fully on the cuff band.
import React from 'react';

export const BEANIE_VIEWBOX = { w: 800, h: 900 };

const OUTLINE = '#9aa0a6';

const BeanieFlat = ({ color = '#ffffff', className = '', style, ...rest }) => {
  const uid = React.useMemo(() => `beanie-${Math.random().toString(36).slice(2, 8)}`, []);
  const shadowId = `${uid}-shadow`;

  // Dome: from the left cuff-line corner (230,540) up over the crown (400,196)
  // and back down to (570,540), closed along the fold line y540.
  const domePath = `
    M 230 540
    C 224 356, 296 196, 400 196
    C 504 196, 576 356, 570 540
    Z
  `;

  // Folded cuff band: a wide rounded rectangle slightly wider than the dome,
  // y540..710. This is the print surface.
  const cuffPath = `
    M 240 540
    L 560 540
    C 570 540, 578 548, 578 558
    L 578 692
    C 578 702, 570 710, 560 710
    L 240 710
    C 230 710, 222 702, 222 692
    L 222 558
    C 222 548, 230 540, 240 540
    Z
  `;

  return (
    <svg
      viewBox={`0 0 ${BEANIE_VIEWBOX.w} ${BEANIE_VIEWBOX.h}`}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      role="img"
      aria-label="Mössa (framvy)"
      {...rest}
    >
      <defs>
        <radialGradient id={shadowId} cx="50%" cy="42%" r="70%">
          <stop offset="0%" stopColor="#000000" stopOpacity="0" />
          <stop offset="80%" stopColor="#000000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.12" />
        </radialGradient>
      </defs>

      {/* ── Dome ────────────────────────────────────────────────────────────*/}
      <path
        d={domePath}
        fill={color}
        stroke={OUTLINE}
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path d={domePath} fill={`url(#${shadowId})`} pointerEvents="none" />

      {/* Subtle vertical knit lines — dome only, stopping short of the cuff fold
          so they never run into the print area. */}
      <path d="M 400 200 L 400 535" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.35" />
      <path d="M 348 210 C 340 320, 336 430, 334 535" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.32" />
      <path d="M 452 210 C 460 320, 464 430, 466 535" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.32" />
      <path d="M 300 248 C 284 348, 276 442, 272 535" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.28" />
      <path d="M 500 248 C 516 348, 524 442, 528 535" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.28" />

      {/* ── Folded cuff band ────────────────────────────────────────────────
          Drawn after the dome so the fold line reads as the cuff overlapping it. */}
      <path
        d={cuffPath}
        fill={color}
        stroke={OUTLINE}
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path d={cuffPath} fill={`url(#${shadowId})`} pointerEvents="none" />

      {/* Fold crease at the top of the cuff. */}
      <path d="M 226 552 L 574 552" fill="none" stroke={OUTLINE} strokeWidth="2" opacity="0.45" />
    </svg>
  );
};

export default BeanieFlat;
