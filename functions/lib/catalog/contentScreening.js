"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.decideScreening = exports.productUsesMappingSku = exports.productMappingSkus = exports.screenProduct = exports.findScreeningHits = exports.normalizeBlocklist = exports.productScreeningTexts = exports.tokenize = exports.foldText = void 0;
const EXTRA_FOLDS = {
    'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'ð': 'd', 'þ': 'th', 'ł': 'l', 'đ': 'd', 'ı': 'i',
};
const foldText = (value) => String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[øæœßðþłđı]/g, (c) => EXTRA_FOLDS[c] || c);
exports.foldText = foldText;
const tokenize = (value) => {
    const t = (0, exports.foldText)(value).replace(/[^a-z0-9]+/g, ' ').trim();
    return t ? ` ${t} ` : '';
};
exports.tokenize = tokenize;
const stripHtml = (value) => String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/&[a-z0-9#]+;/gi, ' ');
const textsOf = (field) => {
    if (typeof field === 'string')
        return [field];
    if (field && typeof field === 'object' && !Array.isArray(field)) {
        return Object.values(field).filter((v) => typeof v === 'string');
    }
    return [];
};
const productScreeningTexts = (product, artworkFileNames = []) => {
    const p = (product || {});
    const descriptions = (p.descriptions || {});
    const out = [
        ...textsOf(p.name),
        ...textsOf(p.description).map(stripHtml),
        ...textsOf(descriptions.b2c).map(stripHtml),
        ...textsOf(descriptions.b2cMoreInfo).map(stripHtml),
        ...(Array.isArray(p.tags) ? p.tags.filter((t) => typeof t === 'string') : []),
        ...(Array.isArray(artworkFileNames) ? artworkFileNames.filter((f) => typeof f === 'string') : []),
    ];
    return out.filter((s) => s.trim() !== '');
};
exports.productScreeningTexts = productScreeningTexts;
const normalizeBlocklist = (raw) => (Array.isArray(raw) ? raw : [])
    .map((e) => (typeof e === 'string' ? { term: e } : e))
    .filter((e) => !!e && typeof e.term === 'string' && e.term.trim() !== '')
    .map((e) => ({
    term: e.term.trim(),
    kind: typeof e.kind === 'string' ? e.kind : 'other',
    hardBlock: e.hardBlock === true,
}));
exports.normalizeBlocklist = normalizeBlocklist;
const findScreeningHits = (texts, blocklist) => {
    const list = Array.isArray(texts) ? texts : [texts];
    const haystack = list.map(exports.tokenize).join('');
    const raw = list.map((s) => String(s ?? '').normalize('NFC')).join('\n');
    const seen = new Set();
    const hits = [];
    for (const entry of (0, exports.normalizeBlocklist)(blocklist)) {
        // Symbol-only terms (™, ®) are judged on the RAW term: NFKD would turn
        // ™ into the word "tm", which "Logga™" (→ "loggatm") never contains.
        const symbolOnly = !/[\p{L}\p{N}]/u.test(entry.term);
        const tok = symbolOnly ? '' : (0, exports.tokenize)(entry.term);
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
exports.findScreeningHits = findScreeningHits;
const screenProduct = (product, blocklist, artworkFileNames = []) => (0, exports.findScreeningHits)((0, exports.productScreeningTexts)(product, artworkFileNames), blocklist).map((h) => h.term);
exports.screenProduct = screenProduct;
// ── POD mapping membership (server only — no client twin) ─────────────────
/**
 * The podMappings SKUs whose artwork prints on this product: the parent sku +
 * every variantGroups[].sku, stringified, blanks dropped, deduped, capped at
 * 30 (the Firestore `in` limit the lookup runs into). No parent sku → none.
 * screenProductOnWrite's artwork lookup queries exactly this list.
 */
const productMappingSkus = (product) => {
    const p = (product || {});
    if (!p.sku)
        return [];
    const groups = Array.isArray(p.variantGroups) ? p.variantGroups : [];
    const skus = [String(p.sku), ...groups.map((g) => String(g?.sku || ''))].filter(Boolean);
    return [...new Set(skus)].slice(0, 30);
};
exports.productMappingSkus = productMappingSkus;
/**
 * Does a podMappings row with this `sku` feed this product's screened artwork
 * names? Same list as the lookup (productMappingSkus), exact string match —
 * a Firestore `in` is type-strict, so a non-string sku never matches. The
 * mapping/artwork rescreen triggers use it to find the products to re-screen.
 */
const productUsesMappingSku = (product, sku) => typeof sku === 'string' && (0, exports.productMappingSkus)(product).includes(sku);
exports.productUsesMappingSku = productUsesMappingSku;
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const union = (...lists) => [...new Set(lists.flatMap((l) => (Array.isArray(l) ? l : [])))];
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
function decideScreening(input) {
    const { prev, terms, hardBlock, shopPublishedCount, reviewFirstProducts } = input;
    const none = { screening: null, deactivate: false };
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
    const withEarlier = (s) => earlierHits.length > 0 ? { ...s, earlierHits } : s;
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
    const status = prev.status === 'blocked' ? 'flagged' : prev.status;
    return { screening: withEarlier({ status, hits: [] }), deactivate: false };
}
exports.decideScreening = decideScreening;
//# sourceMappingURL=contentScreening.js.map