import { isValidDiscountCode } from "../commerce/discount-codes";
import type { AuthEmailMessage } from "./auth-email-job";
import { COUNTRY_NAMES_SV, formatOrderMoney } from "./auth-email-job";

/**
 * The three order mails of CP5-WE (migration 0050):
 *
 *   order_status_update  to the buyer (orders.customer_email), when the seller
 *                        moves the fulfilment: processing, shipped (with the
 *                        tracking number and carrier when given; a further
 *                        parcel says so), ready for pickup (with the place),
 *                        delivered. `completed` sends nothing.
 *   order_notice_shop    to the shop (its support address, else its oldest
 *                        active admin), on a new paid order: the order number,
 *                        the lines, the delivery and what the BUYER paid. No
 *                        platform fee, commission, printer cost or payout: the
 *                        seller sees one number, and it is in the admin.
 *   refund_notice        to the buyer, when a refund settles: the amount the
 *                        server refunded, full or partial.
 *
 * Every job is built by the outbox email effects (src/outbox/email-effect.ts)
 * and sent by the existing `-email` consumer through the delivery ledger, like
 * the order confirmation: `parseAuthEmailJob`, `renderAuthEmail` and
 * `fingerprintAuthEmailJob` hand a job of these kinds to this module.
 *
 * DETERMINISTIC: every field is supplied by the caller (none is minted here),
 * the delivery id is derived from the outbox dedupe key, and what is live (the
 * shop's name and address, the admin origin) is frozen on the outbox row at the
 * first build — so every retry builds the identical job and the ledger sends it
 * at most once. The fingerprint covers everything the template renders.
 *
 * TEXT, NEVER HTML: every value the shop or the buyer wrote (shop name, line
 * names, pickup place, tracking number, carrier, the buyer's name) is escaped
 * in the HTML part. Nothing here logs.
 */

export const ORDER_EMAIL_KINDS = ["order_notice_shop", "order_status_update", "refund_notice"] as const;
export type OrderEmailKind = (typeof ORDER_EMAIL_KINDS)[number];

/** The fulfilment steps the buyer is mailed about. `completed` is not one. */
export const STATUS_MAIL_STEPS = ["processing", "shipped", "ready_for_pickup", "delivered"] as const;
export type StatusMailStep = (typeof STATUS_MAIL_STEPS)[number];

export interface OrderStatusContent {
  /** shipped → shipped: a further parcel of the same order. */
  additionalParcel: boolean;
  carrier: string | null;
  orderNumber: string;
  /** ready_for_pickup only: the place as frozen at checkout. */
  pickupPlaceAddress: string | null;
  pickupPlaceName: string | null;
  /** The order recipient's name (order_recipients), read live, never frozen. */
  recipientName: string | null;
  shopName: string | null;
  status: StatusMailStep;
  /** The shop's support address: shown, and the mail's Reply-To. */
  supportEmail: string | null;
  trackingNumber: string | null;
}

export interface OrderNoticeLine {
  lineTotalMinor: number;
  name: string;
  quantity: number;
}

export interface OrderNoticeContent {
  /** `<admin origin>/admin/orders/<orderId>?shopId=<tenantId>`, or null without an admin origin. */
  adminUrl: string | null;
  currency: string;
  deliveryMethod: "pickup" | "shipping";
  /**
   * CP8-DC: the campaign code the discount came from, by its current name.
   * ABSENT (never null) on an order without one, so such a mail's content and
   * fingerprint are what they were before the code was named.
   */
  discountCode?: string;
  discountMinor: number;
  items: OrderNoticeLine[];
  orderNumber: string;
  pickupPlaceName: string | null;
  shippingCountry: string | null;
  shippingMinor: number;
  shopName: string | null;
  subtotalMinor: number;
  totalMinor: number;
  vatMinor: number;
}

export interface RefundNoticeContent {
  amountMinor: number;
  currency: string;
  /** The order is refunded to its charge by this refund. */
  full: boolean;
  orderNumber: string;
  recipientName: string | null;
  shopName: string | null;
  supportEmail: string | null;
}

interface OrderEmailFrame {
  actionUrl: "";
  createdAt: number;
  deliveryId: string;
  expiresAt: number;
  locale: "sv";
  /** Absent, as on every job that is not an order confirmation. */
  order?: undefined;
  recipient: string;
  tenantId: string;
  /** Absent, as on every job that is not an invite. */
  variant?: undefined;
  version: 1;
}

