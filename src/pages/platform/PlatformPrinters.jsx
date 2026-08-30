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
import { POD_GARMENTS, garmentLabel } from '../../config/podGarments';
import { POD_SLOTS } from '../../config/podSlots';
import toast from 'react-hot-toast';

// Shared platform-surface classes (same strings as PlatformDac7.jsx).
const inputCls = 'rounded-lg border border-white/10 bg-gray-950 px-3 py-1.5 text-sm text-gray-100 placeholder-gray-600 focus:border-indigo-500 focus:outline-none';
const btnPrimary = 'rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50';
const btnGhost = 'rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-gray-200 hover:bg-white/10 disabled:opacity-50';
const checkboxCls = 'rounded border-white/20 bg-gray-950 text-indigo-500 focus:ring-indigo-500';

// Priced print slots — 'other' is deliberately excluded: it is the catch-all
// placement in podSlots.js, not a surface the printer quotes a price for.
const PRICED_SLOTS = POD_SLOTS.filter((s) => s.id !== 'other');

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

/** Firestore doc → form state (numbers → strings; missing → ''). */
const docToForm = (p) => {
  const garments = Array.isArray(p?.garments) ? p.garments : [];
  const blank = p?.pricing?.blankCostSek || {};
  const print = p?.pricing?.printCostSek || {};
  const str = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
  return {
    garments: new Set(garments),
    blank: Object.fromEntries(POD_GARMENTS.map((g) => [g.id, str(blank[g.id])])),
    print: Object.fromEntries(PRICED_SLOTS.map((s) => [s.id, str(print[s.id])])),
  };
};

/**
 * Form state → the stored pricing maps. Empty/blank/invalid → key OMITTED
 * (see the header note: absent ≠ 0). Blank prices are kept only for garments
 * the printer actually offers, so unchecking a garment drops its price too.
 */
