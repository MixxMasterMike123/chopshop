import {
  ELIGIBLE_PRODUCTS_FROM,
  PUBLIC_ELIGIBILITY_PREDICATE,
} from "../catalog/eligibility";
import {
  GALLERY_IMAGE_KEY,
  isPlainObject,
  isSourceStorageAddress,
  STORE_IDENTITY_IMAGE_KEYS,
  type StoreIdentityImageKey,
} from "../platform/tenant-config";
import type { PublicImage } from "../storage/public-objects";
import {
  ALL_PRODUCTS_PATH,
  categoryPath,
  collectionPath,
  HOME_PATH,
  pagePath,
  productPath,
  tagPath,
} from "./addresses";

/**
 * CP4-D — what of a shop's store identity (`tenant_settings.store_identity_json`)
 * a visitor may see: an ALLOWLIST, written key by key.
 *
 * Nothing is copied by default. Every key below is named, read by its own
 * rule and bounded; a key that is not named here — whatever the stored object
 * holds, whatever a page reads today, and every key added to the identity
 * later — is never in a public response. The table of every key, who shows it
 * and why it is in or out, is in docs/cf-port/CP4_D_REPORT.md.
 *
 * Never on the list: the return address (the legal pages print it from the
 * adopted snapshot, not from here), the VAT answer and number, the seller
 * type, the contact and notification addresses no page prints, anything under
 * `legal` (the acceptance pointer, the custom-page flags, the seller's own
 * withdrawal notice — checkout shows the platform's fixed notice, the one the
 * server records as proof), payments, commission, features, the old image
 * ADDRESSES (`logoUrl`, … — images are object ids, resolved at read time),
 * the Trustpilot invite sender, and the inert add-on settings.
 *
 * Text that a page prints as text is returned as stored, trimmed and bounded;
 * the page escapes it (React) and the SEO answer escapes it on the server.
 */

// ── readers ─────────────────────────────────────────────────────────────────

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const LINE_BREAKS = /[\r\n\t]/;

/**
 * A non-empty trimmed string of at most `max` characters, else undefined.
 * Every string of the projection passes here, so a string naming the source
 * system's storage — which PUT /v1/admin/settings refuses and the importer
 * removes (D73) — never reaches a visitor from a row written any other way.
 */
function readText(value: unknown, max: number, multiline = false): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > max ||
    CONTROL_CHARACTERS.test(trimmed) ||
    (!multiline && LINE_BREAKS.test(trimmed)) ||
    isSourceStorageAddress(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

/** An absolute http(s) address with no credentials, as the URL parser writes it. */
export function readHttpUrl(value: unknown, max = 500): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max || isSourceStorageAddress(trimmed)) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return undefined;
  }
  return url.href;
}

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function readHostname(value: unknown): string | undefined {
  return typeof value === "string" && HOSTNAME.test(value.trim())
    ? value.trim().toLowerCase()
    : undefined;
}

// A theme value becomes a CSS custom property on the storefront's <html>:
// nothing that can fetch (`url(`, `image-set(`, `@import`), nothing that could
// end a declaration or a block, no escapes that could spell either.
const UNSAFE_CSS = /url\(|image-set\(|@import|expression\(|[;{}<>\\]/i;

function readCssValue(value: unknown): string | number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  const text = readText(value, 200);
  return text === undefined || UNSAFE_CSS.test(text) ? undefined : text;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * A member of a stored object, only when it is the object's OWN: a value an
 * object inherits is never read (the stored identity is JSON, which has none,
 * and the projection does not rely on that).
 */
function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Drops undefined members, so an absent key is absent in the JSON too. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, member]) => member !== undefined),
  ) as T;
}

// ── the identity ────────────────────────────────────────────────────────────

export const SOCIAL_KEYS = [
  "facebook",
  "instagram",
  "linkedin",
  "pinterest",
  "tiktok",
  "website",
  "youtube",
] as const;

export type SocialKey = (typeof SOCIAL_KEYS)[number];

export const BLOCK_KEYS = ["bestseller", "collections", "gallery", "story", "trust"] as const;

export type BlockKey = (typeof BLOCK_KEYS)[number];

export interface PublicStoryStep {
  text?: string;
  title?: string;
}

export interface PublicGalleryEntry {
  /** null when the entry names no image, or one that does not resolve. */
  image: PublicImage | null;
  label: string;
  /** The linked product's path, when the entry links one that is public. */
  path: string | null;
}

