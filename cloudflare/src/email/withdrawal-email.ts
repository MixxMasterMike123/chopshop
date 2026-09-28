import type { AuthEmailMessage } from "./auth-email-job";
import { hashEmailRecipient } from "./auth-email-job";

/**
 * The two mails of the withdrawal function (CP4-G, DAL 2 kap. 10 a §,
 * migration 0044):
 *
 *   withdrawal_receipt  to the buyer, at the purchase address they stated: the
 *                       receipt (mottagningsbevis) — the time the message
 *                       arrived, the order, the goods it covers, and the
 *                       buyer's own statement;
 *   withdrawal_notice   to the shop's support address: the same facts, and
 *                       that no money has moved.
 *
 * Both are enqueued by the `withdrawal_email` outbox effect
 * (src/commerce/withdrawals.ts) and sent by the existing `-email` consumer
 * through the delivery ledger, like the order confirmation. The consumer
 * learns these kinds through the reviewer's wiring (docs/cf-port/
 * CP4_G_REPORT.md): `parseAuthEmailJob`, `renderAuthEmail` and
 * `fingerprintAuthEmailJob` hand a job of these kinds to this module.
 *
 * DETERMINISTIC: every field is supplied by the caller from the withdrawal row
 * (immutable) and the order's frozen lines, the delivery id is derived from
 * the outbox dedupe key, so every retry builds the identical job and the
 * ledger sends it at most once. The fingerprint covers the rendered content.
 *
 * Nothing here logs; the content holds the buyer's name and address and goes
 * nowhere but the job.
 */

export const WITHDRAWAL_EMAIL_KINDS = ["withdrawal_notice", "withdrawal_receipt"] as const;
export type WithdrawalEmailKind = (typeof WITHDRAWAL_EMAIL_KINDS)[number];

export const WITHDRAWAL_REASONS = ["personalized_exempt", "window_passed"] as const;
export type WithdrawalReason = (typeof WITHDRAWAL_REASONS)[number];

/** The absolute cap (days after the order) of the source function. */
export const WITHDRAWAL_MAX_AGE_DAYS = 450;

/** One order line as the receipt names it (from order_items, frozen at payment). */
export interface WithdrawalLine {
  name: string;
  quantity: number;
  /** May be empty: the page shows it only when present. */
  sku: string;
}

/**
 * The receipt (mottagningsbevis): what the page shows and lets the buyer save,
 * and what both mails render. The keys the source's page reads are kept
 * (`orderNumber`, `withdrawnItems`, `consumerName`, `contactEmail`,
 * `submittedAt`, `statement`); `shopName` and `exemptItems` are added.
 */
export interface WithdrawalAcknowledgement {
  consumerName: string;
  /** The purchase address the buyer stated; the receipt is mailed there. */
  contactEmail: string;
  /** Personalised lines whose right was waived at checkout (none, usually). */
  exemptItems: WithdrawalLine[];
  orderNumber: string;
  shopName: string | null;
  /** The buyer's message, as the source words it, with the time of receipt. */
  statement: string;
  /** THE time of receipt, the server's (ISO-8601 UTC). */
  submittedAt: string;
  /** The lines the withdrawal covers; empty when no right applies. */
  withdrawnItems: WithdrawalLine[];
}

export interface WithdrawalEmailContent {
  acknowledgement: WithdrawalAcknowledgement;
  eligible: boolean;
  reason: WithdrawalReason | null;
}

export interface WithdrawalEmailJob {
  actionUrl: "";
  createdAt: number;
  deliveryId: string;
  expiresAt: number;
  kind: WithdrawalEmailKind;
  locale: "sv";
  /** Absent, as on every job that is not an order confirmation. */
  order?: undefined;
  recipient: string;
  tenantId: string;
  /** Absent, as on every job that is not an invite. */
  variant?: undefined;
  version: 1;
  withdrawal: WithdrawalEmailContent;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DELIVERY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_JOB_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;

export const MAX_WITHDRAWAL_LINES = 200;
export const MAX_LINE_NAME_LENGTH = 200;
export const MAX_LINE_SKU_LENGTH = 128;
const MAX_ORDER_NUMBER_LENGTH = 64;
const MAX_NAME_LENGTH = 200;
const MAX_SHOP_NAME_LENGTH = 200;
const MAX_STATEMENT_LENGTH = 1_000;

export function isWithdrawalEmailKind(value: unknown): value is WithdrawalEmailKind {
  return (WITHDRAWAL_EMAIL_KINDS as readonly unknown[]).includes(value);
}

/** For the consumer's union: `if (isWithdrawalEmailJob(job)) …`. */
export function isWithdrawalEmailJob(job: { kind: string }): job is WithdrawalEmailJob {
  return isWithdrawalEmailKind(job.kind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, min: number, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= min &&
    value.length <= max &&
    // The text lands in a subject line and in HTML.
    !CONTROL.test(value)
  );
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && ISO_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

/** trim + lower case + the ledger's address shape; throws otherwise. */
export function normalizedWithdrawalEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new Error("Invalid withdrawal email address");
  }
  return email;
}

