// The shop's forwards (unit CP5-FL): the path normal form, the refusals as
// Swedish sentences, and the lookup that reads one forward back after a write
// whose answer was lost.
// PURE: no React, no fetch; tested under Node (redirects.test.mjs).
//
// `normalizeStorefrontPath` is the Worker's (cloudflare/src/storefront/redirects.ts),
// ported line for line: the Worker stores both paths of a forward in this one
// form, so a lost write is read back by the form the server would have
// stored. The browser never refuses a path on its own; the server's refusal is
// what the page shows.

export const STOREFRONT_PATH_MAX_LENGTH = 2_048;
export const REDIRECTS_PAGE = 100;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/** The Worker's path normal form, or null (see redirects.ts for each rule). */
export function normalizeStorefrontPath(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > STOREFRONT_PATH_MAX_LENGTH) return null;
  let path = raw;
  const cut = path.search(/[?#]/);
  if (cut !== -1) path = path.slice(0, cut);
  if (!path.startsWith('/') || path.includes('\\')) return null;
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed.length === 0) return '/';
  const segments = [];
  for (const encoded of trimmed.slice(1).split('/')) {
    if (encoded.length === 0) return null;
    let segment;
    try {
      segment = decodeURIComponent(encoded);
    } catch {
      return null;
    }
    segment = segment.normalize('NFC');
    if (segment.length === 0 || segment === '.' || segment === '..' || segment.includes('/') ||
      segment.includes('\\') || CONTROL_CHARACTER.test(segment)) return null;
    segments.push(segment);
  }
  const normal = `/${segments.join('/')}`;
  return normal.length > STOREFRONT_PATH_MAX_LENGTH ? null : normal;
}

/** Byte order of the UTF-8 forms (D1's BINARY collation, the list's order). */
export function compareUtf8(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** base64url of a string's UTF-8, no padding (the list's cursor). */
export function cursorOf(path) {
  let binary = '';
  for (const byte of new TextEncoder().encode(path)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The cursor to start a lookup of `path` from: the path without its last
 * character (a proper prefix sorts before it). Null for a path that cannot be
 * a stored old address.
 */
export function lookupCursorFor(path) {
  const chars = Array.from(typeof path === 'string' ? path : '');
  if (chars.length < 2 || chars[0] !== '/') return null;
  return cursorOf(chars.slice(0, -1).join(''));
}

/**
 * One page of a lookup: 'found' (with the row), 'absent' (the page passed the
 * place the path would sort at, or the list ended), or 'next' (read on).
 */
export function scanPage(rows, nextCursor, path) {
  for (const row of rows ?? []) {
    if (row?.fromPath === path) return { state: 'found', row };
    if (typeof row?.fromPath === 'string' && compareUtf8(row.fromPath, path) > 0) return { state: 'absent' };
  }
  return nextCursor ? { state: 'next' } : { state: 'absent' };
}

/** The Worker's reasons (RedirectProblem) → Swedish sentences. */
export const PROBLEM_MESSAGES = Object.freeze({
  invalid_path: 'Adresserna ska vara sökvägar i butiken som börjar med /, t.ex. /products/gammal-troja. Utan domän, utan ? eller #, och utan // eller ../.',
  reserved_path: 'Den gamla adressen går inte att skicka vidare: startsidan och butikens egna sidor för varukorg, kassa, orderbekräftelse, ångerrätt och intrångsanmälan måste alltid fungera.',
  same_path: 'Den gamla och den nya adressen är samma sida.',
  duplicate: 'Samma gamla adress finns två gånger.',
  chain: 'Det skulle bli en kedja: den nya adressen skickas redan vidare, eller den gamla adressen är redan målet för en annan omdirigering. Peka direkt på slutadressen.',
});

/** Any refusal of the forwards route → a Swedish sentence. */
export function redirectRefusalMessage(error, what = 'Omdirigeringen') {
  const code = error?.code;
  if (code === 'unauthenticated') return error.message;
  if (code === 'network_error') return `${what} kunde inte skickas: servern kunde inte nås.`;
  if (code === 'refused_redirects') {
    const reasons = Array.isArray(error?.details?.problems) ? error.details.problems.map((p) => p?.reason) : [];
    const sentence = reasons.map((r) => PROBLEM_MESSAGES[r]).find(Boolean);
    return sentence ?? 'Servern tog inte emot omdirigeringen.';
  }
  if (code === 'conflict') return 'Omdirigeringarna ändrades samtidigt av någon annan. Ladda om sidan och försök igen.';
  if (code === 'invalid_request') return 'Servern tog inte emot omdirigeringen. Kontrollera att båda adresserna är ifyllda och börjar med /.';
  if (code === 'rate_limited') return 'För många ändringar på kort tid. Vänta en stund och försök igen.';
  return `${what} gick inte igenom: servern svarade med ett fel (HTTP ${error?.status ?? '?'}).`;
}

/** "4 okt. 2026" (Swedish), "—" for no time. */
export function dateText(iso) {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString('sv-SE', { dateStyle: 'medium' }) : '—';
}
