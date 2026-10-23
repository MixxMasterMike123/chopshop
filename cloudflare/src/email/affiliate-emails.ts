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
 * COPY: unit A4's final Swedish/English words (CP13_BRIEFS.md, design §9);
 * the shapes, the fingerprint and the "nothing the applicant typed goes back
 * to the applicant" rule are A1's and unchanged. TEXT, NEVER HTML: every
 * value is escaped in the HTML part. Nothing here logs.
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

/**
 * The shop's name in the Swedish genitive (Språkrådet's rules), trimmed:
 *   - ends in s, x or z                      → unchanged ("Lars", "Max")
 *   - ends in a digit, a non-letter, or its
 *     last word is an all-caps abbreviation  → colon genitive ("Meteor PR AB:s", "Shop24:s")
 *   - otherwise                              → + s ("Kents")
 * Null or blank → "butikens".
 */
export function swedishGenitive(shopName: string | null): string {
  const name = shopName?.trim() ?? "";
  if (name === "") {
    return "butikens";
  }
  const lastWord = name.split(/\s+/).pop() ?? name;
  if (!/\p{L}$/u.test(name) || (lastWord.length >= 2 && /^\p{Lu}+$/u.test(lastWord))) {
    return `${name}:s`;
  }
  return /[sxz]$/i.test(name) ? name : `${name}s`;
}

/** An instant as the Swedish calendar day it falls on (Europe/Stockholm): "2026-11-05". */
export function stockholmDay(isoInstant: string): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Stockholm",
    year: "numeric",
  }).formatToParts(new Date(isoInstant));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** The applicant's chosen channel, in the shop's words (the notice is Swedish). */
const PROMOTION_LABELS: Readonly<Record<string, string>> = {
  blog: "Blogg",
  facebook: "Facebook",
  forum: "Forum",
  instagram: "Instagram",
  other: "Annat",
  tiktok: "TikTok",
  youtube: "YouTube",
};

/** The closing lines of a mail sent under the shop's name: the contact, then the shop. */
function closing(shopName: string | null, supportEmail: string | null, locale: "en" | "sv"): string[] {
  const sv = locale === "sv";
  const shop = shopName ?? (sv ? "butiken" : "the shop");
  return [
    ...(supportEmail === null
      ? []
      : [sv ? `Har du frågor? Svara på det här mejlet eller skriv till ${supportEmail}.` : `Questions? Reply to this email or write to ${supportEmail}.`]),
    ...(shopName === null ? [] : [sv ? `Hälsningar, ${shop}` : `Best regards, ${shop}`]),
  ];
}

/**
 * Every kind's words (design §9; A4's final copy). The two mails TO the
 * applicant carry nothing the applicant typed (A1 round 1): the received mail
 * is the shop's words only, the denial adds the SHOP's reason. The two mails
 * TO the shop are Swedish only (assemble refuses another locale).
 */
