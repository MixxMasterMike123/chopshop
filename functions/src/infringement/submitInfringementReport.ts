/**
 * submitInfringementReport — public callable behind the storefront page
 * "Rapportera intrång" (/:shopId/rapportera-intrang, linked from every shop's
 * footer). A rights holder (or someone acting for one) reports a product that
 * infringes a trademark/copyright. Notice & takedown (SnapWear A10): the report
 * lands in the PLATFORM's queue (PlatformReports → Anmälningar), never the
 * shop's — the seller is the party being reported.
 *
 * Mirrors leads/submitLead.ts in shape: no auth, trim + length caps, hidden
 * `website` honeypot, durable per-IP rate limit, write the doc FIRST (a report
 * must never be lost), then a best-effort platform email.
 *
 * Privacy: the reporter's IP is used only as the rate-limit key (the shared
 * durable limiter, TTL-expired counters) and is NOT stored on the report.
 *
 * Firestore rules: `infringementReports` is platform-read-only and never
 * client-creatable — this Admin SDK write is the only way in.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/database';
import { appUrls } from '../config/app-urls';
import { EmailOrchestrator } from '../email-orchestrator/core/EmailOrchestrator';
import { EMAIL_CONFIG } from '../email-orchestrator/core/config';
import { checkRateLimit, trustedClientIp } from '../protection/rate-limiting/durableRateLimit';

interface SubmitInfringementReportRequest {
  shopId?: string;
  productId?: string;
  productUrl?: string;
  reporterName?: string;
  reporterOrg?: string;
  reporterEmail?: string;
  rightType?: string;
  description?: string;
  attestation?: boolean;
  /** Honeypot — visually hidden in the form; any value = bot. */
  website?: string;
}

// Stored verbatim; PlatformReports labels them. Keep the three in sync.
export const RIGHT_TYPES = ['trademark', 'copyright', 'other'] as const;

const clip = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

// Doc-id shaped (shop ids and product ids are Firestore ids / slugs).
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Resolve the reported product to a doc IN THIS SHOP. A productId from the
 * form (?product=<id>) is trusted only if that product belongs to shopId; a
 * pasted storefront URL (/<shopId>/product/<name>_<SKU>) is resolved by SKU.
 * Anything else stays null — the operator can still act from the URL text.
 */
