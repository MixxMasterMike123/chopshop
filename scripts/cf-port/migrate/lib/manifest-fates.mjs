/**
 * scripts/cf-port/migrate/lib/manifest-fates.mjs — the fate table as data,
 * transcribed from docs/cf-port/MIGRATION_MANIFEST.md §1 (the 75-row table).
 *
 * This is deliberately DATA, not logic: export.mjs looks up a collection's
 * fate here instead of hard-coding it inline. test/manifest-fates.test.mjs
 * parses the manifest table directly out of the markdown and asserts this
 * object matches it exactly, so the two files can never silently drift apart.
 *
 * Two special cases the manifest calls out that need a fate DIFFERENT from
 * "carry"/"archive"/"drop":
 *   - `productsPublic` and `printersPublic` are "drop" in the 75-row table
 *     (§1 rows 47, 52) but the brief additionally asks that these two
 *     specifically be written to `_verify/<collection>.jsonl` rather than
 *     just counted-and-discarded like the other five drops. We record that
 *     distinction as fate `verify-only` here (also called out in §c: "go to
 *     a transient verify file"). manifest-fates.test.mjs treats `verify-only`
 *     as equivalent to the manifest's "drop" for the drift check, and
 *     export.mjs is the thing that treats it specially.
 *
 * `settings` (row) is one collection whose DOCUMENTS carry different fates
 * (rows 67-75): SETTINGS_DOC_FATES maps each known settings doc id to its
 * fate. A settings doc id not in this map (there should be none beyond the
 * 9 the census found) is reported as fate `unknown`, same as an unknown
 * collection.
 */

// Top-level collections, § row 1. Key = Firestore collection id.
const COLLECTION_FATES = {
  activities: { fate: 'archive', row: 1 },
  adminCustomerDocuments: { fate: 'archive', row: 2 },
  adminPresence: { fate: 'drop', row: 3 },
  adminUIDs: { fate: 'archive', row: 4 },
  affiliateApplications: { fate: 'archive', row: 5 },
  affiliateClicks: { fate: 'archive', row: 6 },
  affiliatePayouts: { fate: 'archive', row: 7 },
  affiliates: { fate: 'archive', row: 8 },
  ambassadorActivities: { fate: 'archive', row: 9 },
  ambassadorContacts: { fate: 'archive', row: 10 },
  appSettings: { fate: 'archive', row: 11 },
  auditLogs: { fate: 'carry', row: 12 },
  b2bCustomers: { fate: 'archive', row: 13 },
  b2cCustomers: { fate: 'archive', row: 14 },
  campaignParticipants: { fate: 'archive', row: 15 },
  campaignRevenueTracking: { fate: 'archive', row: 16 },
  campaigns: { fate: 'archive', row: 17 },
  checkouts: { fate: 'archive', row: 18 },
  checkoutSuppressions: { fate: 'archive', row: 19 },
  collections: { fate: 'carry', row: 20 },
  customerDocuments: { fate: 'archive', row: 21 },
  dac7CorrectionRequests: { fate: 'archive', row: 22 },
  dac7Sellers: { fate: 'archive', row: 23 },
  deferredActivities: { fate: 'archive', row: 24 },
  diningActivities: { fate: 'archive', row: 25 },
  diningContacts: { fate: 'archive', row: 26 },
  diningDeferredActivities: { fate: 'archive', row: 27 },
  diningFollowUps: { fate: 'archive', row: 28 },
  discountCodes: { fate: 'archive', row: 29 },
  emailVerifications: { fate: 'drop', row: 30 },
  followUps: { fate: 'archive', row: 31 },
  impersonationAudit: { fate: 'archive', row: 32 },
  infringementReports: { fate: 'carry', row: 33 },
  leads: { fate: 'archive', row: 34 },
  marketingMaterials: { fate: 'archive', row: 35 },
  migrations: { fate: 'archive', row: 36 },
  orderProduction: { fate: 'archive', row: 37 },
  orderStatuses: { fate: 'archive', row: 38 },
  orders: { fate: 'archive', row: 39 },
  pages: { fate: 'carry', row: 40 },
  passwordResets: { fate: 'drop', row: 41 },
  pod3dModels: { fate: 'carry', row: 42 },
  podArtwork: { fate: 'carry', row: 43 },
  podMappings: { fate: 'carry', row: 44 },
  printerCatalog: { fate: 'carry', row: 45 },
  printers: { fate: 'carry', row: 46 },
  printersPublic: { fate: 'verify-only', row: 47 },
  printNotifications: { fate: 'drop', row: 48 },
  productGroups: { fate: 'archive', row: 49 },
  productReviews: { fate: 'archive', row: 50 },
  products: { fate: 'carry', row: 51 },
  productsPublic: { fate: 'verify-only', row: 52 },
  rateLimits: { fate: 'drop', row: 53 },
  reviewRequests: { fate: 'archive', row: 54 },
  reviewSuppressions: { fate: 'archive', row: 55 },
  shops: { fate: 'carry', row: 56 },
  socialPosts: { fate: 'archive', row: 57 },
  translations_en_GB: { fate: 'carry', row: 58 },
  translations_en_US: { fate: 'carry', row: 59 },
  translations_sv_SE: { fate: 'carry', row: 60 },
  userMentions: { fate: 'archive', row: 61 },
  users: { fate: 'carry', row: 62 },
  userWagonSettings: { fate: 'archive', row: 63 },
  wagonConfigurations: { fate: 'archive', row: 64 },
};