function validatedLines(value: unknown): WithdrawalLine[] {
  if (!Array.isArray(value) || value.length > MAX_WITHDRAWAL_LINES) {
    throw new Error("Invalid withdrawal email content");
  }
  return value.map((line: unknown): WithdrawalLine => {
    if (
      !isRecord(line) ||
      !isText(line.name, 1, MAX_LINE_NAME_LENGTH) ||
      !isText(line.sku, 0, MAX_LINE_SKU_LENGTH) ||
      typeof line.quantity !== "number" ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > 999
    ) {
      throw new Error("Invalid withdrawal email content");
    }
    return { name: line.name, quantity: line.quantity, sku: line.sku };
  });
}

function validatedContent(value: unknown): WithdrawalEmailContent {
  if (!isRecord(value) || !isRecord(value.acknowledgement)) {
    throw new Error("Invalid withdrawal email content");
  }
  const ack = value.acknowledgement;
  const reason = value.reason;
  if (
    typeof value.eligible !== "boolean" ||
    (value.eligible ? reason !== null : !(WITHDRAWAL_REASONS as readonly unknown[]).includes(reason)) ||
    !isText(ack.orderNumber, 1, MAX_ORDER_NUMBER_LENGTH) ||
    !isText(ack.consumerName, 1, MAX_NAME_LENGTH) ||
    typeof ack.contactEmail !== "string" ||
    !(ack.shopName === null || isText(ack.shopName, 1, MAX_SHOP_NAME_LENGTH)) ||
    !isText(ack.statement, 1, MAX_STATEMENT_LENGTH) ||
    !isIso(ack.submittedAt)
  ) {
    throw new Error("Invalid withdrawal email content");
  }
  const withdrawnItems = validatedLines(ack.withdrawnItems);
  const exemptItems = validatedLines(ack.exemptItems);
  if (!value.eligible && withdrawnItems.length > 0) {
    throw new Error("Invalid withdrawal email content");
  }
  return {
    acknowledgement: {
      consumerName: ack.consumerName,
      contactEmail: normalizedWithdrawalEmail(ack.contactEmail),
      exemptItems,
      orderNumber: ack.orderNumber,
      shopName: ack.shopName,
      statement: ack.statement,
      submittedAt: ack.submittedAt,
      withdrawnItems,
    },
    eligible: value.eligible,
    reason: value.eligible ? null : (reason as WithdrawalReason),
  };
}

function validatedFrame(
  input: Record<string, unknown>,
  now: number,
): Omit<WithdrawalEmailJob, "withdrawal"> {
  if (
    input.version !== 1 ||
    input.actionUrl !== "" ||
    !isWithdrawalEmailKind(input.kind) ||
    typeof input.deliveryId !== "string" ||
    !DELIVERY_ID_PATTERN.test(input.deliveryId) ||
    input.locale !== "sv" ||
    !Number.isSafeInteger(input.createdAt) ||
    !Number.isSafeInteger(input.expiresAt) ||
    (input.createdAt as number) > now + CLOCK_SKEW_MS ||
    (input.expiresAt as number) <= (input.createdAt as number) ||
    (input.expiresAt as number) - (input.createdAt as number) > MAX_JOB_LIFETIME_MS ||
    typeof input.tenantId !== "string" ||
    input.tenantId.length === 0 ||
    typeof input.recipient !== "string"
  ) {
    throw new Error("Invalid withdrawal email job");
  }
  return {
    actionUrl: "",
    createdAt: input.createdAt as number,
    deliveryId: input.deliveryId,
    expiresAt: input.expiresAt as number,
    kind: input.kind,
    locale: "sv",
    recipient: normalizedWithdrawalEmail(input.recipient),
    tenantId: input.tenantId,
    version: 1,
  };
}

/**
 * Builds the job the outbox effect hands to EMAIL_QUEUE. Every field comes
 * from the caller (none is minted here). Throws on anything the ledger or the
 * template could not carry.
 */
export function createWithdrawalEmailJob(input: {
  createdAt: number;
  deliveryId: string;
  expiresAt: number;
  kind: WithdrawalEmailKind;
  recipient: string;
  tenantId: string;
  withdrawal: WithdrawalEmailContent;
}): WithdrawalEmailJob {
  const frame = validatedFrame({ ...input, actionUrl: "", locale: "sv", version: 1 }, Date.now());
  return { ...frame, withdrawal: validatedContent(input.withdrawal) };
}

