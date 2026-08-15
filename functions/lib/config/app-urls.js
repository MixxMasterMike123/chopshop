"use strict";
// Platform Configuration — single source of truth for URLs, identity and
// commerce defaults used by Cloud Functions.
//
// Every value is env-overridable so a per-shop deploy is pure configuration
// (set in functions/.env.<project-id>). Defaults are the current staging
// values, so deploying without env changes keeps working exactly as before.
Object.defineProperty(exports, "__esModule", { value: true });
exports.commerceConfig = exports.adminSeedConfig = exports.appUrls = void 0;
const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'b8shield-reseller-app';
exports.appUrls = {
    // Primary domains
    // "Portal" = where provisioned admins log in — the admin console. (The old
    // partner.b8shield.com default leaked a dead brand domain into emails.)
    B2B_PORTAL: process.env.APP_PORTAL_URL || 'https://meteorpr.web.app',
    B2C_SHOP: process.env.APP_SHOP_URL || 'https://shop-meteorpr.web.app',
    // Hosting default domain for this project (works on any deploy)
    B2B_LEGACY: `https://${projectId}.web.app`,
    // Admin console base URL — used for Stripe Connect Account Link return/refresh
    // redirects (shop owner returns here after Stripe-hosted onboarding).
    ADMIN_BASE: process.env.ADMIN_BASE_URL || 'https://meteorpr.web.app',
    // Asset URLs. Empty default = emails render a text brand header instead of
    // an <img> (there is no platform logo; per-shop logos are a later slice).
    LOGO_URL: process.env.EMAIL_LOGO_URL || '',
    // CORS allowed origins (shop + portal + project hosting + local dev,
    // plus any comma-separated extras from CORS_EXTRA_ORIGINS)
    get CORS_ORIGINS() {
        const extras = (process.env.CORS_EXTRA_ORIGINS || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        return [
            this.B2C_SHOP,
            this.B2B_PORTAL,
            this.B2B_LEGACY,
            // (shop-b8shield.web.app removed 2026-08-15 — the legacy shop is deleted.)
            // meteorpr surfaces (the live hosting targets) — admin, storefront, and the
            // platform operator console. The platform host is required so the operator
            // console's callables (e.g. createShopUser) aren't CORS-rejected.
            'https://meteorpr.web.app',
            'https://shop-meteorpr.web.app',
            'https://platform-meteorpr.web.app',
            // print-shop portal — its callables (getPrintQueue/getPrintJob/…) are
            // CORS-rejected without this origin.
            'https://print-meteorpr.web.app',
            'http://localhost:5173',
            'http://localhost:3000',
            ...extras
        ];
    },
    // User Agent for outbound API calls
    getUserAgent: () => `${exports.commerceConfig.shopName}/1.0 (${exports.appUrls.B2B_PORTAL})`
};
// Seed admin login used by the createAdminUser maintenance endpoint
exports.adminSeedConfig = {
    email: process.env.ADMIN_SEED_EMAIL || 'micke.ohlen@gmail.com'
};
// Commerce defaults — per-shop, env-overridable
exports.commerceConfig = {
    shopName: process.env.SHOP_NAME || 'MeteorPR',
    // Prefix for human-readable order numbers, e.g. ORD-123456-AB12. Changing
    // it only affects NEW orders; lookups (withdrawal etc.) match the stored
    // string, so old B8S-… numbers keep resolving.
    orderNumberPrefix: process.env.ORDER_NUMBER_PREFIX || 'ORD',
    // VAT rate as a fraction (0.25 = 25%)
    vatRate: parseFloat(process.env.VAT_RATE || '0.25'),
    // ISO currency code for charges
    currency: (process.env.SHOP_CURRENCY || 'SEK').toUpperCase(),
    // Stripe Connect: the PLATFORM's default cut, in BASIS POINTS (500 = 5.00%).
    // Effective rate per sale = shops/{id}.payments.commissionBps
    //   ?? settings/platform.defaultCommissionBps ?? this env default.
    // Basis points (integer) avoid float drift and match Stripe's integer
    // minor-unit fee math (see functions/src/payment/connectFee.ts).
    defaultCommissionBps: parseInt(process.env.PLATFORM_DEFAULT_COMMISSION_BPS || '500', 10)
};
//# sourceMappingURL=app-urls.js.map