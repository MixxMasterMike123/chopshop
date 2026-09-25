// PlatformPrinters — operator UI to provision + manage print-shop accounts.
// Create a print_shop user (Auth + users/{uid} doc via createPrintShopUser
// callable) assigned to one or more shops; list existing printers; toggle active.
// Platform-only (PlatformRoute). Dark PlatformLayout.
//
// Per printer there is also a "Plagg & priser" editor writing printers/{uid}
// (uid = the print_shop user's uid): which garments the shop can make and what
// its tier costs. ALL PRICES ARE EX MOMS — that is the storage convention across
// the POD money path (podCostSek, snapshot line cost); inkl-moms is a DISPLAY
// concern on the seller-facing surfaces only. An empty input means "not priced":
// the key is omitted from the doc rather than stored as 0, so a missing price is
// distinguishable from a genuinely free one downstream.
//
// The same editor holds "Tryckytor (mm)" (SnapWear A3): the printer's real
// print frames per garment × slot (printers/{uid}.printAreasMm). The Design
// Studio reshapes its templates to the ROUTED printer's frames and hides slots
// left empty here; checkout refuses them (slot-not-printable).
//
// API PRINTERS (SnapWear): a printers/{uid} doc with NO users/ counterpart —
// type:'api', seeded by scripts/seed-snapwear-printer.cjs. It has no login, so
// it is listed from the tier doc itself with an "API" badge, and Aktivera/
// Inaktivera flips only printers/{uid}.active (there is no users doc to mirror).
//
// Above the printer list sits "Styrning per plagg" (Slice 3): the routing table
// settings/printRouting, which decides WHICH printer makes which garment. It is
// a PLATFORM decision, never per shop. The seller's production cost — and with
// it the price floor — then comes from the routed printer's tier instead of the
// mockup template. Rerouting does NOT reprice existing products: podCostSek is
// frozen on the product at publish time (see the notice after saving).
import React, { useState, useEffect, useCallback } from 'react';
import { collection, getDoc, getDocs, query, where, doc, updateDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions, auth } from '../../firebase/config';
import PlatformLayout from '../../components/platform/PlatformLayout';
import PrinterRow, {
  inputCls, btnPrimary, PRICED_SLOTS,
  docToForm, formToPricing, formToPrintAreas, incompleteAreaCells,
} from '../../components/platform/PrinterRow';
import { POD_GARMENTS, garmentLabel } from '../../config/podGarments';
import toast from 'react-hot-toast';

// Kim's price list 2026-08-10 (ex moms) — the "Fyll i standardprislista" seed.
// Still requires an explicit Save; this only fills the form. Garments Kim has
// not quoted (sweatshirt) are absent on purpose — the operator fills those in.
// Sleeve prints are absent too: Kim has not given a sleeve price yet.
// `beanie` IS "Mössa" in the live seed data (beanie_flat, 50:-); Kim's separate
// "Beanie 40:-" row and the flat cap are unquoted articles → left for the
// operator to fill after Kim confirms models (open item in the plan).
const DEFAULT_TIER = {
  blankCostSek: { tee: 60, longsleeve: 90, hoodie: 380, cap: 50, beanie: 50, bag: 25 },
  printCostSek: { front: 40, back: 40, pocket: 20 },
};

