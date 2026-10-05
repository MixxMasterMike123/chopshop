import type { AuthEmailMessage } from "./auth-email-job";

/**
 * The abandoned-checkout reminder (CP9-AC, migration 0056 kind
 * `checkout_reminder`): ONE mail to a buyer who reached the payment step and
 * left, sent only with the consent of src/legal/consent.ts
 * reminderConsentGiven.
 *
 * Built by the `email.checkout_reminder` outbox effect
 * (src/commerce/checkout-reminders.ts) and sent by the existing `-email`
 * consumer through the delivery ledger, like the order mails:
 * `parseAuthEmailJob`, `renderAuthEmail` and `fingerprintAuthEmailJob` hand a
 * job of this kind to this module. The consumer gives this kind, and only
 * this kind, the shop's name as the sender's display name, the shop's support
 * address as Reply-To and the two List-Unsubscribe headers (AC13, AC14).
 *
 * WHAT IT CARRIES: the shop's name, the recipient's name as the checkout froze
 * it (read live, never frozen in the job), the names and quantities of the
 * lines still buyable with their variant labels, the resume link and its last
 * valid day, the unsubscribe links, the shop's support address. NEVER a
 * price, a total, carriage, VAT, a discount or a code (AC8): they can be stale,
 * and the new checkout prices everything again. No image, no checkout id, no
 * intent, no order number.
 *
 * DETERMINISTIC: every field is supplied by the caller (none is minted here),
 * the delivery id is derived from the outbox dedupe key and the links from the
 * reminder id, so every retry builds the identical job. The fingerprint covers
 * everything rendered and every header derived from it.
 *
 * Its lifetime is 2 hours (REMINDER_JOB_LIFETIME_MS), not the frame's 24: a
 * reminder held through a long outage is dropped rather than arriving after
 * the buyer may have paid.
 *
 * Nothing here logs; the content holds the buyer's name and address.
 */

export const CHECKOUT_REMINDER_KIND = "checkout_reminder";

export const REMINDER_JOB_LIFETIME_MS = 2 * 60 * 60 * 1_000;
export const MAX_REMINDER_LINES = 50;
const MAX_TEXT_LENGTH = 200;
const MAX_URL_LENGTH = 500;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DELIVERY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
/** The shop segment the web Worker routes (cloudflare/web/src/shop-segment.ts). */
const SHOP_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A recovery link's token (src/commerce/checkout-recovery-token.ts, which
 * mints and verifies it): v1.<a v4 uuid>.<43 base64url characters: 32 bytes,
 * unpadded> — 83 characters. Here so this module imports nothing at runtime.
 */
export const RECOVERY_TOKEN_PATTERN =
  /^v1\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

/** One line still buyable when the mail was built: no price. */
export interface CheckoutReminderLine {
  /** The variant's label (product_variants.label), or null. */
  label: string | null;
  name: string;
  quantity: number;
}

export interface CheckoutReminderContent {
  items: CheckoutReminderLine[];
  /** The last Stockholm calendar day the resume link works through in full (YYYY-MM-DD). */
  linkValidUntil: string;
  /** `https://<web>/_api/<tenant>/v1/checkout-recovery/<unsubscribe token>/unsubscribe` (RFC 8058). */
  oneClickUnsubscribeUrl: string;
  /** The checkout recipient's name (checkout_recipients), read live, never frozen. */
  recipientName: string | null;
  /** `https://<web>/<tenant>/aterta/<resume token>` */
  resumeUrl: string;
  shopName: string | null;
  /** The shop's support address: shown, and the mail's Reply-To. */
  supportEmail: string | null;
  /** `https://<web>/<tenant>/avregistrera/<unsubscribe token>` */
  unsubscribeUrl: string;
}

export interface CheckoutReminderEmailJob {
  actionUrl: "";
  content: CheckoutReminderContent;
  createdAt: number;
  deliveryId: string;
  expiresAt: number;
  kind: typeof CHECKOUT_REMINDER_KIND;
  locale: "sv";
  /** Absent, as on every job that is not an order confirmation. */
  order?: undefined;
  recipient: string;
  tenantId: string;
  /** Absent, as on every job that is not an invite. */
  variant?: undefined;
  version: 1;
}

export function isCheckoutReminderEmailKind(value: unknown): value is typeof CHECKOUT_REMINDER_KIND {
  return value === CHECKOUT_REMINDER_KIND;
}

