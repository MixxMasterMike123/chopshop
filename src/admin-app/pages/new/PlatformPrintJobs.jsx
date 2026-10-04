// Plattform → Tryckjobb (unit CP5-FP): every printer line of every shop, with
// what the printer has reported, and the forward steps of its production
// status (in production → produced → shipped, with the parcel's tracking on
// shipped). The printer reports by e-mail today; this is where the platform
// records what the mail says (CP6_PS1_REPORT.md).
//
// Each step goes through a confirm that says what the write does beyond the
// line (adapters/printJobs.js statusConfirm), built on the job as read just
// before it opens and read again when it is confirmed: a job that moved in
// between rewrites the confirm and nothing is sent. The page is locked while
// a write runs; a lost answer is read back (printJobsData.js).
// CP6-PS4: the printer's exception (out of stock after it accepted the job):
// the row shows it, the filter finds the open ones, and its two bodies
// (record it, close it) go through the same confirm, re-check and read-back.
// New page of the admin build: no older page, no alias row.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { QueueListIcon } from '@heroicons/react/24/outline';
import PlatformLayout from '../../../components/platform/PlatformLayout';
import {
  DEFAULT_FILTERS,
  DISPATCH_FILTERS,
  DISPATCH_LABEL,
  EXCEPTION_FILTERS,
  ORDER_STATUS_LABEL,
  STATE_FILTERS,
  STATE_LABEL,
  actionBlockText,
  actionBody,
  actionConfirm,
  actionDoneText,
  actionGoneText,
  actionMovedText,
  actionToastText,
  emptyViewText,
  exceptionActions,
  exceptionState,
  exceptionText,
  nextStates,
  offersAction,
  sameJobFacts,
  timeText,
} from '../../adapters/printJobs.js';
import { loadFilterChoices, loadJobs, readJob, recordStatus } from './printJobsData.js';
import { ConfirmDialog, LoadError, Loading, btnQuiet, btnRowDanger, inputCls, noticeCls, pillCls } from './platformKit.jsx';

const EMPTY_TRACKING = { trackingNumber: '', trackingUrl: '', carrier: '' };

// The pills of PlatformShopDetail / PlatformShops / PlatformReports.
const STATE_PILL = {
  none: 'bg-white/5 text-gray-300',
  in_production: 'bg-indigo-500/15 text-indigo-300',
  produced: 'bg-amber-500/15 text-amber-300',
  shipped: 'bg-green-500/15 text-green-300',
};

const STEP_BUTTON = { in_production: 'I produktion', produced: 'Producerad', shipped: 'Skickad…' };

// The printer's exception: the console's red pill (PlatformShops' "Inaktiverad")
// while open, the neutral one once closed; a restocked line shows its state.
const EXCEPTION_PILL = {
  open: ['bg-red-500/15 text-red-300', 'Slut i lager hos tryckeriet'],
  resolved: ['bg-white/5 text-gray-300', 'Undantag stängt'],
};
const EXCEPTION_BUTTON = { out_of_stock: 'Slut i lager…', resolved: 'Stäng undantaget…' };

function FilterSelect({ id, label, value, options, onChange, disabled }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-gray-400">{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={inputCls}>
        {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
    </div>
  );
}

