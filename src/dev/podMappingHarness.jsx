// podMappingHarness.jsx — DEV-ONLY harness for eyeballing the POD admin's
// "Manuella tryckkopplingar" card (ProductMapping) with FIXTURE data, WITHOUT
// Firebase/auth. Open /pod-mapping-harness.html (vite dev server).
//
// F2: the add-row requires a Plagg (the print-routing key — since SnapWear A4 a
// mapping without one routes to no printer and checkout refuses the line), and a
// legacy row WITHOUT a garment carries a caution chip. Rendered in light and dark
// (the admin's `.dark` class) because the card reuses the admin tokens.
//
// Like studioHarness, the real component is imported as-is: firebase/config
// initialises at module load but nothing here reads or writes. Leave a field
// empty and press "Lägg till" to see the validation toasts; a COMPLETE add would
// attempt a real setMapping write (localhost = emulators), so don't.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'react-hot-toast';
import '../index.css';
import ProductMapping from '../wagons/pod-wagon/components/ProductMapping';

const ARTWORK = [
  { id: 'a1', label: 'North-logga (ljus)', fileName: 'north-light.png', purpose: 'apparel_dtg', validation: { tier: 'PASS' } },
  { id: 'a2', label: 'Ryggtext', fileName: 'back-text.png', purpose: 'apparel_dtg', validation: { tier: 'WARN' } },
  { id: 'a3', label: 'Gammal skiss', fileName: 'sketch.jpg', purpose: 'apparel_dtg', validation: { tier: 'FAIL' } },
];

const PROFILES = [{ id: 'apparel_dtg', label: 'Kläder (DTG)' }];

// One studio-made row (garment stamped) and one legacy hand-made row without a
// garment — the second must show the "Plagg saknas" chip.
const MAPPINGS = [
  { id: 'm1', sku: 'north-01', artworkId: 'a1', profileId: 'apparel_dtg', placementSlot: 'front', placement: 'Centrerat, 25 cm', garment: 'tee' },
  { id: 'm2', sku: 'harbour-02', artworkId: 'a2', profileId: 'apparel_dtg', placementSlot: 'back', placement: '' },
];

// Shape of listShopProductSkus().products.
const PRODUCTS = [
  {
    id: 'p1', sku: 'north-01', name: 'North tee', image: null, hasSku: true,
    variants: [{ sku: 'north-01-svart', label: 'Svart', image: null }],
    isPodProduct: true, b2cAvailable: true,
  },
  { id: 'p2', sku: 'harbour-02', name: 'Harbour hoodie', image: null, hasSku: true, variants: [], isPodProduct: true, b2cAvailable: true },
];
const PRODUCT_SKUS = new Set(['north-01', 'north-01-svart', 'harbour-02']);

const mappingProps = {
  shopId: 'fixture', mappings: MAPPINGS, artwork: ARTWORK, profiles: PROFILES,
  products: PRODUCTS, productSkus: PRODUCT_SKUS, loading: false, onChanged: () => {},
};

// The project's dark mode is a `.dark` CLASS (hooks/useDarkMode.js), so each
// pane wrapper carries it for the admin tokens to swap. Panes are wide enough
// that they stack — the add-row grid needs the admin page's real width.
const Pane = ({ label, dark, children }) => (
  <div className={`${dark ? 'dark' : ''} min-w-[900px] flex-1`}>
    <div className="bg-admin-surface-2 px-3 py-1 font-mono text-[11px] text-admin-text-faint">{label}</div>
    <div className="min-h-[300px] bg-admin-bg p-4">{children}</div>
  </div>
);

createRoot(document.getElementById('root')).render(
  <div className="flex flex-wrap">
    <Toaster />
    <Pane label="LIGHT — manuella kopplingar (en med plagg, en utan)"><ProductMapping {...mappingProps} /></Pane>
    <Pane label="DARK — manuella kopplingar (en med plagg, en utan)" dark><ProductMapping {...mappingProps} /></Pane>
  </div>
);