export type OrderEmailJob =
  | (OrderEmailFrame & { content: OrderNoticeContent; kind: "order_notice_shop" })
  | (OrderEmailFrame & { content: OrderStatusContent; kind: "order_status_update" })
  | (OrderEmailFrame & { content: RefundNoticeContent; kind: "refund_notice" });

export type OrderEmailContent = OrderEmailJob["content"];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DELIVERY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
const CONTROL_GLOBAL = /[\u0000-\u001f\u007f]+/g;
const MAX_JOB_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;

export const MAX_ORDER_MAIL_LINES = 100;
export const MAX_TEXT_LENGTH = 200;
/** A pickup place's address: what the recipient schema (0045) and the store identity allow. */
export const MAX_PICKUP_ADDRESS_LENGTH = 500;
/** The tenant id the admin build accepts in `?shopId=` (src/admin-app/providers/activeShopStore.js). */
export const ADMIN_SHOP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_ORDER_NUMBER_LENGTH = 64;
const MAX_URL_LENGTH = 500;

export function isOrderEmailKind(value: unknown): value is OrderEmailKind {
  return (ORDER_EMAIL_KINDS as readonly unknown[]).includes(value);
}

/** For the consumer's union: `if (isOrderEmailJob(job)) …`. */
export function isOrderEmailJob(job: { kind: string }): job is OrderEmailJob {
  return isOrderEmailKind(job.kind);
}

function isStep(value: unknown): value is StatusMailStep {
  return (STATUS_MAIL_STEPS as readonly unknown[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !CONTROL.test(value);
}

function isOptionalText(value: unknown, max: number): value is string | null {
  return value === null || isText(value, max);
}

function isMinor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * For the builders: a stored text made safe to render — control characters
 * out, trimmed, bounded; null when nothing is left. Never throws, so a shop's
 * odd text cannot keep its mail from being built.
 */
export function mailText(value: string | null | undefined, max = MAX_TEXT_LENGTH): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.replace(CONTROL_GLOBAL, " ").trim().slice(0, max).trim();
  return text === "" ? null : text;
}

/** trim + lower case + the ledger's address shape; throws otherwise. */
export function normalizedOrderEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new Error("Invalid order email address");
  }
  return email;
}

/**
 * A shop address that can be written to: the ledger's shape and not one of the
 * placeholder domains a default store config ships with (the source's
 * `isRealEmail`). Null otherwise.
 */
export function realShopAddress(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const email = normalizedOrderEmail(value);
    return /@example\.(com|org|net|se)$/.test(email) ? null : email;
  } catch {
    return null;
  }
}

function isOptionalEmail(value: unknown): value is string | null {
  if (value === null) {
    return true;
  }
  try {
    return typeof value === "string" && normalizedOrderEmail(value) === value;
  } catch {
    return false;
  }
}

/**
 * `https://<admin>/admin/orders/<orderId>?shopId=<tenantId>`: the admin's own
 * order page, with the order's shop selected (an admin of several shops lands
 * in the right one). `shopId` is the only parameter and must be the job's own
 * tenant.
 */
function isAdminUrl(value: unknown, tenantId: string): value is string | null {
  if (value === null) {
    return true;
  }
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH || CONTROL.test(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      ADMIN_SHOP_ID_PATTERN.test(tenantId) &&
      url.search === `?shopId=${tenantId}` &&
      [...url.searchParams.keys()].length === 1 &&
      url.searchParams.get("shopId") === tenantId &&
      url.hash === "" &&
      /^\/admin\/orders\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname) &&
      url.href === value
    );
  } catch {
    return false;
  }
}

function invalid(): never {
  throw new Error("Invalid order email content");
}

