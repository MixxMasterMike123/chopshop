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

// Default-ON: a feature is enabled unless EXPLICITLY set to false. This keeps the
// existing shops (which predate the `features` field) and any shop
// missing a flag fully working — nothing disappears until an operator turns it
// off from the platform. New shops get explicit defaults from ProvisionShopModal.
export const isFeatureEnabled = (features, key) => features?.[key] !== false;
