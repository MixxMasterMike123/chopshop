// TeeBackFlat.jsx — BACK-view flat illustration of the same crew-neck t-shirt as TeeFlat.
//
// This is a GARMENT FLAT (a technical fashion "flat" drawing) used as the mockup
// base. The compositor overlays the artwork print area on top of this SVG — the SVG
// itself draws NO print area (that is the compositor's job).
//
// Relationship to TeeFlat: the body/sleeve silhouette coordinates are IDENTICAL
// (shoulders x120..680, torso x196..604, hem y830, sleeve tips x48/752 y~288..392).
// The ONLY difference is the neckline: a back neck drop is small, so the curve
// sits HIGHER and shallower than the front collar. TeeFlat's front collar dips to
// y≈138 (control points 300 150 / 500 150); here the back neckline bottoms out at
// y≈120 (control points 320 138 / 480 138). No front details of any kind.
//
// Props:
//   • color   — the garment body fill. Works across the full range white
//               (#ffffff) → black (#1a1a1a). A subtle grey stroke + soft inner
//               shadow keeps a WHITE garment visible on a white admin canvas.
//   • className / style / ...rest — passed to the root <svg> (sizing is caller's job).
//
// viewBox is 800×900 (TEE_BACK_VIEWBOX). Print area for the back is
// {x:280, y:186, w:240, h:320} → spans x280..520, y186..506. The back print starts
// HIGHER than the front one (~8–9 cm below the neck seam): the neck seam rib ends
// at y≈134, so the rect clears it by ~52 units, and its full width sits inside the
// torso (x196..604) with 84 units of margin per side. Bottom y506 is far above the
// hem (y830). If you nudge the neckline here, re-check that rect.
import React from 'react';

export const TEE_BACK_VIEWBOX = { w: 800, h: 900 };

// A gentle outline colour that reads on both a white garment (needs a visible edge)
// and a black garment (a slightly lighter hairline). Mid-grey works for both.
const OUTLINE = '#9aa0a6';

// Body + sleeves as ONE silhouette path — same hand-tuned coordinates as TeeFlat,
// except the opening curve (the neckline) which is the shallow BACK neck.
const bodyPath = `
  M 300 96
  C 320 138, 480 138, 500 96
  L 512 100
  C 560 112, 604 132, 644 160
  L 748 250
  C 760 260, 762 276, 752 288
  L 672 388
  C 664 398, 650 400, 640 392
  L 604 362
  L 604 812
  C 604 822, 596 830, 586 830
  L 214 830
  C 204 830, 196 822, 196 812
  L 196 362
  L 160 392
  C 150 400, 136 398, 128 388
  L 48 288
  C 38 276, 40 260, 52 250
  L 156 160
  C 196 132, 240 112, 288 100
  Z
`;

const TeeBackFlat = ({ color = '#ffffff', className = '', style, ...rest }) => {
  // Stable-ish id suffix so multiple flats on one page don't clash on the
  // gradient/shadow defs. (Math.random is fine — this is presentational only.)
  const uid = React.useMemo(() => `tee-back-${Math.random().toString(36).slice(2, 8)}`, []);
  const shadowId = `${uid}-shadow`;

  return (
    <svg
      viewBox={`0 0 ${TEE_BACK_VIEWBOX.w} ${TEE_BACK_VIEWBOX.h}`}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      role="img"
      aria-label="T-shirt (bakvy)"
      {...rest}
    >
      <defs>
        {/* Soft inner shadow so the body reads as a garment (subtle volume) and a
            white tee is never invisible on a white background. */}
        <radialGradient id={shadowId} cx="50%" cy="38%" r="72%">
          <stop offset="0%" stopColor="#000000" stopOpacity="0" />
          <stop offset="82%" stopColor="#000000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000000" stopOpacity="0.10" />
        </radialGradient>
      </defs>

      {/* ── Body + sleeves silhouette ─────────────────────────────────────── */}
      <path
        d={bodyPath}
        fill={color}
        stroke={OUTLINE}
        strokeWidth="3"
        strokeLinejoin="round"
      />

      {/* Inner-shadow overlay (same silhouette, non-interactive). */}
      <path d={bodyPath} fill={`url(#${shadowId})`} pointerEvents="none" />

      {/* ── Back neckline ───────────────────────────────────────────────────
          A single shallow curve (bottoms at y≈120) — the back neck drop is small
          compared with the front. One thin rib line sits just under it (y≈134 at
          its lowest), which is the highest thing the back print rect must clear. */}
      <path
        d="M 300 96 C 320 138, 480 138, 500 96"
        fill="none"
        stroke={OUTLINE}
        strokeWidth="3"
      />
      <path
        d="M 296 108 C 318 152, 482 152, 504 108"
        fill="none"
        stroke={OUTLINE}
        strokeWidth="2"
        opacity="0.7"
      />

      {/* Sleeve hem accents (short lines near each cuff) — reads as sleeve openings. */}
      <path d="M 128 388 L 196 356" fill="none" stroke={OUTLINE} strokeWidth="2" opacity="0.6" />
      <path d="M 672 388 L 604 356" fill="none" stroke={OUTLINE} strokeWidth="2" opacity="0.6" />
    </svg>
  );
};

export default TeeBackFlat;
