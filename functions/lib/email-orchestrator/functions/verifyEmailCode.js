"use strict";
// verifyEmailCode - Custom Email Verification Handler
// Consumes a verification code minted by sendCustomEmailVerification and marks
// the account's email verified (Firebase Auth + b2cCustomers mirror).
//
// P0-02 HARDENING (2026-08-15 audit): the emailVerifications doc is keyed by
// the SHA-256 of the code, so this endpoint hashes the incoming code and looks
// the hash up — a Firestore/log reader can never redeem a code. Consumption is
// a TRANSACTION (single-use): two concurrent redemptions cannot both pass the
// unverified check. The code itself is never logged.
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyEmailCode = void 0;
const https_1 = require("firebase-functions/v2/https");
const app_urls_1 = require("../../config/app-urls");
const firestore_1 = require("firebase-admin/firestore");
const auth_1 = require("firebase-admin/auth");
const verificationCode_1 = require("./verificationCode");
// Initialize Firebase services
const db = (0, firestore_1.getFirestore)('b8s-reseller-db');
const auth = (0, auth_1.getAuth)();
exports.verifyEmailCode = (0, https_1.onCall)({
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 60,
    cors: app_urls_1.appUrls.CORS_ORIGINS
}, async (request) => {
    const code = (request.data?.verificationCode || '').trim();
    if (!code) {
        throw new https_1.HttpsError('invalid-argument', 'Verification code is required');
    }
    const docRef = db.collection('emailVerifications').doc((0, verificationCode_1.hashVerificationCode)(code));
    // Atomic single-use consume: validate + mark verified in one transaction.
    const outcome = await db.runTransaction(async (tx) => {
        const snap = await tx.get(docRef);
        if (!snap.exists) {
            // Legacy plaintext-keyed records are intentionally NOT honored — the
            // hash lookup invalidates every code minted before the P0-02 fix.
            throw new https_1.HttpsError('invalid-argument', 'Invalid verification code');
        }
        const data = snap.data();
        if (data.verified) {
            // Idempotent double-click on the email link: already-verified is a
            // success, not an error (nothing new is granted).
            return { alreadyVerified: true, email: data.email, firebaseAuthUid: data.firebaseAuthUid };
        }
        if (new Date() > data.expiresAt.toDate()) {
            throw new https_1.HttpsError('deadline-exceeded', 'Verification code has expired');
        }
        tx.update(docRef, { verified: true, verifiedAt: new Date() });
        return { alreadyVerified: false, email: data.email, firebaseAuthUid: data.firebaseAuthUid };
    });
    if (outcome.alreadyVerified) {
        return {
            success: true,
            message: 'Email already verified',
            email: outcome.email,
            alreadyVerified: true
        };
    }
    // Mark the Auth user verified. If this fails, revert the consume so the
    // user can retry with the same link instead of being stranded.
    try {
        await auth.updateUser(outcome.firebaseAuthUid, { emailVerified: true });
    }
    catch (authError) {
        console.error('❌ Auth emailVerified update failed — reverting consume', authError);
        try {
            await docRef.update({ verified: false, verifiedAt: null });
        }
        catch (revertError) {
            console.error('❌ Consume revert also failed', revertError);
        }
        throw new https_1.HttpsError('internal', 'Verification could not be completed, please try the link again');
    }
    // Mirror onto the B2C customer record (best-effort).
    try {
        const b2cQuery = await db.collection('b2cCustomers')
            .where('firebaseAuthUid', '==', outcome.firebaseAuthUid)
            .limit(1)
            .get();
        if (!b2cQuery.empty) {
            await b2cQuery.docs[0].ref.update({
                emailVerified: true,
                updatedAt: new Date()
            });
        }
    }
    catch (b2cError) {
        console.error('❌ Error updating B2C customer emailVerified mirror:', b2cError);
        // Continue — Auth is the authoritative record.
    }
    console.log('🎉 Email verification completed', { firebaseAuthUid: outcome.firebaseAuthUid });
    return {
        success: true,
        message: 'Email verified successfully',
        email: outcome.email,
        verifiedAt: new Date().toISOString()
    };
});
//# sourceMappingURL=verifyEmailCode.js.map