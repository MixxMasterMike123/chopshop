"use strict";
// EmailOrchestrator Functions Index
// Unified email functions replacing ALL V1/V2/V3 email functions
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendAffiliateApplicationEmails = exports.confirmPasswordReset = exports.verifyEmailCode = exports.sendCustomEmailVerification = exports.sendEmailVerification = exports.migrateFromWoo = exports.migrateFromShopify = exports.deletePlatformUser = exports.createPlatformSuperAdmin = exports.createShopUser = exports.approveAffiliate = exports.sendAffiliateWelcomeEmail = exports.sendLoginCredentialsEmail = exports.sendPasswordResetEmail = exports.sendOrderNotificationAdmin = exports.sendOrderStatusUpdateEmail = exports.sendOrderConfirmationEmail = void 0;
// Import all unified email functions
var sendOrderConfirmationEmail_1 = require("./sendOrderConfirmationEmail");
Object.defineProperty(exports, "sendOrderConfirmationEmail", { enumerable: true, get: function () { return sendOrderConfirmationEmail_1.sendOrderConfirmationEmail; } });
var sendOrderStatusUpdateEmail_1 = require("./sendOrderStatusUpdateEmail");
Object.defineProperty(exports, "sendOrderStatusUpdateEmail", { enumerable: true, get: function () { return sendOrderStatusUpdateEmail_1.sendOrderStatusUpdateEmail; } });
var sendOrderNotificationAdmin_1 = require("./sendOrderNotificationAdmin");
Object.defineProperty(exports, "sendOrderNotificationAdmin", { enumerable: true, get: function () { return sendOrderNotificationAdmin_1.sendOrderNotificationAdmin; } });
var sendPasswordResetEmail_1 = require("./sendPasswordResetEmail");
Object.defineProperty(exports, "sendPasswordResetEmail", { enumerable: true, get: function () { return sendPasswordResetEmail_1.sendPasswordResetEmail; } });
var sendLoginCredentialsEmail_1 = require("./sendLoginCredentialsEmail");
Object.defineProperty(exports, "sendLoginCredentialsEmail", { enumerable: true, get: function () { return sendLoginCredentialsEmail_1.sendLoginCredentialsEmail; } });
var sendAffiliateWelcomeEmail_1 = require("./sendAffiliateWelcomeEmail");
Object.defineProperty(exports, "sendAffiliateWelcomeEmail", { enumerable: true, get: function () { return sendAffiliateWelcomeEmail_1.sendAffiliateWelcomeEmail; } });
var approveAffiliate_1 = require("./approveAffiliate");
Object.defineProperty(exports, "approveAffiliate", { enumerable: true, get: function () { return approveAffiliate_1.approveAffiliate; } });
var createShopUser_1 = require("./createShopUser");
Object.defineProperty(exports, "createShopUser", { enumerable: true, get: function () { return createShopUser_1.createShopUser; } });
var platformUsers_1 = require("./platformUsers");
Object.defineProperty(exports, "createPlatformSuperAdmin", { enumerable: true, get: function () { return platformUsers_1.createPlatformSuperAdmin; } });
Object.defineProperty(exports, "deletePlatformUser", { enumerable: true, get: function () { return platformUsers_1.deletePlatformUser; } });
var migrateFromShopify_1 = require("./migrateFromShopify");
Object.defineProperty(exports, "migrateFromShopify", { enumerable: true, get: function () { return migrateFromShopify_1.migrateFromShopify; } });
var migrateFromWoo_1 = require("./migrateFromWoo");
Object.defineProperty(exports, "migrateFromWoo", { enumerable: true, get: function () { return migrateFromWoo_1.migrateFromWoo; } });
var sendEmailVerification_1 = require("./sendEmailVerification");
Object.defineProperty(exports, "sendEmailVerification", { enumerable: true, get: function () { return sendEmailVerification_1.sendEmailVerification; } });
var sendCustomEmailVerification_1 = require("./sendCustomEmailVerification");
Object.defineProperty(exports, "sendCustomEmailVerification", { enumerable: true, get: function () { return sendCustomEmailVerification_1.sendCustomEmailVerification; } });
var verifyEmailCode_1 = require("./verifyEmailCode");
Object.defineProperty(exports, "verifyEmailCode", { enumerable: true, get: function () { return verifyEmailCode_1.verifyEmailCode; } });
var confirmPasswordReset_1 = require("./confirmPasswordReset");
Object.defineProperty(exports, "confirmPasswordReset", { enumerable: true, get: function () { return confirmPasswordReset_1.confirmPasswordReset; } });
var sendAffiliateApplicationEmails_1 = require("./sendAffiliateApplicationEmails");
Object.defineProperty(exports, "sendAffiliateApplicationEmails", { enumerable: true, get: function () { return sendAffiliateApplicationEmails_1.sendAffiliateApplicationEmails; } });
// export { sendB2BApplicationEmails } from './sendB2BApplicationEmails'; // TEMPORARILY DISABLED
//# sourceMappingURL=index.js.map