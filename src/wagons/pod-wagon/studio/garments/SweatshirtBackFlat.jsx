// SweatshirtBackFlat.jsx — BACK-view flat illustration of the crew-neck sweatshirt.
//
// Garment flat (technical fashion drawing) used as the mockup base. The compositor
// overlays the artwork print area; the SVG draws NO print area itself.
//
// Relationship to SweatshirtFlat: the body + long-sleeve silhouette is IDENTICAL
// (torso side seams x188/x612, hem band y786..830, sleeves out to x≈78/722 with
// cuff blocks at y≈688..744). The only change is the neckline: the back neck drop
// is small, so the curve sits HIGHER and shallower — the front collar dips to
// y≈146, the back neckline bottoms out at y≈134 and its rib line at y≈148.
// Ribbed cuffs and ribbed waist band stay; no front details.
//
// Props:
//   • color   — the garment body fill (white #ffffff → black #1a1a1a). A subtle
//               grey stroke + soft inner shadow keeps a white sweatshirt visible
//               on a white admin canvas.
//   • className / style / ...rest — passed to the root <svg>.
//
// viewBox is 800×900 (SWEATSHIRT_BACK_VIEWBOX). Back print area is
// {x:280, y:206, w:240, h:320} → spans x280..520, y206..526. It clears the neck
// rib (lowest point y≈148) by 58, sits 92 inside each torso side seam (188/612),
// and its bottom (y526) is 260 above the ribbed hem band (y786).
import React from 'react';

export const SWEATSHIRT_BACK_VIEWBOX = { w: 800, h: 900 };

const OUTLINE = '#9aa0a6';

const SweatshirtBackFlat = ({ color = '#ffffff', className = '', style, ...rest }) => {
  const uid = React.useMemo(() => `sweat-back-${Math.random().toString(36).slice(2, 8)}`, []);
  const shadowId = `${uid}-shadow`;

  // Same clockwise silhouette as SweatshirtFlat (collar → right shoulder → right
  // sleeve outer edge → cuff → sleeve underside → side seam → hem → mirrored back
  // up the left), with the shallow BACK neckline as the opening curve.
  const bodyPath = `
    M 300 118
    C 316 156, 484 156, 500 118
    L 516 122
    C 566 134, 610 154, 646 184
    C 684 212, 712 254, 716 330
    L 722 688
    C 723 704, 716 718, 702 722
    L 634 744
    C 620 748, 606 740, 602 726
    L 590 692
    C 596 560, 600 430, 604 350
    L 612 786
    L 612 812
    C 612 822, 604 830, 594 830
    L 206 830
    C 196 830, 188 822, 188 812
    L 188 786
    L 196 350
    C 200 430, 204 560, 210 692
    L 198 726
    C 194 740, 180 748, 166 744
    L 104 722
    C 84 718, 77 704, 78 688
    L 84 330
    C 88 254, 116 212, 154 184
    C 190 154, 234 134, 284 122
    Z
  `;

  return (
    <svg
      viewBox={`0 0 ${SWEATSHIRT_BACK_VIEWBOX.w} ${SWEATSHIRT_BACK_VIEWBOX.h}`}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      role="img"
      aria-label="Sweatshirt (bakvy)"
      {...rest}
    >
      <defs>
        <radialGradient id={shadowId} cx="50%" cy="40%" r="72%">
          <stop offset="0%" stopColor="#000000" stopOpacity="0" />
          <stop offset="82%" stopColor="#000000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.11" />
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

      {/* Sleeve inner seams — armpit down to cuff along the silhouette's inner edge. */}
      <path d="M 196 350 C 200 430, 204 560, 210 692" fill="none" stroke={OUTLINE} strokeWidth="2.5" opacity="0.8" />
      <path d="M 604 350 C 600 430, 596 560, 590 692" fill="none" stroke={OUTLINE} strokeWidth="2.5" opacity="0.8" />

      {/* ── Ribbed cuffs ────────────────────────────────────────────────────*/}
      <path d="M 78 688 L 210 694" fill="none" stroke={OUTLINE} strokeWidth="2.5" opacity="0.85" />
      <path d="M 108 692 L 116 736" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.5" />
      <path d="M 133 693 L 141 738" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.5" />
      <path d="M 158 693 L 166 740" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.5" />
      <path d="M 183 694 L 191 741" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.5" />
      <path d="M 722 688 L 590 694" fill="none" stroke={OUTLINE} strokeWidth="2.5" opacity="0.85" />
      <path d="M 692 692 L 684 736" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.5" />
      <path d="M 667 693 L 659 738" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.5" />
      <path d="M 642 693 L 634 740" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.5" />
      <path d="M 617 694 L 609 741" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.5" />

      {/* ── Back neckline ───────────────────────────────────────────────────
          Shallow curve (bottoms at y≈134) with one thin rib line under it
          (bottoms at y≈148) — the highest thing the back print rect must clear. */}
      <path
        d="M 300 118 C 316 156, 484 156, 500 118"
        fill="none"
        stroke={OUTLINE}
        strokeWidth="3"
      />
      <path
        d="M 294 132 C 312 172, 488 172, 506 132"
        fill="none"
        stroke={OUTLINE}
        strokeWidth="2"
        opacity="0.7"
      />

      {/* ── Ribbed waist hem band ───────────────────────────────────────────*/}
      <path d="M 188 786 L 612 786" fill="none" stroke={OUTLINE} strokeWidth="2.5" opacity="0.8" />
      <path d="M 236 788 L 236 828" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.4" />
      <path d="M 290 788 L 290 828" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.4" />
      <path d="M 344 788 L 344 828" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.4" />
      <path d="M 400 788 L 400 828" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.4" />
      <path d="M 456 788 L 456 828" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.4" />
      <path d="M 510 788 L 510 828" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.4" />
      <path d="M 564 788 L 564 828" fill="none" stroke={OUTLINE} strokeWidth="1.5" opacity="0.4" />
    </svg>
  );
};

export default SweatshirtBackFlat;
