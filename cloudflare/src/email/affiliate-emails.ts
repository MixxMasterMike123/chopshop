import type { AffiliateEmailKind } from "../affiliate/mail";
import { AFFILIATE_EMAIL_KINDS, isAffiliateEmailKind } from "../affiliate/mail";
import type { AuthEmailMessage } from "./auth-email-job";

/**
 * CP13 — the affiliate mails (design §9, A11; migration 0058's kinds):
 *
 *   affiliate_application_received  applicant   the apply batch
 *   affiliate_application_notice    the shop    the apply batch
 *   affiliate_application_denied    applicant   the deny batch
 *   affiliate_welcome               affiliate   approval/invite of a person who
 *                                               already has a password (no link)
 *   affiliate_conversion            affiliate   the order batch (beside the accrual)
 *   affiliate_reversal              affiliate   the refund / dispute batch
 *   affiliate_payout                affiliate   paid / void
 *   affiliate_payout_requested      the shop    the request batch
 *
 * Built by the outbox `email` effect (src/outbox/email-effect.ts, the
 * affiliate branch) and sent by the `-email` consumer through the delivery
 * ledger like the order mails: parseAuthEmailJob, renderAuthEmail and
 * fingerprintAuthEmailJob hand a job of these kinds here.
 *
 * SENDER (CX-B8, R2-14/15): every mail to an affiliate or an applicant goes
 * out under the SHOP's display name with the shop's support address as
 * Reply-To (email-queue-consumer.ts shopSenderName reads `shopName` from the
 * job's own content — FROZEN at the first build, never a tenant id read at
 * send time). The two mails TO the shop keep the configured sender.
 *
 * DETERMINISTIC: every field comes from the caller, the delivery id is
 * derived from the outbox dedupe key, and what is live (the shop's name and
 * support address, the shop's notice address, the addresses built from the
 * canonical origins) is frozen at the first build — so every retry builds the
 * identical job. The fingerprint covers everything rendered.
 *
 * COPY: minimal and correct here; unit A4 writes the final Swedish/English
 * words (CP13_BRIEFS.md). TEXT, NEVER HTML: every value is escaped in the HTML
 * part. Nothing here logs.
 */

export { AFFILIATE_EMAIL_KINDS, isAffiliateEmailKind };
export type { AffiliateEmailKind };

const SHOP_FACING: ReadonlySet<AffiliateEmailKind> = new Set(["affiliate_application_notice", "affiliate_payout_requested"]);

/** The kinds sent TO the shop (configured sender, no Reply-To). */
export function isShopFacingAffiliateKind(kind: AffiliateEmailKind): boolean {
  return SHOP_FACING.has(kind);
}

// ── the content of each kind ────────────────────────────────────────────────

type FieldType = "bp" | "email?" | "enum" | "iso" | "minor" | "text" | "text?" | "url" | "url?";

interface FieldSpec {
  max?: number;
  type: FieldType;
  values?: readonly string[];
}