/** Every key a visitor may see of the identity. Absent = not set. */
export interface PublicStoreIdentity {
  address?: string;
  blocks?: Partial<Record<BlockKey, boolean>>;
  businessInfo?: string;
  collectionsTitle?: string;
  companyDescription?: string;
  featuredLimit?: number;
  featuredTitle?: string;
  frontpageCategory?: string;
  gallery?: PublicGalleryEntry[];
  heroCtaLabel?: string;
  heroHeadline?: string;
  heroMark?: string;
  heroSecondaryLabel?: string;
  heroSubtitle?: string;
  introBody?: string;
  introTitle?: string;
  legalName?: string;
  orgNumber?: string;
  productsSubtitle?: string;
  productsTitle?: string;
  reviewsSubtitle?: string;
  reviewsTitle?: string;
  social?: Partial<Record<SocialKey, string>>;
  story?: PublicStoryStep[];
  storyTitle?: string;
  /** From `tenants.support_email`: the footer's contact link, the home's JSON-LD. */
  supportEmail?: string;
  tagline?: string;
  trustpilot?: { domain: string };
}

/** The page shows at most 4 gallery tiles and 3 story steps (PublicStorefront). */
const GALLERY_MAX = 4;
const STORY_MAX = 3;

function projectSocial(value: unknown): Partial<Record<SocialKey, string>> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const social: Partial<Record<SocialKey, string>> = {};
  for (const key of SOCIAL_KEYS) {
    const url = readHttpUrl(own(value, key));
    if (url !== undefined) {
      social[key] = url;
    }
  }
  return Object.keys(social).length === 0 ? undefined : social;
}

function projectBlocks(value: unknown): Partial<Record<BlockKey, boolean>> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const blocks: Partial<Record<BlockKey, boolean>> = {};
  for (const key of BLOCK_KEYS) {
    const flag = readBoolean(own(value, key));
    if (flag !== undefined) {
      blocks[key] = flag;
    }
  }
  return Object.keys(blocks).length === 0 ? undefined : blocks;
}

function projectStory(value: unknown): PublicStoryStep[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const steps: PublicStoryStep[] = [];
  for (const entry of (value as unknown[]).slice(0, STORY_MAX)) {
    if (isPlainObject(entry)) {
      steps.push(
        compact({ text: readText(own(entry, "text"), 1_000, true), title: readText(own(entry, "title"), 200) }),
      );
    }
  }
  return steps.length === 0 ? undefined : steps;
}

function projectTrustpilot(value: unknown): { domain: string } | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const domain = readHostname(own(value, "domain"));
  return domain === undefined ? undefined : { domain };
}

/** The page clamps it to 1..12 (PublicStorefront); anything else is not set. */
function readFeaturedLimit(value: unknown): number | undefined {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d{1,2}$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  return Number.isInteger(number) && number >= 1 && number <= 12 ? number : undefined;
}

/** What the projection needs from the database, resolved beforehand. */
export interface IdentityResolutions {
  /** Active public `shop_branding` objects of this shop, by object id. */
  images: ReadonlyMap<string, PublicImage>;
  /** Public products of this shop by sku → their path. */
  productPathsBySku: ReadonlyMap<string, string>;
  supportEmail: string | null;
}

interface StoredGalleryEntry {
  imageObjectId: string | null;
  label: string;
  linkSku: string | null;
}

function storedGallery(value: unknown): StoredGalleryEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: StoredGalleryEntry[] = [];
  for (const entry of (value as unknown[]).slice(0, GALLERY_MAX)) {
    if (isPlainObject(entry)) {
      const id = own(entry, GALLERY_IMAGE_KEY);
      entries.push({
        imageObjectId: typeof id === "string" ? id : null,
        label: readText(own(entry, "label"), 200) ?? "",
        linkSku: readText(own(entry, "linkSku"), 128) ?? null,
      });
    }
  }
  return entries;
}

/** The SKUs the gallery links to (read before projecting, to resolve paths). */
export function galleryLinkSkus(identity: Record<string, unknown>): string[] {
  return storedGallery(own(identity, "gallery"))
    .map((entry) => entry.linkSku)
    .filter((sku): sku is string => sku !== null);
}

/**
 * THE projection. `identity` is the stored object (already stripped of the
 * refused keys by `readTenantSettings`'s rule); only the keys named here leave.
 */