function validatedStatus(value: Record<string, unknown>): OrderStatusContent {
  if (
    typeof value.additionalParcel !== "boolean" ||
    !isStep(value.status) ||
    !isText(value.orderNumber, MAX_ORDER_NUMBER_LENGTH) ||
    !isOptionalText(value.shopName, MAX_TEXT_LENGTH) ||
    !isOptionalEmail(value.supportEmail) ||
    !isOptionalText(value.recipientName, MAX_TEXT_LENGTH) ||
    !isOptionalText(value.trackingNumber, MAX_TEXT_LENGTH) ||
    !isOptionalText(value.carrier, MAX_TEXT_LENGTH) ||
    !isOptionalText(value.pickupPlaceName, MAX_TEXT_LENGTH) ||
    !isOptionalText(value.pickupPlaceAddress, MAX_PICKUP_ADDRESS_LENGTH) ||
    // Shipment facts belong to `shipped`, the place to `ready_for_pickup`.
    (value.status !== "shipped" &&
      (value.trackingNumber !== null || value.carrier !== null || value.additionalParcel)) ||
    (value.status !== "ready_for_pickup" &&
      (value.pickupPlaceName !== null || value.pickupPlaceAddress !== null))
  ) {
    invalid();
  }
  return {
    additionalParcel: value.additionalParcel as boolean,
    carrier: value.carrier as string | null,
    orderNumber: value.orderNumber as string,
    pickupPlaceAddress: value.pickupPlaceAddress as string | null,
    pickupPlaceName: value.pickupPlaceName as string | null,
    recipientName: value.recipientName as string | null,
    shopName: value.shopName as string | null,
    status: value.status as StatusMailStep,
    supportEmail: value.supportEmail as string | null,
    trackingNumber: value.trackingNumber as string | null,
  };
}

function validatedNotice(value: Record<string, unknown>, tenantId: string): OrderNoticeContent {
  const items = value.items;
  if (
    !isText(value.orderNumber, MAX_ORDER_NUMBER_LENGTH) ||
    typeof value.currency !== "string" ||
    !/^[A-Z]{3}$/.test(value.currency) ||
    (value.deliveryMethod !== "pickup" && value.deliveryMethod !== "shipping") ||
    (value.deliveryMethod === "pickup"
      ? value.shippingCountry !== null || !isOptionalText(value.pickupPlaceName, MAX_TEXT_LENGTH)
      : typeof value.shippingCountry !== "string" ||
        !/^[A-Z]{2}$/.test(value.shippingCountry) ||
        value.pickupPlaceName !== null) ||
    !isOptionalText(value.shopName, MAX_TEXT_LENGTH) ||
    !isAdminUrl(value.adminUrl, tenantId) ||
    !isMinor(value.subtotalMinor) ||
    !isMinor(value.shippingMinor) ||
    !isMinor(value.discountMinor) ||
    !isMinor(value.vatMinor) ||
    !isMinor(value.totalMinor) ||
    // The order's own arithmetic (0011): VAT is contained in the total.
    value.totalMinor !== value.subtotalMinor + value.shippingMinor - value.discountMinor ||
    value.vatMinor > value.totalMinor ||
    // Absent on a copy frozen before CP8-DC and on an order without a code.
    (value.discountCode !== undefined &&
      (typeof value.discountCode !== "string" || !isValidDiscountCode(value.discountCode))) ||
    !Array.isArray(items) ||
    items.length === 0 ||
    items.length > MAX_ORDER_MAIL_LINES
  ) {
    invalid();
  }
  const lines = (items as unknown[]).map((item): OrderNoticeLine => {
    if (
      !isRecord(item) ||
      !isText(item.name, MAX_TEXT_LENGTH) ||
      typeof item.quantity !== "number" ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 999 ||
      !isMinor(item.lineTotalMinor)
    ) {
      invalid();
    }
    return { lineTotalMinor: item.lineTotalMinor, name: item.name, quantity: item.quantity };
  });
  return {
    adminUrl: value.adminUrl as string | null,
    currency: value.currency as string,
    deliveryMethod: value.deliveryMethod as "pickup" | "shipping",
    ...(typeof value.discountCode === "string" ? { discountCode: value.discountCode } : {}),
    discountMinor: value.discountMinor as number,
    items: lines,
    orderNumber: value.orderNumber as string,
    pickupPlaceName: value.pickupPlaceName as string | null,
    shippingCountry: value.shippingCountry as string | null,
    shippingMinor: value.shippingMinor as number,
    shopName: value.shopName as string | null,
    subtotalMinor: value.subtotalMinor as number,
    totalMinor: value.totalMinor as number,
    vatMinor: value.vatMinor as number,
  };
}

