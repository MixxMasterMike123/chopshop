"use strict";
// EmailOrchestrator - Master Email Controller
// Single entry point for ALL email operations on the platform.
// MULTI-TENANT IDENTITY (Option 1, 2026-07-03): callers thread `shopId` in the
// context; the orchestrator loads that shop's Store Identity and sends as
// `"{shopName}" <no-reply@platform-domain>` with replyTo = shop supportEmail.
// Without a shopId the neutral platform defaults apply.
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmailOrchestrator = void 0;
const UserResolver_1 = require("../services/UserResolver");
const database_1 = require("../../config/database");
const EmailService_1 = require("../services/EmailService");
const orderConfirmation_1 = require("../templates/orderConfirmation");
const orderStatusUpdate_1 = require("../templates/orderStatusUpdate");
const orderNotificationAdmin_1 = require("../templates/orderNotificationAdmin");
const passwordReset_1 = require("../templates/passwordReset");
const loginCredentials_1 = require("../templates/loginCredentials");
const affiliateWelcome_1 = require("../templates/affiliateWelcome");
const emailVerification_1 = require("../templates/emailVerification");
const affiliateApplicationReceived_1 = require("../templates/affiliateApplicationReceived");
const affiliateApplicationNotificationAdmin_1 = require("../templates/affiliateApplicationNotificationAdmin");
const refundConfirmation_1 = require("../templates/refundConfirmation");
const disputeAlertAdmin_1 = require("../templates/disputeAlertAdmin");
const connectStatusChange_1 = require("../templates/connectStatusChange");
const abandonedCheckoutReminder_1 = require("../templates/abandonedCheckoutReminder");
const reviewRequest_1 = require("../templates/reviewRequest");
const printOrderNotification_1 = require("../templates/printOrderNotification");
const emailLayout_1 = require("../templates/emailLayout");
const config_1 = require("./config");
const app_urls_1 = require("../../config/app-urls");
// Admin email types that must ALWAYS reach the PLATFORM operator, never the
// shop — even though a shopId is threaded for identity/branding. These are
// platform-level concerns (financial/legal risk, new-merchant sales lead), not
// something the shop owner handles. Everything else with adminEmail:true is a
// shop-scoped notification and routes to the shop's own inbox (see sendEmail).
const PLATFORM_ONLY_ADMIN_EMAILS = new Set([
    'DISPUTE_ALERT_ADMIN',
    'LEAD_NOTIFICATION_ADMIN',
    'INFRINGEMENT_REPORT_ADMIN', // notice & takedown — the SHOP is the reported party
]);
// Regex for a syntactically valid email.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// A syntactically-valid address is NOT necessarily a REAL one. The generic
// storefront ships `supportEmail: 'hello@example.com'` (src/config/store.js) as
// a placeholder; a shop that never edited it must be treated as UNCONFIGURED —
// otherwise the placeholder leaks into reply-to and admin routing. Mirrors the
// storefront's own placeholder check in src/utils/legalPageReadiness.js.
const isRealEmail = (v) => {
    if (typeof v !== 'string')
        return false;
    const s = v.trim();
    return EMAIL_RE.test(s) && !/@example\.(com|org|net|se)$/i.test(s);
};
class EmailOrchestrator {
    constructor() {
        this.userResolver = new UserResolver_1.UserResolver();
        this.emailService = new EmailService_1.EmailService();
        console.log('🎼 EmailOrchestrator: Initialized with unified email system');
    }
    /**
     * The shop's ACTIVE admin users' emails — the zero-configuration tier of the
     * admin-notification resolution (after storeIdentity fields / ownerEmail,
     * before the platform fallback). Excludes platform operators (they manage
     * many shops but run none) and inactive users; capped to avoid spamming a
     * shop that has many staff accounts. Reply-To is NOT affected by this — a
     * personal admin email must never become the customer-facing reply address
     * unless the shop explicitly sets it as Support-e-post.
     */
    async resolveShopAdminEmails(shopId) {
        try {
            const snap = await database_1.db
                .collection('users')
                .where('shopId', '==', shopId)
                .where('role', '==', 'admin')
                .get();
            const emails = snap.docs
                .map((d) => d.data())
                // platform !== true (field may be absent on shop admins — a `!=` query
                // would exclude docs missing the field, so filter in code)
                .filter((u) => u.platform !== true && u.active !== false && isRealEmail(u.email))
                .map((u) => u.email.trim().toLowerCase());
            return [...new Set(emails)].slice(0, 5);
        }
        catch (e) {
            console.warn(`⚠️ EmailOrchestrator: resolveShopAdminEmails(${shopId}) failed:`, e?.message);
            return [];
        }
    }
    /**
     * The ACTIVE print_shop users assigned to a shop — the recipients of the
     * "Ny POD-order" notification. A printer is assigned when its printShopShops
     * array contains this shopId; role must be print_shop and active must not be
     * false (mirrors printGuard's live-doc authority). Emails validated with the
     * same isRealEmail placeholder guard used everywhere else, deduped, capped to 5.
     * Returns [] when no printer is assigned — the caller then SKIPS the send (there
     * is deliberately NO platform fallback for this type: a POD order with no printer
     * must not spam the platform inbox; it is a shop-configuration gap surfaced in logs).
     */
    async resolvePrinterEmails(shopId) {
        try {
            // Single array-contains only — combining it with a role== equality filter
            // requires a composite index that does not exist (FAILED_PRECONDITION at
            // runtime, silently swallowed below → email never sends). Filter role in
            // code instead; the printShopShops field only exists on print_shop users
            // anyway, so the read set is tiny.
            const snap = await database_1.db
                .collection('users')
                .where('printShopShops', 'array-contains', shopId)
                .get();
            const emails = snap.docs
                .map((d) => d.data())
                .filter((u) => u.role === 'print_shop' && u.active !== false && isRealEmail(u.email))
                .map((u) => u.email.trim().toLowerCase());
            return [...new Set(emails)].slice(0, 5);
        }
        catch (e) {
            console.warn(`⚠️ EmailOrchestrator: resolvePrinterEmails(${shopId}) failed:`, e?.message);
            return [];
        }
    }
    /**
     * Send the "Ny POD-order" notification to a shop's assigned printers. Fully
     * self-contained: no UserResolver, no customer/admin routing. Resolves the
     * printers off the live user docs; if none, SKIPS (no platform fallback). The
     * order data (order number, POD lines, delivery method) is passed by the caller
     * in orderData/additionalData — production-scoped, no customer PII.
     */
    async sendPrintOrderNotification(context) {
        const shopId = context.shopId;
        if (!shopId) {
            console.warn('⚠️ EmailOrchestrator: PRINT_ORDER_NOTIFICATION missing shopId — skipping');
            return { success: false, error: 'shopId required for print order notification' };
        }
        const recipients = await this.resolvePrinterEmails(shopId);
        if (recipients.length === 0) {
            // No assigned printer → nothing to do. NOT an error (a shop may simply have
            // no printer yet); log so the gap is visible. NEVER falls back to platform.
            console.log(`📭 EmailOrchestrator: PRINT_ORDER_NOTIFICATION for shop "${shopId}" has no active assigned printer — skipping send (no platform fallback).`);
            return { success: true, details: { skipped: true, reason: 'no-printer-assigned' } };
        }
        // Shop identity for brand-name + logo (best-effort, neutral fallback).
        const shopIdentity = await this.loadShopIdentity(shopId);
        const brandName = shopIdentity?.shopName || config_1.EMAIL_CONFIG.SMTP.FROM_NAME;
        const od = context.orderData || {};
        const lines = Array.isArray(context.additionalData?.lines) ? context.additionalData.lines : [];
        (0, emailLayout_1.setShellLogoUrl)(shopIdentity?.logoUrl);
        let template;
        try {
            template = (0, printOrderNotification_1.generatePrintOrderNotificationTemplate)({
                orderNumber: String(od.orderNumber || context.orderId || ''),
                shopName: brandName,
                deliveryMethod: od.deliveryMethod === 'pickup' ? 'pickup' : 'home',
                lines,
                printPortalUrl: context.additionalData?.printPortalUrl || 'https://print-meteorpr.web.app',
                brandName,
            });
        }
        finally {
            (0, emailLayout_1.setShellLogoUrl)(undefined);
        }
        // Send directly to the printers. Reuses sendAdminEmail's extraAdminRecipients
        // REPLACE semantics (a non-empty extras list REPLACES the platform recipients),
        // so the platform ADMIN_RECIPIENTS are never mailed for this type. The from-name
        // carries no "System" suffix (getFromAddress omits it for this type).
        const result = await this.emailService.sendAdminEmail(template, {
            from: this.getFromAddress('PRINT_ORDER_NOTIFICATION', 'B2C', brandName),
            ...(shopIdentity?.supportEmail ? { replyTo: shopIdentity.supportEmail } : {}),
            extraAdminRecipients: recipients,
        });
        if (result.success) {
            console.log(`✅ EmailOrchestrator: PRINT_ORDER_NOTIFICATION sent to ${recipients.length} printer(s) for shop "${shopId}"`);
            return {
                success: true,
                messageId: result.messageId,
                details: { emailType: 'PRINT_ORDER_NOTIFICATION', recipients: recipients.length, subject: template.subject },
            };
        }
        console.error('❌ EmailOrchestrator: PRINT_ORDER_NOTIFICATION send failed:', result.error);
        return { success: false, error: result.error };
    }
    /**
     * Master email sending method
     * Single entry point for ALL emails in the system
     */
    async sendEmail(context) {
        try {
            console.log('🎼 EmailOrchestrator: Processing email request');
            console.log('🎼 EmailOrchestrator: Email type:', context.emailType);
            console.log('🎼 EmailOrchestrator: Context:', {
                userId: context.userId,
                b2cCustomerId: context.b2cCustomerId,
                customerEmail: context.customerInfo?.email,
                source: context.source,
                adminEmail: context.adminEmail
            });
            // PRINT_ORDER_NOTIFICATION is a special case: it has NO customer/user to
            // resolve (it goes to the shop's assigned printers), so it bypasses the
            // UserResolver + the customer/shop-admin routing entirely. Recipients are
            // the ACTIVE print_shop users for this shop; if there are none we SKIP the
            // send (deliberately NO platform fallback — see resolvePrinterEmails).
            if (context.emailType === 'PRINT_ORDER_NOTIFICATION') {
                return await this.sendPrintOrderNotification(context);
            }
            // Step 1: Resolve user data
            const userData = await this.userResolver.resolve(context);
            console.log('✅ EmailOrchestrator: User resolved:', {
                email: userData.email,
                type: userData.type,
                name: userData.name
            });
            // Step 2: Determine language
            const language = context.language || userData.language || 'sv-SE';
            console.log('🌍 EmailOrchestrator: Language selected:', language);
            // Step 2b: Resolve the tenant's sender identity (neutral fallback).
            const shopIdentity = await this.loadShopIdentity(context.shopId);
            const brandName = shopIdentity?.shopName || config_1.EMAIL_CONFIG.SMTP.FROM_NAME;
            // Step 3: Generate template. Set the per-shop logo for the shared shell
            // header synchronously right before generation (templates read it via the
            // shell); always clear it afterwards so nothing bleeds into a later send.
            // ⚠️ INVARIANT: concurrency-safe ONLY because every template generator is
            // fully synchronous (no await between set and read). If a generator ever
            // needs async work, thread logoUrl as an argument instead.
            (0, emailLayout_1.setShellLogoUrl)(shopIdentity?.logoUrl);
            let template;
            try {
                template = await this.generateTemplate(context.emailType, {
                    userData,
                    language,
                    orderData: context.orderData,
                    additionalData: context.additionalData,
                    context,
                    brandName
                });
            }
            finally {
                (0, emailLayout_1.setShellLogoUrl)(undefined);
            }
            console.log('📧 EmailOrchestrator: Template generated:', template.subject);
            // Step 4: Prepare email options
            // One-click List-Unsubscribe (RFC 8058) — set ONLY for the marketing-ish
            // abandoned-checkout reminder, whose unsubscribe URL comes in additionalData.
            const unsubscribeUrl = context.additionalData?.unsubscribeUrl;
            const listUnsubHeaders = (context.emailType === 'ABANDONED_CHECKOUT_REMINDER' ||
                context.emailType === 'REVIEW_REQUEST') && unsubscribeUrl
                ? {
                    'List-Unsubscribe': `<${unsubscribeUrl}>`,
                    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                }
                : undefined;
            const emailOptions = {
                to: userData.email,
                from: this.getFromAddress(context.emailType, userData.type, shopIdentity?.shopName),
                // Replies go to the SHOP, not the platform (when the shop has set one).
                ...(shopIdentity?.supportEmail ? { replyTo: shopIdentity.supportEmail } : {}),
                ...(listUnsubHeaders ? { headers: listUnsubHeaders } : {}),
            };
            // Step 5: Send email
            let result;
            if (context.adminEmail) {
                console.log('📧 EmailOrchestrator: Sending admin email');
                // Multi-tenant admin routing. Shop-scoped notifications (e.g. new-order,
                // affiliate application) go to the SHOP's own notification address — the
                // shop owner runs everything around their shop. Resolution precedence is
                // in loadShopIdentity (notificationEmail → contactEmail → supportEmail →
                // ownerEmail). When the shop resolved a real address it is used INSTEAD
                // of the platform admins (extraAdminRecipients replaces, see below);
                // when it did not, we fall back to the platform admins and warn loudly so
                // a misconfigured shop is visible in the logs.
                let extraAdminRecipients = [];
                if (context.shopId && !PLATFORM_ONLY_ADMIN_EMAILS.has(context.emailType)) {
                    if (shopIdentity?.notificationEmail) {
                        extraAdminRecipients = [shopIdentity.notificationEmail];
                    }
                    else {
                        // No explicit address on storeIdentity — fall through to the shop's
                        // ACTIVE admin users (the shop's staff get shop mail with zero
                        // configuration; platform operators are excluded — they administer
                        // many shops but run none).
                        extraAdminRecipients = await this.resolveShopAdminEmails(context.shopId);
                        if (extraAdminRecipients.length === 0) {
                            console.warn(`⚠️ EmailOrchestrator: shop "${context.shopId}" has no notification/contact/support/owner email ` +
                                `AND no active admin user with a real email — ` +
                                `admin ${context.emailType} email falling back to platform recipients (${config_1.EMAIL_CONFIG.ADMIN_RECIPIENTS.join(', ')}). ` +
                                `Set storeIdentity.supportEmail or add an admin user for this shop.`);
                        }
                    }
                }
                result = await this.emailService.sendAdminEmail(template, { ...emailOptions, extraAdminRecipients });
            }
            else {
                console.log('📧 EmailOrchestrator: Sending customer email');
                result = await this.emailService.sendEmail(template, emailOptions);
            }
            if (result.success) {
                console.log('✅ EmailOrchestrator: Email sent successfully');
                return {
                    success: true,
                    messageId: result.messageId,
                    details: {
                        emailType: context.emailType,
                        recipient: userData.email,
                        userType: userData.type,
                        language: language,
                        subject: template.subject
                    }
                };
            }
            else {
                console.error('❌ EmailOrchestrator: Email sending failed:', result.error);
                return {
                    success: false,
                    error: result.error
                };
            }
        }
        catch (error) {
            console.error('❌ EmailOrchestrator: Fatal error:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown orchestrator error'
            };
        }
    }
    /**
     * Generate email template based on type and context
     */
    // Load the tenant's Store Identity slice for sender identity. Best-effort:
    // any failure falls back to the neutral platform defaults (an email must
    // never fail because a shop doc read did).
    async loadShopIdentity(shopId) {
        if (!shopId)
            return null;
        try {
            const snap = await database_1.db.collection('shops').doc(shopId).get();
            if (!snap.exists)
                return null;
            const shop = snap.data() || {};
            const si = shop.storeIdentity || {};
            const shopName = typeof si.shopName === 'string' && si.shopName.trim() ? si.shopName.trim() : undefined;
            // Reply-to = the shop's PUBLIC support address (placeholder rejected).
            const supportEmail = isRealEmail(si.supportEmail) ? si.supportEmail.trim() : undefined;
            // Only absolute http(s) logos are usable in email (client default is a
            // relative /images/logo.svg the shell must ignore). Prefer the EMAIL-SAFE
            // variant (emailLogoUrl): storefront logos are often transparent PNGs,
            // and email clients (Gmail's image proxy, dark mode) flatten transparency
            // to BLACK — a dark wordmark becomes an unreadable black box. The email
            // variant has its background baked in.
            const asAbsoluteUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v.trim()) ? v.trim() : undefined;
            const logoUrl = asAbsoluteUrl(si.emailLogoUrl) || asAbsoluteUrl(si.logoUrl);
            // Admin/order-notification recipient for this shop, in precedence order.
            // A dedicated notificationEmail wins (a shop may want orders routed to a
            // back-office inbox ≠ its public support address); then contactEmail;
            // then the public supportEmail; then the shop owner's account email.
            // First REAL (non-placeholder) match wins.
            const notificationEmail = (isRealEmail(si.notificationEmail) && si.notificationEmail.trim()) ||
                (isRealEmail(si.contactEmail) && si.contactEmail.trim()) ||
                (isRealEmail(si.supportEmail) && si.supportEmail.trim()) ||
                (isRealEmail(shop.ownerEmail) && shop.ownerEmail.trim()) ||
                undefined;
            return { shopName, supportEmail, logoUrl, notificationEmail: notificationEmail || undefined };
        }
        catch (error) {
            console.warn('⚠️ EmailOrchestrator: shop identity load failed (using platform defaults):', error);
            return null;
        }
    }
    async generateTemplate(emailType, data) {
        console.log('📝 EmailOrchestrator: Generating template for:', emailType);
        switch (emailType) {
            case 'ORDER_CONFIRMATION':
                if (!data.orderData) {
                    throw new Error('Order data is required for order confirmation email');
                }
                const orderConfirmationData = {
                    orderData: data.orderData,
                    customerInfo: {
                        email: data.userData.email,
                        name: data.userData.name,
                        firstName: data.context.customerInfo?.firstName,
                        lastName: data.context.customerInfo?.lastName
                    },
                    orderId: data.context.orderId || '',
                    orderType: data.userData.type === 'B2B' ? 'B2B' : 'B2C',
                    brandName: data.brandName
                };
                return (0, orderConfirmation_1.generateOrderConfirmationTemplate)(orderConfirmationData, data.language, data.context.orderId);
            case 'ORDER_STATUS_UPDATE':
                if (!data.orderData) {
                    throw new Error('Order data is required for order status update email');
                }
                const orderStatusData = {
                    orderData: data.orderData,
                    userData: data.userData,
                    newStatus: data.additionalData?.newStatus || data.orderData.status,
                    previousStatus: data.additionalData?.previousStatus,
                    trackingNumber: data.additionalData?.trackingNumber,
                    estimatedDelivery: data.additionalData?.estimatedDelivery,
                    notes: data.additionalData?.notes,
                    // Click & Collect: pickup location name for the ready_for_pickup step.
                    // Prefer an explicit additionalData value, else read the order doc.
                    pickupLocationName: data.additionalData?.pickupLocationName || data.orderData?.pickupLocation?.name,
                    userType: data.userData.type,
                    brandName: data.brandName
                };
                return (0, orderStatusUpdate_1.generateOrderStatusUpdateTemplate)(orderStatusData, data.language, data.context.orderId);
            case 'ORDER_NOTIFICATION_ADMIN':
                if (!data.orderData) {
                    throw new Error('Order data is required for admin notification email');
                }
                const adminNotificationData = {
                    orderData: {
                        orderNumber: data.orderData.orderNumber || data.context.orderId || '',
                        source: data.context.source,
                        shopId: data.orderData.shopId || data.context.shopId,
                        orderId: data.context.orderId,
                        customerInfo: {
                            firstName: data.context.customerInfo?.firstName,
                            lastName: data.context.customerInfo?.lastName,
                            name: data.userData.name,
                            email: data.userData.email,
                            companyName: data.userData.companyName,
                            contactPerson: data.userData.contactPerson,
                            phone: data.userData.phone,
                            address: data.userData.address,
                            city: data.userData.city,
                            postalCode: data.userData.postalCode,
                            marginal: data.userData.marginal,
                        },
                        shippingInfo: data.orderData.shippingInfo,
                        // Click & Collect: carry pickup fields so the admin mail shows an
                        // "Upphämtning" section instead of a "SE"-only shipping address.
                        deliveryMethod: data.orderData.deliveryMethod,
                        pickupLocation: data.orderData.pickupLocation,
                        items: data.orderData.items || [],
                        subtotal: data.orderData.subtotal || 0,
                        shipping: data.orderData.shipping || 0,
                        vat: data.orderData.vat || 0,
                        total: data.orderData.total || 0,
                        discountAmount: data.orderData.discountAmount,
                        affiliateCode: data.orderData.affiliateCode,
                        affiliate: data.orderData.affiliate,
                        payment: data.orderData.payment,
                        createdAt: data.orderData.createdAt,
                    },
                    orderSummary: data.additionalData?.orderSummary,
                    orderType: data.userData.type === 'B2B' ? 'B2B' : 'B2C',
                    brandName: data.brandName
                };
                return (0, orderNotificationAdmin_1.generateOrderNotificationAdminTemplate)(adminNotificationData, data.language);
            case 'LOGIN_CREDENTIALS':
                if (!data.additionalData?.credentials) {
                    throw new Error('Credentials data is required for login credentials email');
                }
                const loginCredentialsData = {
                    userInfo: {
                        name: data.userData.name || data.userData.contactPerson || '',
                        email: data.userData.email,
                        companyName: data.userData.companyName,
                        contactPerson: data.userData.contactPerson
                    },
                    credentials: data.additionalData.credentials,
                    accountType: (data.additionalData.accountType === 'AFFILIATE') ? 'AFFILIATE' : 'B2B',
                    wasExistingAuthUser: data.additionalData.wasExistingAuthUser || false,
                    brandName: data.brandName
                };
                return (0, loginCredentials_1.generateLoginCredentialsTemplate)(loginCredentialsData, data.language);
            case 'PASSWORD_RESET':
                if (!data.additionalData?.resetCode) {
                    throw new Error('Reset code is required for password reset email');
                }
                const passwordResetData = {
                    email: data.userData.email,
                    resetCode: data.additionalData.resetCode,
                    userAgent: data.additionalData.userAgent,
                    timestamp: data.additionalData.timestamp,
                    userType: data.additionalData.userType || (data.userData.type === 'B2B' ? 'B2B' : 'B2C'),
                    brandName: data.brandName
                };
                return (0, passwordReset_1.generatePasswordResetTemplate)(passwordResetData, data.language);
            case 'AFFILIATE_WELCOME':
                if (!data.additionalData?.affiliateInfo || !data.additionalData?.credentials) {
                    throw new Error('Affiliate info and credentials are required for affiliate welcome email');
                }
                const affiliateWelcomeData = {
                    affiliateInfo: data.additionalData.affiliateInfo,
                    credentials: data.additionalData.credentials,
                    wasExistingAuthUser: data.additionalData.wasExistingAuthUser || false,
                    language: data.language,
                    brandName: data.brandName
                };
                return (0, affiliateWelcome_1.generateAffiliateWelcomeTemplate)(affiliateWelcomeData);
            case 'EMAIL_VERIFICATION':
                if (!data.additionalData?.verificationCode) {
                    throw new Error('Verification code is required for email verification');
                }
                const emailVerificationData = {
                    customerInfo: {
                        firstName: data.context.customerInfo?.firstName,
                        lastName: data.context.customerInfo?.lastName,
                        name: data.context.customerInfo?.name || data.userData.name,
                        email: data.userData.email
                    },
                    verificationCode: data.additionalData.verificationCode,
                    language: data.language,
                    source: data.additionalData.source,
                    brandName: data.brandName
                };
                return (0, emailVerification_1.generateEmailVerificationTemplate)(emailVerificationData);
            case 'AFFILIATE_APPLICATION_RECEIVED':
                if (!data.additionalData?.applicantInfo || !data.additionalData?.applicationId) {
                    throw new Error('Affiliate application received requires applicantInfo and applicationId');
                }
                return {
                    subject: data.language === 'en-GB' || data.language === 'en-US'
                        ? `Affiliate Application Received - ${data.brandName}`
                        : `Affiliate-ansökan mottagen - ${data.brandName}`,
                    html: (0, affiliateApplicationReceived_1.generateAffiliateApplicationReceivedTemplate)({
                        applicantInfo: data.additionalData.applicantInfo,
                        applicationId: data.additionalData.applicationId,
                        language: data.language,
                        brandName: data.brandName
                    }),
                    text: `Thank you for your affiliate application! Your application ID: ${data.additionalData.applicationId}`
                };
            case 'AFFILIATE_APPLICATION_NOTIFICATION_ADMIN':
                if (!data.additionalData?.applicantInfo || !data.additionalData?.applicationId) {
                    throw new Error('Affiliate application admin notification requires applicantInfo and applicationId');
                }
                return {
                    subject: `Ny Affiliate-ansökan: ${data.additionalData.applicantInfo.name}`,
                    html: (0, affiliateApplicationNotificationAdmin_1.generateAffiliateApplicationNotificationAdminTemplate)({
                        applicantInfo: data.additionalData.applicantInfo,
                        applicationId: data.additionalData.applicationId,
                        adminPortalUrl: data.additionalData.adminPortalUrl || config_1.EMAIL_CONFIG.URLS.B2B_PORTAL,
                        brandName: data.brandName
                    }),
                    text: `New affiliate application from ${data.additionalData.applicantInfo.name} (${data.additionalData.applicantInfo.email}). Application ID: ${data.additionalData.applicationId}`
                };
            case 'LEAD_NOTIFICATION_ADMIN': {
                // Platform-admin alert: a prospective merchant submitted the landing-
                // page lead form ("Vill du ha en egen butik?"). Fired best-effort from
                // leads/submitLead.ts AFTER the lead doc is written. Platform-level —
                // no shop identity involved.
                const lead = data.additionalData?.lead;
                if (!lead) {
                    throw new Error('Lead data is required for lead admin notification');
                }
                const leadBody = (0, emailLayout_1.renderHeading)('Ny intresseanmälan — egen butik') +
                    (0, emailLayout_1.renderParagraph)('Någon har skickat in lead-formuläret på landningssidan.') +
                    (0, emailLayout_1.renderKeyValueRows)([
                        { label: 'Namn', value: String(lead.name || '') },
                        { label: 'Företag', value: String(lead.company || '—') },
                        { label: 'E-post', value: String(lead.email || '') },
                        { label: 'Lead-ID', value: String(data.additionalData?.leadId || '') },
                    ]) +
                    (lead.message ? (0, emailLayout_1.renderPanel)((0, emailLayout_1.renderParagraph)(String(lead.message)), 'Meddelande') : '') +
                    (0, emailLayout_1.renderParagraph)('Leaden är sparad i `leads` med status "new".', { muted: true });
                return {
                    subject: `Ny intresseanmälan: ${lead.name || lead.email}`,
                    html: (0, emailLayout_1.renderEmailShell)({
                        brandName: data.brandName,
                        bodyHtml: leadBody,
                        preheader: `Ny intresseanmälan från ${lead.name || lead.email}`,
                    }),
                    text: `Ny intresseanmälan — egen butik\n` +
                        `Namn: ${lead.name || ''}\nFöretag: ${lead.company || ''}\n` +
                        `E-post: ${lead.email || ''}\n\n${lead.message || ''}`
                };
            }
            case 'INFRINGEMENT_REPORT_ADMIN': {
                // Platform-admin alert: a rights holder filed "Rapportera intrång" on a
                // storefront (SnapWear A10). Fired best-effort from
                // infringement/submitInfringementReport.ts AFTER the report doc is
                // written. Every value is reporter-typed → escaped; links only when
                // they are absolute http(s) (a pasted `javascript:` URL stays text).
                const report = data.additionalData?.report;
                if (!report) {
                    throw new Error('Report data is required for infringement report notification');
                }
                const RIGHT_LABELS = {
                    trademark: 'Varumärke', copyright: 'Upphovsrätt', other: 'Annat',
                };
                const oneLine = (v) => String(v || '').replace(/\s+/g, ' ').trim();
                const isHttp = (v) => typeof v === 'string' && /^https?:\/\//i.test(v.trim());
                const productLabel = oneLine(report.productName) || oneLine(report.productUrl) || 'okänd produkt';
                const reportsUrl = String(data.additionalData?.reportsUrl || '');
                const infringementBody = (0, emailLayout_1.renderHeading)('Ny intrångsanmälan') +
                    (0, emailLayout_1.renderParagraph)('En rättighetshavare har anmält en produkt via "Rapportera intrång". Granska inom 24 timmar.') +
                    (0, emailLayout_1.renderKeyValueRows)([
                        { label: 'Butik', value: `${oneLine(report.shopName)} (${oneLine(report.shopId)})` },
                        { label: 'Produkt', value: productLabel },
                        { label: 'Produkt-ID', value: oneLine(report.productId) || '— (ej matchad)' },
                        { label: 'Rättighet', value: RIGHT_LABELS[report.rightType] || String(report.rightType || '') },
                        { label: 'Anmälare', value: oneLine(report.reporterName) },
                        { label: 'Organisation', value: oneLine(report.reporterOrg) || '—' },
                        { label: 'E-post', value: oneLine(report.reporterEmail) },
                        { label: 'Ärende-ID', value: String(data.additionalData?.reportId || '') },
                    ]) +
                    (0, emailLayout_1.renderPanel)((0, emailLayout_1.renderParagraph)(String(report.description || '')), 'Beskrivning') +
                    (isHttp(report.productUrl)
                        ? (0, emailLayout_1.renderParagraph)(`Produktlänk: ${(0, emailLayout_1.renderTextLink)(report.productUrl.trim(), (0, emailLayout_1.esc)(report.productUrl.trim()))}`, { html: true })
                        : '') +
                    (isHttp(reportsUrl) ? (0, emailLayout_1.renderButton)(reportsUrl, 'Öppna Anmälningar') : '') +
                    (0, emailLayout_1.renderParagraph)('Anmälan är sparad i `infringementReports` med status "new".', { muted: true });
                return {
                    subject: `⚠️ Intrångsanmälan: ${oneLine(report.shopName) || oneLine(report.shopId)} / ${productLabel}`.slice(0, 200),
                    html: (0, emailLayout_1.renderEmailShell)({
                        brandName: data.brandName,
                        bodyHtml: infringementBody,
                        preheader: `Intrångsanmälan mot ${productLabel}`,
                    }),
                    text: `Ny intrångsanmälan\n` +
                        `Butik: ${oneLine(report.shopName)} (${oneLine(report.shopId)})\n` +
                        `Produkt: ${productLabel}${report.productId ? ` [${report.productId}]` : ''}\n` +
                        `Rättighet: ${RIGHT_LABELS[report.rightType] || report.rightType}\n` +
                        `Anmälare: ${oneLine(report.reporterName)} ${report.reporterOrg ? `(${oneLine(report.reporterOrg)}) ` : ''}<${oneLine(report.reporterEmail)}>\n\n` +
                        `${report.description || ''}\n\n${report.productUrl || ''}\n${reportsUrl}`
                };
            }
            case 'WITHDRAWAL_ACKNOWLEDGMENT': {
                // Mottagningsbevis (acknowledgement of receipt) for an exercised right of
                // withdrawal — DAL 2 kap. 10 a § / CRD Art. 11a. Must include the content
                // + the date and time of submission. The durable acknowledgement object
                // is computed server-side in withdrawal/functions.ts and passed through.
                const ack = data.additionalData?.acknowledgement || data.orderData?.acknowledgement;
                if (!ack) {
                    throw new Error('Acknowledgement data is required for withdrawal acknowledgement email');
                }
                // Legal content (order number, submittedAt, withdrawn items, statement,
                // "spara detta mottagningsbevis" instruction) is preserved verbatim — only
                // the presentation is restyled onto the shared NORD shell.
                const withdrawnItems = Array.isArray(ack.withdrawnItems) && ack.withdrawnItems.length
                    ? ack.withdrawnItems.map((it) => `${(0, emailLayout_1.esc)(it.name || '')}${it.sku ? ` (${(0, emailLayout_1.esc)(it.sku)})` : ''} × ${(0, emailLayout_1.esc)(it.quantity || 1)}`)
                    : [];
                const ackBody = (0, emailLayout_1.renderHeading)('Mottagningsbevis – ångrat köp') +
                    (0, emailLayout_1.renderParagraph)(`Hej ${(0, emailLayout_1.esc)(ack.consumerName || '')},`) +
                    (0, emailLayout_1.renderParagraph)('Vi bekräftar att vi har tagit emot ditt meddelande om att du ångrar ditt köp.') +
                    (0, emailLayout_1.renderKeyValueRows)([
                        { label: 'Order', value: String(ack.orderNumber || '') },
                        { label: 'Mottaget', value: String(ack.submittedAt || '') },
                    ]) +
                    (withdrawnItems.length
                        ? (0, emailLayout_1.renderPanel)((0, emailLayout_1.renderList)(withdrawnItems), 'Ångrade varor')
                        : '') +
                    (ack.statement ? (0, emailLayout_1.renderParagraph)(String(ack.statement)) : '') +
                    (0, emailLayout_1.renderParagraph)('Spara detta mottagningsbevis. Återbetalning hanteras enligt våra villkor.', { muted: true });
                return {
                    subject: `Mottagningsbevis – ångrat köp ${ack.orderNumber || ''}`.trim(),
                    html: (0, emailLayout_1.renderEmailShell)({
                        brandName: data.brandName,
                        bodyHtml: ackBody,
                        preheader: `Mottagningsbevis – ångrat köp ${ack.orderNumber || ''}`.trim(),
                    }),
                    text: `Mottagningsbevis – ångrat köp ${ack.orderNumber || ''}\n` +
                        `Mottaget: ${ack.submittedAt || ''}\n` +
                        `${ack.statement || ''}\n` +
                        `Spara detta mottagningsbevis. Återbetalning hanteras enligt våra villkor.`
                };
            }
            case 'REFUND_CONFIRMATION': {
                // Buyer-facing refund receipt. Fired from connectRefund.ts after the
                // refund succeeds. `refundAmountSek` = amount actually refunded (partial
                // or full); `isFullRefund` distinguishes the copy; `hasWithdrawal` adds
                // the ångerrätt-completion line when the order carried a withdrawalRequest.
                const ad = data.additionalData || {};
                return (0, refundConfirmation_1.generateRefundConfirmationTemplate)({
                    orderNumber: String(ad.orderNumber || data.orderData?.orderNumber || data.context.orderId || ''),
                    refundAmountSek: Number(ad.refundAmountSek || 0),
                    currency: ad.currency || 'SEK',
                    isFullRefund: ad.isFullRefund !== false,
                    hasWithdrawal: !!ad.hasWithdrawal,
                    customerName: data.userData.name,
                    brandName: data.brandName,
                });
            }
            case 'DISPUTE_ALERT_ADMIN': {
                // Platform-admin alert for a chargeback / shortfall. Best-effort from the
                // Stripe webhook. Names the shop so a multi-shop platform inbox can triage.
                const ad = data.additionalData || {};
                return (0, disputeAlertAdmin_1.generateDisputeAlertAdminTemplate)({
                    shopId: ad.shopId,
                    shopName: ad.shopName,
                    orderId: ad.orderId,
                    orderNumber: ad.orderNumber,
                    disputeId: ad.disputeId,
                    reason: ad.reason,
                    amount: ad.amount,
                    status: ad.status,
                    alertKind: ad.alertKind === 'shortfall' ? 'shortfall' : 'dispute',
                    recoveryStatus: ad.recoveryStatus,
                    brandName: data.brandName,
                });
            }
            case 'CONNECT_STATUS_CHANGE': {
                // Shop-owner alert: their Stripe Connect account status changed in a way
                // that can block payouts. Fired from the account.updated webhook only on
                // meaningful transitions. CTA → the admin payments page.
                const ad = data.additionalData || {};
                // Deep-link into the MANAGED shop's admin (?shopId= handled by the SPA).
                const connectShopId = ad.shopId || data.context.shopId;
                const paymentsUrl = `${app_urls_1.appUrls.ADMIN_BASE.replace(/\/$/, '')}/admin/payments${connectShopId ? `?shopId=${encodeURIComponent(connectShopId)}` : ''}`;
                return (0, connectStatusChange_1.generateConnectStatusChangeTemplate)({
                    changes: Array.isArray(ad.changes) ? ad.changes : [],
                    paymentsUrl,
                    brandName: data.brandName,
                });
            }
            case 'ABANDONED_CHECKOUT_REMINDER': {
                // Abandoned-checkout reminder — fired best-effort from the recovery sweep
                // (checkout-recovery/sweep.ts). Sends under the SHOP's identity (from-name
                // + logo + reply-to), so shopId must be threaded by the caller. The
                // one-click unsubscribe link is in additionalData; the List-Unsubscribe
                // header is set at send time (see below).
                const ad = data.additionalData || {};
                return (0, abandonedCheckoutReminder_1.generateAbandonedCheckoutReminderTemplate)({
                    brandName: data.brandName,
                    customerFirstName: ad.customerFirstName || data.context.customerInfo?.firstName,
                    items: Array.isArray(ad.items) ? ad.items : [],
                    totals: ad.totals,
                    recoveryUrl: ad.recoveryUrl,
                    unsubscribeUrl: ad.unsubscribeUrl,
                }, data.language);
            }
            case 'REVIEW_REQUEST': {
                // Review-request email — fired best-effort from the review sweep
                // (product-reviews/sweep.ts). Sends under the SHOP's identity (from-name
                // + logo + reply-to), so shopId must be threaded by the caller. The
                // one-click unsubscribe link is in additionalData; the List-Unsubscribe
                // header is set at send time (see above).
                const ad = data.additionalData || {};
                return (0, reviewRequest_1.generateReviewRequestTemplate)({
                    brandName: data.brandName,
                    customerFirstName: ad.customerFirstName || data.context.customerInfo?.firstName,
                    items: Array.isArray(ad.items) ? ad.items : [],
                    reviewUrl: ad.reviewUrl,
                    unsubscribeUrl: ad.unsubscribeUrl,
                }, data.language);
            }
            default:
                throw new Error(`Unknown email type: ${emailType}`);
        }
    }
    /**
     * Get appropriate from address based on email type and user type
     */
    getFromAddress(emailType, _userType, shopName) {
        // Customer-facing mail sends as the SHOP (or the neutral platform name);
        // admin notifications carry a System suffix so they sort visibly.
        const brand = shopName || config_1.EMAIL_CONFIG.SMTP.FROM_NAME;
        const from = (displayName) => `"${displayName}" <${config_1.EMAIL_CONFIG.SMTP.FROM_EMAIL}>`;
        if (emailType === 'ORDER_NOTIFICATION_ADMIN' ||
            emailType === 'AFFILIATE_APPLICATION_NOTIFICATION_ADMIN' ||
            emailType === 'LEAD_NOTIFICATION_ADMIN' ||
            emailType === 'INFRINGEMENT_REPORT_ADMIN' ||
            emailType === 'DISPUTE_ALERT_ADMIN') {
            return from(`${brand} System`);
        }
        return from(brand);
    }
    /**
     * Test the complete email orchestrator system
     */
    async testSystem() {
        try {
            console.log('🧪 EmailOrchestrator: Running system test...');
            // Test SMTP connection
            const smtpTest = await this.emailService.testConnection();
            if (!smtpTest.success) {
                return {
                    success: false,
                    error: `SMTP connection failed: ${smtpTest.error}`
                };
            }
            console.log('✅ EmailOrchestrator: System test passed');
            return {
                success: true,
                details: {
                    smtp: 'connected',
                    userResolver: 'ready',
                    orchestrator: 'ready'
                }
            };
        }
        catch (error) {
            console.error('❌ EmailOrchestrator: System test failed:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'System test failed'
            };
        }
    }
}
exports.EmailOrchestrator = EmailOrchestrator;
//# sourceMappingURL=EmailOrchestrator.js.map