/** Every kind's fields, in the FIXED order the fingerprint uses. */
const CONTENT: Record<AffiliateEmailKind, Record<string, FieldSpec>> = {
  // The two mails TO the applicant carry nothing the applicant typed (A1
  // round 1: the form must not relay free text to an address it names); the
  // shop's notice keeps the name.
  affiliate_application_denied: {
    reason: { max: 500, type: "text" },
    shopName: { max: 200, type: "text?" },
    supportEmail: { type: "email?" },
  },
  affiliate_application_notice: {
    adminUrl: { type: "url?" },
    applicantEmail: { type: "email?" },
    applicantName: { max: 100, type: "text" },
    promotionMethod: { max: 20, type: "text" },
    shopName: { max: 200, type: "text?" },
  },
  affiliate_application_received: {
    shopName: { max: 200, type: "text?" },
    supportEmail: { type: "email?" },
  },
  affiliate_conversion: {
    availableAt: { type: "iso" },
    commissionMinor: { type: "minor" },
    currency: { max: 3, type: "text" },
    orderNumber: { max: 64, type: "text" },
    shopName: { max: 200, type: "text?" },
    supportEmail: { type: "email?" },
  },
  affiliate_payout: {
    amountMinor: { type: "minor" },
    currency: { max: 3, type: "text" },
    outcome: { type: "enum", values: ["paid", "void"] },
    reason: { max: 500, type: "text?" },
    reference: { max: 100, type: "text?" },
    shopName: { max: 200, type: "text?" },
    supportEmail: { type: "email?" },
  },
  affiliate_payout_requested: {
    adminUrl: { type: "url?" },
    affiliateName: { max: 100, type: "text" },
    amountMinor: { type: "minor" },
    currency: { max: 3, type: "text" },
    shopName: { max: 200, type: "text?" },
  },
  affiliate_reversal: {
    amountMinor: { type: "minor" },
    cause: { type: "enum", values: ["dispute", "refund"] },
    currency: { max: 3, type: "text" },
    direction: { type: "enum", values: ["restored", "reversed"] },
    orderNumber: { max: 64, type: "text" },
    shopName: { max: 200, type: "text?" },
    supportEmail: { type: "email?" },
  },
  affiliate_welcome: {
    affiliateName: { max: 100, type: "text" },
    code: { max: 20, type: "text" },
    commissionBp: { type: "bp" },
    discountBp: { type: "bp" },
    portalUrl: { type: "url" },
    refLink: { type: "url" },
    shopName: { max: 200, type: "text?" },
    supportEmail: { type: "email?" },
  },
};

export type AffiliateEmailContent = Record<string, number | string | null>;

export interface AffiliateEmailJob {
  actionUrl: "";
  content: AffiliateEmailContent;
  createdAt: number;
  deliveryId: string;
  expiresAt: number;
  kind: AffiliateEmailKind;
  locale: "en" | "sv";
  /** Absent, as on every job that is not an order confirmation. */
  order?: undefined;
  recipient: string;
  tenantId: string;
  /** Absent, as on every job that is not an invite. */
  variant?: undefined;
  version: 1;
}

/** For the consumer's union: `if (isAffiliateEmailJob(job)) …`. */
export function isAffiliateEmailJob(job: { kind: string }): job is AffiliateEmailJob {
  return isAffiliateEmailKind(job.kind);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DELIVERY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_JOB_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;

function invalid(): never {
  throw new Error("Invalid affiliate email job");
}

function normalizedEmail(value: unknown): string {
  if (typeof value !== "string") {
    invalid();
  }
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    invalid();
  }
  return email;
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !CONTROL.test(value);
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 500 || CONTROL.test(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === "" && url.href === value;
  } catch {
    return false;
  }
}

function validField(spec: FieldSpec, value: unknown): boolean {
  switch (spec.type) {
    case "text":
      return isText(value, spec.max ?? 200);
    case "text?":
      return value === null || isText(value, spec.max ?? 200);
    case "email?":
      if (value === null) {
        return true;
      }
      try {
        return normalizedEmail(value) === value;
      } catch {
        return false;
      }
    case "minor":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    case "bp":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 10_000;
    case "iso":
      return typeof value === "string" && ISO.test(value);
    case "url":
      return isHttpsUrl(value);
    case "url?":
      return value === null || isHttpsUrl(value);
    case "enum":
      return typeof value === "string" && (spec.values ?? []).includes(value);
  }
}

/** The content of `kind`, validated, in the fixed key order; throws otherwise. */
function validatedContent(kind: AffiliateEmailKind, value: unknown): AffiliateEmailContent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid();
  }
  const record = value as Record<string, unknown>;
  const spec = CONTENT[kind];
  if (Object.keys(record).length !== Object.keys(spec).length) {
    invalid();
  }
  const out: AffiliateEmailContent = {};
  for (const [field, fieldSpec] of Object.entries(spec)) {
    if (!(field in record) || !validField(fieldSpec, record[field])) {
      invalid();
    }
    out[field] = record[field] as number | string | null;
  }
  return out;
}