function validatedRefund(value: Record<string, unknown>): RefundNoticeContent {
  if (
    !isMinor(value.amountMinor) ||
    value.amountMinor === 0 ||
    typeof value.currency !== "string" ||
    !/^[A-Z]{3}$/.test(value.currency) ||
    typeof value.full !== "boolean" ||
    !isText(value.orderNumber, MAX_ORDER_NUMBER_LENGTH) ||
    !isOptionalText(value.recipientName, MAX_TEXT_LENGTH) ||
    !isOptionalText(value.shopName, MAX_TEXT_LENGTH) ||
    !isOptionalEmail(value.supportEmail)
  ) {
    invalid();
  }
  return {
    amountMinor: value.amountMinor as number,
    currency: value.currency as string,
    full: value.full as boolean,
    orderNumber: value.orderNumber as string,
    recipientName: value.recipientName as string | null,
    shopName: value.shopName as string | null,
    supportEmail: value.supportEmail as string | null,
  };
}

function validatedContent(kind: OrderEmailKind, value: unknown, tenantId: string): OrderEmailContent {
  if (!isRecord(value)) {
    invalid();
  }
  switch (kind) {
    case "order_status_update":
      return validatedStatus(value);
    case "order_notice_shop":
      return validatedNotice(value, tenantId);
    case "refund_notice":
      return validatedRefund(value);
  }
}

function validatedFrame(input: Record<string, unknown>, now: number): OrderEmailFrame & { kind: OrderEmailKind } {
  if (
    input.version !== 1 ||
    input.actionUrl !== "" ||
    !isOrderEmailKind(input.kind) ||
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
    throw new Error("Invalid order email job");
  }
  return {
    actionUrl: "",
    createdAt: input.createdAt as number,
    deliveryId: input.deliveryId,
    expiresAt: input.expiresAt as number,
    kind: input.kind,
    locale: "sv",
    recipient: normalizedOrderEmail(input.recipient),
    tenantId: input.tenantId,
    version: 1,
  };
}

function assemble(value: Record<string, unknown>): OrderEmailJob {
  const frame = validatedFrame(value, Date.now());
  return { ...frame, content: validatedContent(frame.kind, value.content, frame.tenantId) } as OrderEmailJob;
}

/**
 * Builds the job an effect hands to EMAIL_QUEUE. Every field comes from the
 * caller. Throws on anything the ledger or the template could not carry.
 */
export function createOrderEmailJob(input: {
  content: OrderEmailContent;
  createdAt: number;
  deliveryId: string;
  expiresAt: number;
  kind: OrderEmailKind;
  recipient: string;
  tenantId: string;
}): OrderEmailJob {
  return assemble({ ...input, actionUrl: "", locale: "sv", version: 1 });
}

/** The consumer's parse of a queued job of these kinds; throws on anything else. */
export function parseOrderEmailJob(value: unknown): OrderEmailJob {
  if (!isRecord(value)) {
    throw new Error("Invalid order email job");
  }
  return assemble(value);
}

/** The content in a FIXED key order: all of it is rendered, so all of it is covered. */
export function canonicalOrderEmailContent(job: OrderEmailJob): Record<string, unknown> {
  switch (job.kind) {
    case "order_status_update": {
      const c = job.content;
      return {
        additionalParcel: c.additionalParcel,
        carrier: c.carrier,
        orderNumber: c.orderNumber,
        pickupPlaceAddress: c.pickupPlaceAddress,
        pickupPlaceName: c.pickupPlaceName,
        recipientName: c.recipientName,
        shopName: c.shopName,
        status: c.status,
        supportEmail: c.supportEmail,
        trackingNumber: c.trackingNumber,
      };
    }
    case "order_notice_shop": {
      const c = job.content;
      return {
        adminUrl: c.adminUrl,
        currency: c.currency,
        deliveryMethod: c.deliveryMethod,
        // Only when there is one: an order without a code keeps its
        // fingerprint byte for byte (CP8-DC).
        ...(c.discountCode === undefined ? {} : { discountCode: c.discountCode }),
        discountMinor: c.discountMinor,
        items: c.items.map((item) => ({
          lineTotalMinor: item.lineTotalMinor,
          name: item.name,
          quantity: item.quantity,
        })),
        orderNumber: c.orderNumber,
        pickupPlaceName: c.pickupPlaceName,
        shippingCountry: c.shippingCountry,
        shippingMinor: c.shippingMinor,
        shopName: c.shopName,
        subtotalMinor: c.subtotalMinor,
        totalMinor: c.totalMinor,
        vatMinor: c.vatMinor,
      };
    }
    case "refund_notice": {
      const c = job.content;
      return {
        amountMinor: c.amountMinor,
        currency: c.currency,
        full: c.full,
        orderNumber: c.orderNumber,
        recipientName: c.recipientName,
        shopName: c.shopName,
        supportEmail: c.supportEmail,
      };
    }
  }
}

function bytesToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The ledger fingerprint of an order mail: the frame keys of
 * `fingerprintAuthEmailJob`, in its order, plus the content. The wired
 * `fingerprintAuthEmailJob` delegates here, so producer and consumer agree.
 */
export async function fingerprintOrderEmailJob(job: OrderEmailJob): Promise<string> {
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
    content: canonicalOrderEmailContent(job),
  });
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
}

/** The Reply-To of a buyer mail: the shop's own support address, if any. */
export function orderEmailReplyTo(job: OrderEmailJob): string | null {
  return job.kind === "order_notice_shop" ? null : job.content.supportEmail;
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

export const STATUS_NAMES_SV: Record<StatusMailStep, string> = {
  delivered: "Levererad",
  processing: "Behandlas",
  ready_for_pickup: "Redo att hämtas",
  shipped: "Skickad",
};

interface Copy {
  closing: string[];
  facts: Array<[string, string]>;
  greeting: string | null;
  intro: string;
  link: { href: string; label: string } | null;
  sections: Array<{ heading: string; lines: string[] }>;
  subject: string;
  title: string;
}

function greetingOf(name: string | null): string {
  return name === null ? "Hej," : `Hej ${name},`;
}

function contactLine(shopName: string | null, supportEmail: string | null): string {
  return supportEmail === null
    ? "Har du frågor om din beställning? Kontakta butiken."
    : `Har du frågor om din beställning? Kontakta ${shopName ?? "butiken"} på ${supportEmail}.`;
}

function statusCopy(content: OrderStatusContent): Copy {
  const name = STATUS_NAMES_SV[content.status];
  const facts: Array<[string, string]> = [
    ["Ordernummer", content.orderNumber],
    ["Status", name],
  ];
  let steps: string[];
  switch (content.status) {
    case "processing":
      steps = ["Din beställning behandlas och förbereds.", "Du får ett nytt mejl när den skickas eller kan hämtas."];
      break;
    case "shipped":
      if (content.trackingNumber !== null) {
        facts.push(["Spårningsnummer", content.trackingNumber]);
      }
      if (content.carrier !== null) {
        facts.push(["Fraktbolag", content.carrier]);
      }
      steps = [
        content.additionalParcel
          ? "Ytterligare ett paket i din beställning är nu på väg till dig."
          : "Din beställning är nu på väg till dig.",
        ...(content.trackingNumber === null ? [] : ["Använd spårningsnumret för att följa leveransen."]),
      ];
      break;
    case "ready_for_pickup":
      if (content.pickupPlaceName !== null) {
        facts.push(["Upphämtningsställe", content.pickupPlaceName]);
      }
      if (content.pickupPlaceAddress !== null) {
        facts.push(["Adress", content.pickupPlaceAddress]);
      }
      steps = ["Din beställning är redo att hämtas.", "Ta med ditt ordernummer när du hämtar den."];
      break;
    case "delivered":
      steps = ["Din beställning har levererats.", "Vi hoppas att du blir nöjd med ditt köp."];
      break;
  }
  return {
    closing: [contactLine(content.shopName, content.supportEmail)],
    facts,
    greeting: greetingOf(content.recipientName),
    intro:
      content.shopName === null
        ? "Vi har en uppdatering om din beställning."
        : `Vi har en uppdatering om din beställning hos ${content.shopName}.`,
    link: null,
    sections: [{ heading: "Vad händer nu:", lines: steps }],
    subject:
      content.status === "shipped" && content.additionalParcel
        ? `Orderuppdatering: ${content.orderNumber} – ytterligare ett paket skickat`
        : `Orderuppdatering: ${content.orderNumber} – ${name}`,
    title: "Orderuppdatering",
  };
}

/** "Rabatt (SOMMAR20)", or "Rabatt" without a named code (CP8-DC). */
export function discountLabel(code: string | undefined): string {
  return code === undefined ? "Rabatt" : `Rabatt (${code})`;
}

function noticeCopy(content: OrderNoticeContent): Copy {
  const money = (minor: number) => formatOrderMoney(minor, content.currency);
  const delivery =
    content.deliveryMethod === "pickup"
      ? content.pickupPlaceName === null
        ? "Upphämtning"
        : `Upphämtning: ${content.pickupPlaceName}`
      : `Frakt till ${COUNTRY_NAMES_SV[content.shippingCountry ?? ""] ?? content.shippingCountry}`;
  return {
    closing: [
      content.adminUrl === null
        ? "Hantera ordern under Ordrar i butikens admin."
        : "Hantera ordern i butikens admin.",
    ],
    facts: [
      ["Ordernummer", content.orderNumber],
      ["Leverans", delivery],
    ],
    greeting: null,
    intro:
      content.shopName === null
        ? "En ny betald beställning har kommit in i butiken."
        : `En ny betald beställning har kommit in i ${content.shopName}.`,
    link: content.adminUrl === null ? null : { href: content.adminUrl, label: "Hantera order" },
    sections: [
      {
        heading: "Varor:",
        lines: content.items.map((item) => `${item.quantity} st ${item.name}: ${money(item.lineTotalMinor)}`),
      },
      {
        heading: "Kunden betalade:",
        lines: [
          `Delsumma: ${money(content.subtotalMinor)}`,
          `${content.deliveryMethod === "pickup" ? "Upphämtning" : "Frakt"}: ${money(content.shippingMinor)}`,
          ...(content.discountMinor > 0
            ? [`${discountLabel(content.discountCode)}: -${money(content.discountMinor)}`]
            : []),
          `Totalt: ${money(content.totalMinor)}`,
          `varav moms: ${money(content.vatMinor)}`,
        ],
      },
    ],
    subject: `Ny beställning: ${content.orderNumber}`,
    title: "Ny beställning",
  };
}

function refundCopy(content: RefundNoticeContent): Copy {
  const shop = content.shopName === null ? "" : ` hos ${content.shopName}`;
  return {
    closing: [
      "Pengarna når dig inom några bankdagar, beroende på din bank.",
      contactLine(content.shopName, content.supportEmail),
    ],
    facts: [
      ["Order", content.orderNumber],
      ["Återbetalat belopp", formatOrderMoney(content.amountMinor, content.currency)],
    ],
    greeting: greetingOf(content.recipientName),
    intro: content.full
      ? `Vi har genomfört en full återbetalning av din beställning${shop}.`
      : `Vi har genomfört en delåterbetalning av din beställning${shop}.`,
    link: null,
    sections: [],
    subject: `Återbetalning – order ${content.orderNumber}`,
    title: "Återbetalning genomförd",
  };
}

function copyOf(job: OrderEmailJob): Copy {
  switch (job.kind) {
    case "order_status_update":
      return statusCopy(job.content);
    case "order_notice_shop":
      return noticeCopy(job.content);
    case "refund_notice":
      return refundCopy(job.content);
  }
}

/** The Swedish mail of an order job: text + HTML, every value HTML-escaped. */
export function renderOrderEmail(job: OrderEmailJob): AuthEmailMessage {
  const copy = copyOf(job);

  const text = [
    copy.title,
    "",
    ...(copy.greeting === null ? [] : [copy.greeting, ""]),
    copy.intro,
    "",
    ...copy.facts.map(([label, value]) => `${label}: ${value}`),
    ...copy.sections.flatMap((section) => ["", section.heading, ...section.lines.map((line) => `- ${line}`)]),
    ...copy.closing.flatMap((paragraph) => ["", paragraph]),
    ...(copy.link === null ? [] : [`${copy.link.label}: ${copy.link.href}`]),
  ].join("\n");

  const html = [
    `<p><strong>${escapeHtml(copy.title)}</strong></p>`,
    ...(copy.greeting === null ? [] : [`<p>${escapeHtml(copy.greeting)}</p>`]),
    `<p>${escapeHtml(copy.intro)}</p>`,
    `<p>${copy.facts.map(([label, value]) => `${escapeHtml(label)}: ${escapeHtml(value)}`).join("<br>")}</p>`,
    ...copy.sections.map(
      (section) =>
        `<p>${escapeHtml(section.heading)}</p><ul>${section.lines
          .map((line) => `<li>${escapeHtml(line)}</li>`)
          .join("")}</ul>`,
    ),
    ...copy.closing.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
    ...(copy.link === null
      ? []
      : [`<p><a href="${escapeHtml(copy.link.href)}">${escapeHtml(copy.link.label)}</a></p>`]),
  ].join("");

  return { html, subject: copy.subject, text };
}
