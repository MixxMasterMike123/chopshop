export type AuthEmailKind =
  | "alert_digest"
  | "email_verification"
  | "order_confirmation"
  | "password_reset";
export type AuthEmailLocale = "en" | "sv";

/** The two kinds that carry an action link (verify / reset). */
export type AuthActionEmailKind = "email_verification" | "password_reset";

/**
 * The product's display name in every email this module renders. ONE place:
 * the reset, verification and invite templates all read it.
 */
export const PLATFORM_DISPLAY_NAME = "ChopShop";

/**
 * How long an invite link works, in the words of the invite email. The token's
 * own lifetime (src/platform/invites.ts INVITE_TOKEN_TTL_SECONDS) is derived
 * from this, so the copy and the token cannot disagree.
 */
export const INVITE_LINK_VALID_HOURS = 72;

/**
 * A wording variant of an action email. `invite` exists only on a
 * `password_reset` job: the link and the mechanism are the reset's, the words
 * are an invitation (src/platform/invites.ts). The ledger kind stays
 * `password_reset`.
 */
export type AuthActionEmailVariant = "invite";

interface EmailJobBase {
  createdAt: number;
  deliveryId: string;
  expiresAt: number;
  locale: AuthEmailLocale;
  recipient: string;
  tenantId?: string;
  version: 1;
}

export interface AuthActionEmailJob extends EmailJobBase {
  actionUrl: string;
  kind: AuthActionEmailKind;
  order?: undefined;
  /** Absent on every ordinary reset and verification job (their shape is unchanged). */
  variant?: AuthActionEmailVariant;
}

/**
 * One order line as the confirmation shows it. Copied from the order's own
 * frozen rows (orders / order_items, 0011) by the outbox email effect
 * (src/outbox/email-effect.ts) — never from the catalogue.
 */
export interface OrderConfirmationLine {
  lineTotalMinor: number;
  name: string;
  quantity: number;
}

export interface OrderConfirmationContent {
  currency: string;
  deliveryMethod: "pickup" | "shipping";
  discountMinor: number;
  items: OrderConfirmationLine[];
  orderNumber: string;
  shippingCountry: string | null;
  shippingMinor: number;
  shopName: string | null;
  subtotalMinor: number;
  totalMinor: number;
  vatMinor: number;
}

/**
 * The order confirmation (PLAN §2.3: `outbox(email)` in the order batch). It
 * carries NO link — `actionUrl` is always the empty string: the guest receipt
 * capability is returned once at checkout and stored only hashed (§2.1), so
 * there is nothing a mail could safely point at. (Empty rather than absent so
 * every job keeps one shape for the ledger's fingerprint and existing readers.)
 * Its delivery id is DERIVED from the outbox dedupe key, so every retry of the
 * effect produces the same job and the ledger sends it at most once.
 */
export interface OrderConfirmationEmailJob extends EmailJobBase {
  actionUrl: "";
  kind: "order_confirmation";
  order: OrderConfirmationContent;
  tenantId: string;
}

/**
 * One kind of open alert, as the platform digest shows it (D40). Ids and
 * counts only: an alert's message is never copied (it may name a shop's
 * order), and nothing here is an amount or customer data.
 */
export interface AlertDigestKind {
  count: number;
  kind: string;
  newCount: number;
  /** created_at of the oldest open alert of this kind (ISO-8601 UTC). */
  oldestAt: string;
  /** Up to MAX_DIGEST_RESOURCE_IDS resource ids, oldest first. */
  resourceIds: string[];
  severity: "critical" | "info" | "warning";
}

export interface AlertDigestContent {
  /** The 15-minute bucket this digest belongs to (ISO-8601 UTC). */
  bucketStart: string;
  kinds: AlertDigestKind[];
  /** Open alerts raised since the previous digest. */
  newCount: number;
  /** Every open alert. */
  openCount: number;
  /** Kinds beyond MAX_DIGEST_KINDS, not listed. */
  omittedKinds: number;
}

