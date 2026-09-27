import { createAuthEmailJob } from "../email/auth-email-job";
import {
  abandonAuthEmailDelivery,
  recordAuthEmailDelivery,
} from "../email/email-delivery-store";
import type { CanonicalOrigins } from "../lib/origins";
import { readCanonicalOrigins } from "../lib/origins";
import { clientIp, enforceRateLimit } from "../lib/rate-limit";
import {
  invalidRequestResponse,
  rateLimitedResponse,
  readJsonBody,
} from "../lib/responses";

/**
 * Password reset with delivery through the email queue (PLAN §10, CP1).
 *
 * Three Better Auth 1.6.29 endpoints are mounted for it (verified against
 * node_modules/better-auth/dist/api/routes/password.mjs, where they are defined,
 * and dist/api/index.mjs, where they are registered):
 *
 *   POST /api/auth/request-password-reset   { email }         → always 200
 *   GET  /api/auth/reset-password/:token    ?callbackURL=…    → 302 to the web app
 *   POST /api/auth/reset-password           { token, newPassword }
 *
 * (`/forget-password` does not exist in core 1.6.29 — only in the email-otp
 * plugin, which is not installed — and stays unmounted.)
 *
 * NOTHING IS SENT INLINE. Better Auth calls `sendResetPassword` from inside the
 * request; that hook (below, wired in create-auth.ts) records a ledger row and
 * enqueues a job, and the `-email` queue consumer does the sending. The request
 * therefore never waits on the email provider, and a provider outage never
 * turns into a failed or slow reset request.
 */

/** Better Auth's reset token lifetime, and therefore the email's. */
export const PASSWORD_RESET_TOKEN_TTL_SECONDS = 60 * 60;

/** Where the web app handles `?token=` / `?error=` after the link redirects. */
export const PASSWORD_RESET_WEB_PATH = "/reset-password";

const MINUTE_MS = 60 * 1_000;

// Two limits in front of Better Auth's own (3/min per client IP): per IP, the
// flood shield; per email address, which survives an attacker rotating IPs to
// mail-bomb one inbox. Both count every request whether or not the address
// belongs to an account, so neither can be used to tell the two apart.
export const PASSWORD_RESET_IP_SCOPE = "password-reset-ip";
export const PASSWORD_RESET_IP_LIMIT = 5;
export const PASSWORD_RESET_IP_WINDOW_MS = 10 * MINUTE_MS;
export const PASSWORD_RESET_EMAIL_SCOPE = "password-reset-email";
export const PASSWORD_RESET_EMAIL_LIMIT = 3;
export const PASSWORD_RESET_EMAIL_WINDOW_MS = 60 * MINUTE_MS;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

/**
 * The reset surface exists only when everything it needs exists: the email
 * queue to hand jobs to and a valid canonical origin allowlist to build the
 * link from (the auth secret is checked first, by the /api/auth/ namespace gate
 * in auth-routes.ts). Missing any one ⇒ every reset route answers the same 404
 * as a route that was never mounted.
 *
 * RESEND_API_KEY is deliberately NOT part of this gate. Requests are accepted
 * and queued without it; the consumer holds them (retrying with a delay) until
 * the key exists, so a key rotation never drops a reset on the floor.
 */
export function isPasswordResetConfigured(env: Env): boolean {
  return env.EMAIL_QUEUE !== undefined && readCanonicalOrigins(env) !== null;
}

/**
 * The web surfaces a reset link may land on (CP3). The ordinary reset lands on
 * `web`; a platform invite (src/platform/invites.ts) lands on `platform` for a
 * platform admin and on `admin` for a tenant admin (PLAN §2.1: admin and
 * platform are one hostname each).
 */
export type ResetPageSurface = "admin" | "platform" | "web";

const RESET_PAGE_SURFACES: readonly ResetPageSurface[] = ["web", "admin", "platform"];

/**
 * The canonical origin of one reset surface. The allowlist (src/lib/origins.ts)
 * lists `api` and `web` today; until it also lists `admin` and `platform`, those
 * surfaces are served by the web origin and land there. The origin is always an
 * allowlist value, never anything the request carried.
 */
export function resetPageOrigin(
  origins: CanonicalOrigins,
  surface: ResetPageSurface,
): string {
  const listed = (origins as Readonly<Partial<Record<ResetPageSurface, string>>>)[surface];
  return typeof listed === "string" ? listed : origins.web;
}

/** Every distinct origin a reset link may land on (Better Auth must trust them). */
export function resetPageOrigins(origins: CanonicalOrigins): string[] {
  return [...new Set(RESET_PAGE_SURFACES.map((surface) => resetPageOrigin(origins, surface)))];
}

/**
 * The web page the emailed link lands on. The ordinary reset (no surface)
 * always lands on the canonical web origin.
 */
export function passwordResetCallbackUrl(
  origins: CanonicalOrigins,
  surface: ResetPageSurface = "web",
): string {
  return `${resetPageOrigin(origins, surface)}${PASSWORD_RESET_WEB_PATH}`;
}

/**
 * The emailed link. Built from AUTH_BASE_URL (Better Auth's own base, and the
 * only origin the job validator accepts) and a canonical reset page — never
 * from the request, and never from the URL Better Auth hands the hook, which
 * would carry whatever `redirectTo` reached Better Auth.
 */
export function passwordResetActionUrl(
  env: Env,
  origins: CanonicalOrigins,
  token: string,
  surface: ResetPageSurface = "web",
): string {
  const url = new URL(
    `/api/auth/reset-password/${encodeURIComponent(token)}`,
    env.AUTH_BASE_URL,
  );
  url.searchParams.set("callbackURL", passwordResetCallbackUrl(origins, surface));
  return url.href;
}

