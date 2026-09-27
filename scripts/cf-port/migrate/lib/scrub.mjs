/**
 * scripts/cf-port/migrate/lib/scrub.mjs — the three staging scrub rules
 * (MIGRATION_MANIFEST.md §d S3, DECISIONS D20):
 *
 *   1. EMAIL — every email address the plan would write goes through
 *      `--email-map` (real → test address). An address not in the map either
 *      REFUSES the whole run, or (with `--scrub-unmapped`) becomes a
 *      deterministic `scrubbed+<12 hex>@example.com` placeholder. This
 *      applies to every email field the plan touches: user emails,
 *      `tenants.support_email`, the emails embedded in the storeIdentity
 *      JSON, and legal-acceptance emails (manifest row 65) — not only the
 *      `users` collection.
 *   2. CONNECT — a live Stripe Connect account id is never written to
 *      staging. With `--connect-map` a live id is replaced by its mapped
 *      sandbox id; without one it is dropped to NULL and the row's charge
 *      flags are forced to 0/false.
 *   3. STORAGE URL — the two Firebase Storage host names (manifest §b) are
 *      scanned for across the WHOLE plan (a defence-in-depth net, not just at
 *      the field that is supposed to carry them) and any hit refuses the run.
 */

import { createHash } from 'node:crypto';

/** The two Firebase Storage host names named in manifest §b. Never written to D1. */
export const FIREBASE_STORAGE_HOSTS = ['firebasestorage.googleapis.com', 'storage.googleapis.com'];

// No `/` and no `:` on either side: a profile link such as
// `https://www.tiktok.com/@name.surname` has one `@` and a dot after it, and
// is a URL, not an address. Found on real data, where the looser pattern
// replaced a shop's social link with a placeholder address.
const EMAIL_PATTERN = /^[^\s@/:]+@[^\s@/:]+\.[^\s@/:]+$/;

export function looksLikeEmail(value) {
  return typeof value === 'string' && EMAIL_PATTERN.test(value.trim());
}

/** scrubbed+<first 12 hex of sha256 of the lowercased address>@example.com */
export function scrubbedEmailFor(address) {
  const lower = address.trim().toLowerCase();
  const hash = createHash('sha256').update(lower, 'utf8').digest('hex').slice(0, 12);
  return `scrubbed+${hash}@example.com`;
}

/**
 * Review round 1, fix 4: never put the address itself into a message that
 * reaches the terminal. The message names WHERE the address was found
 * (a collection/document/field location the caller supplies) and the first
 * 12 hex characters of sha256(lowercased address) — the SAME value
 * `scrubbedEmailFor` would itself produce for that address, given by
 * `emailFingerprint` below — so an operator holding the email map can look up
 * which real address hashes to that value without the address ever being
 * printed anywhere this tool writes to stdout/stderr or plan.json.
 */
export function emailFingerprint(address) {
  return createHash('sha256').update(address.trim().toLowerCase(), 'utf8').digest('hex').slice(0, 12);
}

export class UnmappedEmailError extends Error {
  constructor(where, address) {
    super(`unmapped email address at ${where} (fingerprint ${emailFingerprint(address)} — pass --email-map or --scrub-unmapped)`);
    this.name = 'UnmappedEmailError';
    this.fingerprint = emailFingerprint(address);
    this.where = where;
  }
}

/**
 * The email map of a PRODUCTION run. S3 is a staging rule: production carries
 * every address as it is, and the callers refuse `--email-map` and
 * `--scrub-unmapped` there, so a production user can never be written with a
 * test address or a placeholder.
 */
export const KEEP_ADDRESSES = Object.freeze({});

/** The email map a run uses: the file's map on staging, KEEP_ADDRESSES on production. */
export function emailMapFor(env, raw) {
  return env === 'production' ? KEEP_ADDRESSES : normalizeEmailMap(raw);
}

