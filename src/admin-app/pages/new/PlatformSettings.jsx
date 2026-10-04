// Plattform → Inställningar → Allmänt (unit CP5-FL): every value of
// GET /v1/platform/settings with what it means. The fee, the review count and
// the global hard block are editable; the two payment policies are fixed in
// code and only shown. A change first reads the server's value again (the
// confirm says "from" what is stored; a value someone else changed is shown,
// not overwritten). The fee and the hard block ask for a confirm that says
// what changes and from when. The page is locked while a write runs.
// New page of the admin build: no older page, no alias row.

import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Cog6ToothIcon } from '@heroicons/react/24/outline';
import PlatformLayout from '../../../components/platform/PlatformLayout';
import {
  SETTING_MEANINGS,
  commissionConfirm,
  disputeText,
  hardBlockConfirm,
  parsePercent,
  parseReviewCount,
  percentInput,
  percentText,
  refundFeeText,
  rescreenSummaryText,
  reviewCountText,
} from '../../adapters/platformSettings.js';
import { dateTimeText } from '../../adapters/termsVersions.js';
import { freshSettingsFor, loadSettings, saveSettings } from './platformSettingsData.js';
import {
  Card, ConfirmDialog, LoadError, Loading, SettingsHeader,
  btnPrimarySm, btnQuiet, inputCls, noticeCls, pillCls,
} from './platformKit.jsx';

function Row({ label, meaning, children }) {
  return (
    <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
      <div className="min-w-0 max-w-xl">
        <div className="text-sm font-medium text-white">{label}</div>
        <p className="mt-1 text-sm leading-relaxed text-gray-400">{meaning}</p>
      </div>
      <div className="shrink-0 sm:pt-0.5">{children}</div>
    </div>
  );
}

const Fixed = ({ children }) => (
  <div className="flex flex-wrap items-center gap-2 sm:justify-end">
    <span className="text-sm text-gray-200">{children}</span>
    <span className={`${pillCls} bg-white/5 text-gray-400`} title="Värdet är låst i koden och ändras inte här">Låst i koden</span>
  </div>
);

const FIELDS = {
  defaultCommissionBps: { label: 'Standardavgift', unit: '%', parse: parsePercent, input: percentInput, show: percentText, key: 'bps' },
  reviewFirstProducts: { label: 'Förhandsgranskning av nya butiker', unit: 'st', parse: parseReviewCount, input: (n) => (Number.isInteger(n) ? String(n) : ''), show: reviewCountText, key: 'value' },
};

