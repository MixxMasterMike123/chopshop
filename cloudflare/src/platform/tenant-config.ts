import type {
  PlatformPrincipal,
  TenantAdminPrincipal,
} from "../auth/live-authorization";
import { auditMetadataJson } from "../auth/live-authorization";
import { resolvePublicImages } from "../storage/public-objects";

/**
 * CP3-A — a shop's configuration (migrations/0032_tenant_config.sql):
 *
 *   FEATURES  per-shop add-on entitlements (Firebase shops/{id}.features),
 *             platform-written, read by `isFeatureEnabled` everywhere.
 *   SETTINGS  the shop's store identity (Firebase shops/{id}.storeIdentity)
 *             plus the four fields the server gates checkout on, written by
 *             the shop's own admin (acting-as admitted).
 *
 * Plus the small helpers the three CP3-A platform modules share (audit rows,
 * tenant state, ISO time).
 */

// ── shared helpers ──────────────────────────────────────────────────────────

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOnlyKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(body).every((key) => allowed.includes(key));
}

/** Epoch milliseconds (the `tenants` / `tenant_domains` convention) → ISO. */
export function isoFromMs(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export type TenantStatus = "active" | "closed" | "provisioning" | "suspended";

/** The tenant's lifecycle status, or null when no such tenant exists. */
export async function readTenantStatus(
  db: D1Database,
  tenantId: string,
): Promise<TenantStatus | null> {
  const row = await db
    .prepare("SELECT status FROM tenants WHERE tenant_id = ? LIMIT 1")
    .bind(tenantId)
    .first<{ status: TenantStatus }>();
  return row?.status ?? null;
}

export interface AuditRow {
  action: string;
  metadata: Record<string, unknown> | null;
  reason?: string | null;
  resourceId: string;
  resourceType: string;
  tenantId: string;
}

/**
 * One platform-actor `audit_events` INSERT, written only while `guardSql`
 * (a boolean SQL expression, with `guardBinds`) holds at commit time. The
 * guard lives in the same statement, so the audit row and the change it
 * records are decided by the same snapshot of the batch's transaction.
 */
export function guardedPlatformAudit(
  db: D1Database,
  principal: PlatformPrincipal,
  row: AuditRow,
  now: number,
  guardSql: string,
  guardBinds: unknown[],
  eventId: string = crypto.randomUUID(),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (
         event_id, tenant_id, actor_user_id, action, resource_type,
         resource_id, reason, request_id, metadata_json, created_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ${guardSql}`,
    )
    .bind(
      eventId,
      row.tenantId,
      principal.userId,
      row.action,
      row.resourceType,
      row.resourceId,
      row.reason ?? null,
      crypto.randomUUID(),
      row.metadata === null ? null : JSON.stringify(row.metadata),
      now,
      ...guardBinds,
    );
}

/** The SQL guard "this tenant exists and is not closed". One bind: tenant id. */
export const TENANT_OPEN_GUARD =
  "EXISTS (SELECT 1 FROM tenants WHERE tenant_id = ? AND status <> 'closed')";

// ── features ────────────────────────────────────────────────────────────────

/**
 * The allowed feature keys: src/config/addons.js ADDON_CATALOG minus the two
 * refused groups below (D22, the manifest's §f Q9 proposal). MUST equal the
 * allowlist in the 0032 triggers (test/tenant-features.test.ts pins both).
 */
export const FEATURE_KEYS = [
  "abandonedCheckout",
  "contentStudio",
  "discountCodes",
  "marketingMaterials",
  "pod",
  "productReviews",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

/**
 * DELETED FROM THE PRODUCT: the pre-pivot CRM add-ons (PLAN §3.3, D2). They
 * never come back.
 */
export const DELETED_FEATURE_KEYS = [
  "ambassador",
  "campaigns",
  "dining",
  "writers",
] as const;

/**
 * NOT PORTED YET (PLAN §3.2 PORT-LATER): refused today; each comes back as an
 * allowed key, through a migration that replaces the two 0032 allowlist
 * triggers, in the checkpoint that ports its feature. Their Firebase values
 * stay in the archived raw map until then.
 */
export const NOT_PORTED_FEATURE_KEYS = ["affiliate", "b2b"] as const;

/**
 * Firebase OPT_IN_KEYS (addons.js, shopFeatures.ts): enabled only by an
 * explicit true. Every other allowed key is default-ON: enabled unless
 * explicitly false. A refused key (deleted or not ported) is never enabled.
 */
const OPT_IN_KEYS: ReadonlySet<FeatureKey> = new Set<FeatureKey>([
  "contentStudio",
  "marketingMaterials",
  "pod",
]);

/** The value a key has when the tenant has no explicit row for it. */
export const FEATURE_DEFAULTS: Readonly<Record<FeatureKey, boolean>> =
  Object.fromEntries(
    FEATURE_KEYS.map((key) => [key, !OPT_IN_KEYS.has(key)]),
  ) as Record<FeatureKey, boolean>;

export function isFeatureKey(value: unknown): value is FeatureKey {
  return (
    typeof value === "string" && (FEATURE_KEYS as readonly string[]).includes(value)
  );
}

export interface FeatureView {
  defaultEnabled: boolean;
  enabled: boolean;
  key: FeatureKey;
  source: "default" | "explicit";
}

/**
 * Is `key` enabled for `tenantId`? THE entitlement predicate for every module
 * and later checkpoint: an explicit row wins; no row means the key's default
 * (opt-in keys OFF, every other key ON) — Firebase isShopFeatureEnabled's rule.
 *
 * Unlike Firebase it does NOT fail open on a read error: a D1 fault propagates
 * to the caller like every other read in this Worker, instead of silently
 * granting a feature. A key outside the allowlist is never enabled.
 */
export async function isFeatureEnabled(
  db: D1Database,
  tenantId: string,
  key: FeatureKey,
): Promise<boolean> {
  if (!isFeatureKey(key)) {
    return false;
  }

  const row = await db
    .prepare(
      `SELECT enabled FROM tenant_features
       WHERE tenant_id = ? AND feature_key = ?
       LIMIT 1`,
    )
    .bind(tenantId, key)
    .first<{ enabled: number }>();

  return row === null ? FEATURE_DEFAULTS[key] : row.enabled === 1;
}

/** Every allowed key with its effective value and where the value came from. */
export async function readTenantFeatures(
  db: D1Database,
  tenantId: string,
): Promise<FeatureView[]> {
  const rows = await db
    .prepare(
      "SELECT feature_key, enabled FROM tenant_features WHERE tenant_id = ?",
    )
    .bind(tenantId)
    .all<{ enabled: number; feature_key: string }>();

  const explicit = new Map<string, boolean>();
  for (const row of rows.results) {
    explicit.set(row.feature_key, row.enabled === 1);
  }

  return FEATURE_KEYS.map((key) => {
    const value = explicit.get(key);
    return {
      defaultEnabled: FEATURE_DEFAULTS[key],
      enabled: value ?? FEATURE_DEFAULTS[key],
      key,
      source: value === undefined ? "default" : "explicit",
    };
  });
}

/**
 * `{ "features": { "<key>": true | false, … } }` — at least one key, every key
 * allowed, every value a boolean. Named keys become explicit rows; keys not
 * named keep whatever they had.
 */
export function parseFeaturesInput(
  body: unknown,
): Map<FeatureKey, boolean> | null {
  if (!isPlainObject(body) || !hasOnlyKeys(body, ["features"])) {
    return null;
  }
  const features = body.features;
  if (!isPlainObject(features)) {
    return null;
  }

  const entries = Object.entries(features);
  if (entries.length === 0) {
    return null;
  }

  const parsed = new Map<FeatureKey, boolean>();
  for (const [key, value] of entries) {
    if (!isFeatureKey(key) || typeof value !== "boolean") {
      return null;
    }
    parsed.set(key, value);
  }
  return parsed;
}

export type SetFeaturesResult =
  | { features: FeatureView[]; status: "ok" }
  | { status: "conflict" | "not_found" };

/**
 * Writes explicit values for the named keys, audited, in one batch. A closed
 * tenant is refused (409): the guard is inside every statement, so a close
 * that commits between the read and the batch leaves nothing half-written.
 */
export async function setTenantFeatures(
  db: D1Database,
  principal: PlatformPrincipal,
  tenantId: string,
  input: Map<FeatureKey, boolean>,
  now: number,
): Promise<SetFeaturesResult> {
  const status = await readTenantStatus(db, tenantId);
  if (status === null) {
    return { status: "not_found" };
  }
  if (status === "closed") {
    return { status: "conflict" };
  }

  const before = new Map(
    (await readTenantFeatures(db, tenantId)).map((view) => [view.key, view]),
  );
  const nowIso = new Date(now).toISOString();
  const set: Record<string, boolean> = {};
  const previous: Record<string, { enabled: boolean; source: string }> = {};
  for (const [key, enabled] of input) {
    set[key] = enabled;
    const view = before.get(key);
    if (view !== undefined) {
      previous[key] = { enabled: view.enabled, source: view.source };
    }
  }

  const statements: D1PreparedStatement[] = [
    guardedPlatformAudit(
      db,
      principal,
      {
        action: "tenant.features_update",
        metadata: { previous, set },
        resourceId: tenantId,
        resourceType: "tenant",
        tenantId,
      },
      now,
      TENANT_OPEN_GUARD,
      [tenantId],
    ),
  ];
  for (const [key, enabled] of input) {
    statements.push(
      db
        .prepare(
          `INSERT INTO tenant_features (
             tenant_id, feature_key, enabled, updated_at, updated_by
           )
           SELECT ?, ?, ?, ?, ?
           WHERE ${TENANT_OPEN_GUARD}
           ON CONFLICT (tenant_id, feature_key) DO UPDATE SET
             enabled = excluded.enabled,
             updated_at = excluded.updated_at,
             updated_by = excluded.updated_by`,
        )
        .bind(tenantId, key, enabled ? 1 : 0, nowIso, principal.userId, tenantId),
    );
  }

  const results = await db.batch(statements);
  if ((results[0]?.meta.changes ?? 0) === 0) {
    return { status: "conflict" };
  }

  return { features: await readTenantFeatures(db, tenantId), status: "ok" };
}

// ── store settings ──────────────────────────────────────────────────────────

/** Same number as the 0032 CHECK, counted here in UTF-8 bytes (stricter). */
export const STORE_IDENTITY_MAX_BYTES = 65_536;
/** Deep enough for theme.colors.* and menu[].children; shallow enough to stay sane. */
const STORE_IDENTITY_MAX_DEPTH = 8;
const RETURN_ADDRESS_MAX_LENGTH = 1_000;
const VAT_NUMBER_MAX_LENGTH = 64;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/**
 * Top-level store-identity keys this route refuses (400) and never returns.
 * Each has another home, and a second copy inside a seller-writable JSON blob
 * would either be ignored (confusing) or, worse, trusted by a later reader:
 *
 *   owned by `tenants`, written by the platform PATCH:
 *     shopName, supportEmail, status, published, commissionBps, vatRate,
 *     vatRateBp, currency, defaultCurrency, defaultLocale
 *   money / Connect (the `tenants` Connect columns, CP3-F):
 *     payments, stripeAccountId
 *   entitlements (tenant_features, platform only): features
 *   the platform-terms acceptance pointer (0031, CP3-E): platformTerms
 *   the four gate columns (top-level body fields of this route instead):
 *     returnAddress, vatRegistered, vatNumber, sellerType
 *   tenancy identity: tenantId, shopId
 *
 * Nested: `legal.acceptance` (the legal-pages acceptance pointer, CP3-E's
 * legal_acceptances). The rest of `legal` (custom, customUpdatedAt) is the
 * seller's own content and is accepted.
 */
export const REFUSED_STORE_IDENTITY_KEYS = [
  "commissionBps",
  "currency",
  "defaultCurrency",
  "defaultLocale",
  "features",
  "payments",
  "platformTerms",
  "published",
  "returnAddress",
  "sellerType",
  "shopId",
  "shopName",
  "status",
  "stripeAccountId",
  "supportEmail",
  "tenantId",
  "vatNumber",
  "vatRate",
  "vatRateBp",
  "vatRegistered",
] as const;

export const REFUSED_LEGAL_KEYS = ["acceptance"] as const;

export type SellerType = "company" | "individual";

export interface StoreSettingsView {
  returnAddress: string | null;
  sellerType: SellerType | null;
  storeIdentity: Record<string, unknown>;
  updatedAt: string | null;
  vatNumber: string | null;
  vatRegistered: boolean | null;
}

/** Present fields are written; absent (undefined) fields keep their value. */
export interface StoreSettingsInput {
  returnAddress?: string | null;
  sellerType?: SellerType | null;
  /** The canonical JSON text of the validated object. */
  storeIdentityJson?: string;
  vatNumber?: string | null;
  vatRegistered?: boolean | null;
}

export type StoreSettingsParse =
  | { input: StoreSettingsInput; status: "ok" }
  | { status: "invalid" }
  | { keys: string[]; status: "refused" };

const SETTINGS_KEYS = [
  "returnAddress",
  "sellerType",
  "storeIdentity",
  "vatNumber",
  "vatRegistered",
] as const;

function depthOf(value: unknown, depth = 0): number {
  if (typeof value !== "object" || value === null) {
    return depth;
  }
  let deepest = depth + 1;
  for (const child of Object.values(value)) {
    deepest = Math.max(deepest, depthOf(child, depth + 1));
    if (deepest > STORE_IDENTITY_MAX_DEPTH) {
      return deepest;
    }
  }
  return deepest;
}

/** The refused keys an identity object carries (top level + legal.*). */
export function refusedStoreIdentityKeys(
  identity: Record<string, unknown>,
): string[] {
  const refused: string[] = (REFUSED_STORE_IDENTITY_KEYS as readonly string[])
    .filter((key) => Object.hasOwn(identity, key));
  const legal = identity.legal;
  if (isPlainObject(legal)) {
    for (const key of REFUSED_LEGAL_KEYS) {
      if (Object.hasOwn(legal, key)) {
        refused.push(`legal.${key}`);
      }
    }
  }
  return refused;
}

/**
 * A copy of `identity` without any refused key. Applied on every READ as well,
 * so a row written by something other than this route (the importer, a hand
 * fix) can never hand a tenant admin a payments block or a commission.
 */
export function sanitizeStoreIdentity(
  identity: Record<string, unknown>,
): Record<string, unknown> {
  // Object.fromEntries defines OWN properties, so a stored "__proto__" key
  // stays data instead of becoming a prototype assignment on the copy.
  return Object.fromEntries(
    Object.entries(identity)
      .filter(([key]) => !(REFUSED_STORE_IDENTITY_KEYS as readonly string[]).includes(key))
      .map(([key, value]) =>
        key === "legal" && isPlainObject(value)
          ? [
              key,
              Object.fromEntries(
                Object.entries(value).filter(
                  ([legalKey]) => !(REFUSED_LEGAL_KEYS as readonly string[]).includes(legalKey),
                ),
              ),
            ]
          : [key, value],
      ),
  );
}

// ── the branding images of the store identity (CP4-D) ───────────────────────
//
// The identity names its images by OBJECT ID, never by address (D92, D95): an
// address is made at read time from the object's row, so moving the public
// bucket behind a domain of our own changes one value and no stored identity.
//
//   logoObjectId, heroObjectId, faviconObjectId, emailLogoObjectId
//   gallery[].imageObjectId
//
// Each must be an active public object of kind `shop_branding` of the SAME
// shop when it is written (`unreferencableStoreIdentityImages`); a later
// removal (D93) leaves the id in place and the public response shows no image.

/** The four top-level keys that name a branding image. */
export const STORE_IDENTITY_IMAGE_KEYS = [
  "emailLogoObjectId",
  "faviconObjectId",
  "heroObjectId",
  "logoObjectId",
] as const;

export type StoreIdentityImageKey = (typeof STORE_IDENTITY_IMAGE_KEYS)[number];

/** The key of a gallery entry that names its image. */
export const GALLERY_IMAGE_KEY = "imageObjectId";

/** What `crypto.randomUUID()` object ids (and any imported id) look like. */
const OBJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Hosts of the source system's file storage (the importer's list, manifest
 * §b, plus the bucket domains). An address on one of them points at storage
 * that is being retired and must never be written into an identity again.
 */
const SOURCE_STORAGE_MARKERS = [
  "firebasestorage.googleapis.com",
  "storage.googleapis.com",
  "firebasestorage.app",
  ".appspot.com",
  "gs://",
] as const;

export function isSourceStorageAddress(value: string): boolean {
  // As a URL parser reads a host: percent escapes of ASCII decoded, lower case.
  const plain = value
    .replace(/%([0-7][0-9a-f])/gi, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .toLowerCase();
  return SOURCE_STORAGE_MARKERS.some((marker) => plain.includes(marker));
}

/** Every path of the identity (any depth) whose string names source storage. */
function sourceStoragePaths(value: unknown, path: string, found: string[]): void {
  if (typeof value === "string") {
    if (isSourceStorageAddress(value)) {
      found.push(path);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => sourceStoragePaths(entry, `${path}[${index}]`, found));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      sourceStoragePaths(child, path === "" ? key : `${path}.${key}`, found);
    }
  }
}

export interface StoreIdentityImageRef {
  objectId: string;
  /** `logoObjectId`, or `gallery[2].imageObjectId`. */
  path: string;
}

/**
 * The object ids an identity names as images, with where. A value that is not
 * a well-formed id (or null, which clears) is not a reference: the parser
 * refuses it on write, and the public projection shows no image for it.
 */
export function storeIdentityImageRefs(
  identity: Record<string, unknown>,
): StoreIdentityImageRef[] {
  const refs: StoreIdentityImageRef[] = [];
  for (const key of STORE_IDENTITY_IMAGE_KEYS) {
    const value = identity[key];
    if (typeof value === "string" && OBJECT_ID_PATTERN.test(value)) {
      refs.push({ objectId: value, path: key });
    }
  }
  const gallery = identity.gallery;
  if (Array.isArray(gallery)) {
    gallery.forEach((entry: unknown, index) => {
      if (isPlainObject(entry)) {
        const value = entry[GALLERY_IMAGE_KEY];
        if (typeof value === "string" && OBJECT_ID_PATTERN.test(value)) {
          refs.push({ objectId: value, path: `gallery[${index}].${GALLERY_IMAGE_KEY}` });
        }
      }
    });
  }
  return refs;
}

/** true when every image key holds null or a well-formed object id. */
function imageKeysWellFormed(identity: Record<string, unknown>): boolean {
  const wellFormed = (value: unknown): boolean =>
    value === null || (typeof value === "string" && OBJECT_ID_PATTERN.test(value));
  for (const key of STORE_IDENTITY_IMAGE_KEYS) {
    if (Object.hasOwn(identity, key) && !wellFormed(identity[key])) {
      return false;
    }
  }
  const gallery = identity.gallery;
  if (Array.isArray(gallery)) {
    for (const entry of gallery as unknown[]) {
      if (
        isPlainObject(entry) &&
        Object.hasOwn(entry, GALLERY_IMAGE_KEY) &&
        !wellFormed(entry[GALLERY_IMAGE_KEY])
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * For PUT /v1/admin/settings, after `parseStoreSettingsInput`: the paths of
 * the identity's image references that this shop may NOT use — anything but
 * an active public `shop_branding` object of this tenant, and every reference
 * while the public object address is not configured
 * (`getReferencablePublicImage`'s conditions, in one batched read). Empty =
 * the write may proceed; otherwise the route answers 400 and writes nothing.
 */
export async function unreferencableStoreIdentityImages(
  env: Env,
  db: D1Database,
  tenantId: string,
  storeIdentityJson: string,
): Promise<string[]> {
  const parsed: unknown = JSON.parse(storeIdentityJson);
  if (!isPlainObject(parsed)) {
    return [];
  }
  const refs = storeIdentityImageRefs(parsed);
  if (refs.length === 0) {
    return [];
  }
  const images = await resolvePublicImages(
    env,
    db,
    tenantId,
    refs.map((ref) => ref.objectId),
    ["shop_branding"],
  );
  return refs.filter((ref) => !images.has(ref.objectId)).map((ref) => ref.path);
}

/** A trimmed, bounded, control-character-free string; '' → null (cleared). */
function parseOptionalText(
  value: unknown,
  maxLength: number,
  allowNewlines: boolean,
): { ok: true; value: string | null } | { ok: false } {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== "string") {
    return { ok: false };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: null };
  }
  if (
    trimmed.length > maxLength ||
    CONTROL_CHARACTERS.test(trimmed) ||
    (!allowNewlines && /[\r\n\t]/.test(trimmed))
  ) {
    return { ok: false };
  }
  return { ok: true, value: trimmed };
}

/**
 * PUT /v1/admin/settings body: any non-empty subset of
 *   storeIdentity  object (REPLACES the stored object; see the report). Its
 *                  image keys (STORE_IDENTITY_IMAGE_KEYS, gallery[].imageObjectId)
 *                  hold an object id or null; a string naming the source
 *                  system's storage anywhere in it is refused with its path.
 *                  Whether the ids may be used is decided with the database,
 *                  by `unreferencableStoreIdentityImages`.
 *   returnAddress  string | null ('' clears)
 *   vatRegistered  boolean | null (null = not answered)
 *   vatNumber      string | null ('' clears)
 *   sellerType     'individual' | 'company' | null ('' clears)
 */
export function parseStoreSettingsInput(body: unknown): StoreSettingsParse {
  if (!isPlainObject(body) || !hasOnlyKeys(body, SETTINGS_KEYS)) {
    return { status: "invalid" };
  }
  if (Object.keys(body).length === 0) {
    return { status: "invalid" };
  }

  const input: StoreSettingsInput = {};

  if (Object.hasOwn(body, "storeIdentity")) {
    const identity = parseIdentityObject(body.storeIdentity);
    if (identity.status !== "ok") {
      return identity;
    }
    input.storeIdentityJson = identity.json;
  }

  return parseGateFields(body, input);
}

/**
 * The checks one identity object passes on every write (PUT: the whole
 * identity; PATCH: the object of the top-level keys it replaces): no refused
 * key, at most STORE_IDENTITY_MAX_DEPTH deep, at most STORE_IDENTITY_MAX_BYTES,
 * image keys holding an object id or null, and no address of the source
 * system's storage anywhere in it.
 */
function parseIdentityObject(
  identity: unknown,
): { json: string; status: "ok" } | { status: "invalid" } | { keys: string[]; status: "refused" } {
  if (!isPlainObject(identity)) {
    return { status: "invalid" };
  }
  const refused = refusedStoreIdentityKeys(identity);
  if (refused.length > 0) {
    return { keys: refused, status: "refused" };
  }
  if (depthOf(identity) > STORE_IDENTITY_MAX_DEPTH) {
    return { status: "invalid" };
  }
  const json = JSON.stringify(identity);
  if (new TextEncoder().encode(json).byteLength > STORE_IDENTITY_MAX_BYTES) {
    return { status: "invalid" };
  }
  // CP4-D: an image is named by object id (null clears it) …
  if (!imageKeysWellFormed(identity)) {
    return { status: "invalid" };
  }
  // … and never by an address of the source system's storage, at any depth.
  const storagePaths: string[] = [];
  sourceStoragePaths(identity, "", storagePaths);
  if (storagePaths.length > 0) {
    return { keys: storagePaths, status: "refused" };
  }
  return { json, status: "ok" };
}

/** The four gate fields of a settings body (PUT and PATCH alike), into `input`. */
function parseGateFields(
  body: Record<string, unknown>,
  input: StoreSettingsInput,
): StoreSettingsParse {
  if (Object.hasOwn(body, "returnAddress")) {
    const parsed = parseOptionalText(body.returnAddress, RETURN_ADDRESS_MAX_LENGTH, true);
    if (!parsed.ok) {
      return { status: "invalid" };
    }
    input.returnAddress = parsed.value;
  }

  if (Object.hasOwn(body, "vatRegistered")) {
    const value = body.vatRegistered;
    if (value !== null && typeof value !== "boolean") {
      return { status: "invalid" };
    }
    input.vatRegistered = value;
  }

  if (Object.hasOwn(body, "vatNumber")) {
    const parsed = parseOptionalText(body.vatNumber, VAT_NUMBER_MAX_LENGTH, false);
    if (!parsed.ok) {
      return { status: "invalid" };
    }
    input.vatNumber = parsed.value;
  }

  if (Object.hasOwn(body, "sellerType")) {
    const value = body.sellerType;
    if (value === null || value === "") {
      input.sellerType = null;
    } else if (value === "individual" || value === "company") {
      input.sellerType = value;
    } else {
      return { status: "invalid" };
    }
  }

  return { input, status: "ok" };
}

interface SettingsRow {
  return_address: string | null;
  seller_type: SellerType | null;
  store_identity_json: string;
  updated_at: string;
  vat_number: string | null;
  vat_registered: number | null;
}

function parseStoredIdentity(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return isPlainObject(parsed) ? sanitizeStoreIdentity(parsed) : {};
  } catch {
    return {};
  }
}

/** The tenant admin's view. No row yet → an empty identity, every field unanswered. */
export async function readTenantSettings(
  db: D1Database,
  tenantId: string,
): Promise<StoreSettingsView> {
  const row = await db
    .prepare(
      `SELECT store_identity_json, return_address, vat_registered, vat_number,
              seller_type, updated_at
       FROM tenant_settings
       WHERE tenant_id = ?
       LIMIT 1`,
    )
    .bind(tenantId)
    .first<SettingsRow>();

  if (row === null) {
    return {
      returnAddress: null,
      sellerType: null,
      storeIdentity: {},
      updatedAt: null,
      vatNumber: null,
      vatRegistered: null,
    };
  }

  return {
    returnAddress: row.return_address,
    sellerType: row.seller_type,
    storeIdentity: parseStoredIdentity(row.store_identity_json),
    updatedAt: row.updated_at,
    vatNumber: row.vat_number,
    vatRegistered: row.vat_registered === null ? null : row.vat_registered === 1,
  };
}

/** What the platform detail shows: WHETHER the gate fields are answered, not their text. */
export async function readSettingsSummary(
  db: D1Database,
  tenantId: string,
): Promise<{ returnAddressSet: boolean; vatAnswered: boolean }> {
  const row = await db
    .prepare(
      `SELECT return_address IS NOT NULL AS has_return_address,
              vat_registered IS NOT NULL AS has_vat_answer
       FROM tenant_settings
       WHERE tenant_id = ?
       LIMIT 1`,
    )
    .bind(tenantId)
    .first<{ has_return_address: number; has_vat_answer: number }>();

  return {
    returnAddressSet: row?.has_return_address === 1,
    vatAnswered: row?.has_vat_answer === 1,
  };
}

/**
 * Upserts the present fields for the principal's shop, audited in the same
 * batch. The audit row names the FIELDS written, never their values (the
 * identity can be large and the gate fields are the seller's business data);
 * under an acting-as grant it also carries the grant id (auditMetadataJson).
 */
export async function writeTenantSettings(
  db: D1Database,
  principal: TenantAdminPrincipal,
  input: StoreSettingsInput,
  now: number,
): Promise<StoreSettingsView> {
  const nowIso = new Date(now).toISOString();
  const columns = settingsColumns(input);

  // Column names come from settingsColumns' fixed list, never from the request.
  const insertColumns = ["tenant_id", ...columns.map((entry) => entry.column), "updated_at", "updated_by"];
  const updateSet = [
    ...columns.map((entry) => `${entry.column} = excluded.${entry.column}`),
    // CP5-WK: strictly forward, so the PATCH's fence sees every write.
    `updated_at = ${nextUpdatedAtSql("excluded.updated_at")}`,
    "updated_by = excluded.updated_by",
  ];

  await db.batch([
    db
      .prepare(
        `INSERT INTO tenant_settings (${insertColumns.join(", ")})
         VALUES (${insertColumns.map(() => "?").join(", ")})
         ON CONFLICT (tenant_id) DO UPDATE SET ${updateSet.join(", ")}`,
      )
      .bind(
        principal.tenantId,
        ...columns.map((entry) => entry.value),
        nowIso,
        principal.userId,
      ),
    db
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type,
           resource_id, request_id, metadata_json, created_at
         ) VALUES (?, ?, ?, 'tenant.settings_update', 'tenant_settings', ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        principal.tenantId,
        principal.userId,
        principal.tenantId,
        crypto.randomUUID(),
        auditMetadataJson(principal, { fields: columns.map((entry) => entry.field) }),
        now,
      ),
  ]);

  return readTenantSettings(db, principal.tenantId);
}

interface SettingsColumn {
  column: string;
  field: string;
  value: unknown;
}

/** The present fields of a settings write, as (column, body field, value), in a fixed order. */
function settingsColumns(input: StoreSettingsInput): SettingsColumn[] {
  const columns: SettingsColumn[] = [];
  if (input.storeIdentityJson !== undefined) {
    columns.push({
      column: "store_identity_json",
      field: "storeIdentity",
      value: input.storeIdentityJson,
    });
  }
  if (input.returnAddress !== undefined) {
    columns.push({ column: "return_address", field: "returnAddress", value: input.returnAddress });
  }
  if (input.vatRegistered !== undefined) {
    columns.push({
      column: "vat_registered",
      field: "vatRegistered",
      value: input.vatRegistered === null ? null : input.vatRegistered ? 1 : 0,
    });
  }
  if (input.vatNumber !== undefined) {
    columns.push({ column: "vat_number", field: "vatNumber", value: input.vatNumber });
  }
  if (input.sellerType !== undefined) {
    columns.push({ column: "seller_type", field: "sellerType", value: input.sellerType });
  }
  return columns;
}

// ── the fenced partial write: PATCH /v1/admin/settings (CP5-WK, unit WD) ────
//
// The PUT replaces each field it names, the identity object WHOLE, with no
// lock: a page that reads, changes one key and writes the whole identity back
// overwrites whatever another tab, admin or operator wrote in between. The
// PATCH sends only the top-level identity keys it changes, and the
// `updatedAt` it read; the write happens only if the row is still at that
// `updatedAt`, else 409 and nothing is written.
//
// MERGE = REPLACE AT THE TOP-LEVEL KEY. Each key the patch's `storeIdentity`
// names replaces the stored key's value whole — an object (`theme`, `legal`,
// `social`), an array (`menu`, `gallery`, `pickupLocations`) or a scalar; a
// key set to null is stored as null (an image key's null clears the image, as
// on the PUT); a key the patch does not name keeps its value. There is no
// deep merge and no way to drop a key (the PUT does that). The page that
// changes one leaf of `legal` computes the new `legal` from the one it read,
// as it does today, and sends that key; the fence turns a write that landed
// in between into a 409, after which it reads again and re-applies. The base
// of the merge is the identity as the GET shows it (refused keys a non-route
// writer stored are dropped), so the result is what a read-modify-write PUT
// of the same keys would store.
//
// The same checks as the PUT, applied to the keys written: refused keys,
// depth, image keys well-formed, no source-storage address; the merged
// identity within STORE_IDENTITY_MAX_BYTES; and (in the route) the images the
// PATCHED keys name must be this shop's (an image the patch does not touch is
// not re-checked, so a removed logo no longer blocks an unrelated save).

/**
 * The next `updated_at` of an existing settings row, as SQL: the write's own
 * time when it is later than the stored one, else one millisecond after the
 * stored one. Every write moves `updated_at` strictly forward — two writes in
 * one millisecond, or a clock that stepped back, never leave the same value
 * twice — so it is a version the PATCH can fence on. `incoming` is the SQL of
 * the write's ISO time (each occurrence is its own bind when it is `?`).
 */
function nextUpdatedAtSql(incoming: string): string {
  return `CASE WHEN ${incoming} > tenant_settings.updated_at THEN ${incoming}
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', tenant_settings.updated_at, '+0.001 seconds') END`;
}

/** What the GET answers as `updatedAt`: ISO-8601 UTC with milliseconds (the 0032 CHECK). */
const UPDATED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const PATCH_SETTINGS_KEYS = [...SETTINGS_KEYS, "expectedUpdatedAt"] as const;

export interface StoreSettingsPatchInput {
  /** The `updatedAt` the caller read: the ISO time, or null for "no settings yet". */
  expectedUpdatedAt: string | null;
  /** The four gate fields the patch names (the PUT's rules). */
  gates: StoreSettingsInput;
  /** The top-level identity keys to replace (validated), and their canonical JSON. */
  identityPatch?: Record<string, unknown>;
  identityPatchJson?: string;
}

export type StoreSettingsPatchParse =
  | { input: StoreSettingsPatchInput; status: "ok" }
  | { status: "invalid" }
  | { keys: string[]; status: "refused" };

/**
 * PATCH /v1/admin/settings body:
 *   expectedUpdatedAt  REQUIRED: the `updatedAt` of the last GET (or write)
 *                      answer — an ISO string, or null when it was null
 *   storeIdentity      optional: an object of at least one top-level key, each
 *                      replacing the stored key (see above)
 *   returnAddress, vatRegistered, vatNumber, sellerType   optional, as the PUT
 * At least one of the last five must change something: `storeIdentity` with a
 * key, or a gate field.
 */
export function parseStoreSettingsPatchInput(body: unknown): StoreSettingsPatchParse {
  if (
    !isPlainObject(body) ||
    !hasOnlyKeys(body, PATCH_SETTINGS_KEYS) ||
    !Object.hasOwn(body, "expectedUpdatedAt")
  ) {
    return { status: "invalid" };
  }
  const expected = body.expectedUpdatedAt;
  if (expected !== null && (typeof expected !== "string" || !UPDATED_AT_PATTERN.test(expected))) {
    return { status: "invalid" };
  }

  const input: StoreSettingsPatchInput = { expectedUpdatedAt: expected, gates: {} };
  if (Object.hasOwn(body, "storeIdentity")) {
    const identity = body.storeIdentity;
    if (!isPlainObject(identity) || Object.keys(identity).length === 0) {
      return { status: "invalid" };
    }
    const parsed = parseIdentityObject(identity);
    if (parsed.status !== "ok") {
      return parsed;
    }
    input.identityPatch = identity;
    input.identityPatchJson = parsed.json;
  }

  const gates = parseGateFields(body, {});
  if (gates.status !== "ok") {
    return gates;
  }
  input.gates = gates.input;
  if (input.identityPatch === undefined && Object.keys(gates.input).length === 0) {
    return { status: "invalid" };
  }
  return { input, status: "ok" };
}

export type PatchSettingsResult =
  | { settings: StoreSettingsView; status: "ok" }
  /** The row is not at `expectedUpdatedAt` (before, or by the time of, the write): nothing written. */
  | { settings: StoreSettingsView; status: "stale" }
  /** The merged identity is over STORE_IDENTITY_MAX_BYTES: nothing written. */
  | { status: "invalid" };

/**
 * The fenced write. One read (the stored identity and its `updated_at`), the
 * merge, then ONE batch: the audit row and the write, both conditioned on the
 * row being exactly as read — `updated_at` unchanged, or still absent when
 * `expectedUpdatedAt` is null — so a write that lands in between makes both a
 * no-op (D1 runs the batch as one transaction). The audit row is the PUT's
 * (`tenant.settings_update`, the fields written, never a value) plus the
 * identity keys replaced; under acting-as it carries the grant id.
 */
export async function patchTenantSettings(
  db: D1Database,
  principal: TenantAdminPrincipal,
  input: StoreSettingsPatchInput,
  now: number,
): Promise<PatchSettingsResult> {
  const tenantId = principal.tenantId;
  const stale = async (): Promise<PatchSettingsResult> => ({
    settings: await readTenantSettings(db, tenantId),
    status: "stale",
  });

  const row = await db
    .prepare("SELECT store_identity_json, updated_at FROM tenant_settings WHERE tenant_id = ? LIMIT 1")
    .bind(tenantId)
    .first<{ store_identity_json: string; updated_at: string }>();
  if ((row?.updated_at ?? null) !== input.expectedUpdatedAt) {
    return stale();
  }

  const write: StoreSettingsInput = { ...input.gates };
  if (input.identityPatch !== undefined) {
    const base = row === null ? {} : parseStoredIdentity(row.store_identity_json);
    // Own properties only, key order kept: a replaced key stays where it was.
    const merged = Object.fromEntries([
      ...Object.entries(base),
      ...Object.entries(input.identityPatch),
    ]);
    const json = JSON.stringify(merged);
    if (new TextEncoder().encode(json).byteLength > STORE_IDENTITY_MAX_BYTES) {
      return { status: "invalid" };
    }
    write.storeIdentityJson = json;
  }
  const columns = settingsColumns(write);
  const nowIso = new Date(now).toISOString();

  // "The row is as read", as SQL; the same guard for the audit row and the write.
  const guard =
    row === null
      ? { binds: [tenantId], sql: "NOT EXISTS (SELECT 1 FROM tenant_settings WHERE tenant_id = ?)" }
      : {
          binds: [tenantId, row.updated_at],
          sql: "EXISTS (SELECT 1 FROM tenant_settings WHERE tenant_id = ? AND updated_at = ?)",
        };

  const audit = db
    .prepare(
      `INSERT INTO audit_events (
         event_id, tenant_id, actor_user_id, action, resource_type,
         resource_id, request_id, metadata_json, created_at
       )
       SELECT ?, ?, ?, 'tenant.settings_update', 'tenant_settings', ?, ?, ?, ?
       WHERE ${guard.sql}`,
    )
    .bind(
      crypto.randomUUID(),
      tenantId,
      principal.userId,
      tenantId,
      crypto.randomUUID(),
      auditMetadataJson(principal, {
        fields: columns.map((entry) => entry.field),
        ...(input.identityPatch === undefined
          ? {}
          : { identityKeys: Object.keys(input.identityPatch).sort() }),
      }),
      now,
      ...guard.binds,
    );

  // Column names come from settingsColumns' fixed list, never from the request.
  const change =
    row === null
      ? db
          .prepare(
            `INSERT INTO tenant_settings (
               tenant_id, ${columns.map((entry) => entry.column).join(", ")}, updated_at, updated_by
             )
             SELECT ?, ${columns.map(() => "?").join(", ")}, ?, ?
             WHERE ${guard.sql}`,
          )
          .bind(tenantId, ...columns.map((entry) => entry.value), nowIso, principal.userId, ...guard.binds)
      : db
          .prepare(
            `UPDATE tenant_settings
             SET ${columns.map((entry) => `${entry.column} = ?`).join(", ")},
                 updated_at = ${nextUpdatedAtSql("?")},
                 updated_by = ?
             WHERE tenant_id = ? AND updated_at = ?`,
          )
          .bind(
            ...columns.map((entry) => entry.value),
            nowIso,
            nowIso,
            principal.userId,
            tenantId,
            row.updated_at,
          );

  const results = await db.batch([audit, change]);
  // D1 counts rows a trigger wrote too (catalog_version): "nothing" is === 0.
  if ((results[1]?.meta.changes ?? 0) === 0) {
    return stale();
  }
  return { settings: await readTenantSettings(db, tenantId), status: "ok" };
}