async function resolveProduct(
  shopId: string,
  productId: string,
  productUrl: string
): Promise<{ id: string; name: string } | null> {
  const nameOf = (d: FirebaseFirestore.DocumentData | undefined) =>
    typeof d?.name === 'string' ? d.name : (d?.name && typeof d.name === 'object' ? String(Object.values(d.name)[0] || '') : '');

  if (productId && ID_RE.test(productId)) {
    const snap = await db.collection('products').doc(productId).get();
    if (snap.exists && snap.data()?.shopId === shopId) {
      return { id: snap.id, name: nameOf(snap.data()) };
    }
  }
  const m = productUrl.match(/\/product\/([^/?#\s]+)/);
  const slug = m ? decodeURIComponent(m[1]) : '';
  const sku = slug.includes('_') ? slug.split('_').pop() : '';
  if (sku) {
    const q = await db.collection('products')
      .where('shopId', '==', shopId)
      .where('sku', '==', sku)
      .limit(1)
      .get();
    if (!q.empty) return { id: q.docs[0].id, name: nameOf(q.docs[0].data()) };
  }
  return null;
}

export const submitInfringementReport = onCall<SubmitInfringementReportRequest>(
  {
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 60,
    cors: appUrls.CORS_ORIGINS,
    // Platform notification email transport (best-effort after the write).
    secrets: ['RESEND_API_KEY'],
  },
  async (request) => {
    const data = request.data || {};

    // Honeypot filled → bot. Reject without writing anything.
    if (clip(data.website, 10)) {
      throw new HttpsError('invalid-argument', 'Invalid submission.');
    }

    // Durable per-IP throttle — every accepted report also sends a platform
    // email, so this bounds both collection spam and mail volume.
    if (!(await checkRateLimit('infringement', trustedClientIp(request.rawRequest as any), { limit: 5, windowSec: 3600 }))) {
      throw new HttpsError('resource-exhausted', 'För många försök — försök igen om en stund.');
    }

    const shopId = clip(data.shopId, 128);
    const productIdIn = clip(data.productId, 128);
    const productUrl = clip(data.productUrl, 1000);
    const reporterName = clip(data.reporterName, 200);
    const reporterOrg = clip(data.reporterOrg, 200);
    const reporterEmail = clip(data.reporterEmail, 320);
    const rightType = clip(data.rightType, 20);
    const description = clip(data.description, 5000);

    if (!shopId || !ID_RE.test(shopId)) {
      throw new HttpsError('invalid-argument', 'Unknown shop.');
    }
    if (!reporterName) {
      throw new HttpsError('invalid-argument', 'Name is required.');
    }
    if (!reporterEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reporterEmail)) {
      throw new HttpsError('invalid-argument', 'A valid email is required.');
    }
    if (!(RIGHT_TYPES as readonly string[]).includes(rightType)) {
      throw new HttpsError('invalid-argument', 'Unknown right type.');
    }
    if (description.length < 20) {
      throw new HttpsError('invalid-argument', 'Description must be at least 20 characters.');
    }
    if (data.attestation !== true) {
      throw new HttpsError('invalid-argument', 'The good-faith statement must be confirmed.');
    }
    if (!productIdIn && !productUrl) {
      throw new HttpsError('invalid-argument', 'Say which product the report is about.');
    }

    // The shop must exist — the report is filed against a real storefront.
    const shopSnap = await db.collection('shops').doc(shopId).get();
    if (!shopSnap.exists) {
      throw new HttpsError('invalid-argument', 'Unknown shop.');
    }
    const shopName = String(shopSnap.data()?.storeIdentity?.shopName || shopSnap.data()?.name || shopId);

    const product = await resolveProduct(shopId, productIdIn, productUrl);

    // 1. Persist the report FIRST. No IP, no user agent — only what the
    // reporter typed plus the resolved product.
    const reportRef = await db.collection('infringementReports').add({
      shopId,
      productId: product?.id || null,
      productName: product?.name || null,
      productUrl,
      reporterName,
      reporterOrg,
      reporterEmail,
      rightType,
      description,
      attestation: true,
      status: 'new',
      source: 'storefront',
      createdAt: FieldValue.serverTimestamp(),
    });
    logger.info(`submitInfringementReport: report ${reportRef.id} for shop ${shopId} product ${product?.id || '(unresolved)'}`);

    // 2. Best-effort platform notification — never fail the report over email.
    // No shopId on the context: the email is the PLATFORM's (neutral identity,
    // no reply-to the reported shop) and INFRINGEMENT_REPORT_ADMIN is also in
    // PLATFORM_ONLY_ADMIN_EMAILS as a second guard.
    try {
      const orchestrator = new EmailOrchestrator();
      const emailResult = await orchestrator.sendEmail({
        emailType: 'INFRINGEMENT_REPORT_ADMIN',
        customerInfo: {
          email: EMAIL_CONFIG.ADMIN_RECIPIENTS.join(', '),
          name: `${EMAIL_CONFIG.SMTP.FROM_NAME} Admin`,
        },
        language: 'sv-SE',
        additionalData: {
          report: {
            shopId, shopName,
            productId: product?.id || null,
            productName: product?.name || null,
            productUrl, reporterName, reporterOrg, reporterEmail, rightType, description,
          },
          reportId: reportRef.id,
          reportsUrl: `${appUrls.PLATFORM_CONSOLE}/reports`,
          shopUrl: `${appUrls.B2C_SHOP}/${shopId}`,
        },
        adminEmail: true,
      });
      if (!emailResult.success) {
        logger.error(`submitInfringementReport: admin email failed for report ${reportRef.id}:`, emailResult.error);
      }
    } catch (emailError) {
      logger.error(`submitInfringementReport: admin email threw for report ${reportRef.id}:`, emailError);
    }

    return { success: true, reportId: reportRef.id };
  }
);
