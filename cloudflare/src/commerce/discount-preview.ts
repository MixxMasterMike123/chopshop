import { isCheckoutLegallyOpen } from "../legal/legal-pages";
import { isFeatureEnabled } from "../platform/tenant-config";
import type { TenantContext } from "../tenancy/resolve-tenant";
import type { CheckoutItemInput } from "./checkout";
import { parseCheckoutItems, resolveCurrency, resolveLines } from "./checkout";
import {
  isValidDiscountCode,
  normalizeDiscountCode,
  resolveDiscount,
} from "./discount-codes";

/**
 * CP8-DC — the storefront's preview of a discount code against a cart
 * (design §4.1). DISPLAY-ONLY, as Firebase's validateDiscountCode callable
 * was: it never writes, never holds a use, and is never a source of money.
 * The checkout's answer is authoritative and can only be stricter.
 *
 * What it checks: the shop's switch, the code's row, its window, its cap by
 * paid uses only (`used_count < max_uses`, no holds), its minimum, and that it
 * is worth something against these lines. What it does NOT check: other
 * buyers' holds, the fee rule (R2) and the minimum charge (R3), which depend
 * on carriage, production and other buyers.
 *
 * THE ANSWER IS UNIFORM. Every case in which the code does not apply (no such
 * code, another shop's code, inactive, not started, ended, full, minimum not
 * met, no matching line, worth nothing, the switch off) is the same body with
 * `applies: false` and the code echoed, from the same single read of the code
 * (DC11). Nothing of the code's terms leaves: not its type, value, window,
 * cap, use count or scope (the callable's full terms were an oracle, F8).
 *
 * The lines are resolved by the checkout's own resolveLines with the same
 * stand-in switch the checkout route passes, so the preview prices exactly the
 * lines a checkout would accept; a line that cannot be bought is the
 * checkout's own 422.
 *
 * CP13 (design §2.2): the body may carry the link's `refCode` beside (or
 * instead of) the typed `code`, and the SAME seam the checkout runs
 * (resolveDiscount, both switches, each gating its own family) decides: an
 * active affiliate's link code, then a typed affiliate code, then a campaign
 * code. An affiliate hit answers exactly as a campaign hit does —
 * `{ applies, code, discountMinor }` — and nothing of the affiliate (no id,
 * no rate, no reason, no `overriddenBy`) leaves the preview. `code` echoes
 * the code that applied (the link's when it won), else the typed code, else
 * the link's. The display-only rule is unchanged: no hold, no write.
 */

export interface DiscountPreviewInput {
  /** The typed code, normalized; null when only a link code was sent. */
  code: string | null;
  items: CheckoutItemInput[];
  /** CP13: the link's code, normalized, or null. */
  refCode: string | null;
}

export interface DiscountPreview {
  applies: boolean;
  code: string;
  discountMinor: number;
}

export type DiscountPreviewResult =
  | { discount: DiscountPreview; status: "ok" }
  | { status: "invalid_items" }
  | { status: "not_found" };

const PREVIEW_KEYS = ["code", "items", "refCode"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A code field: absent → null; a string that normalizes to a valid code → it; else undefined (400). */
function parseCodeField(value: unknown): string | null | undefined {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const code = normalizeDiscountCode(value);
  return isValidDiscountCode(code) ? code : undefined;
}

/**
 * `{ code?, refCode?, items }`, strict keys, at least one of the two codes
 * (CP13: `refCode` is the link's code; a body with neither is a 400 as a
 * missing `code` was). Each code is normalized (trimmed, upper case) and its
 * shape decided here, without the database: a malformed one is a 400 that
 * leaks nothing. The items are parsed exactly as the checkout parses them.
 */
export function parseDiscountPreviewInput(body: unknown): DiscountPreviewInput | null {
  if (!isPlainObject(body) || !Object.keys(body).every((key) => (PREVIEW_KEYS as readonly string[]).includes(key))) {
    return null;
  }
  const code = parseCodeField(body.code);
  const refCode = parseCodeField(body.refCode);
  if (code === undefined || refCode === undefined || (code === null && refCode === null)) {
    return null;
  }
  const items = parseCheckoutItems(body.items);
  return items === null ? null : { code, items, refCode };
}

export async function previewDiscount(
  db: D1Database,
  tenant: TenantContext,
  input: DiscountPreviewInput,
  now: number,
  refuseStandInFrames: boolean,
): Promise<DiscountPreviewResult> {
  // The checkout's own legal gate and opaque answer: a shop that cannot take
  // a checkout does not preview one either.
  if (!(await isCheckoutLegallyOpen(db, tenant.tenantId, now))) {
    return { status: "not_found" };
  }

  const lines = await resolveLines(db, tenant, input.items, refuseStandInFrames);
  if (lines === null || resolveCurrency(lines) === null) {
    return { status: "invalid_items" };
  }

  // The echo of a code that does not apply: the typed code, else the link's.
  const none: DiscountPreview = {
    applies: false,
    code: input.code ?? input.refCode ?? "",
    discountMinor: 0,
  };
  // Each family under its own switch, as the checkout reads them (CP13: an
  // affiliate-only shop previews its affiliate codes).
  const gates = {
    affiliate: await isFeatureEnabled(db, tenant.tenantId, "affiliate"),
    discountCodes:
      input.code !== null && (await isFeatureEnabled(db, tenant.tenantId, "discountCodes")),
  };
  if (!gates.affiliate && !gates.discountCodes) {
    return { discount: none, status: "ok" };
  }

  const subtotalMinor = lines.reduce((total, line) => total + line.lineTotalMinor, 0);
  const resolved = await resolveDiscount(
    db,
    tenant.tenantId,
    { ref: input.refCode, typed: input.code },
    lines,
    subtotalMinor,
    now,
    null,
    gates,
  );
  return {
    discount:
      resolved.discountMinor > 0
        ? { applies: true, code: resolved.code, discountMinor: resolved.discountMinor }
        : none,
    status: "ok",
  };
}
