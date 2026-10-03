/**
 * PlatformTermsGate — the seller must accept the platform's B2B agreement
 * (Plattformsvillkor + the personuppgiftsbiträdesavtal annex) before using the
 * admin. Wraps AppLayout's content area: while acceptance is missing the page
 * body is REPLACED by the terms + a single "godkänn" action, so there is no way
 * to work in the admin around it.
 *
 * Who is gated: only a SHOP ADMIN acting for their own shop.
 *   - platform operators (isPlatform) are never gated — they are the platform,
 *     not the seller;
 *   - an operator IMPERSONATING a shop is never gated — the platform must never
 *     sign the seller's agreement on the seller's behalf (the acceptance record
 *     is legal evidence of who agreed);
 *   - an unresolved shopId (operator still picking a shop) has no shop to
 *     accept for.
 *
 * Fail-open on load/read: acceptance is re-checked on every mount, so a slow or
 * failed read costs at most one session — far better than locking a paying
 * seller out of their own admin over a transient Firestore hiccup. The hard
 * consequences (checkout) hang off other gates, not this one.
 *
 * The terms, the shop's acceptance and the act of accepting come from
 * ./platformTermsData (the Cloudflare admin build swaps that module: the
 * API's legal routes).
 */

import React, { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import { useAuth } from '../../contexts/AuthContext';
import { getImpersonation } from '../../config/impersonation';
import { isUnresolvedShopId } from '../../config/tenancy';
import { acceptPlatformTerms, initialPlatformTerms, loadPlatformTerms } from './platformTermsData';
import { Card, CardSection, Button } from './ui';

const fmtDate = (iso) => {
  const s = String(iso || '').trim();
  if (!s) return '';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('sv-SE');
};

// Document typography. No @tailwindcss/typography in this build (Tailwind v4,
// no `prose` plugin registered), so the headings/lists/tables the markdown
// renderer emits get their rhythm from explicit child selectors here.
export const LEGAL_DOC_TYPO =
  'text-[14px] leading-6 text-admin-text ' +
  '[&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:text-[15px] [&_h2]:font-semibold [&_h2]:text-admin-text ' +
  '[&_h3]:mt-4 [&_h3]:mb-1.5 [&_h3]:text-[14px] [&_h3]:font-semibold ' +
  '[&>*:first-child]:mt-0 ' +
  '[&_p]:my-3 [&_ul]:my-3 [&_ol]:my-3 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 ' +
  '[&_li]:my-1 [&_strong]:font-semibold ' +
  '[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-admin-caution-dot ' +
  '[&_blockquote]:bg-admin-caution-bg [&_blockquote]:px-3 [&_blockquote]:py-2 ' +
  '[&_blockquote]:text-admin-caution-text ' +
  '[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[13px] ' +
  '[&_th]:border [&_th]:border-admin-border [&_th]:bg-admin-surface-2 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left ' +
  '[&_td]:border [&_td]:border-admin-border [&_td]:px-2 [&_td]:py-1 [&_td]:align-top ' +
  '[&_a]:underline';

// The legal text is markdown we author and the renderer already sanitizes;
// sanitizing again here is belt-and-braces at the injection site.
const LegalHtml = ({ html }) => (
  <div
    className={
      'max-h-[60vh] overflow-y-auto rounded-[var(--radius-admin)] border border-admin-border ' +
      `bg-admin-surface-2 p-4 ${LEGAL_DOC_TYPO}`
    }
    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }}
  />
);

const PlatformTermsGate = ({ shopId, children }) => {
  const { currentUser, userProfile, isPlatform } = useAuth();
  // { rendered, accepted, acceptance } of ./platformTermsData; null = unread.
  const [shopDoc, setShopDoc] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Only a shop admin acting for their own resolved shop can be gated at all.
  const eligible =
    userProfile?.role === 'admin' &&
    !isPlatform &&
    !getImpersonation() &&
    !isUnresolvedShopId(shopId);

  useEffect(() => {
    if (!eligible) return undefined;
    let alive = true;
    setLoaded(false);
    (async () => {
      try {
        const state = await loadPlatformTerms(shopId);
        if (!alive) return;
        setShopDoc(state);
      } catch (e) {
        if (!alive) return;
        // Fail OPEN: render the admin. Acceptance is enforced again next load.
        console.warn('PlatformTermsGate: could not read the terms state, letting through', e);
        setShopDoc(null);
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [eligible, shopId]);

  const mustAccept =
    eligible && loaded && shopDoc !== null && !accepted && !shopDoc.accepted;

  if (!mustAccept) return children;

  const RENDERED = shopDoc.rendered || initialPlatformTerms();
  const prior = shopDoc.acceptance;
  const staleVersion =
    prior && String(prior.acceptedAt || '').trim() && prior.version !== RENDERED.version;

  const accept = async () => {
    setError('');
    setSaving(true);
    try {
      await acceptPlatformTerms({ shopId, user: currentUser, version: RENDERED.version });
      setAccepted(true);
    } catch (e) {
      console.error('PlatformTermsGate: acceptance failed', e);
      setError(e?.message || 'Kunde inte spara godkännandet. Försök igen.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <header className="mb-4">
        <h1 className="text-[20px] font-semibold leading-7 text-admin-text">Plattformsvillkor</h1>
        <p className="mt-1 max-w-3xl text-[13px] text-admin-text-muted">
          Innan du använder administrationen behöver du som butiksägare godkänna plattformsvillkoren
          och personuppgiftsbiträdesavtalet. Version {RENDERED.version}.
        </p>
        {staleVersion && (
          <p className="mt-2 text-[13px] text-admin-caution-text">
            Villkoren har uppdaterats sedan du senast godkände dem ({fmtDate(prior.acceptedAt)} v
            {prior.version}).
          </p>
        )}
      </header>

      <div className="space-y-4">
        <CardSection title={RENDERED.terms.title}>
          <LegalHtml html={RENDERED.terms.html} />
        </CardSection>

        <CardSection title={RENDERED.dpa.title}>
          <LegalHtml html={RENDERED.dpa.html} />
        </CardSection>

        <Card padded>
          <label className="flex items-start gap-3 text-[14px] leading-6 text-admin-text">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="mt-1 h-4 w-4 shrink-0 rounded border-admin-border"
            />
            <span>
              Jag har läst och godkänner plattformsvillkoren inklusive
              personuppgiftsbiträdesavtalet, och intygar att jag är behörig att företräda säljaren.
            </span>
          </label>
          <div className="mt-4 flex items-center gap-3">
            <Button variant="primary" size="lg" disabled={!checked || saving} onClick={accept}>
              {saving ? 'Sparar…' : 'Godkänn och fortsätt'}
            </Button>
            {error && <span className="text-[13px] text-admin-critical-text">{error}</span>}
          </div>
        </Card>
      </div>
    </div>
  );
};

export default PlatformTermsGate;
