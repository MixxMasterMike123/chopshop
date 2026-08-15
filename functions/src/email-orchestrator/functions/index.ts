// EmailOrchestrator Functions Index
// Unified email functions replacing ALL V1/V2/V3 email functions

// Import all unified email functions
export { sendOrderConfirmationEmail } from './sendOrderConfirmationEmail';
export { sendOrderStatusUpdateEmail } from './sendOrderStatusUpdateEmail';
export { sendOrderNotificationAdmin } from './sendOrderNotificationAdmin';
export { sendPasswordResetEmail } from './sendPasswordResetEmail';
export { sendLoginCredentialsEmail } from './sendLoginCredentialsEmail';
export { sendAffiliateWelcomeEmail } from './sendAffiliateWelcomeEmail';
export { approveAffiliate } from './approveAffiliate';
export { createShopUser } from './createShopUser';
export { createPlatformSuperAdmin, deletePlatformUser } from './platformUsers';
export { migrateFromShopify } from './migrateFromShopify';
export { migrateFromWoo } from './migrateFromWoo';
// sendEmailVerification DELETED (P0-02/P1-01, 2026-08-15 audit): it was an
// unauthenticated open relay (caller-supplied recipient + code) with zero
// client callers — verification mail goes through sendCustomEmailVerification.
export { sendCustomEmailVerification } from './sendCustomEmailVerification';
export { verifyEmailCode } from './verifyEmailCode';
export { confirmPasswordReset } from './confirmPasswordReset';
export { sendAffiliateApplicationEmails } from './sendAffiliateApplicationEmails';
// export { sendB2BApplicationEmails } from './sendB2BApplicationEmails'; // TEMPORARILY DISABLED
