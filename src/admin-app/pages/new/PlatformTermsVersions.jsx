// Plattform → Inställningar → Plattformsvillkor (unit CP5-FL): the versions of
// the platform terms, each one's archived text read-only (rendered as the
// sellers see it, or as source), and a new version: its two documents
// written here, published now. A publish says what it does to every shop
// before it is sent (termsVersions.js publishConfirm: re-acceptance, the
// 14-day grace of the checkout, no grace for a shop further behind, the
// text immutable). A version without its archived text (the 0031 seed) can
// get its exact text, pasted or from a file; the server checks it by its hash.
// The server gives no count of the shops that accepted a version.
// New page of the admin build: no older page, no alias row.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { DocumentTextIcon, PlusIcon } from '@heroicons/react/24/outline';
import PlatformLayout from '../../../components/platform/PlatformLayout';
import { PLATFORM_DPA_TITLE, PLATFORM_TERMS_TITLE } from '../../../config/platformTerms.js';
import { toPagePlatformTerms } from '../../../storefront/adapters/legal.js';
import { renderLegalTemplate } from '../../../utils/legalPageRenderer.js';
import {
  STATE_LABELS,
  TERMS_TEXT_MAX_BYTES,
  archiveConfirm,
  byteLength,
  composeTermsText,
  dateTimeText,
  newVersionBody,
  parseTermsText,
  publishConfirm,
  suggestedVersionLabel,
} from '../../adapters/termsVersions.js';
import {
  archiveText,
  currentVersionOf,
  loadVersionText,
  loadVersions,
  publishVersion,
  startingDocuments,
  textOfFile,
} from './termsVersionsData.js';
import {
  Card, ConfirmDialog, LoadError, Loading, SettingsHeader,
  btnPrimary, btnQuiet, errorCls, inputCls, noticeCls, pillCls, textareaCls,
} from './platformKit.jsx';

// The seller's legal typography (PlatformTermsGate.jsx LEGAL_DOC_TYPO) in the
// console's colours; the draft notice of the templates as the console's notice.
const DOC_TYPO =
  'text-sm leading-6 text-gray-200 ' +
  '[&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:text-[15px] [&_h2]:font-semibold [&_h2]:text-white ' +
  '[&_h3]:mt-4 [&_h3]:mb-1.5 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-white ' +
  '[&>*:first-child]:mt-0 [&_h1]:hidden ' +
  '[&_p]:my-3 [&_ul]:my-3 [&_ol]:my-3 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 ' +
  '[&_li]:my-1 [&_strong]:font-semibold [&_strong]:text-white [&_a]:text-indigo-300 [&_a]:underline ' +
  '[&_blockquote]:my-3 [&_blockquote]:rounded-lg [&_blockquote]:border [&_blockquote]:border-amber-400/30 ' +
  '[&_blockquote]:bg-amber-500/10 [&_blockquote]:px-3 [&_blockquote]:py-2 [&_blockquote]:text-amber-200 [&_blockquote_p]:my-0 ' +
  '[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[13px] ' +
  '[&_th]:border [&_th]:border-white/10 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left ' +
  '[&_td]:border [&_td]:border-white/10 [&_td]:px-2 [&_td]:py-1 [&_td]:align-top';

const render = (markdown) => renderLegalTemplate(markdown, {}, {});

const STATE_TONES = {
  current: 'bg-green-500/15 text-green-300',
  scheduled: 'bg-indigo-500/15 text-indigo-300',
  superseded: 'bg-white/5 text-gray-400',
};

/** The two documents as a seller reads them (the gate's own adapter), or null. */
function sellerView(version, text) {
  return toPagePlatformTerms({ version, text }, { render, dpaTitle: PLATFORM_DPA_TITLE });
}

