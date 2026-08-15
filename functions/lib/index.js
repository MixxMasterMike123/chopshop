"use strict";
// V2 FUNCTIONS BATCH 4 - Direct imports to avoid circular dependencies
// EMAIL ORCHESTRATOR SYSTEM - Unified email functions
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPrintQueue = exports.scrapeWebsiteMetaV2 = exports.resolveDac7Correction = exports.requestDac7Correction = exports.correctOwnDac7Contact = exports.getOwnDac7 = exports.exportDac7Report = exports.aggregateDac7Year = exports.pullDac7FromStripe = exports.getDac7SellerProfile = exports.saveDac7SellerProfile = exports.refundOrder = exports.setConnectPayoutDelay = exports.getConnectBalance = exports.setShopCommission = exports.createConnectLoginLink = exports.refreshConnectStatus = exports.createConnectAccountLink = exports.createConnectAccount = exports.stripeWebhookV2 = exports.createPaymentIntentV2 = exports.syncAdminClaims = exports.createAdminUserV2 = exports.toggleCustomerActiveStatusV2 = exports.deleteB2CCustomerAccountV2 = exports.deleteCustomerAccountV2 = exports.getGeoDataV2 = exports.syncUserClaimsOnWrite = exports.cancelB2BOrder = exports.createB2BOrder = exports.reverseAffiliateCommissionOnCancel = exports.processB2COrderCompletionHttpV2 = exports.validateDiscountCode = exports.logAffiliateClickV2 = exports.sendAffiliateApplicationEmails = exports.verifyEmailCode = exports.sendCustomEmailVerification = exports.sendEmailVerification = exports.migrateFromWoo = exports.migrateFromShopify = exports.deletePlatformUser = exports.createPlatformSuperAdmin = exports.createShopUser = exports.approveAffiliate = exports.sendAffiliateWelcomeEmail = exports.sendLoginCredentialsEmail = exports.sendPasswordResetEmail = exports.sendOrderNotificationAdmin = exports.sendOrderStatusUpdateEmail = exports.sendOrderConfirmationEmail = void 0;
exports.confirmPasswordReset = exports.confirmPasswordResetV2 = exports.getHandoffPackage = exports.renderSocialVideo = exports.generateSocialCopy = exports.submitWithdrawal = exports.moderateReview = exports.unsubscribeReviews = exports.submitReview = exports.resolveReviewRequest = exports.sweepReviewRequests = exports.onOrderReviewQualify = exports.unsubscribeCheckout = exports.resolveCheckoutRecovery = exports.sweepAbandonedCheckouts = exports.submitLead = exports.processPodArtwork = exports.setPrintJobStatus = exports.createPrintShopUser = exports.getPrintArtworkDownload = exports.getPrintArtworkLibrary = exports.getPrintQueueExport = exports.getPrintJob = void 0;
// Initialize Firebase Admin SDK
const app_1 = require("firebase-admin/app");
(0, app_1.initializeApp)();
// NEW UNIFIED EMAIL ORCHESTRATOR FUNCTIONS
var functions_1 = require("./email-orchestrator/functions");
Object.defineProperty(exports, "sendOrderConfirmationEmail", { enumerable: true, get: function () { return functions_1.sendOrderConfirmationEmail; } });
Object.defineProperty(exports, "sendOrderStatusUpdateEmail", { enumerable: true, get: function () { return functions_1.sendOrderStatusUpdateEmail; } });
Object.defineProperty(exports, "sendOrderNotificationAdmin", { enumerable: true, get: function () { return functions_1.sendOrderNotificationAdmin; } });
Object.defineProperty(exports, "sendPasswordResetEmail", { enumerable: true, get: function () { return functions_1.sendPasswordResetEmail; } });
Object.defineProperty(exports, "sendLoginCredentialsEmail", { enumerable: true, get: function () { return functions_1.sendLoginCredentialsEmail; } });
Object.defineProperty(exports, "sendAffiliateWelcomeEmail", { enumerable: true, get: function () { return functions_1.sendAffiliateWelcomeEmail; } });
Object.defineProperty(exports, "approveAffiliate", { enumerable: true, get: function () { return functions_1.approveAffiliate; } });
Object.defineProperty(exports, "createShopUser", { enumerable: true, get: function () { return functions_1.createShopUser; } });
Object.defineProperty(exports, "createPlatformSuperAdmin", { enumerable: true, get: function () { return functions_1.createPlatformSuperAdmin; } });
Object.defineProperty(exports, "deletePlatformUser", { enumerable: true, get: function () { return functions_1.deletePlatformUser; } });
Object.defineProperty(exports, "migrateFromShopify", { enumerable: true, get: function () { return functions_1.migrateFromShopify; } });
Object.defineProperty(exports, "migrateFromWoo", { enumerable: true, get: function () { return functions_1.migrateFromWoo; } });
Object.defineProperty(exports, "sendEmailVerification", { enumerable: true, get: function () { return functions_1.sendEmailVerification; } });
Object.defineProperty(exports, "sendCustomEmailVerification", { enumerable: true, get: function () { return functions_1.sendCustomEmailVerification; } });
Object.defineProperty(exports, "verifyEmailCode", { enumerable: true, get: function () { return functions_1.verifyEmailCode; } });
Object.defineProperty(exports, "sendAffiliateApplicationEmails", { enumerable: true, get: function () { return functions_1.sendAffiliateApplicationEmails; } });
// Import confirmPasswordReset separately for aliasing
const functions_2 = require("./email-orchestrator/functions");
Object.defineProperty(exports, "confirmPasswordResetV2", { enumerable: true, get: function () { return functions_2.confirmPasswordReset; } });
Object.defineProperty(exports, "confirmPasswordReset", { enumerable: true, get: function () { return functions_2.confirmPasswordReset; } });
// Import affiliate functions directly (avoiding export * circular imports)
const logAffiliateClick_1 = require("./affiliate/callable/logAffiliateClick");
Object.defineProperty(exports, "logAffiliateClickV2", { enumerable: true, get: function () { return logAffiliateClick_1.logAffiliateClickV2; } });
const validateDiscountCode_1 = require("./affiliate/callable/validateDiscountCode");
Object.defineProperty(exports, "validateDiscountCode", { enumerable: true, get: function () { return validateDiscountCode_1.validateDiscountCode; } });
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
const functions_3 = require("./order-processing/functions");
Object.defineProperty(exports, "processB2COrderCompletionHttpV2", { enumerable: true, get: function () { return functions_3.processB2COrderCompletionHttp // single order-completion engine (idempotent)
    ; } });
