// sendAffiliateWelcomeEmail - New Affiliate Onboarding Function
// Replaces: sendAffiliateWelcomeEmailV3, approveAffiliateV3 email functionality
// Used for: New affiliate approval and welcome (different from login credentials)

import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { appUrls } from '../../config/app-urls';
import { db } from '../../config/database';
import { EmailOrchestrator } from '../core/EmailOrchestrator';
import { requireAdminOfShop } from './authGuard';

interface AffiliateWelcomeRequest {
  affiliateInfo: {
    name: string;
    email: string;
    affiliateCode: string;
    commissionRate?: number;
    checkoutDiscount?: number;
    preferredLang?: string;
  };
  credentials: {
    email: string;
    temporaryPassword?: string;
  };
  wasExistingAuthUser?: boolean;
  language?: string;
}

export const sendAffiliateWelcomeEmail = onCall<AffiliateWelcomeRequest>(
  {
    region: 'us-central1',
    secrets: ['RESEND_API_KEY'],
    memory: '256MiB',
    timeoutSeconds: 60,
    cors: appUrls.CORS_ORIGINS
  },
  async (request) => {
    try {
      const affiliateCode = String(request.data.affiliateInfo?.affiliateCode || '').trim();
      if (!affiliateCode) throw new HttpsError('invalid-argument', 'Affiliate code is required');
      const affiliateQuery = await db.collection('affiliates')
        .where('affiliateCode', '==', affiliateCode)
        .limit(2)
        .get();
      if (affiliateQuery.empty) throw new HttpsError('not-found', 'Affiliate not found');
      if (affiliateQuery.size !== 1) throw new HttpsError('failed-precondition', 'Affiliate code is not unique');
      const affiliate = affiliateQuery.docs[0].data();
      await requireAdminOfShop(affiliate.shopId, request.auth?.uid);
      const affiliateEmail = String(affiliate.email || '').trim();
      const affiliateName = String(affiliate.name || affiliate.contactPerson || '').trim();
      if (!affiliateEmail || !affiliateName) {
        throw new HttpsError('failed-precondition', 'Affiliate contact details are incomplete');
      }

      console.log('🎉 sendAffiliateWelcomeEmail: Starting affiliate welcome onboarding');
      console.log('🎉 Request data:', {
        affiliateName,
        affiliateCode,
        wasExistingAuthUser: request.data.wasExistingAuthUser,
        language: request.data.language
      });

      // Validate required data
      // Initialize EmailOrchestrator
      const orchestrator = new EmailOrchestrator();

      // Prepare affiliate welcome data
      const language = affiliate.preferredLang || request.data.language || 'sv-SE';
      const wasExistingAuthUser = request.data.wasExistingAuthUser || false;

      // Send email via orchestrator
      const result = await orchestrator.sendEmail({
        emailType: 'AFFILIATE_WELCOME',
        customerInfo: {
          email: affiliateEmail,
          name: affiliateName
        },
        language: language,
        additionalData: {
          affiliateInfo: {
            name: affiliateName,
            email: affiliateEmail,
            affiliateCode,
            commissionRate: affiliate.commissionRate,
            checkoutDiscount: affiliate.checkoutDiscount
          },
          credentials: {
            email: affiliateEmail,
            temporaryPassword: request.data.credentials.temporaryPassword
          },
          wasExistingAuthUser: wasExistingAuthUser
        }
      });

      if (result.success) {
        console.log('✅ sendAffiliateWelcomeEmail: Success - Welcome email sent');
        return {
          success: true,
          messageId: result.messageId,
          details: result.details,
          affiliateCode,
          email: affiliateEmail,
          wasExistingAuthUser: wasExistingAuthUser,
          language: language
        };
      } else {
        console.error('❌ sendAffiliateWelcomeEmail: Failed:', result.error);
        throw new Error(result.error || 'Affiliate welcome email sending failed');
      }

    } catch (error) {
      console.error('❌ sendAffiliateWelcomeEmail: Fatal error:', error);
      if (error instanceof HttpsError) throw error;
      throw new Error(error instanceof Error ? error.message : 'Unknown error in affiliate welcome email');
    }
  }
);
