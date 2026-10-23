// One affiliate application (CP13 A2, design §5.2 / §7.2): what the person
// sent, then the decision — approve with a code and the rates ("Godkänn och
// bjud in": the approval invites them to the affiliate portal) or deny with a
// reason (mailed to them). Nothing is deleted. New page; its tokens follow the
// sibling detail pages (RightRail, CardSection, Field).
import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import AppLayout from '../../components/layout/AppLayout';
import { useShopId } from '../../contexts/ShopContext';
import { PATHS, approveApplication, denyApplication, loadApplication } from './adminAffiliateData';
import { APPLICATION_STATUS, SOCIALS, formatDay, languageLabel, promotionLabel } from './affiliateView';
import { Page, Card, CardSection, RightRail, Button, StatusPill, Field, Input, Textarea } from '../../components/admin/ui';

const Row = ({ label, children }) => (
  <div className="flex items-baseline justify-between gap-4 py-1 text-[13px]">
    <span className="text-admin-text-muted">{label}</span>
    <span className="min-w-0 break-words text-right text-admin-text">{children}</span>
  </div>
);

/** A link the applicant typed: an address only when it is a web address, else plain text. */
const SocialValue = ({ value }) =>
  /^https?:\/\//i.test(value) ? (
    <a href={value} target="_blank" rel="noopener noreferrer nofollow" className="text-admin-text underline underline-offset-2 hover:text-admin-text-muted">
      {value.replace(/^https?:\/\//i, '')}
    </a>
  ) : (
    <span>{value}</span>
  );

const AdminAffiliateApplication = () => {
  const { id } = useParams();
  const shopId = useShopId();
  const navigate = useNavigate();
  const [application, setApplication] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(null); // 'approve' | 'deny'
  const [terms, setTerms] = useState({ code: '', discountPercent: '10', commissionPercent: '15' });
  const [reason, setReason] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    loadApplication(shopId, id)
      .then((row) => { if (!cancelled) setApplication(row); })
      .catch((error) => { if (!cancelled) setLoadError(error?.message || 'Kunde inte hämta ansökan.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [shopId, id]);

  const handleApprove = async (e) => {
    e.preventDefault();
    setBusy('approve');
    try {
      const result = await approveApplication(shopId, application, terms);
      if (result.notice) toast(result.notice, { icon: '⚠️', duration: 15000 });
      else toast.success(`${application.name} är godkänd och inbjuden till affiliateportalen.`);
      navigate(result.affiliateId ? PATHS.detail(result.affiliateId) : PATHS.list);
    } catch (error) {
      toast.error(error?.message || 'Kunde inte godkänna ansökan.');
      setBusy(null);
    }
  };

  const handleDeny = async (e) => {
    e.preventDefault();
    if (!window.confirm(`Avslå ansökan från ${application.name}? Orsaken mejlas till den sökande.`)) return;
    setBusy('deny');
    try {
      const updated = await denyApplication(shopId, application.applicationId, reason);
      toast.success('Ansökan är avslagen.');
      if (updated?.applicationId && updated.status === 'denied' && updated.name) setApplication(updated);
      else navigate(PATHS.list);
    } catch (error) {
      toast.error(error?.message || 'Kunde inte avslå ansökan.');
    } finally {
      setBusy(null);
    }
  };

  const back = { to: PATHS.list, label: 'Affiliates' };

  if (loading || loadError || !application) {
    return (
      <AppLayout>
        <Page title="Ansökan" back={back}>
          <Card className="px-6 py-12 text-center">
            {loading ? (
              <>
                <div className="inline-block h-7 w-7 animate-spin rounded-full border-2 border-solid border-admin-text-muted border-r-transparent" />
                <p className="mt-3 text-[13px] text-admin-text-muted">Laddar…</p>
              </>
            ) : (
              <p className="text-[13px] text-admin-text-muted">{loadError || 'Ansökan hittades inte.'}</p>
            )}
          </Card>
        </Page>
      </AppLayout>
    );
  }

  const status = APPLICATION_STATUS[application.status] ?? APPLICATION_STATUS.pending;
  const pending = application.status === 'pending';
  const socials = SOCIALS.filter(({ key }) => application.socials?.[key]);

  return (
    <AppLayout>
      <Page
        title={`Ansökan från ${application.name}`}
        titleAdornment={<StatusPill tone={status.tone}>{status.label}</StatusPill>}
        back={back}
      >
        <RightRail
          main={
            <>
              <CardSection title="Ansökan" bodyClassName="space-y-0.5">
                <Row label="Namn">{application.name}</Row>
                <Row label="E-post">
                  <a href={`mailto:${application.email}`} className="text-admin-text underline underline-offset-2 hover:text-admin-text-muted">{application.email}</a>
                </Row>
                <Row label="Telefon">{application.phone || '–'}</Row>
                <Row label="Kanal">{promotionLabel(application.promotionMethod)}</Row>
                <Row label="Språk">{languageLabel(application.preferredLang)}</Row>
                <Row label="Inkom">{formatDay(application.createdAt)}</Row>
                {application.termsVersion && (
                  <Row label="Villkor">
                    Version {application.termsVersion}, godkända {formatDay(application.termsAcceptedAt)}
                  </Row>
                )}
              </CardSection>

              <CardSection title="Länkar" bodyClassName="space-y-0.5">
                {socials.length === 0 ? (
                  <p className="text-[13px] text-admin-text-muted">Inga länkar angivna.</p>
                ) : (
                  socials.map(({ key, label }) => (
                    <Row key={key} label={label}><SocialValue value={application.socials[key]} /></Row>
                  ))
                )}
              </CardSection>

              <CardSection title="Meddelande">
                <p className="whitespace-pre-wrap text-[13px] text-admin-text">{application.message || '–'}</p>
              </CardSection>
            </>
          }
          rail={
            pending ? (
              <>
                <CardSection title="Godkänn">
                  <form onSubmit={handleApprove} className="space-y-4">
                    <Field
                      label="Kod (valfri)"
                      htmlFor="approve-code"
                      help="Lämna tomt så skapas en kod av namnet. A–Z, 0–9 och bindestreck, 3–20 tecken."
                    >
                      <Input
                        id="approve-code"
                        value={terms.code}
                        onChange={(e) => setTerms((t) => ({ ...t, code: e.target.value.toUpperCase() }))}
                        placeholder="ANNA10"
                        className="font-mono"
                      />
                    </Field>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Kundrabatt (%)" htmlFor="approve-discount">
                        <Input
                          id="approve-discount"
                          type="number"
                          min="0"
                          max="100"
                          step="1"
                          value={terms.discountPercent}
                          onChange={(e) => setTerms((t) => ({ ...t, discountPercent: e.target.value }))}
                        />
                      </Field>
                      <Field label="Provision (%)" htmlFor="approve-commission">
                        <Input
                          id="approve-commission"
                          type="number"
                          min="0"
                          max="100"
                          step="1"
                          value={terms.commissionPercent}
                          onChange={(e) => setTerms((t) => ({ ...t, commissionPercent: e.target.value }))}
                        />
                      </Field>
                    </div>
                    <p className="text-[12px] text-admin-text-muted">
                      Provisionen räknas på ordervärdet exklusive moms och frakt. Affiliaten får ett mejl med en länk för att välja lösenord.
                    </p>
                    <Button type="submit" variant="primary" className="w-full" disabled={busy !== null}>
                      {busy === 'approve' ? 'Godkänner…' : 'Godkänn och bjud in'}
                    </Button>
                  </form>
                </CardSection>

                <CardSection title="Avslå">
                  <form onSubmit={handleDeny} className="space-y-4">
                    <Field label="Orsak" htmlFor="deny-reason" required help="Mejlas till den sökande.">
                      <Textarea
                        id="deny-reason"
                        rows={3}
                        maxLength={500}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                      />
                    </Field>
                    <Button type="submit" variant="destructive" className="w-full" disabled={busy !== null || reason.trim() === ''}>
                      {busy === 'deny' ? 'Avslår…' : 'Avslå'}
                    </Button>
                  </form>
                </CardSection>
              </>
            ) : (
              <CardSection title="Beslut" bodyClassName="space-y-0.5">
                <Row label="Status"><StatusPill tone={status.tone}>{status.label}</StatusPill></Row>
                <Row label="Beslutad">{formatDay(application.decidedAt)}</Row>
                {application.decisionReason && <Row label="Orsak">{application.decisionReason}</Row>}
                {application.affiliateId && (
                  <div className="pt-3">
                    <Button as={Link} to={PATHS.detail(application.affiliateId)} variant="secondary" className="w-full">
                      Visa affiliaten
                    </Button>
                  </div>
                )}
              </CardSection>
            )
          }
        />
      </Page>
    </AppLayout>
  );
};

export default AdminAffiliateApplication;
