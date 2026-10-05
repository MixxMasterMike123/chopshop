/**
 * Store Identity — single source of truth for per-shop branding.
 *
 * Swap these values to rebrand the storefront. This is the de-branded
 * baseline a real per-shop deployment would overwrite.
 *
 * NOTE: This is intentionally a static, build-time config so the public
 * storefront renders instantly for anonymous visitors with no async load
 * and no Firestore rule dependency. A later step wires these defaults to a
 * publicly-readable Firestore `settings/app` doc + the AdminSettings form
 * so a shop can be rebranded without a redeploy.
 */
export const STORE = {
  // Display identity. CP9-OB: EMPTY, never a placeholder value. The texts this
  // file shipped before ("My Shop", "My Company", …) were shown as the admin
  // form's values, printed in the storefront and adopted into legal pages;
  // src/utils/placeholderIdentity.js still recognises them where a shop
  // stored them. A page prints the shop's own value or nothing.
  shopName: '',
  legalName: '',
  tagline: '',

  // Generic placeholder logo. Admins can override via the Store Identity form.
  logoUrl: '/images/logo.svg',

  // Per-shop browser-tab favicon. Empty = the static neutral /favicon.ico from
  // index.html is used. Set via the admin Butik → Varumärke upload; applied at
  // runtime (StoreSettingsContext) on both storefront and admin tabs.
  faviconUrl: '',

  // NORD design system (see DESIGN.md) — per-shop visual identity.
  // accent: the single brand color, used ONLY on actions and live signals.
  // Must pass WCAG AA as a button background with white text.
  accent: '#0E5E63',

  // Selected storefront TEMPLATE (src/config/templates.js). '' or 'nord' = the
  // default NORD look. 'sport' = the Gameday sport template, etc. The template
  // supplies a base token set; `accent` and `theme` below override on top.
  templateId: '',

  // NORD template — a PARTIAL override of the NORD token defaults
  // (src/config/nordTokens.js). Empty {} = pure NORD (only `accent` above
  // applies). A template we build/generate sets a subset of:
  //   { colors:{accent,accentInk,accentSoft,canvas,surface,ink,inkMuted,
  //             inkFaint,line},
  //     fonts:{display,body}, shape:{rTile,rEl}, motion:{ease},
  //     layout:{ gridCols:3|4, density:'compact'|'cozy'|'airy',
  //              heroStyle:'bento'|'full'|'split'|'editorial' } }
  // Applied at runtime on <html> by StoreSettingsContext → resolveTheme().
  // Omitted keys fall back to NORD defaults, so a template can never break.
  theme: {},
  // Hero block content. ALL empty by default — a generic template must not
  // ship a brand-specific image/copy. Empty heroImageUrl → the storefront
  // renders the accent-gradient hero (no flash of a placeholder image before
  // the shop's saved config loads). Headline/subtitle empty → translation
  // fallback. Each shop sets these via the admin Butik page.
  heroImageUrl: '',
  heroHeadline: '',
  heroSubtitle: '',

  // Frontpage showcase category. When set to an existing category name, the shop
  // frontpage features THAT category's products + a "show all products" link;
  // empty = show all products (current behavior). Admin picks it in the Butik page.
  frontpageCategory: '',

  // Optional per-shop section headings/subtitles. Empty → inline default (see
  // PublicStorefront). Admin-editable in the Butik page so a shop can rename
  // "Utvalt"/"Våra produkter"/"Vad våra kunder säger" etc.
  featuredTitle: '',
  productsTitle: '',
  productsSubtitle: '',
  reviewsTitle: '',
  reviewsSubtitle: '',

  // Contact (empty until the shop has its own, CP9-OB)
  supportEmail: '',
  // HTML allowed (rendered via dangerouslySetInnerHTML in the footer).
  address: '',

  // Return address shown to the customer in the legal pages (köpvillkor §8 +
  // ångerrätt page). HARD-REQUIRED before the auto-generated legal pages may go
  // live on a real shop (see legalPageReadiness.js). Empty = not yet collected.
  returnAddress: '',

  // Footer company / legal info. Rendered DIRECTLY (not via the translation
  // layer) so saved translations can't override per-shop identity.
  companyDescription: '',
  orgNumber: '',   // e.g. company/VAT registration number; empty hides the line
  businessInfo: '', // e.g. 'Registered for VAT'; empty hides the line
  // VAT registration — drives the [[IF vat_registered]] branch in the legal
  // pages AND must match what checkout charges. THREE states on purpose:
  //   null  = not yet decided (legal pages NOT ready to go live — see the gate),
  //   true  = registered (prices incl. moms; VAT shown on receipt),
  //   false = below threshold / not registered (no VAT added).
  // NOT inferred from sellerType: a company can be under threshold, an
  // individual over it (docs/legal-template-files/README.md).
  vatRegistered: null, // null | true | false
  vatNumber: '',  // momsreg.nr; disclosed in legal pages only when vatRegistered === true
  // Seller type: a first-class shop attribute (individual privatperson vs
  // company). Drives the contract track + consumer-protection handling + UI,
  // beyond DAC7. Populated from Stripe `business_type` at the DAC7 pull, or set
  // at provisioning/onboarding. '' = not yet resolved.
  sellerType: '', // '' | 'individual' | 'company'

  // Social links. Empty string = icon hidden. If all empty, the whole
  // "Follow us" block is hidden.
  social: {
    facebook: '',
    instagram: '',
    youtube: '',
    tiktok: '',
    pinterest: '',
    linkedin: '',
    website: '',
  },

  // Trustpilot integration (per-shop, admin-editable). Empty = no Trustpilot
  // widget/reviews. domain = the shop's Trustpilot business domain; email =
  // the review-invite sender. Both default empty (no hardcoded brand).
  trustpilot: {
    domain: '',
    email: '',
  },

  // Currency / VAT — included for completeness. NOT wired into pricing math
  // in this slice; parameterizing currency/VAT is a later step.
  currency: 'SEK',
  vatRate: 0.25,

  // Pickup locations (Click & Collect). The shop admin manages these in
  // Settings; the storefront checkout offers them as a no-shipping-cost
  // alternative to home delivery. Each: { id, name, address, hours, dates }
  // where dates is an optional string[] of ISO YYYY-MM-DD pickup dates the
  // customer chooses between at checkout (empty = no specific date choice).
  // Empty = pickup is simply not offered at checkout.
  pickupLocations: [],
};
