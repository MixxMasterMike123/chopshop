/**
 * submitLead — public callable behind the landing-page "Vill du ha en egen
 * butik?" form. Visitors are prospective MERCHANTS, so leads are PLATFORM-level
 * (no shopId stamped). Writes a `leads` doc first (the lead must never be lost),
 * then fires a best-effort admin notification email — a failing email transport
 * must NOT fail the submission.
 *
 * Abuse guard is deliberately cheap: trim + length caps + a hidden `website`
 * honeypot field (humans never see it; bots fill it). No rate-limit infra.
 * Firestore rules: `leads` is platform-read-only and never client-writable —
 * this Admin SDK write is the only way in.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/database';
import { appUrls } from '../config/app-urls';
import { EmailOrchestrator } from '../email-orchestrator/core/EmailOrchestrator';
import { EMAIL_CONFIG } from '../email-orchestrator/core/config';
import { checkRateLimit, trustedClientIp } from '../protection/rate-limiting/durableRateLimit';

interface SubmitLeadRequest {
  name?: string;
  company?: string;
  email?: string;
  message?: string;
  /** Honeypot — visually hidden in the form; any value = bot. */
  website?: string;
}

const clip = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

export const submitLead = onCall<SubmitLeadRequest>(
  {
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 60,
    cors: appUrls.CORS_ORIGINS,
    // Admin notification email transport (best-effort after the write).
    secrets: ['RESEND_API_KEY'],
  },
  async (request) => {
    const data = request.data || {};

    // Honeypot filled → bot. Reject without writing anything.
    if (clip(data.website, 10)) {
      throw new HttpsError('invalid-argument', 'Invalid submission.');
    }

    // P1-02: durable per-IP throttle (each accepted lead also fires an admin
    // email — this bounds both the collection spam and the mail volume).
    if (!(await checkRateLimit('lead', trustedClientIp(request.rawRequest as any), { limit: 5, windowSec: 3600 }))) {
      throw new HttpsError('resource-exhausted', 'För många försök — försök igen om en stund.');
    }

    const name = clip(data.name, 500);
    const company = clip(data.company, 500);
    const email = clip(data.email, 500);
    const message = clip(data.message, 2000);

    if (!name) {
      throw new HttpsError('invalid-argument', 'Name is required.');
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new HttpsError('invalid-argument', 'A valid email is required.');
    }

    // 1. Persist the lead FIRST (platform-level — no shopId: the sender is a
    // prospective merchant, not a tenant's customer).
    const leadRef = await db.collection('leads').add({
      name,
      company,
      email,
      message,
      status: 'new',
      source: 'landing',
      createdAt: FieldValue.serverTimestamp(),
    });
    logger.info(`submitLead: lead ${leadRef.id} written for ${email}`);

    // 2. Best-effort admin notification — never fail the submission over email.
    try {
      const orchestrator = new EmailOrchestrator();
      const emailResult = await orchestrator.sendEmail({
        emailType: 'LEAD_NOTIFICATION_ADMIN',
        customerInfo: {
          email: EMAIL_CONFIG.ADMIN_RECIPIENTS.join(', '),
          name: `${EMAIL_CONFIG.SMTP.FROM_NAME} Admin`,
        },
        language: 'sv-SE', // Admin emails always in Swedish
        additionalData: {
          lead: { name, company, email, message },
          leadId: leadRef.id,
        },
        adminEmail: true,
      });
      if (!emailResult.success) {
        logger.error(`submitLead: admin email failed for lead ${leadRef.id}:`, emailResult.error);
      }
    } catch (emailError) {
      logger.error(`submitLead: admin email threw for lead ${leadRef.id}:`, emailError);
    }

    return { success: true, leadId: leadRef.id };
  }
);