const commissionReversal_1 = require("./order-processing/commissionReversal");
Object.defineProperty(exports, "reverseAffiliateCommissionOnCancel", { enumerable: true, get: function () { return commissionReversal_1.reverseAffiliateCommissionOnCancel; } });
// B2B Faktura ordering (Phase 4 v1): server-side order creation for the B2B
// wholesale portal (orders are client-uncreatable; totals computed from b2bPrice).
const createB2BOrder_1 = require("./order-processing/createB2BOrder");
Object.defineProperty(exports, "createB2BOrder", { enumerable: true, get: function () { return createB2BOrder_1.createB2BOrder; } });
const cancelB2BOrder_1 = require("./order-processing/cancelB2BOrder");
Object.defineProperty(exports, "cancelB2BOrder", { enumerable: true, get: function () { return cancelB2BOrder_1.cancelB2BOrder; } });
// Tenant isolation: keep Auth custom claims (role/shopId/platform) in sync with
// the users doc on every write + revoke tokens on privilege reduction.
const syncUserClaimsOnWrite_1 = require("./auth/syncUserClaimsOnWrite");
Object.defineProperty(exports, "syncUserClaimsOnWrite", { enumerable: true, get: function () { return syncUserClaimsOnWrite_1.syncUserClaimsOnWrite; } });
// Import geo functions for B2C shop currency detection
const functions_4 = require("./geo/functions");
Object.defineProperty(exports, "getGeoDataV2", { enumerable: true, get: function () { return functions_4.getGeoData; } });
// Google Merchant Center integration removed (POD shops don't need Google Shopping feeds).
// Import customer-admin functions directly with original names
const functions_5 = require("./customer-admin/functions");
Object.defineProperty(exports, "deleteCustomerAccountV2", { enumerable: true, get: function () { return functions_5.deleteCustomerAccount; } });
Object.defineProperty(exports, "deleteB2CCustomerAccountV2", { enumerable: true, get: function () { return functions_5.deleteB2CCustomerAccount; } });
Object.defineProperty(exports, "toggleCustomerActiveStatusV2", { enumerable: true, get: function () { return functions_5.toggleCustomerActiveStatus; } });
Object.defineProperty(exports, "createAdminUserV2", { enumerable: true, get: function () { return functions_5.createAdminUser; } });
Object.defineProperty(exports, "syncAdminClaims", { enumerable: true, get: function () { return functions_5.syncAdminClaims; } });
// Import payment functions for Stripe integration
const createPaymentIntent_1 = require("./payment/createPaymentIntent");
Object.defineProperty(exports, "createPaymentIntentV2", { enumerable: true, get: function () { return createPaymentIntent_1.createPaymentIntentV2; } });
const stripeWebhook_1 = require("./payment/stripeWebhook");
Object.defineProperty(exports, "stripeWebhookV2", { enumerable: true, get: function () { return stripeWebhook_1.stripeWebhookV2; } });
// Stripe Connect — onboarding callables (Slice 1)
const connectOnboarding_1 = require("./payment/connectOnboarding");
Object.defineProperty(exports, "createConnectAccount", { enumerable: true, get: function () { return connectOnboarding_1.createConnectAccount; } });
Object.defineProperty(exports, "createConnectAccountLink", { enumerable: true, get: function () { return connectOnboarding_1.createConnectAccountLink; } });
Object.defineProperty(exports, "refreshConnectStatus", { enumerable: true, get: function () { return connectOnboarding_1.refreshConnectStatus; } });
Object.defineProperty(exports, "createConnectLoginLink", { enumerable: true, get: function () { return connectOnboarding_1.createConnectLoginLink; } });
Object.defineProperty(exports, "setShopCommission", { enumerable: true, get: function () { return connectOnboarding_1.setShopCommission; } });
Object.defineProperty(exports, "getConnectBalance", { enumerable: true, get: function () { return connectOnboarding_1.getConnectBalance; } });
Object.defineProperty(exports, "setConnectPayoutDelay", { enumerable: true, get: function () { return connectOnboarding_1.setConnectPayoutDelay; } });
const connectRefund_1 = require("./payment/connectRefund");
Object.defineProperty(exports, "refundOrder", { enumerable: true, get: function () { return connectRefund_1.refundOrder; } });
// DAC7 seller due-diligence + aggregation + export (Slices E/F)
const functions_6 = require("./dac7/functions");
Object.defineProperty(exports, "saveDac7SellerProfile", { enumerable: true, get: function () { return functions_6.saveDac7SellerProfile; } });
Object.defineProperty(exports, "getDac7SellerProfile", { enumerable: true, get: function () { return functions_6.getDac7SellerProfile; } });
Object.defineProperty(exports, "pullDac7FromStripe", { enumerable: true, get: function () { return functions_6.pullDac7FromStripe; } });
Object.defineProperty(exports, "aggregateDac7Year", { enumerable: true, get: function () { return functions_6.aggregateDac7Year; } });
Object.defineProperty(exports, "exportDac7Report", { enumerable: true, get: function () { return functions_6.exportDac7Report; } });
Object.defineProperty(exports, "getOwnDac7", { enumerable: true, get: function () { return functions_6.getOwnDac7; } });
Object.defineProperty(exports, "correctOwnDac7Contact", { enumerable: true, get: function () { return functions_6.correctOwnDac7Contact; } });
Object.defineProperty(exports, "requestDac7Correction", { enumerable: true, get: function () { return functions_6.requestDac7Correction; } });
Object.defineProperty(exports, "resolveDac7Correction", { enumerable: true, get: function () { return functions_6.resolveDac7Correction; } });
// Import website scraper functions for DiningWagon
const functions_7 = require("./website-scraper/functions");
Object.defineProperty(exports, "scrapeWebsiteMetaV2", { enumerable: true, get: function () { return functions_7.scrapeWebsiteMeta; } });
// POD print-shop callables (callable-projection model — the print_shop role has NO
// direct DB/Storage access; these enforce scope off the live user doc + return
// production-scoped data + signed URLs). createPrintShopUser is platform-only.
var functions_8 = require("./print/functions");
Object.defineProperty(exports, "getPrintQueue", { enumerable: true, get: function () { return functions_8.getPrintQueue; } });
Object.defineProperty(exports, "getPrintJob", { enumerable: true, get: function () { return functions_8.getPrintJob; } });
Object.defineProperty(exports, "getPrintQueueExport", { enumerable: true, get: function () { return functions_8.getPrintQueueExport; } });
Object.defineProperty(exports, "getPrintArtworkLibrary", { enumerable: true, get: function () { return functions_8.getPrintArtworkLibrary; } });
Object.defineProperty(exports, "getPrintArtworkDownload", { enumerable: true, get: function () { return functions_8.getPrintArtworkDownload; } });
Object.defineProperty(exports, "createPrintShopUser", { enumerable: true, get: function () { return functions_8.createPrintShopUser; } });
// setPrintJobStatus — the printer advances a POD order ('printed' internal
// milestone / 'shipped' fulfilment → customer email + reviews trigger). Same
// callable-projection auth as the print queue callables; lives in its own file
// because it declares the RESEND_API_KEY secret for the server-side status email.
var setPrintJobStatus_1 = require("./print/setPrintJobStatus");
Object.defineProperty(exports, "setPrintJobStatus", { enumerable: true, get: function () { return setPrintJobStatus_1.setPrintJobStatus; } });
// processPodArtwork — the server-authoritative artwork pipeline (sharp):
// convert-to-PNG + trim + sRGB + BLOCKING 300-DPI contain gate (docs/POD_PRINT_SPEC.md).
var processArtwork_1 = require("./pod/processArtwork");
Object.defineProperty(exports, "processPodArtwork", { enumerable: true, get: function () { return processArtwork_1.processPodArtwork; } });
// Landing-page lead form ("Vill du ha en egen butik?") — public callable that
// writes a platform-level `leads` doc + best-effort admin notification email.
var submitLead_1 = require("./leads/submitLead");
Object.defineProperty(exports, "submitLead", { enumerable: true, get: function () { return submitLead_1.submitLead; } });
// Abandoned-checkout recovery ("Övergiven kassa" add-on): a scheduled sweep that
// reminds buyers who created a PaymentIntent but never completed the order, plus
// two public callables the storefront recovery/unsubscribe pages call.
var sweep_1 = require("./checkout-recovery/sweep");
Object.defineProperty(exports, "sweepAbandonedCheckouts", { enumerable: true, get: function () { return sweep_1.sweepAbandonedCheckouts; } });
var callables_1 = require("./checkout-recovery/callables");
Object.defineProperty(exports, "resolveCheckoutRecovery", { enumerable: true, get: function () { return callables_1.resolveCheckoutRecovery; } });
Object.defineProperty(exports, "unsubscribeCheckout", { enumerable: true, get: function () { return callables_1.unsubscribeCheckout; } });
// Native product reviews ("Recensioner" add-on): an order trigger that schedules
// a review request when a B2C order is fulfilled, a scheduled sweep that emails
// the request, and the public/admin callables the storefront + admin pages call.
var writeReviewRequest_1 = require("./product-reviews/writeReviewRequest");
Object.defineProperty(exports, "onOrderReviewQualify", { enumerable: true, get: function () { return writeReviewRequest_1.onOrderReviewQualify; } });
var sweep_2 = require("./product-reviews/sweep");
Object.defineProperty(exports, "sweepReviewRequests", { enumerable: true, get: function () { return sweep_2.sweepReviewRequests; } });
var callables_2 = require("./product-reviews/callables");
Object.defineProperty(exports, "resolveReviewRequest", { enumerable: true, get: function () { return callables_2.resolveReviewRequest; } });
Object.defineProperty(exports, "submitReview", { enumerable: true, get: function () { return callables_2.submitReview; } });
Object.defineProperty(exports, "unsubscribeReviews", { enumerable: true, get: function () { return callables_2.unsubscribeReviews; } });
Object.defineProperty(exports, "moderateReview", { enumerable: true, get: function () { return callables_2.moderateReview; } });
// Ångerfunktion — consumer right-of-withdrawal function (DAL 2 kap. 10 a § /
// CRD Art. 11a, in force 19 June 2026). Server-authoritative: stamps the
// submission time, enforces eligibility (Regime A applies / Regime B exempt),
// persists a durable acknowledgement of receipt. See memory angerratt_pod.md.
var functions_9 = require("./withdrawal/functions");
Object.defineProperty(exports, "submitWithdrawal", { enumerable: true, get: function () { return functions_9.submitWithdrawal; } });
// Content Studio ("Innehållsstudio" add-on): two PURE-COMPUTE callables. Both
// are auth+opt-in gated (requireContentStudio) and never write Firestore — the
// client persists results onto socialPosts docs. generateSocialCopy turns a
// description into per-channel social copy; renderSocialVideo assembles a
// vertical beat-cut clip from the shop's uploads and returns a download URL.
var generateSocialCopy_1 = require("./content-studio/generateSocialCopy");
Object.defineProperty(exports, "generateSocialCopy", { enumerable: true, get: function () { return generateSocialCopy_1.generateSocialCopy; } });
var renderSocialVideo_1 = require("./content-studio/renderSocialVideo");
Object.defineProperty(exports, "renderSocialVideo", { enumerable: true, get: function () { return renderSocialVideo_1.renderSocialVideo; } });
// getHandoffPackage: token-guarded PUBLIC projection for the "Skicka till
// mobilen" QR flow — the phone is not logged in and gets only copy + video URL.
var getHandoffPackage_1 = require("./content-studio/getHandoffPackage");
Object.defineProperty(exports, "getHandoffPackage", { enumerable: true, get: function () { return getHandoffPackage_1.getHandoffPackage; } });
// OLD V1/V2/V3 EMAIL SYSTEM FUNCTIONS - MOVED TO QUARANTINE
// All old email functions have been migrated to the new Email Orchestrator system
// Old files moved to: functions/quarantine/old-email-systems/
// New system: functions/src/email-orchestrator/ 
//# sourceMappingURL=index.js.map