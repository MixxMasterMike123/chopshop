// PrintShopOrderDetail — one order's PRODUCTION view. Calls getPrintJob (per-
// resource scope check server-side); renders ship-to + per-line production fields
// + signed-URL downloads. The callable returns ONLY production data, so there is
// no customer PII here to leak by accident. Unresolved lines (renamed SKU / deleted
// artwork) show a visible problem, never a silent gap.
import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../../firebase/config';
import PrintShopLayout from '../../components/print/PrintShopLayout';

const fmtDate = (iso) => { try { return iso ? new Date(iso).toLocaleDateString('sv-SE') : ''; } catch { return iso || ''; } };

const TIER_BADGE = {
  PASS: 'bg-emerald-500/15 text-emerald-300',
  WARN: 'bg-amber-500/15 text-amber-300',
  FAIL: 'bg-red-500/15 text-red-300',
};

// Swedish labels for the status pill on the print surface (dark aesthetic).
const STATUS_LABEL = {
  pending: 'Väntar',
  confirmed: 'Bekräftad',
  processing: 'Behandlas',
  printed: 'Tryckt',
  shipped: 'Skickad',
  delivered: 'Levererad',
  ready_for_pickup: 'Redo att hämtas',
  cancelled: 'Avbruten',
  refunded: 'Återbetald',
  completed: 'Slutförd',
};
const STATUS_CHIP = {
  printed: 'bg-purple-500/15 text-purple-300',
  shipped: 'bg-emerald-500/15 text-emerald-300',
  delivered: 'bg-emerald-500/15 text-emerald-300',
  completed: 'bg-emerald-500/15 text-emerald-300',
  cancelled: 'bg-red-500/15 text-red-300',
  refunded: 'bg-red-500/15 text-red-300',
};
// Statuses past which the printer can no longer advance (mirrors the callable).
const TERMINAL = ['shipped', 'delivered', 'cancelled', 'refunded', 'completed'];

