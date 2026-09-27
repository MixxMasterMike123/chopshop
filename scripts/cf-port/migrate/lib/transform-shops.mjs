/**
 * scripts/cf-port/migrate/lib/transform-shops.mjs — manifest row 56:
 * `shops` → `tenants`, `tenant_domains`, `tenant_settings`, `tenant_features`.
 *
 * D21: the shop `robowatz` is archived, not imported — filtered out by the
 * caller before this module ever sees it (kept here as a named constant so
 * the exclusion is visible in one place and tested).
 *
 * Status maps `active` → `active`, `disabled` → `suspended` (D59).
 * `published` keeps its Firebase meaning (D57): only an EXPLICIT `false` is
 * unpublished (ShopGate.jsx reads `published === false`; 0025 defaults the
 * column to 1). A shop with no `published` field is published.
 *
 * Money facts of the shop, both refused in the store identity and owned by
 * `tenants`:
 *   payments.commissionBps → commission_bps, when it is an integer within the
 *     cap every Cloudflare route enforces (MAX_COMMISSION_BPS, D45/D71). NULL
 *     = the platform default. A value above the cap is NOT carried and is
 *     reported; on production it refuses the plan (D75), so no shop goes live
 *     on a rate that was changed without a decision.
 *   storeIdentity.vatRate (a fraction, 0.25) → vat_rate_bp (2500). Absent =
 *     the column's own default, 2500. A value that is not a whole number of
 *     basis points in 0..10000 refuses the plan.
 *
 * D7b: every imported shop gets a placeholder hostname
 * `<tenantId>.import.invalid` (no shop may hold the shared staging API host).
 *
 * tenant_settings: the store identity object with the REFUSED_STORE_IDENTITY_KEYS
 * removed (imported from the Worker source's own list, pinned by a test that
 * re-reads that file — see test/tenant-config-keys-pin.test.mjs), the four
 * gate fields extracted into their own columns, empty strings → NULL,
 * updated_by = 'import'. Every Firebase Storage URL in the identity is removed
 * (this checkpoint has not copied Storage yet): the four branding images and
 * any other, such as the gallery images, via lib/scrub.mjs
 * removeStorageUrlsDeep; each removed path is reported per shop.
 *
 * tenant_features: effective values (D22) for the six allowed keys
 * (FEATURE_KEYS in cloudflare/src/platform/tenant-config.ts) only. An
 * explicit `pod` row is written for every shop that has POD products or
 * `features.pod === true` — CP3 cannot see "has POD products" (products are
 * CP4), so this module writes an explicit pod row whenever the source
 * `features.pod === true`; a shop with POD products but no explicit
 * `features.pod` flag is a case the CP4 products importer must re-examine
 * (documented in the report as an open question).
 *
 * Connect facts (D20): resolved by lib/scrub.mjs resolveConnectFacts, called
 * by the caller (import.mjs) — this module only accepts the ALREADY-RESOLVED
 * facts as input, so it stays free of the --connect-map / env plumbing.
 */

import { insertStatement } from './sql.mjs';
import { rowContentHash, carriedRow } from './plan.mjs';
import { scrubEmailsDeep, removeStorageUrlsDeep, resolveEmail } from './scrub.mjs';
import { formatTime, formatTimeOrNull } from './time-columns.mjs';
import { parseSourceTimestampMillis, clampForward } from './timestamps.mjs';

/** D21. */
export const ARCHIVED_SHOP_IDS = new Set(['robowatz']);

const STATUS_MAP = { active: 'active', disabled: 'suspended' };

/** Must equal cloudflare/src/platform/platform-settings.ts MAX_DEFAULT_COMMISSION_BPS
 * (pinned by test/tenant-config-keys-pin.test.mjs). */
export const MAX_COMMISSION_BPS = 800;
/** 0009: `vat_rate_bp INTEGER NOT NULL DEFAULT 2500`. */
export const DEFAULT_VAT_RATE_BP = 2500;

/** Must equal cloudflare/src/platform/tenant-config.ts REFUSED_STORE_IDENTITY_KEYS
 * top-level keys, and REFUSED_LEGAL_KEYS for the nested `legal.*` keys.
 * Pinned against the live source file by test/tenant-config-keys-pin.test.mjs
 * (reads the .ts file as text and extracts the arrays), per the brief: "the
 * two must not drift". */
export const REFUSED_STORE_IDENTITY_KEYS = [
  'commissionBps',
  'currency',
  'defaultCurrency',
  'defaultLocale',
  'features',
  'payments',
  'platformTerms',
  'published',
  'returnAddress',
  'sellerType',
  'shopId',
  'shopName',
  'status',
  'stripeAccountId',
  'supportEmail',
  'tenantId',
  'vatNumber',
  'vatRate',
  'vatRateBp',
  'vatRegistered',
];
export const REFUSED_LEGAL_KEYS = ['acceptance'];

