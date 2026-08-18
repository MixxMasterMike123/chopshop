// Add-on catalog + the wagon→feature mapping — the single source of truth for
// the per-shop add-on (entitlement) system. Add-ons are enabled/disabled PER
// SHOP from the platform console (shops/{shopId}.features.<key>), read app-wide
// via useShopFeatures(). See docs/ADDONS_PLATFORM_CONTROL_PLAN.md.
//
// "Wagon" is the internal plugin-framework name (src/wagons/, WagonRegistry);
// "Add-on" / "Tillägg" is the user/operator-facing name. This map ties each
// wagon's manifest id to its feature key on the shop doc.

// wagon manifest id → shops/{id}.features key
export const WAGON_FEATURE_KEY = {
  'ambassador-wagon': 'ambassador',
  'dining-wagon': 'dining',
  'campaign-wagon': 'campaigns',
  'writers-wagon': 'writers',
  'pod-wagon': 'pod',
};

// The add-on catalog shown in the platform per-shop toggle UI. `key` matches a
// feature flag on shops/{id}.features. Swedish operator-facing copy (editable).
// `affiliate` is listed so the platform can toggle the entitlement now, but its
// ENFORCEMENT (storefront/admin/functions) lands in a follow-up slice (P4.5b);
// see the plan. The four wagon add-ons are wired end-to-end in this slice.
export const ADDON_CATALOG = [
  { key: 'affiliate', label: 'Affiliate', description: 'Affiliate-program: registrering, portal, provisioner och rabattkoder.' },
  { key: 'discountCodes', label: 'Rabattkoder', description: 'Kampanjkoder med rabatt på hela kundvagnen eller valda produkter, med datumintervall och användningsgräns.' },
  { key: 'b2b', label: 'B2B Grossist', description: 'Grossistportal: grossistpriser per produkt, inloggning för återförsäljare och fakturaköp.' },
  { key: 'campaigns', label: 'Kampanjer', description: 'Kampanjhanterare för affiliate-marknadsföring, banners och tävlingar.' },
  { key: 'dining', label: 'Dining CRM', description: 'CRM för säljkontakter: kontakter, aktiviteter, uppföljningar och dokument.' },
  { key: 'ambassador', label: 'Ambassadörer', description: 'CRM för influencers/ambassadörer per plattform och följarnivå.' },
  { key: 'writers', label: 'AI-texter', description: 'AI-genererade produktbeskrivningar (Claude). Kräver API-nyckel.' },
  { key: 'pod', label: 'Print on demand', description: 'Ladda upp tryckoriginal, validera mot tryckspecar och koppla dem till produkter via SKU. Tryckeriet får produktionsfiler per order.' },
  { key: 'abandonedCheckout', label: 'Övergiven kassa', description: 'Påminner kunder via e-post om kassor de inte slutförde. En påminnelse per kassa, med återställningslänk och avregistrering.' },
  { key: 'productReviews', label: 'Recensioner', description: 'Egna produktrecensioner från verifierade köp. Automatisk e-postförfrågan efter leverans, auto-publicering med innehållsfilter och aggregerat betyg på produktsidan.' },
  // NOTE: contentStudio is EXPLICIT OPT-IN (features.contentStudio === true),
  // unlike the default-ON legacy keys above — nav + page gate on the explicit
  // flag (not isFeatureEnabled), so it stays hidden until the platform turns
  // it on per shop.
  { key: 'contentStudio', label: 'Innehållsstudio', description: 'AI-studio för sociala medier: ladda upp råmaterial, få färdiga inlägg (hook, caption, hashtags) för TikTok/Reels/Shorts och automatiskt ihopklippt vertikal video i takt med musiken.' },
];

// Explicit OPT-IN keys: enabled only when the flag is the literal true. `pod`
// flipped to opt-in 2026-08-18 (pod-shop-type-selector plan D3) AFTER every
// existing shop got an explicit backfilled value — a missing flag must mean a
// things shop, never a silently POD-entitled one. `contentStudio` was always
// opt-in (its gates check === true directly); listing it here also makes the
// /addons toggle grid display its true state.
const OPT_IN_KEYS = new Set(['pod', 'contentStudio']);

// Legacy keys are default-ON: enabled unless EXPLICITLY set to false. This keeps
// shops that predate the `features` field fully working — nothing disappears
// until an operator turns it off. New shops get explicit defaults for ALL keys
// from ProvisionShopModal, so the default only matters for legacy docs.
export const isFeatureEnabled = (features, key) =>
  OPT_IN_KEYS.has(key) ? features?.[key] === true : features?.[key] !== false;
