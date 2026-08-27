// SweatshirtFlat.jsx — front-view flat illustration of a crew-neck sweatshirt.
//
// Garment flat (technical fashion drawing) used as the mockup base. The compositor
// overlays the artwork print area; the SVG draws NO print area itself.
//
// Think "the tee, but heavier": a boxier torso, a ribbed crew collar, LONG sleeves
// ending in ribbed cuffs and a ribbed waist hem band. No hood, no pocket.
//
// Props:
//   • color   — the garment body fill (white #ffffff → black #1a1a1a). A subtle
//               grey stroke + soft inner shadow keeps a white sweatshirt visible
//               on a white admin canvas.
//   • className / style / ...rest — passed to the root <svg>.
//
// viewBox is 800×900 (SWEATSHIRT_VIEWBOX). Silhouette coordinate ranges:
//   • collar opening x300..500, dipping to y≈146; rib line bottoms at y≈162
//   • torso side seams x188 (left) / x612 (right), straight from y≈330 to the hem
//   • hem band y786..830 (ribbed, parallel ticks)
//   • sleeves sweep outward from the shoulders to the cuffs: the outer edge reaches
//     x≈78 / x≈722, cuff blocks span y≈688..744, and the sleeve body fills the
//     x78..196 / x604..722 bands from y≈260 down
// Print areas that must land on fabric:
//   • chest  {x:256,y:230,w:288,h:336} → x256..544, y230..566. Clears the collar
//     rib (y162) by 68; sits 68 inside each torso side seam (188/612); bottom y566
//     is 220 above the hem band (y786). (Widened 2026-08-27 from w:240 when the
//     front print area went 250→300 mm, matching the back — spec §1.)
//   • pocket row 80×80 rects at y225..305 across x280..520 — same torso band as the
//     chest rect, all inside x188..612.
//   • sleeve areas x96..160 and x640..704, y280..360 — inside the sleeve bodies,
//     whose outer edges at that height are x≈80 and x≈720 (the sleeve outer curve
//     was widened specifically so these rects clear it).
import React from 'react';

export const SWEATSHIRT_VIEWBOX = { w: 800, h: 900 };

const OUTLINE = '#9aa0a6';

const SweatshirtFlat = ({ color = '#ffffff', className = '', style, ...rest }) => {
  const uid = React.useMemo(() => `sweat-${Math.random().toString(36).slice(2, 8)}`, []);
  const shadowId = `${uid}-shadow`;

  // Body + LONG sleeves as ONE silhouette, symmetric about x=400.
  // Path order (clockwise from the collar): collar dip → right shoulder → right
  // sleeve OUTER edge down to the cuff → across the cuff end → sleeve UNDERSIDE
  // back up to the armpit → right side seam down → hem → left side seam up →
  // left armpit → left sleeve underside down → cuff → outer edge up to the left
  // shoulder → back to the collar.
  const bodyPath = `
    M 300 118
    C 300 172, 500 172, 500 118
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
      viewBox={`0 0 ${SWEATSHIRT_VIEWBOX.w} ${SWEATSHIRT_VIEWBOX.h}`}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      role="img"
      aria-label="Sweatshirt (framvy)"
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

      {/* Sleeve inner seams — armpit down to cuff, following the silhouette's
          inner sleeve edge, so the sleeves read as separate from the torso. */}
      <path d="M 196 350 C 200 430, 204 560, 210 692" fill="none" stroke={OUTLINE} strokeWidth="2.5" opacity="0.8" />
      <path d="M 604 350 C 600 430, 596 560, 590 692" fill="none" stroke={OUTLINE} strokeWidth="2.5" opacity="0.8" />

      {/* ── Ribbed cuffs ────────────────────────────────────────────────────
          Cuff seam line across each sleeve end + short parallel rib ticks. */}
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

      {/* ── Ribbed crew collar ──────────────────────────────────────────────
          Outer neckline + inner rib line — the heavier, deeper rib of a sweatshirt
          (rib bottoms at y≈162, which the chest print rect at y230 clears). */}
      <path
        d="M 300 118 C 300 172, 500 172, 500 118"
        fill="none"
        stroke={OUTLINE}
        strokeWidth="3"
      />
      <path
        d="M 294 136 C 298 182, 502 182, 506 136"
        fill="none"
        stroke={OUTLINE}
        strokeWidth="2"
        opacity="0.7"
      />

      {/* ── Ribbed waist hem band ───────────────────────────────────────────
          Band seam at y786 + parallel rib ticks down to the hem (y830). */}
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

export default SweatshirtFlat;
