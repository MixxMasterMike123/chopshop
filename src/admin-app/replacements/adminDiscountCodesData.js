// AdminDiscountCodes' data layer — the ADMIN build's implementation (the API,
// CP8-DC). The alias list of vite.admin.config.js puts this file where the
// page imports src/pages/admin/adminDiscountCodesData.js (the older build's,
// Firebase). Same names, same meaning; the shapes are bridged by
// adapters/discountCode.js.
//
// Differences the page shows: no delete (SUPPORTS_DELETE false: a code is
// deactivated, never deleted, DC12); the dates are Stockholm days and the end
// day counts in full (DC15); a clash of names or a new name for a used code
// is the server's 409, thrown with its code ('conflict' |
// 'discount_code_in_use').

import { createDiscountCode, listDiscountCodes, updateDiscountCode } from '../../api/admin/discountCodes.js';
import { listAllProducts } from '../../api/admin/products.js';
import {
  dayStartMs,
  discountCodeBodyFromForm,
  discountCodeRowFromApi,
  formatStockholmDay,
  stockholmDayOf,
} from '../adapters/discountCode.js';

export const SUPPORTS_DELETE = false;

/** Trimmed and upper case, as the Worker stores and looks it up. */
export function normalizeCode(raw) {
  return String(raw ?? '').trim().toUpperCase();
}

/** The shop's codes as the page's rows, newest first. */
export async function loadDiscountCodes(shopId) {
  const { discountCodes } = await listDiscountCodes({ shopId });
  return discountCodes.map(discountCodeRowFromApi).filter(Boolean);
}

/** The products the scope picker offers: every product not archived, by name. */
export async function loadDiscountProducts(shopId) {
  const products = await listAllProducts({ shopId });
  return products
    .filter((product) => product.status !== 'archived')
    .map((product) => ({ id: product.productId, name: product.name, sku: product.sku }))
    .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'sv'));
}

function refusalOf(error) {
  if (error?.status === 409) {
    const code = error.code === 'discount_code_in_use' ? 'discount_code_in_use' : 'conflict';
    return Object.assign(new Error(code), { code });
  }
  return error;
}

/** Creates (`id` null) or saves a code from the page's validated form. */
export async function saveDiscountCode({ shopId, id, form }) {
  const body = discountCodeBodyFromForm(form);
  try {
    if (id) await updateDiscountCode(id, body, { shopId });
    else await createDiscountCode(body, { shopId });
  } catch (error) {
    throw refusalOf(error);
  }
}

export async function setDiscountCodeActive(shopId, row, active) {
  await updateDiscountCode(row.id, { active }, { shopId });
}

/** Never called (SUPPORTS_DELETE is false): the API has no delete. */
export async function deleteDiscountCode() {
  throw new Error('A discount code is deactivated, never deleted');
}

/** An instant (ms) → the Stockholm day for <input type="date">. */
export function tsToInput(ms) {
  return ms == null ? '' : stockholmDayOf(ms);
}

/** `YYYY-MM-DD` → the day's first instant in Stockholm (a Date), or null. */
export function inputToDate(day) {
  const ms = dayStartMs(day);
  return ms === null ? null : new Date(ms);
}

/** An instant (ms) → the Stockholm day as the list shows it. */
export function fmtDate(ms) {
  return ms == null ? '' : formatStockholmDay(ms);
}
