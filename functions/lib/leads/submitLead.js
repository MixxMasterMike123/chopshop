"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.submitLead = void 0;
const https_1 = require("firebase-functions/v2/https");
const logger = __importStar(require("firebase-functions/logger"));
const firestore_1 = require("firebase-admin/firestore");
const database_1 = require("../config/database");
const app_urls_1 = require("../config/app-urls");
const EmailOrchestrator_1 = require("../email-orchestrator/core/EmailOrchestrator");
const config_1 = require("../email-orchestrator/core/config");
const durableRateLimit_1 = require("../protection/rate-limiting/durableRateLimit");
const clip = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';
exports.submitLead = (0, https_1.onCall)({
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 60,
    cors: app_urls_1.appUrls.CORS_ORIGINS,
    // Admin notification email transport (best-effort after the write).
    secrets: ['RESEND_API_KEY'],
}, async (request) => {
    const data = request.data || {};
    // Honeypot filled → bot. Reject without writing anything.
    if (clip(data.website, 10)) {
        throw new https_1.HttpsError('invalid-argument', 'Invalid submission.');
    }
    // P1-02: durable per-IP throttle (each accepted lead also fires an admin
    // email — this bounds both the collection spam and the mail volume).
    if (!(await (0, durableRateLimit_1.checkRateLimit)('lead', (0, durableRateLimit_1.trustedClientIp)(request.rawRequest), { limit: 5, windowSec: 3600 }))) {
        throw new https_1.HttpsError('resource-exhausted', 'För många försök — försök igen om en stund.');
    }
    const name = clip(data.name, 500);
    const company = clip(data.company, 500);
    const email = clip(data.email, 500);
    const message = clip(data.message, 2000);
    if (!name) {
        throw new https_1.HttpsError('invalid-argument', 'Name is required.');
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new https_1.HttpsError('invalid-argument', 'A valid email is required.');
    }
    // 1. Persist the lead FIRST (platform-level — no shopId: the sender is a
    // prospective merchant, not a tenant's customer).
    const leadRef = await database_1.db.collection('leads').add({
        name,
        company,
        email,
        message,
        status: 'new',
        source: 'landing',
        createdAt: firestore_1.FieldValue.serverTimestamp(),
    });
    logger.info(`submitLead: lead ${leadRef.id} written for ${email}`);
    // 2. Best-effort admin notification — never fail the submission over email.
    try {
        const orchestrator = new EmailOrchestrator_1.EmailOrchestrator();
        const emailResult = await orchestrator.sendEmail({
            emailType: 'LEAD_NOTIFICATION_ADMIN',
            customerInfo: {
                email: config_1.EMAIL_CONFIG.ADMIN_RECIPIENTS.join(', '),
                name: `${config_1.EMAIL_CONFIG.SMTP.FROM_NAME} Admin`,
            },
            language: 'sv-SE',
            additionalData: {
                lead: { name, company, email, message },
                leadId: leadRef.id,
            },
            adminEmail: true,
        });
        if (!emailResult.success) {
            logger.error(`submitLead: admin email failed for lead ${leadRef.id}:`, emailResult.error);
        }
    }
    catch (emailError) {
        logger.error(`submitLead: admin email threw for lead ${leadRef.id}:`, emailError);
    }
    return { success: true, leadId: leadRef.id };
});
//# sourceMappingURL=submitLead.js.map