export function projectStoreIdentity(
  identity: Record<string, unknown>,
  resolved: IdentityResolutions,
): PublicStoreIdentity {
  const gallery = storedGallery(own(identity, "gallery")).map(
    (entry): PublicGalleryEntry => ({
      image:
        entry.imageObjectId === null ? null : (resolved.images.get(entry.imageObjectId) ?? null),
      label: entry.label,
      path: entry.linkSku === null ? null : (resolved.productPathsBySku.get(entry.linkSku) ?? null),
    }),
  );

  return compact<PublicStoreIdentity>({
    address: readText(own(identity, "address"), 1_000, true),
    blocks: projectBlocks(own(identity, "blocks")),
    businessInfo: readText(own(identity, "businessInfo"), 300),
    collectionsTitle: readText(own(identity, "collectionsTitle"), 200),
    companyDescription: readText(own(identity, "companyDescription"), 1_000, true),
    featuredLimit: readFeaturedLimit(own(identity, "featuredLimit")),
    featuredTitle: readText(own(identity, "featuredTitle"), 200),
    frontpageCategory: readText(own(identity, "frontpageCategory"), 200),
    gallery: gallery.length === 0 ? undefined : gallery,
    heroCtaLabel: readText(own(identity, "heroCtaLabel"), 100),
    heroHeadline: readText(own(identity, "heroHeadline"), 300),
    heroMark: readText(own(identity, "heroMark"), 20),
    heroSecondaryLabel: readText(own(identity, "heroSecondaryLabel"), 100),
    heroSubtitle: readText(own(identity, "heroSubtitle"), 500, true),
    introBody: readText(own(identity, "introBody"), 5_000, true),
    introTitle: readText(own(identity, "introTitle"), 300),
    legalName: readText(own(identity, "legalName"), 200),
    orgNumber: readText(own(identity, "orgNumber"), 64),
    productsSubtitle: readText(own(identity, "productsSubtitle"), 500),
    productsTitle: readText(own(identity, "productsTitle"), 200),
    reviewsSubtitle: readText(own(identity, "reviewsSubtitle"), 500),
    reviewsTitle: readText(own(identity, "reviewsTitle"), 200),
    social: projectSocial(own(identity, "social")),
    story: projectStory(own(identity, "story")),
    storyTitle: readText(own(identity, "storyTitle"), 200),
    supportEmail: readText(resolved.supportEmail, 320),
    tagline: readText(own(identity, "tagline"), 300),
    trustpilot: projectTrustpilot(own(identity, "trustpilot")),
  });
}

// ── branding ────────────────────────────────────────────────────────────────

export interface PublicBranding {
  emailLogo: PublicImage | null;
  favicon: PublicImage | null;
  hero: PublicImage | null;
  logo: PublicImage | null;
}

const BRANDING_FIELDS: Readonly<Record<keyof PublicBranding, StoreIdentityImageKey>> = {
  emailLogo: "emailLogoObjectId",
  favicon: "faviconObjectId",
  hero: "heroObjectId",
  logo: "logoObjectId",
};

export function projectBranding(
  identity: Record<string, unknown>,
  images: ReadonlyMap<string, PublicImage>,
): PublicBranding {
  const image = (key: StoreIdentityImageKey): PublicImage | null => {
    const id = own(identity, key);
    return typeof id === "string" ? (images.get(id) ?? null) : null;
  };
  return {
    emailLogo: image(BRANDING_FIELDS.emailLogo),
    favicon: image(BRANDING_FIELDS.favicon),
    hero: image(BRANDING_FIELDS.hero),
    logo: image(BRANDING_FIELDS.logo),
  };
}

/** Every object id the identity names as an image (branding keys + gallery). */
export function identityImageIds(identity: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const key of STORE_IDENTITY_IMAGE_KEYS) {
    const id = own(identity, key);
    if (typeof id === "string") {
      ids.push(id);
    }
  }
  for (const entry of storedGallery(own(identity, "gallery"))) {
    if (entry.imageObjectId !== null) {
      ids.push(entry.imageObjectId);
    }
  }
  return ids;
}

// ── theme, template, accent, pickup places ──────────────────────────────────

/**
 * The token groups and keys the storefront reads (src/config/nordTokens.js
 * TOKEN_CSS_VAR and TOKEN_ENUMS). A key outside this table is never public.
 */
const THEME_KEYS = {
  colors: [
    "accent",
    "accentInk",
    "accentSoft",
    "canvas",
    "ink",
    "inkFaint",
    "inkMuted",
    "line",
    "surface",
  ],
  fonts: ["body", "display"],
  layout: ["cardStyle", "density", "gridCols", "heroStyle"],
  motion: ["ease"],
  shape: ["rEl", "rTile"],
} as const;