function Documents({ version, text }) {
  const view = useMemo(() => (text ? sellerView(version, text) : null), [version, text]);
  if (!view) return null;
  return (
    <div className="space-y-4">
      {[{ title: PLATFORM_TERMS_TITLE, html: view.terms.html }, { title: view.dpa.title, html: view.dpa.html }].map((doc) => (
        <article key={doc.title} className="rounded-lg border border-white/10 bg-gray-950 p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">{doc.title}</h3>
          {/* The renderer sanitizes (DOMPurify), as on the seller's page. */}
          <div className={DOC_TYPO} dangerouslySetInnerHTML={{ __html: doc.html }} />
        </article>
      ))}
    </div>
  );
}

/**
 * The exact text of a version published without one: pasted, or read from a
 * file (the text itself, or the `{ "text": … }` body of CP3_E_REPORT.md §2).
 * A preview shows it as the sellers would; the server checks the hash.
 */
function ArchiveForm({ version, busy, onArchive }) {
  const [text, setText] = useState('');
  const [problem, setProblem] = useState('');
  const readFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > TERMS_TEXT_MAX_BYTES * 2) { setProblem('Filen är för stor för en villkorstext.'); return; }
    setText(textOfFile(await file.text()));
    setProblem('');
  };
  return (
    <div className="space-y-3 rounded-lg border border-white/10 bg-gray-950/60 p-4">
      <p className="text-sm text-gray-400">
        Texten kan läggas till i efterhand, men bara exakt den text versionen publicerades med: servern jämför den med
        kontrollsumman ovan och tar inte emot något annat.
      </p>
      <div>
        <label htmlFor={`fl-archive-${version}`} className="mb-1 block text-xs text-gray-400">Den exakta texten</label>
        <textarea
          id={`fl-archive-${version}`}
          value={text}
          onChange={(e) => { setText(e.target.value); setProblem(''); }}
          disabled={busy}
          rows={6}
          spellCheck={false}
          placeholder='{"version":"…","terms":"…","dpa":"…"}'
          className={`font-mono text-xs leading-5 ${textareaCls}`}
        />
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label className={`${btnQuiet} cursor-pointer self-start`}>
          <input type="file" accept=".txt,.json,text/plain,application/json" className="sr-only" onChange={readFile} disabled={busy} />
          Välj en fil…
        </label>
        <button
          type="button"
          className={btnPrimary}
          disabled={busy || text === ''}
          onClick={() => (text ? onArchive(version, text) : setProblem('Klistra in texten, eller välj en fil med den.'))}
        >
          Arkivera texten…
        </button>
      </div>
      {problem && <p role="alert" className={errorCls}>{problem}</p>}
      {text && parseTermsText(text) && (
        <>
          <p className="text-xs text-gray-500">Så här ser texten ut för säljarna:</p>
          <Documents version={version} text={text} />
        </>
      )}
      {text && !parseTermsText(text) && (
        <p className={noticeCls}>Texten är inte i det format säljarnas sidor läser (villkor och personuppgiftsbiträdesavtal i markdown), så säljarna skulle inte kunna se den.</p>
      )}
    </div>
  );
}

