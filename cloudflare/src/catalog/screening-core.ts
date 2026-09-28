/**
 * Content screening — the PURE half (no D1, no env). Ported from
 * functions/src/catalog/contentScreening.ts (SnapWear A11):
 *
 *   foldText / tokenize / findScreeningHits   the blocklist matcher (L26–94)
 *   productUsesMapping                          productUsesMappingSku (L99–122)
 *   decideScreening                             the trigger state machine (L124–217)
 *
 * plus the D8 overlay (DECISIONS D8: approval-before-first-sale for a shop's
 * first N=2 products, advisory after) that maps the Firebase machine's statuses
 * onto the CF vocabulary in migrations/0024_product_screening.sql.
 *
 * The matcher and the machine are behaviour-identical to Firebase; the only
 * adaptations are the ones the data model forces, each named where it happens.
 */

export interface BlocklistEntry {
  hardBlock: boolean;
  kind: string;
  term: string;
}

const EXTRA_FOLDS: Record<string, string> = {
  æ: "ae",
  ð: "d",
  đ: "d",
  ı: "i",
  ł: "l",
  ø: "o",
  œ: "oe",
  ß: "ss",
  þ: "th",
};

export const foldText = (value: unknown): string =>
  String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[øæœßðþłđı]/g, (c) => EXTRA_FOLDS[c] ?? c);

export const tokenize = (value: unknown): string => {
  const t = foldText(value).replace(/[^a-z0-9]+/g, " ").trim();
  return t ? ` ${t} ` : "";
};

const stripHtml = (value: unknown): string =>
  String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ");

/**
 * Every text of one product a visitor reads (CP4-A). `name` and `description`
 * are always there; the rest are optional so that a caller which knows only
 * those two (the CP2/CP3 paths) still type-checks and screens what it always
 * screened. src/catalog/admin-product-reads.ts `loadProductScreeningInput`
 * reads the whole set from D1.
 */
export interface ProductScreeningInput {
  brand?: string | null;
  category?: string | null;
  description: string | null;
  /** The alt text of every image row of the product. */
  imageAlts?: readonly string[];
  /** "Mer information": HTML, screened with its markup stripped. */
  moreInfo?: string | null;
  name: string;
  size?: string | null;
  sizeGuide?: string | null;
  tags?: readonly string[];
  /** The label, group and size of every ACTIVE variant. */
  variantTexts?: readonly string[];
}

/**
 * The screened texts of one product. Firebase read name, description, the two
 * `descriptions.b2c*` fields, tags and the artwork file names/labels. A CF
 * artwork has no label, so the artwork contribution is the original's file name
 * (the last segment of its stored object key). CP4-A adds every further text a
 * visitor reads: the further description (`b2cMoreInfo`), the size guide, the
 * category, the tags, the brand, the product's size, the label, group and size
 * of each active variant, and the image alt texts. They come AFTER the texts of
 * before, so the stored haystack of a product that has none of them is
 * byte-identical to what CP3 stored.
 */
export const productScreeningTexts = (
  product: ProductScreeningInput,
  artworkFileNames: readonly string[] = [],
): string[] =>
  [
    product.name,
    stripHtml(product.description ?? ""),
    ...artworkFileNames,
    stripHtml(product.moreInfo ?? ""),
    product.sizeGuide ?? "",
    product.category ?? "",
    ...(product.tags ?? []),
    product.brand ?? "",
    product.size ?? "",
    ...(product.variantTexts ?? []),
    ...(product.imageAlts ?? []),
  ].filter((s) => typeof s === "string" && s.trim() !== "");

/**
 * The two strings a product's texts are matched in — THE normalisation of
 * product text (CP3-D stores both on the screening row so a blocklist change
 * can be checked in SQL against exactly what the matcher saw):
 *
 *   tokens  every text tokenized and concatenated (word terms match here);
 *   raw     every text NFC-normalised, joined by "\n" (symbol-only terms).
 */
export interface ScreeningHaystacks {
  raw: string;
  tokens: string;
}

export const screeningHaystacks = (texts: readonly string[]): ScreeningHaystacks => ({
  raw: texts.map((s) => String(s ?? "").normalize("NFC")).join("\n"),
  tokens: texts.map(tokenize).join(""),
});

