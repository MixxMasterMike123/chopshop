/**
 * contentScreening — SERVER TWIN of src/utils/contentScreening.js (SnapWear A11).
 *
 * Same matcher, byte-for-byte in behaviour: the functions build cannot compile
 * a file from the app's src/ (tsconfig rootDir: "src"), so the client module
 * and this one are logic twins, held together by
 * rules-tests/content-screening-parity.test.cjs. Change one, change both.
 *
 * Plus decideScreening(): the PURE state machine the screenProductOnWrite
 * trigger runs, and productUsesMappingSku(): which products a podMappings row
 * feeds — both kept here (no firebase imports) so they are unit-testable too.
 */

export interface BlocklistEntry {
  term: string;
  kind: string;
  hardBlock: boolean;
}

type AnyDoc = Record<string, unknown>;

const EXTRA_FOLDS: Record<string, string> = {
  'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'ð': 'd', 'þ': 'th', 'ł': 'l', 'đ': 'd', 'ı': 'i',
};

export const foldText = (value: unknown): string =>
  String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[øæœßðþłđı]/g, (c) => EXTRA_FOLDS[c] || c);

export const tokenize = (value: unknown): string => {
  const t = foldText(value).replace(/[^a-z0-9]+/g, ' ').trim();
  return t ? ` ${t} ` : '';
};

const stripHtml = (value: unknown): string =>
  String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/&[a-z0-9#]+;/gi, ' ');

const textsOf = (field: unknown): string[] => {
  if (typeof field === 'string') return [field];
  if (field && typeof field === 'object' && !Array.isArray(field)) {
    return Object.values(field as AnyDoc).filter((v): v is string => typeof v === 'string');
  }
  return [];
};

export const productScreeningTexts = (product: AnyDoc | null | undefined, artworkFileNames: unknown[] = []): string[] => {
  const p = (product || {}) as AnyDoc;
  const descriptions = (p.descriptions || {}) as AnyDoc;
  const out = [
    ...textsOf(p.name),
    ...textsOf(p.description).map(stripHtml),
    ...textsOf(descriptions.b2c).map(stripHtml),
    ...textsOf(descriptions.b2cMoreInfo).map(stripHtml),
    ...(Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === 'string') : []),
    ...(Array.isArray(artworkFileNames) ? artworkFileNames.filter((f): f is string => typeof f === 'string') : []),
  ];
  return out.filter((s) => s.trim() !== '');
};

export const normalizeBlocklist = (raw: unknown): BlocklistEntry[] =>
  (Array.isArray(raw) ? raw : [])
    .map((e) => (typeof e === 'string' ? { term: e } : e))
    .filter((e): e is AnyDoc => !!e && typeof (e as AnyDoc).term === 'string' && ((e as AnyDoc).term as string).trim() !== '')
    .map((e) => ({
      term: (e.term as string).trim(),
      kind: typeof e.kind === 'string' ? e.kind : 'other',
      hardBlock: e.hardBlock === true,
    }));

export const findScreeningHits = (texts: unknown, blocklist: unknown): BlocklistEntry[] => {
  const list = Array.isArray(texts) ? texts : [texts];
  const haystack = list.map(tokenize).join('');
  const raw = list.map((s) => String(s ?? '').normalize('NFC')).join('\n');
  const seen = new Set<string>();
  const hits: BlocklistEntry[] = [];
  for (const entry of normalizeBlocklist(blocklist)) {
    // Symbol-only terms (™, ®) are judged on the RAW term: NFKD would turn
    // ™ into the word "tm", which "Logga™" (→ "loggatm") never contains.
    const symbolOnly = !/[\p{L}\p{N}]/u.test(entry.term);
    const tok = symbolOnly ? '' : tokenize(entry.term);
    const hit = symbolOnly
      ? raw.includes(entry.term.normalize('NFC'))
      : tok !== '' && haystack.includes(tok);
    const key = tok || entry.term;
    if (hit && !seen.has(key)) {
      seen.add(key);
      hits.push(entry);
    }
  }
  return hits;
};

export const screenProduct = (product: AnyDoc | null | undefined, blocklist: unknown, artworkFileNames: unknown[] = []): string[] =>
  findScreeningHits(productScreeningTexts(product, artworkFileNames), blocklist).map((h) => h.term);

// ── POD mapping membership (server only — no client twin) ─────────────────

/**
 * The podMappings SKUs whose artwork prints on this product: the parent sku +
 * every variantGroups[].sku, stringified, blanks dropped, deduped, capped at
 * 30 (the Firestore `in` limit the lookup runs into). No parent sku → none.
 * screenProductOnWrite's artwork lookup queries exactly this list.
 */