function logEnqueueFailure(reason: string, error?: unknown): void {
  // No recipient, no token, no link: the log line names the failure only.
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.name : undefined,
      message: "password reset email could not be enqueued",
      reason,
    }),
  );
}

/**
 * The `sendResetPassword` hook: ledger row first, then the queue.
 *
 * It never throws. Better Auth runs it inside the request, and a throw would
 * turn into a 500 that only an EXISTING account can produce — an account
 * oracle. A failure is logged and the ledger row is closed as failed instead
 * (the ledger holds no recipient, so an un-enqueued row could never be sent);
 * the user sees the same answer as always and can simply ask again.
 */
export async function enqueuePasswordResetEmail(
  env: Env,
  input: { recipient: string; token: string },
): Promise<void> {
  const origins = readCanonicalOrigins(env);
  const queue = env.EMAIL_QUEUE;
  if (origins === null || queue === undefined) {
    // Unreachable through the mounted route, which is gated on both.
    logEnqueueFailure("not_configured");
    return;
  }

  let job;
  try {
    job = createAuthEmailJob(
      {
        actionUrl: passwordResetActionUrl(env, origins, input.token),
        expiresAt: Date.now() + PASSWORD_RESET_TOKEN_TTL_SECONDS * 1_000,
        kind: "password_reset",
        locale: "sv",
        recipient: input.recipient,
      },
      env.AUTH_BASE_URL,
    );
  } catch (error) {
    logEnqueueFailure("invalid_job", error);
    return;
  }

  try {
    await recordAuthEmailDelivery(env.DB, job, job.createdAt);
  } catch (error) {
    logEnqueueFailure("ledger_unavailable", error);
    return;
  }

  try {
    await queue.send(job, { contentType: "json" });
  } catch (error) {
    logEnqueueFailure("queue_unavailable", error);
    try {
      await abandonAuthEmailDelivery(
        env.DB,
        job.deliveryId,
        "E_ENQUEUE",
        Date.now(),
      );
    } catch {
      // The row stays pending; the reconciliation sweep (PLAN §2.2) owns it.
    }
  }
}

function parseRequestedEmail(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }

  const email = (body as Record<string, unknown>).email;
  if (typeof email !== "string") {
    return null;
  }

  const normalized = email.trim().toLowerCase();
  return normalized.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(normalized)
    ? normalized
    : null;
}

/**
 * `POST /api/auth/request-password-reset`, in front of Better Auth.
 *
 * Rate limits first (per IP before the body is read, per address after), then
 * the request Better Auth sees is REBUILT: only the normalized email survives,
 * and `redirectTo` is set to the canonical web reset page. Whatever the client
 * sent as `redirectTo`/`callbackURL` never reaches Better Auth, so it can
 * neither steer the link nor probe the trusted-origin list with a 403.
 *
 * The answer for a known and an unknown address is Better Auth's identical
 * `200 { status: true, message }`; both limits count both kinds alike.
 */
export async function handleRequestPasswordReset(
  env: Env,
  request: Request,
  forward: (request: Request) => Promise<Response>,
): Promise<Response> {
  const origins = readCanonicalOrigins(env);
  if (origins === null) {
    throw new Error("password reset reached without canonical origins");
  }

  const now = Date.now();
  const byIp = await enforceRateLimit(env.DB, {
    key: clientIp(request),
    limit: PASSWORD_RESET_IP_LIMIT,
    now,
    scope: PASSWORD_RESET_IP_SCOPE,
    windowMs: PASSWORD_RESET_IP_WINDOW_MS,
  });
  if (!byIp.allowed) {
    return rateLimitedResponse(byIp.retryAfterSeconds);
  }

  const email = parseRequestedEmail(await readJsonBody(request));
  if (email === null) {
    return invalidRequestResponse();
  }

  const byEmail = await enforceRateLimit(env.DB, {
    key: email,
    limit: PASSWORD_RESET_EMAIL_LIMIT,
    now,
    scope: PASSWORD_RESET_EMAIL_SCOPE,
    windowMs: PASSWORD_RESET_EMAIL_WINDOW_MS,
  });
  if (!byEmail.allowed) {
    return rateLimitedResponse(byEmail.retryAfterSeconds);
  }

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");

  return forward(
    new Request(request.url, {
      body: JSON.stringify({
        email,
        redirectTo: passwordResetCallbackUrl(origins),
      }),
      headers,
      method: "POST",
    }),
  );
}

/**
 * `GET /api/auth/reset-password/:token` — the link in the email.
 *
 * The `callbackURL` query is rebuilt before Better Auth sees it: it survives
 * only when it is EXACTLY one of the canonical reset pages (the web page, or the
 * admin/platform page an invite points at), and is otherwise replaced with the
 * canonical web reset page. Every other query parameter is dropped. A doctored
 * link therefore cannot bounce a valid token to any page outside the allowlist,
 * trusted or not. While the allowlist has only `web`, this is exactly the old
 * rule: the callback is always the web reset page.
 */
export function canonicalResetLinkRequest(
  request: Request,
  origins: CanonicalOrigins,
): Request {
  const url = new URL(request.url);
  const asked = url.searchParams.get("callbackURL");
  const allowed = RESET_PAGE_SURFACES.map((surface) =>
    passwordResetCallbackUrl(origins, surface),
  );
  url.search = "";
  url.searchParams.set(
    "callbackURL",
    asked !== null && allowed.includes(asked) ? asked : passwordResetCallbackUrl(origins),
  );
  return new Request(url.href, { headers: request.headers, method: "GET" });
}
