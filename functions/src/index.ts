// V2 FUNCTIONS BATCH 4 - Direct imports to avoid circular dependencies
// EMAIL ORCHESTRATOR SYSTEM - Unified email functions

// Initialize Firebase Admin SDK
import { initializeApp } from 'firebase-admin/app';
initializeApp();

// NEW UNIFIED EMAIL ORCHESTRATOR FUNCTIONS
export { 
  sendOrderConfirmationEmail,
  sendOrderStatusUpdateEmail,
  sendOrderNotificationAdmin,
  sendPasswordResetEmail,
  sendLoginCredentialsEmail,
  sendAffiliateWelcomeEmail,
  approveAffiliate,
  createShopUser,
  createPlatformSuperAdmin,
  deletePlatformUser,
  migrateFromShopify,
  migrateFromWoo,
  sendCustomEmailVerification,
  verifyEmailCode,
  sendAffiliateApplicationEmails
  // sendB2BApplicationEmails, // TEMPORARILY DISABLED - compilation errors
} from './email-orchestrator/functions';

// Import confirmPasswordReset separately for aliasing
import { confirmPasswordReset } from './email-orchestrator/functions';

// Import affiliate functions directly (avoiding export * circular imports)
import { logAffiliateClickV2 } from './affiliate/callable/logAffiliateClick';
import { validateDiscountCode } from './affiliate/callable/validateDiscountCode';
// logAffiliateClickHttpV2 removed: unauthenticated CORS-* endpoint allowed
// anyone to inflate any affiliate's click stats; the SPA uses the callable.
// processAffiliateConversionV2 removed: deprecated no-op trigger.

// Debug functions removed - found the real issue

// LEGACY EMAIL FUNCTIONS DISABLED - ALL EMAIL NOW USES V3 SYSTEM WITH GMAIL SMTP
// import { 
//   sendCustomerWelcomeEmail,        // → Use sendCustomerWelcomeEmailV3
//   sendAffiliateWelcomeEmail,       // → Use sendAffiliateWelcomeEmailV3
//   sendB2BOrderConfirmationAdmin,   // → Use sendB2BOrderConfirmationAdminV3
//   sendB2BOrderConfirmationCustomer,// → Use sendB2BOrderConfirmationCustomerV3
//   sendOrderStatusEmail,            // → Use sendOrderStatusEmailV3
//   sendB2COrderNotificationAdmin,   // → Use sendB2COrderNotificationAdminV3
//   sendB2COrderPendingEmail,        // → Use sendB2COrderPendingEmailV3
//   sendOrderConfirmationEmails,     // → Use sendOrderConfirmationEmailsV3 (trigger)
//   sendUserActivationEmail,         // → TODO: Create sendUserActivationEmailV3
//   sendOrderStatusUpdateEmail,      // → TODO: Create sendOrderStatusUpdateEmailV3
//   updateCustomerEmail,             // → TODO: Create updateCustomerEmailV3
//   testEmail,                       // → TODO: Create testEmailV3
//   approveAffiliate,                // → Use approveAffiliateV3
//   sendVerificationEmail,           // → Use sendVerificationEmailV3
//   sendAffiliateCredentialsV2,      // → Use sendAffiliateCredentialsV3
//   sendPasswordResetEmailV2,        // → Use sendPasswordResetV3
//   confirmPasswordResetV2           // → Use confirmPasswordResetV3
// } from './email/functions';

// OLD EMAIL FUNCTIONS MOVED TO QUARANTINE - NO LONGER AVAILABLE
// sendStatusUpdateHttp and sendUserActivationEmail moved to quarantine
// All email functionality now handled by Email Orchestrator system

