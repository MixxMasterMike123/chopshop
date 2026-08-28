// ProvisionShopModal — Slice P4.4. Creates a new shops/{shopId} tenant.
// Platform-only (Phase 3 rules: shops create requires isPlatform). v1 creates
// the shop ENTITY only (id + name + accent + default features + active status);
// assigning/creating an owner user is P4.6 (users management).
//
// shopId is the tenant key AND a future URL segment (Phase 0b path-prefix /
// subdomain), so it's validated url-safe: lowercase, a-z 0-9 and hyphens,
// 3-30 chars, must be unique.
import React, { useState } from 'react';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../../firebase/config';
import toast from 'react-hot-toast';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { NON_SHOP_FIRST_SEGMENTS } from '../../config/tenancy';

// 3-30 chars, a-z 0-9 and single hyphens BETWEEN characters (no edge/double
// hyphens — the id is a URL segment and, one day, a subdomain label).
const SHOP_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Ids that can never be shops: URL-grammar reserved segments (a shop named
// "admin" would be unreachable) + infra hostnames reserved by architecture.
const RESERVED_IDS = new Set([...NON_SHOP_FIRST_SEGMENTS, 'api', 'www', 'shop', 'print']);

// Default add-ons for a new shop (manual toggles; plans come later). All 11
// catalog keys are explicit so a new shop's defaults are unambiguous (writers is
// also off — it's manifest-disabled globally too). Existing shops with no
// `features` field default-ON for everything (see config/addons.js isFeatureEnabled).
// contentStudio is EXPLICIT OPT-IN (gated on features.contentStudio === true,
// not the default-ON helper) — new shops start with it off. `pod` is the one key
// that varies by the Butikstyp choice below (see PRESETS).
const BASE_FEATURES = {
  affiliate: true,
  campaigns: true,
  dining: false,
  ambassador: false,
  writers: false,
  contentStudio: false,
  marketingMaterials: false,
  discountCodes: true,
  abandonedCheckout: true,
  productReviews: true,
  b2b: false,
};

// Butikstyp presets (plan D2). The choice only changes `pod`; `shopType` is
// written alongside as an immutable audit crumb (D1) — runtime gating always
// reads live features.pod, never shopType.
const SHOP_TYPES = [
  {
    type: 'things',
    title: 'Vanlig butik',
    description: 'Säljer vanliga produkter.',
    features: { ...BASE_FEATURES, pod: false },
  },
  {
    type: 'pod',
    title: 'POD-butik',
    description: 'Design Studio, tryck och merch. Kan även sälja vanliga produkter.',
    features: { ...BASE_FEATURES, pod: true },
  },
];

const slugifyId = (s) =>
  (s || '')
    .toLowerCase()
    .trim()
    .replace(/[åäæ]/g, 'a')
    .replace(/[ö ø]/g, 'o')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);

