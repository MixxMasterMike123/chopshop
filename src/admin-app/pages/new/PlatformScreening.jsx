// Plattform → Inställningar → Varumärkesfilter (unit CP5-FL): the terms the
// product screening matches, add / change / remove, and a re-screen run. A
// change that moves the storefront (a term that blocks, a removed blocking
// term, a re-screen) says what it does before it is sent; the server's
// counts are shown after. The page is locked while a write runs; a lost
// answer is read back (platformSettingsData.js). The global hard block is
// read beside the terms: while it is on, every term blocks. While it is NOT
// KNOWN (the settings could not be read) the page says so and takes no write,
// and it is read again before each write's confirm is written.
// New page of the admin build: no older page, no alias row.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { MagnifyingGlassIcon, ShieldCheckIcon } from '@heroicons/react/24/outline';
import PlatformLayout from '../../../components/platform/PlatformLayout';
import {
  MAX_SCREENING_TERMS,
  MAX_TERM_NOTE_LENGTH,
  TERM_KINDS,
  addTermConfirm,
  deleteTermConfirm,
  newTermBody,
  policyKnown,
  rescreenConfirm,
  rescreenResultText,
  rescreenSummaryText,
  termChanges,
  termKindLabel,
  updateTermConfirm,
} from '../../adapters/platformSettings.js';
import { dateText } from '../../adapters/termsVersions.js';
import { addTerm, loadGlobalHardBlock, loadScreening, removeTerm, runRescreen, updateTerm } from './platformSettingsData.js';
import {
  Card, ConfirmDialog, LoadError, Loading, SettingsHeader,
  btnPrimary, btnPrimarySm, btnQuiet, btnRowDanger, errorCls, inputCls, noticeCls, pillCls,
} from './platformKit.jsx';

const checkboxCls = 'rounded border-white/20 bg-gray-950 text-indigo-500 focus:ring-indigo-500'; // PrinterRow.jsx
const EMPTY_FORM = { term: '', kind: 'brand', hardBlock: false, note: '' };
const byTerm = (a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0);

const BlockPill = ({ blocks }) => (
  <span className={`${pillCls} ${blocks ? 'bg-red-500/15 text-red-300' : 'bg-amber-500/15 text-amber-300'}`}>
    {blocks ? 'Spärrar' : 'Flaggar'}
  </span>
);