/** For the consumer's union: `if (isCheckoutReminderEmailJob(job)) …`. */
export function isCheckoutReminderEmailJob(job: { kind: string }): job is CheckoutReminderEmailJob {
  return isCheckoutReminderEmailKind(job.kind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max = MAX_TEXT_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !CONTROL.test(value);
}

function isOptionalText(value: unknown): value is string | null {
  return value === null || isText(value);
}

/** trim + lower case + the ledger's address shape; throws otherwise. */
export function normalizedReminderEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new Error("Invalid checkout reminder address");
  }
  return email;
}

function isOptionalEmail(value: unknown): value is string | null {
  if (value === null) {
    return true;
  }
  try {
    return typeof value === "string" && normalizedReminderEmail(value) === value;
  } catch {
    return false;
  }
}

function invalid(): never {
  throw new Error("Invalid checkout reminder content");
}

/**
 * A link of the mail: https, no credentials, no query, no fragment, the
 * job's own tenant as the shop segment, and exactly `path(token)` after it,
 * with a token of the recovery shape. Returns the token.
 */
function linkToken(value: unknown, tenantId: string, shape: RegExp): { origin: string; token: string } {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH || CONTROL.test(value)) {
    invalid();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid();
  }
  const match = shape.exec(url.pathname);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.href !== value ||
    match === null ||
    match[1] !== tenantId ||
    !RECOVERY_TOKEN_PATTERN.test(match[2] as string)
  ) {
    invalid();
  }
  return { origin: url.origin, token: match[2] as string };
}

const RESUME_PATH = /^\/([a-z0-9][a-z0-9-]{0,62})\/aterta\/([^/]+)$/;
const UNSUBSCRIBE_PAGE_PATH = /^\/([a-z0-9][a-z0-9-]{0,62})\/avregistrera\/([^/]+)$/;
const ONE_CLICK_PATH = /^\/_api\/([a-z0-9][a-z0-9-]{0,62})\/v1\/checkout-recovery\/([^/]+)\/unsubscribe$/;

