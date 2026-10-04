// The shop's campaign discount codes, "Rabattkoder" (CP8-DC; the Worker:
// cloudflare/src/app.ts handleAdminDiscountCodeRoute and
// cloudflare/src/commerce/admin-discount-codes.ts).
//
//   GET   /v1/admin/discount-codes       { discountCodes: AdminDiscountCode[], truncated }
//                                        newest first, at most 200
//   POST  /v1/admin/discount-codes       201 { discountCode } · 400 · 409 conflict (the name is taken)
//   GET   /v1/admin/discount-codes/:id   { discountCode } · 404
//   PATCH /v1/admin/discount-codes/:id   { discountCode } · 400 · 404
//                                        · 409 conflict | discount_code_in_use (a used or held code keeps its name)
//
// There is no DELETE: a code is deactivated (`active: false`), never deleted.
// Every route answers the opaque 404 while the shop's add-on is off.
//
// AdminDiscountCode: { discountCodeId, code, active, type: 'percent' | 'fixed',
//   percentBp | null, valueMinor | null, scope: 'all' | 'products',
//   productIds | null, minSpendMinor | null, startsAt | null, endsAt | null
//   (ms epoch), maxUses | null, usedCount, heldCount }.
// Every request carries X-Shop-Id (adminRequest).

import { adminRequest, segment } from './client.js';

export const DISCOUNT_CODES_PATH = '/v1/admin/discount-codes';

const codePath = (discountCodeId) => `${DISCOUNT_CODES_PATH}/${segment(discountCodeId)}`;

/** The shop's codes. → { discountCodes, truncated } */
export async function listDiscountCodes({ shopId, signal } = {}) {
  const { data } = await adminRequest('GET', DISCOUNT_CODES_PATH, { shopId, signal });
  return {
    discountCodes: Array.isArray(data?.discountCodes) ? data.discountCodes : [],
    truncated: data?.truncated === true,
  };
}

/** One code, or null on the opaque 404. */
export async function getDiscountCode(discountCodeId, { shopId, signal } = {}) {
  try {
    const { data } = await adminRequest('GET', codePath(discountCodeId), { shopId, signal });
    return data?.discountCode ?? null;
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

/** Creates a code. → the stored code. */
export async function createDiscountCode(body, { shopId } = {}) {
  const { data } = await adminRequest('POST', DISCOUNT_CODES_PATH, { shopId, json: body });
  return data.discountCode;
}

/** Edits a code (any subset of the create keys). → the stored code. */
export async function updateDiscountCode(discountCodeId, body, { shopId } = {}) {
  const { data } = await adminRequest('PATCH', codePath(discountCodeId), { shopId, json: body });
  return data.discountCode;
}
