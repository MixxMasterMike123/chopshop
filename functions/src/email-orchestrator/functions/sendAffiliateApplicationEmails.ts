// sendAffiliateApplicationEmails.ts - Send both affiliate and admin emails when application is submitted
//
// P1-01 HARDENING (2026-08-15 audit): this endpoint used to accept a full
// caller-supplied applicantInfo payload (recipient + content) — an anonymous
// relay through the platform's sender identity. It now accepts ONLY an
// applicationId: recipient, content and tenant are loaded server-side from the
// affiliateApplications doc the storefront just created (that create is itself
// rules-gated). A per-doc sent-stamp makes the send single-shot, so the
// endpoint cannot be replayed to spam the applicant.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { appUrls } from '../../config/app-urls';
import { EmailOrchestrator } from '../core/EmailOrchestrator';
import { EMAIL_CONFIG } from '../core/config';
import { checkRateLimit, trustedClientIp } from '../../protection/rate-limiting/durableRateLimit';

const db = getFirestore('b8s-reseller-db');

interface AffiliateApplicationEmailsRequest {
  applicationId: string;
  language?: string;
}

export const sendAffiliateApplicationEmails = onCall<AffiliateApplicationEmailsRequest>(
  {
    region: 'us-central1',
    secrets: ['RESEND_API_KEY'],
    memory: '256MiB',
    timeoutSeconds: 60,
    cors: appUrls.CORS_ORIGINS
  },
  async (request) => {
    const applicationId = (request.data?.applicationId || '').trim();
    if (!applicationId) {
      throw new HttpsError('invalid-argument', 'Application ID is required');
    }

    // P1-02: per-IP throttle on top of the per-application single-shot claim —
    // bounds how fast a bot farm of fresh application docs can pump mail.
    if (!(await checkRateLimit('affAppMail', trustedClientIp(request.rawRequest as any), { limit: 10, windowSec: 3600 }))) {
      throw new HttpsError('resource-exhausted', 'För många försök — försök igen om en stund.');
    }

    // Load the application — the SERVER-side source of recipient + content.
    const appRef = db.collection('affiliateApplications').doc(applicationId);
    const appSnap = await appRef.get();
    if (!appSnap.exists) {
      throw new HttpsError('not-found', 'Application not found');
    }
    const application = appSnap.data() as any;

    if (!application.email || !application.name) {
      throw new HttpsError('failed-precondition', 'Application is missing name or email');
    }
    if (application.status !== 'pending') {
      throw new HttpsError('failed-precondition', 'Application is not pending');
    }

    // Single-shot: claim the send in a TRANSACTION so a replayed/concurrent
    // call cannot spam the applicant — exactly one caller wins the stamp.
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(appRef);
      if ((snap.data() as any)?.confirmationEmailsSentAt) {
        throw new HttpsError('already-exists', 'Confirmation emails were already sent for this application');
      }
      tx.update(appRef, { confirmationEmailsSentAt: FieldValue.serverTimestamp() });
    });

    const applicantInfo = {
      name: application.name,
      email: application.email,
      phone: application.phone || '',
      address: application.address || '',
      city: application.city || '',
      country: application.country || '',
      promotionMethod: application.promotionMethod || '',
      message: application.message || '',
      socials: application.socials || {}
    };
    const language = request.data?.language || application.preferredLang || 'sv-SE';

    const orchestrator = new EmailOrchestrator();

    // 1. Confirmation email to the applicant (recipient from the DOC).
    const applicantResult = await orchestrator.sendEmail({
      emailType: 'AFFILIATE_APPLICATION_RECEIVED',
      customerInfo: {
        email: application.email,
        name: application.name
      },
      language,
      additionalData: {
        applicantInfo,
        applicationId
      },
      shopId: application.shopId,
      adminEmail: false
    });

    if (!applicantResult.success) {
      console.error('❌ Failed to send applicant confirmation email:', applicantResult.error);
      // Release the single-shot claim so a retry can succeed — otherwise a
      // transient send failure permanently loses the confirmation email.
      try {
        await appRef.update({ confirmationEmailsSentAt: FieldValue.delete() });
      } catch (releaseError) {
        console.error('❌ Could not release the email-send claim:', releaseError);
      }
      throw new HttpsError('internal', 'Failed to send confirmation email');
    }

    // 2. Notification email to admin
    const adminResult = await orchestrator.sendEmail({
      emailType: 'AFFILIATE_APPLICATION_NOTIFICATION_ADMIN',
      customerInfo: {
        email: EMAIL_CONFIG.ADMIN_RECIPIENTS.join(', '), // Admin email(s)
        name: `${EMAIL_CONFIG.SMTP.FROM_NAME} Admin`
      },
      language: 'sv-SE', // Admin emails always in Swedish
      additionalData: {
        applicantInfo,
        applicationId,
        adminPortalUrl: appUrls.B2B_PORTAL
      },
      shopId: application.shopId,
      adminEmail: true
    });

    if (!adminResult.success) {
      console.error('❌ Failed to send admin notification email:', adminResult.error);
      // Don't fail the entire operation if admin email fails
    }

    return {
      success: true,
      applicantEmailSent: applicantResult.success,
      adminEmailSent: adminResult.success
    };
  }
);