function assemble(input: Record<string, unknown>): AffiliateEmailJob {
  const now = Date.now();
  if (
    input.version !== 1 ||
    input.actionUrl !== "" ||
    !isAffiliateEmailKind(input.kind) ||
    typeof input.deliveryId !== "string" ||
    !DELIVERY_ID_PATTERN.test(input.deliveryId) ||
    (input.locale !== "sv" && input.locale !== "en") ||
    !Number.isSafeInteger(input.createdAt) ||
    !Number.isSafeInteger(input.expiresAt) ||
    (input.createdAt as number) > now + CLOCK_SKEW_MS ||
    (input.expiresAt as number) <= (input.createdAt as number) ||
    (input.expiresAt as number) - (input.createdAt as number) > MAX_JOB_LIFETIME_MS ||
    typeof input.tenantId !== "string" ||
    input.tenantId.length === 0 ||
    // The shop reads its own mails in Swedish (as its order notices).
    (SHOP_FACING.has(input.kind) && input.locale !== "sv")
  ) {
    invalid();
  }
  return {
    actionUrl: "",
    content: validatedContent(input.kind, input.content),
    createdAt: input.createdAt as number,
    deliveryId: input.deliveryId,
    expiresAt: input.expiresAt as number,
    kind: input.kind,
    locale: input.locale,
    recipient: normalizedEmail(input.recipient),
    tenantId: input.tenantId,
    version: 1,
  };
}

/** Builds the job an effect hands to EMAIL_QUEUE. Every field comes from the caller. */
export function createAffiliateEmailJob(input: {
  content: AffiliateEmailContent;
  createdAt: number;
  deliveryId: string;
  expiresAt: number;
  kind: AffiliateEmailKind;
  locale: "en" | "sv";
  recipient: string;
  tenantId: string;
}): AffiliateEmailJob {
  return assemble({ ...input, actionUrl: "", version: 1 });
}

/** The consumer's parse of a queued job of these kinds; throws on anything else. */
export function parseAffiliateEmailJob(value: unknown): AffiliateEmailJob {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid();
  }
  return assemble(value as Record<string, unknown>);
}

function bytesToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The ledger fingerprint: the frame keys of `fingerprintAuthEmailJob`, in its
 * order, plus the content in its fixed order (validatedContent built it so).
 */
export async function fingerprintAffiliateEmailJob(job: AffiliateEmailJob): Promise<string> {
  const content: Record<string, unknown> = {};
  for (const field of Object.keys(CONTENT[job.kind])) {
    content[field] = job.content[field] ?? null;
  }
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
    content,
  });
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
}

/** The display name of the sender: the shop's, for every mail not sent TO the shop. */
export function affiliateSenderName(job: AffiliateEmailJob): string | null {
  return SHOP_FACING.has(job.kind) ? null : (job.content.shopName as string | null);
}

/** Reply-To: the shop's support address, for every mail not sent TO the shop. */
export function affiliateReplyTo(job: AffiliateEmailJob): string | null {
  return SHOP_FACING.has(job.kind) ? null : ((job.content.supportEmail as string | null | undefined) ?? null);
}

// ── the templates ───────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function money(minor: number, currency: string, locale: "en" | "sv"): string {
  return new Intl.NumberFormat(locale === "sv" ? "sv-SE" : "en-GB", { currency, style: "currency" }).format(minor / 100);
}

function percent(bp: number, locale: "en" | "sv"): string {
  const whole = Math.trunc(bp / 100);
  const rest = bp % 100;
  return rest === 0 ? String(whole) : `${whole}${locale === "sv" ? "," : "."}${String(rest).padStart(2, "0").replace(/0$/, "")}`;
}

interface Copy {
  lines: string[];
  link: { href: string; label: string } | null;
  subject: string;
}

