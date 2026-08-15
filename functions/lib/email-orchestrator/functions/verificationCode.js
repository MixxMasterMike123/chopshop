"use strict";
// Verification-code crypto helpers — shared by sendCustomEmailVerification
// (mint) and verifyEmailCode (consume).
//
// P0-02 (2026-08-15 audit): the plaintext code must exist ONLY inside the email
// sent to the mailbox. At rest the emailVerifications doc is keyed by the
// SHA-256 of the code and stores no plaintext, so neither a Firestore reader
// nor a log reader can redeem it. The code itself is 256-bit CSPRNG output —
// unguessable, and safe to treat as a bearer capability for the 24h window.
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashVerificationCode = exports.generateVerificationCode = void 0;
const crypto_1 = require("crypto");
function generateVerificationCode() {
    return (0, crypto_1.randomBytes)(32).toString('hex'); // 64 hex chars, 256 bits
}
exports.generateVerificationCode = generateVerificationCode;
function hashVerificationCode(code) {
    return (0, crypto_1.createHash)('sha256').update(code, 'utf8').digest('hex');
}
exports.hashVerificationCode = hashVerificationCode;
//# sourceMappingURL=verificationCode.js.map