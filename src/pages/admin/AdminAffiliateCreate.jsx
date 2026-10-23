// "Bjud in affiliate" (CP13 A2, design §5.2 [DEV-2]): the shop adds an
// affiliate without an application; the person gets a mail with a link to set
// a password and log in to the affiliate portal. Nothing stores or mails a
// password. Ported from the manual create page: the address, social and
// marketing fields leave (the affiliate fills in their own profile in the
// portal), the code and the rates stay.
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import AppLayout from '../../components/layout/AppLayout';
import { useShopId } from '../../contexts/ShopContext';
import { CAPABILITIES, PATHS, inviteAffiliate } from './adminAffiliateData';
import { LANGUAGES } from './affiliateView';
import { Page, CardSection, RightRail, Button, Field, Input, Select } from '../../components/admin/ui';

const AdminAffiliateCreate = () => {
  const navigate = useNavigate();
  const shopId = useShopId();
  const [form, setForm] = useState({
    name: '',
    email: '',
    preferredLang: 'sv',
    code: '',
    commissionPercent: '15',
    discountPercent: '10',
  });
  const [loading, setLoading] = useState(false);

  const set = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const result = await inviteAffiliate(shopId, form);
      if (result.notice) toast(result.notice, { icon: '⚠️', duration: 15000 });
      else toast.success(CAPABILITIES.invites ? `Inbjudan skickad till ${form.email.trim()}.` : `Affiliate "${form.name.trim()}" har skapats.`);
      navigate(result.affiliateId ? PATHS.detail(result.affiliateId) : PATHS.list);
    } catch (error) {
      toast.error(error?.message || 'Kunde inte bjuda in affiliaten.');
      setLoading(false);
    }
  };

  return (
    <AppLayout>
      <Page
        title="Bjud in affiliate"
        subtitle={
          CAPABILITIES.invites
            ? 'Affiliaten får ett mejl med en länk för att välja lösenord och logga in i affiliateportalen.'
            : 'Affiliaten skapas som inaktiv och kan aktiveras senare.'
        }
        back={{ to: PATHS.list, label: 'Affiliates' }}
      >
        <form onSubmit={handleSubmit}>
          <RightRail
            main={
              <>
                <CardSection title="Uppgifter" bodyClassName="space-y-4">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <Field label="Namn" htmlFor="invite-name" required>
                      <Input id="invite-name" value={form.name} onChange={set('name')} required maxLength={100} placeholder="Förnamn Efternamn" />
                    </Field>
                    <Field label="E-post" htmlFor="invite-email" required help="Affiliatens inloggning. Kan inte vara en adress som redan används av ett annat konto.">
                      <Input id="invite-email" type="email" value={form.email} onChange={set('email')} required placeholder="namn@example.com" />
                    </Field>
                    <Field label="Språk" htmlFor="invite-lang" help="Språket i mejlen till affiliaten.">
                      <Select id="invite-lang" value={form.preferredLang} onChange={set('preferredLang')}>
                        {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                      </Select>
                    </Field>
                  </div>
                </CardSection>

                {/* Save bar */}
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="secondary" onClick={() => navigate(PATHS.list)} disabled={loading}>
                    Avbryt
                  </Button>
                  <Button type="submit" variant="primary" disabled={loading}>
                    {loading ? 'Bjuder in…' : 'Bjud in'}
                  </Button>
                </div>
              </>
            }
            rail={
              <CardSection title="Kod och villkor" bodyClassName="space-y-4">
                <Field label="Kod (valfri)" htmlFor="invite-code" help="Lämna tomt så skapas en kod av namnet. A–Z, 0–9 och bindestreck, 3–20 tecken.">
                  <Input
                    id="invite-code"
                    value={form.code}
                    onChange={(e) => setForm((prev) => ({ ...prev, code: e.target.value.toUpperCase() }))}
                    placeholder="ANNA10"
                    className="font-mono"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Provision (%)" htmlFor="invite-commission">
                    <Input id="invite-commission" type="number" min="0" max="100" step="1" value={form.commissionPercent} onChange={set('commissionPercent')} />
                  </Field>
                  <Field label="Kundrabatt (%)" htmlFor="invite-discount">
                    <Input id="invite-discount" type="number" min="0" max="100" step="1" value={form.discountPercent} onChange={set('discountPercent')} />
                  </Field>
                </div>
                <p className="text-[12px] text-admin-text-muted">
                  Provisionen räknas på ordervärdet exklusive moms och frakt och betalas till affiliaten; kundrabatten dras i kassan.
                </p>
              </CardSection>
            }
          />
        </form>
      </Page>
    </AppLayout>
  );
};

export default AdminAffiliateCreate;
