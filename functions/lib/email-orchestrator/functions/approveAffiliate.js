"use strict";
// approveAffiliate - Unified Affiliate Approval Function
// Replaces: approveAffiliateV3
// Complete workflow: Creates Firebase Auth user + Affiliate record + Sends welcome email via orchestrator
Object.defineProperty(exports, "__esModule", { value: true });
exports.approveAffiliate = void 0;
const https_1 = require("firebase-functions/v2/https");
const app_urls_1 = require("../../config/app-urls");
const firestore_1 = require("firebase-admin/firestore");
const auth_1 = require("firebase-admin/auth");
const EmailOrchestrator_1 = require("../core/EmailOrchestrator");
const tenancy_1 = require("../../config/tenancy");
const shopFeatures_1 = require("../../config/shopFeatures");
const authGuard_1 = require("./authGuard");
// Initialize Firebase services
const db = (0, firestore_1.getFirestore)('b8s-reseller-db');
const auth = (0, auth_1.getAuth)();
exports.approveAffiliate = (0, https_1.onCall)({
    region: 'us-central1',
    secrets: ['RESEND_API_KEY'],
    memory: '256MiB',
    timeoutSeconds: 120,
    cors: app_urls_1.appUrls.CORS_ORIGINS
}, async (request) => {
    try {
        console.log('🎉 approveAffiliate: Starting unified affiliate approval workflow');
        console.log('🎉 Request data:', {
            applicationId: request.data.applicationId,
            checkoutDiscount: request.data.checkoutDiscount
        });
        // Basic auth gate (full shop-parity check happens AFTER the application
        // is loaded — the application's own shopId is the trustworthy source).
        (0, authGuard_1.requireAuth)(request.auth?.uid);
        const { applicationId, checkoutDiscount, phone, address, postalCode, city, country, socials, promotionMethod, message } = request.data;
        if (!applicationId) {
            throw new Error('Application ID is required');
        }
        // 1. Get application data
        console.log('📄 Fetching affiliate application...');
        const applicationRef = db.collection('affiliateApplications').doc(applicationId);
        const applicationDoc = await applicationRef.get();
        if (!applicationDoc.exists) {
            throw new Error('Affiliate application not found');
        }
        const appData = applicationDoc.data();
        if (!appData) {
            throw new Error('Application data is missing');
        }
        // TENANT ISOLATION: enforce shop parity using the application's OWN shopId
        // (trustworthy source). A shop admin may only approve their own shop's
        // applications; a platform super-admin may approve any. Admin-SDK bypasses
        // Firestore rules, so this MUST be checked here in code.
        await (0, authGuard_1.requireAdminOfShop)(appData.shopId || tenancy_1.DEFAULT_SHOP_ID, request.auth?.uid);
        // Affiliate add-on gate: don't approve a new affiliate for a shop whose
        // affiliate add-on is disabled (no new affiliate activity). Checked BEFORE
        // any Auth/Firestore write so nothing is half-created. Default-ON.
        if (!(await (0, shopFeatures_1.isShopFeatureEnabled)(appData.shopId || tenancy_1.DEFAULT_SHOP_ID, 'affiliate'))) {
            throw new Error('Affiliate-tillägget är inaktiverat för den här butiken.');
        }
        // 2. Create Firebase Auth user
        console.log('🔐 Creating Firebase Auth user...');
        const tempPassword = Math.random().toString(36).substring(2, 15);
        let authUser;
        let wasExistingAuthUser = false;
        try {
            authUser = await auth.createUser({
                email: appData.email,
                password: tempPassword,
                displayName: appData.name,
                emailVerified: true
            });
            console.log(`✅ Created new Firebase Auth user for ${appData.email}`);
        }
        catch (error) {
            if (error.code === 'auth/email-already-exists') {
                // HOTFIX 2026-09-26 (account takeover): NEVER reset an existing
                // account's password here. affiliateApplications can be created by
                // anyone with any email + shopId, so approving one used to hand the
                // approving shop admin a fresh password for ANY existing account —
                // including a platform super-admin's — and store it in plaintext on
                // the affiliate doc. Same deny-by-default guard as createShopUser:
                // an affiliate needs a fresh email.
                throw new Error(`${appData.email} tillhör redan ett konto och kan inte godkännas som affiliate. Be sökanden använda en annan e-postadress.`);
            }
            else {
                throw error;
            }
        }
        // 3. Generate unique affiliate code
        const affiliateCode = `${appData.name.substring(0, 3).toUpperCase()}${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
        console.log(`🏷️ Generated affiliate code: ${affiliateCode}`);
        // 4. Create affiliate record
        console.log('📝 Creating affiliate record...');
        const affiliateData = {
            id: authUser.uid,
            // Inherit the tenant from the application the affiliate is approved
            // from; falls back to the default shop.
            shopId: appData.shopId || tenancy_1.DEFAULT_SHOP_ID,
            affiliateCode,
            name: appData.name,
            email: appData.email,
            phone: phone || appData.phone || '',
            address: address || appData.address || '',
            postalCode: postalCode || appData.postalCode || '',
            city: city || appData.city || '',
            country: country || appData.country || 'SE',
            socials: socials || appData.socials || {},
            promotionMethod: promotionMethod || appData.promotionMethod || '',
            message: message || appData.message || '',
            status: 'active',
            commissionRate: 15,
            checkoutDiscount: Number(checkoutDiscount) || 10,
            preferredLang: appData.preferredLang || 'sv-SE',
            stats: {
                clicks: 0,
                conversions: 0,
                totalEarnings: 0,
                balance: 0,
            },
            firebaseAuthUid: authUser.uid,
            credentialsSent: false,
            credentialsSentAt: null,
            credentialsSentBy: null,
            // HOTFIX 2026-09-26: the temporary password is delivered by the welcome
            // email only — never persisted (it was stored in plaintext, readable by
            // the shop's admins).
            requiresPasswordChange: true,
            createdAt: new Date(),
            updatedAt: new Date()
        };
        await db.collection('affiliates').doc(authUser.uid).set(affiliateData);
        console.log('✅ Affiliate record created successfully');
        // 5. Send welcome email via orchestrator
        console.log('📧 Sending welcome email via orchestrator...');
        const orchestrator = new EmailOrchestrator_1.EmailOrchestrator();
        const emailResult = await orchestrator.sendEmail({
            emailType: 'AFFILIATE_WELCOME',
            customerInfo: {
                email: appData.email,
                name: appData.name
            },
            language: appData.preferredLang || 'sv-SE',
            additionalData: {
                affiliateInfo: {
                    name: appData.name,
                    email: appData.email,
                    affiliateCode: affiliateCode,
                    commissionRate: 15,
                    checkoutDiscount: Number(checkoutDiscount) || 10
                },
                credentials: {
                    email: appData.email,
                    temporaryPassword: tempPassword
                },
                wasExistingAuthUser: wasExistingAuthUser
            }
        });
        if (!emailResult.success) {
            console.error('❌ Welcome email failed:', emailResult.error);
            // Don't fail the whole process, but log the error
        }
        else {
            console.log('✅ Welcome email sent successfully');
            // Update affiliate record with email sent info
            await db.collection('affiliates').doc(authUser.uid).update({
                credentialsSent: true,
                credentialsSentAt: new Date(),
                credentialsSentBy: request.auth?.uid || 'system'
            });
        }
        // 6. Delete application record
        console.log('🗑️ Cleaning up application record...');
        await applicationRef.delete();
        console.log('✅ Application record deleted');
        console.log('🎉 Affiliate approval workflow completed successfully');
        return {
            success: true,
            email: appData.email,
            affiliateCode: affiliateCode,
            affiliateId: authUser.uid,
            wasExistingAuthUser: wasExistingAuthUser,
            language: appData.preferredLang || 'sv-SE',
            messageId: emailResult.messageId,
            emailSent: emailResult.success,
            commissionRate: 15,
            checkoutDiscount: Number(checkoutDiscount) || 10
        };
    }
    catch (error) {
        console.error('❌ approveAffiliate: Fatal error:', error);
        throw new Error(error instanceof Error ? error.message : 'Unknown error in affiliate approval');
    }
});
//# sourceMappingURL=approveAffiliate.js.map