// Order-independent JSON for "did these frames change?" (Firestore map key
// order is not guaranteed).
const stable = (v) => JSON.stringify(v ?? null, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

const PlatformPrinters = () => {
  const [shops, setShops] = useState([]);
  const [printers, setPrinters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Tier editor: printers/{uid} docs by uid, which row is expanded, and the
  // in-progress form for the expanded row (one at a time — no bulk save).
  const [tiers, setTiers] = useState({});
  const [openUid, setOpenUid] = useState(null);
  const [form, setForm] = useState(null);
  const [savingTier, setSavingTier] = useState(false);
  // Garments whose print frames changed in the LAST tier save → the notice.
  const [areasChanged, setAreasChanged] = useState([]);

  // Routing (settings/printRouting): per-garment printer + the catch-all default.
  // `route` is the edit buffer — '' means "no explicit rule, use the default".
  const [route, setRoute] = useState({});                 // { [garmentId]: uid|'' }
  const [defaultUid, setDefaultUid] = useState('');
  const [savedRoute, setSavedRoute] = useState({});       // what is in Firestore now
  const [savedDefaultUid, setSavedDefaultUid] = useState('');
  const [savingRoute, setSavingRoute] = useState(false);
  // Garments whose printer changed in the LAST save — drives the frozen-cost notice.
  const [rerouted, setRerouted] = useState([]);

  // create form
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [selectedShops, setSelectedShops] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [shopSnap, printerSnap, tierSnap, routeSnap] = await Promise.all([
        getDocs(collection(db, 'shops')),
        getDocs(query(collection(db, 'users'), where('role', '==', 'print_shop'))),
        getDocs(collection(db, 'printers')),
        getDoc(doc(db, 'settings', 'printRouting')),
      ]);
      setShops(shopSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setPrinters(printerSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setTiers(Object.fromEntries(tierSnap.docs.map((d) => [d.id, { id: d.id, ...d.data() }])));
      const routing = routeSnap.exists() ? routeSnap.data() || {} : {};
      const byGarment = routing.byGarment && typeof routing.byGarment === 'object' ? routing.byGarment : {};
      // Every garment gets a key so the selects are controlled from the first
      // render ('' = no explicit rule → the default printer).
      const buffer = Object.fromEntries(POD_GARMENTS.map((g) => [g.id, byGarment[g.id] || '']));
      setRoute(buffer);
      setSavedRoute(buffer);
      setDefaultUid(routing.defaultPrinterUid || '');
      setSavedDefaultUid(routing.defaultPrinterUid || '');
      setRerouted([]);
    } catch (e) {
      console.error('PlatformPrinters load failed:', e);
      toast.error('Kunde inte ladda tryckerier.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleShop = (id) =>
    setSelectedShops((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));

  const handleCreate = async (e) => {
    e.preventDefault();
    if (saving) return;
    if (!email.trim()) { toast.error('Ange e-post.'); return; }
    if (selectedShops.length === 0) { toast.error('Välj minst en butik.'); return; }
    setSaving(true);
    try {
      const res = await httpsCallable(functions, 'createPrintShopUser')({
        email: email.trim(), name: name.trim(), printShopShops: selectedShops,
      });
      const pw = res.data?.tempPassword;
      toast.success(`Tryckerikonto skapat${pw ? ` · tillfälligt lösenord: ${pw}` : ''}`, { duration: 12000 });
      setEmail(''); setName(''); setSelectedShops([]);
      load();
    } catch (err) {
      console.error('createPrintShopUser failed:', err);
      toast.error(err?.message || 'Kunde inte skapa tryckerikonto.');
    } finally {
      setSaving(false);
    }
  };

  const shopName = (id) => shops.find((s) => s.id === id)?.name || id;

  // ── One list of printers: print_shop USERS + tier docs with no user ──────
  // A tier doc without a users/ counterpart is an API printer (type:'api',
  // SnapWear) or a leftover tier whose account was removed ('tier'). Both can
  // be routed to — the resolver only reads printers/{uid} — so both are shown.
  const rows = [
    ...printers.map((p) => ({
      id: p.id,
      kind: 'user',
      title: p.contactPerson || p.email,
      subtitle: `${p.email} · butiker: ${(p.printShopShops || []).map(shopName).join(', ') || '—'}`,
      active: !!p.active,
    })),
    ...Object.values(tiers)
      .filter((t) => !printers.some((p) => p.id === t.id))
      .map((t) => ({
        id: t.id,
        kind: t.type === 'api' ? 'api' : 'tier',
        title: t.name || t.id,
        subtitle: t.type === 'api'
          ? 'Ordrar skickas via tryckeriets API — ingen inloggning i tryckeriportalen'
          : 'Prislista utan tryckerikonto',
        // Absent flag = active, the resolver's own rule.
        active: t.active !== false,
      })),
  ].map((r) => {
    const g = Array.isArray(tiers[r.id]?.garments) ? tiers[r.id].garments : [];
    return { ...r, garmentsLabel: g.length ? g.map(garmentLabel).join(', ') : 'inga angivna' };
  });
  const rowById = (uid) => rows.find((r) => r.id === uid);

  const toggleActive = async (row) => {
    try {
      if (row.kind === 'user') {
        await updateDoc(doc(db, 'users', row.id), { active: !row.active });
      }
      // Mirror onto the tier doc so the routing resolver (client + server) can
      // skip a deactivated printer without a users/ read — a routed line must
      // never land on a printer printGuard would reject. For an API printer
      // this flag IS the switch (no users doc exists).
      await setDoc(doc(db, 'printers', row.id), { active: !row.active }, { merge: true });
      toast.success(row.active ? 'Tryckeri inaktiverat' : 'Tryckeri aktiverat');
      load();
    } catch (e) {
      toast.error('Kunde inte ändra status.');
    }
  };

  // ── Tier editor ──────────────────────────────────────────────────────────
  const toggleEditor = (row) => {
    setAreasChanged([]);
    if (openUid === row.id) { setOpenUid(null); setForm(null); return; }
    setOpenUid(row.id);
    setForm(docToForm(tiers[row.id]));
  };

  // Prefill Kim's standard list: check every garment it prices and fill both
  // price maps. Nothing is written until Save.
  const fillDefaults = () =>
    setForm((f) => {
      const priced = POD_GARMENTS.filter((g) => typeof DEFAULT_TIER.blankCostSek[g.id] === 'number');
      return {
        ...f,
        garments: new Set([...f.garments, ...priced.map((g) => g.id)]),
        blank: { ...f.blank, ...Object.fromEntries(priced.map((g) => [g.id, String(DEFAULT_TIER.blankCostSek[g.id])])) },
        print: { ...f.print, ...Object.fromEntries(PRICED_SLOTS.map((s) => [s.id, DEFAULT_TIER.printCostSek[s.id] != null ? String(DEFAULT_TIER.printCostSek[s.id]) : f.print[s.id]])) },
      };
    });

  const saveTier = async (row) => {
    if (savingTier) return;
    const incomplete = incompleteAreaCells(form);
    if (incomplete.length) {
      toast.error(`Ange både bredd och höjd (eller inget) för: ${incomplete.join(', ')}.`);
      return;
    }
    setSavingTier(true);
    try {
      const garments = POD_GARMENTS.filter((g) => form.garments.has(g.id)).map((g) => g.id);
      const printAreasMm = formToPrintAreas(form);
      const payload = {
        // A user printer is named after its account (as before); an API /
        // account-less printer keeps the name on its tier doc (row.title).
        name: row.title || row.id,
        active: row.active === true,
        garments,
        pricing: formToPricing(form),
        printAreasMm,
        provisionalAreas: garments.filter((g) => form.provisional.has(g)),
        updatedAt: serverTimestamp(),
        updatedBy: auth.currentUser?.uid || null,
      };
      // mergeFields, not merge:true: a deep merge would keep a price or a print
      // frame the operator just EMPTIED alive inside the nested maps — and an
      // emptied frame must mean "cannot print". The listed fields are replaced
      // whole; any other field on the doc (type, catalog, shippingSek from the
      // SnapWear seed) survives.
      await setDoc(doc(db, 'printers', row.id), payload, { mergeFields: Object.keys(payload) });
      const before = tiers[row.id]?.printAreasMm || {};
      const changed = POD_GARMENTS
        .filter((g) => stable(before[g.id]) !== stable(printAreasMm[g.id]))
        .map((g) => g.label);
      setAreasChanged(changed);
      setTiers((t) => ({ ...t, [row.id]: { ...(t[row.id] || {}), id: row.id, ...payload } }));
      toast.success('Plagg, priser & tryckytor sparade.');
    } catch (e) {
      console.error('saveTier failed:', e);
      toast.error('Kunde inte spara plagg & priser.');
    } finally {
      setSavingTier(false);
    }
  };

  // ── Routing ──────────────────────────────────────────────────────────────
  // The printers that can be routed a garment: those with a printers/{uid} tier
  // listing it. A printer without a tier doc has nothing to price with, so it
  // is not offerable — that is exactly the eligibility rule the resolver in
  // src/wagons/pod-wagon/printRouting.js applies, kept identical on purpose.
  const printersFor = (garmentId) =>
    rows.filter((r) => r.active && (tiers[r.id]?.garments || []).includes(garmentId));
  // Any active printer with a tier may be the default. Since SnapWear A4 the
  // resolver sends it only the garments it LISTS — a garment it does not make
  // stays unrouted (hidden in the studio, refused at checkout).
  const defaultCandidates = rows.filter((r) => r.active && tiers[r.id]);
  const printerLabel = (uid) => rowById(uid)?.title || tiers[uid]?.name || uid;
  const routeDirty =
    defaultUid !== savedDefaultUid ||
    POD_GARMENTS.some((g) => (route[g.id] || '') !== (savedRoute[g.id] || ''));

  const saveRouting = async () => {
    if (savingRoute) return;
    setSavingRoute(true);
    try {
      // Only real routes are stored — '' (no explicit rule) drops the key so the
      // doc reads as the operator's intent rather than a map of empty strings.
      const byGarment = Object.fromEntries(
        POD_GARMENTS.map((g) => [g.id, route[g.id]]).filter(([, uid]) => !!uid)
      );
      // Which garments actually changed printer — the notice below names them.
      const changed = POD_GARMENTS.filter((g) => (route[g.id] || '') !== (savedRoute[g.id] || ''));
      await setDoc(doc(db, 'settings', 'printRouting'), {
        byGarment,
        defaultPrinterUid: defaultUid || null,
        updatedAt: serverTimestamp(),
        updatedBy: auth.currentUser?.uid || null,
      }, { merge: true });
      setSavedRoute({ ...route });
      setSavedDefaultUid(defaultUid);
      setRerouted(changed.map((g) => g.label));
      toast.success('Styrning sparad.');
    } catch (e) {
      console.error('saveRouting failed:', e);
      toast.error('Kunde inte spara styrningen.');
    } finally {
      setSavingRoute(false);
    }
  };

  return (
    <PlatformLayout>
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        <h1 className="mb-1 text-lg font-bold">Tryckerier</h1>
        <p className="mb-5 text-sm text-gray-400">
          Skapa och hantera tryckerikonton. Ett tryckeri ser endast POD-ordrar för sina tilldelade butiker
          (via säkra serveranrop — ingen direkt databasåtkomst, inga kunduppgifter utöver leveransadress).
        </p>

        {/* Create form */}
        <form onSubmit={handleCreate} className="mb-8 rounded-xl border border-white/10 bg-white/5 p-4">
          <h2 className="mb-3 text-sm font-semibold">Nytt tryckerikonto</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-gray-400">E-post</label>
              <input value={email} onChange={(e) => setEmail(e.target.value)} type="email"
                className="w-full rounded-lg bg-gray-800 border border-white/10 px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-indigo-400 focus:outline-none"
                placeholder="tryckeri@exempel.se" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-400">Namn</label>
              <input value={name} onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg bg-gray-800 border border-white/10 px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-indigo-400 focus:outline-none"
                placeholder="t.ex. Tryckeri AB" />
            </div>
          </div>
          <div className="mt-3">
            <label className="mb-1 block text-xs text-gray-400">Tilldelade butiker</label>
            <div className="flex flex-wrap gap-2">
              {shops.map((s) => {
                const on = selectedShops.includes(s.id);
                return (
                  <button key={s.id} type="button" onClick={() => toggleShop(s.id)}
                    className={'rounded-lg border px-3 py-1.5 text-sm ' + (on ? 'border-indigo-400 bg-indigo-500/20 text-indigo-200' : 'border-white/10 bg-gray-800 text-gray-300 hover:bg-white/10')}>
                    {s.name || s.id}
                  </button>
                );
              })}
              {shops.length === 0 && <span className="text-sm text-gray-500">Inga butiker.</span>}
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <button type="submit" disabled={saving}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
              {saving ? 'Skapar…' : 'Skapa tryckerikonto'}
            </button>
          </div>
        </form>

        {/* Routing — which printer makes which garment (settings/printRouting) */}
        <section className="mb-8 rounded-xl border border-white/10 bg-white/5 p-4">
          <h2 className="mb-1 text-sm font-semibold">Styrning per plagg</h2>
          <p className="mb-4 text-xs text-gray-500">
            Välj vilket tryckeri som tillverkar varje plaggtyp. Ett tryckeri kan väljas för ett plagg
            först när det kryssat i plagget under “Plagg &amp; priser”. Produktens produktionskostnad —
            och därmed prisgolvet — hämtas från det valda tryckeriets prislista.
          </p>

          <div className="mb-4 grid gap-2 sm:grid-cols-2">
            {POD_GARMENTS.map((g) => {
              const options = printersFor(g.id);
              return (
                <div key={g.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-gray-900 px-3 py-2">
                  <span className="truncate text-sm text-gray-300">{g.label}</span>
                  <select
                    value={route[g.id] || ''}
                    onChange={(e) => setRoute((r) => ({ ...r, [g.id]: e.target.value }))}
                    className={`w-48 ${inputCls}`}
                  >
                    <option value="">— standard —</option>
                    {options.map((p) => (
                      <option key={p.id} value={p.id}>{printerLabel(p.id)}</option>
                    ))}
                    {/* A route saved earlier to a printer that no longer offers this
                        garment must stay VISIBLE, or the operator sees "— standard —"
                        while the doc still says otherwise. The resolver already
                        ignores such a route (it falls through to the default), so the
                        option is labelled as the dead rule it is. */}
                    {route[g.id] && !options.some((p) => p.id === route[g.id]) && (
                      <option value={route[g.id]}>{printerLabel(route[g.id])} (erbjuder inte plagget)</option>
                    )}
                  </select>
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
            <label className="flex items-center gap-3 text-sm text-gray-300">
              Standardtryckeri
              <select value={defaultUid} onChange={(e) => setDefaultUid(e.target.value)} className={`w-48 ${inputCls}`}>
                <option value="">— inget —</option>
                {defaultCandidates.map((p) => (
                  <option key={p.id} value={p.id}>{printerLabel(p.id)}</option>
                ))}
              </select>
            </label>
            <button type="button" onClick={saveRouting} disabled={savingRoute || !routeDirty} className={btnPrimary}>
              {savingRoute ? 'Sparar…' : 'Spara styrning'}
            </button>
          </div>

          <p className="mt-3 text-xs text-gray-500">
            Plagg utan eget val går till standardtryckeriet — men bara om det tillverkar plagget. Ett plagg
            som inget tryckeri tillverkar visas inte i designstudion och kan inte köpas.
          </p>

          {/* Frozen-cost notice. podCostSek is stamped on the product at publish
              time and deliberately NOT recomputed, so a reroute changes only what
              NEW products cost. A scan listing existing products now priced below
              their floor is a later add (it needs a cross-shop products query). */}
          {rerouted.length > 0 && (
            <p className="mt-3 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              Prisgolvet kan ha ändrats för produkter av typen {rerouted.join(', ')} — befintliga
              produkter prissätts inte om automatiskt.
            </p>
          )}
        </section>

        {/* Existing printers */}
        <h2 className="mb-2 text-sm font-semibold">Befintliga tryckerier</h2>
        {loading ? (
          <p className="text-sm text-gray-400">Laddar…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-gray-400">Inga tryckerier ännu.</p>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => (
              <PrinterRow
                key={r.id}
                row={r}
                open={openUid === r.id}
                form={openUid === r.id ? form : null}
                setForm={setForm}
                saving={savingTier}
                areasNotice={openUid === r.id ? areasChanged : []}
                onToggleEditor={() => toggleEditor(r)}
                onToggleActive={() => toggleActive(r)}
                onFillDefaults={fillDefaults}
                onSave={() => saveTier(r)}
              />
            ))}
          </div>
        )}
      </div>
    </PlatformLayout>
  );
};

export default PlatformPrinters;
