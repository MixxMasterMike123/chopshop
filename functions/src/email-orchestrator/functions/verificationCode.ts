// Verification-code crypto helpers — shared by sendCustomEmailVerification
// (mint) and verifyEmailCode (consume).
//
// P0-02 (2026-08-15 audit): the plaintext code must exist ONLY inside the email
// sent to the mailbox. At rest the emailVerifications doc is keyed by the
// SHA-256 of the code and stores no plaintext, so neither a Firestore reader
// nor a log reader can redeem it. The code itself is 256-bit CSPRNG output —
// unguessable, and safe to treat as a bearer capability for the 24h window.

import { createHash, randomBytes } from 'crypto';

export function generateVerificationCode(): string {
  return randomBytes(32).toString('hex'); // 64 hex chars, 256 bits
}

export function hashVerificationCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}