/** The consumer's parse of a queued job of these kinds; throws on anything else. */
export function parseWithdrawalEmailJob(value: unknown): WithdrawalEmailJob {
  if (!isRecord(value)) {
    throw new Error("Invalid withdrawal email job");
  }
  const frame = validatedFrame(value, Date.now());
  return { ...frame, withdrawal: validatedContent(value.withdrawal) };
}

function canonicalLines(lines: readonly WithdrawalLine[]) {
  return lines.map((line) => ({ name: line.name, quantity: line.quantity, sku: line.sku }));
}

/** The content in a FIXED key order: all of it is rendered, so all of it is covered. */
export function canonicalWithdrawalContent(content: WithdrawalEmailContent) {
  const ack = content.acknowledgement;
  return {
    acknowledgement: {
      consumerName: ack.consumerName,
      contactEmail: ack.contactEmail,
      exemptItems: canonicalLines(ack.exemptItems),
      orderNumber: ack.orderNumber,
      shopName: ack.shopName,
      statement: ack.statement,
      submittedAt: ack.submittedAt,
      withdrawnItems: canonicalLines(ack.withdrawnItems),
    },
    eligible: content.eligible,
    reason: content.reason,
  };
}

function bytesToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The ledger fingerprint of a withdrawal job. The frame keys are those of
 * `fingerprintAuthEmailJob`, in its order, plus the content: a queued copy
 * whose time, lines, name or wording differs from what the producer recorded
 * is a conflict, never a send. The wired `fingerprintAuthEmailJob` delegates
 * here for these kinds, so producer and consumer compute the same value.
 */
export async function fingerprintWithdrawalEmailJob(job: WithdrawalEmailJob): Promise<string> {
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
    withdrawal: canonicalWithdrawalContent(job.withdrawal),
  });
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
}

/**
 * The ledger row (email_deliveries, 0044 kinds) as a statement builder, so the
 * effect records it in the batch that moves its outbox row, under that row's
 * claim — the same INSERT, columns and values as `prepareAuthEmailDeliveryRecord`
 * writes for the other kinds (src/email/email-delivery-store.ts), with this
 * module's fingerprint.
 */
export async function prepareWithdrawalEmailDeliveryRecord(
  db: D1Database,
  job: WithdrawalEmailJob,
  now: number,
): Promise<(where?: { binds: unknown[]; sql: string }) => D1PreparedStatement> {
  const [recipientHash, fingerprint] = await Promise.all([
    hashEmailRecipient(job.recipient),
    fingerprintWithdrawalEmailJob(job),
  ]);
  return (where) =>
    db
      .prepare(
        `INSERT INTO email_deliveries (
           delivery_id, tenant_id, kind, recipient_hash, status, attempts,
           max_attempts, next_attempt_at, expires_at, created_at, updated_at,
           job_fingerprint
         ) SELECT ?, ?, ?, ?, 'pending', 0, 8, ?, ?, ?, ?, ?
         WHERE ${where?.sql ?? "1"}
         ON CONFLICT(delivery_id) DO NOTHING`,
      )
      .bind(
        job.deliveryId,
        job.tenantId,
        job.kind,
        recipientHash,
        now,
        job.expiresAt,
        job.createdAt,
        Math.max(now, job.createdAt),
        fingerprint,
        ...(where?.binds ?? []),
      );
}

// ── the Swedish templates ───────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function lineText(line: WithdrawalLine): string {
  return `${line.name}${line.sku === "" ? "" : ` (${line.sku})`} × ${line.quantity}`;
}

interface Section {
  heading: string;
  lines: string[];
}

interface Copy {
  closing: string[];
  facts: Array<[string, string]>;
  intro: string;
  sections: Section[];
  subject: string;
  title: string;
}

