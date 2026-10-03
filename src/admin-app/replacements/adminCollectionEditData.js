// AdminCollectionEdit's data layer — the ADMIN build's implementation (the API).
// The alias list of vite.admin.config.js puts this file where the page imports
// src/pages/admin/adminCollectionEditData.js (the older build's, Firebase).
// Same names, same meaning; the shapes are bridged by adapters/content.js.
//
//   picker       GET /v1/admin/products + each product's tags (contentSources.js)
//   open         GET /v1/admin/collections/:id
//   handle       the list's handles (the route's 409 handle_taken is the backstop)
//   cover        uploads.js, kind product_media → the object id is kept beside
//                the address and written (imageObjectId) only when it changed
//   save         POST (created UNPUBLISHED) → PUT …/products → PATCH published,
//                undone by a DELETE if the members are refused; or PATCH →
//                PUT …/products for an existing one
//   delete       DELETE

import { AdminApiError } from '../../api/admin/client.js';
import {
  COLLECTION_PRODUCTS_MAX, createCollection, deleteCollection as deleteApiCollection, getCollection,
  listAllCollections, setCollectionProducts, updateCollection,
} from '../../api/admin/content.js';
import { uploadObject } from '../../api/admin/uploads.js';
import {
  collectionBody, collectionFormFromApi, collectionLimitProblem, collectionRefusal, membersChanged,
  pickerProductFromApi, tagsOf, uploadRefusal,
} from '../adapters/content.js';
import { loadProductsWithTags } from './contentSources.js';

// Address → object id of the covers uploaded in this tab.
const uploaded = new Map();

/** An Error the page shows as its toast (`userMessage`), keeping the cause. */
function sayable(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.userMessage = message;
  return error;
}

export async function loadPickerProducts(shopId) {
  const rows = await loadProductsWithTags(shopId);
  const products = rows.map(({ item, tags }) => pickerProductFromApi(item, tags)).filter(Boolean);
  products.sort((a, b) => String(a.name).localeCompare(String(b.name), 'sv'));
  return { products, availableTags: tagsOf(products) };
}

export async function loadCollection(id) {
  return collectionFormFromApi(await getCollection(id));
}

export async function handleIsTaken(shopId, handle, id) {
  const all = await listAllCollections({ shopId });
  return all.some((c) => c.handle === handle && c.collectionId !== id);
}

export async function uploadCollectionCover(file, shopId) {
  try {
    const { objectId, url } = await uploadObject(file, { kind: 'product_media', shopId });
    if (typeof url !== 'string' || url === '') throw sayable('Bilden laddades upp men kan inte visas ännu.');
    uploaded.set(url, objectId);
    return url;
  } catch (error) {
    if (error?.userMessage) throw error;
    const message = error instanceof AdminApiError ? uploadRefusal(error) : null;
    throw message ? sayable(message, error) : error;
  }
}

function coverToWrite(data, form) {
  if (data.imageUrl === (form?.savedImageUrl ?? '')) return undefined; // not touched: the stored cover stays
  if (data.imageUrl === '') return null;
  const objectId = uploaded.get(data.imageUrl);
  if (!objectId) throw sayable('Bilden kan inte användas som omslag. Ladda upp den igen.');
  return objectId;
}

export async function saveCollection({ id, isNew, shopId, data, form }) {
  const problem = collectionLimitProblem(data);
  if (problem) throw sayable(problem);
  if (data.type === 'manual' && data.productIds.length > COLLECTION_PRODUCTS_MAX) {
    throw sayable(`En samling får ha högst ${COLLECTION_PRODUCTS_MAX} produkter.`);
  }
  const imageObjectId = coverToWrite(data, form);
  const refuse = (error) => {
    const message = error instanceof AdminApiError ? collectionRefusal(error, data) : null;
    return message ? sayable(message, error) : error;
  };

  if (isNew) {
    let created;
    try {
      created = await createCollection(collectionBody(data, { imageObjectId, forCreate: true }), { shopId });
    } catch (error) {
      throw refuse(error);
    }
    const newId = created.collectionId;
    try {
      if (data.type === 'manual' && data.productIds.length > 0) await setCollectionProducts(newId, data.productIds, { shopId });
      if (data.published === true) await updateCollection(newId, { published: true }, { shopId });
    } catch (error) {
      // Nothing half-made is left behind: the new collection is removed again.
      await deleteApiCollection(newId, { shopId }).catch(() => {});
      throw refuse(error);
    }
    return newId;
  }

  try {
    await updateCollection(id, collectionBody(data, { imageObjectId }), { shopId });
  } catch (error) {
    throw refuse(error);
  }
  if (data.type === 'manual' && (form?.savedType !== 'manual' || membersChanged(data.productIds, form?.savedProductIds))) {
    try {
      await setCollectionProducts(id, data.productIds, { shopId });
    } catch (error) {
      const refused = refuse(error);
      throw refused.userMessage
        ? sayable(`Samlingen sparades, men produktlistan kunde inte sparas. ${refused.userMessage}`, error)
        : sayable('Samlingen sparades, men produktlistan kunde inte sparas. Försök igen.', error);
    }
  }
  return id;
}

export async function deleteCollection(id) {
  await deleteApiCollection(id);
}