/**
 * How ONE blocklist term is matched — THE normalisation of a term. `null` = the
 * term can never match (empty after trimming, or letters/digits that all fold
 * away, e.g. a term written only in a non-Latin script).
 *
 *   symbolOnly  no letter or digit (™, ®): judged on the RAW term, because
 *               NFKD would turn ™ into the word "tm", which "Logga™"
 *               (→ "loggatm") never contains;
 *   tok         the tokenized term (" word word "), matched in `tokens`;
 *   raw         the trimmed NFC term, matched in `raw` (symbol-only terms);
 *   key         what two terms that match identically share (dedupe key).
 */
export interface TermMatch {
  key: string;
  raw: string;
  symbolOnly: boolean;
  tok: string;
}

export const termMatch = (term: string): TermMatch | null => {
  const trimmed = term.trim();
  if (trimmed === "") {
    return null;
  }
  const symbolOnly = !/[\p{L}\p{N}]/u.test(trimmed);
  const tok = symbolOnly ? "" : tokenize(trimmed);
  if (!symbolOnly && tok === "") {
    return null;
  }
  return { key: tok || trimmed, raw: trimmed.normalize("NFC"), symbolOnly, tok };
};

export const findScreeningHits = (
  texts: readonly string[],
  blocklist: readonly BlocklistEntry[],
): BlocklistEntry[] => {
  const { raw, tokens } = screeningHaystacks(texts);
  const seen = new Set<string>();
  const hits: BlocklistEntry[] = [];
  for (const entry of blocklist) {
    const match = termMatch(entry.term);
    if (match === null) {
      continue;
    }
    const hit = match.symbolOnly ? raw.includes(match.raw) : tokens.includes(match.tok);
    if (hit && !seen.has(match.key)) {
      seen.add(match.key);
      hits.push({ ...entry, term: entry.term.trim() });
    }
  }
  return hits;
};

/**
 * Firebase screenProductOnWrite.ts:119 — a hit blocks when the platform's
 * global switch is on or the term itself is a hard block.
 */
export const isHardBlock = (
  hits: readonly BlocklistEntry[],
  globalHardBlock: boolean,
): boolean => hits.length > 0 && (globalHardBlock || hits.some((hit) => hit.hardBlock));

// ── the stored form of a term (CP3-D term routes) ───────────────────────────

export const MAX_TERM_LENGTH = 200;

/**
 * A term as the platform types it → the form it is stored in, so that the
 * stored term is exactly what the matcher looks for and two spellings the
 * matcher cannot tell apart are one term:
 *
 *   word term    its tokenized form ("Håkan  Hellström" → "hakan hellstrom",
 *                "AC/DC" → "ac dc"): the same fold product text gets;
 *   symbol term  trimmed and NFC-normalised ("™").
 *
 * `null` when the term can never match (termMatch), is too long once
 * normalised (NFKD can lengthen: "ß" → "ss"), or carries a control character.
 */
export function normalizeScreeningTerm(
  input: unknown,
): { symbolOnly: boolean; term: string } | null {
  if (typeof input !== "string" || /[\u0000-\u001f\u007f]/.test(input)) {
    return null;
  }
  const match = termMatch(input.normalize("NFC"));
  if (match === null) {
    return null;
  }
  const term = match.symbolOnly ? match.raw : match.tok.trim();
  return term.length >= 1 && term.length <= MAX_TERM_LENGTH
    ? { symbolOnly: match.symbolOnly, term }
    : null;
}

/**
 * The blocklist as the SQL safety check matches it (src/catalog/screening.ts
 * `blockOnTermChangeStatement`): one entry per matcher key, in blocklist order,
 * keeping the FIRST entry of a key — exactly the entry findScreeningHits
 * records when two terms match identically. `b` = this hit would block
 * (global switch or the term's own flag), `s` = symbol-only, `k` = the tokenized
 * term, `r` = the raw term, `t` = the term as a hit records it.
 */
export interface SqlMatchTerm {
  b: 0 | 1;
  k: string;
  r: string;
  s: 0 | 1;
  t: string;
}