/** The refusal, or null: the two scrub options belong to staging only. */
export function scrubOptionsProblem(env, { emailMapGiven, scrubUnmapped }) {
  if (env !== 'production') return null;
  if (emailMapGiven) return 'REFUSED: --email-map is a staging option; production carries every address as it is';
  if (scrubUnmapped) return 'REFUSED: --scrub-unmapped is a staging option; production carries every address as it is';
  return null;
}

/**
 * Resolves one email address per the S3 rule. `emailMap` is a plain object
 * (real address, case-sensitive key as given in the map file → test address);
 * lookup is case-insensitive against the map's own keys (each key is
 * lower-cased once when the map is loaded — see loadEmailMap below).
 * `scrubUnmapped` enables the deterministic placeholder fallback instead of
 * refusing. `where` names the source location (e.g. `shops/test-shop-a
 * .storeIdentity.supportEmail`, `users/<hash-of-uid>`) for the refusal
 * message only — it is never itself allowed to contain the address.
 * Returns { value, action } where action is 'mapped' | 'scrubbed' |
 * 'unchanged' (the value was not an email-shaped string at all — passed
 * through verbatim, e.g. an empty string field).
 */
export function resolveEmail(address, emailMap, scrubUnmapped, where = '(unspecified)') {
  if (!looksLikeEmail(address) || emailMap === KEEP_ADDRESSES) {
    return { action: 'unchanged', value: address };
  }
  const key = address.trim().toLowerCase();
  const mapped = emailMap?.[key];
  if (typeof mapped === 'string' && mapped.length > 0) {
    return { action: 'mapped', value: mapped };
  }
  if (scrubUnmapped) {
    return { action: 'scrubbed', value: scrubbedEmailFor(address) };
  }
  throw new UnmappedEmailError(where, address);
}

/** Loads an `--email-map` JSON file's already-parsed object into a
 * lower-cased-key lookup map (so resolveEmail's case-insensitive lookup is
 * correct regardless of how the map file capitalizes its keys). */
export function normalizeEmailMap(raw) {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('normalizeEmailMap: email map must be a JSON object');
  }
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string' || v.length === 0) {
      // The key is a real address: named by its fingerprint, never printed.
      throw new Error(`normalizeEmailMap: the value for the address with fingerprint ${emailFingerprint(k)} must be a non-empty string`);
    }
    out[k.trim().toLowerCase()] = v;
  }
  return out;
}

/**
 * Recursively walks a JSON-like value (the decoded storeIdentity object, most
 * commonly) and resolves every email-shaped string it finds through
 * resolveEmail. Returns { value, changed: boolean, actions: [{path, action}] }.
 * Used for the emails embedded inside storeIdentity (supportEmail duplicated
 * inside the free-form object, trustpilot.email, etc. — anything that is
 * email-shaped is scrubbed, on the principle that S3 covers "every email
 * field the plan touches", not an enumerated list that can drift).
 */
export function scrubEmailsDeep(value, emailMap, scrubUnmapped, path = '$') {
  const actions = [];
  function walk(node, nodePath) {
    if (typeof node === 'string') {
      if (!looksLikeEmail(node)) return node;
      const { value: resolved, action } = resolveEmail(node, emailMap, scrubUnmapped, nodePath);
      if (action !== 'unchanged') actions.push({ action, path: nodePath });
      return resolved;
    }
    if (Array.isArray(node)) {
      return node.map((entry, i) => walk(entry, `${nodePath}[${i}]`));
    }
    if (node !== null && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = walk(v, `${nodePath}.${k}`);
      }
      return out;
    }
    return node;
  }
  const result = walk(value, path);
  return { actions, changed: actions.length > 0, value: result };
}

// ── Connect (rule 2) ────────────────────────────────────────────────────────

/**
 * Loads a `--connect-map` JSON file's parsed object (live account id → sandbox
 * account id) into a lookup with keys trimmed verbatim (Stripe account ids
 * are case-sensitive `acct_...` strings, so no case-folding here).
 */
export function normalizeConnectMap(raw) {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('normalizeConnectMap: connect map must be a JSON object');
  }
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`normalizeConnectMap: value for ${JSON.stringify(k)} must be a non-empty string`);
    }
    out[k] = v;
  }
  return out;
}

