// flatsHarness.jsx — DEV-ONLY visual harness for the garment flats (step 3).
// Renders every garment × view × colorway with the SEED's print-area rects
// overlaid (front/pocket L-C-R/sleeves on the front view, back on the back view)
// so seed↔drawing calibration can be verified by eye. NOT part of the app build;
// loaded only by flats-harness.html via `npx vite`. Do not commit product code here.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { GARMENT_FLATS, GARMENT_VIEWBOX } from '../wagons/pod-wagon/studio/garments';

// Seed geometry (scripts/seed-pod-mockup-templates.cjs v3) — keep in sync by hand.
const T = {
  tee: {
    front: { x: 280, y: 210, w: 240, h: 336 },
    back: { x: 280, y: 186, w: 240, h: 320 },
    pocket: { y: 210, w: 80, h: 80, xs: { left: 440, center: 360, right: 280 } },
    sleeves: [{ x: 636, y: 280, w: 56, h: 56 }, { x: 108, y: 280, w: 56, h: 56 }],
  },
  hoodie: {
    front: { x: 285, y: 250, w: 230, h: 322 },
    back: { x: 286, y: 240, w: 228, h: 304 },
    pocket: { y: 255, w: 80, h: 80, xs: { left: 430, center: 360, right: 290 } },
    sleeves: [{ x: 604, y: 340, w: 56, h: 56 }, { x: 140, y: 340, w: 56, h: 56 }],
  },
  sweatshirt: {
    front: { x: 280, y: 230, w: 240, h: 336 },
    back: { x: 280, y: 206, w: 240, h: 320 },
    pocket: { y: 225, w: 80, h: 80, xs: { left: 440, center: 360, right: 280 } },
    sleeves: [{ x: 644, y: 290, w: 56, h: 56 }, { x: 100, y: 290, w: 56, h: 56 }],
  },
  bag: { front: { x: 250, y: 330, w: 300, h: 300 } },
  cap: { front: { x: 330, y: 330, w: 140, h: 100 } },
  beanie: { front: { x: 265, y: 560, w: 270, h: 120 } },
  flatcap: { front: { x: 250, y: 470, w: 300, h: 120 } },
};

const COLORS = [
  { id: 'white', hex: '#ffffff' },
  { id: 'black', hex: '#1a1a1a' },
];

const pct = (r, vb) => ({
  position: 'absolute',
  left: `${(r.x / vb.w) * 100}%`,
  top: `${(r.y / vb.h) * 100}%`,
  width: `${(r.w / vb.w) * 100}%`,
  height: `${(r.h / vb.h) * 100}%`,
});

const Rect = ({ r, vb, color = '#2563eb', dash = true, label }) => (
  <div style={{ ...pct(r, vb), border: `2px ${dash ? 'dashed' : 'solid'} ${color}`, boxSizing: 'border-box' }}>
    {label && (
      <span style={{ position: 'absolute', top: -16, left: 0, fontSize: 10, color, whiteSpace: 'nowrap' }}>{label}</span>
    )}
  </div>
);

const Cell = ({ garment, view, hex }) => {
  const views = GARMENT_FLATS[garment];
  const Flat = views[view];
  const vb = GARMENT_VIEWBOX[garment];
  const g = T[garment];
  if (!Flat) return null;
  return (
    <div style={{ width: 240 }}>
      <div style={{ position: 'relative', background: '#f4f4f5', borderRadius: 8 }}>
        <Flat color={hex} style={{ display: 'block', width: '100%', height: 'auto' }} />
        {view === 'front' && g.front && <Rect r={g.front} vb={vb} label="front" />}
        {view === 'back' && g.back && <Rect r={g.back} vb={vb} color="#7c3aed" label="back" />}
        {view === 'front' && g.pocket &&
          Object.entries(g.pocket.xs).map(([pos, x]) => (
            <Rect key={pos} r={{ x, y: g.pocket.y, w: g.pocket.w, h: g.pocket.h }} vb={vb}
              color={pos === 'left' ? '#dc2626' : pos === 'center' ? '#ea580c' : '#ca8a04'} label={pos} />
          ))}
        {view === 'front' && g.sleeves &&
          g.sleeves.map((r, i) => <Rect key={i} r={r} vb={vb} color="#059669" label={i === 0 ? 'L(w)' : 'R(w)'} />)}
      </div>
      <div style={{ fontSize: 11, color: '#555', marginTop: 2 }}>{garment} · {view} · {hex}</div>
    </div>
  );
};

const App = () => (
  <div style={{ padding: 16, fontFamily: 'system-ui' }}>
    <h1 style={{ fontSize: 16 }}>Garment flats × seed print rects (step 3)</h1>
    <p style={{ fontSize: 12, color: '#666' }}>
      blå=front · lila=back · röd/orange/gul=ficka vänster/mitten/höger (bärarens perspektiv) · grön=ärmar
    </p>
    {Object.keys(GARMENT_FLATS).map((garment) => (
      <div key={garment} style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, margin: '12px 0 6px' }}>{garment}</h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {['front', 'back'].filter((v) => GARMENT_FLATS[garment][v]).map((view) =>
            COLORS.map((c) => <Cell key={`${view}-${c.id}`} garment={garment} view={view} hex={c.hex} />)
          )}
        </div>
      </div>
    ))}
  </div>
);

createRoot(document.getElementById('root')).render(<App />);
