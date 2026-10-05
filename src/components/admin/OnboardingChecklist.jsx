// "Kom igång": what a new shop has left before it can sell (CP9-OB item 3).
// The steps come from the dashboard's data module (adapters/onboarding.js in
// the admin build); this only shows them. Admin Neutral look.
import React from 'react';
import { Link } from 'react-router-dom';
import { CheckCircleIcon, ClockIcon } from '@heroicons/react/24/outline';
import { CardSection } from './ui';

function Marker({ state }) {
  if (state === 'done') {
    return <CheckCircleIcon className="h-5 w-5 shrink-0 text-admin-success-dot" aria-hidden="true" />;
  }
  if (state === 'platform' || state === 'waiting') {
    return <ClockIcon className="h-5 w-5 shrink-0 text-admin-text-faint" aria-hidden="true" />;
  }
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden="true">
      <span className="h-3.5 w-3.5 rounded-full border-2 border-admin-caution-dot" />
    </span>
  );
}

const STATE_WORD = { done: 'Klart', todo: 'Att göra', platform: 'Plattformen', waiting: 'Väntar' };

export default function OnboardingChecklist({ steps }) {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const done = steps.filter((step) => step.state === 'done').length;

  return (
    <CardSection
      title="Kom igång"
      actions={<span className="text-[12px] text-admin-text-muted tabular-nums">{done} av {steps.length} klara</span>}
      bodyClassName="!p-0"
    >
      <ol className="divide-y divide-admin-border">
        {steps.map((step) => (
          <li
            key={step.key}
            className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5 px-4 py-3 sm:grid-cols-[1.25rem_minmax(0,1fr)_auto]"
          >
            <Marker state={step.state} />
            <div>
              <span className="sr-only">{STATE_WORD[step.state]}:</span>
              <p className={`text-[13px] font-medium ${step.state === 'done' ? 'text-admin-text-muted' : 'text-admin-text'}`}>
                {step.title}
              </p>
              <p className="mt-0.5 text-[12px] text-admin-text-muted">{step.text}</p>
              {step.note && <p className="mt-0.5 text-[12px] text-admin-text-faint">{step.note}</p>}
            </div>
            {/* Below the sentence on a phone, at the row's end from sm up. */}
            {step.state === 'todo' && step.to && (
              <Link
                to={step.to}
                className="col-start-2 justify-self-start text-[13px] font-medium text-admin-text underline-offset-2 hover:underline sm:col-start-3 sm:row-start-1 sm:justify-self-end sm:whitespace-nowrap"
              >
                {step.linkLabel} <span aria-hidden="true">&rarr;</span>
              </Link>
            )}
          </li>
        ))}
      </ol>
    </CardSection>
  );
}