/** One version's text, read-only: as the sellers see it, or the archived source. */
function VersionText({ row, onArchive, busy }) {
  const [held, setHeld] = useState(null);
  const [error, setError] = useState('');
  const [source, setSource] = useState(false);

  useEffect(() => {
    let alive = true;
    loadVersionText(row.version)
      .then((t) => { if (alive) setHeld(t); })
      .catch((e) => { if (alive) setError(e.userMessage || 'Texten kunde inte läsas.'); });
    return () => { alive = false; };
  }, [row.version, row.textArchived]);

  if (error) return <p className={errorCls}>{error}</p>;
  if (!held) return <p className="py-4 text-sm text-gray-500">Läser texten…</p>;

  return (
    <div className="space-y-4">
      <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="text-gray-500">Publicerad</dt>
        <dd className="text-gray-300">{dateTimeText(row.publishedAt)}</dd>
        <dt className="text-gray-500">Kontrollsumma (SHA-256)</dt>
        <dd className="break-all font-mono text-gray-400">{row.sha256}</dd>
      </dl>

      {held.text === null ? (
        <div className="space-y-3">
          {row.state !== 'current' && (
            <p className={noticeCls}>Versionen har ingen arkiverad text, så säljarna kunde inte läsa den.</p>
          )}
          <ArchiveForm version={row.version} busy={busy} onArchive={onArchive} />
        </div>
      ) : held.parsed ? (
        <>
          <div className="flex justify-end">
            <button type="button" className={btnQuiet} onClick={() => setSource((s) => !s)} aria-pressed={source}>
              {source ? 'Visa som säljarna ser den' : 'Visa källtexten'}
            </button>
          </div>
          {source ? (
            <div className="space-y-4">
              {[[PLATFORM_TERMS_TITLE, held.parsed.terms], [PLATFORM_DPA_TITLE, held.parsed.dpa]].map(([title, md]) => (
                <div key={title}>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">{title}</h3>
                  <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-gray-950 p-4 font-mono text-xs leading-5 text-gray-300">{md}</pre>
                </div>
              ))}
            </div>
          ) : (
            <Documents version={row.version} text={held.text} />
          )}
        </>
      ) : (
        <>
          <p className={noticeCls}>
            Texten är inte i det format säljarnas sidor läser (villkor och personuppgiftsbiträdesavtal i markdown), så säljarna kan inte se den. Så här är den arkiverad:
          </p>
          <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-gray-950 p-4 font-mono text-xs leading-5 text-gray-300">{held.text}</pre>
        </>
      )}
    </div>
  );
}

/** The form of a new version: its name and the two documents, with a preview. */
function NewVersion({ versions, current, busy, error, onPublish, onCancel }) {
  const [form, setForm] = useState(null);
  const [preview, setPreview] = useState(false);
  const [problem, setProblem] = useState('');

  // Seeded ONCE, when the form opens: a refresh of the list behind it (an
  // archived text) must not replace what the operator has typed.
  const seed = useRef({ current: current?.version ?? null, versions });
  useEffect(() => {
    let alive = true;
    const { current: from, versions: taken } = seed.current;
    startingDocuments(from).then((docs) => {
      if (alive) setForm({ version: suggestedVersionLabel(new Date(), taken), terms: docs.terms, dpa: docs.dpa, fromCurrent: docs.fromCurrent });
    });
    return () => { alive = false; };
  }, []);

  if (!form) return <Card title="Ny version"><p className="text-sm text-gray-500">Läser texten som gäller nu…</p></Card>;

  const set = (key) => (e) => { setForm((f) => ({ ...f, [key]: e.target.value })); setProblem(''); };
  const size = byteLength(composeTermsText({ version: form.version, terms: form.terms, dpa: form.dpa }));
  const submit = (e) => {
    e.preventDefault();
    const body = newVersionBody(form, versions);
    if (body.problem) { setProblem(body.problem); return; }
    onPublish(form);
  };

  return (
    <Card title="Ny version">
      <form onSubmit={submit} className="space-y-4">
        <div className="max-w-xs">
          <label htmlFor="fl-version" className="mb-1 block text-xs text-gray-400">Versionens namn</label>
          <input id="fl-version" value={form.version} onChange={set('version')} disabled={busy} aria-describedby="fl-version-help" className={`w-full font-mono ${inputCls}`} maxLength={32} />
          <p id="fl-version-help" className="mt-1 text-xs text-gray-500">Visas för säljarna och kan inte ändras. Vanligen dagens datum.</p>
        </div>
        <p className="text-xs leading-relaxed text-gray-500">
          {form.fromCurrent
            ? 'Texterna börjar som versionen som gäller nu.'
            : 'Det finns ingen arkiverad text att utgå från, så texterna börjar tomma.'}{' '}
          Skriv i markdown. <span className="font-mono">{'{{platform_legal_name}}'}</span> och{' '}
          <span className="font-mono">{'{{platform_org_suffix}}'}</span> blir plattformens namn och organisationsnummer,{' '}
          <span className="font-mono">{'{{last_updated}}'}</span> blir versionens namn.
        </p>

        <div className="flex gap-1 border-b border-white/10" role="tablist" aria-label="Visa">
          {[[false, 'Redigera'], [true, 'Förhandsgranska']].map(([on, label]) => (
            <button
              key={label}
              type="button"
              role="tab"
              aria-selected={preview === on}
              onClick={() => setPreview(on)}
              className={'-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ' +
                (preview === on ? 'border-indigo-400 text-white' : 'border-transparent text-gray-400 hover:text-gray-200')}
            >
              {label}
            </button>
          ))}
        </div>

        {preview ? (
          form.terms.trim() && form.dpa.trim()
            ? <Documents version={form.version} text={composeTermsText(form)} />
            : <p className="text-sm text-gray-500">Båda texterna behövs för en förhandsgranskning.</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {[['terms', PLATFORM_TERMS_TITLE], ['dpa', `${PLATFORM_DPA_TITLE} (bilaga)`]].map(([key, label]) => (
              <div key={key}>
                <label htmlFor={`fl-${key}`} className="mb-1 block text-xs text-gray-400">{label}</label>
                <textarea
                  id={`fl-${key}`}
                  value={form[key]}
                  onChange={set(key)}
                  disabled={busy}
                  rows={16}
                  spellCheck
                  className={`font-mono text-xs leading-5 ${textareaCls}`}
                />
              </div>
            ))}
          </div>
        )}

        <p className={'text-xs tabular-nums ' + (size > TERMS_TEXT_MAX_BYTES ? 'text-red-300' : 'text-gray-500')}>
          {Math.ceil(size / 1024)} kB av {TERMS_TEXT_MAX_BYTES / 1024} kB
        </p>
        {(problem || error) && <p role="alert" className={errorCls}>{problem || error}</p>}

        <div className="flex flex-col-reverse gap-2 border-t border-white/10 pt-4 sm:flex-row sm:justify-end">
          <button type="button" onClick={onCancel} disabled={busy} className="rounded-lg px-4 py-2 text-sm text-gray-400 hover:text-gray-200 disabled:opacity-50">
            Avbryt
          </button>
          <button type="submit" disabled={busy} className={btnPrimary}>Publicera…</button>
        </div>
      </form>
    </Card>
  );
}

