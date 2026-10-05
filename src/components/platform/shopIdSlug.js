// The shop id the "Ny butik" form suggests from the shop's name (CP9-OB item
// 1). The id is the tenant key, a URL segment and one day a subdomain label,
// and it can never be changed, so the suggestion must be the name as a reader
// expects it: "Dry Run Artist" → "dry-run-artist", "Sill & Strid" →
// "sill-strid", "Åsa Öberg" → "asa-oberg". Pure, tested under Node in
// src/admin-app/adapters/shopIdSlug.test.mjs. The form still validates what
// it sends (ProvisionShopModal SHOP_ID_RE).

export const SHOP_ID_MAX = 30;

// The letters a decomposition does not split into a base letter and a mark.
const LETTERS = { æ: 'ae', ø: 'o', œ: 'oe', ß: 'ss', ð: 'd', þ: 'th', ł: 'l', đ: 'd', ı: 'i' };

export function slugifyShopId(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // å ä ö é ü … → a a o e u
    .replace(/[æøœßðþłđı]/g, (letter) => LETTERS[letter])
    .replace(/['’‘`´]/g, '') // an apostrophe joins: "Kent's" → "kents"
    .replace(/[^a-z0-9]+/g, '-') // spaces, punctuation and anything else separate
    .replace(/^-+|-+$/g, '')
    .slice(0, SHOP_ID_MAX)
    .replace(/-+$/, ''); // a cut inside "-" never leaves an edge hyphen
}
