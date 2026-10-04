// What the console's three settings pages share (unit CP5-FL): the header with
// the section links, the confirm dialog, and the console's own class strings.
// Every class here is copied from an existing console page, named at each
// string; nothing introduces a colour, a radius or a shadow of its own.

import React, { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';

// PrinterRow.jsx (inputCls, btnPrimary), PlatformReports.jsx (btnQuiet, noteCls as textareaCls).
export const inputCls = 'rounded-lg border border-white/10 bg-gray-950 px-3 py-1.5 text-sm text-gray-100 placeholder-gray-600 focus:border-indigo-500 focus:outline-none disabled:opacity-50';
export const textareaCls = 'w-full rounded-lg border border-white/10 bg-gray-950 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600 focus:border-indigo-500 focus:outline-none disabled:opacity-50';
export const btnPrimary = 'rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed';
// shopCells.jsx CommissionCell's save button, at btnQuiet's size.
export const btnPrimarySm = 'inline-flex items-center rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed';
export const btnQuiet ='inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium bg-white/5 text-gray-200 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed';
// PlatformUsers.jsx's row action: quiet at rest, red on hover (a list of many rows).
export const btnRowDanger = 'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium bg-white/5 text-gray-300 hover:bg-red-500/15 hover:text-red-300 disabled:opacity-40 disabled:cursor-not-allowed';
// PlatformShopDetail.jsx (the pill).
export const pillCls = 'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium';
// PlatformPrinters.jsx (the amber notice).
export const noticeCls = 'rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200';
// PlatformUsers.jsx (the error line of its modal), as a block.
export const errorCls = 'rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300';

/** PlatformShopDetail.jsx's Card. */
export const Card = ({ title, action, children }) => (
  <section className="rounded-xl border border-white/10 bg-gray-900 p-5">
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">{title}</h2>
      {action}
    </div>
    {children}
  </section>
);

const SECTIONS = [
  { id: 'settings', label: 'Allmänt', short: 'Allmänt', to: '/settings' },
  { id: 'screening', label: 'Varumärkesfilter', short: 'Filter', to: '/screening' },
  { id: 'terms', label: 'Plattformsvillkor', short: 'Villkor', to: '/terms' },
];

/**
 * The settings area's header: the title of the console's pages
 * (PlatformShops.jsx) and the section links, drawn as PlatformReports.jsx's
 * tabs. Each section is its own address, so a link can name it.
 */
export function SettingsHeader({ active, subtitle, actions }) {
  return (
    <>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Inställningar</h1>
          <p className="mt-1 text-gray-400">{subtitle}</p>
        </div>
        {actions}
      </div>
      <nav aria-label="Inställningar" className="mb-6 flex gap-1 overflow-x-auto border-b border-white/10">
        {SECTIONS.map((s) => {
          const current = s.id === active;
          return (
            <Link
              key={s.id}
              to={s.to}
              aria-current={current ? 'page' : undefined}
              className={
                '-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors sm:px-4 ' +
                (current ? 'border-indigo-400 text-white' : 'border-transparent text-gray-400 hover:text-gray-200')
              }
            >
              <span className="sm:hidden">{s.short}</span>
              <span className="hidden sm:inline">{s.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}

/** The console's centred states (PlatformUsers.jsx). */
export const Loading = () => <div className="py-16 text-center text-gray-500">Laddar…</div>;

export function LoadError({ icon: Icon, message, onRetry }) {
  return (
    <div className="py-16 text-center text-gray-400">
      {Icon && <Icon className="mx-auto mb-3 h-10 w-10 text-red-500/60" />}
      <p>{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex items-center gap-2 rounded-lg bg-white/5 px-4 py-2 text-sm font-medium text-gray-200 hover:bg-white/10"
      >
        Försök igen
      </button>
    </div>
  );
}

/**
 * A confirm that says what a change does before it is made: PlatformUsers.jsx's
 * modal. `confirm` = { title, lines, confirmLabel, tone: 'primary' | 'danger' }.
 * While `busy`, nothing closes it (the answer lands where it was asked);
 * Escape and the backdrop cancel otherwise. The cancel button has the focus
 * first: an Enter does not confirm by accident.
 */
export function ConfirmDialog({ confirm, busy = false, error = '', onConfirm, onCancel, children }) {
  const cancelRef = useRef(null);
  useEffect(() => {
    if (!confirm) return undefined;
    cancelRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirm, busy, onCancel]);
  if (!confirm) return null;
  const danger = confirm.tone === 'danger';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={busy ? undefined : onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="fl-confirm-title"
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-white/10 bg-gray-900 text-gray-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-white/10 px-6 py-5">
          <h2 id="fl-confirm-title" className="text-lg font-semibold text-white">{confirm.title}</h2>
        </div>
        <div className="space-y-3 px-6 py-5">
          <ul className="space-y-2 text-sm leading-relaxed text-gray-300">
            {confirm.lines.map((line) => (
              <li key={line} className="flex gap-2">
                <span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-gray-500" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
          {children}
          {error && <p className={errorCls} role="alert">{error}</p>}
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <button
              ref={cancelRef}
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="rounded-lg px-4 py-2 text-sm text-gray-400 hover:text-gray-200 disabled:opacity-50"
            >
              Avbryt
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              className={danger
                ? 'rounded-lg bg-red-500/15 px-4 py-2 text-sm font-semibold text-red-300 hover:bg-red-500/25 disabled:opacity-50'
                : btnPrimary}
            >
              {busy ? 'Skickar…' : confirm.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
