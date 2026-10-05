import { auditMetadataJson, type TenantAdminPrincipal } from "../auth/live-authorization";
import { authorizeTenantAdminRequest } from "../auth/request-authorization";
import { readReminderSettings } from "../commerce/checkout-reminders";
import { readEmailDeliveryConfig } from "../email/email-queue-consumer";
import { jsonResponse } from "../lib/http";
import { invalidRequestResponse, readJsonBody, routeNotFoundResponse } from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";
import { isFeatureEnabled } from "../platform/tenant-config";

/**
 * CP9-AC — the seller's switch for Övergiven kassa (§7.1, migration 0056
 * checkout_reminder_settings):
 *
 *   GET /v1/admin/checkout-reminders
 *       200 { checkoutReminders: { enabled, delayHours, enabledAt, updatedAt,
 *                                  queuedLast30Days, mailConfigured } }
 *           no row yet: enabled false, delayHours 1, enabledAt and updatedAt null
 *   PUT /v1/admin/checkout-reminders   body exactly { enabled, delayHours }
 *       200 the same shape, as stored
 *       400 invalid_request               any other shape; a delay outside 1–24
 *   both:
 *       404  no session, membership or acting-as grant; a cross-origin PUT;
 *            the platform's add-on is off for the shop (CP8-DC's rule DC14)
 *
 * `enabledAt`: when the switch was last turned on. Only a checkout made at or
 * after it can be reminded (AC3), so turning the switch on mails nobody from
 * before; an off → on write moves it to now, every other write keeps it.
 *
 * `mailConfigured`: can a mail leave this environment at all (CP9-OB's rule,
 * src/platform/invites.ts)? False: reminders are decided and queued but held,
 * and the page says so.
 *
 * What the seller NEVER sees: a buyer's address, name or cart from an unpaid
 * checkout, a list of abandoned checkouts, whether an address unsubscribed.
 * One count of queued reminders is all.
 *
 * An acting-as platform user may write the switch (AC15); the audit row
 * carries the grant (auditMetadataJson).
 */

export const ADMIN_CHECKOUT_REMINDERS_PATH = "/v1/admin/checkout-reminders";

const DAY_MS = 24 * 60 * 60 * 1_000;
const BODY_KEYS = ["delayHours", "enabled"];

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

async function view(env: Env, tenantId: string, now: number) {
  const [settings, queued] = await Promise.all([
    readReminderSettings(env.DB, tenantId),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM checkout_reminders
       WHERE tenant_id = ? AND state = 'queued' AND decided_at > ?`,
    )
      .bind(tenantId, now - 30 * DAY_MS)
      .first<{ n: number }>(),
  ]);
  return {
    checkoutReminders: {
      delayHours: settings.delayHours,
      enabled: settings.enabled,
      enabledAt: iso(settings.enabledAt),
      mailConfigured: readEmailDeliveryConfig(env) !== null,
      queuedLast30Days: queued?.n ?? 0,
      updatedAt: iso(settings.updatedAt),
    },
  };
}

function parseSwitch(body: unknown): { delayHours: number; enabled: boolean } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== BODY_KEYS.length || !BODY_KEYS.every((key) => keys.includes(key))) {
    return null;
  }
  const { delayHours, enabled } = record;
  return typeof enabled === "boolean" &&
    typeof delayHours === "number" &&
    Number.isSafeInteger(delayHours) &&
    delayHours >= 1 &&
    delayHours <= 24
    ? { delayHours, enabled }
    : null;
}

async function writeSwitch(
  env: Env,
  principal: TenantAdminPrincipal,
  input: { delayHours: number; enabled: boolean },
  now: number,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO checkout_reminder_settings (tenant_id, enabled, delay_hours, enabled_at, updated_at, updated_by)
       VALUES (?1, ?2, ?3, CASE WHEN ?2 = 1 THEN ?4 ELSE NULL END, ?4, ?5)
       ON CONFLICT (tenant_id) DO UPDATE SET
         enabled = excluded.enabled,
         delay_hours = excluded.delay_hours,
         enabled_at = CASE
           WHEN excluded.enabled = 1 AND checkout_reminder_settings.enabled = 0 THEN excluded.updated_at
           ELSE checkout_reminder_settings.enabled_at
         END,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    ).bind(principal.tenantId, input.enabled ? 1 : 0, input.delayHours, now, principal.userId),
    env.DB.prepare(
      `INSERT INTO audit_events (
         event_id, tenant_id, actor_user_id, action, resource_type,
         resource_id, request_id, metadata_json, created_at
       ) VALUES (?, ?, ?, 'checkout_reminders.settings', 'checkout_reminder_settings', ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      principal.tenantId,
      principal.userId,
      principal.tenantId,
      crypto.randomUUID(),
      auditMetadataJson(principal, { delayHours: input.delayHours, enabled: input.enabled }),
      now,
    ),
  ]);
}

export async function handleAdminCheckoutRemindersRoute(
  env: Env,
  request: Request,
  // Tests pin the clock; the mounted route always uses the server's.
  options: { now?: number } = {},
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "PUT") {
    return routeNotFoundResponse();
  }
  const principal = await authorizeTenantAdminRequest(env, request);
  if (
    principal === null ||
    (request.method === "PUT" && !isSameOriginRequest(request)) ||
    !(await isFeatureEnabled(env.DB, principal.tenantId, "abandonedCheckout"))
  ) {
    return routeNotFoundResponse();
  }
  const now = options.now ?? Date.now();
  if (request.method === "PUT") {
    const input = parseSwitch(await readJsonBody(request));
    if (input === null) {
      return invalidRequestResponse();
    }
    await writeSwitch(env, principal, input, now);
  }
  return jsonResponse(await view(env, principal.tenantId, now));
}
