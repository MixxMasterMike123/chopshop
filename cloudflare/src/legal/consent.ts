/**
 * The buyer's consent at checkout (CP2-E, migrations/0031) — the rules, ported
 * from Firebase (functions/src/payment/createPaymentIntent.ts
 * `withdrawalConsentBlockReason`, src/utils/withdrawal.js, and the abandoned-
 * checkout consent model):
 *
 *  1. TERMS. The buyer accepts the shop's purchase terms: `consent.terms` must
 *     be `true` or the request is not a checkout (400 invalid_request).
 *  2. NO RIGHT OF WITHDRAWAL, only when disclosed and waived. A personalised
 *     line (made to the buyer's own specification — DAL 2 kap. 11 § 3, CRD Art.
 *     16(c)) has no 14-day right of withdrawal ONLY IF the buyer was shown the
 *     disclosure and ticked the box before paying. So a cart holding one needs
 *     `withdrawalWaiver: true` plus the `disclosureVersion` of the text the
 *     storefront showed, which must be the current one; otherwise 400 with a
 *     code. The server — never the client — decides which lines are
 *     personalised, from `products.is_personalized` (see isPersonalizedLine).
 *     A waiver sent for a cart with no personalised line is NOT recorded: the
 *     buyer keeps the right, and no stored fact may say otherwise.
 *  3. MARKETING is a separate, optional, pre-unticked box (MFL 19 §, the
 *     dual-checkbox decision): stored as its own fact, never implied by terms.
 *  4. REMINDER (CP9-AC): the purpose-specific box "Påminn mig via e-post om
 *     jag inte slutför köpet", optional and pre-unticked, shown only while
 *     the shop sends reminders. Frozen as `reminder: true` ONLY when ticked:
 *     an unticked checkout's consent is byte for byte what it was before the
 *     box came back. A reminder needs it OR the marketing box
 *     (reminderConsentGiven, the owner's rule of 2026-07-06).
 *
 * The frozen shape (checkouts.consent_json → orders.consent_json):
 *   { v: 1, terms: true, marketing: boolean, reminder?: true,
 *     withdrawal: { personalizedItems: number[], waived: boolean,
 *                   disclosureVersion: string | null, disclosureSha256: string | null },
 *     recordedAt: ISO-8601 }
 */

/** Firebase src/utils/withdrawal.js WITHDRAWAL_NOTICE_VERSION — the proof references it. */
export const WITHDRAWAL_DISCLOSURE_VERSION = "v1-2026-06";

/** Firebase DEFAULT_NO_WITHDRAWAL_NOTICE, verbatim (the storefront shows this text). */
export const WITHDRAWAL_DISCLOSURE_TEXT =
  "Den här beställningen innehåller en eller flera specialtillverkade produkter " +
  "(tillverkas efter din design, text, bild eller mått). Enligt lagen om " +
  "distansavtal gäller ingen 14-dagars ångerrätt för specialtillverkade varor. " +
  "Reklamationsrätten vid fel på varan gäller alltid. Genom att kryssa i rutan " +
  "bekräftar du att du har tagit del av detta och godkänner att ångerrätten inte " +
  "gäller för dessa produkter.";

export interface CheckoutConsentInput {
  disclosureVersion: string | null;
  marketing: boolean;
  /** CP9-AC: the reminder box was ticked. Absent (an engine caller) = unticked. */
  reminder?: boolean;
  terms: true;
  withdrawalWaiver: boolean;
}

export type ConsentRefusalCode =
  | "withdrawal_disclosure_outdated"
  | "withdrawal_waiver_required";

export interface FrozenConsent {
  marketing: boolean;
  recordedAt: string;
  /** CP9-AC: present only when the reminder box was ticked. */
  reminder?: true;
  terms: true;
  v: 1;
  withdrawal: {
    disclosureSha256: string | null;
    disclosureVersion: string | null;
    personalizedItems: number[];
    waived: boolean;
  };
}

