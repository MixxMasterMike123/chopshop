/**
 * scripts/cf-port/migrate/lib/ids.mjs — deterministic id generation for rows
 * that receive a NEW id (manifest §a: "new + map"), so a re-run of the same
 * bundle under the same environment produces byte-identical ids and therefore
 * a byte-identical plan (C4/C5).
 *
 * Only ONE kind needs a new id in CP3: users (manifest §a; `legacy_id_map.kind
 * = 'user'`, migration 0033). Every other id this importer writes is preserved
 * verbatim from Firestore (tenant id = shopId, printer id = Firestore doc id,
 * profile id = Firestore doc id, …).
 *
 * The id is derived from (env, kind, legacyId) with SHA-256 so it is stable
 * across runs and NEVER collides between staging and production (the env is
 * part of the hash input), matching the manifest: "Staging and production
 * maps are separate."
 */

import { createHash } from 'node:crypto';

/**
 * A deterministic, URL-safe, Better-Auth-compatible user id: 32 lowercase hex
 * characters derived from sha256(`user:${env}:${legacyId}`). Better Auth's own
 * ids are typically nanoid-shaped opaque strings; a lowercase hex string of
 * this length is a valid TEXT PRIMARY KEY and carries no legacy value or PII.
 */
export function deterministicUserId(env, legacyId) {
  if (env !== 'staging' && env !== 'production') {
    throw new Error(`deterministicUserId: env must be 'staging' or 'production', got ${JSON.stringify(env)}`);
  }
  if (typeof legacyId !== 'string' || legacyId.length === 0) {
    throw new Error('deterministicUserId: legacyId must be a non-empty string');
  }
  const hash = createHash('sha256').update(`user:${env}:${legacyId}`, 'utf8').digest('hex');
  return hash.slice(0, 32);
}

/**
 * A deterministic id for any other row this importer writes that needs a
 * fresh, stable, collision-free primary key across re-runs (e.g. a legal
 * acceptance row derived from a Firestore auto-id: kept verbatim actually —
 * see the transform modules — but audit/import-run scratch ids use this).
 * `parts` are joined with `:` before hashing; every part must be a string.
 */
export function deterministicId(namespace, ...parts) {
  if (typeof namespace !== 'string' || namespace.length === 0) {
    throw new Error('deterministicId: namespace must be a non-empty string');
  }
  for (const part of parts) {
    if (typeof part !== 'string') {
      throw new Error('deterministicId: every part must be a string');
    }
  }
  const hash = createHash('sha256').update([namespace, ...parts].join(':'), 'utf8').digest('hex');
  return hash.slice(0, 32);
}
