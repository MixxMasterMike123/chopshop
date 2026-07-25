"use strict";
// sendAffiliateApplicationEmails.ts - Send both affiliate and admin emails when application is submitted
// Replaces missing affiliate application notification system
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendAffiliateApplicationEmails = void 0;
const https_1 = require("firebase-functions/v2/https");
const app_urls_1 = require("../../config/app-urls");
const EmailOrchestrator_1 = require("../core/EmailOrchestrator");
const config_1 = require("../core/config");
const database_1 = require("../../config/database");
const firestore_1 = require("firebase-admin/firestore");
exports.sendAffiliateApplicationEmails = (0, https_1.onCall)({
    region: 'us-central1',
    secrets: ['RESEND_API_KEY'],
    memory: '256MiB',
    timeoutSeconds: 60,
    cors: app_urls_1.appUrls.CORS_ORIGINS
}, async (request) => {
    try {
        console.log('📧 sendAffiliateApplicationEmails: Starting dual email send');
        const applicationId = (request.data?.applicationId || '').trim();
        if (!applicationId) {
            throw new https_1.HttpsError('invalid-argument', 'applicationId is required');
        }
        // Recipient comes from the STORED application, never from the caller.
        const appSnap = await database_1.db.collection('affiliateApplications').doc(applicationId).get();
        if (!appSnap.exists) {
            throw new https_1.HttpsError('not-found', 'Application not found');
        }
        const appData = appSnap.data();
        // Send once per application: re-calling must not re-deliver mail (which
        // would turn a legitimate applicationId into a repeatable send primitive).
        if (appData.applicationEmailsSentAt) {
            console.log(`📧 Emails already sent for ${applicationId} — skipping.`);
            return { success: true, alreadySent: true };
        }
        const applicantInfo = {
            name: appData.name,
            email: appData.email,
            phone: appData.phone,
            address: appData.address,
            city: appData.city,
            country: appData.country,
            promotionMethod: appData.promotionMethod,
            message: appData.message,
            socials: appData.socials
        };
        if (!applicantInfo.name || !applicantInfo.email) {
            throw new https_1.HttpsError('failed-precondition', 'Application is missing name or email');
        }
        console.log('📧 Sending for application:', applicationId);
        // Initialize EmailOrchestrator
        const orchestrator = new EmailOrchestrator_1.EmailOrchestrator();
        // 1. Send confirmation email to affiliate applicant
        console.log('📧 Sending confirmation email to applicant...');
        const applicantResult = await orchestrator.sendEmail({
            emailType: 'AFFILIATE_APPLICATION_RECEIVED',
            customerInfo: {
                email: applicantInfo.email,
                name: applicantInfo.name
            },
            language: appData.preferredLang || request.data?.language || 'sv-SE',
            additionalData: {
                applicantInfo,
                applicationId
            },
            adminEmail: false
        });
        if (!applicantResult.success) {
            console.error('❌ Failed to send applicant confirmation email:', applicantResult.error);
            throw new Error(`Failed to send confirmation email: ${applicantResult.error}`);
        }
        // 2. Send notification email to admin
        console.log('📧 Sending notification email to admin...');
        const adminResult = await orchestrator.sendEmail({
            emailType: 'AFFILIATE_APPLICATION_NOTIFICATION_ADMIN',
            customerInfo: {
                email: config_1.EMAIL_CONFIG.ADMIN_RECIPIENTS.join(', '),
                name: `${config_1.EMAIL_CONFIG.SMTP.FROM_NAME} Admin`
            },
            language: 'sv-SE',
            additionalData: {
                applicantInfo,
                applicationId,
                adminPortalUrl: app_urls_1.appUrls.B2B_PORTAL
            },
            adminEmail: true
        });
        if (!adminResult.success) {
            console.error('❌ Failed to send admin notification email:', adminResult.error);
            // Don't fail the entire operation if admin email fails
            console.log('⚠️ Continuing despite admin email failure');
        }
        // Stamp AFTER a successful applicant send, so a transient failure can be
        // retried but a success can never be replayed into repeat delivery.
        await appSnap.ref.update({ applicationEmailsSentAt: firestore_1.FieldValue.serverTimestamp() });
        console.log('✅ sendAffiliateApplicationEmails: Success');
        return {
            success: true,
            applicantEmailSent: applicantResult.success,
            adminEmailSent: adminResult.success,
            applicantMessageId: applicantResult.messageId,
            adminMessageId: adminResult.messageId,
            details: {
                applicant: applicantResult.details,
                admin: adminResult.details
            }
        };
    }
    catch (error) {
        console.error('❌ sendAffiliateApplicationEmails: Fatal error:', error);
        throw new Error(error instanceof Error ? error.message : 'Unknown error in affiliate application emails');
    }
});
//# sourceMappingURL=sendAffiliateApplicationEmails.js.map