/**
 * Resolves ONE tenant's Connect facts for staging (D20/S3): a live account id
 * present in the map is replaced by its sandbox id, unchanged otherwise; an
 * unmapped live account id is dropped to null and every charge flag is forced
 * to false — a live id is NEVER written to staging, mapped or not-mapped.
 */
export function resolveConnectFacts(
  { chargesEnabled, detailsSubmitted, payoutsEnabled, stripeAccountId },
  connectMap,
  env,
) {
  if (stripeAccountId === null || stripeAccountId === undefined) {
    return { chargesEnabled: false, detailsSubmitted: false, payoutsEnabled: false, stripeAccountId: null };
  }
  if (env !== 'staging') {
    // Production carries the live account id and its real flags verbatim.
    return { chargesEnabled, detailsSubmitted, payoutsEnabled, stripeAccountId };
  }
  const mapped = connectMap[stripeAccountId];
  if (typeof mapped === 'string' && mapped.length > 0) {
    return { chargesEnabled, detailsSubmitted, payoutsEnabled, stripeAccountId: mapped };
  }
  return { chargesEnabled: false, detailsSubmitted: false, payoutsEnabled: false, stripeAccountId: null };
}

// ── Storage URL removal / scan (rule 3) ─────────────────────────────────────

export function containsFirebaseStorageUrl(value) {
  if (typeof value !== 'string') return false;
  return FIREBASE_STORAGE_HOSTS.some((host) => value.includes(host));
}

/**
 * Removes EVERY Firebase Storage URL from a store identity, at any depth
 * (manifest row 56 names the four branding keys logoUrl, heroImageUrl,
 * faviconUrl and emailLogoUrl; a shop's gallery holds image URLs too, as
 * `gallery[].imageUrl`, and any later field may). Nothing in this checkpoint
 * has copied Storage, so such a value would point at a host that is being
 * retired. The key holding the URL is removed and the rest of its object is
 * kept; a URL that is itself an array element is dropped from the array. A
 * value that is not a Firebase Storage URL (an empty string, an address
 * elsewhere) is left as it is.
 * Returns { identity, removedPaths } with array indexes in the paths
 * (`gallery[0].imageUrl`). The bundle keeps the original values for the
 * checkpoint that copies the objects.
 */
export function removeStorageUrlsDeep(identity) {
  const removedPaths = [];
  function walk(node, nodePath) {
    if (Array.isArray(node)) {
      const out = [];
      node.forEach((entry, i) => {
        const entryPath = `${nodePath}[${i}]`;
        if (containsFirebaseStorageUrl(entry)) {
          removedPaths.push(entryPath);
        } else {
          out.push(walk(entry, entryPath));
        }
      });
      return out;
    }
    // Plain maps only: a decoded Timestamp or a Buffer is a value, not a map.
    const proto = node !== null && typeof node === 'object' ? Object.getPrototypeOf(node) : undefined;
    if (proto === Object.prototype || proto === null) {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        const childPath = nodePath === '' ? k : `${nodePath}.${k}`;
        if (containsFirebaseStorageUrl(v)) {
          removedPaths.push(childPath);
        } else {
          out[k] = walk(v, childPath);
        }
      }
      return out;
    }
    return node;
  }
  return { identity: walk(identity, ''), removedPaths };
}

/** Recursively scans any JSON-like value for a Firebase Storage host,
 * returning every path where one was found (empty = clean). Used by the
 * whole-plan scan test as a second, independent check beyond the string scan
 * of the generated SQL text. */
export function findFirebaseStorageUrls(value, path = '$') {
  const found = [];
  function walk(node, nodePath) {
    if (typeof node === 'string') {
      if (containsFirebaseStorageUrl(node)) found.push(nodePath);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, i) => walk(entry, `${nodePath}[${i}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, `${nodePath}.${k}`);
    }
  }
  walk(value, path);
  return found;
}