function JobRow({ job, busy, onStep }) {
  const steps = nextStates(job);
  const exceptions = exceptionActions(job);
  const block = actionBlockText(job);
  const exceptionPill = EXCEPTION_PILL[exceptionState(job)];
  const exceptionLine = exceptionText(job);
  const state = job.state ?? 'none';
  const dispatch = DISPATCH_LABEL[job.dispatchState ?? 'none'] ?? job.dispatchState;
  const sent = timeText(job.dispatchedAt);
  return (
    <li className="flex flex-col gap-3 px-4 py-4 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-white">Order {job.orderNumber}</span>
          <span className="text-sm text-gray-400">{job.shopName || job.tenantId}</span>
          <span className={`${pillCls} ${STATE_PILL[state] ?? STATE_PILL.none}`}>{STATE_LABEL[state] ?? state}</span>
          {exceptionPill && <span className={`${pillCls} ${exceptionPill[0]}`}>{exceptionPill[1]}</span>}
        </div>
        <p className="text-sm text-gray-300">
          Rad {job.lineNo}: {job.quantity} × {job.name}
          {job.variantLabel ? ` (${job.variantLabel})` : ''}
          <span className="text-gray-500"> · {job.sku}</span>
        </p>
        <p className="text-xs text-gray-500">
          {job.printerId || 'Okänt tryckeri'}
          {job.printerJobRef ? ` · jobb ${job.printerJobRef}` : ''}
          {' · '}{dispatch}{sent ? ` ${sent}` : ''}
          {' · '}Order: {ORDER_STATUS_LABEL[job.orderStatus] ?? job.orderStatus}
        </p>
        {state === 'shipped' && (job.trackingNumber || job.carrier || job.trackingUrl) && (
          <p className="text-xs text-gray-400">
            Spårning: {[job.trackingNumber, job.carrier].filter(Boolean).join(' · ') || 'ingen'}
            {job.trackingUrl && (
              <>
                {' · '}
                <a href={job.trackingUrl} target="_blank" rel="noopener noreferrer" className="text-indigo-300 hover:text-indigo-200">länk</a>
              </>
            )}
          </p>
        )}
        {exceptionLine && <p className="text-xs text-gray-400">{exceptionLine}</p>}
        {block && <p className="text-xs text-gray-500">{block}</p>}
      </div>
      {steps.length + exceptions.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-2 lg:justify-end">
          {steps.map((step) => (
            <button key={step} type="button" className={btnQuiet} disabled={busy} onClick={() => onStep(job, step)}>
              {STEP_BUTTON[step]}
            </button>
          ))}
          {exceptions.map((action) => (
            <button key={action} type="button" className={action === 'resolved' ? btnRowDanger : btnQuiet} disabled={busy}
              onClick={() => onStep(job, action)}>
              {EXCEPTION_BUTTON[action]}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

export default function PlatformPrintJobs() {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [choices, setChoices] = useState({ shops: [], printers: [] });
  const [jobs, setJobs] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false); // one read or write at a time; the rows are locked meanwhile
  const [pending, setPending] = useState(null); // { job, action }: the open confirm (a state, or an exception body)
  const [tracking, setTracking] = useState(EMPTY_TRACKING);
  const [confirmError, setConfirmError] = useState('');
  const [status, setStatus] = useState(null); // { text, warn }
  const view = useRef(0); // the filters' generation: an answer for older filters is dropped

  useEffect(() => {
    loadFilterChoices().then(setChoices);
  }, []);

  const load = useCallback(async (wanted) => {
    const mine = ++view.current;
    setLoading(true);
    setLoadError('');
    try {
      const page = await loadJobs(wanted);
      if (mine !== view.current) return;
      setJobs(page.jobs);
      setNextCursor(page.nextCursor);
    } catch (e) {
      if (mine === view.current) setLoadError(e.userMessage || 'Tryckjobben kunde inte läsas.');
    } finally {
      if (mine === view.current) setLoading(false);
    }
  }, []);
  useEffect(() => { load(filters); }, [load, filters]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const mine = view.current;
    setLoadingMore(true);
    try {
      const page = await loadJobs(filters, nextCursor);
      if (mine !== view.current) return;
      setJobs((rows) => [...rows, ...page.jobs.filter((job) => !rows.some((r) => r.jobId === job.jobId))]);
      setNextCursor(page.nextCursor);
    } catch (e) {
      if (mine === view.current) toast.error(e.userMessage || 'Fler tryckjobb kunde inte läsas.');
    } finally {
      setLoadingMore(false);
    }
  };

  const setFilter = (key) => (value) => {
    setStatus(null);
    setFilters((f) => ({ ...f, [key]: value }));
  };

  /** The row of `job` follows the job as the server holds it. */
  const replaceRow = (fresh) => {
    if (fresh) setJobs((rows) => rows.map((row) => (row.jobId === fresh.jobId ? { ...row, ...fresh } : row)));
  };

  // A step (a state, or an exception body): read the job now; the confirm is written on what is true now.
  const askStep = async (job, action) => {
    if (busy) return;
    setStatus(null);
    setBusy(true);
    let fresh;
    try {
      fresh = await readJob(job);
    } catch (e) {
      setStatus({ text: e.userMessage, warn: true });
      return;
    } finally {
      setBusy(false);
    }
    if (!fresh) {
      setStatus({ text: 'Tryckjobbet finns inte längre i listan. Ladda om sidan.', warn: true });
      return;
    }
    replaceRow(fresh);
    if (!offersAction(fresh, action)) {
      setStatus({ text: actionMovedText(fresh, action), warn: true });
      return;
    }
    setTracking(EMPTY_TRACKING);
    setConfirmError('');
    setPending({ job: fresh, action });
  };

  const cancelConfirm = useCallback(() => {
    setPending(null);
    setConfirmError('');
  }, []);

  const confirmStep = async () => {
    if (!pending || busy) return;
    const { job, action } = pending;
    const parsed = actionBody(action, tracking);
    if (parsed.problems) {
      setConfirmError(parsed.problems.join(' '));
      return;
    }
    setBusy(true);
    setConfirmError('');
    try {
      // Read again: the confirm said what the write does to the job as read then.
      const now = await readJob(job);
      if (!now || !sameJobFacts(now, job)) {
        replaceRow(now);
        if (now && offersAction(now, action)) {
          setPending({ job: now, action });
          setConfirmError('Tryckjobbet ändrades medan rutan var öppen. Texten ovan gäller läget nu; bekräfta igen om det fortfarande stämmer.');
        } else {
          setPending(null);
          setStatus({ text: actionGoneText(action), warn: true });
        }
        return;
      }
      const result = await recordStatus(job, parsed.body);
      replaceRow(result.job);
      setPending(null);
      setStatus({ text: actionDoneText(job, action, result), warn: false });
      toast.success(actionToastText(action, result));
    } catch (e) {
      replaceRow(e.fresh);
      setConfirmError(e.userMessage || 'Ändringen gick inte igenom.');
    } finally {
      setBusy(false);
    }
  };

  const confirm = useMemo(() => (pending ? actionConfirm(pending.job, pending.action) : null), [pending]);
  const shopOptions = [['', 'Alla butiker'], ...choices.shops.map((s) => [s.id, s.name])];
  const printerOptions = [['', 'Alla tryckerier'], ...choices.printers.map((p) => [p.id, p.name])];
  const locked = busy || loading;

  return (
    <PlatformLayout>
      <div className="max-w-6xl px-6 py-8 lg:px-10">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Tryckjobb</h1>
          <p className="mt-1 text-gray-400">
            Orderrader som skickats till ett tryckeri, och vad tryckeriet har rapporterat. När tryckeriets mejl säger
            att ett jobb är i produktion, producerat eller skickat, eller att plagget är slut i lager, rapporterar du det här.
          </p>
        </div>

        <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <FilterSelect id="pj-state" label="Produktion" value={filters.state} options={STATE_FILTERS} onChange={setFilter('state')} disabled={locked} />
          <FilterSelect id="pj-dispatch" label="Hos tryckeriet" value={filters.dispatchState} options={DISPATCH_FILTERS} onChange={setFilter('dispatchState')} disabled={locked} />
          <FilterSelect id="pj-exception" label="Undantag" value={filters.exception} options={EXCEPTION_FILTERS} onChange={setFilter('exception')} disabled={locked} />
          <FilterSelect id="pj-shop" label="Butik" value={filters.tenantId} options={shopOptions} onChange={setFilter('tenantId')} disabled={locked} />
          <FilterSelect id="pj-printer" label="Tryckeri" value={filters.printerId} options={printerOptions} onChange={setFilter('printerId')} disabled={locked} />
        </div>

        {status && (
          <p role="status" className={`mb-4 ${status.warn ? noticeCls : 'rounded-lg border border-white/10 bg-gray-950 px-3 py-2 text-xs text-gray-300'}`}>
            {status.text}
          </p>
        )}

        {loading ? (
          <Loading />
        ) : loadError ? (
          <LoadError icon={QueueListIcon} message={loadError} onRetry={() => load(filters)} />
        ) : jobs.length === 0 ? (
          <div className="py-16 text-center text-gray-500">
            <QueueListIcon className="mx-auto mb-3 h-10 w-10 text-gray-700" />
            <p>{emptyViewText(filters, nextCursor !== null)}</p>
            {nextCursor && (
              <button type="button" className={`${btnQuiet} mt-4`} disabled={loadingMore || busy} onClick={loadMore}>
                {loadingMore ? 'Läser…' : 'Sök vidare'}
              </button>
            )}
          </div>
        ) : (
          <>
            <ul className="divide-y divide-white/5 rounded-xl border border-white/10 bg-gray-900">
              {jobs.map((job) => <JobRow key={job.jobId} job={job} busy={busy} onStep={askStep} />)}
            </ul>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-gray-500">
              <span>{jobs.length === 1 ? '1 tryckjobb' : `${jobs.length} tryckjobb`} visas, sorterade efter orderns interna id (inte efter datum).</span>
              {nextCursor && (
                <button type="button" className={btnQuiet} disabled={loadingMore || busy} onClick={loadMore}>
                  {loadingMore ? 'Läser…' : 'Visa fler'}
                </button>
              )}
            </div>
          </>
        )}
      </div>

      <ConfirmDialog confirm={confirm} busy={busy} error={confirmError} onConfirm={confirmStep} onCancel={cancelConfirm}>
        {pending?.action === 'shipped' && (
          <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-2">
            <div className="flex flex-col gap-1 sm:col-span-2">
              <label htmlFor="pj-tracking-number" className="text-xs font-medium text-gray-400">Spårningsnummer (valfritt)</label>
              <input id="pj-tracking-number" className={inputCls} value={tracking.trackingNumber} maxLength={100} disabled={busy}
                onChange={(e) => setTracking((t) => ({ ...t, trackingNumber: e.target.value }))} />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="pj-carrier" className="text-xs font-medium text-gray-400">Fraktbolag (valfritt)</label>
              <input id="pj-carrier" className={inputCls} value={tracking.carrier} maxLength={60} disabled={busy}
                onChange={(e) => setTracking((t) => ({ ...t, carrier: e.target.value }))} />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="pj-tracking-url" className="text-xs font-medium text-gray-400">Länk till spårningen (valfri)</label>
              <input id="pj-tracking-url" className={inputCls} value={tracking.trackingUrl} maxLength={500} disabled={busy} placeholder="https://…"
                onChange={(e) => setTracking((t) => ({ ...t, trackingUrl: e.target.value }))} />
            </div>
          </div>
        )}
      </ConfirmDialog>
    </PlatformLayout>
  );
}
