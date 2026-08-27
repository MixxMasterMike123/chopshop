import React from 'react';
import { Link } from 'react-router-dom';

/**
 * Page — the Admin Neutral page frame (Polaris-style).
 *
 * Gives every admin page one consistent header grammar: optional back-link,
 * title (+ optional subtitle / inline status pills), and a right-aligned action
 * cluster. It does NOT add its own max-width/centering — AppLayout's <main>
 * owns the shared content container, so pages aren't double-boxed.
 *
 * Polaris page title = 20px / semibold; header bottom margin = 20px (space-500).
 *
 * @param {React.ReactNode} props.title
 * @param {React.ReactNode} [props.subtitle]
 * @param {React.ReactNode} [props.titleAdornment]  e.g. status pills next to title
 * @param {React.ReactNode} [props.actions]  right-aligned header actions
 * @param {{to:string,label:string,onClick?:function}} [props.back]  back link.
 *   `onClick` is for hosts whose "detail view" is LOCAL STATE on the list route
 *   (AdminProducts) rather than a route of its own: navigating to the list URL
 *   is then a same-URL no-op that leaves the form mounted, so the host must
 *   also clear that state. Handler runs first, then the Link navigates.
 */
export default function Page({
  title,
  subtitle,
  titleAdornment,
  actions,
  back,
  className = '',
  children,
}) {
  return (
    <div>
      {(title || actions || back) && (
        <header className="mb-4">
          {back && (
            <Link
              to={back.to}
              onClick={back.onClick}
              className="inline-flex items-center gap-1 text-[13px] text-admin-text-muted hover:text-admin-text mb-2"
            >
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path
                  fillRule="evenodd"
                  d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z"
                  clipRule="evenodd"
                />
              </svg>
              {back.label}
            </Link>
          )}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                {title && (
                  <h1 className="text-[20px] font-semibold leading-7 text-admin-text truncate">{title}</h1>
                )}
                {titleAdornment}
              </div>
              {subtitle && <p className="mt-0.5 text-[13px] text-admin-text-muted">{subtitle}</p>}
            </div>
            {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
          </div>
        </header>
      )}
      <div className={className}>{children}</div>
    </div>
  );
}
