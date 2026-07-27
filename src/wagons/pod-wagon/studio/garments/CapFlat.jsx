// CapFlat.jsx — front-view flat illustration of a baseball cap.
//
// Garment flat (technical product drawing) used as the mockup base. The compositor
// overlays the artwork print area; the SVG draws NO print area itself.
//
// Structure: like TeeFlat/HoodieFlat, the cap is ONE continuous silhouette — the
// crown flows straight into the bill rather than being two stacked shapes. The
// front panel faces the viewer square-on (so the print area is undistorted) while
// the bill projects to ONE side at a slight three-quarter angle. See the comment on
// capPath for WHY that asymmetry is non-negotiable.
//
// Props:
//   • color   — the cap fill (white #ffffff → black #1a1a1a). A subtle grey stroke
//               + soft inner shadow keeps a white cap visible on a white canvas.
//   • className / style / ...rest — passed to the root <svg>.
//
// viewBox is 800×900 (CAP_VIEWBOX). Silhouette coordinate ranges:
//   • crown: x232..566 at the sweatband line (y=462), rising to y≈246 at the apex —
//     wide and low (~334×216); the button sits on the apex at (400, 256)
//   • bill: leaves the crown base at (566,462), sweeps RIGHT to its tip near
//     (688,516) and its underside returns left to (234,516)
//   • sweatband line across y≈462..470; panel seams at x≈322/478 at print height
// Print area {x:330, y:330, w:140, h:100} → spans x330..470, y330..430 (7:5 for a
// 70×50 mm embroidery/print field).
//   • Horizontally it sits BETWEEN the panel seams, which run x≈322 (left) and
//     x≈478 (right) over y330..430 — ~8 units of clearance per side.
//   • Vertically: 84 below the crown apex (y246) and 32 above the sweatband (y462).
import React from 'react';

export const CAP_VIEWBOX = { w: 800, h: 900 };

const OUTLINE = '#9aa0a6';

const CapFlat = ({ color = '#ffffff', className = '', style, ...rest }) => {
  const uid = React.useMemo(() => `cap-${Math.random().toString(36).slice(2, 8)}`, []);
  const shadowId = `${uid}-shadow`;

  // ONE silhouette. IMPORTANT — the bill projects to ONE side (a slight three-quarter
  // angle), it is NOT symmetric about the crown. That asymmetry is the whole trick:
  // a bill drawn equally on both sides of the crown is topologically a BRIM, and a
  // brim always reads as a bucket hat no matter how the proportions are tuned (five
  // symmetric attempts confirmed this). Angling it right is what makes the shape
  // unmistakably a baseball cap while still presenting the front panel flat-on to
  // the viewer, so the print area stays undistorted.
  //
  // Clockwise from the left sweatband corner:
  //   crown dome up over the top, down the right side into the bill root (566,462)
  //   → bill sweeps RIGHT and down to its tip (688,516)
  //   → bill underside returns left to the sweatband (234,516)
  //   → back up the left sweatband edge to the start.
  const capPath = `
    M 232 462
    C 240 336, 312 246, 400 246
    C 488 246, 562 336, 566 462
    C 616 462, 664 480, 688 508
    C 696 522, 688 536, 668 542
    C 596 556, 420 556, 300 550
    C 262 548, 238 536, 234 516
    C 232 500, 232 480, 232 462
    Z
  `;

  return (
    <svg
      viewBox={`0 0 ${CAP_VIEWBOX.w} ${CAP_VIEWBOX.h}`}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      role="img"
      aria-label="Keps (framvy)"
      {...rest}
    >
      <defs>
        <radialGradient id={shadowId} cx="50%" cy="40%" r="70%">
          <stop offset="0%" stopColor="#000000" stopOpacity="0" />
          <stop offset="80%" stopColor="#000000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.12" />
        </radialGradient>
      </defs>

      {/* ── Crown + bill as one silhouette ──────────────────────────────────*/}
      <path
        d={capPath}
        fill={color}
        stroke={OUTLINE}
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path d={capPath} fill={`url(#${shadowId})`} pointerEvents="none" />

      {/* ── Sweatband line ──────────────────────────────────────────────────
          Where the crown meets the bill, spanning the full crown width.
          little into each bill tip, so the two read as joined but distinct. */}
      <path
        d="M 234 470 C 300 456, 500 456, 566 464"
        fill="none"
        stroke={OUTLINE}
        strokeWidth="2.5"
        opacity="0.8"
      />

      {/* Bill topstitch — an arc echoing the bill's lower edge. */}
      <path
        d="M 300 528 C 420 540, 580 534, 664 518"
        fill="none"
        stroke={OUTLINE}
        strokeWidth="2"
        opacity="0.5"
      />

      {/* ── Panel seams ─────────────────────────────────────────────────────
          Two seams splitting the crown into a centre panel plus side panels. They
          bracket the print area: over y330..430 they sit at x≈322 and x≈478, just
          outside the rect's x330/x470 edges. */}
      <path
        d="M 372 250 C 342 296, 322 366, 322 462"
        fill="none"
        stroke={OUTLINE}
        strokeWidth="2.5"
        opacity="0.7"
      />
      <path
        d="M 428 250 C 458 296, 478 366, 478 462"
        fill="none"
        stroke={OUTLINE}
        strokeWidth="2.5"
        opacity="0.7"
      />

      {/* ── Button on top ───────────────────────────────────────────────────
          Seated ON the crown apex (y246), not floating above it. */}
      <circle cx="400" cy="256" r="11" fill={color} stroke={OUTLINE} strokeWidth="3" />
    </svg>
  );
};

export default CapFlat;
