"use strict";
// sendCustomEmailVerification - Complete B2C Email Verification System
// Replaces: Firebase's sendEmailVerification with custom verification flow
// Creates verification record + sends custom branded email
//
// P0-02 HARDENING (2026-08-15 audit): verification must prove MAILBOX
// ownership, so
//   • the recipient is the caller's Firebase AUTH email (server-derived) — the
//     payload email is display-only and must match, or the call is rejected;
//   • the code is 256-bit CSPRNG, stored ONLY as a SHA-256 hash (doc id), and
//     is NEVER returned to the caller or written to logs — the only plaintext
//     copy is inside the email itself.
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendCustomEmailVerification = void 0;
const https_1 = require("firebase-functions/v2/https");
const app_urls_1 = require("../../config/app-urls");
const firestore_1 = require("firebase-admin/firestore");
const auth_1 = require("firebase-admin/auth");
const EmailOrchestrator_1 = require("../core/EmailOrchestrator");
const authGuard_1 = require("./authGuard");
const verificationCode_1 = require("./verificationCode");
const durableRateLimit_1 = require("../../protection/rate-limiting/durableRateLimit");
// Initialize Firestore with named database
const db = (0, firestore_1.getFirestore)('b8s-reseller-db');
exports.sendCustomEmailVerification = (0, https_1.onCall)({
    region: 'us-central1',
    secrets: ['RESEND_API_KEY'],
    memory: '256MiB',
    timeoutSeconds: 60,
    cors: app_urls_1.appUrls.CORS_ORIGINS
}, async (request) => {
    // SECURITY: only the just-created account itself may request its own
    // verification email — otherwise this is an open mailer.
    if (!request.auth || request.auth.uid !== request.data.firebaseAuthUid) {
        throw new https_1.HttpsError('permission-denied', 'Callers may only request verification for their own account');
    }
    // P1-02: per-account send throttle (mail-volume abuse guard).
    if (!(await (0, durableRateLimit_1.checkRateLimit)('verifyMail', request.auth.uid, { limit: 5, windowSec: 3600 }))) {
        throw new https_1.HttpsError('resource-exhausted', 'För många verifieringsmail — försök igen om en stund.');
    }
    // The recipient is the AUTH account's email — never a caller-chosen
    // address. A payload email that disagrees with the account is rejected
    // (it would verify a mailbox the account doesn't own).
    const authUser = await (0, auth_1.getAuth)().getUser(request.auth.uid);
    const authEmail = (authUser.email || '').trim().toLowerCase();
    if (!authEmail) {
        throw new https_1.HttpsError('failed-precondition', 'Account has no email address');
    }
    const payloadEmail = (request.data.customerInfo?.email || '').trim().toLowerCase();
    if (payloadEmail && payloadEmail !== authEmail) {
        throw new https_1.HttpsError('invalid-argument', 'Email does not match the authenticated account');
    }
    console.log('🔐 sendCustomEmailVerification: minting verification', {
        firebaseAuthUid: request.auth.uid,
        source: request.data.source,
        language: request.data.language
    });
    // 256-bit code; only its HASH is persisted (as the doc id).
    const verificationCode = (0, verificationCode_1.generateVerificationCode)();
    const codeHash = (0, verificationCode_1.hashVerificationCode)(verificationCode);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    const language = request.data.language || request.data.customerInfo?.preferredLang || 'sv-SE';
    // TENANT ISOLATION: stamp the shop this account belongs to so the
    // verification record is shop-scoped (INV-1). The verify step looks the
    // doc up by hash-as-doc-id, so this is for scoping/audit rather than an
    // attack boundary. Falls back to the unresolved sentinel (never untagged).
    const shopId = await (0, authGuard_1.resolveShopIdByEmail)(authEmail);
    const verificationData = {
        shopId,
        email: authEmail,
        firebaseAuthUid: request.auth.uid,
        expiresAt: expiresAt,
        verified: false,
        createdAt: new Date(),
        source: request.data.source || 'registration',
        language: language,
        customerInfo: {
            firstName: request.data.customerInfo?.firstName,
            lastName: request.data.customerInfo?.lastName,
            name: request.data.customerInfo?.name,
            email: authEmail
        }
    };
    await db.collection('emailVerifications').doc(codeHash).set(verificationData);
    const orchestrator = new EmailOrchestrator_1.EmailOrchestrator();
    const emailResult = await orchestrator.sendEmail({
        emailType: 'EMAIL_VERIFICATION',
        customerInfo: {
            email: authEmail,
            firstName: request.data.customerInfo?.firstName,
            lastName: request.data.customerInfo?.lastName,
            name: request.data.customerInfo?.name
        },
        language: language,
        additionalData: {
            verificationCode: verificationCode,
            source: request.data.source || 'registration'
        },
        shopId // tenant identity: verification mail sends as the shop
    });
    if (!emailResult.success) {
        console.error('❌ Custom verification email failed:', emailResult.error);
        // Clean up verification record if email failed
        await db.collection('emailVerifications').doc(codeHash).delete();
        throw new https_1.HttpsError('internal', 'Verification email sending failed');
    }
    console.log('✅ Custom verification email sent', { firebaseAuthUid: request.auth.uid });
    return {
        success: true,
        messageId: emailResult.messageId,
        source: request.data.source,
        language: language,
        expiresAt: expiresAt.toISOString()
    };
});
//# sourceMappingURL=sendCustomEmailVerification.js.map