type ThemeGroup = keyof typeof THEME_KEYS;

export type PublicTheme = Partial<Record<ThemeGroup, Record<string, string | number>>>;

export function projectTheme(value: unknown): PublicTheme {
  const theme: PublicTheme = {};
  if (!isPlainObject(value)) {
    return theme;
  }
  for (const group of Object.keys(THEME_KEYS) as ThemeGroup[]) {
    const stored = own(value, group);
    if (!isPlainObject(stored)) {
      continue;
    }
    const tokens: Record<string, string | number> = {};
    for (const key of THEME_KEYS[group]) {
      const token = readCssValue(own(stored, key));
      if (token !== undefined) {
        tokens[key] = token;
      }
    }
    if (Object.keys(tokens).length > 0) {
      theme[group] = tokens;
    }
  }
  return theme;
}

export function projectAccent(value: unknown): string | null {
  const accent = readCssValue(value);
  return typeof accent === "string" ? accent : null;
}

/** A template id of src/config/templates.js ('' or absent = NORD). */
export function projectTemplateId(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9-]{1,64}$/.test(value) ? value : null;
}

export interface PublicPickupLocation {
  address?: string;
  /** ISO YYYY-MM-DD pickup dates; empty = no date to choose. */
  dates: string[];
  hours?: string;
  id: string;
  name?: string;
}

const PICKUP_LOCATIONS_MAX = 50;
const PICKUP_DATES_MAX = 400;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Checkout offers these (Checkout.jsx): one option per (place, date). */
export function projectPickupLocations(value: unknown): PublicPickupLocation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const locations: PublicPickupLocation[] = [];
  for (const entry of (value as unknown[]).slice(0, PICKUP_LOCATIONS_MAX)) {
    if (!isPlainObject(entry)) {
      continue;
    }
    const id = readText(own(entry, "id"), 128);
    if (id === undefined) {
      continue;
    }
    const storedDates = own(entry, "dates");
    const dates = Array.isArray(storedDates)
      ? (storedDates as unknown[])
          .slice(0, PICKUP_DATES_MAX)
          .filter((date): date is string => typeof date === "string" && ISO_DATE.test(date))
      : [];
    locations.push(
      compact<PublicPickupLocation>({
        address: readText(own(entry, "address"), 500, true),
        dates,
        hours: readText(own(entry, "hours"), 300, true),
        id,
        name: readText(own(entry, "name"), 200),
      }),
    );
  }
  return locations;
}

// ── the menu ────────────────────────────────────────────────────────────────

export const MENU_TYPES = [
  "all-products",
  "category",
  "collection",
  "home",
  "page",
  "tag",
  "url",
] as const;

export type MenuType = (typeof MENU_TYPES)[number];

/**
 * One entry of the shop's menu (src/pages/admin/AdminMenu.jsx writes
 * `{ type, target, label }`), with its target resolved. Exactly one of `path`
 * (a path relative to the shop's root) and `url` (an absolute http(s) address
 * of type `url`, which the storefront opens as an outside link) is set.
 */
export interface PublicMenuEntry {
  label: string;
  path: string | null;
  target: string;
  type: MenuType;
  url: string | null;
}

interface StoredMenuEntry {
  label: string;
  target: string;
  type: MenuType;
}

const MENU_MAX = 50;

export function storedMenu(value: unknown): StoredMenuEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: StoredMenuEntry[] = [];
  for (const entry of (value as unknown[]).slice(0, MENU_MAX)) {
    if (!isPlainObject(entry)) {
      continue;
    }
    const label = readText(own(entry, "label"), 100);
    const type = own(entry, "type");
    const storedTarget = own(entry, "target");
    const target = storedTarget === undefined || storedTarget === null ? "" : storedTarget;
    if (
      label === undefined ||
      typeof type !== "string" ||
      !(MENU_TYPES as readonly string[]).includes(type) ||
      typeof target !== "string" ||
      target.length > 500
    ) {
      continue;
    }
    entries.push({ label, target: target.trim(), type: type as MenuType });
  }
  return entries;
}

export interface MenuResolutions {
  /** Handles of this shop's PUBLISHED collections, among those the menu names. */
  collectionHandles: ReadonlySet<string>;
  /** Slugs of this shop's PUBLISHED pages and posts, among those the menu names. */
  pageSlugs: ReadonlySet<string>;
}

