// PlatformReports — "Anmälningar": the platform's notice-&-takedown desk
// (SnapWear A10) + the brand-screening review queue (A11, "Granskning" tab).
//
// Anmälningar: infringementReports, created ONLY by the submitInfringementReport
// callable (the storefront "Rapportera intrång" form). The operator reads the
// report, then either switches the product off ("Avpublicera produkt" → the
// takedownProduct callable: isActive=false + takedown stamp + audit log) or
// closes it ("Avvisa"). firestore.rules allow the client to change only
// status/note/handledAt/handledBy on a report.
//
// Granskning: products whose server-stamped screening.status is flagged
// (blocklist hit), blocked (hard-blocked term, already switched off) or review
// (a new shop's first products). "Godkänn" sets screening.status='cleared'
// (platform-only per rules); "Avpublicera" is the same takedown callable with
// no report.
//
// Reinstating a taken-down product: set the report to Avvisad and re-activate
// the product in the shop's product form (open the shop admin as platform);
// the form clears the takedown stamp for platform users.
//
// The view (ReportsView) is presentational so src/dev/platformReportsHarness.jsx
// can render it with fixtures and no Firestore.
import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { collection, getDocs, getDoc, doc, updateDoc, query, orderBy, where, serverTimestamp } from 'firebase/firestore';
import { httpsCallable, getFunctions } from 'firebase/functions';
import { db } from '../../firebase/config';
import { APP_URLS } from '../../config/urls';
import { getVariantProductSlug } from '../../utils/productUrls';
import { useAuth } from '../../contexts/AuthContext';
import PlatformLayout, { notifyPlatformBadgesChanged } from '../../components/platform/PlatformLayout';
import toast from 'react-hot-toast';
import {
  FlagIcon,
  ArrowTopRightOnSquareIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/outline';

// Report pipeline. Values are stored verbatim in infringementReports/{id}.status
// and are the ONLY values firestore.rules accepts — keep the two in sync.
export const REPORT_STATUSES = {
  new: { label: 'Ny', cls: 'bg-amber-500/15 text-amber-300' },
  reviewing: { label: 'Granskas', cls: 'bg-indigo-500/15 text-indigo-300' },
  taken_down: { label: 'Avpublicerad', cls: 'bg-red-500/15 text-red-300' },
  rejected: { label: 'Avvisad', cls: 'bg-white/5 text-gray-400' },
};

export const RIGHT_LABELS = { trademark: 'Varumärke', copyright: 'Upphovsrätt', other: 'Annat' };

// Screening statuses that belong in the queue (server-stamped by
// screenProductOnWrite). Flagged/blocked outrank a new shop's routine review.
export const QUEUE_STATUSES = {
  blocked: { label: 'Blockerad', cls: 'bg-red-500/15 text-red-300', rank: 0 },
  flagged: { label: 'Flaggad', cls: 'bg-amber-500/15 text-amber-300', rank: 0 },
  review: { label: 'Ny butik', cls: 'bg-indigo-500/15 text-indigo-300', rank: 1 },
};

const tsMillis = (ts) => (ts?.toMillis ? ts.toMillis() : ts instanceof Date ? ts.getTime() : 0);
const formatDate = (ts) => {
  const ms = tsMillis(ts);
  return ms ? new Date(ms).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' }) : '–';
};
// Reporter-typed URLs are only rendered as links when they are http(s) — a
// pasted `javascript:` URL must stay inert text.
const isHttpUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v.trim());
const plainName = (n) => (typeof n === 'string' ? n : (n && Object.values(n).find((v) => typeof v === 'string')) || '');
export const storefrontProductUrl = (p) =>
  p?.shopId && p?.sku ? `${APP_URLS.B2C_SHOP}/${p.shopId}/product/${getVariantProductSlug(p)}` : null;

const Pill = ({ cls, children }) => (
  <span className={'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ' + cls}>
    {children}
  </span>
);

const noteCls =
  'w-full rounded-lg border border-white/10 bg-gray-950 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600 focus:border-indigo-500 focus:outline-none';
const btnDanger =
  'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold bg-red-500/15 text-red-300 hover:bg-red-500/25 disabled:opacity-40 disabled:cursor-not-allowed';
const btnQuiet =
  'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium bg-white/5 text-gray-200 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed';
const btnOk =
  'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed';