function isCalendarDay(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = DATE_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const date = new Date(`${value}T12:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validatedContent(value: unknown, tenantId: string): CheckoutReminderContent {
  if (!isRecord(value) || !SHOP_SEGMENT_PATTERN.test(tenantId)) {
    invalid();
  }
  const items = value.items;
  if (
    !Array.isArray(items) ||
    items.length === 0 ||
    items.length > MAX_REMINDER_LINES ||
    !isCalendarDay(value.linkValidUntil) ||
    !isOptionalText(value.recipientName) ||
    !isOptionalText(value.shopName) ||
    !isOptionalEmail(value.supportEmail)
  ) {
    invalid();
  }
  const resume = linkToken(value.resumeUrl, tenantId, RESUME_PATH);
  const page = linkToken(value.unsubscribeUrl, tenantId, UNSUBSCRIBE_PAGE_PATH);
  const oneClick = linkToken(value.oneClickUnsubscribeUrl, tenantId, ONE_CLICK_PATH);
  // One host for the three; the two unsubscribe links carry one token; the
  // resume token is another purpose's, of the same reminder.
  if (
    resume.origin !== page.origin ||
    page.origin !== oneClick.origin ||
    page.token !== oneClick.token ||
    resume.token === page.token ||
    resume.token.slice(0, 40) !== page.token.slice(0, 40)
  ) {
    invalid();
  }
  const lines = (items as unknown[]).map((item): CheckoutReminderLine => {
    if (
      !isRecord(item) ||
      !isText(item.name) ||
      !isOptionalText(item.label) ||
      typeof item.quantity !== "number" ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 999
    ) {
      invalid();
    }
    return { label: item.label as string | null, name: item.name as string, quantity: item.quantity as number };
  });
  return {
    items: lines,
    linkValidUntil: value.linkValidUntil as string,
    oneClickUnsubscribeUrl: value.oneClickUnsubscribeUrl as string,
    recipientName: value.recipientName as string | null,
    resumeUrl: value.resumeUrl as string,
    shopName: value.shopName as string | null,
    supportEmail: value.supportEmail as string | null,
    unsubscribeUrl: value.unsubscribeUrl as string,
  };
}

function validatedFrame(input: Record<string, unknown>, now: number): Omit<CheckoutReminderEmailJob, "content"> {
  if (
    input.version !== 1 ||
    input.actionUrl !== "" ||
    !isCheckoutReminderEmailKind(input.kind) ||
    typeof input.deliveryId !== "string" ||
    !DELIVERY_ID_PATTERN.test(input.deliveryId) ||
    input.locale !== "sv" ||
    !Number.isSafeInteger(input.createdAt) ||
    !Number.isSafeInteger(input.expiresAt) ||
    (input.createdAt as number) > now + CLOCK_SKEW_MS ||
    (input.expiresAt as number) <= (input.createdAt as number) ||
    // This kind's own lifetime, shorter than the frame's 24 hours.
    (input.expiresAt as number) - (input.createdAt as number) > REMINDER_JOB_LIFETIME_MS ||
    typeof input.tenantId !== "string" ||
    input.tenantId.length === 0 ||
    typeof input.recipient !== "string"
  ) {
    throw new Error("Invalid checkout reminder job");
  }
  return {
    actionUrl: "",
    createdAt: input.createdAt as number,
    deliveryId: input.deliveryId,
    expiresAt: input.expiresAt as number,
    kind: CHECKOUT_REMINDER_KIND,
    locale: "sv",
    recipient: normalizedReminderEmail(input.recipient),
    tenantId: input.tenantId,
    version: 1,
  };
}

/**
 * Builds the job the effect hands to EMAIL_QUEUE. Every field comes from the
 * caller. Throws on anything the ledger or the template could not carry.
 */
export function createCheckoutReminderEmailJob(input: {
  content: CheckoutReminderContent;
  createdAt: number;
  deliveryId: string;
  expiresAt: number;
  recipient: string;
  tenantId: string;
}): CheckoutReminderEmailJob {
  const frame = validatedFrame({ ...input, actionUrl: "", kind: CHECKOUT_REMINDER_KIND, locale: "sv", version: 1 }, Date.now());
  return { ...frame, content: validatedContent(input.content, frame.tenantId) };
}

/** The consumer's parse of a queued job of this kind; throws on anything else. */
export function parseCheckoutReminderEmailJob(value: unknown): CheckoutReminderEmailJob {
  if (!isRecord(value)) {
    throw new Error("Invalid checkout reminder job");
  }
  const frame = validatedFrame(value, Date.now());
  return { ...frame, content: validatedContent(value.content, frame.tenantId) };
}

/** The content in a FIXED key order: all of it is rendered, so all of it is covered. */
export function canonicalCheckoutReminderContent(content: CheckoutReminderContent) {
  return {
    items: content.items.map((item) => ({ label: item.label, name: item.name, quantity: item.quantity })),
    linkValidUntil: content.linkValidUntil,
    oneClickUnsubscribeUrl: content.oneClickUnsubscribeUrl,
    recipientName: content.recipientName,
    resumeUrl: content.resumeUrl,
    shopName: content.shopName,
    supportEmail: content.supportEmail,
    unsubscribeUrl: content.unsubscribeUrl,
  };
}

function bytesToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The ledger fingerprint of a reminder job: the frame keys of
 * `fingerprintAuthEmailJob`, in its order, plus the content. The sender's
 * display name, the Reply-To and the List-Unsubscribe headers are derived
 * from the content (shopName, supportEmail, oneClickUnsubscribeUrl), so they
 * are covered with it. The wired `fingerprintAuthEmailJob` delegates here.
 */
export async function fingerprintCheckoutReminderEmailJob(job: CheckoutReminderEmailJob): Promise<string> {
  const canonical = JSON.stringify({
    actionUrl: job.actionUrl,
    createdAt: job.createdAt,
    deliveryId: job.deliveryId,
    expiresAt: job.expiresAt,
    kind: job.kind,
    locale: job.locale,
    recipient: job.recipient,
    tenantId: job.tenantId,
    version: job.version,
    content: canonicalCheckoutReminderContent(job.content),
  });
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
}

// ── the sender, the reply address and the headers (AC13, AC14) ──────────────

const MAX_DISPLAY_NAME_LENGTH = 100;
// Quotes, backslashes and angle brackets would break out of the quoted
// display name; control characters and the Unicode line separators would
// break the header.
const DISPLAY_NAME_FORBIDDEN = /["\\<>\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const FROM_ADDRESS = /<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>$/;

/** The shop's name as a display name: cleaned, bounded; null when nothing is left. */
export function reminderDisplayName(shopName: string | null): string | null {
  if (shopName === null) {
    return null;
  }
  const name = shopName.replace(DISPLAY_NAME_FORBIDDEN, " ").replace(/\s+/g, " ").trim().slice(0, MAX_DISPLAY_NAME_LENGTH).trim();
  return name === "" ? null : name;
}

/**
 * The From of a reminder: `"<shop>" <the address of EMAIL_FROM>`, or EMAIL_FROM
 * as it is when the shop has no name. `configuredFrom` is the consumer's
 * validated sender (a bare address or `Name <address>`).
 */
export function checkoutReminderFrom(configuredFrom: string, shopName: string | null): string {
  const name = reminderDisplayName(shopName);
  if (name === null) {
    return configuredFrom;
  }
  const address = FROM_ADDRESS.exec(configuredFrom)?.[1] ?? configuredFrom;
  return `"${name}" <${address}>`;
}

/** RFC 2369 + RFC 8058: the one-click target is the API route, which acts on POST. */
export function checkoutReminderHeaders(job: CheckoutReminderEmailJob): Record<string, string> {
  return {
    "List-Unsubscribe": `<${job.content.oneClickUnsubscribeUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

// ── the last full day of the link ───────────────────────────────────────────

const STOCKHOLM_DAY = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Europe/Stockholm",
  year: "numeric",
});

/**
 * The last Stockholm calendar day the link works through in full: the day of
 * `linkExpiresAt − 25 h` (a day is at most 25 hours long, at the autumn
 * clock change). "Gäller till och med <day>" is then always true; the day of
 * the expiry itself would promise a day on which the link stops at, say, 14:23.
 */
export function linkValidUntilOf(linkExpiresAt: number): string {
  const parts = Object.fromEntries(
    STOCKHOLM_DAY.formatToParts(new Date(linkExpiresAt - 25 * 60 * 60 * 1_000)).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const MONTHS_SV = [
  "januari", "februari", "mars", "april", "maj", "juni",
  "juli", "augusti", "september", "oktober", "november", "december",
];

/** "2026-10-12" → "12 oktober 2026". */
export function swedishDate(day: string): string {
  const match = DATE_PATTERN.exec(day);
  if (match === null) {
    return day;
  }
  return `${Number(match[3])} ${MONTHS_SV[Number(match[2]) - 1] ?? ""} ${match[1]}`;
}

// ── the Swedish template ────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function lineText(line: CheckoutReminderLine): string {
  return `${line.quantity} st ${line.name}${line.label === null ? "" : ` (${line.label})`}`;
}

/** The Swedish mail of a reminder job: text + HTML, every value HTML-escaped. */
export function renderCheckoutReminderEmail(job: CheckoutReminderEmailJob): AuthEmailMessage {
  const c = job.content;
  const shop = c.shopName ?? "butiken";
  const title = "Din varukorg väntar";
  const greeting = c.recipientName === null ? "Hej," : `Hej ${c.recipientName},`;
  const intro = `Du påbörjade ett köp hos ${shop} men slutförde det inte. Vi har sparat varorna åt dig:`;
  const lines = c.items.map(lineText);
  const action = "Slutför köpet";
  const validity = `Länken gäller till och med ${swedishDate(c.linkValidUntil)}. Priser och frakt visas i kassan.`;
  const why = `Du får det här mejlet eftersom du gav ${shop} lov att mejla dig när du handlade.`;
  const once = "Det här är den enda påminnelsen om det här köpet.";
  const optOut = `Vill du inte få fler påminnelser från ${shop}?`;
  const contact =
    c.supportEmail === null ? "Har du frågor? Kontakta butiken." : `Har du frågor? Kontakta ${shop} på ${c.supportEmail}.`;

  const text = [
    title,
    "",
    greeting,
    "",
    intro,
    ...lines.map((line) => `- ${line}`),
    "",
    `${action}: ${c.resumeUrl}`,
    validity,
    "",
    why,
    once,
    `${optOut} Avregistrera dig: ${c.unsubscribeUrl}`,
    contact,
  ].join("\n");

  const html = [
    `<p><strong>${escapeHtml(title)}</strong></p>`,
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(intro)}</p>`,
    `<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`,
    `<p><a href="${escapeHtml(c.resumeUrl)}">${escapeHtml(action)}</a></p>`,
    `<p>${escapeHtml(validity)}</p>`,
    `<p>${escapeHtml(why)}<br>${escapeHtml(once)}<br>${escapeHtml(optOut)} <a href="${escapeHtml(c.unsubscribeUrl)}">Avregistrera dig från påminnelser</a><br>${escapeHtml(contact)}</p>`,
  ].join("");

  return {
    html,
    subject: c.shopName === null ? "Du glömde något i kassan" : `Du glömde något i kassan hos ${c.shopName}`,
    text,
  };
}

// ── the suppression (one row per shop and address, 0056) ────────────────────

/**
 * Has `emailHash` unsubscribed from `tenantId`'s reminders? The cron step's
 * check 7, the effect's re-check, and the consumer's last word before a
 * held reminder leaves.
 */
export async function isReminderSuppressed(db: D1Database, tenantId: string, emailHash: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM checkout_reminder_suppressions
       WHERE tenant_id = ? AND email_hash = ?
       LIMIT 1`,
    )
    .bind(tenantId, emailHash)
    .first<{ hit: number }>();
  return row !== null;
}