export default function PlatformTermsVersions() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [open, setOpen] = useState(null); // the version whose text is shown
  const [composing, setComposing] = useState(false);
  const [composeError, setComposeError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null); // { confirm, run }
  const [confirmError, setConfirmError] = useState('');

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) { setLoading(true); setLoadError(''); }
    try {
      setRows(await loadVersions());
    } catch (e) {
      if (!quiet) setLoadError(e.userMessage || 'Villkorsversionerna kunde inte läsas.');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const current = useMemo(() => rows.find((r) => r.state === 'current') ?? null, [rows]);

  const cancelConfirm = useCallback(() => { setPending(null); setConfirmError(''); }, []);
  const confirmNow = async () => {
    setBusy(true);
    try {
      await pending.run();
      setPending(null);
      setConfirmError('');
    } catch (e) {
      setConfirmError(e.userMessage || 'Det gick inte igenom.');
    } finally {
      setBusy(false);
    }
  };

  // The confirm of a publish says what it does to every shop, and that hangs
  // on the version in force: it is written on the versions as the server
  // holds them NOW, and checked again when the operator confirms
  // (publishVersion). A version that came into force in between rewrites the
  // confirm and asks again; nothing is published on a confirm that was untrue.
  const openPublishConfirm = (form, confirmedCurrent) => {
    setPending({
      confirm: publishConfirm(form.version.trim(), confirmedCurrent),
      run: async () => {
        let published;
        try {
          published = await publishVersion(form, confirmedCurrent);
        } catch (e) {
          if (e.currentMoved) {
            setRows(e.rows);
            openPublishConfirm(form, e.current);
          }
          throw e;
        }
        setComposing(false);
        await load({ quiet: true });
        setOpen(published.version);
        toast.success(`Version ${published.version} är publicerad.`);
      },
    });
  };

  const askPublish = async (form) => {
    if (busy) return;
    setComposeError('');
    setBusy(true);
    let fresh;
    try {
      fresh = await loadVersions();
    } catch (e) {
      setComposeError(e.userMessage || 'Villkorsversionerna kunde inte läsas, så bekräftelsen kan inte skrivas. Försök igen.');
      return;
    } finally {
      setBusy(false);
    }
    setRows(fresh);
    const body = newVersionBody(form, fresh);
    if (body.problem) { setComposeError(body.problem); return; }
    openPublishConfirm(form, currentVersionOf(fresh));
  };

  const askArchive = (version, text) => {
    setPending({
      confirm: archiveConfirm(version),
      run: async () => {
        await archiveText(version, text);
        await load({ quiet: true });
        toast.success(`Texten för ${version} är arkiverad.`);
      },
    });
  };

  return (
    <PlatformLayout>
      <div className="max-w-5xl px-6 py-8 lg:px-10">
        <SettingsHeader
          active="terms"
          subtitle="Avtalet mellan plattformen och säljarna. En butik kan bara ta betalt när dess admin har godkänt versionen som gäller."
          actions={!composing && !loading && !loadError ? (
            <button type="button" className={`${btnPrimary} inline-flex shrink-0 items-center gap-2 self-start whitespace-nowrap`} onClick={() => setComposing(true)} disabled={busy}>
              <PlusIcon className="h-4 w-4" />
              Ny version
            </button>
          ) : null}
        />

        {loading ? (
          <Loading />
        ) : loadError ? (
          <LoadError icon={DocumentTextIcon} message={loadError} onRetry={() => load()} />
        ) : (
          <div className="space-y-5">
            {current && !current.textArchived && (
              <p className={noticeCls}>
                Versionen som gäller, {current.version}, har ingen arkiverad text. Säljarna kan inte läsa eller godkänna den, och en butik som inte
                har godkänt den kan inte ta betalt. Öppna versionen nedan för att lägga till texten.
              </p>
            )}

            {composing && (
              <NewVersion
                versions={rows}
                current={current}
                busy={busy}
                error={composeError}
                onPublish={askPublish}
                onCancel={() => { if (!busy) setComposing(false); }}
              />
            )}

            {rows.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-gray-900 px-6 py-12 text-center text-sm text-gray-500">
                <DocumentTextIcon className="mx-auto mb-3 h-10 w-10 text-gray-700" />
                <p>Ingen version är publicerad, så ingen butik kan ta betalt än.</p>
                <p className="mt-1">Publicera den första versionen med "Ny version".</p>
              </div>
            ) : (
              <ul className="divide-y divide-white/5 rounded-xl border border-white/10 bg-gray-900">
                {rows.map((r) => (
                  <li key={r.version} className={open === r.version ? 'bg-white/[0.03]' : ''}>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                      <span className="font-mono text-sm font-medium text-white">{r.version}</span>
                      <span className={`${pillCls} ${STATE_TONES[r.state]}`}>{STATE_LABELS[r.state]}</span>
                      {!r.textArchived && <span className={`${pillCls} bg-amber-500/15 text-amber-300`}>Text saknas</span>}
                      <span className="text-sm tabular-nums text-gray-400">
                        {r.state === 'scheduled' ? 'Gäller från ' : r.state === 'current' ? 'Sedan ' : 'Gällde från '}
                        {dateTimeText(r.publishedAt)}
                      </span>
                      <button
                        type="button"
                        className={`${btnQuiet} ml-auto`}
                        onClick={() => setOpen((o) => (o === r.version ? null : r.version))}
                        aria-expanded={open === r.version}
                      >
                        {open === r.version ? 'Stäng' : 'Visa text'}
                      </button>
                    </div>
                    {open === r.version && (
                      <div className="border-t border-white/5 px-4 pb-5 pt-4">
                        <VersionText row={r} busy={busy} onArchive={askArchive} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <p className="text-xs text-gray-600">
              En publicerad version och dess text kan inte ändras eller tas bort. Hur många butiker som godkänt en version visas inte här än.
            </p>
          </div>
        )}
      </div>

      <ConfirmDialog confirm={pending?.confirm} busy={busy} error={confirmError} onCancel={cancelConfirm} onConfirm={confirmNow} />
    </PlatformLayout>
  );
}