/**
 * The menu with every target resolved. An entry is left out when its
 * collection or page does not exist or is not public, when a category or tag
 * slugifies to nothing, and when a `url` entry is not an http(s) address.
 */
export function resolveMenu(
  entries: readonly StoredMenuEntry[],
  resolved: MenuResolutions,
): PublicMenuEntry[] {
  const menu: PublicMenuEntry[] = [];
  for (const entry of entries) {
    let path: string | null = null;
    let url: string | null = null;
    switch (entry.type) {
      case "home":
        path = HOME_PATH;
        break;
      case "all-products":
        path = ALL_PRODUCTS_PATH;
        break;
      case "category":
        path = entry.target === "" ? null : categoryPath(entry.target);
        break;
      case "tag":
        path = entry.target === "" ? null : tagPath(entry.target);
        break;
      case "collection":
        path = resolved.collectionHandles.has(entry.target) ? collectionPath(entry.target) : null;
        break;
      case "page":
        path = resolved.pageSlugs.has(entry.target) ? pagePath(entry.target) : null;
        break;
      case "url":
        url = readHttpUrl(entry.target) ?? null;
        break;
    }
    if (path !== null || url !== null) {
      menu.push({ label: entry.label, path, target: entry.target, type: entry.type, url });
    }
  }
  return menu;
}

// ── reads the projection needs (other builders' tables) ─────────────────────
//
// Each names only the columns CP4_BRIEFS.md fixes for tables B and C own
// (`collections`, `pages`) and A's `products.handle`; each is a candidate for
// that builder's own exported function (Reviewer wiring in the report).

const IN_CHUNK = 90;

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function chunked(values: readonly string[]): string[][] {
  const unique = [...new Set(values)];
  const out: string[][] = [];
  for (let start = 0; start < unique.length; start += IN_CHUNK) {
    out.push(unique.slice(start, start + IN_CHUNK));
  }
  return out;
}

async function readSet(
  db: D1Database,
  sql: (count: number) => string,
  tenantId: string,
  values: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  const groups = chunked(values);
  if (groups.length === 0) {
    return found;
  }
  const results = await db.batch<{ value: string }>(
    groups.map((group) => db.prepare(sql(group.length)).bind(tenantId, ...group)),
  );
  for (const result of results) {
    for (const row of result.results) {
      found.add(row.value);
    }
  }
  return found;
}

/** The menu's collection and page targets that are public. No query when none. */
export async function readMenuResolutions(
  db: D1Database,
  tenantId: string,
  entries: readonly StoredMenuEntry[],
): Promise<MenuResolutions> {
  const handles = entries.filter((entry) => entry.type === "collection").map((entry) => entry.target);
  const slugs = entries.filter((entry) => entry.type === "page").map((entry) => entry.target);
  const [collectionHandles, pageSlugs] = await Promise.all([
    readSet(
      db,
      (count) =>
        `SELECT handle AS value FROM collections
         WHERE tenant_id = ? AND published = 1 AND handle IN (${placeholders(count)})
         LIMIT ${IN_CHUNK}`,
      tenantId,
      handles,
    ),
    readSet(
      db,
      (count) =>
        `SELECT slug AS value FROM pages
         WHERE tenant_id = ? AND status = 'published' AND slug IN (${placeholders(count)})
         LIMIT ${IN_CHUNK}`,
      tenantId,
      slugs,
    ),
  ]);
  return { collectionHandles, pageSlugs };
}

/**
 * The paths of the PUBLIC products (THE predicate) among `skus`. A product
 * that is not public gives no path: its tile shows, unlinked.
 */
export async function readProductPathsBySku(
  db: D1Database,
  tenantId: string,
  skus: readonly string[],
): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  const groups = chunked(skus);
  if (groups.length === 0) {
    return paths;
  }
  const results = await db.batch<{ handle: string | null; sku: string }>(
    groups.map((group) =>
      db
        .prepare(
          `SELECT product.sku AS sku, product.handle AS handle
           ${ELIGIBLE_PRODUCTS_FROM}
           WHERE publication.tenant_id = ?
             AND product.tenant_id = ?
             AND product.sku IN (${placeholders(group.length)})
             AND ${PUBLIC_ELIGIBILITY_PREDICATE}
           LIMIT ${IN_CHUNK}`,
        )
        .bind(tenantId, tenantId, ...group),
    ),
  );
  for (const result of results) {
    for (const row of result.results) {
      if (typeof row.handle === "string" && row.handle.length > 0) {
        paths.set(row.sku, productPath(row.handle));
      }
    }
  }
  return paths;
}