const CONSENT_KEYS = ["disclosureVersion", "marketing", "reminder", "terms", "withdrawalWaiver"];
const DISCLOSURE_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Strict shape. `terms` must be literally `true`; the three boxes are optional
 * booleans (absent = unticked); `disclosureVersion` accompanies a ticked waiver
 * and only a ticked waiver — a version with no waiver is self-contradictory.
 * `reminder` is accepted whatever the shop's switch says: a tab opened before
 * the seller turned it off must not fail at payment, and no reminder is sent
 * for such a shop anyway (src/commerce/checkout-reminders.ts).
 */
export function parseCheckoutConsent(value: unknown): CheckoutConsentInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !CONSENT_KEYS.includes(key))) {
    return null;
  }
  if (record.terms !== true) {
    return null;
  }
  const marketing = record.marketing ?? false;
  const reminder = record.reminder ?? false;
  const withdrawalWaiver = record.withdrawalWaiver ?? false;
  if (
    typeof marketing !== "boolean" ||
    typeof reminder !== "boolean" ||
    typeof withdrawalWaiver !== "boolean"
  ) {
    return null;
  }

  let disclosureVersion: string | null = null;
  if (withdrawalWaiver) {
    if (
      typeof record.disclosureVersion !== "string" ||
      !DISCLOSURE_VERSION_PATTERN.test(record.disclosureVersion)
    ) {
      return null;
    }
    disclosureVersion = record.disclosureVersion;
  } else if (record.disclosureVersion !== undefined) {
    return null;
  }

  return { disclosureVersion, marketing, ...(reminder ? { reminder: true } : {}), terms: true, withdrawalWaiver };
}

/**
 * THE personalisation predicate — one place, so CP6's buyer-supplied-artwork
 * flow changes this function and nothing else.
 *
 * CP2 rule: the product's own `is_personalized` flag (Firebase parity:
 * `product.isPersonalized === true`). POD-ness NEVER implies it: a catalogue
 * POD product (the seller's own design) keeps the full 14-day right — treating
 * it as personalised would strip a statutory consumer right (the LEGAL
 * FIREWALL in the Firebase pod-wagon manifest; C-529/19).
 */
export function isPersonalizedLine(line: { isPersonalized: boolean }): boolean {
  return line.isPersonalized;
}

let disclosureSha256: Promise<string> | null = null;

function sha256Hex(text: string): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((buffer) =>
      Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
}

/** SHA-256 of the current disclosure text, stored beside its version as proof. */
export function withdrawalDisclosureSha256(): Promise<string> {
  disclosureSha256 ??= sha256Hex(WITHDRAWAL_DISCLOSURE_TEXT);
  return disclosureSha256;
}

/**
 * Decides the consent for a priced cart and freezes it.
 *
 * `consent` undefined is an ENGINE-level caller that passed none (the HTTP
 * route always passes the parsed one): nothing is frozen (NULL), and a cart
 * with a personalised line is still refused — no waiver was given.
 */
export async function freezeConsent(
  consent: CheckoutConsentInput | undefined,
  personalizedItems: readonly number[],
  now: number,
): Promise<{ json: string | null; status: "ok" } | { code: ConsentRefusalCode; status: "refused" }> {
  const personalized = personalizedItems.length > 0;
  if (personalized) {
    if (consent?.withdrawalWaiver !== true) {
      return { code: "withdrawal_waiver_required", status: "refused" };
    }
    if (consent.disclosureVersion !== WITHDRAWAL_DISCLOSURE_VERSION) {
      return { code: "withdrawal_disclosure_outdated", status: "refused" };
    }
  }
  if (consent === undefined) {
    return { json: null, status: "ok" };
  }

  const frozen: FrozenConsent = {
    marketing: consent.marketing,
    recordedAt: new Date(now).toISOString(),
    // Only when ticked, so an unticked checkout freezes what it froze before.
    ...(consent.reminder === true ? { reminder: true as const } : {}),
    terms: true,
    v: 1,
    withdrawal: personalized
      ? {
          disclosureSha256: await withdrawalDisclosureSha256(),
          disclosureVersion: WITHDRAWAL_DISCLOSURE_VERSION,
          personalizedItems: [...personalizedItems],
          waived: true,
        }
      : {
          disclosureSha256: null,
          disclosureVersion: null,
          personalizedItems: [],
          waived: false,
        },
  };
  return { json: JSON.stringify(frozen), status: "ok" };
}