// Import order processing functions directly with original names
import {
  processB2COrderCompletionHttp // single order-completion engine (idempotent)
} from './order-processing/functions';
import { reverseAffiliateCommissionOnCancel } from './order-processing/commissionReversal';
// B2B Faktura ordering (Phase 4 v1): server-side order creation for the B2B
// wholesale portal (orders are client-uncreatable; totals computed from b2bPrice).
import { createB2BOrder } from './order-processing/createB2BOrder';
import { cancelB2BOrder } from './order-processing/cancelB2BOrder';
// Tenant isolation: keep Auth custom claims (role/shopId/platform) in sync with
// the users doc on every write + revoke tokens on privilege reduction.
import { syncUserClaimsOnWrite } from './auth/syncUserClaimsOnWrite';

// Import geo functions for B2C shop currency detection
import {
  getGeoData
} from './geo/functions';

// Google Merchant Center integration removed (POD shops don't need Google Shopping feeds).

// Import customer-admin functions directly with original names
import {
  deleteCustomerAccount,
  deleteB2CCustomerAccount,
  toggleCustomerActiveStatus,
  createAdminUser,
  syncAdminClaims
} from './customer-admin/functions';

// Import payment functions for Stripe integration
import {
  createPaymentIntentV2
} from './payment/createPaymentIntent';
import {
  stripeWebhookV2
} from './payment/stripeWebhook';
// Stripe Connect — onboarding callables (Slice 1)
import {
  createConnectAccount,
  createConnectAccountLink,
  refreshConnectStatus,
  createConnectLoginLink,
  setShopCommission,
  getConnectBalance,
  setConnectPayoutDelay
} from './payment/connectOnboarding';
import { refundOrder } from './payment/connectRefund';
// DAC7 seller due-diligence + aggregation + export (Slices E/F)
import {
  saveDac7SellerProfile,
  getDac7SellerProfile,
  pullDac7FromStripe,
  aggregateDac7Year,
  exportDac7Report,
  getOwnDac7,
  correctOwnDac7Contact,
  requestDac7Correction,
  resolveDac7Correction
} from './dac7/functions';

// Import website scraper functions for DiningWagon
import {
  scrapeWebsiteMeta
} from './website-scraper/functions';

// Re-export affiliate functions individually with V2 names (avoid V1 conflicts)
export { logAffiliateClickV2, validateDiscountCode };

// OLD EMAIL FUNCTIONS MOVED TO QUARANTINE - NO LONGER EXPORTED
// All email functionality now handled by Email Orchestrator system
// sendStatusUpdateHttp and sendUserActivationEmail moved to quarantine

// Re-export order processing functions individually with V2 names (avoid V1 conflicts)
export {
  processB2COrderCompletionHttp as processB2COrderCompletionHttpV2,
  reverseAffiliateCommissionOnCancel,
  createB2BOrder,
  cancelB2BOrder
};

// Tenant-isolation: claim-resync trigger on users/{uid}.
export { syncUserClaimsOnWrite };

// Re-export geo functions for B2C shop currency detection
export {
  getGeoData as getGeoDataV2
};

// Re-export customer-admin functions individually with V2 names (avoid V1 conflicts)
export {
  deleteCustomerAccount as deleteCustomerAccountV2,
  deleteB2CCustomerAccount as deleteB2CCustomerAccountV2,
  toggleCustomerActiveStatus as toggleCustomerActiveStatusV2,
  createAdminUser as createAdminUserV2,
  syncAdminClaims
};

// Re-export payment functions for Stripe integration
export {
  createPaymentIntentV2,
  stripeWebhookV2
};

// Stripe Connect — onboarding (Slice 1) + commission (Slice 3) + refund (Slice 4)
export {
  createConnectAccount,
  createConnectAccountLink,
  refreshConnectStatus,
  createConnectLoginLink,
  setShopCommission,
  getConnectBalance,
  setConnectPayoutDelay,
  refundOrder
};

// DAC7 seller due-diligence + aggregation + export (Slices E/F).
// Platform-only: save/get/pull/aggregate/export + resolveDac7Correction.
// Seller (own shop): getOwnDac7 / correctOwnDac7Contact / requestDac7Correction.
export {
  saveDac7SellerProfile,
  getDac7SellerProfile,
  pullDac7FromStripe,
  aggregateDac7Year,
  exportDac7Report,
  getOwnDac7,
  correctOwnDac7Contact,
  requestDac7Correction,
  resolveDac7Correction
};

