// BagFlat.jsx — front-on flat illustration of a canvas tote bag.
//
// Garment flat (technical product drawing) used as the mockup base. The compositor
// overlays the artwork print area; the SVG draws NO print area itself.
//
// The tote's print area is large (25×25 cm), so the bag body deliberately fills
// most of the 800×900 box: a rectangular-ish body with a slightly tapered top
// (the opening is a touch narrower than the base, as a filled tote hangs), a top
// hem stitch line, and two strap handles arcing up from the top edge.
//
// Props:
//   • color   — the bag body fill (white #ffffff → black #1a1a1a). A subtle grey
//               stroke + soft inner shadow keeps a white tote visible on a white
//               admin canvas.
//   • className / style / ...rest — passed to the root <svg>.
//
// viewBox is 800×900 (BAG_VIEWBOX). Silhouette coordinate ranges:
//   • top edge (opening) y=250, spanning x180..620
//   • sides taper gently outward to x168..632 at the base
//   • base y=810, with small corner radii
//   • top hem stitch line at y=286; the handle band roots at x250..284 and
//     x516..550 and arcs up to y≈100 — entirely ABOVE the body, so it never
//     crosses the print area
// Print area {x:250, y:330, w:300, h:300} → spans x250..550, y330..630.
//   • Left/right: body edges at that height are x≈176/624 → ≥74 units of margin.
//   • Top: 44 below the hem stitch line (y286) and 80 below the opening (y250).
//   • Bottom: 180 above the base (y810). Fully on the bag body.
import React from 'react';

export const BAG_VIEWBOX = { w: 800, h: 900 };

const OUTLINE = '#9aa0a6';

const BagFlat = ({ color = '#ffffff', className = '', style, ...rest }) => {
  const uid = React.useMemo(() => `bag-${Math.random().toString(36).slice(2, 8)}`, []);
  const shadowId = `${uid}-shadow`;

  // Body as ONE silhouette: opening (y250) → right side tapering out to x616 →
  // base (y810) → left side back up to x196. Symmetric about x=400.
  const bodyPath = `
    M 180 250
    L 620 250
    L 632 786
    C 632 800, 622 810, 608 810
    L 192 810
    C 178 810, 168 800, 168 786
    Z
  `;

  return (
    <svg
      viewBox={`0 0 ${BAG_VIEWBOX.w} ${BAG_VIEWBOX.h}`}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      role="img"
      aria-label="Tygkasse (framvy)"
      {...rest}
    >
      <defs>
        <radialGradient id={shadowId} cx="50%" cy="42%" r="70%">
          <stop offset="0%" stopColor="#000000" stopOpacity="0" />
          <stop offset="82%" stopColor="#000000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.11" />
        </radialGradient>
      </defs>

      {/* ── Strap handle ────────────────────────────────────────────────────
          Drawn FIRST so the body's top edge overlaps its roots cleanly. A closed
          band (outer arc up and over, inner arc back down) rising to y≈100 — well
          above the body opening at y250, so it never touches the print area. The
          band is ~34 units thick so it reads as webbing, not a wire. */}
      <path
        d="
          M 250 256
          C 240 148, 316 100, 400 100
          C 484 100, 560 148, 550 256
          L 516 256
          C 524 172, 464 134, 400 134
          C 336 134, 276 172, 284 256
          Z
        "
        fill={color}
        stroke={OUTLINE}
        strokeWidth="3"
        strokeLinejoin="round"
      />

      {/* ── Bag body ────────────────────────────────────────────────────────*/}
      <path
        d={bodyPath}
        fill={color}
        stroke={OUTLINE}
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path d={bodyPath} fill={`url(#${shadowId})`} pointerEvents="none" />

      {/* Top hem stitch line — the folded-over canvas hem at the opening. */}
      <path d="M 174 286 L 626 286" fill="none" stroke={OUTLINE} strokeWidth="2" opacity="0.6" />

      {/* Handle attachment stitch boxes where the strap ends meet the hem. */}
      <path d="M 250 256 L 284 256" fill="none" stroke={OUTLINE} strokeWidth="2" opacity="0.7" />
      <path d="M 516 256 L 550 256" fill="none" stroke={OUTLINE} strokeWidth="2" opacity="0.7" />
      <path d="M 254 282 L 280 282" fill="none" stroke={OUTLINE} strokeWidth="2" opacity="0.5" />
      <path d="M 520 282 L 546 282" fill="none" stroke={OUTLINE} strokeWidth="2" opacity="0.5" />

      {/* Base stitch line — reads as the bottom seam of the tote. */}
      <path d="M 176 782 L 624 782" fill="none" stroke={OUTLINE} strokeWidth="2" opacity="0.45" />
    </svg>
  );
};

export default BagFlat;