export default function PlatformScreening() {
  const [terms, setTerms] = useState([]);
  const [termsVersion, setTermsVersion] = useState(null);
  const [globalHardBlock, setGlobalHardBlock] = useState(null); // null: not known
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [query, setQuery] = useState('');
  const [editKey, setEditKey] = useState(null);
  const [editDraft, setEditDraft] = useState(null);
  const [editError, setEditError] = useState('');
  const [busy, setBusy] = useState(false); // one write at a time; everything is locked meanwhile
  const [busyWhat, setBusyWhat] = useState(null); // 'add' | 'edit' | null: which button says "Sparar…"
  const [pending, setPending] = useState(null); // { confirm, run }
  const [confirmError, setConfirmError] = useState('');
  const [status, setStatus] = useState(null); // { text, warn }
  const [rescreen, setRescreen] = useState(null); // the last run's counts

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) {
      setLoading(true);
      setLoadError('');
    }
    try {
      const page = await loadScreening();
      setTerms([...page.terms].sort(byTerm));
      setTermsVersion(page.termsVersion);
      setGlobalHardBlock(page.globalHardBlock);
    } catch (e) {
      if (!quiet) setLoadError(e.userMessage || 'Varumärkesfiltret kunde inte läsas.');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? terms.filter((t) => t.term.toLowerCase().includes(q) || (t.note ?? '').toLowerCase().includes(q)) : terms;
  }, [terms, query]);

  // No write while the global hard block is not known: null is not "off".
  const locked = busy || !policyKnown(globalHardBlock);

  /**
   * The global hard block as the server holds it NOW, for the confirm about
   * to be written (someone may have switched it since the page loaded).
   * → true / false, or null: it cannot be read, the page is locked and says so.
   */
  const freshPolicy = async () => {
    setBusy(true);
    try {
      const now = await loadGlobalHardBlock();
      setGlobalHardBlock(now);
      return now;
    } finally {
      setBusy(false);
    }
  };

  const ask = (confirm, run) => {
    setConfirmError('');
    setPending({ confirm, run });
  };
  const cancelConfirm = useCallback(() => {
    setPending(null);
    setConfirmError('');
  }, []);

  /** Runs one write: the page is locked; a refusal lands in the confirm, or at `onError`. */
  const perform = async (run, onError, what = null) => {
    setBusy(true);
    setBusyWhat(what);
    try {
      await run();
      setPending(null);
      setConfirmError('');
      await load({ quiet: true }); // the list and its version as the server holds them now
    } catch (e) {
      const message = e.userMessage || 'Ändringen gick inte igenom.';
      if (pending) setConfirmError(message);
      else onError(message);
    } finally {
      setBusy(false);
      setBusyWhat(null);
    }
  };

  const summaryAfter = (lead, answer) => {
    const summary = answer.readBack
      ? 'Svaret kom aldrig fram, så hur många produkter som påverkades kunde inte läsas.'
      : rescreenSummaryText(answer.rescreen);
    setStatus({ text: [lead, summary].filter(Boolean).join(' '), warn: (answer.rescreen?.blockedNow ?? 0) > 0 });
  };

  // ── add ──
  const submitAdd = async (e) => {
    e.preventDefault();
    if (locked) return;
    const parsed = newTermBody(form);
    if (parsed.problem) { setFormError(parsed.problem); return; }
    const policy = await freshPolicy();
    if (!policyKnown(policy)) return;
    const run = async () => {
      const answer = await addTerm(parsed.body, terms);
      setForm(EMPTY_FORM);
      setFormError('');
      summaryAfter(`"${answer.term.term}" lades till.`, answer);
      toast.success('Ordet lades till.');
    };
    const confirm = addTermConfirm(parsed.body, policy);
    if (confirm) ask(confirm, run);
    else perform(run, setFormError, 'add');
  };

  // ── change ──
  const startEdit = (t) => {
    if (locked) return;
    setEditKey(t.termKey);
    setEditDraft({ kind: t.kind, hardBlock: t.hardBlock, note: t.note ?? '' });
    setEditError('');
  };
  const stopEdit = () => {
    if (busy) return;
    setEditKey(null);
    setEditDraft(null);
    setEditError('');
  };
  const submitEdit = async (t) => {
    if (locked) return;
    const changes = termChanges(t, editDraft);
    if (Object.keys(changes).length === 0) { stopEdit(); return; }
    if ((changes.note ?? '').length > MAX_TERM_NOTE_LENGTH) { setEditError(`Anteckningen får vara högst ${MAX_TERM_NOTE_LENGTH} tecken.`); return; }
    const policy = await freshPolicy();
    if (!policyKnown(policy)) return;
    const run = async () => {
      const answer = await updateTerm(t, changes);
      setEditKey(null);
      setEditDraft(null);
      summaryAfter(`"${t.term}" ändrades.`, answer);
      toast.success('Ändringen är sparad.');
    };
    const confirm = updateTermConfirm(t, changes, policy);
    if (confirm) ask(confirm, run);
    else perform(run, setEditError, 'edit');
  };

  // ── remove ──
  const askRemove = async (t) => {
    if (locked) return;
    const policy = await freshPolicy();
    if (!policyKnown(policy)) return;
    ask(deleteTermConfirm(t, policy), async () => {
      const answer = await removeTerm(t);
      if (editKey === t.termKey) { setEditKey(null); setEditDraft(null); }
      summaryAfter(`"${t.term}" togs bort.`, answer);
      toast.success('Ordet togs bort.');
    });
  };

  // ── re-screen ──
  const askRescreen = async () => {
    if (locked) return;
    const policy = await freshPolicy();
    if (!policyKnown(policy)) return;
    ask(rescreenConfirm(policy), async () => {
      const result = await runRescreen();
      setRescreen(result);
      toast.success('Omgranskningen kördes.');
    });
  };

  const full = terms.length >= MAX_SCREENING_TERMS;

  return (
    <PlatformLayout>
      <div className="max-w-5xl px-6 py-8 lg:px-10">
        <SettingsHeader
          active="screening"
          subtitle="Ord som produkttexter kontrolleras mot när en produkt publiceras eller ändras. En träff flaggar produkten för granskning; ett ord som spärrar tar den ur butiken."
        />

        {loading ? (
          <Loading />
        ) : loadError ? (
          <LoadError icon={ShieldCheckIcon} message={loadError} onRetry={() => load()} />
        ) : (
          <div className="space-y-5">
            {!policyKnown(globalHardBlock) && (
              <div role="alert" className={`${noticeCls} flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6`}>
                <p>
                  Det gick inte att läsa om "Alla träffar spärrar" är på. Utan det går det inte att säga vad en ändring gör i butikerna,
                  så filtret kan inte ändras eller granskas om förrän inställningen har lästs.
                </p>
                <button type="button" className={`${btnQuiet} shrink-0 self-start sm:self-auto`} onClick={() => freshPolicy()} disabled={busy}>
                  Försök igen
                </button>
              </div>
            )}
            {globalHardBlock === true && (
              <p className={noticeCls}>
                "Alla träffar spärrar" är på under <Link to="/settings" className="underline hover:text-amber-100">Allmänt</Link>:
                varje ord i filtret spärrar, oavsett sin egen markering.
              </p>
            )}

            <Card title="Lägg till ord">
              <form onSubmit={submitAdd} className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                  <div>
                    <label htmlFor="fl-term" className="mb-1 block text-xs text-gray-400">Ord</label>
                    <input
                      id="fl-term"
                      value={form.term}
                      onChange={(e) => { setForm((f) => ({ ...f, term: e.target.value })); setFormError(''); }}
                      disabled={locked || full}
                      placeholder="t.ex. ett bandnamn eller ett varumärke"
                      aria-describedby="fl-term-help"
                      className={`w-full ${inputCls}`}
                    />
                  </div>
                  <div>
                    <label htmlFor="fl-kind" className="mb-1 block text-xs text-gray-400">Typ</label>
                    <select
                      id="fl-kind"
                      value={form.kind}
                      onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
                      disabled={locked || full}
                      className={`w-full ${inputCls}`}
                    >
                      {TERM_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <label htmlFor="fl-note" className="mb-1 block text-xs text-gray-400">Anteckning (valfri, syns bara här)</label>
                  <input
                    id="fl-note"
                    value={form.note}
                    maxLength={MAX_TERM_NOTE_LENGTH}
                    onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                    disabled={locked || full}
                    placeholder="t.ex. vem som begärt spärren"
                    className={`w-full ${inputCls}`}
                  />
                </div>
                <p id="fl-term-help" className="text-xs text-gray-500">
                  Ordet sparas i den form filtret jämför med: små bokstäver, utan accenter och skiljetecken ("AC/DC" blir "ac dc").
                  Ett ord av bara symboler, som ™, sparas som det skrivs.
                </p>
                <div className="flex flex-col gap-3 border-t border-white/10 pt-3 sm:flex-row sm:items-center sm:justify-between">
                  <label className="flex items-start gap-2 text-sm text-gray-300">
                    <input
                      type="checkbox"
                      checked={form.hardBlock}
                      onChange={(e) => setForm((f) => ({ ...f, hardBlock: e.target.checked }))}
                      disabled={locked || full}
                      className={`mt-0.5 ${checkboxCls}`}
                    />
                    <span>Spärrar: en träff tar produkten ur butiken direkt</span>
                  </label>
                  <button type="submit" className={btnPrimary} disabled={locked || full}>
                    {busyWhat === 'add' ? 'Sparar…' : 'Lägg till'}
                  </button>
                </div>
                {full && <p className={noticeCls}>Filtret är fullt: det rymmer högst {MAX_SCREENING_TERMS.toLocaleString('sv-SE')} ord.</p>}
                {formError && <p role="alert" className={errorCls}>{formError}</p>}
              </form>
            </Card>

            <Card title="Omgranskning">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
                <p className="max-w-xl text-sm leading-relaxed text-gray-400">
                  När filtret ändras granskas publicerade produkter om automatiskt, högst 25 åt gången var 15:e minut.
                  Produkter som ett nytt spärrande ord träffar tas bort ur butikerna redan när du sparar ordet.
                </p>
                <button type="button" className={`${btnQuiet} shrink-0 self-start`} onClick={askRescreen} disabled={locked}>
                  {rescreen?.pending > 0 ? 'Granska nästa omgång…' : 'Granska om nu…'}
                </button>
              </div>
              {rescreen && (
                <p role="status" className="mt-4 rounded-lg border border-white/10 bg-gray-950 px-3 py-2 text-xs text-gray-300">
                  {rescreenResultText(rescreen)}
                </p>
              )}
            </Card>

            <section aria-labelledby="fl-terms-heading">
              <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h2 id="fl-terms-heading" className="text-sm font-semibold uppercase tracking-wider text-gray-500">Ord i filtret</h2>
                  <p className="mt-1 text-xs text-gray-500">
                    {terms.length === 1 ? '1 ord' : `${terms.length.toLocaleString('sv-SE')} ord`}
                    {termsVersion !== null && <> · filtrets version {termsVersion}</>}
                  </p>
                </div>
                {terms.length > 0 && (
                  <label className="relative block sm:w-64">
                    <span className="sr-only">Sök bland orden</span>
                    <MagnifyingGlassIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
                    <input
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Sök ord eller anteckning"
                      className={`w-full pl-8 ${inputCls}`}
                    />
                  </label>
                )}
              </div>

              {status && (
                <p role="status" className={`mb-3 ${status.warn ? noticeCls : 'rounded-lg border border-white/10 bg-gray-950 px-3 py-2 text-xs text-gray-300'}`}>
                  {status.text}
                </p>
              )}

              {terms.length === 0 ? (
                <div className="rounded-xl border border-white/10 bg-gray-900 py-12 text-center text-sm text-gray-500">
                  <ShieldCheckIcon className="mx-auto mb-3 h-10 w-10 text-gray-700" />
                  Filtret är tomt. Lägg till ett ord ovan; produkter som innehåller det flaggas för granskning.
                </div>
              ) : shown.length === 0 ? (
                <div className="rounded-xl border border-white/10 bg-gray-900 py-12 text-center text-sm text-gray-500">
                  Inget ord matchar "{query.trim()}".
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-white/10 bg-gray-900">
                  <table className="min-w-full divide-y divide-white/10 text-sm">
                    <thead>
                      <tr className="text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
                        <th className="px-4 py-3">Ord</th>
                        <th className="hidden px-4 py-3 sm:table-cell">Typ</th>
                        <th className="px-4 py-3">Vid träff</th>
                        <th className="hidden px-4 py-3 md:table-cell">Anteckning</th>
                        <th className="hidden px-4 py-3 md:table-cell">Tillagt</th>
                        <th className="px-4 py-3 text-right"><span className="sr-only sm:not-sr-only">Åtgärder</span></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {shown.map((t) => (
                        <React.Fragment key={t.termKey}>
                          <tr className={editKey === t.termKey ? 'bg-white/[0.03]' : 'hover:bg-white/5'}>
                            <td className="px-4 py-3 font-medium text-white">{t.term}</td>
                            <td className="hidden whitespace-nowrap px-4 py-3 text-gray-300 sm:table-cell">{termKindLabel(t.kind)}</td>
                            <td className="px-4 py-3"><BlockPill blocks={t.hardBlock || globalHardBlock === true} /></td>
                            <td className="hidden max-w-xs px-4 py-3 text-gray-400 md:table-cell"><span className="line-clamp-2">{t.note || '–'}</span></td>
                            <td className="hidden whitespace-nowrap px-4 py-3 tabular-nums text-gray-400 md:table-cell">{dateText(t.createdAt)}</td>
                            <td className="px-4 py-3">
                              <div className="flex flex-col items-end gap-1.5 whitespace-nowrap sm:flex-row sm:justify-end sm:gap-2">
                                <button type="button" className={btnQuiet} onClick={() => (editKey === t.termKey ? stopEdit() : startEdit(t))} disabled={editKey === t.termKey ? busy : locked}>
                                  {editKey === t.termKey ? 'Stäng' : 'Ändra'}
                                </button>
                                <button type="button" className={btnRowDanger} onClick={() => askRemove(t)} disabled={locked} aria-label={`Ta bort ${t.term}`}>
                                  Ta bort
                                </button>
                              </div>
                            </td>
                          </tr>
                          {editKey === t.termKey && editDraft && (
                            <tr className="bg-white/[0.03]">
                              <td colSpan={6} className="px-4 pb-4 pt-1">
                                <div className="grid gap-3 rounded-xl border border-white/10 bg-gray-950/60 p-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
                                  <div>
                                    <label htmlFor="fl-edit-kind" className="mb-1 block text-xs text-gray-400">Typ</label>
                                    <select
                                      id="fl-edit-kind"
                                      value={editDraft.kind}
                                      onChange={(e) => setEditDraft((d) => ({ ...d, kind: e.target.value }))}
                                      disabled={busy}
                                      className={`w-full ${inputCls}`}
                                    >
                                      {TERM_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                                    </select>
                                  </div>
                                  <div>
                                    <label htmlFor="fl-edit-note" className="mb-1 block text-xs text-gray-400">Anteckning</label>
                                    <input
                                      id="fl-edit-note"
                                      value={editDraft.note}
                                      maxLength={MAX_TERM_NOTE_LENGTH}
                                      onChange={(e) => setEditDraft((d) => ({ ...d, note: e.target.value }))}
                                      disabled={busy}
                                      className={`w-full ${inputCls}`}
                                    />
                                  </div>
                                  <label className="flex items-start gap-2 text-sm text-gray-300 sm:col-span-2">
                                    <input
                                      type="checkbox"
                                      checked={editDraft.hardBlock}
                                      onChange={(e) => setEditDraft((d) => ({ ...d, hardBlock: e.target.checked }))}
                                      disabled={busy}
                                      className={`mt-0.5 ${checkboxCls}`}
                                    />
                                    <span>Spärrar: en träff tar produkten ur butiken direkt</span>
                                  </label>
                                  <p className="text-xs text-gray-500 sm:col-span-2">Själva ordet kan inte ändras: ta bort det och lägg till det nya.</p>
                                  {editError && <p role="alert" className={`${errorCls} sm:col-span-2`}>{editError}</p>}
                                  <div className="flex justify-end gap-2 sm:col-span-2">
                                    <button type="button" className={btnQuiet} onClick={stopEdit} disabled={busy}>Avbryt</button>
                                    <button type="button" className={btnPrimarySm} onClick={() => submitEdit(t)} disabled={locked}>
                                      {busyWhat === 'edit' ? 'Sparar…' : 'Spara'}
                                    </button>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
      </div>

      <ConfirmDialog
        confirm={pending?.confirm}
        busy={busy}
        error={confirmError}
        onCancel={cancelConfirm}
        onConfirm={() => perform(pending.run, () => {})}
      />
    </PlatformLayout>
  );
}