function contact(shop: string, supportEmail: string | null, locale: "en" | "sv"): string[] {
  if (supportEmail === null) {
    return [];
  }
  return [locale === "sv" ? `Frågor? Kontakta ${shop} på ${supportEmail}.` : `Questions? Contact ${shop} at ${supportEmail}.`];
}

function copyOf(job: AffiliateEmailJob): Copy {
  const c = job.content;
  const sv = job.locale === "sv";
  const shop = (c.shopName as string | null) ?? (sv ? "butiken" : "the shop");
  const support = (c.supportEmail as string | null | undefined) ?? null;
  switch (job.kind) {
    case "affiliate_application_received":
      return {
        lines: sv
          ? ["Hej!", `Tack för din ansökan till ${shop}s affiliateprogram.`, "Vi hör av oss inom 1–3 arbetsdagar.", ...contact(shop, support, "sv")]
          : ["Hi!", `Thank you for applying to the affiliate programme of ${shop}.`, "We will get back to you within 1–3 working days.", ...contact(shop, support, "en")],
        link: null,
        subject: sv ? `Tack för din ansökan till ${shop}s affiliateprogram` : `Thank you for applying to ${shop}`,
      };
    case "affiliate_application_notice":
      return {
        lines: [
          `Ny affiliate-ansökan: ${c.applicantName}`,
          ...(c.applicantEmail === null ? [] : [`E-post: ${c.applicantEmail}`]),
          `Kanal: ${c.promotionMethod}`,
          c.adminUrl === null ? "Granska ansökan under Affiliate i butikens admin." : "Granska ansökan i butikens admin.",
        ],
        link: c.adminUrl === null ? null : { href: c.adminUrl as string, label: "Granska ansökan" },
        subject: `Ny affiliate-ansökan: ${c.applicantName}`,
      };
    case "affiliate_application_denied":
      return {
        lines: sv
          ? ["Hej!", `Din ansökan till ${shop}s affiliateprogram har inte godkänts.`, `Orsak: ${c.reason}`, ...contact(shop, support, "sv")]
          : ["Hi!", `Your application to the affiliate programme of ${shop} was not approved.`, `Reason: ${c.reason}`, ...contact(shop, support, "en")],
        link: null,
        subject: sv ? `Din ansökan till ${shop}` : `Your application to ${shop}`,
      };
    case "affiliate_welcome":
      return {
        lines: sv
          ? [
              `Hej ${c.affiliateName},`,
              `Du har lagts till som affiliate hos ${shop}.`,
              `Din kod: ${c.code}`,
              `Din länk: ${c.refLink}`,
              `Kundrabatt ${percent(c.discountBp as number, "sv")} % · Din provision ${percent(c.commissionBp as number, "sv")} % av nettovärdet (exkl. moms och frakt).`,
              "Logga in i affiliateportalen med ditt vanliga lösenord.",
              ...contact(shop, support, "sv"),
            ]
          : [
              `Hi ${c.affiliateName},`,
              `You have been added as an affiliate of ${shop}.`,
              `Your code: ${c.code}`,
              `Your link: ${c.refLink}`,
              `Customer discount ${percent(c.discountBp as number, "en")} % · Your commission ${percent(c.commissionBp as number, "en")} % of the net value (excl. VAT and shipping).`,
              "Sign in to the affiliate portal with your usual password.",
              ...contact(shop, support, "en"),
            ],
        link: { href: c.portalUrl as string, label: sv ? "Öppna portalen" : "Open the portal" },
        subject: sv ? `Du har lagts till som affiliate hos ${shop}` : `You are now an affiliate of ${shop}`,
      };
    case "affiliate_conversion": {
      const amount = money(c.commissionMinor as number, c.currency as string, job.locale);
      const day = (c.availableAt as string).slice(0, 10);
      return {
        lines: sv
          ? [`Ny provision: ${amount}`, `Order: ${c.orderNumber}`, `Provisionen kan betalas ut efter ångerfristen (14 dagar), från ${day}.`, ...contact(shop, support, "sv")]
          : [`New commission: ${amount}`, `Order: ${c.orderNumber}`, `It can be paid out after the 14-day withdrawal period, from ${day}.`, ...contact(shop, support, "en")],
        link: null,
        subject: sv ? `Ny provision: ${amount}` : `New commission: ${amount}`,
      };
    }
    case "affiliate_reversal": {
      const amount = money(c.amountMinor as number, c.currency as string, job.locale);
      const restored = c.direction === "restored";
      const why = sv
        ? c.cause === "dispute" ? "Köpet bestreds och betalningen gick tillbaka." : "Ordern har återbetalats helt eller delvis; provisionen justeras i proportion till återbetalningen."
        : c.cause === "dispute" ? "The purchase was disputed and the payment returned." : "The order was refunded in full or in part; the commission follows the refund.";
      return {
        lines: sv
          ? [restored ? `Provision återställd: +${amount}` : `Provision justerad: −${amount}`, `Order: ${c.orderNumber}`, restored ? "En återbetalning gick inte igenom, så provisionen gäller igen." : why, ...contact(shop, support, "sv")]
          : [restored ? `Commission restored: +${amount}` : `Commission adjusted: −${amount}`, `Order: ${c.orderNumber}`, restored ? "A refund did not go through, so the commission stands again." : why, ...contact(shop, support, "en")],
        link: null,
        subject: sv
          ? restored ? `Provision återställd: +${amount}` : `Provision justerad: −${amount}`
          : restored ? `Commission restored: +${amount}` : `Commission adjusted: −${amount}`,
      };
    }
    case "affiliate_payout": {
      const amount = money(c.amountMinor as number, c.currency as string, job.locale);
      const paid = c.outcome === "paid";
      return {
        lines: sv
          ? paid
            ? [`Utbetalning registrerad: ${amount}`, ...(c.reference === null ? [] : [`Referens: ${c.reference}`]), ...contact(shop, support, "sv")]
            : [`Begäran avvisad: ${amount}`, ...(c.reason === null ? [] : [`Orsak: ${c.reason}`]), "Beloppet finns kvar i ditt saldo.", ...contact(shop, support, "sv")]
          : paid
            ? [`Payout recorded: ${amount}`, ...(c.reference === null ? [] : [`Reference: ${c.reference}`]), ...contact(shop, support, "en")]
            : [`Request declined: ${amount}`, ...(c.reason === null ? [] : [`Reason: ${c.reason}`]), "The amount stays in your balance.", ...contact(shop, support, "en")],
        link: null,
        subject: sv ? (paid ? `Utbetalning registrerad: ${amount}` : "Begäran om utbetalning avvisad") : paid ? `Payout recorded: ${amount}` : "Payout request declined",
      };
    }
    case "affiliate_payout_requested": {
      const amount = money(c.amountMinor as number, c.currency as string, "sv");
      return {
        lines: [`${c.affiliateName} begär utbetalning: ${amount}`, c.adminUrl === null ? "Hantera begäran under Affiliate i butikens admin." : "Hantera begäran i butikens admin."],
        link: c.adminUrl === null ? null : { href: c.adminUrl as string, label: "Hantera utbetalning" },
        subject: `${c.affiliateName} begär utbetalning: ${amount}`,
      };
    }
  }
}

/** The mail of an affiliate job: text + HTML, every value HTML-escaped. */
export function renderAffiliateEmail(job: AffiliateEmailJob): AuthEmailMessage {
  const copy = copyOf(job);
  const text = [...copy.lines, ...(copy.link === null ? [] : ["", `${copy.link.label}: ${copy.link.href}`])].join("\n");
  const html = [
    ...copy.lines.map((line) => `<p>${escapeHtml(line)}</p>`),
    ...(copy.link === null ? [] : [`<p><a href="${escapeHtml(copy.link.href)}">${escapeHtml(copy.link.label)}</a></p>`]),
  ].join("");
  return { html, subject: copy.subject, text };
}