/** Must equal cloudflare/src/platform/tenant-config.ts FEATURE_KEYS. */
export const FEATURE_KEYS = ['abandonedCheckout', 'contentStudio', 'discountCodes', 'marketingMaterials', 'pod', 'productReviews'];
/** Must equal cloudflare/src/platform/tenant-config.ts OPT_IN_KEYS (module-private there; restated here, pinned by the same test). */
export const OPT_IN_FEATURE_KEYS = new Set(['contentStudio', 'marketingMaterials', 'pod']);
export const FEATURE_DEFAULTS = Object.fromEntries(FEATURE_KEYS.map((k) => [k, !OPT_IN_FEATURE_KEYS.has(k)]));

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function emptyToNull(value) {
  if (typeof value !== 'string') return value ?? null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : value;
}

function refusedKeysOf(identity) {
  const refused = REFUSED_STORE_IDENTITY_KEYS.filter((k) => Object.hasOwn(identity, k));
  const legal = identity.legal;
  if (isPlainObject(legal)) {
    for (const key of REFUSED_LEGAL_KEYS) {
      if (Object.hasOwn(legal, key)) refused.push(`legal.${key}`);
    }
  }
  return refused;
}

function sanitizeIdentity(identity) {
  const refused = new Set(REFUSED_STORE_IDENTITY_KEYS);
  const out = {};
  for (const [key, value] of Object.entries(identity)) {
    if (refused.has(key)) continue;
    if (key === 'legal' && isPlainObject(value)) {
      out[key] = Object.fromEntries(Object.entries(value).filter(([k]) => !REFUSED_LEGAL_KEYS.includes(k)));
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Transforms one shop document into its plan statements.
 *
 * @param {object} args
 * @param {object} args.doc          the bundle document `{ id, data, ... }`
 * @param {string} args.env          'staging' | 'production'
 * @param {number} args.nowMillis    the run's clock, milliseconds since epoch
 *                                   (the bundle's own exportedAt — see import.mjs)
 * @param {object} args.emailMap     normalized email map (lib/scrub.mjs)
 * @param {boolean} args.scrubUnmapped
 * @param {object} args.connectFacts ALREADY-RESOLVED connect facts (see header)
 * @param {object|null} args.targetState  optional { tenantIds:Set, hostnames:Set }
 * @returns {{
 *   tenantId: string, skipped: string|null,
 *   rows: { table: string, pk: string, statement: string, contentSha: string }[],
 *   report: object
 * }}
 */
export function transformShop({ connectFacts, doc, emailMap, env, nowMillis, scrubUnmapped, targetState = null }) {
  const tenantId = doc.id;
  if (ARCHIVED_SHOP_IDS.has(tenantId)) {
    return { report: { reason: 'D21: robowatz is archived, not imported', tenantId }, rows: [], skipped: 'archived', tenantId };
  }

  const data = doc.data ?? {};
  const status = STATUS_MAP[data.status] ?? 'provisioning';
  const published = data.published === false ? 0 : 1;
  const createdAtMillis = parseSourceTimestampMillis(data.createdAt, nowMillis);
  const updatedAtRawMillis = parseSourceTimestampMillis(data.updatedAt, createdAtMillis);
  // tenants CHECK (updated_at >= created_at): the source's own updatedAt can
  // predate its createdAt reconstruction here (e.g. createdAt absent from the
  // bundle and defaulted to the run clock, while updatedAt is an old ISO
  // string carried verbatim, manifest §56's "mixed timestamp shape" case).
  // Clamping forward preserves the source value whenever it already satisfies
  // the invariant, and never invents a LATER time than what actually happened
  // when it does not.
  const updatedAtMillis = clampForward(updatedAtRawMillis, createdAtMillis);

  const refusals = [];
  const moneyLines = [];

  const commissionSource = data.payments?.commissionBps;
  let commissionBps = null;
  if (commissionSource !== undefined && commissionSource !== null) {
    if (Number.isInteger(commissionSource) && commissionSource >= 0 && commissionSource <= MAX_COMMISSION_BPS) {
      commissionBps = commissionSource;
    } else {
      const line = `payments.commissionBps is ${JSON.stringify(commissionSource)}, outside 0–${MAX_COMMISSION_BPS} (D71): NOT carried, the platform default applies to this shop (D75)`;
      moneyLines.push(line);
      if (env === 'production') refusals.push(line);
    }
  }

  const vatRateSource = data.storeIdentity?.vatRate;
  let vatRateBp = DEFAULT_VAT_RATE_BP;
  if (vatRateSource !== undefined && vatRateSource !== null) {
    const bp = typeof vatRateSource === 'number' ? Math.round(vatRateSource * 10_000) : Number.NaN;
    if (Number.isInteger(bp) && bp >= 0 && bp <= 10_000 && Math.abs(vatRateSource * 10_000 - bp) < 1e-6) {
      vatRateBp = bp;
    } else {
      refusals.push(`storeIdentity.vatRate is ${JSON.stringify(vatRateSource)}: not a fraction that is a whole number of basis points in 0–10000`);
    }
  }

  const collisions = [];
  if (targetState?.tenantIds?.has(tenantId)) {
    collisions.push(`tenant id ${tenantId} already exists in the target`);
  }
  const hostname = `${tenantId}.import.invalid`;
  if (targetState?.hostnames?.has(hostname)) {
    collisions.push(`hostname ${hostname} already exists in the target`);
  }

  const rows = [];
  const reportLines = [...moneyLines];

  // ── tenants ──
  const supportEmailRaw = data.storeIdentity?.supportEmail ?? null;
  let supportEmail = supportEmailRaw;
  if (typeof supportEmailRaw === 'string' && supportEmailRaw.trim().length > 0) {
    const resolved = resolveEmail(supportEmailRaw, emailMap, scrubUnmapped, `shops/${tenantId}.storeIdentity.supportEmail`);
    supportEmail = resolved.value;
    if (resolved.action !== 'unchanged') {
      reportLines.push(`support_email ${resolved.action}`);
    }
  }

  // 0038 tenants_connect_facts_need_account_*: a requirements list, a
  // disabled reason or a payout delay without an account id is refused. When
  // stripe_account_id ends up NULL (no Connect account carried), every one of
  // these three facts must be NULL too, regardless of what the source or the
  // Connect-map resolution produced.
  const hasAccount = connectFacts.stripeAccountId !== null && connectFacts.stripeAccountId !== undefined;
  const tenantsRow = {
    commission_bps: commissionBps,
    connect_enabled: connectFacts.connectEnabled ? 1 : 0,
    created_at: formatTime('tenants', 'created_at', createdAtMillis),
    default_currency: 'SEK',
    default_locale: 'sv-SE',
    payout_delay_days: hasAccount ? connectFacts.payoutDelayDays ?? null : null,
    published,
    settings_json: null,
    shop_name: data.storeIdentity?.shopName ?? data.name ?? null,
    status,
    stripe_account_id: connectFacts.stripeAccountId,
    stripe_charges_enabled: connectFacts.chargesEnabled ? 1 : 0,
    stripe_details_submitted: connectFacts.detailsSubmitted ? 1 : 0,
    stripe_disabled_reason: hasAccount ? connectFacts.disabledReason ?? null : null,
    stripe_payouts_enabled: connectFacts.payoutsEnabled ? 1 : 0,
    stripe_requirements_due_json: hasAccount ? connectFacts.requirementsDueJson ?? null : null,
    support_email: emptyToNull(supportEmail),
    tenant_id: tenantId,
    updated_at: formatTime('tenants', 'updated_at', updatedAtMillis),
    vat_rate_bp: vatRateBp,
  };
  const tenantsColumns = [
    'tenant_id',
    'status',
    'shop_name',
    'support_email',
    'default_locale',
    'default_currency',
    'settings_json',
    'created_at',
    'updated_at',
    'published',
    'connect_enabled',
    'stripe_account_id',
    'stripe_charges_enabled',
    'stripe_payouts_enabled',
    'stripe_details_submitted',
    'stripe_requirements_due_json',
    'stripe_disabled_reason',
    'payout_delay_days',
    'commission_bps',
    'vat_rate_bp',
  ];
  rows.push(
    carriedRow(
      'tenants',
      tenantId,
      insertStatement('tenants', tenantsColumns, tenantsRow),
      rowContentHash('tenants', tenantsColumns, tenantsRow),
    ),
  );

  // ── tenant_domains: placeholder hostname (D7b) ──
  const domainId = `dom_${tenantId}_import`;
  const domainsRow = {
    created_at: formatTime('tenant_domains', 'created_at', nowMillis),
    domain_id: domainId,
    hostname,
    kind: 'storefront',
    status: 'pending',
    tenant_id: tenantId,
    updated_at: formatTime('tenant_domains', 'updated_at', nowMillis),
    verified_at: formatTimeOrNull('tenant_domains', 'verified_at', null),
  };
  const domainsColumns = ['domain_id', 'tenant_id', 'hostname', 'kind', 'status', 'verified_at', 'created_at', 'updated_at'];
  rows.push(
    carriedRow(
      'tenant_domains',
      domainId,
      insertStatement('tenant_domains', domainsColumns, domainsRow),
      rowContentHash('tenant_domains', domainsColumns, domainsRow),
    ),
  );

  // ── tenant_settings ──
  const rawIdentity = isPlainObject(data.storeIdentity) ? data.storeIdentity : {};
  const refused = refusedKeysOf(rawIdentity);
  let identity = sanitizeIdentity(rawIdentity);
  const { identity: identityNoStorageUrls, removedPaths } = removeStorageUrlsDeep(identity);
  identity = identityNoStorageUrls;
  for (const removedPath of removedPaths) reportLines.push(`storeIdentity.${removedPath} removed (Firebase Storage URL, not yet copied)`);
  if (refused.length > 0) reportLines.push(`storeIdentity refused keys dropped on import: ${refused.join(', ')}`);

  const emailScrub = scrubEmailsDeep(identity, emailMap, scrubUnmapped, `shops/${tenantId}.storeIdentity`);
  identity = emailScrub.value;
  for (const action of emailScrub.actions) reportLines.push(`${action.path} email ${action.action}`);

  const returnAddress = emptyToNull(rawIdentity.returnAddress ?? null);
  const vatRegisteredRaw = rawIdentity.vatRegistered;
  const vatRegistered = vatRegisteredRaw === true ? 1 : vatRegisteredRaw === false ? 0 : null;
  const vatNumber = emptyToNull(rawIdentity.vatNumber ?? null);
  const sellerTypeRaw = emptyToNull(rawIdentity.sellerType ?? null);
  const sellerType = sellerTypeRaw === 'individual' || sellerTypeRaw === 'company' ? sellerTypeRaw : null;

  const identityJson = JSON.stringify(identity);
  const settingsRow = {
    return_address: returnAddress,
    seller_type: sellerType,
    store_identity_json: identityJson,
    tenant_id: tenantId,
    updated_at: formatTime('tenant_settings', 'updated_at', nowMillis),
    updated_by: 'import',
    vat_number: vatNumber,
    vat_registered: vatRegistered,
  };
  const settingsColumns = [
    'tenant_id',
    'store_identity_json',
    'return_address',
    'vat_registered',
    'vat_number',
    'seller_type',
    'updated_at',
    'updated_by',
  ];
  rows.push(
    carriedRow(
      'tenant_settings',
      tenantId,
      insertStatement('tenant_settings', settingsColumns, settingsRow),
      rowContentHash('tenant_settings', settingsColumns, settingsRow),
    ),
  );

  // ── tenant_features (D22: effective values only) ──
  const rawFeatures = isPlainObject(data.features) ? data.features : {};
  const effective = {};
  for (const key of FEATURE_KEYS) {
    const raw = rawFeatures[key];
    if (OPT_IN_FEATURE_KEYS.has(key)) {
      effective[key] = raw === true;
    } else {
      effective[key] = raw !== false;
    }
  }
  // "An explicit pod row for every shop that has POD products or
  // features.pod === true" — CP3 cannot see products (CP4). Review round 1
  // decision: write `pod` explicitly for EVERY shop using the shop's own
  // `features.pod === true` for the value (so a shop that never had POD gets
  // an explicit pod row with value 0, and a shop that did gets 1) — this
  // satisfies the D22/D62 "every POD shop needs an explicit pod row"
  // invariant unconditionally. Every other key is explicit only when its
  // effective value differs from the default.
  for (const key of FEATURE_KEYS) {
    const value = effective[key];
    const mustBeExplicit = key === 'pod' || value !== FEATURE_DEFAULTS[key];
    if (!mustBeExplicit) continue;
    const featuresRow = {
      enabled: value ? 1 : 0,
      feature_key: key,
      tenant_id: tenantId,
      updated_at: formatTime('tenant_features', 'updated_at', nowMillis),
      updated_by: 'import',
    };
    const featuresColumns = ['tenant_id', 'feature_key', 'enabled', 'updated_at', 'updated_by'];
    rows.push(
      carriedRow(
        'tenant_features',
        `${tenantId}:${key}`,
        insertStatement('tenant_features', featuresColumns, featuresRow),
        rowContentHash('tenant_features', featuresColumns, featuresRow),
      ),
    );
  }

  // What verify.mjs compares the target against after the apply: read from
  // the rows written above, never recomputed.
  const expected = {
    chargesEnabled: tenantsRow.stripe_charges_enabled === 1,
    commissionBps: tenantsRow.commission_bps,
    connectEnabled: tenantsRow.connect_enabled === 1,
    payoutDelayDays: tenantsRow.payout_delay_days,
    payoutsEnabled: tenantsRow.stripe_payouts_enabled === 1,
    podEnabled: effective.pod,
    published: published === 1,
    status,
    stripeAccountId: tenantsRow.stripe_account_id ?? null,
    vatRateBp: tenantsRow.vat_rate_bp,
  };

  return {
    report: { collisions, expected, hostname, lines: reportLines, published, refusals, status, tenantId },
    rows,
    skipped: collisions.length > 0 ? 'collision' : null,
    tenantId,
  };
}