const ProvisionShopModal = ({ onClose, onCreated }) => {
  const [name, setName] = useState('');
  const [shopId, setShopId] = useState('');
  const [shopIdTouched, setShopIdTouched] = useState(false);
  const [accent, setAccent] = useState('#0E5E63');
  // No preselection (D8) — the choice is the whole point, don't default it.
  const [shopType, setShopType] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Auto-derive shopId from name until the operator edits it directly.
  const onNameChange = (v) => {
    setName(v);
    if (!shopIdTouched) setShopId(slugifyId(v));
  };

  const create = async (e) => {
    e.preventDefault();
    setError('');

    const id = shopId.trim();
    if (!name.trim()) return setError('Ange ett butiksnamn.');
    if (id.length < 3 || id.length > 30 || !SHOP_ID_RE.test(id)) {
      return setError('Butiks-ID: 3–30 tecken, a–z, 0–9 och enkla bindestreck mellan tecken (t.ex. "melodie-mc").');
    }
    if (RESERVED_IDS.has(id)) {
      return setError(`Butiks-ID "${id}" är reserverat av plattformen. Välj ett annat.`);
    }
    const preset = SHOP_TYPES.find((t) => t.type === shopType);
    if (!preset) return setError('Välj butikstyp.');

    try {
      setSaving(true);
      // Uniqueness check (rules also prevent overwrite via create, but check for a clear message).
      const existing = await getDoc(doc(db, 'shops', id));
      if (existing.exists()) {
        setSaving(false);
        return setError(`Butiks-ID "${id}" finns redan. Välj ett annat.`);
      }

      await setDoc(doc(db, 'shops', id), {
        name: name.trim(),
        storeIdentity: {
          shopName: name.trim(),
          accent,
        },
        status: 'active',
        // A new shop starts hidden from search engines: the storefront is open +
        // shoppable via link, but carries a noindex robots meta until the operator
        // clicks GO LIVE on the shop detail page. (status=active is the kill-switch;
        // published controls search-engine indexing only.)
        published: false,
        features: preset.features,
        // Immutable audit crumb (D1) — written once at creation, never read at
        // runtime. Live gating always reads features.pod; this field only
        // records what was chosen at provisioning time.
        shopType: preset.type,
        ownerUid: null, // owner assignment is a later slice (P4.6)
        createdAt: serverTimestamp(),
        provisionedVia: 'platform',
      });

      toast.success(`Butik "${name.trim()}" skapad`);
      onCreated?.();
      onClose?.();
    } catch (err) {
      console.error('Provision failed:', err);
      setError('Kunde inte skapa butiken (behörighet?). Försök igen.');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-gray-900 border border-white/10 p-6 text-gray-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold">Ny butik</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300">
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={create} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Butiksnamn</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder="t.ex. Sillmans Fisk"
              className="w-full rounded-lg bg-gray-800 border border-white/10 px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-indigo-400 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Butiks-ID (URL-nyckel)</label>
            <input
              value={shopId}
              onChange={(e) => { setShopIdTouched(true); setShopId(e.target.value); }}
              placeholder="sillmans"
              className="w-full rounded-lg bg-gray-800 border border-white/10 px-3 py-2 text-sm text-white placeholder-gray-600 font-mono focus:border-indigo-400 focus:outline-none"
            />
            <p className="mt-1 text-xs text-gray-600">a–z, 0–9, bindestreck. Kan inte ändras senare.</p>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Accentfärg</label>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={accent}
                onChange={(e) => setAccent(e.target.value)}
                className="h-9 w-12 rounded bg-gray-800 border border-white/10"
              />
              <span className="font-mono text-sm text-gray-400">{accent}</span>
            </div>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Butikstyp</label>
            <div className="grid grid-cols-2 gap-2">
              {SHOP_TYPES.map((t) => {
                const selected = shopType === t.type;
                return (
                  <button
                    key={t.type}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setShopType(t.type)}
                    className={
                      'flex flex-col items-start rounded-lg border p-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ' +
                      (selected
                        ? 'border-indigo-400 bg-indigo-500/10 ring-1 ring-indigo-400'
                        : 'border-white/10 bg-gray-800 hover:bg-white/5')
                    }
                  >
                    <div className="text-sm font-medium text-white">{t.title}</div>
                    <div className="text-xs text-gray-500">{t.description}</div>
                  </button>
                );
              })}
            </div>
            {!shopType && <p className="mt-1 text-xs text-gray-600">Välj butikstyp</p>}
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm text-gray-400 hover:text-gray-200"
            >
              Avbryt
            </button>
            <button
              type="submit"
              disabled={saving || !shopType}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {saving ? 'Skapar…' : 'Skapa butik'}
            </button>
          </div>
        </form>

        <p className="mt-4 text-xs text-gray-600">
          Butiken skapas <span className="text-gray-500">dold för sökmotorer</span> (öppen via länk) — gör den sökbar
          via GO LIVE på butikens detaljsida när den är klar. Ägare/användare läggs till i ett senare steg. Branding och funktioner kan justeras efteråt.
        </p>
      </div>
    </div>
  );
};

export default ProvisionShopModal;