// Re-export website scraper functions for DiningWagon
export {
  scrapeWebsiteMeta as scrapeWebsiteMetaV2
};

// POD print-shop callables (callable-projection model — the print_shop role has NO
// direct DB/Storage access; these enforce scope off the live user doc + return
// production-scoped data + signed URLs). createPrintShopUser is platform-only.
export {
  getPrintQueue,
  getPrintJob,
  getPrintQueueExport,
  getPrintArtworkLibrary,
  getPrintArtworkDownload,
  createPrintShopUser,
} from './print/functions';

// setPrintJobStatus — the printer advances a POD order ('printed' internal
// milestone / 'shipped' fulfilment → customer email + reviews trigger). Same
// callable-projection auth as the print queue callables; lives in its own file
// because it declares the RESEND_API_KEY secret for the server-side status email.
export { setPrintJobStatus } from './print/setPrintJobStatus';

// processPodArtwork — the server-authoritative artwork pipeline (sharp):
// convert-to-PNG + trim + sRGB + BLOCKING 300-DPI contain gate (docs/POD_PRINT_SPEC.md).
export { processPodArtwork } from './pod/processArtwork';

// Landing-page lead form ("Vill du ha en egen butik?") — public callable that
// writes a platform-level `leads` doc + best-effort admin notification email.
export { submitLead } from './leads/submitLead';

// Abandoned-checkout recovery ("Övergiven kassa" add-on): a scheduled sweep that
// reminds buyers who created a PaymentIntent but never completed the order, plus
// two public callables the storefront recovery/unsubscribe pages call.
export { sweepAbandonedCheckouts } from './checkout-recovery/sweep';
export { resolveCheckoutRecovery, unsubscribeCheckout } from './checkout-recovery/callables';

// Native product reviews ("Recensioner" add-on): an order trigger that schedules
// a review request when a B2C order is fulfilled, a scheduled sweep that emails
// the request, and the public/admin callables the storefront + admin pages call.
export { onOrderReviewQualify } from './product-reviews/writeReviewRequest';
export { sweepReviewRequests } from './product-reviews/sweep';
export {
  resolveReviewRequest,
  submitReview,
  unsubscribeReviews,
  moderateReview,
} from './product-reviews/callables';

// Ångerfunktion — consumer right-of-withdrawal function (DAL 2 kap. 10 a § /
// CRD Art. 11a, in force 19 June 2026). Server-authoritative: stamps the
// submission time, enforces eligibility (Regime A applies / Regime B exempt),
// persists a durable acknowledgement of receipt. See memory angerratt_pod.md.
export { submitWithdrawal } from './withdrawal/functions';

// Content Studio ("Innehållsstudio" add-on): two PURE-COMPUTE callables. Both
// are auth+opt-in gated (requireContentStudio) and never write Firestore — the
// client persists results onto socialPosts docs. generateSocialCopy turns a
// description into per-channel social copy; renderSocialVideo assembles a
// vertical beat-cut clip from the shop's uploads and returns a download URL.
export { generateSocialCopy } from './content-studio/generateSocialCopy';
export { renderSocialVideo } from './content-studio/renderSocialVideo';
// getHandoffPackage: token-guarded PUBLIC projection for the "Skicka till
// mobilen" QR flow — the phone is not logged in and gets only copy + video URL.
export { getHandoffPackage } from './content-studio/getHandoffPackage';

// Re-export orchestrator functions with V2 aliases for backward compatibility
export { confirmPasswordReset as confirmPasswordResetV2 };

// Also export the main function
export { confirmPasswordReset };

// OLD V1/V2/V3 EMAIL SYSTEM FUNCTIONS - MOVED TO QUARANTINE
// All old email functions have been migrated to the new Email Orchestrator system
// Old files moved to: functions/quarantine/old-email-systems/
// New system: functions/src/email-orchestrator/ 