export const productMappingSkus = (product: AnyDoc | null | undefined): string[] => {
  const p = (product || {}) as AnyDoc;
  if (!p.sku) return [];
  const groups = Array.isArray(p.variantGroups) ? p.variantGroups : [];
  const skus = [String(p.sku), ...groups.map((g) => String((g as AnyDoc | null)?.sku || ''))].filter(Boolean);
  return [...new Set(skus)].slice(0, 30);
};

/**
 * Does a podMappings row with this `sku` feed this product's screened artwork
 * names? Same list as the lookup (productMappingSkus), exact string match —
 * a Firestore `in` is type-strict, so a non-string sku never matches. The
 * mapping/artwork rescreen triggers use it to find the products to re-screen.
 */
export const productUsesMappingSku = (product: AnyDoc | null | undefined, sku: unknown): boolean =>
  typeof sku === 'string' && productMappingSkus(product).includes(sku);

// ── Trigger state machine ──────────────────────────────────────────────────

/** Statuses on products/{id}.screening. Queue = flagged | review | blocked. */
export type ScreeningStatus = 'ok' | 'review' | 'flagged' | 'blocked' | 'cleared' | 'taken_down';

export interface ScreeningState {
  status: ScreeningStatus;
  hits: string[];
  /** Terms seen on earlier versions — a rename that drops a hit keeps them. */
  earlierHits?: string[];
}

export interface ScreeningDecisionInput {
  prev: ScreeningState | null;
  /** Hit terms on the CURRENT product text. */
  terms: string[];
  /** Any hit term is hard-blocked (per-term flag or settings.hardBlock). */
  hardBlock: boolean;
  /** Other live products this shop already has (only needed when prev is null). */
  shopPublishedCount: number;
  reviewFirstProducts: number;
}

export interface ScreeningDecision {
  /** New screening state to write, or null to leave it untouched. */
  screening: ScreeningState | null;
  /** Force isActive=false (hard block). */
  deactivate: boolean;
}

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));
const union = (...lists: (string[] | undefined)[]) =>
  [...new Set(lists.flatMap((l) => (Array.isArray(l) ? l : [])))];

/**
 * Decide what to stamp on a LIVE product. Returns { screening: null,
 * deactivate: false } for "nothing to do" — the trigger's own write re-fires
 * the trigger, so an unchanged input MUST converge to a no-op.
 *
 *   - hits present         → flagged (or blocked + deactivate when hard-blocked);
 *   - no hits, first time  → review when the shop has < reviewFirstProducts
 *                            other live products (new shop), else ok;
 *   - hits dropped         → keep the status (a rename that dodges the list
 *                            still needs the human look), remember earlierHits;
 *   - platform 'cleared'   → sticks while no NEW term appears;
 *   - 'taken_down'         → sticks (reinstating is a platform action).
 */
export function decideScreening(input: ScreeningDecisionInput): ScreeningDecision {
  const { prev, terms, hardBlock, shopPublishedCount, reviewFirstProducts } = input;
  const none: ScreeningDecision = { screening: null, deactivate: false };

  if (prev && sameSet(prev.hits || [], terms)) {
    // Unchanged text. Only the hard block needs re-enforcing (a seller who
    // re-activates a blocked product is switched off again) — unless the
    // platform cleared it or took it down itself.
    if (hardBlock && terms.length > 0 && prev.status !== 'cleared' && prev.status !== 'taken_down') {
      return {
        screening: prev.status === 'blocked' ? null : { ...prev, status: 'blocked' },
        deactivate: true,
      };
    }
    return none;
  }

  const known = union(prev?.hits, prev?.earlierHits);
  const earlierHits = union(prev?.earlierHits, prev?.hits).filter((t) => !terms.includes(t));
  const withEarlier = (s: ScreeningState): ScreeningState =>
    earlierHits.length > 0 ? { ...s, earlierHits } : s;

  if (terms.length > 0) {
    const onlyKnown = terms.every((t) => known.includes(t));
    if (prev?.status === 'taken_down') {
      return { screening: withEarlier({ ...prev, hits: terms }), deactivate: false };
    }
    if (prev?.status === 'cleared' && onlyKnown) {
      return { screening: withEarlier({ status: 'cleared', hits: terms }), deactivate: false };
    }
    return {
      screening: withEarlier({ status: hardBlock ? 'blocked' : 'flagged', hits: terms }),
      deactivate: hardBlock,
    };
  }

  // No hits on the current text.
  if (!prev) {
    const isNewShop = shopPublishedCount < reviewFirstProducts;
    return { screening: { status: isNewShop ? 'review' : 'ok', hits: [] }, deactivate: false };
  }
  // Hits dropped to none. A hard block no longer applies, but a human still
  // looks at it (flagged); everything else keeps its status.
  const status: ScreeningStatus = prev.status === 'blocked' ? 'flagged' : prev.status;
  return { screening: withEarlier({ status, hits: [] }), deactivate: false };
}