export function sqlMatchTerms(
  blocklist: readonly BlocklistEntry[],
  globalHardBlock: boolean,
): SqlMatchTerm[] {
  const seen = new Set<string>();
  const out: SqlMatchTerm[] = [];
  for (const entry of blocklist) {
    const match = termMatch(entry.term);
    if (match === null || seen.has(match.key)) {
      continue;
    }
    seen.add(match.key);
    out.push({
      b: globalHardBlock || entry.hardBlock ? 1 : 0,
      k: match.tok,
      r: match.raw,
      s: match.symbolOnly ? 1 : 0,
      t: entry.term.trim(),
    });
  }
  return out;
}

/**
 * Does this mapping feed this product's screened artwork names?
 *
 * Firebase `productUsesMappingSku(product, sku)` matched a podMappings row's
 * `sku` against the product's sku + variantGroups skus, because a Firestore
 * mapping carried no product id — the SKU was the only join. A CF mapping
 * carries the product FOREIGN KEY (and its `sku` is the PRINTER's SKU, not the
 * product's), so the same membership question has exactly one correct answer:
 * the mapping belongs to the product it names. The rescreen paths (mapping
 * create/delete) use this to pick the product to re-screen, as Firebase's
 * rescreenProductsOnMappingWrite did.
 */
export const productUsesMapping = (
  product: { productId: string },
  mapping: { productId: string },
): boolean => mapping.productId === product.productId;

// ── the state machine (verbatim port) ───────────────────────────────────────

/** Firebase `products/{id}.screening.status`. */
export type MachineStatus =
  | "blocked"
  | "cleared"
  | "flagged"
  | "ok"
  | "review"
  | "taken_down";

export interface ScreeningState {
  earlierHits?: string[];
  hits: string[];
  status: MachineStatus;
}

export interface ScreeningDecisionInput {
  hardBlock: boolean;
  prev: ScreeningState | null;
  reviewFirstProducts: number;
  shopPublishedCount: number;
  terms: string[];
}

export interface ScreeningDecision {
  deactivate: boolean;
  screening: ScreeningState | null;
}

const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x));
const union = (...lists: (string[] | undefined)[]): string[] => [
  ...new Set(lists.flatMap((l) => (Array.isArray(l) ? l : []))),
];

/**
 * Decide what to stamp on a LIVE product. `{ screening: null, deactivate: false }`
 * = nothing to do. Verbatim from contentScreening.ts L172–217:
 *
 *   - hits present         → flagged (or blocked + deactivate when hard-blocked);
 *   - no hits, first time  → review when the shop has < reviewFirstProducts
 *                            other live products (new shop), else ok;
 *   - hits dropped         → keep the status, remember earlierHits;
 *   - platform 'cleared'   → sticks while no NEW term appears;
 *   - 'taken_down'         → sticks (reinstating is a platform action).
 */
export function decideScreening(input: ScreeningDecisionInput): ScreeningDecision {
  const { hardBlock, prev, reviewFirstProducts, shopPublishedCount, terms } =
    input;
  const none: ScreeningDecision = { deactivate: false, screening: null };

  if (prev && sameSet(prev.hits ?? [], terms)) {
    if (
      hardBlock &&
      terms.length > 0 &&
      prev.status !== "cleared" &&
      prev.status !== "taken_down"
    ) {
      return {
        deactivate: true,
        screening: prev.status === "blocked" ? null : { ...prev, status: "blocked" },
      };
    }
    return none;
  }

  const known = union(prev?.hits, prev?.earlierHits);
  const earlierHits = union(prev?.earlierHits, prev?.hits).filter(
    (t) => !terms.includes(t),
  );
  const withEarlier = (s: ScreeningState): ScreeningState =>
    earlierHits.length > 0 ? { ...s, earlierHits } : s;

  if (terms.length > 0) {
    const onlyKnown = terms.every((t) => known.includes(t));
    if (prev?.status === "taken_down") {
      return { deactivate: false, screening: withEarlier({ ...prev, hits: terms }) };
    }
    if (prev?.status === "cleared" && onlyKnown) {
      return {
        deactivate: false,
        screening: withEarlier({ hits: terms, status: "cleared" }),
      };
    }
    return {
      deactivate: hardBlock,
      screening: withEarlier({ hits: terms, status: hardBlock ? "blocked" : "flagged" }),
    };
  }

  if (!prev) {
    const isNewShop = shopPublishedCount < reviewFirstProducts;
    return {
      deactivate: false,
      screening: { hits: [], status: isNewShop ? "review" : "ok" },
    };
  }
  const status: MachineStatus = prev.status === "blocked" ? "flagged" : prev.status;
  return { deactivate: false, screening: withEarlier({ hits: [], status }) };
}

