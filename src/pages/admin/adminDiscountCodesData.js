// AdminDiscountCodes' data layer — the OLDER build's implementation (Firebase).
//
// The page (AdminDiscountCodes.jsx) reaches its data only through this module,
// so one page serves two builds: the older build (vite.config.js) uses this
// file as it is; the admin build (vite.admin.config.js) swaps it, by its alias
// list, for src/admin-app/replacements/adminDiscountCodesData.js (the API).
// Both files export the same names with the same meaning.
//
// Everything here is the page's former inline code, moved and unchanged. The
// one difference of form: a name that clashes is thrown as `{ code: 'conflict' }`
// for the page to say so, where the page used to say it itself.

import { db } from '../../firebase/config';
import {
  collection,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  query,
  where,
  orderBy,
  serverTimestamp,
} from 'firebase/firestore';
import { withShopId } from '../../config/withShopId';
import { normalizeAffiliateCode } from '../../utils/affiliateCalculations';

export const SUPPORTS_DELETE = true;

export const normalizeCode = normalizeAffiliateCode;

export async function loadDiscountCodes(shopId) {
  const codesQuery = query(
    collection(db, 'discountCodes'),
    where('shopId', '==', shopId),
    orderBy('createdAt', 'desc')
  );
  const snap = await getDocs(codesQuery);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// Products for the scope='products' picker (active only, name-sorted) —
// same pattern as CampaignCreate.fetchProducts.
export async function loadDiscountProducts(shopId) {
  const productsQuery = query(
    collection(db, 'products'),
    where('shopId', '==', shopId),
    orderBy('name', 'asc')
  );
  const pSnap = await getDocs(productsQuery);
  return pSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((p) => p.isActive !== false);
}

export async function saveDiscountCode({ shopId, id: editingId, form }) {
  const normalizedCode = form.code;
  // Uniqueness (code, shopId) enforced app-layer: query before create.
  // On edit, an identical code on the SAME doc is allowed.
  const dupQuery = query(
    collection(db, 'discountCodes'),
    where('shopId', '==', shopId),
    where('code', '==', normalizedCode)
  );
  const dupSnap = await getDocs(dupQuery);
  const clash = dupSnap.docs.find((d) => d.id !== editingId);
  if (clash) {
    throw Object.assign(new Error('conflict'), { code: 'conflict' });
  }

  const startsAt = inputToDate(form.startsDay);
  const endsAt = inputToDate(form.endsDay);
  const payload = {
    code: normalizedCode,
    type: form.type,
    value: form.value,
    scope: form.scope,
    productIds: form.scope === 'products' ? form.productIds : [],
    minSpend: form.minSpend,
    startsAt: startsAt || null,
    endsAt: endsAt || null,
    maxUses: form.maxUses,
    active: !!form.active,
  };

  if (editingId) {
    await updateDoc(doc(db, 'discountCodes', editingId), payload);
  } else {
    await addDoc(
      collection(db, 'discountCodes'),
      withShopId(
        {
          ...payload,
          usedCount: 0,
          createdAt: serverTimestamp(),
        },
        shopId
      )
    );
  }
}

export async function setDiscountCodeActive(_shopId, c, active) {
  await updateDoc(doc(db, 'discountCodes', c.id), { active });
}

export async function deleteDiscountCode(_shopId, c) {
  await deleteDoc(doc(db, 'discountCodes', c.id));
}

// Firestore Timestamp | Date | null → YYYY-MM-DD for <input type="date">.
export function tsToInput(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : ts instanceof Date ? ts : null;
  if (!d) return '';
  return d.toISOString().slice(0, 10);
}
// YYYY-MM-DD string → Date (local midnight) | null.
export function inputToDate(s) {
  if (!s) return null;
  const d = new Date(`${s}T00:00:00`);
  return isNaN(d.getTime()) ? null : d;
}
// Firestore Timestamp | Date | null → localized display date.
export function fmtDate(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : ts instanceof Date ? ts : null;
  if (!d) return '';
  return d.toLocaleDateString('sv-SE');
}
