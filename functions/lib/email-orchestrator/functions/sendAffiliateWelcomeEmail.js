"use strict";
// sendAffiliateWelcomeEmail - New Affiliate Onboarding Function
// Replaces: sendAffiliateWelcomeEmailV3, approveAffiliateV3 email functionality
// Used for: New affiliate approval and welcome (different from login credentials)
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendAffiliateWelcomeEmail = void 0;
const https_1 = require("firebase-functions/v2/https");
const app_urls_1 = require("../../config/app-urls");
const database_1 = require("../../config/database");
const EmailOrchestrator_1 = require("../core/EmailOrchestrator");
const authGuard_1 = require("./authGuard");
exports.sendAffiliateWelcomeEmail = (0, https_1.onCall)({
    region: 'us-central1',
    secrets: ['RESEND_API_KEY'],
    memory: '256MiB',
    timeoutSeconds: 60,
    cors: app_urls_1.appUrls.CORS_ORIGINS
}, async (request) => {
    try {
        const affiliateCode = String(request.data.affiliateInfo?.affiliateCode || '').trim();
        if (!affiliateCode)
            throw new https_1.HttpsError('invalid-argument', 'Affiliate code is required');
        const affiliateQuery = await database_1.db.collection('affiliates')
            .where('affiliateCode', '==', affiliateCode)
            .limit(2)
            .get();
        if (affiliateQuery.empty)
            throw new https_1.HttpsError('not-found', 'Affiliate not found');
        if (affiliateQuery.size !== 1)
            throw new https_1.HttpsError('failed-precondition', 'Affiliate code is not unique');
        const affiliate = affiliateQuery.docs[0].data();
        await (0, authGuard_1.requireAdminOfShop)(affiliate.shopId, request.auth?.uid);
        const affiliateEmail = String(affiliate.email || '').trim();
        const affiliateName = String(affiliate.name || affiliate.contactPerson || '').trim();
        if (!affiliateEmail || !affiliateName) {
            throw new https_1.HttpsError('failed-precondition', 'Affiliate contact details are incomplete');
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
        const orchestrator = new EmailOrchestrator_1.EmailOrchestrator();
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
        }
        else {
            console.error('❌ sendAffiliateWelcomeEmail: Failed:', result.error);
            throw new Error(result.error || 'Affiliate welcome email sending failed');
        }
    }
    catch (error) {
        console.error('❌ sendAffiliateWelcomeEmail: Fatal error:', error);
        if (error instanceof https_1.HttpsError)
            throw error;
        throw new Error(error instanceof Error ? error.message : 'Unknown error in affiliate welcome email');
    }
});
//# sourceMappingURL=sendAffiliateWelcomeEmail.js.map