// ── the CF vocabulary + the D8 overlay ──────────────────────────────────────

/**
 * DECISIONS D8: the first N products of a shop need a platform approval.
 * Since CP3 N is `platform_settings.review_first_products` (migration 0034
 * seeds 2); this constant is the fallback when that row is absent.
 */
export const REVIEW_FIRST_PRODUCTS = 2;

export type ScreeningStatus =
  | "advisory"
  | "approved"
  | "blocked"
  | "flagged"
  | "pending";

/** The statuses the public-eligibility predicate admits. */
export const PUBLIC_SCREENING_STATUSES: readonly ScreeningStatus[] = [
  "approved",
  "advisory",
  "flagged",
];

export interface StoredScreening {
  earlierHits: string[];
  hits: string[];
  /** D8: decided on the first screening, cleared by a platform approval. */
  requiresApproval: boolean;
  status: ScreeningStatus;
  /** products.takedown_at IS NOT NULL — the platform's sticky block. */
  takenDown: boolean;
}

/**
 * The stored CF row → the machine's `prev`. `pending` carries both Firebase
 * states it can stand for: `review` (no hits) and a first product's `flagged`
 * (hits) — the overlay below turns either back into `pending`.
 */
export function toMachineState(row: StoredScreening | null): ScreeningState | null {
  if (row === null) {
    return null;
  }
  const base = {
    hits: row.hits,
    ...(row.earlierHits.length > 0 ? { earlierHits: row.earlierHits } : {}),
  };
  switch (row.status) {
    case "advisory":
      return { ...base, status: "ok" };
    case "approved":
      return { ...base, status: "cleared" };
    case "flagged":
      return { ...base, status: "flagged" };
    case "blocked":
      return { ...base, status: row.takenDown ? "taken_down" : "blocked" };
    case "pending":
      return { ...base, status: row.hits.length > 0 ? "flagged" : "review" };
  }
}

export interface OverlaidDecision {
  earlierHits: string[];
  hits: string[];
  reason: string | null;
  requiresApproval: boolean;
  status: ScreeningStatus;
}

/**
 * The machine's answer in CF terms, with D8 applied.
 *
 * `requiresApproval` is decided ONCE — on the product's first screening, when
 * the shop has fewer than `reviewFirstProducts` (the platform setting, default
 * REVIEW_FIRST_PRODUCTS) other publicly-eligible products (Firebase counted
 * `productsPublic`, the live set; a pending product is not live here, so a
 * shop cannot skip the rule by publishing two dummies) — and is then carried
 * on the row until a platform approval clears it. While it is set, every
 * automatic outcome short of a block is `pending`.
 *
 * Returns null when nothing changes (the machine's no-op).
 */
export function overlayDecision(
  prevRow: StoredScreening | null,
  decision: ScreeningDecision,
  shopPublishedCount: number,
  reviewFirstProducts: number = REVIEW_FIRST_PRODUCTS,
): OverlaidDecision | null {
  const next = decision.screening;
  if (next === null) {
    return null;
  }

  const requiresApproval =
    prevRow === null
      ? shopPublishedCount < reviewFirstProducts
      : prevRow.requiresApproval;

  const common = { earlierHits: next.earlierHits ?? [], hits: next.hits, requiresApproval };

  switch (next.status) {
    case "review":
      return { ...common, reason: "first_products", status: "pending" };
    case "ok":
      return requiresApproval
        ? { ...common, reason: "first_products", status: "pending" }
        : { ...common, reason: null, status: "advisory" };
    case "flagged":
      return requiresApproval
        ? { ...common, reason: "blocklist_hit", status: "pending" }
        : { ...common, reason: "blocklist_hit", status: "flagged" };
    case "blocked":
      return { ...common, reason: "hard_block", status: "blocked" };
    case "cleared":
      return { ...common, reason: "platform_approved", status: "approved" };
    case "taken_down":
      return { ...common, reason: "takedown", status: "blocked" };
  }
}
