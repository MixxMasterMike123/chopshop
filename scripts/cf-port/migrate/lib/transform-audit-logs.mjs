/**
 * scripts/cf-port/migrate/lib/transform-audit-logs.mjs — manifest row 12:
 * `auditLogs` → `audit_events` (0001), preserve (`event_id` = Firestore id).
 * Insert-only (`audit_events` is append-only by trigger; INSERT OR IGNORE is
 * therefore the correct idempotent form — a re-run with the SAME id and
 * content is a no-op, matching every other carried table here).
 *
 * shopId → tenant_id (verbatim; NULL when absent — the table allows a NULL
 * tenant for a platform-level event). actor uid → uid→map (legacy uid kept in
 * metadata_json when unmapped, per manifest §a "Evidence rows keep the legacy
 * uid verbatim... An unmappable uid... keeps its value in a *_legacy_uid
 * column" — audit_events has no such column, so this module follows the
 * manifest's own audit-row precedent and puts it in metadata_json instead,
 * since 0001's audit_events.actor_user_id has no FK to enforce and no
 * *_legacy_uid sibling column exists on this table).
 *
 * resource_type (review round 1 answer): the source's own writers
 * (functions/src/infringement/takedownProduct.ts, functions/src/customer-
 * admin/functions.ts) stamp a `targetType` field naming what the entry is
 * about — 'product' and 'b2cCustomer' are the two values found in the source.
 * This module maps that field onto the Worker's OWN resource_type vocabulary
 * (cloudflare/src's own audit writers use singular, snake_case values:
 * "tenant", "tenant_domain", "order", "payment_intent", "refund_operation",
 * "withholding_release", "outbox_event"): 'product' -> 'product' (already
 * matches the convention), 'b2cCustomer' -> 'b2c_customer' (camelCase folded
 * to snake_case, matching "tenant_domain"'s own multi-word shape). An entry
 * whose targetType is absent or unrecognised keeps 'legacy_import' — never
 * invented past what the source actually named.
 *
 * Firebase field → column:
 *   shopId                → tenant_id
 *   action                → action
 *   actor uid (mapped)    → actor_user_id (NULL if unmapped; legacy kept in metadata_json.legacyActorUid)
 *   targetType             → resource_type (mapped per TARGET_TYPE_TO_RESOURCE_TYPE; 'legacy_import' when absent/unrecognised)
 *   target/resource id    → resource_id
 *   reason                → reason
 *   metadata               → metadata_json (merged with legacyActorUid when applicable)
 *   createdAt/at/performedAt → created_at (INTEGER ms — 0001's schema; see lib/time-columns.mjs)
 */

import { insertStatement } from './sql.mjs';
import { rowContentHash, carriedRow } from './plan.mjs';
import { formatTime } from './time-columns.mjs';
import { parseSourceTimestampMillis } from './timestamps.mjs';

/** Source `targetType` -> this schema's `resource_type`. Every entry found in
 * the source writers (takedownProduct.ts, customer-admin/functions.ts) is
 * listed explicitly; nothing is derived or guessed. */
export const TARGET_TYPE_TO_RESOURCE_TYPE = {
  b2cCustomer: 'b2c_customer',
  product: 'product',
};

function resourceTypeFor(data) {
  const targetType = typeof data.targetType === 'string' ? data.targetType : null;
  if (targetType === null) return 'legacy_import';
  return TARGET_TYPE_TO_RESOURCE_TYPE[targetType] ?? 'legacy_import';
}

export function transformAuditLog({ doc, legacyIdMap, nowMillis }) {
  const data = doc.data ?? {};
  const eventId = doc.id;
  const tenantId = typeof data.shopId === 'string' && data.shopId.length > 0 ? data.shopId : null;
  const action = typeof data.action === 'string' ? data.action : 'legacy.unknown';
  const legacyActorUid =
    typeof data.actorUid === 'string' && data.actorUid.length > 0
      ? data.actorUid
      : typeof data.performedBy === 'string' && data.performedBy.length > 0
        ? data.performedBy
        : typeof data.uid === 'string'
          ? data.uid
          : null;
  const mappedActorUserId = legacyActorUid !== null ? legacyIdMap[legacyActorUid] ?? null : null;

  const resourceId =
    typeof data.targetId === 'string' ? data.targetId : typeof data.resourceId === 'string' ? data.resourceId : null;
  const resourceType = resourceTypeFor(data);
  const reason = typeof data.reason === 'string' ? data.reason : null;

  const metadata = { ...(typeof data.metadata === 'object' && data.metadata !== null ? data.metadata : {}) };
  // details (takedownProduct.ts) / targetName carry useful context the
  // schema has no dedicated column for; folded into metadata_json rather
  // than dropped.
  if (typeof data.details === 'object' && data.details !== null) {
    metadata.details = data.details;
  }
  if (typeof data.targetName === 'string' && data.targetName.length > 0) {
    metadata.targetName = data.targetName;
  }
  if (legacyActorUid !== null && mappedActorUserId === null) {
    metadata.legacyActorUid = legacyActorUid;
  }
  const createdAtMillis = parseSourceTimestampMillis(data.createdAt ?? data.at ?? data.performedAt, nowMillis);

  const columns = ['event_id', 'tenant_id', 'actor_user_id', 'action', 'resource_type', 'resource_id', 'reason', 'request_id', 'metadata_json', 'created_at'];
  const row = {
    action,
    actor_user_id: mappedActorUserId,
    created_at: formatTime('audit_events', 'created_at', createdAtMillis),
    event_id: eventId,
    metadata_json: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
    reason,
    request_id: `import_${eventId}`,
    resource_id: resourceId,
    resource_type: resourceType,
    tenant_id: tenantId,
  };
  return { rows: [carriedRow('audit_events', eventId, insertStatement('audit_events', columns, row), rowContentHash('audit_events', columns, row))] };
}