/**
 * The platform alert digest (D40, CP2-D2): a Swedish summary of the open
 * alerts to PLATFORM_ALERT_EMAIL, enqueued by runAlertDigest
 * (src/commerce/crons.ts). No tenant (a platform mail: the ledger row's
 * tenant_id is NULL), no link. Its delivery id is derived from the 15-minute
 * bucket and its content is frozen in platform_state (0029), so a retried
 * tick produces the identical job and the ledger sends it at most once.
 */
export interface AlertDigestEmailJob extends EmailJobBase {
  actionUrl: "";
  digest: AlertDigestContent;
  kind: "alert_digest";
  order?: undefined;
  tenantId?: undefined;
}

export type AuthEmailJob = AuthActionEmailJob | AlertDigestEmailJob | OrderConfirmationEmailJob;

export interface AuthEmailMessage {
  html: string;
  subject: string;
  text: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DELIVERY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_JOB_LIFETIME_MS = 24 * 60 * 60 * 1000;

function normalizedEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    throw new Error("Invalid auth email recipient");
  }
  return email;
}

function validatedActionUrl(
  value: string,
  kind: AuthActionEmailKind,
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

/** A variant is either absent or `invite` on a `password_reset` job. */
function validatedVariant(
  value: unknown,
  kind: AuthActionEmailKind,
): { variant?: AuthActionEmailVariant } {
  if (value === undefined) {
    return {};
  }
  if (value === "invite" && kind === "password_reset") {
    return { variant: "invite" };
  }
  throw new Error("Invalid auth email variant");
}

export function createAuthEmailJob(
  input: Omit<
    AuthActionEmailJob,
    "createdAt" | "deliveryId" | "order" | "recipient" | "version"
  > & {
    recipient: string;
  },
  expectedBaseUrl: string,
): AuthActionEmailJob {
  const createdAt = Date.now();
  if (
    !Number.isSafeInteger(input.expiresAt) ||
    input.expiresAt <= createdAt ||
    input.expiresAt > createdAt + MAX_JOB_LIFETIME_MS
  ) {
    throw new Error("Auth email expiry must be in the future");
  }

  return {
    actionUrl: validatedActionUrl(
      input.actionUrl,
      input.kind,
      expectedBaseUrl,
    ),
    createdAt,
    deliveryId: crypto.randomUUID(),
    expiresAt: input.expiresAt,
    kind: input.kind,
    locale: input.locale,
    recipient: normalizedEmail(input.recipient),
    ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
    ...validatedVariant(input.variant, input.kind),
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

  if ((value as { kind?: unknown }).kind === "order_confirmation") {
    return parseOrderConfirmationEmailJob(value);
  }

  if ((value as { kind?: unknown }).kind === "alert_digest") {
    return parseAlertDigestEmailJob(value);
  }

  const job = value as Partial<AuthActionEmailJob>;
  if (
    job.version !== 1 ||
    !DELIVERY_ID_PATTERN.test(job.deliveryId ?? "") ||
    (job.kind !== "email_verification" && job.kind !== "password_reset") ||
    (job.locale !== "sv" && job.locale !== "en") ||
    !Number.isSafeInteger(job.createdAt) ||
    !Number.isSafeInteger(job.expiresAt) ||
    (job.createdAt as number) > Date.now() + 5 * 60 * 1000 ||
    (job.expiresAt as number) <= (job.createdAt as number) ||
    (job.expiresAt as number) - (job.createdAt as number) >
      MAX_JOB_LIFETIME_MS ||
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
    createdAt: job.createdAt as number,
    deliveryId: job.deliveryId as string,
    expiresAt: job.expiresAt as number,
    kind: job.kind,
    locale: job.locale,
    recipient: normalizedEmail(String(job.recipient ?? "")),
    ...(job.tenantId === undefined ? {} : { tenantId: job.tenantId }),
    ...validatedVariant(job.variant, job.kind),
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
    createdAt: job.createdAt,
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
  if (job.kind === "order_confirmation") {
    return renderOrderConfirmationEmail(job);
  }

  if (job.kind === "alert_digest") {
    return renderAlertDigestEmail(job);
  }

  if (job.variant === "invite") {
    return renderInviteEmail(job);
  }

  const copy =
    job.locale === "sv"
      ? job.kind === "email_verification"
        ? {
            action: "Verifiera e-postadress",
            intro: `Bekräfta din e-postadress för ${PLATFORM_DISPLAY_NAME}.`,
            subject: "Verifiera din e-postadress",
          }
        : {
            action: "Återställ lösenord",
            intro: `Du har begärt att återställa ditt lösenord för ${PLATFORM_DISPLAY_NAME}.`,
            subject: "Återställ ditt lösenord",
          }
      : job.kind === "email_verification"
        ? {
            action: "Verify email address",
            intro: `Confirm your email address for ${PLATFORM_DISPLAY_NAME}.`,
            subject: "Verify your email address",
          }
        : {
            action: "Reset password",
            intro: `You requested a password reset for ${PLATFORM_DISPLAY_NAME}.`,
            subject: "Reset your password",
          };
  const safeUrl = escapeHtml(job.actionUrl);

  return {
    html: `<p>${copy.intro}</p><p><a href="${safeUrl}">${copy.action}</a></p>`,
    subject: copy.subject,
    text: `${copy.intro}\n\n${copy.action}: ${job.actionUrl}`,
  };
}

// ── the platform invite (CP3-B) ──────────────────────────────────────────────

/**
 * The invite wording (a `password_reset` job with `variant: "invite"`). Plain:
 * what this is, what to do, how long the link works, and that an unexpected
 * mail can be ignored. Swedish by default, English as the alternative, like
 * the reset template.
 */
export function inviteEmailCopy(locale: AuthEmailLocale): {
  action: string;
  lines: { after: string[]; before: string[] };
  subject: string;
} {
  return locale === "sv"
    ? {
        action: "Välj lösenord",
        lines: {
          after: [
            `Länken gäller i ${INVITE_LINK_VALID_HOURS} timmar och kan bara användas en gång.`,
            "Om du inte väntade dig det här mejlet kan du bortse från det.",
          ],
          before: [
            `Ett konto har skapats åt dig på ${PLATFORM_DISPLAY_NAME}.`,
            "Välj ett lösenord för att logga in.",
          ],
        },
        subject: `Välj ditt lösenord för ${PLATFORM_DISPLAY_NAME}`,
      }
    : {
        action: "Choose password",
        lines: {
          after: [
            `The link works for ${INVITE_LINK_VALID_HOURS} hours and can be used once.`,
            "If you did not expect this email, you can ignore it.",
          ],
          before: [
            `An account has been created for you on ${PLATFORM_DISPLAY_NAME}.`,
            "Choose a password to sign in.",
          ],
        },
        subject: `Choose your password for ${PLATFORM_DISPLAY_NAME}`,
      };
}

function renderInviteEmail(job: AuthActionEmailJob): AuthEmailMessage {
  const copy = inviteEmailCopy(job.locale);
  const paragraph = (line: string) => `<p>${escapeHtml(line)}</p>`;

  return {
    html: [
      ...copy.lines.before.map(paragraph),
      `<p><a href="${escapeHtml(job.actionUrl)}">${escapeHtml(copy.action)}</a></p>`,
      ...copy.lines.after.map(paragraph),
    ].join(""),
    subject: copy.subject,
    text: [
      ...copy.lines.before,
      "",
      `${copy.action}: ${job.actionUrl}`,
      "",
      ...copy.lines.after,
    ].join("\n"),
  };
}

// ── order confirmation (CP2, PLAN §2.3 `outbox(email)`) ──────────────────────

const MAX_ORDER_LINES = 100;
const MAX_LINE_NAME_LENGTH = 200;
const MAX_ORDER_NUMBER_LENGTH = 64;
const MAX_SHOP_NAME_LENGTH = 200;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMinor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    // No control characters: the text lands in a subject line and in HTML.
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validatedOrderContent(value: unknown): OrderConfirmationContent {
  if (!isPlainRecord(value)) {
    throw new Error("Invalid order confirmation content");
  }
  const items = value.items;
  if (
    !isBoundedText(value.orderNumber, MAX_ORDER_NUMBER_LENGTH) ||
    typeof value.currency !== "string" ||
    !/^[A-Z]{3}$/.test(value.currency) ||
    (value.deliveryMethod !== "pickup" && value.deliveryMethod !== "shipping") ||
    (value.deliveryMethod === "pickup"
      ? value.shippingCountry !== null
      : typeof value.shippingCountry !== "string" ||
        !/^[A-Z]{2}$/.test(value.shippingCountry)) ||
    (value.shopName !== null && !isBoundedText(value.shopName, MAX_SHOP_NAME_LENGTH)) ||
    !isMinor(value.subtotalMinor) ||
    !isMinor(value.shippingMinor) ||
    !isMinor(value.discountMinor) ||
    !isMinor(value.vatMinor) ||
    !isMinor(value.totalMinor) ||
    // The order's own arithmetic (0011): VAT is contained in the total.
    value.totalMinor !== value.subtotalMinor + value.shippingMinor - value.discountMinor ||
    value.vatMinor > value.totalMinor ||
    !Array.isArray(items) ||
    items.length === 0 ||
    items.length > MAX_ORDER_LINES
  ) {
    throw new Error("Invalid order confirmation content");
  }

  const lines = items.map((item: unknown): OrderConfirmationLine => {
    if (
      !isPlainRecord(item) ||
      !isBoundedText(item.name, MAX_LINE_NAME_LENGTH) ||
      typeof item.quantity !== "number" ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 999 ||
      !isMinor(item.lineTotalMinor)
    ) {
      throw new Error("Invalid order confirmation content");
    }
    return {
      lineTotalMinor: item.lineTotalMinor,
      name: item.name,
      quantity: item.quantity,
    };
  });

  return {
    currency: value.currency,
    deliveryMethod: value.deliveryMethod,
    discountMinor: value.discountMinor,
    items: lines,
    orderNumber: value.orderNumber,
    shippingCountry: value.shippingCountry as string | null,
    shippingMinor: value.shippingMinor,
    shopName: value.shopName as string | null,
    subtotalMinor: value.subtotalMinor,
    totalMinor: value.totalMinor,
    vatMinor: value.vatMinor,
  };
}

/**
 * A v4-shaped UUID derived from a stable key (the outbox row's dedupe key),
 * so the ledger's delivery id — and Resend's Idempotency-Key — is the same on
 * every retry of the same effect. SHA-256, first 16 bytes, version and variant
 * bits set as RFC 9562 requires for the shape DELIVERY_ID_PATTERN accepts.
 */
export async function deliveryIdFromKey(key: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)),
  ).slice(0, 16);
  digest[6] = ((digest[6] as number) & 0x0f) | 0x40;
  digest[8] = ((digest[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validatedOrderJobFrame(
  input: Record<string, unknown>,
  now: number,
): Omit<OrderConfirmationEmailJob, "actionUrl" | "kind" | "order"> {
  if (
    input.version !== 1 ||
    typeof input.deliveryId !== "string" ||
    !DELIVERY_ID_PATTERN.test(input.deliveryId) ||
    input.locale !== "sv" ||
    !Number.isSafeInteger(input.createdAt) ||
    !Number.isSafeInteger(input.expiresAt) ||
    (input.createdAt as number) > now + 5 * 60 * 1000 ||
    (input.expiresAt as number) <= (input.createdAt as number) ||
    (input.expiresAt as number) - (input.createdAt as number) > MAX_JOB_LIFETIME_MS ||
    typeof input.tenantId !== "string" ||
    input.tenantId.length === 0
  ) {
    throw new Error("Invalid auth email job");
  }

  return {
    createdAt: input.createdAt as number,
    deliveryId: input.deliveryId,
    expiresAt: input.expiresAt as number,
    locale: "sv",
    recipient: normalizedEmail(String(input.recipient ?? "")),
    tenantId: input.tenantId,
    version: 1,
  };
}

/**
 * Builds the job the outbox email effect hands to EMAIL_QUEUE. Every field is
 * supplied by the caller (none is minted here), so the same inputs always
 * produce the same job — the property the ledger's fingerprint relies on.
 */
export function createOrderConfirmationEmailJob(input: {
  createdAt: number;
  deliveryId: string;
  expiresAt: number;
  order: OrderConfirmationContent;
  recipient: string;
  tenantId: string;
}): OrderConfirmationEmailJob {
  const frame = validatedOrderJobFrame(
    { ...input, locale: "sv", version: 1 },
    Date.now(),
  );
  return {
    ...frame,
    actionUrl: "",
    kind: "order_confirmation",
    order: validatedOrderContent(input.order),
  };
}

function parseOrderConfirmationEmailJob(value: unknown): OrderConfirmationEmailJob {
  const job = value as Record<string, unknown>;
  if (job.actionUrl !== "") {
    throw new Error("Invalid auth email job");
  }
  const frame = validatedOrderJobFrame(job, Date.now());
  return {
    ...frame,
    actionUrl: "",
    kind: "order_confirmation",
    order: validatedOrderContent(job.order),
  };
}

/**
 * The order content in a FIXED key order, for the delivery ledger's job
 * fingerprint (email-delivery-store.ts). The confirmation renders all of it, so
 * all of it is covered: a queued copy whose order number, lines or totals differ
 * from what the producer recorded is a fingerprint conflict, never a send.
 */
export function canonicalOrderContent(order: OrderConfirmationContent) {
  return {
    currency: order.currency,
    deliveryMethod: order.deliveryMethod,
    discountMinor: order.discountMinor,
    items: order.items.map((item) => ({
      lineTotalMinor: item.lineTotalMinor,
      name: item.name,
      quantity: item.quantity,
    })),
    orderNumber: order.orderNumber,
    shippingCountry: order.shippingCountry,
    shippingMinor: order.shippingMinor,
    shopName: order.shopName,
    subtotalMinor: order.subtotalMinor,
    totalMinor: order.totalMinor,
    vatMinor: order.vatMinor,
  };
}

/** Minor units → "1 234,50 kr" (sv-SE), the way the storefront shows money. */
export function formatOrderMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat("sv-SE", { currency, style: "currency" }).format(minor / 100);
}

const COUNTRY_NAMES_SV: Record<string, string> = {
  DK: "Danmark",
  FI: "Finland",
  NO: "Norge",
  SE: "Sverige",
};

function renderOrderConfirmationEmail(job: OrderConfirmationEmailJob): AuthEmailMessage {
  const { order } = job;
  const money = (minor: number) => formatOrderMoney(minor, order.currency);
  const thanks =
    order.shopName === null
      ? "Tack för din beställning!"
      : `Tack för din beställning hos ${order.shopName}!`;
  const intro = "Vi har tagit emot din beställning och börjar behandla den direkt.";
  const delivery =
    order.deliveryMethod === "pickup"
      ? "Upphämtning i butiken"
      : `Leverans till ${COUNTRY_NAMES_SV[order.shippingCountry ?? ""] ?? order.shippingCountry}`;

  const lines = order.items.map((item) => ({
    amount: money(item.lineTotalMinor),
    label: `${item.quantity} st ${item.name}`,
  }));
  const totals: Array<{ label: string; value: string }> = [
    { label: "Delsumma", value: money(order.subtotalMinor) },
    {
      label: order.deliveryMethod === "pickup" ? "Upphämtning" : "Frakt",
      value: money(order.shippingMinor),
    },
    ...(order.discountMinor > 0
      ? [{ label: "Rabatt", value: `-${money(order.discountMinor)}` }]
      : []),
    { label: "Totalt", value: money(order.totalMinor) },
    { label: "varav moms", value: money(order.vatMinor) },
  ];

  const text = [
    thanks,
    "",
    intro,
    "",
    `Ordernummer: ${order.orderNumber}`,
    `Leverans: ${delivery}`,
    "",
    ...lines.map((line) => `${line.label}: ${line.amount}`),
    "",
    ...totals.map((row) => `${row.label}: ${row.value}`),
  ].join("\n");

  const cell = (value: string) => `<td>${escapeHtml(value)}</td>`;
  const html = [
    `<p>${escapeHtml(thanks)}</p>`,
    `<p>${escapeHtml(intro)}</p>`,
    `<p>Ordernummer: <strong>${escapeHtml(order.orderNumber)}</strong><br>Leverans: ${escapeHtml(delivery)}</p>`,
    `<table>${lines.map((line) => `<tr>${cell(line.label)}${cell(line.amount)}</tr>`).join("")}</table>`,
    `<table>${totals.map((row) => `<tr>${cell(row.label)}${cell(row.value)}</tr>`).join("")}</table>`,
  ].join("");

  return {
    html,
    subject: `Orderbekräftelse ${order.orderNumber}`,
    text,
  };
}

// ── the platform alert digest (CP2-D2, DECISIONS D40) ────────────────────────

export const MAX_DIGEST_KINDS = 30;
export const MAX_DIGEST_RESOURCE_IDS = 5;
const MAX_DIGEST_COUNT = 1_000_000;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ALERT_KIND_PATTERN = /^[a-z0-9_.]{1,64}$/;

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_DIGEST_COUNT;
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && ISO_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

function validatedDigestContent(value: unknown): AlertDigestContent {
  if (
    !isPlainRecord(value) ||
    !isIso(value.bucketStart) ||
    !isCount(value.newCount) ||
    !isCount(value.openCount) ||
    !isCount(value.omittedKinds) ||
    value.newCount > value.openCount ||
    !Array.isArray(value.kinds) ||
    value.kinds.length > MAX_DIGEST_KINDS
  ) {
    throw new Error("Invalid alert digest content");
  }

  const kinds = value.kinds.map((entry: unknown): AlertDigestKind => {
    if (
      !isPlainRecord(entry) ||
      typeof entry.kind !== "string" ||
      !ALERT_KIND_PATTERN.test(entry.kind) ||
      (entry.severity !== "critical" && entry.severity !== "warning" && entry.severity !== "info") ||
      !isCount(entry.count) ||
      !isCount(entry.newCount) ||
      entry.newCount > entry.count ||
      entry.count < 1 ||
      !isIso(entry.oldestAt) ||
      !Array.isArray(entry.resourceIds) ||
      entry.resourceIds.length > MAX_DIGEST_RESOURCE_IDS ||
      !entry.resourceIds.every((id: unknown) => isBoundedText(id, 200))
    ) {
      throw new Error("Invalid alert digest content");
    }
    return {
      count: entry.count,
      kind: entry.kind,
      newCount: entry.newCount,
      oldestAt: entry.oldestAt,
      resourceIds: [...(entry.resourceIds as string[])],
      severity: entry.severity,
    };
  });

  return {
    bucketStart: value.bucketStart,
    kinds,
    newCount: value.newCount,
    omittedKinds: value.omittedKinds,
    openCount: value.openCount,
  };
}

function validatedDigestJobFrame(
  input: Record<string, unknown>,
  now: number,
): Omit<AlertDigestEmailJob, "actionUrl" | "digest" | "kind"> {
  if (
    input.version !== 1 ||
    typeof input.deliveryId !== "string" ||
    !DELIVERY_ID_PATTERN.test(input.deliveryId) ||
    input.locale !== "sv" ||
    !Number.isSafeInteger(input.createdAt) ||
    !Number.isSafeInteger(input.expiresAt) ||
    (input.createdAt as number) > now + 5 * 60 * 1000 ||
    (input.expiresAt as number) <= (input.createdAt as number) ||
    (input.expiresAt as number) - (input.createdAt as number) > MAX_JOB_LIFETIME_MS ||
    // A platform mail: never bound to a tenant.
    input.tenantId !== undefined
  ) {
    throw new Error("Invalid auth email job");
  }

  return {
    createdAt: input.createdAt as number,
    deliveryId: input.deliveryId,
    expiresAt: input.expiresAt as number,
    locale: "sv",
    recipient: normalizedEmail(String(input.recipient ?? "")),
    version: 1,
  };
}

/**
 * Builds the digest job. Every field is supplied by the caller (none is
 * minted here), so the same frozen inputs always produce the same job — the
 * property the ledger's fingerprint relies on. Throws on an invalid recipient.
 */
export function createAlertDigestEmailJob(input: {
  createdAt: number;
  deliveryId: string;
  digest: AlertDigestContent;
  expiresAt: number;
  recipient: string;
}): AlertDigestEmailJob {
  const frame = validatedDigestJobFrame({ ...input, locale: "sv", version: 1 }, Date.now());
  return {
    ...frame,
    actionUrl: "",
    digest: validatedDigestContent(input.digest),
    kind: "alert_digest",
  };
}

function parseAlertDigestEmailJob(value: unknown): AlertDigestEmailJob {
  const job = value as Record<string, unknown>;
  if (job.actionUrl !== "") {
    throw new Error("Invalid auth email job");
  }
  const frame = validatedDigestJobFrame(job, Date.now());
  return {
    ...frame,
    actionUrl: "",
    digest: validatedDigestContent(job.digest),
    kind: "alert_digest",
  };
}

/**
 * The digest content in a FIXED key order, for the delivery ledger's job
 * fingerprint (email-delivery-store.ts): all of it is rendered, so all of it
 * is covered.
 */
export function canonicalAlertDigestContent(digest: AlertDigestContent) {
  return {
    bucketStart: digest.bucketStart,
    kinds: digest.kinds.map((entry) => ({
      count: entry.count,
      kind: entry.kind,
      newCount: entry.newCount,
      oldestAt: entry.oldestAt,
      resourceIds: [...entry.resourceIds],
      severity: entry.severity,
    })),
    newCount: digest.newCount,
    omittedKinds: digest.omittedKinds,
    openCount: digest.openCount,
  };
}

const SEVERITY_SV: Record<AlertDigestKind["severity"], string> = {
  critical: "kritisk",
  info: "info",
  warning: "varning",
};

/** "2026-09-27T08:15:00.000Z" → "2026-09-27 08:15 UTC". */
function digestTime(value: string): string {
  return `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`;
}

function renderAlertDigestEmail(job: AlertDigestEmailJob): AuthEmailMessage {
  const { digest } = job;
  const intro = `${digest.newCount} nya larm sedan förra sammanställningen, ${digest.openCount} öppna totalt.`;
  const lines = digest.kinds.map((entry) => ({
    head: `${entry.kind} (${SEVERITY_SV[entry.severity]}): ${entry.count} öppna, ${entry.newCount} nya, äldst ${digestTime(entry.oldestAt)}`,
    resources:
      entry.resourceIds.length === 0
        ? null
        : `Resurser: ${entry.resourceIds.join(", ")}${entry.count > entry.resourceIds.length ? " …" : ""}`,
  }));
  const omitted =
    digest.omittedKinds > 0 ? `Ytterligare ${digest.omittedKinds} larmtyper visas inte.` : null;
  const footer =
    "Larmen hanteras i plattformens admin. Sammanställningen innehåller inga belopp eller kunduppgifter.";

  const text = [
    intro,
    "",
    ...lines.flatMap((line) => (line.resources === null ? [line.head] : [line.head, `  ${line.resources}`])),
    ...(omitted === null ? [] : ["", omitted]),
    "",
    footer,
  ].join("\n");

  const html = [
    `<p>${escapeHtml(intro)}</p>`,
    `<ul>${lines
      .map(
        (line) =>
          `<li>${escapeHtml(line.head)}${line.resources === null ? "" : `<br>${escapeHtml(line.resources)}`}</li>`,
      )
      .join("")}</ul>`,
    ...(omitted === null ? [] : [`<p>${escapeHtml(omitted)}</p>`]),
    `<p>${escapeHtml(footer)}</p>`,
  ].join("");

  return {
    html,
    subject: `Plattformslarm: ${digest.newCount} nya, ${digest.openCount} öppna`,
    text,
  };
}
