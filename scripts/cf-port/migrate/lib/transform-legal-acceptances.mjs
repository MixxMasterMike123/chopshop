/**
 * scripts/cf-port/migrate/lib/transform-legal-acceptances.mjs — manifest row
 * 65: `shops/{id}/legalAcceptances` → `legal_acceptances` (0037), source =
 * 'import', the original uid kept verbatim (`legacy_uid`), the mapped user id
 * when the user was carried (from legacy_id_map), the canonical texts hash
 * computed exactly as builder E specifies (cloudflare/src/legal/legal-pages.ts
 * canonicalJson: JSON.stringify(sortKeysDeep(value)) — identical to
 * lib/typed-json.mjs canonicalStringify/sortKeysDeep, reused here directly so
 * the two can never drift), the per-page custom map in `custom_json`.
 *
 * Firebase field → column:
 *   type ('legalPages' | 'platformTerms')     → type
 *   shopId                                     → tenant_id
 *   uid                                        → legacy_uid (verbatim) + user_id (mapped, or NULL)
 *   email                                      → email
 *   acceptedAt (Timestamp)                     → accepted_at (ISO)
 *   acceptedAtIso (string, kept verbatim)      → accepted_at_original
 *   templateVersion                            → template_version
 *   version (platformTerms only)               → version
 *   pod (boolean)                              → is_pod
 *   custom (object or boolean)                 → custom_json (object form) + is_custom
 *   texts (object of html strings)             → texts_json + texts_sha256
 *   userAgent                                  → user_agent
 *   (no ip in Firebase source)                 → ip = NULL
 *   source                                     → 'import' (fixed)
 *
 * 0037 CHECK "source <> 'import' OR legacy_uid IS NOT NULL": every imported
 * row always carries the original uid, satisfied unconditionally here.
 */

import { createHash } from 'node:crypto';
import { canonicalStringify } from './typed-json.mjs';
import { insertStatement, sqlLiteral } from './sql.mjs';
import { rowContentHash, carriedRow } from './plan.mjs';
import { resolveEmail } from './scrub.mjs';
import { formatTime } from './time-columns.mjs';
import { parseSourceTimestampMillis } from './timestamps.mjs';

const LEGAL_TEXTS_MAX_BYTES = 262_144;
const CUSTOM_JSON_MAX_BYTES = 1024;

/** Identical algorithm to cloudflare/src/legal/legal-pages.ts canonicalJson /
 * scripts/cf-port/migrate/lib/typed-json.mjs canonicalStringify: this is
 * literally the same function, imported, so the two can never drift. */
function canonicalJson(value) {
  return canonicalStringify(value);
}

