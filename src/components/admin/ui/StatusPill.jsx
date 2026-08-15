import React from 'react';

/**
 * StatusPill — Polaris Badge. Desaturated pastel chip with a small leading
 * marker (filled dot = done/positive, hollow ring = pending/caution). 12px /
 * medium / 8px radius / 2px·8px padding. NOT a bright Tailwind badge.
 *
 * Tones map to the admin status tokens (index.css). These are intentionally
 * mode-agnostic — solid pale chips with dark text stay legible on both the
 * light and dark admin canvas (like GitHub/Linear badges), so the badge tokens
 * are NOT re-pointed under .dark.
 * `marker`: 'dot' (filled) | 'ring' (hollow) | 'none'. Tone presets pick a
 * sensible default marker; override per call when needed.
 */

const TONE = {
  success: { cls: 'bg-admin-success-bg text-admin-success-text', dot: 'bg-admin-success-dot', ring: 'border-admin-success-dot', marker: 'dot' },
  positive: { cls: 'bg-admin-success-bg text-admin-success-text', dot: 'bg-admin-success-dot', ring: 'border-admin-success-dot', marker: 'dot' },
  info: { cls: 'bg-admin-info-bg text-admin-info-text', dot: 'bg-admin-info-dot', ring: 'border-admin-info-dot', marker: 'dot' },
  warning: { cls: 'bg-admin-caution-bg text-admin-caution-text', dot: 'bg-admin-caution-dot', ring: 'border-admin-caution-dot', marker: 'ring' },
  attention: { cls: 'bg-admin-caution-bg text-admin-caution-text', dot: 'bg-admin-caution-dot', ring: 'border-admin-caution-dot', marker: 'ring' },
  danger: { cls: 'bg-admin-critical-bg text-admin-critical-text', dot: 'bg-admin-critical-dot', ring: 'border-admin-critical-dot', marker: 'dot' },
  neutral: { cls: 'bg-admin-neutral-bg text-admin-neutral-text', dot: 'bg-admin-neutral-dot', ring: 'border-admin-neutral-dot', marker: 'dot' },
};

// Order lifecycle status → tone (preserves prior color meaning intent).
export const ORDER_STATUS_TONE = {
  pending: 'warning',
  confirmed: 'info',
  processing: 'attention',
  ready_for_pickup: 'info',
  shipped: 'success',
  delivered: 'positive',
  cancelled: 'danger',
  refunded: 'danger',
  partially_refunded: 'attention',
};
export const PAYMENT_STATUS_TONE = { paid: 'success', pending: 'warning', unpaid: 'warning', refunded: 'neutral', failed: 'danger' };
export const FULFILLMENT_STATUS_TONE = { fulfilled: 'success', unfulfilled: 'warning', partial: 'attention', cancelled: 'danger' };

export function toneForOrderStatus(status) {
  return ORDER_STATUS_TONE[status] || 'neutral';
}

/**
 * @param {object} props
 * @param {'success'|'positive'|'info'|'warning'|'attention'|'danger'|'neutral'} [props.tone='neutral']
 * @param {'dot'|'ring'|'none'} [props.marker]  override the tone's default marker
 * @param {React.ReactNode} props.children  the (translated) label
 */
export default function StatusPill({ tone = 'neutral', marker, className = '', children }) {
  const t = TONE[tone] || TONE.neutral;
  const m = marker || t.marker;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-[var(--radius-admin-el)] px-2 py-0.5 text-[12px] font-medium leading-4 whitespace-nowrap ${t.cls} ${className}`}
    >
      {m === 'ring' ? (
        <span className={`h-2 w-2 shrink-0 rounded-full border-[1.5px] ${t.ring}`} aria-hidden="true" />
      ) : m === 'dot' ? (
        <span className={`h-2 w-2 shrink-0 rounded-full ${t.dot}`} aria-hidden="true" />
      ) : null}
      {children}
    </span>
  );
}
