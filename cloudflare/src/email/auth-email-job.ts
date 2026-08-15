export type AuthEmailKind = "email_verification" | "password_reset";
export type AuthEmailLocale = "en" | "sv";

export interface AuthEmailJob {
  actionUrl: string;
  deliveryId: string;
  expiresAt: number;
  kind: AuthEmailKind;
  locale: AuthEmailLocale;
  recipient: string;
  tenantId?: string;
  version: 1;
}

export interface AuthEmailMessage {
  html: string;
  subject: string;
  text: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DELIVERY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizedEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    throw new Error("Invalid auth email recipient");
  }
  return email;
}

function validatedActionUrl(
  value: string,
  kind: AuthEmailKind,
  expectedBaseUrl: string,
): string {
  const url = new URL(value);
  const baseUrl = new URL(expectedBaseUrl);
  const expectedPath =
    kind === "email_verification"
      ? /^\/api\/auth\/verify-email$/
      : /^\/api\/auth\/reset-password\/[^/]+$/;

  if (
    url.protocol !== "https:" ||
    url.origin !== baseUrl.origin ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    !expectedPath.test(url.pathname)
  ) {
    throw new Error("Invalid auth email action URL");
  }

  return url.href;
}

export function createAuthEmailJob(
  input: Omit<AuthEmailJob, "deliveryId" | "recipient" | "version"> & {
    recipient: string;
  },
  expectedBaseUrl: string,
): AuthEmailJob {
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) {
    throw new Error("Auth email expiry must be in the future");
  }

  return {
    actionUrl: validatedActionUrl(
      input.actionUrl,
      input.kind,
      expectedBaseUrl,
    ),
    deliveryId: crypto.randomUUID(),
    expiresAt: input.expiresAt,
    kind: input.kind,
    locale: input.locale,
    recipient: normalizedEmail(input.recipient),
    ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
    version: 1,
  };
}

export function parseAuthEmailJob(
  value: unknown,
  expectedBaseUrl: string,
): AuthEmailJob {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid auth email job");
  }

  const job = value as Partial<AuthEmailJob>;
  if (
    job.version !== 1 ||
    !DELIVERY_ID_PATTERN.test(job.deliveryId ?? "") ||
    (job.kind !== "email_verification" && job.kind !== "password_reset") ||
    (job.locale !== "sv" && job.locale !== "en") ||
    !Number.isSafeInteger(job.expiresAt) ||
    (job.expiresAt as number) <= Date.now() ||
    (job.tenantId !== undefined &&
      (typeof job.tenantId !== "string" || job.tenantId.length === 0))
  ) {
    throw new Error("Invalid auth email job");
  }

  return {
    actionUrl: validatedActionUrl(
      String(job.actionUrl ?? ""),
      job.kind,
      expectedBaseUrl,
    ),
    deliveryId: job.deliveryId as string,
    expiresAt: job.expiresAt as number,
    kind: job.kind,
    locale: job.locale,
    recipient: normalizedEmail(String(job.recipient ?? "")),
    ...(job.tenantId === undefined ? {} : { tenantId: job.tenantId }),
    version: 1,
  };
}

export async function hashEmailRecipient(recipient: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalizedEmail(recipient)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function redactedAuthEmailJobMetadata(job: AuthEmailJob) {
  return {
    deliveryId: job.deliveryId,
    expiresAt: job.expiresAt,
    kind: job.kind,
    locale: job.locale,
    tenantId: job.tenantId ?? null,
    version: job.version,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function renderAuthEmail(job: AuthEmailJob): AuthEmailMessage {
  const copy =
    job.locale === "sv"
      ? job.kind === "email_verification"
        ? {
            action: "Verifiera e-postadress",
            intro: "Bekräfta din e-postadress för MeteorShop.",
            subject: "Verifiera din e-postadress",
          }
        : {
            action: "Återställ lösenord",
            intro: "Du har begärt att återställa ditt lösenord för MeteorShop.",
            subject: "Återställ ditt lösenord",
          }
      : job.kind === "email_verification"
        ? {
            action: "Verify email address",
            intro: "Confirm your email address for MeteorShop.",
            subject: "Verify your email address",
          }
        : {
            action: "Reset password",
            intro: "You requested a password reset for MeteorShop.",
            subject: "Reset your password",
          };
  const safeUrl = escapeHtml(job.actionUrl);

  return {
    html: `<p>${copy.intro}</p><p><a href="${safeUrl}">${copy.action}</a></p>`,
    subject: copy.subject,
    text: `${copy.intro}\n\n${copy.action}: ${job.actionUrl}`,
  };
}