const PrintShopOrderDetail = () => {
  const { orderId } = useParams();
  const [job, setJob] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Status-action state (mirrors the admin's pendingShip pattern: the "shipped"
  // action reveals a tracking-number input first, then confirms).
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [pendingShip, setPendingShip] = useState(false);
  const [trackingNumber, setTrackingNumber] = useState('');

  const loadJob = React.useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await httpsCallable(functions, 'getPrintJob')({ orderId });
      setJob(res.data);
    } catch (e) {
      console.error('getPrintJob failed:', e);
      setError(e?.message || 'Kunde inte ladda ordern.');
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => { loadJob(); }, [loadJob]);

  const runAction = async (action, extra = {}) => {
    setBusy(true); setActionError('');
    try {
      await httpsCallable(functions, 'setPrintJobStatus')({ orderId, action, ...extra });
      toast.success(action === 'shipped' ? 'Markerad som skickad — kunden aviseras.' : 'Markerad som tryckt.');
      setPendingShip(false);
      setTrackingNumber('');
      await loadJob(); // reflect the new status
    } catch (e) {
      console.error('setPrintJobStatus failed:', e);
      const msg = e?.message || 'Kunde inte uppdatera status.';
      setActionError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleShipConfirm = () => {
    const tn = (trackingNumber || '').trim();
    runAction('shipped', tn ? { trackingNumber: tn } : {});
  };

  const status = job?.order?.status || '';
  const isTerminal = TERMINAL.includes(status);
  const canPrint = !isTerminal && status !== 'printed';
  // Pickup orders are handed over by the shop — the printer never "ships" them
  // (the server rejects it too); their journey here ends at "tryckt".
  const isPickup = job?.deliveryMethod === 'pickup';

  return (
    <PrintShopLayout>
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        <Link to="/" className="text-sm text-indigo-300 hover:text-indigo-200">← Tillbaka till kön</Link>

        {loading ? (
          <p className="mt-4 text-sm text-gray-400">Laddar…</p>
        ) : error ? (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>
        ) : job ? (
          <>
            <div className="mt-3 mb-5">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-lg font-bold">Order {job.order.orderNumber}</h1>
                {status && (
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_CHIP[status] || 'bg-white/10 text-gray-300'}`}>
                    {STATUS_LABEL[status] || status}
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-400">
                {job.shopName} · {fmtDate(job.order.orderDate)}
              </p>
            </div>

            {/* Status actions — the printer pushes the order forward. "Tryckt" is an
                internal milestone (no customer mail); "Skickad" avises the customer
                (reveals an optional tracking-number field first, like the admin). */}
            <div className="mb-6 rounded-xl border border-white/10 bg-white/5 p-4">
              <h2 className="mb-2 text-xs uppercase tracking-wide text-gray-400">Produktionsstatus</h2>
              {isTerminal ? (
                <p className="text-sm text-gray-400">
                  Ordern har status <span className="text-gray-200">{STATUS_LABEL[status] || status}</span> och kan inte ändras här.
                </p>
              ) : pendingShip ? (
                <div className="space-y-3">
                  <label className="block text-sm text-gray-300">
                    Spårningsnummer <span className="text-gray-500">(valfritt)</span>
                    <input
                      type="text"
                      value={trackingNumber}
                      onChange={(e) => setTrackingNumber(e.target.value)}
                      placeholder="t.ex. PostNord-kolli-ID"
                      className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-500 focus:border-indigo-400 focus:outline-none"
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={handleShipConfirm}
                      disabled={busy}
                      className="rounded-lg bg-emerald-500/20 px-3 py-1.5 text-sm font-medium text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-50"
                    >
                      {busy ? 'Skickar…' : 'Bekräfta skickad'}
                    </button>
                    <button
                      onClick={() => { setPendingShip(false); setTrackingNumber(''); }}
                      disabled={busy}
                      className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-gray-300 hover:bg-white/10 disabled:opacity-50"
                    >
                      Avbryt
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => runAction('printed')}
                    disabled={busy || !canPrint}
                    title={!canPrint ? 'Ordern är redan markerad som tryckt' : undefined}
                    className="rounded-lg bg-purple-500/20 px-3 py-1.5 text-sm font-medium text-purple-200 hover:bg-purple-500/30 disabled:opacity-50"
                  >
                    {busy ? 'Uppdaterar…' : 'Markera som tryckt'}
                  </button>
                  {!isPickup && (
                    <button
                      onClick={() => setPendingShip(true)}
                      disabled={busy}
                      className="rounded-lg bg-emerald-500/20 px-3 py-1.5 text-sm font-medium text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-50"
                    >
                      Markera som skickad
                    </button>
                  )}
                  {isPickup && (
                    <span className="self-center text-sm text-gray-400">
                      Upphämtningsorder — butiken lämnar ut till kunden. Markera som tryckt när den är klar.
                    </span>
                  )}
                </div>
              )}
              {actionError && (
                <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{actionError}</div>
              )}
            </div>

            {/* Delivery block: pickup orders go to the SHOP's pickup location (no
                customer ship-to at all); home orders show the ship-to address
                (production-scoped — no email/phone). */}
            {isPickup ? (
              <div className="mb-6 rounded-xl border border-white/10 bg-white/5 p-4">
                <h2 className="mb-1 text-xs uppercase tracking-wide text-gray-400">Upphämtning — ingen frakt till kund</h2>
                <p className="text-sm text-gray-200">
                  Levereras till butikens utlämningsställe{job.pickup?.name ? ':' : '.'}<br />
                  {job.pickup?.name && <span className="font-medium">{job.pickup.name}</span>}
                  {job.pickup?.address && <><br />{job.pickup.address}</>}
                  {job.pickup?.date && <><br /><span className="text-gray-400">Utlämningsdatum: {job.pickup.date}</span></>}
                </p>
                <p className="mt-2 text-xs text-gray-500">Märk paketet med ordernumret {job.order.orderNumber}.</p>
              </div>
            ) : job.shipTo ? (
              <div className="mb-6 rounded-xl border border-white/10 bg-white/5 p-4">
                <h2 className="mb-1 text-xs uppercase tracking-wide text-gray-400">Leveransadress</h2>
                <p className="text-sm text-gray-200">
                  {job.shipTo.name}<br />
                  {job.shipTo.line1}{job.shipTo.line2 ? `, ${job.shipTo.line2}` : ''}<br />
                  {job.shipTo.postalCode} {job.shipTo.city}<br />
                  {job.shipTo.country}
                </p>
              </div>
            ) : null}

            {/* Production lines */}
            <h2 className="mb-2 text-xs uppercase tracking-wide text-gray-400">Produktionsrader</h2>
            <div className="space-y-3">
              {job.lines.map((ln, i) => (
                <div key={i} className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <div className="flex items-start gap-4">
                    {ln.artwork?.previewUrl && (
                      <img src={ln.artwork.previewUrl} alt="" className="h-16 w-16 shrink-0 rounded-lg border border-white/10 object-cover" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-white">{ln.productName}</span>
                        <span className="font-mono text-xs text-gray-400">{ln.sku}</span>
                        {ln.variantLabel && <span className="rounded bg-white/10 px-1.5 py-0.5 text-xs text-gray-300">{ln.variantLabel}</span>}
                        <span className="text-xs text-gray-400">× {ln.quantity}</span>
                        {ln.artwork?.tier && (
                          <span className={`rounded px-1.5 py-0.5 text-xs ${TIER_BADGE[ln.artwork.tier] || 'bg-white/10 text-gray-300'}`}>{ln.artwork.tier}</span>
                        )}
                      </div>
                      <div className="mt-1 text-sm text-gray-400">
                        {ln.purpose ? `Profil: ${ln.purpose}` : ''}{ln.placement ? ` · Placering: ${ln.placement}` : ''}
                      </div>

                      {ln.artwork?.unresolved ? (
                        <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
                          ⚠ Kunde inte hämta original: {ln.artwork.reason}. Kontakta butiken.
                        </div>
                      ) : ln.artwork?.downloadUrl ? (
                        <a
                          href={ln.artwork.downloadUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-2 inline-block rounded-lg bg-indigo-500/20 px-3 py-1.5 text-sm font-medium text-indigo-200 hover:bg-indigo-500/30"
                        >
                          {ln.artwork.isPrintFile
                            ? `Ladda ner tryckfil (PNG)${ln.artwork.fileName ? ` — ${ln.artwork.fileName}` : ''}`
                            : `Ladda ner original${ln.artwork.fileName ? ` (${ln.artwork.fileName})` : ''}`}
                        </a>
                      ) : (
                        <p className="mt-2 text-sm text-gray-500">Ingen nedladdningslänk tillgänglig.</p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {job.lines.length === 0 && <p className="text-sm text-gray-400">Inga POD-rader i denna order.</p>}
            </div>
          </>
        ) : null}
      </div>
    </PrintShopLayout>
  );
};

export default PrintShopOrderDetail;