export default function PlatformSettings() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState(null); // a key of FIELDS
  const [draft, setDraft] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [busy, setBusy] = useState(false); // a read-before-change or a write runs: everything is locked
  const [pending, setPending] = useState(null); // { confirm, patch }
  const [confirmError, setConfirmError] = useState('');
  const [result, setResult] = useState(null); // { text, warn }

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      setSettings(await loadSettings());
    } catch (e) {
      setLoadError(e.userMessage || 'Inställningarna kunde inte läsas.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const startEdit = (key) => {
    if (busy) return;
    setEditing(key);
    setDraft(FIELDS[key].input(settings[key]));
    setFieldError('');
  };
  const stopEdit = () => {
    if (busy) return;
    setEditing(null);
    setFieldError('');
  };

  const afterSave = (answer, patch) => {
    setSettings(answer.settings);
    setEditing(null);
    setPending(null);
    setConfirmError('');
    const summary = rescreenSummaryText(answer.rescreen);
    if ('screeningHardBlock' in patch) {
      setResult(answer.readBack
        ? { text: 'Ändringen är sparad. Svaret kom aldrig fram, så hur många produkter som påverkades kunde inte läsas.', warn: false }
        : summary ? { text: summary, warn: (answer.rescreen?.blockedNow ?? 0) > 0 } : null);
    }
    if ('defaultCommissionBps' in patch) toast.success(`Standardavgiften är nu ${percentText(answer.settings.defaultCommissionBps)}.`);
    else if ('reviewFirstProducts' in patch) toast.success(`Förhandsgranskning: ${reviewCountText(answer.settings.reviewFirstProducts).toLowerCase()}.`);
    else toast.success(answer.settings.screeningHardBlock ? '"Alla träffar spärrar" är på.' : '"Alla träffar spärrar" är av.');
  };

  /** The value the server holds now; a moved value is shown and the change stops. */
  const readFresh = async (patch) => {
    try {
      return await freshSettingsFor(settings, patch);
    } catch (e) {
      if (e.fresh) setSettings(e.fresh);
      setEditing(null);
      toast.error(e.userMessage || 'Inställningarna kunde inte läsas.', { duration: 9000 });
      return null;
    }
  };

  const write = async (patch) => {
    setBusy(true);
    try {
      afterSave(await saveSettings(patch), patch);
    } catch (e) {
      if (e.fresh) setSettings(e.fresh);
      if (pending) setConfirmError(e.userMessage || 'Ändringen gick inte igenom.');
      else setFieldError(e.userMessage || 'Ändringen gick inte igenom.');
    } finally {
      setBusy(false);
    }
  };

  const submitField = async (e) => {
    e.preventDefault();
    if (busy) return;
    const field = FIELDS[editing];
    const parsed = field.parse(draft);
    if (parsed.problem) { setFieldError(parsed.problem); return; }
    const value = parsed[field.key];
    if (value === settings[editing]) { setEditing(null); return; }
    const patch = { [editing]: value };
    setBusy(true);
    const fresh = await readFresh(patch);
    if (!fresh) { setBusy(false); return; }
    setSettings(fresh);
    if (editing === 'defaultCommissionBps') {
      setPending({ confirm: commissionConfirm(fresh.defaultCommissionBps, value), patch });
      setBusy(false);
      return;
    }
    await write(patch); // still locked: the write follows the read without a gap
  };

  const toggleHardBlock = async () => {
    if (busy) return;
    const patch = { screeningHardBlock: !settings.screeningHardBlock };
    setBusy(true);
    const fresh = await readFresh(patch);
    setBusy(false);
    if (!fresh) return;
    setSettings(fresh);
    setPending({ confirm: hardBlockConfirm(patch.screeningHardBlock), patch });
  };

  const cancelConfirm = useCallback(() => {
    setPending(null);
    setConfirmError('');
  }, []);

  const editable = (key) => {
    const field = FIELDS[key];
    if (editing !== key) {
      return (
        <div className="flex items-center gap-3 sm:justify-end">
          <span className="text-sm font-semibold tabular-nums text-white">{field.show(settings[key])}</span>
          <button type="button" className={btnQuiet} onClick={() => startEdit(key)} disabled={busy || editing !== null}>
            Ändra
          </button>
        </div>
      );
    }
    return (
      <form onSubmit={submitField} className="sm:text-right">
        <div className="flex items-center gap-2 sm:justify-end">
          <input
            autoFocus
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setFieldError(''); }}
            onKeyDown={(e) => { if (e.key === 'Escape') stopEdit(); }}
            disabled={busy}
            inputMode={key === 'defaultCommissionBps' ? 'decimal' : 'numeric'}
            aria-label={field.label}
            aria-invalid={fieldError ? 'true' : undefined}
            aria-describedby={fieldError ? `${key}-error` : undefined}
            className={`w-20 text-right tabular-nums ${inputCls}`}
          />
          <span className="text-sm text-gray-500">{field.unit}</span>
          <button type="submit" className={btnPrimarySm} disabled={busy}>{busy ? 'Sparar…' : 'Spara'}</button>
          <button type="button" className={btnQuiet} onClick={stopEdit} disabled={busy}>Avbryt</button>
        </div>
        {fieldError && <p id={`${key}-error`} role="alert" className="mt-2 max-w-xs text-xs text-red-300 sm:ml-auto">{fieldError}</p>}
      </form>
    );
  };

  return (
    <PlatformLayout>
      <div className="max-w-4xl px-6 py-8 lg:px-10">
        <SettingsHeader active="settings" subtitle="Plattformens avgift, granskningen av produkter och plattformsvillkoren. Allt här gäller alla butiker." />

        {loading ? (
          <Loading />
        ) : loadError ? (
          <LoadError icon={Cog6ToothIcon} message={loadError} onRetry={load} />
        ) : (
          <div className="space-y-5">
            <Card title="Avgift och betalningar">
              <div className="divide-y divide-white/5">
                <Row label="Standardavgift" meaning={`${SETTING_MEANINGS.defaultCommissionBps} Högst 8 %.`}>
                  {editable('defaultCommissionBps')}
                </Row>
                <Row label="Avgiften vid återbetalning" meaning={SETTING_MEANINGS.refundApplicationFee}>
                  <Fixed>{refundFeeText(settings.refundApplicationFee)}</Fixed>
                </Row>
                <Row label="Omtvistade betalningar" meaning={SETTING_MEANINGS.reverseDisputeOnCreated}>
                  <Fixed>{disputeText(settings.reverseDisputeOnCreated)}</Fixed>
                </Row>
              </div>
            </Card>

            <Card
              title="Granskning av produkter"
              action={<Link to="/screening" className="text-sm text-indigo-300 hover:text-indigo-200">Varumärkesfilter →</Link>}
            >
              <div className="divide-y divide-white/5">
                <Row label="Förhandsgranskning av nya butiker" meaning={`${SETTING_MEANINGS.reviewFirstProducts} En ändring gäller produkter som publiceras första gången efter den; en produkt som redan väntar fortsätter vänta.`}>
                  {editable('reviewFirstProducts')}
                </Row>
                <Row label="Alla träffar spärrar" meaning={SETTING_MEANINGS.screeningHardBlock}>
                  <div className="flex items-center gap-3 sm:justify-end">
                    <span className="text-sm text-gray-200">{settings.screeningHardBlock ? 'På' : 'Av'}</span>
                    <button
                      type="button"
                      onClick={toggleHardBlock}
                      disabled={busy || editing !== null}
                      role="switch"
                      aria-checked={settings.screeningHardBlock === true}
                      aria-label="Alla träffar spärrar"
                      className={
                        'relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ' +
                        (settings.screeningHardBlock ? 'bg-green-600' : 'bg-white/10')
                      }
                    >
                      <span
                        className={
                          'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ' +
                          (settings.screeningHardBlock ? 'translate-x-5' : 'translate-x-1')
                        }
                      />
                    </button>
                  </div>
                </Row>
                <Row label="Filtrets version" meaning={SETTING_MEANINGS.screeningTermsVersion}>
                  <span className="text-sm font-semibold tabular-nums text-white">{settings.screeningTermsVersion ?? '—'}</span>
                </Row>
              </div>
              {result && (
                <p role="status" className={`mt-4 ${result.warn ? noticeCls : 'rounded-lg border border-white/10 bg-gray-950 px-3 py-2 text-xs text-gray-300'}`}>
                  {result.text}
                </p>
              )}
            </Card>

            <p className="text-xs text-gray-600">
              Senast ändrad {dateTimeText(settings.updatedAt)}
              {settings.updatedBy ? <> av konto <span className="font-mono">{settings.updatedBy}</span></> : null}.
            </p>
          </div>
        )}
      </div>

      <ConfirmDialog
        confirm={pending?.confirm}
        busy={busy}
        error={confirmError}
        onCancel={cancelConfirm}
        onConfirm={() => write(pending.patch)}
      />
    </PlatformLayout>
  );
}
