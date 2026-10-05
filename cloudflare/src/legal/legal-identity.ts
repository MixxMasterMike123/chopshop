import { realShopAddress } from "../email/order-emails";
import { readTenantSettings } from "../platform/tenant-config";

/**
 * CP9-OB — the seller's identity the legal pages print, and the placeholders
 * that are never a shop's own identity.
 *
 * THE PLACEHOLDERS. The older admin shipped six identity texts as defaults
 * (src/config/store.js until CP9-OB) and saved its whole form, defaults
 * included; the import carried them (melodie-mc holds "My Company" and
 * "My Company<br>123 Main Street<br>City", three shops "hello@example.com").
 * A value that IS one of them (compared without tags, spaces and case), or an
 * address at a placeholder domain (`realShopAddress`, the order mails' rule),
 * is not set: the public projection drops it (identity-projection.ts) and the
 * act of adopting counts it as missing (below). The list is pinned to the
 * frontend's copy by src/admin-app/adapters/placeholderIdentity.test.mjs.
 *
 * THE RULE OF ADOPTING. The three templates (src/config/legalTemplates.js)
 * print the seller's legal name, postal address and contact address on every
 * page; the organisation number in the company branch; the VAT number in the
 * company branch when VAT-registered (köpvillkor §1). The return address and
 * the VAT answer are the checkout's own conditions (legal-pages.ts
 * readLegalReadiness) and are not repeated here. A NEW adoption is refused
 * while any of these is missing (POST /v1/admin/legal/accept-pages, 409
 * legal_identity_incomplete). An adoption already made is never judged by it:
 * the checkout's gate is not changed.
 */

export const PLACEHOLDER_IDENTITY_TEXTS: readonly string[] = [
  "My Shop",
  "My Company",
  "Quality products, delivered.",
  "hello@example.com",
  "My Company<br>123 Main Street<br>City",
];

function normalized(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

const PLACEHOLDERS = new Set(PLACEHOLDER_IDENTITY_TEXTS.map(normalized));

/** True when `value` is one of the placeholder texts. */
export function isPlaceholderText(value: string): boolean {
  return PLACEHOLDERS.has(normalized(value));
}

/** An address at a placeholder domain (the domains `realShopAddress` refuses). */
export function isPlaceholderAddress(value: string): boolean {
  return /@example\.(com|org|net|se)$/i.test(value.trim());
}

/** A text the shop really set: a string with something in it that is not a placeholder. */
export function isRealText(value: unknown): value is string {
  return typeof value === "string" && normalized(value) !== "" && !isPlaceholderText(value);
}

/** The fields, in the order the adopt control names them. */
export const LEGAL_IDENTITY_FIELDS = ["legalName", "address", "supportEmail", "orgNumber", "vatNumber"] as const;

export type LegalIdentityField = (typeof LEGAL_IDENTITY_FIELDS)[number];

/** What a shop's stored identity lacks for the pages to print no hole (empty: nothing). */
export async function readLegalIdentityGaps(db: D1Database, tenantId: string): Promise<LegalIdentityField[]> {
  const [settings, tenant] = await Promise.all([
    readTenantSettings(db, tenantId),
    db
      .prepare("SELECT support_email FROM tenants WHERE tenant_id = ? LIMIT 1")
      .bind(tenantId)
      .first<{ support_email: string | null }>(),
  ]);
  const identity = settings.storeIdentity;
  const company = settings.sellerType === "company";
  const held: Record<LegalIdentityField, boolean> = {
    address: isRealText(identity.address),
    legalName: isRealText(identity.legalName),
    orgNumber: !company || isRealText(identity.orgNumber),
    supportEmail: realShopAddress(tenant?.support_email ?? null) !== null,
    vatNumber: !company || settings.vatRegistered !== true || isRealText(settings.vatNumber),
  };
  return LEGAL_IDENTITY_FIELDS.filter((field) => !held[field]);
}