function receiptCopy(job: WithdrawalEmailJob): Copy {
  const { acknowledgement: ack, eligible, reason } = job.withdrawal;
  const sections: Section[] = [];
  if (ack.withdrawnItems.length > 0) {
    sections.push({ heading: "Varor som ångras:", lines: ack.withdrawnItems.map(lineText) });
  }
  if (ack.exemptItems.length > 0) {
    sections.push({
      heading: eligible
        ? "Följande varor är specialtillverkade och omfattas inte av ångerrätten:"
        : "Varor i beställningen:",
      lines: ack.exemptItems.map(lineText),
    });
  }
  const verdict =
    reason === "personalized_exempt"
      ? [
          "Enligt butikens uppgifter innehåller beställningen bara specialtillverkade varor, och vid köpet godkände du att ångerrätten inte gäller för dem. Reklamationsrätten vid fel på varan gäller alltid.",
          "Butiken har fått ditt meddelande. Kontakta butiken om du har frågor.",
        ]
      : reason === "window_passed"
        ? [
            `Beställningen gjordes för mer än ${WITHDRAWAL_MAX_AGE_DAYS} dagar sedan, så ångerfristen har gått ut.`,
            "Butiken har fått ditt meddelande. Kontakta butiken om du har frågor.",
          ]
        : ["Spara detta mottagningsbevis. Återbetalning hanteras enligt butikens villkor."];

  return {
    closing: [`Ditt meddelande: ${ack.statement}`, ...verdict],
    facts: [
      ["Mottaget", `${ack.submittedAt} (UTC)`],
      ...(ack.shopName === null ? [] : [["Butik", ack.shopName] as [string, string]]),
      ["Order", ack.orderNumber],
      ["Namn", ack.consumerName],
    ],
    intro: eligible
      ? "Vi har tagit emot ditt meddelande om att du ångrar ditt köp."
      : "Vi har tagit emot ditt meddelande om att du vill ångra ditt köp.",
    sections,
    subject: eligible
      ? `Mottagningsbevis – ångrat köp, order ${ack.orderNumber}`
      : `Mottagningsbevis – meddelande om ångrat köp, order ${ack.orderNumber}`,
    title: eligible ? "Mottagningsbevis – ångrat köp" : "Mottagningsbevis – meddelande om ångrat köp",
  };
}

function noticeCopy(job: WithdrawalEmailJob): Copy {
  const { acknowledgement: ack, eligible, reason } = job.withdrawal;
  const sections: Section[] = [];
  if (ack.withdrawnItems.length > 0) {
    sections.push({ heading: "Varor som ångras:", lines: ack.withdrawnItems.map(lineText) });
  }
  if (ack.exemptItems.length > 0) {
    sections.push({
      heading: "Specialtillverkade varor (kunden godkände vid köpet att ångerrätten inte gäller):",
      lines: ack.exemptItems.map(lineText),
    });
  }
  const verdict =
    reason === "personalized_exempt"
      ? "Funktionen svarade kunden att ångerrätten inte gäller, eftersom beställningen bara innehåller specialtillverkade varor."
      : reason === "window_passed"
        ? `Funktionen svarade kunden att ångerfristen har gått ut (beställningen är äldre än ${WITHDRAWAL_MAX_AGE_DAYS} dagar).`
        : "Kunden har fått ett mottagningsbevis. Bedöm om ångern kom i tid: ångerfristen är 14 dagar från den dag kunden tog emot varan.";

  return {
    closing: [
      verdict,
      "Inga pengar har flyttats. En återbetalning gör du själv under Ordrar i butikens admin.",
    ],
    facts: [
      ["Mottaget", `${ack.submittedAt} (UTC)`],
      ["Order", ack.orderNumber],
      ["Namn", ack.consumerName],
      ["Kundens e-post", ack.contactEmail],
    ],
    intro: 'En kund har använt ångerfunktionen ("Ångra avtalet här") i din butik.',
    sections,
    subject: eligible
      ? `Ångrat köp: order ${ack.orderNumber}`
      : `Meddelande om ångrat köp: order ${ack.orderNumber}`,
    title: eligible ? "Ångrat köp" : "Meddelande om ångrat köp",
  };
}

/** The Swedish mail of a withdrawal job; every value HTML-escaped. */
export function renderWithdrawalEmail(job: WithdrawalEmailJob): AuthEmailMessage {
  const copy = job.kind === "withdrawal_receipt" ? receiptCopy(job) : noticeCopy(job);

  const text = [
    copy.title,
    "",
    copy.intro,
    "",
    ...copy.facts.map(([label, value]) => `${label}: ${value}`),
    ...copy.sections.flatMap((section) => ["", section.heading, ...section.lines.map((line) => `- ${line}`)]),
    "",
    ...copy.closing.flatMap((paragraph, index) => (index === 0 ? [paragraph] : ["", paragraph])),
  ].join("\n");

  const html = [
    `<p><strong>${escapeHtml(copy.title)}</strong></p>`,
    `<p>${escapeHtml(copy.intro)}</p>`,
    `<p>${copy.facts.map(([label, value]) => `${escapeHtml(label)}: ${escapeHtml(value)}`).join("<br>")}</p>`,
    ...copy.sections.map(
      (section) =>
        `<p>${escapeHtml(section.heading)}</p><ul>${section.lines
          .map((line) => `<li>${escapeHtml(line)}</li>`)
          .join("")}</ul>`,
    ),
    ...copy.closing.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
  ].join("");

  return { html, subject: copy.subject, text };
}
