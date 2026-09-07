// Shared platform-console shop cells — used by both PlatformShops (fleet row)
// and PlatformShopDetail (drill-down page). Extracted so there is exactly ONE
// source for the commission editor, legal-readiness badge, and Connect-status
// label (avoids drift between the two surfaces). DARK platform design.
import React, { useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../../firebase/config';
import { getLegalReadiness } from '../../utils/legalPageReadiness';
import { PLATFORM_TERMS_VERSION } from '../../config/platformTerms';
import toast from 'react-hot-toast';

// Stripe Connect status label for a shop, derived from the payments map (which is
// platform-/Stripe-set only). Precedence: charging > has account (onboarding) >
// invited (connectEnabled) > off.
export const connectLabel = (shop) => {
  const p = shop.payments || {};
  if (p.chargesEnabled) return { text: 'Aktivt', cls: 'bg-green-500/15 text-green-300' };
  if (p.stripeAccountId) return { text: 'Onboarding', cls: 'bg-amber-500/15 text-amber-300' };
  if (p.connectEnabled) return { text: 'Inbjuden', cls: 'bg-sky-500/15 text-sky-300' };
  return { text: 'Av', cls: 'bg-white/5 text-gray-500' };
};

// Legal-pages readiness for the operator. Reads the same gate the seller's
// AdminSettings + the storefront use (legalPageReadiness.js) against the shop's
// stored storeIdentity, so the operator sees at a glance whether a shop's
// auto-generated legal pages are publishable (return address + VAT status set).
// No extra fetch: storeIdentity already rides on the loaded shop doc.
//
// Two independent facts, two pills:
//   1. the shop's CONSUMER legal pages (readiness + acceptance drift), and
//   2. the PLATFORM's B2B terms the seller must accept to use the admin
//      (shops/{id}.platformTerms, written by PlatformTermsGate).
// They are unrelated documents — a shop can be fine on one and missing the
// other — so they never collapse into a single badge.
// DARK platform design: emerald = ok, amber = drift/incomplete, red = missing.
const PILL = 'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium';
const TONE = {
  ok: 'bg-green-500/15 text-green-300',
  warn: 'bg-amber-500/15 text-amber-300',
  bad: 'bg-red-500/15 text-red-300',
};

// The platform-terms fact for a shop: { tone, text, title }.
export const platformTermsBadge = (shop) => {
  const t = shop?.platformTerms;
  const accepted = Boolean(t && String(t.acceptedAt || '').trim());
  if (!accepted) {
    return { tone: 'bad', text: 'Plattformsvillkor: ej godkända', title: 'Butiksägaren har inte godkänt plattformsvillkoren' };
  }
  if (t.version !== PLATFORM_TERMS_VERSION) {
    return {
      tone: 'warn',
      text: 'Plattformsvillkor: gammal version',
      title: `Godkänd version ${t.version || '–'}, aktuell är ${PLATFORM_TERMS_VERSION}`,
    };
  }
  return { tone: 'ok', text: `Plattformsvillkor v${t.version}`, title: `Godkända av ${t.email || t.uid || 'okänd'}` };
};

export const LegalCell = ({ shop }) => {
  const { ready, blockers, needsReacceptance } = getLegalReadiness(shop.storeIdentity || {});
  const pt = platformTermsBadge(shop);

  let legal;
  if (ready && !needsReacceptance) {
    legal = { tone: 'ok', text: 'Juridik OK', title: 'Butikens juridiska sidor är publiceringsklara' };
  } else if (ready) {
    legal = {
      tone: 'warn',
      text: 'Behöver godkännas på nytt',
      title: 'Villkorstexten har ändrats sedan butiksägarens senaste godkännande',
    };
  } else {
    legal = {
      tone: blockers.some((b) => b.key === 'acceptance') ? 'bad' : 'warn',
      text: `Ofullständig (${blockers.length})`,
      title: blockers.map((b) => b.label).join('\n'),
    };
  }

  return (
    <div className="inline-flex flex-wrap items-center gap-1.5">
      <span title={legal.title} className={`${PILL} ${TONE[legal.tone]}`}>{legal.text}</span>
      <span title={pt.title} className={`${PILL} ${TONE[pt.tone]}`}>{pt.text}</span>
    </div>
  );
};

// Per-shop platform commission — PLATFORM-ONLY (negotiate a lower fee for a big
// seller). Shows the effective fee or "Standard" (platform default applies when
// unset), with an inline editor. Percentage in/out; stored as integer basis
// points via setShopCommission (requirePlatform server-side; firestore.rules
// also blocks a direct payments-map write). The shop owner never sees this.
export const CommissionCell = ({ shop, onSaved }) => {
  const currentBps = Number.isInteger(shop.payments?.commissionBps) ? shop.payments.commissionBps : null;
  const [editing, setEditing] = useState(false);
  const [pct, setPct] = useState(currentBps != null ? (currentBps / 100).toString() : '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const n = parseFloat((pct || '').replace(',', '.'));
    if (!Number.isFinite(n) || n < 0 || n > 100) { toast.error('Ange 0–100 %.'); return; }
    const bps = Math.round(n * 100);
    try {
      setSaving(true);
      await httpsCallable(functions, 'setShopCommission')({ shopId: shop.id, commissionBps: bps });
      toast.success(`Avgift sparad: ${(bps / 100).toFixed(2)} %`);
      onSaved?.(bps);
      setEditing(false);
    } catch (e) {
      toast.error(e.message || 'Kunde inte spara avgift.');
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button
        onClick={() => { setPct(currentBps != null ? (currentBps / 100).toString() : ''); setEditing(true); }}
        title="Sätt plattformsavgift för denna butik"
        className="inline-flex items-center gap-1.5 rounded-lg bg-white/5 px-2.5 py-1 text-xs font-medium text-gray-200 hover:bg-indigo-500/15 hover:text-indigo-300"
      >
        {currentBps != null ? `${(currentBps / 100).toFixed(2)} %` : <span className="text-gray-500">Standard</span>}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number" min="0" max="100" step="0.01" value={pct} autoFocus
        onChange={(e) => setPct(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
        placeholder="5"
        className="w-16 rounded-lg border border-white/10 bg-gray-950 px-2 py-1 text-xs text-gray-100 focus:border-indigo-500 focus:outline-none"
      />
      <span className="text-xs text-gray-500">%</span>
      <button disabled={saving} onClick={save} className="rounded-lg bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
        {saving ? '…' : 'Spara'}
      </button>
      <button onClick={() => setEditing(false)} className="rounded-lg bg-white/5 px-2 py-1 text-xs text-gray-400 hover:bg-white/10">✕</button>
    </div>
  );
};
