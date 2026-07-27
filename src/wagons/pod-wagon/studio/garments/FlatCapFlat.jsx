// FlatCapFlat.jsx — front-view flat illustration of a "flat mössa" (docker /
// fisherman-style knit cap, WITHOUT a fold).
//
// Garment flat (technical product drawing) used as the mockup base. The compositor
// overlays the artwork print area; the SVG draws NO print area itself.
//
// The difference from BeanieFlat: no folded cuff, and the dome is SHALLOWER — a
// docker cap sits close to the head, so the crown is a low, wide arc rather than a
// tall knitted dome. It finishes in a short ribbed brim edge at the bottom instead
// of a deep turn-up.
//
// Props:
//   • color   — the cap fill (white #ffffff → black #1a1a1a). A subtle grey stroke
//               + soft inner shadow keeps a white cap visible on a white canvas.
//   • className / style / ...rest — passed to the root <svg>.
//
// viewBox is 800×900 (FLAT_CAP_VIEWBOX). Silhouette coordinate ranges:
//   • crown spans x214..586 and rises only to y≈300 at the top — roughly half the
//     height of the beanie dome (which peaked at y196), giving the shallow docker
//     profile
//   • band seam (crown → lower band) at y=440
//   • lower band runs y440..640, spanning x210..590, and ends in the short ribbed
//     brim edge (a seam at y=610 with rib ticks down to the hem y640)
//   • horizontal knit courses cross the crown at y≈350 and y≈400
// Print area {x:250, y:470, w:300, h:120} → spans x250..550, y470..590 (10:4 for
// a 100×40 mm band print).
//   • Vertically: 30 below the band seam (y440) and 20 above the ribbed brim seam
//     (y610) — inside the plain part of the lower band.
//   • Horizontally: the band spans x210..590, so 40 units of margin on each side.
import React from 'react';

export const FLAT_CAP_VIEWBOX = { w: 800, h: 900 };

const OUTLINE = '#9aa0a6';

const FlatCapFlat = ({ color = '#ffffff', className = '', style, ...rest }) => {
  const uid = React.useMemo(() => `flatcap-${Math.random().toString(36).slice(2, 8)}`, []);
  const shadowId = `${uid}-shadow`;

  // Whole cap as ONE silhouette: shallow crown arc from the left band corner
  // (214,440) over the top (400,300) to (586,440), then straight down the sides of
  // the lower band to the hem (y640) with small corner radii.
  const capPath = `
    M 214 440
    C 212 356, 296 300, 400 300
    C 504 300, 588 356, 586 440
    L 590 616
    C 590 630, 580 640, 566 640
    L 234 640
    C 220 640, 210 630, 210 616
    Z
  `;

  return (
    <svg
      viewBox={`0 0 ${FLAT_CAP_VIEWBOX.w} ${FLAT_CAP_VIEWBOX.h}`}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      role="img"
      aria-label="Flat mössa (framvy)"
      {...rest}
    >
      <defs>
        <radialGradient id={shadowId} cx="50%" cy="44%" r="70%">
          <stop offset="0%" stopColor="#000000" stopOpacity="0" />
          <stop offset="80%" stopColor="#000000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.12" />
        </radialGradient>
      </defs>

      {/* ── Cap silhouette ──────────────────────────────────────────────────*/}
      <path
        d={capPath}
        fill={color}
        stroke={OUTLINE}
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path d={capPath} fill={`url(#${shadowId})`} pointerEvents="none" />

      {/* Knit courses across the shallow crown — kept ABOVE the band seam (y440)
          so nothing runs into the print area. */}
      <path d="M 224 350 C 300 322, 500 322, 576 350" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.3" />
      <path d="M 217 400 C 300 380, 500 380, 583 400" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.3" />

      {/* Band seam where the crown meets the lower band — the print area's top edge
          (y470) sits 30 below this. */}
      <path d="M 214 440 L 586 440" fill="none" stroke={OUTLINE} strokeWidth="2.5" opacity="0.75" />

      {/* ── Short ribbed brim edge ──────────────────────────────────────────
          Seam at y610 + short parallel rib ticks down to the hem (y640). */}
      <path d="M 211 610 L 589 610" fill="none" stroke={OUTLINE} strokeWidth="2.5" opacity="0.8" />
      <path d="M 252 612 L 252 638" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.42" />
      <path d="M 302 612 L 302 638" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.42" />
      <path d="M 352 612 L 352 638" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.42" />
      <path d="M 400 612 L 400 638" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.42" />
      <path d="M 448 612 L 448 638" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.42" />
      <path d="M 498 612 L 498 638" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.42" />
      <path d="M 548 612 L 548 638" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.42" />
    </svg>
  );
};

export default FlatCapFlat;
