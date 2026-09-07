/**
 * AdminPlatformTerms (/admin/plattformsvillkor) — the seller's read-only copy of
 * the B2B agreement they accepted (Plattformsvillkor + the PUB-avtal annex),
 * plus the acceptance receipt (who, when, which version).
 *
 * Read-only by design: accepting happens ONCE in PlatformTermsGate, which is
 * the surface that records evidence. This page is the archive you go back to.
 */

import React, { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import DOMPurify from 'dompurify';
import AppLayout from '../../components/layout/AppLayout';
import { Page, Card, CardSection, StatusPill } from '../../components/admin/ui';
import { LEGAL_DOC_TYPO } from '../../components/admin/PlatformTermsGate';
import { db } from '../../firebase/config';
import { useShopId } from '../../contexts/ShopContext';
import { isUnresolvedShopId } from '../../config/tenancy';
import { renderPlatformTerms } from '../../utils/platformTermsRenderer';

const RENDERED = renderPlatformTerms();

// The draft banner ships inside the templates until a lawyer signs off; the
// note below is shown only while that banner is still there.
const IS_DRAFT =
  RENDERED.terms.html.includes('UTKAST') || RENDERED.dpa.html.includes('UTKAST');

const fmtDateTime = (iso) => {
  const s = String(iso || '').trim();
  if (!s) return '';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString('sv-SE');
};

const LegalHtml = ({ html }) => (
  <div
    className={`rounded-[var(--radius-admin)] border border-admin-border bg-admin-surface-2 p-4 ${LEGAL_DOC_TYPO}`}
    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }}
  />
);

const AdminPlatformTerms = () => {
  const shopId = useShopId();
  const [terms, setTerms] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (isUnresolvedShopId(shopId)) {
      setLoading(false);
      return undefined;
    }
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'shops', shopId));
        if (alive) setTerms(snap.exists() ? snap.data()?.platformTerms || null : null);
      } catch (e) {
        console.error('AdminPlatformTerms: could not read acceptance', e);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [shopId]);

  const acceptedAt = String(terms?.acceptedAt || '').trim();
  const isAccepted = Boolean(acceptedAt);
  const isCurrent = isAccepted && terms.version === RENDERED.version;

  return (
    <AppLayout>
      <Page
        title="Plattformsvillkor"
        subtitle={`Avtalet mellan dig som säljare och plattformen. Aktuell version ${RENDERED.version}.`}
      >
        <div className="space-y-4">
          <Card padded>
            {loading ? (
              <p className="text-[14px] text-admin-text-muted">Laddar…</p>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <StatusPill tone={isAccepted ? (isCurrent ? 'success' : 'warning') : 'warning'}>
                  {isAccepted ? 'Godkända' : 'Ej godkända'}
                </StatusPill>
                <span className="text-[14px] text-admin-text">
                  {isAccepted
                    ? `Godkända av ${terms.email || terms.uid || 'okänd användare'} ${fmtDateTime(acceptedAt)} · version ${terms.version || '–'}`
                    : 'Ej godkända'}
                </span>
              </div>
            )}
            {!loading && isAccepted && !isCurrent && (
              <p className="mt-2 text-[13px] text-admin-caution-text">
                Villkoren har uppdaterats sedan du senast godkände dem. Du behöver godkänna den nya
                versionen nästa gång du öppnar administrationen.
              </p>
            )}
            {IS_DRAFT && (
              <p className="mt-3 text-[13px] text-admin-text-muted">
                Villkoren är ett utkast och granskas av jurist.
              </p>
            )}
          </Card>

          <CardSection title={RENDERED.terms.title}>
            <LegalHtml html={RENDERED.terms.html} />
          </CardSection>

          <CardSection title={RENDERED.dpa.title}>
            <LegalHtml html={RENDERED.dpa.html} />
          </CardSection>
        </div>
      </Page>
    </AppLayout>
  );
};

export default AdminPlatformTerms;
