// colorwayStripHarness.jsx — DEV-ONLY harness for eyeballing the ColorwayStrip
// review gate (step 6 "Motiv per färg") WITHOUT Firebase. UNTRACKED: delete
// together with /colorway-strip-harness.html.
//
// Mounts the REAL ColorwayStrip with the same fixture shapes as studioHarness
// (flat tee template + canvas-generated artwork). Reviewed-marking mimics
// DesignStudio's seen-on-view rule: selecting a colourway marks it seen.
import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import ColorwayStrip from '../wagons/pod-wagon/studio/ColorwayStrip';

const COLORWAYS = [
  { id: 'white', label: 'Vit', hex: '#ffffff' },
  { id: 'black', label: 'Svart', hex: '#1a1a1a' },
  { id: 'navy', label: 'Marinblå', hex: '#1f2a44' },
  { id: 'heather', label: 'Gråmelerad', hex: '#b7b7b7' },
  { id: 'red', label: 'Röd', hex: '#b3272d' },
];

const TEMPLATE = {
  id: 'tee_flat', label: 'T-shirt', garment: 'tee', profileId: 'apparel_dtg',
  colorways: COLORWAYS,
  printAreas: { front: { x: 280, y: 210, w: 240, h: 320 } },
  printAreaMm: { front: { w: 300, h: 400 } },
};

const makeArtwork = () => {
  const c = document.createElement('canvas');
  c.width = 1200; c.height = 1600;
  const g = c.getContext('2d');
  g.fillStyle = '#e2574c';
  g.beginPath(); g.arc(600, 560, 360, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#2c4b6e';
  g.fillRect(240, 880, 720, 480);
  g.fillStyle = '#ffffff';
  g.font = '150px sans-serif'; g.textAlign = 'center';
  g.fillText('MOTIV', 600, 1200);
  return {
    id: 'art-1', label: 'Motiv 1200×1600',
    previewUrl: c.toDataURL('image/png'),
    sourceWidthPx: 1200, sourceHeightPx: 1600,
    validation: { tier: 'PASS' },
  };
};

const Strip = ({ initialReviewed }) => {
  const art = useMemo(makeArtwork, []);
  const [activeId, setActiveId] = useState('white');
  const [reviewed, setReviewed] = useState(() => new Set(initialReviewed));
  // Seen-on-view, like DesignStudio: selecting marks reviewed.
  const select = (id) => {
    setActiveId(id);
    setReviewed((prev) => new Set(prev).add(id));
  };
  return (
    <div className="p-4">
      <ColorwayStrip
        template={TEMPLATE}
        slot="front"
        activeColorwayId={activeId}
        onSelect={select}
        placement={null}
        resolveArtwork={() => art}
        overrides={{}}
        onOverrideChange={() => {}}
        artworkOptions={[]}
        baseArtworkLabel="Standardmotiv"
        reviewedColorwayIds={reviewed}
        colorwayIds={COLORWAYS.map((c) => c.id)}
        onApproveAll={() => setReviewed(new Set(COLORWAYS.map((c) => c.id)))}
      />
    </div>
  );
};

const Pane = ({ label, dark, children }) => (
  <div className={`${dark ? 'dark' : ''} flex-1 min-w-[520px]`}>
    <div className="bg-admin-surface-2 px-3 py-1 font-mono text-[11px] text-admin-text-faint">{label}</div>
    <div className="bg-admin-bg">{children}</div>
  </div>
);

createRoot(document.getElementById('root')).render(
  <div className="flex flex-wrap">
    <Pane label="LIGHT — 2 av 5 granskade"><Strip initialReviewed={['white', 'black']} /></Pane>
    <Pane label="DARK — 2 av 5 granskade" dark><Strip initialReviewed={['white', 'black']} /></Pane>
    <Pane label="LIGHT — alla granskade"><Strip initialReviewed={['white', 'black', 'navy', 'heather', 'red']} /></Pane>
    <Pane label="DARK — alla granskade" dark><Strip initialReviewed={['white', 'black', 'navy', 'heather', 'red']} /></Pane>
  </div>
);