function sha256HexOf(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/**
 * @param {object} args.doc  a bundle doc from `shops__legalAcceptances`
 *   (its `path` is `shops/{shopId}/legalAcceptances/{autoId}`)
 * @param {object} args.legacyIdMap  a plain { legacyUid: newUserId } object already resolved
 *   from the users transform pass, so this module never has to re-derive ids
 * @param {string} args.env
 * @param {number} args.nowMillis  the run's clock, milliseconds since epoch
 * @param {object} args.emailMap
 * @param {boolean} args.scrubUnmapped
 */
export function transformLegalAcceptance({ doc, emailMap, legacyIdMap, nowMillis, scrubUnmapped }) {
  const problems = [];
  const data = doc.data ?? {};
  const pathParts = doc.path.split('/'); // shops/{shopId}/legalAcceptances/{autoId}
  const tenantId = pathParts[1];
  const acceptanceId = `legacy_${doc.id}`;

  const type = data.type === 'platformTerms' ? 'platformTerms' : 'legalPages';
  const legacyUid = typeof data.uid === 'string' && data.uid.length > 0 ? data.uid : null;
  if (legacyUid === null) {
    problems.push(`legalAcceptances/${doc.id}: no uid on the source document — row skipped (0037 requires legacy_uid IS NOT NULL for source='import')`);
    return { problems, report: { skipped: true, tenantId }, rows: [] };
  }
  const userId = legacyIdMap[legacyUid] ?? null;

  const emailRaw = typeof data.email === 'string' && data.email.length > 0 ? data.email : null;
  let email = null;
  if (emailRaw !== null) {
    const resolved = resolveEmail(emailRaw, emailMap, scrubUnmapped, `${doc.path}.email`);
    email = resolved.value;
  }

  const acceptedAtMillis = parseSourceTimestampMillis(data.acceptedAt, nowMillis);
  const acceptedAt = formatTime('legal_acceptances', 'accepted_at', acceptedAtMillis);
  // accepted_at_original is the source's own acceptedAtIso string kept BYTE
  // VERBATIM as evidence (0037) — never reformatted through formatTime().
  const acceptedAtOriginal = typeof data.acceptedAtIso === 'string' ? data.acceptedAtIso : null;

  const texts = typeof data.texts === 'object' && data.texts !== null ? data.texts : {};
  const textsJson = canonicalJson(texts);
  const textsBytes = Buffer.byteLength(textsJson, 'utf8');
  if (textsBytes > LEGAL_TEXTS_MAX_BYTES) {
    problems.push(`legalAcceptances/${doc.id}: texts snapshot is ${textsBytes} bytes, over the 0037 cap of ${LEGAL_TEXTS_MAX_BYTES} — row skipped`);
    return { problems, report: { skipped: true, tenantId }, rows: [] };
  }

  const isPod = data.pod === true ? 1 : data.pod === false ? 0 : null;
  const customRaw = data.custom;
  let customJson = null;
  let isCustom = null;
  if (typeof customRaw === 'boolean') {
    isCustom = customRaw ? 1 : 0;
  } else if (typeof customRaw === 'object' && customRaw !== null) {
    const json = canonicalJson(customRaw);
    if (Buffer.byteLength(json, 'utf8') <= CUSTOM_JSON_MAX_BYTES) {
      customJson = json;
      isCustom = Object.values(customRaw).some((v) => v === true) ? 1 : 0;
    } else {
      problems.push(`legalAcceptances/${doc.id}: custom map exceeds ${CUSTOM_JSON_MAX_BYTES} bytes — dropped, is_custom left NULL`);
    }
  }

  const textsSha256 = sha256HexOf(textsJson);
  const columns = [
    'acceptance_id',
    'tenant_id',
    'type',
    'user_id',
    'legacy_uid',
    'email',
    'accepted_at',
    'accepted_at_original',
    'template_version',
    'version',
    'is_pod',
    'is_custom',
    'custom_json',
    'texts_json',
    'texts_sha256',
    'user_agent',
    'ip',
    'source',
  ];
  const row = {
    accepted_at: acceptedAt,
    accepted_at_original: acceptedAtOriginal,
    acceptance_id: acceptanceId,
    custom_json: customJson,
    email,
    is_custom: isCustom,
    is_pod: isPod,
    ip: null,
    legacy_uid: legacyUid,
    source: 'import',
    template_version: typeof data.templateVersion === 'string' ? data.templateVersion : null,
    tenant_id: tenantId,
    texts_json: textsJson,
    texts_sha256: textsSha256,
    type,
    user_agent: typeof data.userAgent === 'string' ? data.userAgent.slice(0, 2048) : null,
    user_id: userId,
    version: typeof data.version === 'string' ? data.version : null,
  };
  const rows = [carriedRow('legal_acceptances', acceptanceId, insertStatement('legal_acceptances', columns, row), rowContentHash('legal_acceptances', columns, row))];
  // The snapshot's own SQL literal, for the whole-plan address scan: evidence
  // is not scrubbed, so the scan leaves this one literal out.
  return { problems, report: { acceptanceId, adopted: userId !== null, tenantId, type }, rows, scanExemptLiterals: [sqlLiteral(textsJson)] };
}