function copyOf(job: AffiliateEmailJob): Copy {
  const c = job.content;
  const sv = job.locale === "sv";
  const shopName = (c.shopName as string | null) ?? null;
  const shop = shopName ?? (sv ? "butiken" : "the shop");
  const support = (c.supportEmail as string | null | undefined) ?? null;
  switch (job.kind) {
    case "affiliate_application_received":
      return sv
        ? {
            lines: [
              "Hej!",
              `Tack för din ansökan till ${swedishGenitive(shopName)} affiliateprogram. Vi har tagit emot den.`,
              "Ansökan gås igenom inom 1–3 arbetsdagar. Blir den godkänd får du ett nytt mejl med din kod, din länk och hur du loggar in i affiliateportalen.",
              "Har du inte skickat någon ansökan kan du bortse från det här mejlet.",
              ...closing(shopName, support, "sv"),
            ],
            link: null,
            subject: `Tack för din ansökan till ${swedishGenitive(shopName)} affiliateprogram`,
          }
        : {
            lines: [
              "Hi!",
              `Thank you for applying to the affiliate programme of ${shop}. We have received your application.`,
              "It will be reviewed within 1–3 working days. If it is approved, you will get another email with your code, your link and how to sign in to the affiliate portal.",
              "If you did not apply, you can ignore this email.",
              ...closing(shopName, support, "en"),
            ],
            link: null,
            subject: `Thank you for applying to the affiliate programme of ${shop}`,
          };
    case "affiliate_application_notice":
      return {
        lines: [
          `${c.applicantName} har ansökt om att bli affiliate hos ${shop}.`,
          ...(c.applicantEmail === null ? [] : [`E-post: ${c.applicantEmail}`]),
          `Kanal: ${PROMOTION_LABELS[c.promotionMethod as string] ?? (c.promotionMethod as string)}`,
          "Godkänn eller avslå ansökan i butikens admin. Den sökande har fått ett mejl om att ansökan är mottagen.",
          ...(c.adminUrl === null ? ["Du hittar den under Affiliate → Ansökningar."] : []),
        ],
        link: c.adminUrl === null ? null : { href: c.adminUrl as string, label: "Öppna ansökan" },
        subject: `Ny affiliate-ansökan: ${c.applicantName}`,
      };
    case "affiliate_application_denied":
      return sv
        ? {
            lines: [
              "Hej!",
              `Tack för ditt intresse för ${swedishGenitive(shopName)} affiliateprogram. Vi har gått igenom din ansökan och kan tyvärr inte godkänna den den här gången.`,
              `Motivering: ${c.reason}`,
              ...closing(shopName, support, "sv"),
            ],
            link: null,
            subject: `Din ansökan till ${swedishGenitive(shopName)} affiliateprogram`,
          }
        : {
            lines: [
              "Hi!",
              `Thank you for your interest in the affiliate programme of ${shop}. We have reviewed your application and cannot approve it this time.`,
              `Reason: ${c.reason}`,
              ...closing(shopName, support, "en"),
            ],
            link: null,
            subject: `Your application to the affiliate programme of ${shop}`,
          };
    case "affiliate_welcome": {
      const discount = percent(c.discountBp as number, job.locale);
      const commission = percent(c.commissionBp as number, job.locale);
      return sv
        ? {
            lines: [
              `Hej ${c.affiliateName}!`,
              `Du har lagts till som affiliate hos ${shop}. Du loggar in i affiliateportalen med samma e-postadress och lösenord som du redan använder.`,
              `Din kod: ${c.code}`,
              `Din länk: ${c.refLink}`,
              `Köpare som använder din kod eller länk får ${discount} % rabatt på varorna. Du får ${commission} % provision på orderns varuvärde efter rabatt, exklusive moms och frakt.`,
              "Märk alltid dina inlägg, videor och länkar som reklam eller annons.",
              ...closing(shopName, support, "sv"),
            ],
            link: { href: c.portalUrl as string, label: "Öppna affiliateportalen" },
            subject: `Du har lagts till som affiliate hos ${shop}`,
          }
        : {
            lines: [
              `Hi ${c.affiliateName}!`,
              `You have been added as an affiliate of ${shop}. Sign in to the affiliate portal with the email address and password you already use.`,
              `Your code: ${c.code}`,
              `Your link: ${c.refLink}`,
              `Buyers who use your code or link get ${discount} % off the goods. You earn ${commission} % commission on the order's goods value after the discount, excluding VAT and shipping.`,
              "Always mark your posts, videos and links as advertising.",
              ...closing(shopName, support, "en"),
            ],
            link: { href: c.portalUrl as string, label: "Open the affiliate portal" },
            subject: `You have been added as an affiliate of ${shop}`,
          };
    }
    case "affiliate_conversion": {
      const amount = money(c.commissionMinor as number, c.currency as string, job.locale);
      // The Swedish calendar day (a 22:00–23:59 UTC instant is the next day here).
      const day = stockholmDay(c.availableAt as string);
      return sv
        ? {
            lines: [
              `Ny provision: ${amount}`,
              `Någon har handlat hos ${shop} med din kod eller länk (order ${c.orderNumber}).`,
              `Provisionen kan betalas ut efter ångerfristen (14 dagar), tidigast ${day}. Återbetalas ordern justeras provisionen.`,
              ...closing(shopName, support, "sv"),
            ],
            link: null,
            subject: `Ny provision: ${amount}`,
          }
        : {
            lines: [
              `New commission: ${amount}`,
              `Someone bought from ${shop} with your code or link (order ${c.orderNumber}).`,
              `The commission can be paid out after the 14-day withdrawal period, from ${day} at the earliest. If the order is refunded, the commission is adjusted.`,
              ...closing(shopName, support, "en"),
            ],
            link: null,
            subject: `New commission: ${amount}`,
          };
    }
    case "affiliate_reversal": {
      const amount = money(c.amountMinor as number, c.currency as string, job.locale);
      const restored = c.direction === "restored";
      const dispute = c.cause === "dispute";
      if (sv) {
        const subject = restored ? `Provision återställd: +${amount}` : `Provision justerad: −${amount}`;
        return {
          lines: [
            subject,
            `Order: ${c.orderNumber}`,
            restored
              ? "En återbetalning av ordern gick inte igenom, så provisionen gäller igen."
              : dispute
                ? "Köparen bestred betalningen och butiken förlorade tvisten, så hela provisionen för ordern har återförts."
                : "Ordern har återbetalats helt eller delvis, så provisionen har minskat i samma proportion.",
            ...closing(shopName, support, "sv"),
          ],
          link: null,
          subject,
        };
      }
      const subject = restored ? `Commission restored: +${amount}` : `Commission adjusted: −${amount}`;
      return {
        lines: [
          subject,
          `Order: ${c.orderNumber}`,
          restored
            ? "A refund of the order did not go through, so the commission stands again."
            : dispute
              ? "The buyer disputed the payment and the shop lost the dispute, so the whole commission for the order has been reversed."
              : "The order was refunded in full or in part, so the commission has been reduced in the same proportion.",
          ...closing(shopName, support, "en"),
        ],
        link: null,
        subject,
      };
    }
    case "affiliate_payout": {
      const amount = money(c.amountMinor as number, c.currency as string, job.locale);
      const paid = c.outcome === "paid";
      if (sv) {
        return paid
          ? {
              lines: [
                `Utbetalning registrerad: ${amount}`,
                `${shop} har registrerat utbetalningen av din provision.`,
                ...(c.reference === null ? [] : [`Referens: ${c.reference}`]),
                "Du ser alla utbetalningar i affiliateportalen.",
                ...closing(shopName, support, "sv"),
              ],
              link: null,
              subject: `Utbetalning registrerad: ${amount}`,
            }
          : {
              lines: [
                `Din begäran om utbetalning av ${amount} har avvisats.`,
                ...(c.reason === null ? [] : [`Orsak: ${c.reason}`]),
                "Beloppet finns kvar i ditt saldo och du kan göra en ny begäran i affiliateportalen.",
                ...closing(shopName, support, "sv"),
              ],
              link: null,
              subject: "Begäran om utbetalning avvisad",
            };
      }
      return paid
        ? {
            lines: [
              `Payout recorded: ${amount}`,
              `${shop} has recorded the payout of your commission.`,
              ...(c.reference === null ? [] : [`Reference: ${c.reference}`]),
              "You can see every payout in the affiliate portal.",
              ...closing(shopName, support, "en"),
            ],
            link: null,
            subject: `Payout recorded: ${amount}`,
          }
        : {
            lines: [
              `Your payout request of ${amount} was declined.`,
              ...(c.reason === null ? [] : [`Reason: ${c.reason}`]),
              "The amount stays in your balance, and you can make a new request in the affiliate portal.",
              ...closing(shopName, support, "en"),
            ],
            link: null,
            subject: "Payout request declined",
          };
    }
    case "affiliate_payout_requested": {
      const amount = money(c.amountMinor as number, c.currency as string, "sv");
      return {
        lines: [
          `${c.affiliateName} begär utbetalning av ${amount} i provision.`,
          "Betala ut beloppet (t.ex. via bank eller Swish) och markera sedan begäran som betald i butikens admin. Avvisar du begäran går beloppet tillbaka till affiliatens saldo.",
          ...(c.adminUrl === null ? ["Du hittar begäran under Affiliate → affiliatens sida → Utbetalningar."] : []),
        ],
        link: c.adminUrl === null ? null : { href: c.adminUrl as string, label: "Hantera utbetalningen" },
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
