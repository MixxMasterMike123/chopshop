// Affiliateportalen — Profil (/affiliate/profile; CP13 design §6.1, §7.3):
// the affiliate's own fields (name, phone, address, links, language), saved
// with PATCH /v1/affiliate/profile; the answer is the new PortalMe. Name and
// address are the invoice's counterparty: a payout cannot be requested
// without them (the server's `profile_incomplete`). The code, the rates and
// the status are the shop's and are not here. "Byt lösenord" is the ordinary
// reset link of the admin host's sign-in.

import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { Button, CardSection, Field, Input, Page, Select } from '../../../components/admin/ui';
import { updatePortalProfile } from '../../../api/affiliate-portal.js';
import { profileFormOf, profilePatchOf } from '../../adapters/affiliatePortal.js';
import { usePortal } from './portalContext.js';

const LINKS = [
  ['website', 'Webbplats'],
  ['instagram', 'Instagram'],
  ['youtube', 'YouTube'],
  ['facebook', 'Facebook'],
  ['tiktok', 'TikTok'],
];

export default function AffiliateProfile() {
  const { affiliate, setAffiliate } = usePortal();
  const [form, setForm] = useState(() => profileFormOf(affiliate));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }));
  const setLink = (key) => (e) => setForm((prev) => ({ ...prev, socials: { ...prev.socials, [key]: e.target.value } }));

  const nameMissing = form.name.trim() === '';
  const countryBad = !/^[A-Za-z]{2}$/.test(form.country.trim());
  const addressMissing = !form.addressLine1.trim() || !form.postalCode.trim() || !form.city.trim();

  const save = async (e) => {
    e.preventDefault();
    if (nameMissing || countryBad || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await updatePortalProfile(profilePatchOf(form));
      setAffiliate(next);
      setForm(profileFormOf(next));
      toast.success('Profilen är sparad');
    } catch (err) {
      if (err?.code !== 'unauthenticated') {
        setError(
          err?.status === 400
            ? 'Något fält kunde inte sparas. Kontrollera längden på texterna och att länkarna är hela adresser.'
            : 'Profilen kunde inte sparas. Försök igen.',
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="Profil" subtitle={affiliate.email}>
      <form onSubmit={save} className="space-y-4" noValidate>
        <CardSection title="Uppgifter">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Namn" htmlFor="pf-name" required error={nameMissing ? 'Ange ditt namn.' : null}>
              <Input id="pf-name" value={form.name} onChange={set('name')} maxLength={100} autoComplete="name" />
            </Field>
            <Field label="Telefon" htmlFor="pf-phone">
              <Input id="pf-phone" value={form.phone} onChange={set('phone')} maxLength={40} autoComplete="tel" />
            </Field>
            <Field label="Språk i mejl" htmlFor="pf-lang">
              <Select id="pf-lang" value={form.preferredLang} onChange={set('preferredLang')}>
                <option value="sv">Svenska</option>
                <option value="en">English</option>
              </Select>
            </Field>
          </div>
        </CardSection>

        <CardSection title="Adress">
          {addressMissing && (
            <p className="mb-3 text-admin-text-muted">Adressen behövs innan du kan begära utbetalning (den står på fakturan).</p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Gatuadress" htmlFor="pf-line1" className="sm:col-span-2">
              <Input id="pf-line1" value={form.addressLine1} onChange={set('addressLine1')} maxLength={200} autoComplete="address-line1" />
            </Field>
            <Field label="Adressrad 2" htmlFor="pf-line2" className="sm:col-span-2">
              <Input id="pf-line2" value={form.addressLine2} onChange={set('addressLine2')} maxLength={200} autoComplete="address-line2" />
            </Field>
            <Field label="Postnummer" htmlFor="pf-postal">
              <Input id="pf-postal" value={form.postalCode} onChange={set('postalCode')} maxLength={20} autoComplete="postal-code" />
            </Field>
            <Field label="Ort" htmlFor="pf-city">
              <Input id="pf-city" value={form.city} onChange={set('city')} maxLength={100} autoComplete="address-level2" />
            </Field>
            <Field label="Land (landskod)" htmlFor="pf-country" help="Två bokstäver, t.ex. SE." error={countryBad ? 'Ange landskoden med två bokstäver, t.ex. SE.' : null}>
              <Input id="pf-country" value={form.country} onChange={set('country')} maxLength={2} autoComplete="country" className="uppercase" />
            </Field>
          </div>
        </CardSection>

        <CardSection title="Kanaler">
          <div className="grid gap-4 sm:grid-cols-2">
            {LINKS.map(([key, label]) => (
              <Field key={key} label={label} htmlFor={`pf-${key}`}>
                <Input id={`pf-${key}`} type="url" inputMode="url" value={form.socials[key]} onChange={setLink(key)} maxLength={300} placeholder="https://" />
              </Field>
            ))}
          </div>
        </CardSection>

        {error && (
          <p className="text-admin-critical-text" role="alert">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button type="submit" variant="primary" disabled={busy || nameMissing || countryBad}>
            {busy ? 'Sparar…' : 'Spara'}
          </Button>
          <a href="/forgot-password" className="text-admin-text-muted underline underline-offset-2 hover:text-admin-text">
            Byt lösenord
          </a>
        </div>
      </form>
    </Page>
  );
}
