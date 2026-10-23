// ShopAddressCard — "Butikens adress" on the settings page (CP14): the shop's
// own label under the platform's shop domain, e.g. melodiemc.flippinstuff.se.
// The data layer (adminSettingsData.js SHOP_ADDRESS) loads and saves; the
// page renders this card only where the build has one. Admin-Neutral.
import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Button, CardSection } from './ui';
import {
  ADDRESS_COPY,
  addressErrorMessage,
  addressPreview,
  labelProblem,
  normalizeLabel,
  swedishDate,
} from '../../admin-app/adapters/shopAddress.js';

const ShopAddressCard = ({ shopId, load, save }) => {
  const [view, setView] = useState(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    load(shopId)
      .then((loaded) => {
        if (cancelled) return;
        setView(loaded);
        setValue(loaded?.label ?? '');
      })
      .catch((e) => console.warn('ShopAddressCard: could not load the address:', e?.message));
    return () => { cancelled = true; };
  }, [shopId, load]);

  // No base domain: the platform has not switched shop addresses on. Nothing to show.
  if (!view?.baseDomain) return null;

  const label = normalizeLabel(value);
  const unchanged = label === (view.label ?? '');

  const submit = async (event) => {
    event.preventDefault();
    const problem = labelProblem(label);
    if (problem) { setError(problem); return; }
    if (unchanged) { setError(''); toast(ADDRESS_COPY.unchanged); return; }
    try {
      setSaving(true);
      const next = await save(shopId, label);
      setView(next);
      setValue(next?.label ?? label);
      setError('');
      toast.success(ADDRESS_COPY.saved(next?.hostname ?? addressPreview(label, view.baseDomain)));
    } catch (e) {
      setError(addressErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <CardSection title={ADDRESS_COPY.title} bodyClassName="space-y-3">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label htmlFor="shop-address-label" className="sr-only">
            {ADDRESS_COPY.title}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center rounded-[var(--radius-admin-el)] border border-admin-border bg-admin-surface focus-within:ring-2 focus-within:ring-[var(--color-admin-primary)]">
              <input
                id="shop-address-label"
                type="text"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                maxLength={80}
                value={value}
                onChange={(e) => { setValue(e.target.value); setError(''); }}
                aria-invalid={error ? 'true' : 'false'}
                aria-describedby="shop-address-help"
                className="min-w-0 flex-1 bg-transparent px-3 py-1.5 text-[13px] text-admin-text placeholder:text-admin-text-faint focus:outline-none"
                placeholder="dinbutik"
              />
              <span className="shrink-0 pr-3 text-[13px] text-admin-text-muted">.{view.baseDomain}</span>
            </div>
            <Button type="submit" variant="primary" disabled={saving || unchanged}>
              {saving ? ADDRESS_COPY.saving : ADDRESS_COPY.save}
            </Button>
          </div>
          {error && <p role="alert" className="mt-1 text-[12px] text-admin-critical-text">{error}</p>}
          <p id="shop-address-help" className="mt-1 text-[12px] text-admin-text-muted">
            {label ? <span className="font-mono text-admin-text">{addressPreview(label, view.baseDomain)}</span> : ADDRESS_COPY.none}
            {' · '}{ADDRESS_COPY.help}
          </p>
        </div>
        <p className="text-[12px] text-admin-text-muted">{ADDRESS_COPY.moved}</p>
        {view.previous?.length > 0 && (
          <ul className="space-y-1 text-[12px] text-admin-text-muted">
            {view.previous.map((entry) => (
              <li key={entry.hostname}>{ADDRESS_COPY.previous(entry.hostname, swedishDate(entry.redirectUntil))}</li>
            ))}
          </ul>
        )}
      </form>
    </CardSection>
  );
};

export default ShopAddressCard;