// ── Anmälningar: one report's expanded detail + actions ────────────────────
const ReportDetail = ({ report, busy, onTakedown, onReject, onMarkReviewing }) => {
  const [note, setNote] = useState(report.note || '');
  const [productId, setProductId] = useState(report.productId || '');
  const closed = report.status === 'taken_down' || report.status === 'rejected';

  return (
    <div className="grid gap-5 px-4 pb-5 pt-1 lg:grid-cols-[1fr_320px]">
      <div className="space-y-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-500">Beskrivning</div>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-gray-200">{report.description}</p>
        </div>
        <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <span className="text-gray-500">Produktlänk / namn: </span>
            {isHttpUrl(report.productUrl) ? (
              <a href={report.productUrl.trim()} target="_blank" rel="noopener noreferrer" className="break-all text-indigo-300 hover:text-indigo-200">
                {report.productUrl}
              </a>
            ) : (
              <span className="break-all text-gray-300">{report.productUrl || '–'}</span>
            )}
          </div>
          <div>
            <span className="text-gray-500">E-post: </span>
            <a href={`mailto:${report.reporterEmail}`} className="text-indigo-300 hover:text-indigo-200">{report.reporterEmail}</a>
          </div>
          <div>
            <span className="text-gray-500">Intygande: </span>
            <span className={report.attestation ? 'text-emerald-300' : 'text-red-300'}>
              {report.attestation ? 'Rättighetshavare/behörig företrädare, uppgifterna korrekta' : 'Saknas'}
            </span>
          </div>
          <div>
            <span className="text-gray-500">Ärende-ID: </span>
            <span className="font-mono text-xs text-gray-400">{report.id}</span>
          </div>
          {report.handledAt && (
            <div>
              <span className="text-gray-500">Hanterad: </span>
              <span className="text-gray-300">{formatDate(report.handledAt)}</span>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-3 rounded-xl border border-white/10 bg-gray-950/60 p-4">
        {!report.productId && (
          <div>
            <label className="text-xs font-medium text-gray-400" htmlFor={`pid-${report.id}`}>
              Produkt-ID (kunde inte matchas automatiskt)
            </label>
            <input
              id={`pid-${report.id}`}
              value={productId}
              onChange={(e) => setProductId(e.target.value.trim())}
              placeholder="Klistra in produktens dokument-ID"
              className={noteCls + ' mt-1 font-mono text-xs'}
              disabled={closed}
            />
          </div>
        )}
        <div>
          <label className="text-xs font-medium text-gray-400" htmlFor={`note-${report.id}`}>Anteckning</label>
          <textarea
            id={`note-${report.id}`}
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Varför — syns i ärendet och i granskningsloggen"
            className={noteCls + ' mt-1'}
            disabled={closed}
          />
        </div>
        {closed ? (
          report.status === 'taken_down' ? (
            <p className="text-xs leading-relaxed text-gray-500">
              Produkten är avpublicerad. Ångra: aktivera produkten i butikens produktformulär (öppna butikens admin
              som plattform) — spärren tas då bort.
              {report.productId && <> Produkt-ID <span className="font-mono">{report.productId}</span>.</>}
            </p>
          ) : (
            <p className="text-xs leading-relaxed text-gray-500">Anmälan är avvisad.</p>
          )
        ) : (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={btnDanger}
              disabled={busy || !productId}
              onClick={() => onTakedown(report, productId, note)}
            >
              Avpublicera produkt
            </button>
            <button type="button" className={btnQuiet} disabled={busy} onClick={() => onReject(report, note)}>
              Avvisa
            </button>
            {report.status === 'new' && (
              <button type="button" className={btnQuiet} disabled={busy} onClick={() => onMarkReviewing(report)}>
                Markera som granskas
              </button>
            )}
          </div>
        )}
        {report.status === 'rejected' && (
          <button type="button" className={btnQuiet} disabled={busy} onClick={() => onMarkReviewing(report)}>
            Öppna igen
          </button>
        )}
      </div>
    </div>
  );
};

const ReportsTable = ({ reports, shopNames, busyId, onTakedown, onReject, onMarkReviewing }) => {
  const [openId, setOpenId] = useState(() => reports.find((r) => r.status === 'new')?.id || null);

  if (reports.length === 0) {
    return (
      <div className="py-16 text-center text-gray-500">
        <FlagIcon className="mx-auto mb-3 h-10 w-10 text-gray-700" />
        Inga anmälningar
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-white/10 bg-gray-900">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-white/10 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">
            <th className="w-8 px-2 py-3" />
            <th className="px-3 py-3">Inkom</th>
            <th className="px-3 py-3">Butik</th>
            <th className="px-3 py-3">Produkt</th>
            <th className="px-3 py-3">Anmälare</th>
            <th className="px-3 py-3">Rättighet</th>
            <th className="px-4 py-3">Status</th>
          </tr>
        </thead>
        {reports.map((r) => {
          const open = openId === r.id;
          const st = REPORT_STATUSES[r.status] || REPORT_STATUSES.new;
          const productHref = r.productId && r.product ? storefrontProductUrl(r.product) : null;
          return (
            <tbody key={r.id} className={'border-b border-white/5 last:border-0 ' + (open ? 'bg-white/[0.03]' : '')}>
              <tr
                className="cursor-pointer hover:bg-white/5"
                onClick={() => setOpenId(open ? null : r.id)}
                aria-expanded={open}
              >
                <td className="px-2 py-3 text-gray-500">
                  {open ? <ChevronDownIcon className="h-4 w-4" /> : <ChevronRightIcon className="h-4 w-4" />}
                </td>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums text-gray-300">{formatDate(r.createdAt)}</td>
                <td className="whitespace-nowrap px-3 py-3">
                  <Link
                    to={`/shops/${r.shopId}`}
                    onClick={(e) => e.stopPropagation()}
                    className="text-gray-200 hover:text-white hover:underline"
                  >
                    {shopNames[r.shopId] || r.shopId}
                  </Link>
                </td>
                <td className="px-3 py-3">
                  <div className="flex max-w-xs items-center gap-1.5">
                    <span className="truncate font-medium text-white" title={r.productName || r.productUrl}>
                      {r.productName || r.productUrl || '–'}
                    </span>
                    {productHref && (
                      <a
                        href={productHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        title="Öppna produkten i butiken"
                        className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-white/10 hover:text-white"
                      >
                        <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                  {!r.productId && <div className="text-xs text-amber-300/80">Ej matchad</div>}
                </td>
                <td className="px-3 py-3">
                  <div className="text-gray-200">{r.reporterName}</div>
                  {r.reporterOrg && <div className="text-xs text-gray-500">{r.reporterOrg}</div>}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-gray-300">{RIGHT_LABELS[r.rightType] || r.rightType}</td>
                <td className="px-4 py-3"><Pill cls={st.cls}>{st.label}</Pill></td>
              </tr>
              {open && (
                <tr>
                  <td colSpan={7}>
                    <ReportDetail
                      report={r}
                      busy={busyId === r.id}
                      onTakedown={onTakedown}
                      onReject={onReject}
                      onMarkReviewing={onMarkReviewing}
                    />
                  </td>
                </tr>
              )}
            </tbody>
          );
        })}
      </table>
    </div>
  );
};

// ── Granskning: screened products awaiting a human look ─────────────────────
const QueueList = ({ queue, shopNames, busyId, onClear, onTakedownProduct }) => {
  const [notes, setNotes] = useState({});
  if (queue.length === 0) {
    return (
      <div className="py-16 text-center text-gray-500">
        <ShieldCheckIcon className="mx-auto mb-3 h-10 w-10 text-gray-700" />
        Inget att granska
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {queue.map((p) => {
        const s = QUEUE_STATUSES[p.screening?.status] || QUEUE_STATUSES.flagged;
        // An inactive (blocked) product has no storefront page — no dead link.
        const href = p.isActive === true ? storefrontProductUrl(p) : null;
        const thumb = p.b2cImageUrl || p.imageUrl || (Array.isArray(p.b2cImageGallery) ? p.b2cImageGallery[0] : '');
        const hits = Array.isArray(p.screening?.hits) ? p.screening.hits : [];
        const earlier = Array.isArray(p.screening?.earlierHits) ? p.screening.earlierHits : [];
        const busy = busyId === p.id;
        return (
          <li key={p.id} className="flex flex-col gap-4 rounded-xl border border-white/10 bg-gray-900 p-4 sm:flex-row sm:items-start">
            <div className="h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-gray-950">
              {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" /> : null}
            </div>
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-semibold text-white">{plainName(p.name) || '(namnlös produkt)'}</span>
                <Pill cls={s.cls}>{s.label}</Pill>
                {p.isActive !== true && <Pill cls="bg-white/5 text-gray-400">Inaktiv</Pill>}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-400">
                <Link to={`/shops/${p.shopId}`} className="text-gray-300 hover:text-white hover:underline">
                  {shopNames[p.shopId] || p.shopId}
                </Link>
                {p.sku && <span className="font-mono">{p.sku}</span>}
                <span>{formatDate(p.screening?.at)}</span>
                {href && (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-indigo-300 hover:text-indigo-200">
                    Visa i butiken <ArrowTopRightOnSquareIcon className="h-3 w-3" />
                  </a>
                )}
              </div>
              {hits.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  <span className="text-xs text-gray-500">Träffar:</span>
                  {hits.map((h) => (
                    <span key={h} className="rounded-md bg-amber-500/10 px-1.5 py-0.5 font-mono text-xs text-amber-200">{h}</span>
                  ))}
                </div>
              ) : p.screening?.status === 'review' ? (
                <p className="pt-0.5 text-xs text-gray-500">En av butikens första produkter — rutingranskning.</p>
              ) : null}
              {earlier.length > 0 && (
                <p className="text-xs text-gray-500">
                  Tidigare träffar som tagits bort ur texten: <span className="font-mono text-amber-200/70">{earlier.join(', ')}</span>
                </p>
              )}
            </div>
            <div className="flex w-full shrink-0 flex-col gap-2 sm:w-56">
              <input
                value={notes[p.id] || ''}
                onChange={(e) => setNotes((n) => ({ ...n, [p.id]: e.target.value }))}
                placeholder="Anteckning (vid avpublicering)"
                className={noteCls + ' text-xs'}
                aria-label={`Anteckning för ${plainName(p.name)}`}
              />
              <div className="flex gap-2">
                <button type="button" className={btnOk + ' flex-1 justify-center'} disabled={busy} onClick={() => onClear(p)}>
                  Godkänn
                </button>
                <button
                  type="button"
                  className={btnDanger + ' flex-1 justify-center'}
                  disabled={busy}
                  onClick={() => onTakedownProduct(p, notes[p.id] || '')}
                >
                  Avpublicera
                </button>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
};

// ── Presentational page body (rendered by the page and the dev harness) ─────
export const ReportsView = ({
  tab, onTab, loading, reports, queue, shopNames = {}, busyId,
  onTakedown, onReject, onMarkReviewing, onClear, onTakedownProduct,
}) => {
  const newCount = reports.filter((r) => r.status === 'new').length;
  const tabs = [
    { id: 'reports', label: 'Anmälningar', count: newCount },
    { id: 'review', label: 'Granskning', count: queue.length },
  ];
  return (
    <div className="px-6 lg:px-10 py-8 max-w-[1600px]">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Anmälningar</h1>
        <p className="mt-1 text-gray-400">
          Intrångsanmälningar från butikernas sidfot och produkter som fastnat i varumärkesgranskningen.
        </p>
      </div>

      <div className="mb-6 flex gap-1 border-b border-white/10" role="tablist">
        {tabs.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onTab(t.id)}
              className={
                '-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ' +
                (active ? 'border-indigo-400 text-white' : 'border-transparent text-gray-400 hover:text-gray-200')
              }
            >
              {t.label}
              {t.count > 0 && (
                <span className={'rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ' + (active ? 'bg-indigo-500/20 text-indigo-200' : 'bg-white/5 text-gray-400')}>
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="py-16 text-center text-gray-500">Laddar…</div>
      ) : tab === 'reports' ? (
        <ReportsTable
          reports={reports}
          shopNames={shopNames}
          busyId={busyId}
          onTakedown={onTakedown}
          onReject={onReject}
          onMarkReviewing={onMarkReviewing}
        />
      ) : (
        <>
          <p className="mb-4 text-sm text-gray-500">
            Flaggade produkter publiceras ändå — granska och avpublicera om säljaren saknar rätt till märket.
            Nya butikers första produkter hamnar här för en rutinkoll.
          </p>
          <QueueList
            queue={queue}
            shopNames={shopNames}
            busyId={busyId}
            onClear={onClear}
            onTakedownProduct={onTakedownProduct}
          />
        </>
      )}
    </div>
  );
};

// ── Data container ─────────────────────────────────────────────────────────
const PlatformReports = () => {
  const { currentUser } = useAuth();
  const [tab, setTab] = useState('reports');
  const [reports, setReports] = useState([]);
  const [queue, setQueue] = useState([]);
  const [shopNames, setShopNames] = useState({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [repSnap, queueSnap, shopSnap] = await Promise.all([
        // Single orderBy on one collection — no composite index needed.
        getDocs(query(collection(db, 'infringementReports'), orderBy('createdAt', 'desc'))),
        // Single-field `in` — no composite index; sorted client-side.
        getDocs(query(collection(db, 'products'), where('screening.status', 'in', Object.keys(QUEUE_STATUSES)))),
        getDocs(collection(db, 'shops')),
      ]);
      const names = {};
      shopSnap.docs.forEach((d) => {
        const s = d.data();
        names[d.id] = s.storeIdentity?.shopName || s.name || d.id;
      });

      const reps = repSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      // The matched product (for the storefront link) — one read per distinct id.
      const ids = [...new Set(reps.map((r) => r.productId).filter(Boolean))];
      const prods = {};
      await Promise.all(ids.map(async (id) => {
        try {
          const snap = await getDoc(doc(db, 'products', id));
          if (snap.exists()) prods[id] = { id, ...snap.data() };
        } catch { /* deleted product — row still renders from the report */ }
      }));

      const q = queueSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      q.sort((a, b) =>
        (QUEUE_STATUSES[a.screening?.status]?.rank ?? 9) - (QUEUE_STATUSES[b.screening?.status]?.rank ?? 9) ||
        tsMillis(b.screening?.at) - tsMillis(a.screening?.at));

      setShopNames(names);
      setReports(reps.map((r) => ({ ...r, product: prods[r.productId] || null })));
      setQueue(q);
    } catch (e) {
      console.error('Error loading reports:', e);
      toast.error('Kunde inte ladda anmälningar');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = async (id, fn, okMsg) => {
    try {
      setBusyId(id);
      await fn();
      toast.success(okMsg);
      notifyPlatformBadgesChanged();
      await load();
    } catch (e) {
      console.error('PlatformReports action failed:', e);
      toast.error(e?.message || 'Åtgärden misslyckades');
    } finally {
      setBusyId(null);
    }
  };

  const takedown = (productId, reportId, note) =>
    httpsCallable(getFunctions(undefined, 'us-central1'), 'takedownProduct')({ productId, reportId, note });

  const onTakedown = (report, productId, note) => {
    if (!window.confirm('Avpublicera produkten? Den försvinner direkt från butiken.')) return;
    return act(report.id, () => takedown(productId, report.id, note), 'Produkten är avpublicerad');
  };
  const onReject = (report, note) =>
    act(report.id, () => updateDoc(doc(db, 'infringementReports', report.id), {
      status: 'rejected', note: note || '', handledAt: serverTimestamp(), handledBy: currentUser?.uid || null,
    }), 'Anmälan avvisad');
  const onMarkReviewing = (report) =>
    act(report.id, () => updateDoc(doc(db, 'infringementReports', report.id), { status: 'reviewing' }), 'Markerad som granskas');
  const onClear = (product) =>
    act(product.id, () => updateDoc(doc(db, 'products', product.id), {
      'screening.status': 'cleared',
      'screening.clearedAt': serverTimestamp(),
      'screening.clearedBy': currentUser?.uid || null,
    }), 'Godkänd');
  const onTakedownProduct = (product, note) => {
    if (!window.confirm('Avpublicera produkten? Den försvinner direkt från butiken.')) return;
    return act(product.id, () => takedown(product.id, null, note), 'Produkten är avpublicerad');
  };

  return (
    <PlatformLayout>
      <ReportsView
        tab={tab}
        onTab={setTab}
        loading={loading}
        reports={reports}
        queue={queue}
        shopNames={shopNames}
        busyId={busyId}
        onTakedown={onTakedown}
        onReject={onReject}
        onMarkReviewing={onMarkReviewing}
        onClear={onClear}
        onTakedownProduct={onTakedownProduct}
      />
    </PlatformLayout>
  );
};

export default PlatformReports;