// Subcollections, § rows 65-66. Key = flattened `parent__child` directory name
// used in the bundle, per §(c) "Subcollections are flattened with `__`".
const SUBCOLLECTION_FATES = {
  'shops__legalAcceptances': {
    fate: 'carry',
    row: 65,
    parentCollection: 'shops',
    subcollection: 'legalAcceptances',
  },
  'users__marketingMaterials': {
    fate: 'archive',
    row: 66,
    parentCollection: 'users',
    subcollection: 'marketingMaterials',
  },
};

// `settings/{docId}` fates, § rows 67-75. Key = the settings document id.
const SETTINGS_DOC_FATES = {
  platform: { fate: 'carry', row: 67 },
  app: { fate: 'carry', row: 68 },
  printRouting: { fate: 'carry', row: 69 },
  podProfiles: { fate: 'carry', row: 70 },
  podMockupTemplates: { fate: 'carry', row: 71 },
  contentScreening: { fate: 'carry', row: 72 },
  SdYOaQ7bqCrKT38V969d: { fate: 'archive', row: 73 },
  riPDNohPyWiyfnfMAKMK: { fate: 'archive', row: 74 },
  zSVmicFaCtWPf7OEwfxC: { fate: 'archive', row: 75 },
};

const DROP_COLLECTIONS = Object.keys(COLLECTION_FATES).filter(
  (name) => COLLECTION_FATES[name].fate === 'drop',
);

const VERIFY_ONLY_COLLECTIONS = Object.keys(COLLECTION_FATES).filter(
  (name) => COLLECTION_FATES[name].fate === 'verify-only',
);

/** The manifest-declared subcollections to walk under every parent doc id
 * (including phantom/missing parents), keyed by parent collection name. */
const KNOWN_SUBCOLLECTIONS_BY_PARENT = Object.values(SUBCOLLECTION_FATES).reduce((acc, entry) => {
  acc[entry.parentCollection] = acc[entry.parentCollection] ?? [];
  acc[entry.parentCollection].push(entry.subcollection);
  return acc;
}, {});

function fateForCollection(name) {
  return COLLECTION_FATES[name] ?? null;
}

function fateForSubcollection(flattenedName) {
  return SUBCOLLECTION_FATES[flattenedName] ?? null;
}

function fateForSettingsDoc(docId) {
  return SETTINGS_DOC_FATES[docId] ?? null;
}

export {
  COLLECTION_FATES,
  SUBCOLLECTION_FATES,
  SETTINGS_DOC_FATES,
  DROP_COLLECTIONS,
  VERIFY_ONLY_COLLECTIONS,
  KNOWN_SUBCOLLECTIONS_BY_PARENT,
  fateForCollection,
  fateForSubcollection,
  fateForSettingsDoc,
};
