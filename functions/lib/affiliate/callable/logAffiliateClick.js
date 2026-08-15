"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logAffiliateClickV2 = void 0;
const https_1 = require("firebase-functions/v2/https");
const firestore_1 = require("firebase-admin/firestore");
const app_1 = require("firebase-admin/app");
const tenancy_1 = require("../../config/tenancy");
const shopFeatures_1 = require("../../config/shopFeatures");
const durableRateLimit_1 = require("../../protection/rate-limiting/durableRateLimit");
/**
 * Log affiliate link click (Callable version)
 * Called when a user clicks an affiliate link
 */
exports.logAffiliateClickV2 = (0, https_1.onCall)({
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 60
}, async (request) => {
    // Get Firestore instance (initialized at runtime)
    const db = (0, firestore_1.getFirestore)((0, app_1.getApp)(), 'b8s-reseller-db');
    const { data } = request;
    const { affiliateCode, campaignCode } = data;
    if (!affiliateCode) {
        throw new Error('The function must be called with an affiliateCode.');
    }
    // P1-02: per-IP throttle on click logging (stats/ledger inflation guard).
    // Over-limit returns the same benign no-track response as the disabled
    // add-on so the storefront tracker never errors for real visitors. 240/h
    // absorbs a campaign burst behind one carrier CGNAT IP while still
    // bounding single-source ledger inflation.
    if (!(await (0, durableRateLimit_1.checkRateLimit)('affClick', (0, durableRateLimit_1.trustedClientIp)(request.rawRequest), { limit: 240, windowSec: 3600 }))) {
        return { success: true, message: 'Rate limited.', clickId: '' };
    }
    try {
        // Get affiliate details
        const affiliatesRef = db.collection('affiliates');
        const q = affiliatesRef.where('affiliateCode', '==', affiliateCode).where('status', '==', 'active');
        const affiliateSnapshot = await q.get();
        if (affiliateSnapshot.empty) {
            throw new Error(`No active affiliate found for code: ${affiliateCode}`);
        }
        const affiliateDoc = affiliateSnapshot.docs[0];
        // Tenant of the click = tenant of the affiliate being clicked (more
        // trustworthy than client input). Falls back to the default shop.
        const shopId = affiliateDoc.data()?.shopId || tenancy_1.DEFAULT_SHOP_ID;
        // Affiliate add-on OFF for this shop → don't log the click or bump stats
        // (no new affiliate activity). Benign success so the storefront tracker
        // doesn't error. Default-ON: existing shops unaffected.
        if (!(await (0, shopFeatures_1.isShopFeatureEnabled)(shopId, 'affiliate'))) {
            // No click logged; empty clickId signals "not tracked" to the client.
            return { success: true, message: 'Affiliate add-on disabled for this shop.', clickId: '' };
        }
        // Create click record
        const clickRef = await db.collection('affiliateClicks').add({
            affiliateCode: affiliateCode,
            affiliateId: affiliateDoc.id,
            shopId,
            campaignCode: campaignCode || null,
            timestamp: firestore_1.Timestamp.now(),
            ipAddress: request.rawRequest?.ip || 'unknown',
            userAgent: request.rawRequest?.headers?.['user-agent'] || 'unknown',
            landingPage: request.rawRequest?.headers?.referer || 'unknown',
            converted: false,
        });
        // Update affiliate stats
        await affiliateDoc.ref.update({
            'stats.clicks': firestore_1.FieldValue.increment(1)
        });
        // Update campaign stats if campaign code provided
        if (campaignCode) {
            try {
                const campaignsRef = db.collection('campaigns');
                // TENANT ISOLATION: campaign codes are unique per shop
                const campaignQuery = campaignsRef.where('code', '==', campaignCode).where('shopId', '==', shopId);
                const campaignSnapshot = await campaignQuery.get();
                if (!campaignSnapshot.empty) {
                    const campaignDoc = campaignSnapshot.docs[0];
                    await campaignDoc.ref.update({
                        'totalClicks': firestore_1.FieldValue.increment(1)
                    });
                    console.log(`Campaign click logged for campaign ${campaignCode}`);
                }
                else {
                    console.warn(`Campaign not found for code: ${campaignCode}`);
                }
            }
            catch (campaignError) {
                console.error(`Error updating campaign stats for ${campaignCode}:`, campaignError);
                // Don't throw error here - affiliate click was successful
            }
        }
        console.log(`Click logged for affiliate ${affiliateCode}${campaignCode ? ` with campaign ${campaignCode}` : ''}, clickId: ${clickRef.id}`);
        return {
            success: true,
            message: `Click logged for affiliate ${affiliateCode}`,
            clickId: clickRef.id
        };
    }
    catch (error) {
        console.error(`Error logging affiliate click for code ${affiliateCode}:`, error);
        throw new Error('Error logging affiliate click.');
    }
});
//# sourceMappingURL=logAffiliateClick.js.map