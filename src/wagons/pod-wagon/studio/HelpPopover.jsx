import React, { useEffect, useId, useRef, useState } from 'react';
import { InformationCircleIcon } from '@heroicons/react/24/outline';

// Small progressive-disclosure control for technical studio concepts. Required
// instructions stay inline; this only carries optional explanatory context.
const HelpPopover = ({ label, children }) => {
  const [open, setOpen] = useState(false);
  const id = useId();
  const rootRef = useRef(null);
  const buttonRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const closeOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };

    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <span
      ref={rootRef}
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!rootRef.current?.contains(document.activeElement)) setOpen(false);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Förklaring: ${label}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        className="grid h-8 w-8 place-items-center rounded-full text-admin-text-muted hover:bg-admin-surface-2 hover:text-admin-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-admin-primary)]"
      >
        <InformationCircleIcon className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="absolute right-0 top-full z-30 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface px-3 py-2 text-left text-[12px] font-normal leading-relaxed text-admin-text shadow-[var(--shadow-admin)]"
        >
          <span className="mb-0.5 block font-medium">{label}</span>
          {children}
        </span>
      )}
    </span>
  );
};

export default HelpPopover;
