/**
 * scripts/cf-port/migrate/lib/screening-normalize.mjs — a JS port of the
 * pure term-normalisation half of cloudflare/src/catalog/screening-core.ts
 * (`termMatch` / `normalizeScreeningTerm`), so the importer stores each
 * Firebase blocklist term in EXACTLY the form the Worker's own matcher
 * expects, matching the Worker's rules bit for bit. This file must be kept in
 * lockstep with screening-core.ts; test/screening-normalize-pin.test.mjs pins
 * the two against the same fixture vectors.
 */

const EXTRA_FOLDS = {
  æ: 'ae',
  ð: 'd',
  đ: 'd',
  ı: 'i',
  ł: 'l',
  ø: 'o',
  œ: 'oe',
  ß: 'ss',
  þ: 'th',
};

export function foldText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[øæœßðþłđı]/g, (c) => EXTRA_FOLDS[c] ?? c);
}

export function tokenize(value) {
  const t = foldText(value).replace(/[^a-z0-9]+/g, ' ').trim();
  return t ? ` ${t} ` : '';
}

export function termMatch(term) {
  const trimmed = term.trim();
  if (trimmed === '') return null;
  const symbolOnly = !/[\p{L}\p{N}]/u.test(trimmed);
  const tok = symbolOnly ? '' : tokenize(trimmed);
  if (!symbolOnly && tok === '') return null;
  return { key: tok || trimmed, raw: trimmed.normalize('NFC'), symbolOnly, tok };
}

export const MAX_TERM_LENGTH = 200;

/** A term as the platform types it → the form it is stored in (screening-core.ts
 * normalizeScreeningTerm). `null` = the term can never match, or too long, or
 * carries a control character. */
export function normalizeScreeningTerm(input) {
  if (typeof input !== 'string' || /[\u0000-\u001f\u007f]/.test(input)) {
    return null;
  }
  const match = termMatch(input.normalize('NFC'));
  if (match === null) return null;
  const term = match.symbolOnly ? match.raw : match.tok.trim();
  return term.length >= 1 && term.length <= MAX_TERM_LENGTH ? { symbolOnly: match.symbolOnly, term } : null;
}
