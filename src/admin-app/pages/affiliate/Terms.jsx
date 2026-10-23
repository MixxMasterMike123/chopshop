// Affiliateportalen — Villkor (/affiliate/terms; CP13 design §8): the shop's
// current affiliate terms at the affiliate's own rates (GET
// /v1/affiliate/terms) and, while they are not accepted, the acceptance
// (POST /v1/affiliate/terms/accept with the version shown). The shell sends
// every page here while PortalMe's `terms.outdated` holds. A newer version
// published meanwhile is `terms_changed`: the page reads the terms again.

import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Button, CardSection, Page, StatusPill } from '../../../components/admin/ui';
import { acceptPortalTerms, getPortalTerms } from '../../../api/affiliate-portal.js';
import { formatDate } from '../../adapters/affiliatePortal.js';
import { usePortal } from './portalContext.js';

export default function AffiliateTerms() {
  const { affiliate, reload } = usePortal();
  const navigate = useNavigate();
  const [terms, setTerms] = useState(null);
  const [failed, setFailed] = useState(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setTerms(await getPortalTerms());
    } catch (err) {
      if (err?.code !== 'unauthenticated') setFailed(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const accept = async () => {
    if (!terms || !checked || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await acceptPortalTerms(terms.version);
      await reload();
      toast.success('Villkoren är godkända');
      navigate('/', { replace: true });
    } catch (err) {
      if (err?.code === 'terms_changed') {
        setChecked(false);
        setNotice('Villkoren har uppdaterats medan du läste. Läs den nya versionen och godkänn igen.');
        await load();
      } else if (err?.code !== 'unauthenticated') {
        setNotice('Godkännandet kunde inte sparas. Försök igen.');
      }
    } finally {
      setBusy(false);
    }
  };

  const outdated = affiliate.terms?.outdated === true;
  const paragraphs = typeof terms?.text === 'string' ? terms.text.split(/\n{2,}/).filter(Boolean) : [];

  return (
    <Page
      title="Villkor"
      titleAdornment={
        terms ? (
          terms.accepted ? <StatusPill tone="success">Godkända</StatusPill> : <StatusPill tone="attention">Inte godkända</StatusPill>
        ) : null
      }
      subtitle={terms ? `Version ${terms.version}` : null}
    >
      <div className="space-y-4">
        {outdated && (
          <div className="rounded-[var(--radius-admin)] border border-admin-border bg-admin-caution-bg px-4 py-3 text-admin-caution-text" role="status">
            {affiliate.terms?.acceptedVersion
              ? 'Villkoren har ändrats. Läs och godkänn den nya versionen för att fortsätta.'
              : 'Läs och godkänn villkoren för att komma åt portalen.'}
          </div>
        )}
        <CardSection>
          {failed ? (
            <div>
              <p className="text-admin-critical-text">Villkoren kunde inte hämtas.</p>
              <Button className="mt-3" onClick={load}>
                Försök igen
              </Button>
            </div>
          ) : !terms ? (
            <p className="text-admin-text-muted">Laddar…</p>
          ) : (
            <article className="max-w-prose space-y-3 leading-relaxed">
              {paragraphs.map((text, i) =>
                i === 0 ? (
                  <h2 key={i} className="text-[15px] font-semibold">
                    {text}
                  </h2>
                ) : (
                  <p key={i}>{text}</p>
                ),
              )}
            </article>
          )}
        </CardSection>

        {terms && !terms.accepted && (
          <CardSection title="Godkänn">
            <label htmlFor="terms-accept" className="flex items-start gap-2.5">
              <input
                id="terms-accept"
                type="checkbox"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-admin-primary)]"
              />
              <span>Jag har läst och godkänner affiliatevillkoren, version {terms.version}.</span>
            </label>
            {notice && (
              <p className="mt-3 text-admin-critical-text" role="alert">
                {notice}
              </p>
            )}
            <Button className="mt-4" variant="primary" disabled={!checked || busy} onClick={accept}>
              {busy ? 'Sparar…' : 'Godkänn villkoren'}
            </Button>
          </CardSection>
        )}
        {terms?.accepted && affiliate.terms?.acceptedAt && (
          <p className="text-[12px] text-admin-text-muted">Du godkände den här versionen {formatDate(affiliate.terms.acceptedAt)}.</p>
        )}
      </div>
    </Page>
  );
}