/** A stored consent_json, read back defensively; null when absent or unreadable. */
export function readFrozenConsent(json: string | null): FrozenConsent | null {
  if (json === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Partial<FrozenConsent>;
  const withdrawal = record.withdrawal;
  if (
    record.v !== 1 ||
    record.terms !== true ||
    typeof record.marketing !== "boolean" ||
    (record.reminder !== undefined && record.reminder !== true) ||
    typeof record.recordedAt !== "string" ||
    typeof withdrawal !== "object" ||
    withdrawal === null ||
    typeof withdrawal.waived !== "boolean" ||
    !Array.isArray(withdrawal.personalizedItems) ||
    !withdrawal.personalizedItems.every((index) => Number.isSafeInteger(index))
  ) {
    return null;
  }
  return record as FrozenConsent;
}

/**
 * THE consent rule of a reminder (CP9-AC §2.3, AC4): the checkout's OWN
 * frozen consent says `reminder: true` OR `marketing: true`. Nothing else
 * counts: a missing or unreadable consent, `terms` alone, the withdrawal
 * waiver, or another checkout of the same buyer. The cron step decides with
 * it and the mail effect asks it again before the mail is built.
 */
export function reminderConsentGiven(json: string | null): boolean {
  const frozen = readFrozenConsent(json);
  return frozen !== null && (frozen.reminder === true || frozen.marketing === true);
}

/**
 * Replay fingerprint: the same idempotency key with different consent is a
 * different request. Everything but the timestamp is compared.
 */
export function sameConsent(stored: string | null, fresh: string | null): boolean {
  if (stored === null || fresh === null) {
    return stored === fresh;
  }
  const a = readFrozenConsent(stored);
  const b = readFrozenConsent(fresh);
  if (a === null || b === null) {
    return false;
  }
  return (
    JSON.stringify({ ...a, recordedAt: "" }) === JSON.stringify({ ...b, recordedAt: "" })
  );
}

/**
 * What the webhook copies onto the order: the checkout's consent verbatim when
 * it is readable, and `is_personalized` = the buyer waived the right for at
 * least one personalised line. An unreadable consent is NOT a reason to refuse
 * a paid order: the order is created without it and keeps the full right
 * (is_personalized = 0) — the consumer-safe default.
 */
export function orderConsentOf(checkoutConsentJson: string | null): {
  consentJson: string | null;
  isPersonalized: 0 | 1;
} {
  const frozen = readFrozenConsent(checkoutConsentJson);
  if (frozen === null) {
    return { consentJson: null, isPersonalized: 0 };
  }
  return {
    consentJson: checkoutConsentJson,
    isPersonalized:
      frozen.withdrawal.waived && frozen.withdrawal.personalizedItems.length > 0 ? 1 : 0,
  };
}

/** The consent facts the shop's admin sees on an order (no hashes needed there). */
export interface AdminConsentView {
  marketing: boolean;
  recordedAt: string;
  terms: boolean;
  withdrawal: {
    disclosureVersion: string | null;
    personalizedItems: number[];
    waived: boolean;
  };
}

export function adminConsentView(json: string | null): AdminConsentView | null {
  const frozen = readFrozenConsent(json);
  return frozen === null
    ? null
    : {
        marketing: frozen.marketing,
        recordedAt: frozen.recordedAt,
        terms: frozen.terms,
        withdrawal: {
          disclosureVersion: frozen.withdrawal.disclosureVersion,
          personalizedItems: [...frozen.withdrawal.personalizedItems],
          waived: frozen.withdrawal.waived,
        },
      };
}

/** The admin order read's consent facts, tenant-scoped. */
export async function readAdminOrderConsent(
  db: D1Database,
  tenantId: string,
  orderId: string,
): Promise<{ consent: AdminConsentView | null; isPersonalized: boolean } | null> {
  const row = await db
    .prepare(
      `SELECT consent_json, is_personalized FROM orders
       WHERE order_id = ? AND tenant_id = ? LIMIT 1`,
    )
    .bind(orderId, tenantId)
    .first<{ consent_json: string | null; is_personalized: number }>();
  return row === null
    ? null
    : { consent: adminConsentView(row.consent_json), isPersonalized: row.is_personalized === 1 };
}
