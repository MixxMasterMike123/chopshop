// HoodieBackFlat.jsx — BACK-view flat illustration of the pullover hoodie.
//
// Garment flat (technical fashion drawing) used as the mockup base. The compositor
// overlays the artwork print area; the SVG draws NO print area itself.
//
// Relationship to HoodieFlat: the body + long-sleeve silhouette is the SAME shape
// (torso x205..595, hem y830, sleeves sweeping out to x≈98/702 and ending in ribbed
// cuffs at y≈740). The difference is the HOOD: from behind you see the whole hood
// as a solid rounded shape draped over the shoulders/upper back, not an opening.
// So: no inner-lining recess, no drawstrings, no kangaroo pocket.
//
// Props:
//   • color   — the garment body fill (white #ffffff → black #1a1a1a). A subtle
//               grey stroke + soft inner shadow keeps a white hoodie visible on a
//               white admin canvas.
//   • className / style / ...rest — passed to the root <svg>.
//
// viewBox is 800×900 (HOODIE_BACK_VIEWBOX). Hood bounds: x250..550, crown y70,
// yoke seam (its lowest edge) y230. Back print area is
// {x:286, y:240, w:228, h:304} → spans x286..514, y240..544. The rect starts 10
// units BELOW the yoke seam so it lands on bare upper back, not on the hood. Torso
// inner edges at that height are x≈207/593, giving ~79 units of clearance per side;
// bottom y544 is well above the ribbed hem (y806).
import React from 'react';

export const HOODIE_BACK_VIEWBOX = { w: 800, h: 900 };

const OUTLINE = '#9aa0a6';

const HoodieBackFlat = ({ color = '#ffffff', className = '', style, ...rest }) => {
  const uid = React.useMemo(() => `hoodie-back-${Math.random().toString(36).slice(2, 8)}`, []);
  const shadowId = `${uid}-shadow`;

  // Body + LONG sleeves as one silhouette — identical geometry to HoodieFlat.
  // Sleeves angle outward and run the full torso length, ending in ribbed cuffs
  // (~y740). Torso spans x205..595, hem y830 — symmetric about x=400.
  const bodyPath = `
    M 300 150
    C 288 158, 276 165, 262 170
    C 232 180, 200 192, 178 210
    C 142 250, 110 430, 100 655
    L 98 696
    C 97 706, 98 716, 100 726
    C 101 736, 108 742, 118 741
    L 172 736
    C 180 735, 184 728, 184 720
    L 182 690
    C 188 560, 196 430, 207 348
    L 205 812
    C 205 822, 213 830, 223 830
    L 577 830
    C 587 830, 595 822, 595 812
    L 593 348
    C 604 430, 612 560, 618 690
    L 616 720
    C 616 728, 620 735, 628 736
    L 682 741
    C 692 742, 699 736, 700 726
    C 702 716, 703 706, 702 696
    L 700 655
    C 690 430, 658 250, 622 210
    C 600 192, 568 180, 538 170
    C 524 165, 512 158, 500 150
    Z
  `;

  // The hood seen from BEHIND: a broad, soft dome draped OVER the shoulders. It is
  // deliberately WIDER than the neck (x≈250..550 at its widest) and shallower than
  // a head-shaped dome, because a hood lying flat against the back spreads out.
  // Crown at y≈70; the bottom is the yoke seam arcing down across the upper back to
  // y≈228. This is the single distinctive element of the back view, so it is a
  // FILLED shape with an outline.
  const hoodPath = `
    M 250 196
    C 244 122, 312 70, 400 70
    C 488 70, 556 122, 550 196
    C 546 214, 528 226, 500 230
    L 300 230
    C 272 226, 254 214, 250 196
    Z
  `;

  return (
    <svg
      viewBox={`0 0 ${HOODIE_BACK_VIEWBOX.w} ${HOODIE_BACK_VIEWBOX.h}`}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      role="img"
      aria-label="Hoodie (bakvy)"
      {...rest}
    >
      <defs>
        <radialGradient id={shadowId} cx="50%" cy="40%" r="70%">
          <stop offset="0%" stopColor="#000000" stopOpacity="0" />
          <stop offset="80%" stopColor="#000000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.12" />
        </radialGradient>
      </defs>

      {/* ── Body + long sleeves silhouette ────────────────────────────────── */}
      <path
        d={bodyPath}
        fill={color}
        stroke={OUTLINE}
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path d={bodyPath} fill={`url(#${shadowId})`} pointerEvents="none" />

      {/* Sleeve inner seams — separate the sleeves from the torso visually
          (armpit down to cuff, following the silhouette's inner sleeve edge). */}
      <path d="M 207 348 C 196 430, 188 560, 182 690" fill="none" stroke={OUTLINE} strokeWidth="2.5" opacity="0.8" />
      <path d="M 593 348 C 604 430, 612 560, 618 690" fill="none" stroke={OUTLINE} strokeWidth="2.5" opacity="0.8" />

      {/* ── Ribbed cuffs ────────────────────────────────────────────────────
          Cuff top line + short rib ticks at each sleeve end. */}
      <path d="M 99 692 L 183 697" fill="none" stroke={OUTLINE} strokeWidth="2.5" opacity="0.85" />
      <path d="M 120 695 L 118 740" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.5" />
      <path d="M 142 694 L 141 739" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.5" />
      <path d="M 163 693 L 163 738" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.5" />
      <path d="M 701 692 L 617 697" fill="none" stroke={OUTLINE} strokeWidth="2.5" opacity="0.85" />
      <path d="M 680 695 L 682 740" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.5" />
      <path d="M 658 694 L 659 739" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.5" />
      <path d="M 637 693 L 637 738" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.5" />

      {/* ── Hood, seen from behind ──────────────────────────────────────────
          Filled dome draped over the shoulders/upper back. Drawn AFTER the body so
          it reads as lying on top; its bottom edge (y≈230) is the yoke seam the
          back print area starts below.
          NOTE: no inner-shadow overlay here — the body already carries one, and
          stacking a second on the hood turned it into a dark blob instead of a
          panel of the same fabric. A hairline seam gives the depth instead. */}
      <path
        d={hoodPath}
        fill={color}
        stroke={OUTLINE}
        strokeWidth="3"
        strokeLinejoin="round"
      />

      {/* Hood centre-back seam — the panel join running down the middle of the hood. */}
      <path d="M 400 72 L 400 230" fill="none" stroke={OUTLINE} strokeWidth="2" opacity="0.4" />

      {/* Yoke seam where the hood meets the back body. */}
      <path
        d="M 300 230 C 336 242, 464 242, 500 230"
        fill="none"
        stroke={OUTLINE}
        strokeWidth="2.5"
        opacity="0.8"
      />

      {/* ── Ribbed hem ──────────────────────────────────────────────────────*/}
      <path d="M 205 806 L 595 806" fill="none" stroke={OUTLINE} strokeWidth="2" opacity="0.55" />
    </svg>
  );
};

export default HoodieBackFlat;
