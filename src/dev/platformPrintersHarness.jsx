// platformPrintersHarness.jsx — DEV-ONLY harness for eyeballing Plattform →
// Tryckerier's printer list + tier editor (PrinterRow) WITHOUT Firebase/auth.
// Open /platform-printers-harness.html (vite dev server).
//
// Fixtures: SnapWear as an API printer (no users/ doc — "API" badge), seeded
// with the frames scripts/seed-snapwear-printer.cjs writes, editor OPEN so the
// "Tryckytor (mm)" table is visible; plus one ordinary print_shop user row.
// Save is stubbed: it runs the real form→doc converters and logs the payload,
// then shows the "valideras inte om automatiskt" notice.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import toast, { Toaster } from 'react-hot-toast';
import '../index.css';
import PrinterRow, { docToForm, formToPricing, formToPrintAreas, incompleteAreaCells } from '../components/platform/PrinterRow';
import { POD_GARMENTS, garmentLabel } from '../config/podGarments';

const SNAPWEAR = {
  id: 'snapwear',
  name: 'Snapwear (Łódź)',
  type: 'api',
  active: true,
  garments: ['tee', 'longsleeve', 'hoodie', 'sweatshirt', 'bag', 'cap', 'beanie'],
  pricing: {
    // Placeholder figures, NOT a real supplier list (A13: no real prices in source).
    blankCostSek: { tee: 100, longsleeve: 100, hoodie: 100, sweatshirt: 100, bag: 100, cap: 100, beanie: 100 },
    printCostSek: { front: 10, back: 10, pocket: 10 },
  },
  printAreasMm: {
    tee: { front: { w: 390, h: 490, offsetTopMm: 30 }, back: { w: 390, h: 490, offsetTopMm: 40 }, pocket: { w: 100, h: 100 } },
    longsleeve: { front: { w: 390, h: 490, offsetTopMm: 30 }, back: { w: 390, h: 490, offsetTopMm: 40 }, pocket: { w: 100, h: 100 } },
    hoodie: { front: { w: 390, h: 280, offsetTopMm: 30 }, back: { w: 390, h: 490, offsetTopMm: 60 }, pocket: { w: 100, h: 100 } },
    sweatshirt: { front: { w: 390, h: 490, offsetTopMm: 30 }, back: { w: 390, h: 490, offsetTopMm: 40 }, pocket: { w: 100, h: 100 } },
    bag: { front: { w: 260, h: 310, offsetTopMm: 50 }, back: { w: 260, h: 310, offsetTopMm: 50 }, pocket: { w: 100, h: 100 } },
    cap: { front: { w: 70, h: 50 } },
    beanie: { front: { w: 100, h: 50 } },
  },
  provisionalAreas: ['longsleeve', 'bag', 'cap', 'beanie'],
};
const USER_TIER = {
  id: 'uid-tryckeri-ab',
  garments: ['tee'],
  pricing: { blankCostSek: { tee: 100 }, printCostSek: { front: 10 } },
};

const rowFor = (tier, extra) => ({
  garmentsLabel: tier.garments.map(garmentLabel).join(', '),
  ...extra,
});

const Harness = () => {
  const params = new URLSearchParams(window.location.search);
  const [tiers, setTiers] = useState({ snapwear: SNAPWEAR, [USER_TIER.id]: USER_TIER });
  const [openUid, setOpenUid] = useState(params.get('closed') === '1' ? null : 'snapwear');
  const [form, setForm] = useState(() => docToForm(SNAPWEAR));
  const [notice, setNotice] = useState([]);

  const rows = [
    rowFor(USER_TIER, { id: USER_TIER.id, kind: 'user', title: 'Tryckeri AB', subtitle: 'tryck@exempel.se · butiker: Melodie MC', active: true }),
    rowFor(tiers.snapwear, { id: 'snapwear', kind: 'api', title: 'Snapwear (Łódź)', subtitle: 'Ordrar skickas via tryckeriets API — ingen inloggning i tryckeriportalen', active: true }),
  ];

  const save = (row) => {
    const bad = incompleteAreaCells(form);
    if (bad.length) { toast.error(`Ange både bredd och höjd (eller inget) för: ${bad.join(', ')}.`); return; }
    const printAreasMm = formToPrintAreas(form);
    const payload = { pricing: formToPricing(form), printAreasMm, provisionalAreas: [...form.provisional] };
    console.log('harness: save', row.id, payload);
    const before = tiers[row.id].printAreasMm || {};
    setNotice(POD_GARMENTS.filter((g) => JSON.stringify(before[g.id] ?? null) !== JSON.stringify(printAreasMm[g.id] ?? null)).map((g) => g.label));
    setTiers((t) => ({ ...t, [row.id]: { ...t[row.id], ...payload } }));
    toast.success('Plagg, priser & tryckytor sparade.');
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <Toaster position="top-right" />
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        <h1 className="mb-1 text-lg font-bold">Tryckerier</h1>
        <p className="mb-5 text-sm text-gray-400">Harness — PrinterRow med fixturer, ingen Firestore.</p>
        <h2 className="mb-2 text-sm font-semibold">Befintliga tryckerier</h2>
        <div className="space-y-2">
          {rows.map((r) => (
            <PrinterRow
              key={r.id}
              row={r}
              open={openUid === r.id}
              form={openUid === r.id ? form : null}
              setForm={setForm}
              areasNotice={openUid === r.id ? notice : []}
              onToggleEditor={() => {
                setNotice([]);
                if (openUid === r.id) { setOpenUid(null); return; }
                setOpenUid(r.id);
                setForm(docToForm(tiers[r.id]));
              }}
              onToggleActive={() => toast(`toggle ${r.id}`)}
              onSave={() => save(r)}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

createRoot(document.getElementById('root')).render(<Harness />);
