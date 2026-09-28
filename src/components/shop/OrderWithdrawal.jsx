import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from '../../contexts/TranslationContext';
import { submitWithdrawal } from '../../api/withdrawal';
import { toWithdrawalRequest, toWithdrawalView } from '../../storefront/adapters/withdrawal';

/**
 * Ångerfunktion — the consumer right-of-withdrawal function on the storefront
 * (DAL 2 kap. 10 a § / CRD Art. 11a, in force 19 June 2026). The law requires a
 * function, available throughout the withdrawal period, that lets the consumer:
 *   - identify the contract + provide/confirm name + the email for the receipt,
 *   - confirm via a control labelled "Bekräfta ångra" / "confirm withdrawal",
 * after which the trader sends an acknowledgement of receipt on a durable medium
 * with its content + the date and time of submission.
 *
 * This component is the client half. The submission TIME, eligibility, and the
 * durable acknowledgement are all decided SERVER-side by POST /v1/withdrawals
 * (the guest path: the order's number and its purchase address; there are no
 * signed-in buyers, D81) — the client only collects the statement, calls it,
 * and renders the returned acknowledgement as an on-screen, savable
 * mottagningsbevis.
 *
 * Regime split (from the order, never recomputed here):
 *   - order.withdrawal.required === true → personalised / made-to-order → the
 *     server returns reason 'personalized_exempt' and we show "ingen ångerrätt".
 *   - otherwise → standard order, withdrawal applies.
 */
const OrderWithdrawal = ({ order }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(order?.customerInfo?.name || '');
  const [contactEmail, setContactEmail] = useState(order?.customerInfo?.email || '');
  const [submitting, setSubmitting] = useState(false);
  const [acknowledgement, setAcknowledgement] = useState(
    order?.withdrawalRequest?.acknowledgement || null
  );
  const [exemptReason, setExemptReason] = useState(null);

  // Personalised (Regime B) orders are exempt under Art. 16(c). We still surface
  // the function — it reflects that no withdrawal right applies — but show the
  // disclosure instead of the statement form. Read-only from the order.
  const isPersonalizedExempt = order?.withdrawal?.required === true;

  // Already withdrawn? Show the saved acknowledgement.
  const alreadyReceived = order?.withdrawalRequest?.status === 'received';

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      // The order's number and the purchase address are the ownership proof.
      const answer = await submitWithdrawal(
        toWithdrawalRequest({ orderNumber: order.orderNumber || '', name, contactEmail })
      );
      const view = toWithdrawalView(answer);
      if (view.refusal) {
        if (view.refusal === 'personalized_exempt') {
          setExemptReason('personalized_exempt');
        } else if (view.refusal === 'window_passed') {
          toast.error(t('order_withdrawal_window_passed', 'Det har gått för lång tid sedan beställningen för att den ska kunna ångras här.'));
        } else {
          toast.error(t('order_withdrawal_not_eligible', 'Den här beställningen kan inte ångras.'));
        }
        return;
      }
      if (view.acknowledgement) {
        setAcknowledgement(view.acknowledgement);
        setOpen(false);
        toast.success(t('order_withdrawal_received', 'Din ångeranmälan har tagits emot.'));
      }
    } catch (err) {
      console.error('submitWithdrawal failed', err?.code);
      toast.error(t('order_withdrawal_error', 'Något gick fel. Försök igen.'));
    } finally {
      setSubmitting(false);
    }
  };

  // ── On-screen mottagningsbevis (acknowledgement of receipt) ──────────────
  // This persisted + on-screen record is the durable medium; the email is a
  // best-effort second copy. The consumer can save/print this.
  if (acknowledgement) {
    return (
      <div className="mt-3 pt-3 border-t border-gray-100">
        <div className="rounded-md bg-green-50 border border-green-200 p-3">
          <p className="text-sm font-semibold text-green-800">
            {t('order_withdrawal_receipt_title', 'Mottagningsbevis – ångrat köp')}
          </p>
          <p className="text-sm text-green-700 mt-1">
            {t('order_withdrawal_receipt_received', 'Mottaget')}: {acknowledgement.submittedAt}
          </p>
          <p className="text-sm text-green-700 mt-1">{acknowledgement.statement}</p>
          <p className="text-xs text-green-600 mt-2">
            {t('order_withdrawal_receipt_save', 'Spara detta mottagningsbevis. Återbetalning hanteras enligt våra villkor.')}
          </p>
        </div>
      </div>
    );
  }

  // ── Regime B: personalised / made-to-order → no withdrawal right ─────────
  if (isPersonalizedExempt || exemptReason === 'personalized_exempt') {
    return (
      <div className="mt-3 pt-3 border-t border-gray-100">
        <p className="text-sm text-gray-500">
          {t(
            'order_withdrawal_not_allowed_pod',
            'Den här beställningen innehåller specialtillverkade produkter – ångerrätten gäller inte. Reklamationsrätten vid fel på varan gäller alltid.'
          )}
        </p>
      </div>
    );
  }

  // ── Regime A: standard order → the withdrawal function ───────────────────
  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-sm font-medium text-blue-600 hover:text-blue-700 underline"
        >
          {/* Statutory label (DAL 2 kap. 10 a § / Art. 11a): "ångra avtalet här" */}
          {t('order_withdrawal_button', 'Ångra avtalet här')}
        </button>
      ) : (
        <div className="rounded-md bg-gray-50 border border-gray-200 p-3 space-y-3">
          <p className="text-sm text-gray-700">
            {t(
              'order_withdrawal_intro',
              'Du har rätt att ångra ditt köp inom 14 dagar från att du tog emot varan. Bekräfta nedan så skickar vi ett mottagningsbevis.'
            )}
          </p>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              {t('order_withdrawal_name', 'Namn')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-hidden focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              {t('order_withdrawal_order_ref', 'Beställning')}
            </label>
            <input
              type="text"
              value={`#${order.orderNumber || order.id}`}
              readOnly
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-gray-100 text-gray-600"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              {t('order_withdrawal_email', 'E-post för bekräftelse')}
            </label>
            <input
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-hidden focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleConfirm}
              disabled={submitting}
              className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 transition-colors text-sm disabled:opacity-60"
            >
              {/* Statutory confirmation label (Art. 11a(3)) */}
              {submitting
                ? t('order_withdrawal_submitting', 'Skickar…')
                : t('order_withdrawal_confirm', 'Bekräfta ångra')}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={submitting}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              {t('order_withdrawal_cancel', 'Avbryt')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default OrderWithdrawal;
