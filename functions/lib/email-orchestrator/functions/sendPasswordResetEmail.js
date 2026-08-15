"use strict";
// sendPasswordResetEmail - Unified Password Reset Function
// Replaces: sendPasswordResetV3, sendPasswordReset
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendPasswordResetEmail = void 0;
const https_1 = require("firebase-functions/v2/https");
const app_urls_1 = require("../../config/app-urls");
const crypto_1 = require("crypto");
const EmailOrchestrator_1 = require("../core/EmailOrchestrator");
const database_1 = require("../../config/database");
const authGuard_1 = require("./authGuard");
const durableRateLimit_1 = require("../../protection/rate-limiting/durableRateLimit");
exports.sendPasswordResetEmail = (0, https_1.onCall)({
    region: 'us-central1',
    secrets: ['RESEND_API_KEY'],
    memory: '256MiB',
    timeoutSeconds: 60,
    cors: app_urls_1.appUrls.CORS_ORIGINS
}, async (request) => {
    try {
        // P1-05: don't log the target email (PII) — type/language suffice.
        console.log('📧 sendPasswordResetEmail: Starting unified password reset', {
            userType: request.data.userType,
            language: request.data.language
        });
        // Validate required data
        if (!request.data.email) {
            throw new Error('Email is required');
        }
        // P1-02: durable throttles — per requesting IP (spray) AND per target
        // email (mail-bombing one victim). Both fail closed on the limit only.
        const ip = (0, durableRateLimit_1.trustedClientIp)(request.rawRequest);
        const targetEmail = String(request.data.email).trim().toLowerCase();
        if (!(await (0, durableRateLimit_1.checkRateLimit)('pwResetIp', ip, { limit: 10, windowSec: 3600 })) ||
            !(await (0, durableRateLimit_1.checkRateLimit)('pwResetEmail', targetEmail, { limit: 3, windowSec: 3600 }))) {
            throw new https_1.HttpsError('resource-exhausted', 'För många försök — försök igen om en stund.');
        }
        // SECURITY: the reset code MUST be generated server-side. Accepting a
        // client-supplied code lets an attacker pre-choose the code for any
        // email address and take over the account.
        const resetCode = (0, crypto_1.randomBytes)(32).toString('hex');
        // Store reset code in Firestore (matching V3 behavior)
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 1); // 1 hour expiry
        // TENANT ISOLATION: this is an anonymous storefront flow (no caller
        // identity), so infer the shop the email belongs to and stamp it. The
        // confirm step queries by resetCode AND shopId, so a code is consumed
        // only within its own shop. Falls back to DEFAULT_SHOP_ID (never untagged).
        const shopId = await (0, authGuard_1.resolveShopIdByEmail)(request.data.email);
        await database_1.db.collection('passwordResets').add({
            shopId,
            email: request.data.email,
            resetCode,
            expiresAt,
            used: false,
            createdAt: new Date(),
            userType: request.data.userType || 'B2C'
        });
        console.log('✅ Reset code stored in Firestore with 1 hour expiry');
        // Initialize EmailOrchestrator
        const orchestrator = new EmailOrchestrator_1.EmailOrchestrator();
        // Send password reset email via orchestrator
        const result = await orchestrator.sendEmail({
            emailType: 'PASSWORD_RESET',
            customerInfo: {
                email: request.data.email
            },
            language: request.data.language || 'sv-SE',
            additionalData: {
                resetCode,
                userAgent: request.data.userAgent,
                timestamp: request.data.timestamp,
                userType: request.data.userType || 'B2C'
            },
            adminEmail: false,
            shopId // tenant identity: reset mail sends as the user's shop
        });
        if (result.success) {
            console.log('✅ sendPasswordResetEmail: Success');
            return {
                success: true,
                messageId: result.messageId,
                details: result.details
            };
        }
        else {
            console.error('❌ sendPasswordResetEmail: Failed:', result.error);
            throw new Error(result.error || 'Password reset email sending failed');
        }
    }
    catch (error) {
        // Preserve typed callable errors (e.g. resource-exhausted from the rate
        // limit) — only wrap untyped ones.
        if (error instanceof https_1.HttpsError)
            throw error;
        console.error('❌ sendPasswordResetEmail: Fatal error:', error);
        throw new Error(error instanceof Error ? error.message : 'Unknown error in password reset email');
    }
});
//# sourceMappingURL=sendPasswordResetEmail.js.map