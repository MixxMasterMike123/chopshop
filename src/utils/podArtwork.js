// podArtwork.js — Firestore CRUD for the per-shop POD artwork library.
//
// Collection: podArtwork/{id}. Every read query is scoped where('shopId','==',shopId)
// (the firestore.rules podArtwork block — Slice 3 — enforces this at the rules layer
// too; the query scoping is the app-side complement, not the security boundary).
// Mirrors the data-access style of utils/marketingMaterials.js.
import {
  collection, doc, addDoc, getDoc, getDocs, deleteDoc, updateDoc, query, where, orderBy, serverTimestamp,
} from 'firebase/firestore';
import { ref, deleteObject } from 'firebase/storage';
import { db, storage } from '../firebase/config';
import { withShopId } from '../config/withShopId';
import { DEFAULT_SHOP_ID } from '../config/tenancy';

const COL = 'podArtwork';

/** Create an artwork doc (stamps shopId). `data` already holds the upload + validation result. */
export const createArtwork = async (data, shopId) => {
  const docRef = await addDoc(
    collection(db, COL),
    withShopId({ ...data, createdAt: serverTimestamp() }, shopId)
  );
  return docRef.id;
};

/** List a shop's artwork, newest first. */
export const listArtwork = async (shopId) => {
  const q = query(
    collection(db, COL),
    where('shopId', '==', shopId || DEFAULT_SHOP_ID),
    orderBy('createdAt', 'desc')
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
};

/** Get one artwork by id (or null). */
export const getArtwork = async (id) => {
  const snap = await getDoc(doc(db, COL, id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
};

/**
 * Count podMappings (in this shop) that still reference an artworkId. Used by the
 * delete soft-guard so we never silently dangle a mapping → printer-no-file.
 */
export const mappingsReferencing = async (artworkId, shopId) => {
  const q = query(
    collection(db, 'podMappings'),
    where('shopId', '==', shopId || DEFAULT_SHOP_ID),
    where('artworkId', '==', artworkId)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
};

/**
 * Replace an artwork's FILE in place, non-destructively for the mapping graph.
 * Updates the SAME podArtwork doc (same id → every mapping keeps pointing at it,
 * so all products using this original — including unshipped orders in the print
 * queue — pick up the new file) with the new upload + validation fields, THEN
 * best-effort deletes the OLD storage objects. The doc id + shopId + purpose are
 * unchanged; only the file + measured/validation fields move.
 *
 * @param {object} artwork  the existing artwork doc (must have .id and old storage paths)
 * @param {object} fields   the new upload+validation fields (same shape createArtwork receives,
 *                          minus createdAt/createdBy): originalUrl/originalStoragePath/previewUrl/
 *                          previewStoragePath/fileName/fileSizeBytes/mimeType/ext/sourceWidthPx/
 *                          sourceHeightPx/validation. `label`/`purpose` are preserved unless passed.
 */
export const replaceArtworkFile = async (artwork, fields) => {
  if (!artwork?.id) throw new Error('Artwork-id saknas.');
  const oldOriginal = artwork.originalStoragePath;
  const oldPreview = artwork.previewStoragePath;

  await updateDoc(doc(db, COL, artwork.id), {
    ...fields,
    updatedAt: serverTimestamp(),
  });

  // Best-effort cleanup of the OLD objects — only if the new paths actually differ
  // (never delete the file we just pointed the doc at). Non-fatal on failure.
  // NOTE: print/ files are SERVER-OWNED (P1-17, storage.rules denies client
  // delete) — old print PNGs are intentionally NOT deleted here. They are
  // orphaned bytes until a server-side sweep exists; a paid order's production
  // file must never be client-deletable.
  const newOriginal = fields.originalStoragePath;
  const newPreview = fields.previewStoragePath;
  for (const [oldPath, newPath] of [[oldOriginal, newOriginal], [oldPreview, newPreview]]) {
    if (!oldPath || oldPath === newPath) continue;
    try {
      await deleteObject(ref(storage, oldPath));
    } catch (e) {
      console.warn('podArtwork: could not delete OLD storage object after replace', oldPath, e?.message);
    }
  }
};

/**
 * Delete an artwork (doc + original + preview from Storage). SOFT GUARD: if any
 * podMapping still references it, throws with the offending SKUs so the caller can
 * tell the seller to remove the mapping first (prevents a silent printer-no-file).
 * Pass { force:true } to delete anyway (e.g. after the mappings are cleared).
 */
export const deleteArtwork = async (artwork, shopId, { force = false } = {}) => {
  if (!artwork?.id) throw new Error('Artwork-id saknas.');

  if (!force) {
    const refs = await mappingsReferencing(artwork.id, shopId);
    if (refs.length > 0) {
      const skus = refs.map((m) => m.sku).filter(Boolean).join(', ');
      const err = new Error(
        `Detta original är kopplat till ${refs.length} SKU${refs.length > 1 ? ':n' : ''}${skus ? ` (${skus})` : ''}. ` +
        `Ta bort kopplingen först.`
      );
      err.code = 'pod/artwork-in-use';
      err.mappings = refs;
      throw err;
    }
  }

  // Best-effort Storage cleanup (non-fatal if a path is already gone).
  // print/ files are SERVER-OWNED (P1-17) — excluded; the rule would deny it.
  for (const path of [artwork.originalStoragePath, artwork.previewStoragePath]) {
    if (!path) continue;
    try {
      await deleteObject(ref(storage, path));
    } catch (e) {
      console.warn('podArtwork: could not delete storage object', path, e?.message);
    }
  }

  await deleteDoc(doc(db, COL, artwork.id));
};