const formToPricing = (form) => {
  const num = (v) => {
    const s = String(v ?? '').trim().replace(',', '.');
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const pick = (entries) => Object.fromEntries(entries.filter(([, n]) => n !== null));
  return {
    blankCostSek: pick(POD_GARMENTS.filter((g) => form.garments.has(g.id)).map((g) => [g.id, num(form.blank[g.id])])),
    printCostSek: pick(PRICED_SLOTS.map((s) => [s.id, num(form.print[s.id])])),
  };
};

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

  const toggleActive = async (printer) => {
    try {
      await updateDoc(doc(db, 'users', printer.id), { active: !printer.active });
      // Mirror onto the tier doc so the routing resolver (client + server) can
      // skip a deactivated printer without a users/ read — a routed line must
      // never land on a printer printGuard would reject.
      await setDoc(doc(db, 'printers', printer.id), { active: !printer.active }, { merge: true });
      toast.success(printer.active ? 'Konto inaktiverat' : 'Konto aktiverat');
      load();
    } catch (e) {
      toast.error('Kunde inte ändra status.');
    }
  };

  const shopName = (id) => shops.find((s) => s.id === id)?.name || id;

  // ── Tier editor ──────────────────────────────────────────────────────────
  const toggleEditor = (printer) => {
    if (openUid === printer.id) { setOpenUid(null); setForm(null); return; }
    setOpenUid(printer.id);
    setForm(docToForm(tiers[printer.id]));
  };

  const toggleGarment = (id) =>
    setForm((f) => {
      const garments = new Set(f.garments);
      if (garments.has(id)) garments.delete(id); else garments.add(id);
      return { ...f, garments };
    });

  const setBlank = (id, v) => setForm((f) => ({ ...f, blank: { ...f.blank, [id]: v } }));
  const setPrint = (id, v) => setForm((f) => ({ ...f, print: { ...f.print, [id]: v } }));

  // Prefill Kim's standard list: check every garment it prices and fill both
  // price maps. Nothing is written until Save.
  const fillDefaults = () =>
    setForm((f) => {
      const priced = POD_GARMENTS.filter((g) => typeof DEFAULT_TIER.blankCostSek[g.id] === 'number');
      return {
        garments: new Set([...f.garments, ...priced.map((g) => g.id)]),
        blank: { ...f.blank, ...Object.fromEntries(priced.map((g) => [g.id, String(DEFAULT_TIER.blankCostSek[g.id])])) },
        print: { ...f.print, ...Object.fromEntries(PRICED_SLOTS.map((s) => [s.id, DEFAULT_TIER.printCostSek[s.id] != null ? String(DEFAULT_TIER.printCostSek[s.id]) : f.print[s.id]])) },
      };
    });

  const saveTier = async (printer) => {
    if (savingTier) return;
    setSavingTier(true);
    try {
      const payload = {
        name: printer.contactPerson || printer.email || printer.id,
        active: printer.active === true,
        garments: POD_GARMENTS.filter((g) => form.garments.has(g.id)).map((g) => g.id),
        pricing: formToPricing(form),
        updatedAt: serverTimestamp(),
        updatedBy: auth.currentUser?.uid || null,
      };
      // merge:true so a future slice can add fields to the doc without this
      // form wiping them; the three keys above are fully replaced each save.
      await setDoc(doc(db, 'printers', printer.id), payload, { merge: true });
      setTiers((t) => ({ ...t, [printer.id]: { ...(t[printer.id] || {}), id: printer.id, ...payload } }));
      toast.success('Plagg & priser sparade.');
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
    printers.filter((p) => p.active && (tiers[p.id]?.garments || []).includes(garmentId));
  // Any printer with a tier may be the catch-all default (it need not list
  // every garment — an unpriced blank simply falls back to the template price).
  const defaultCandidates = printers.filter((p) => p.active && tiers[p.id]);
  const printerLabel = (uid) => {
    const p = printers.find((x) => x.id === uid);
    return p?.contactPerson || p?.email || tiers[uid]?.name || uid;
  };
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
            Plagg utan eget val går till standardtryckeriet. Saknas både val och standard — eller har
            tryckeriet inget blankpris för plagget — används mallens gamla priser.
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
        ) : printers.length === 0 ? (
          <p className="text-sm text-gray-400">Inga tryckerikonton ännu.</p>
        ) : (
          <div className="space-y-2">
            {printers.map((p) => {
              const tier = tiers[p.id];
              const tierGarments = Array.isArray(tier?.garments) ? tier.garments : [];
              const open = openUid === p.id;
              return (
              <div key={p.id} className="rounded-lg border border-white/10 bg-white/5">
                <div className="flex items-center justify-between px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-white">{p.contactPerson || p.email}</span>
                      <span className={'rounded px-1.5 py-0.5 text-xs ' + (p.active ? 'bg-emerald-500/15 text-emerald-300' : 'bg-gray-500/20 text-gray-400')}>
                        {p.active ? 'Aktiv' : 'Inaktiv'}
                      </span>
                    </div>
                    <div className="truncate text-xs text-gray-400">
                      {p.email} · butiker: {(p.printShopShops || []).map(shopName).join(', ') || '—'}
                    </div>
                    <div className="truncate text-xs text-gray-500">
                      plagg: {tierGarments.length ? tierGarments.map(garmentLabel).join(', ') : 'inga angivna'}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button onClick={() => toggleEditor(p)}
                      className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-gray-200 hover:bg-white/10">
                      {open ? 'Stäng' : 'Plagg & priser'}
                    </button>
                    <button onClick={() => toggleActive(p)}
                      className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-gray-200 hover:bg-white/10">
                      {p.active ? 'Inaktivera' : 'Aktivera'}
                    </button>
                  </div>
                </div>

                {open && form && (
                  <div className="border-t border-white/10 px-4 py-4">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold text-white">Plagg &amp; priser</h3>
                      <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-300">
                        Alla priser ex. moms
                      </span>
                    </div>
                    <p className="mb-4 text-xs text-gray-500">
                      Kryssa i de plagg tryckeriet kan tillverka och ange blankpris per plagg samt tryckpris
                      per placering. Tomt fält = inget pris angivet (sparas inte).
                    </p>

                    <div className="mb-5">
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
                        Plagg &amp; blankpris (kr, ex. moms)
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {POD_GARMENTS.map((g) => {
                          const on = form.garments.has(g.id);
                          return (
                            <div key={g.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-gray-900 px-3 py-2">
                              <label className="flex min-w-0 items-center gap-2 text-sm text-gray-300">
                                <input type="checkbox" checked={on} onChange={() => toggleGarment(g.id)} className={checkboxCls} />
                                <span className="truncate">{g.label}</span>
                              </label>
                              <input type="number" min="0" step="1" inputMode="decimal"
                                value={form.blank[g.id]} disabled={!on}
                                onChange={(e) => setBlank(g.id, e.target.value)}
                                placeholder="—"
                                className={`w-24 text-right tabular-nums disabled:opacity-40 ${inputCls}`} />
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="mb-5">
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
                        Tryckpris per placering (kr, ex. moms)
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {PRICED_SLOTS.map((slot) => (
                          <div key={slot.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-gray-900 px-3 py-2">
                            <span className="truncate text-sm text-gray-300">{slot.label}</span>
                            <input type="number" min="0" step="1" inputMode="decimal"
                              value={form.print[slot.id]}
                              onChange={(e) => setPrint(slot.id, e.target.value)}
                              placeholder="—"
                              className={`w-24 text-right tabular-nums ${inputCls}`} />
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <button type="button" onClick={fillDefaults} className={btnGhost}>
                        Fyll i standardprislista
                      </button>
                      <button type="button" onClick={() => saveTier(p)} disabled={savingTier} className={btnPrimary}>
                        {savingTier ? 'Sparar…' : 'Spara'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
              );
            })}
          </div>
        )}
      </div>
    </PlatformLayout>
  );
};

export default PlatformPrinters;
