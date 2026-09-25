/**
 * contentScreening — pre-publish brand screening (SnapWear A11).
 *
 * The one expensive scenario on a POD platform is a seller printing a licensed
 * logo/name and selling 300 tees before anyone reacts. This matcher flags a
 * product whose text mentions a term from the platform blocklist
 * (settings/contentScreening.blocklist) so a human reviews it. It does NOT
 * block publishing: blocking invites renaming to dodge the filter, flag +
 * review is what Printify does. Keyword + human review only — no image/logo
 * recognition.
 *
 * PURE (no firebase imports) so rules-tests can unit-test it, and it has a
 * logic TWIN at functions/src/catalog/contentScreening.ts (the server trigger
 * that stamps `screening` so a client can't skip it). The functions build
 * cannot compile a file from the app's src/ (tsconfig rootDir), so the two are
 * kept identical by rules-tests/content-screening-parity.test.cjs — change one,
 * change both.
 *
 * Matching rules:
 *   - case-insensitive, diacritics folded (Håkan → hakan, Pokémon → pokemon),
 *     plus the few Nordic/European letters NFKD does not decompose (ø, æ, ß…);
 *   - WHOLE-WORD: text and term are both reduced to space-separated alphanumeric
 *     tokens and the term must appear as a whole token run, so "kent" matches
 *     "Kent tour" but not "Kentucky", and "ac/dc" matches "AC/DC" and "ac-dc";
 *   - symbol-only terms (™, ®) have no letters to tokenize and are matched as a
 *     plain substring of the raw text instead.
 */

// Letters NFKD leaves intact but a seller could use to dodge a term.
const EXTRA_FOLDS = { 'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'ð': 'd', 'þ': 'th', 'ł': 'l', 'đ': 'd', 'ı': 'i' };

/** Lower-case, strip diacritics, fold the extras. */
export const foldText = (value) =>
  String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[øæœßðþłđı]/g, (c) => EXTRA_FOLDS[c] || c);

/** Folded text as ` tok tok tok ` — padded so a whole-word test is a substring test. */
export const tokenize = (value) => {
  const t = foldText(value).replace(/[^a-z0-9]+/g, ' ').trim();
  return t ? ` ${t} ` : '';
};

/** Strip HTML tags + entities (Quill descriptions are stored as HTML). */
const stripHtml = (value) =>
  String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/&[a-z0-9#]+;/gi, ' ');

/** Legacy per-locale objects ({ 'sv-SE': '…' }) or plain strings → strings. */
const textsOf = (field) => {
  if (typeof field === 'string') return [field];
  if (field && typeof field === 'object' && !Array.isArray(field)) {
    return Object.values(field).filter((v) => typeof v === 'string');
  }
  return [];
};

/**
 * The texts a product is screened over: name, description(s), tags and the
 * artwork file names printed on it (the server resolves those via podMappings;
 * a client passes what it has).
 */
export const productScreeningTexts = (product, artworkFileNames = []) => {
  const p = product || {};
  const out = [
    ...textsOf(p.name),
    ...textsOf(p.description).map(stripHtml),
    ...textsOf(p.descriptions?.b2c).map(stripHtml),
    ...textsOf(p.descriptions?.b2cMoreInfo).map(stripHtml),
    ...(Array.isArray(p.tags) ? p.tags.filter((t) => typeof t === 'string') : []),
    ...(Array.isArray(artworkFileNames) ? artworkFileNames.filter((f) => typeof f === 'string') : []),
  ];
  return out.filter((s) => s.trim() !== '');
};

/**
 * Blocklist entries → [{ term, kind, hardBlock }]. Accepts plain strings too so
 * a hand-edited settings doc can't crash the matcher.
 */
export const normalizeBlocklist = (raw) =>
  (Array.isArray(raw) ? raw : [])
    .map((e) => (typeof e === 'string' ? { term: e } : e))
    .filter((e) => e && typeof e.term === 'string' && e.term.trim() !== '')
    .map((e) => ({
      term: e.term.trim(),
      kind: typeof e.kind === 'string' ? e.kind : 'other',
      hardBlock: e.hardBlock === true,
    }));

/**
 * Blocklist entries that occur in any of `texts`, in blocklist order, one per
 * term. Returns [] when nothing matches.
 */
export const findScreeningHits = (texts, blocklist) => {
  const list = Array.isArray(texts) ? texts : [texts];
  const haystack = list.map(tokenize).join('');
  const raw = list.map((s) => String(s ?? '').normalize('NFC')).join('\n');
  const seen = new Set();
  const hits = [];
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

/** Convenience: hit TERMS for a product (what the seller notice shows). */
export const screenProduct = (product, blocklist, artworkFileNames = []) =>
  findScreeningHits(productScreeningTexts(product, artworkFileNames), blocklist).map((h) => h.term);

/** The seller-facing Swedish notice for a set of hit terms. */
export const screeningNotice = (terms) => {
  if (!Array.isArray(terms) || terms.length === 0) return '';
  const quoted = terms.map((t) => `'${t}'`).join(', ');
  return `Namnet/beskrivningen innehåller ${quoted} som kan vara ett skyddat varumärke. ` +
    'Produkten publiceras men granskas av plattformen. Om du inte har rätt att använda märket kan produkten stängas av.';
};
