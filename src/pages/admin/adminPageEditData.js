// AdminPageEdit's data layer — the OLDER build's implementation (Firebase).
//
// The page (AdminPageEdit.jsx) reaches its data only through this module; the
// admin build swaps it, by its alias list, for
// src/admin-app/replacements/adminPageEditData.js (the API). Both export the
// same names with the same meaning. Everything here is the page's former
// inline code, moved and unchanged.

import { doc, getDoc, setDoc, serverTimestamp, addDoc, collection } from 'firebase/firestore';
import { db } from '../../firebase/config';
import { withShopId } from '../../config/withShopId';
import { saveShopConfig } from '../../config/shopConfig';
import { isLegalSlug } from '../../config/legalTemplates';

/** The page has an attachments tab (the file controls live in PageAttachments.jsx). */
export const ATTACHMENTS_ENABLED = true;

/** The page document (its fields), or null when it does not exist. */
export async function loadPage(id) {
  const pageDoc = await getDoc(doc(db, 'pages', id));
  return pageDoc.exists() ? pageDoc.data() : null;
}

/**
 * Writes the page (a new one when `isNewPage`). `formData` is the form as the
 * page holds it, `newStatus` the status being saved. → the id of the page.
 */
export async function savePage({ id, isNewPage, formData, newStatus, currentUser, shopId }) {
  const pageData = {
    ...formData,
    status: newStatus,
    updatedAt: serverTimestamp(),
    updatedBy: currentUser?.uid || '',
    ...(isNewPage && {
      createdAt: serverTimestamp(),
                  createdBy: currentUser?.uid || ''
    })
  };

  // Editing a legal page invalidates the seller's last acceptance — stamp
  // storeIdentity.legal.customUpdatedAt so needsLegalReacceptance() flags it
  // in AdminSettings + on the platform. Never let this fail the page save.
  //
  // Only on a PUBLISHED save: a draft doesn't change what the storefront
  // serves, and stamping on every autosave-to-draft would train the seller
  // to click past a re-acceptance notice that means nothing.
  const stampLegalEdit = async () => {
    if (!isLegalSlug(formData.slug) || newStatus !== 'published') return;
    try {
      await saveShopConfig({ legal: { customUpdatedAt: new Date().toISOString() } }, shopId);
    } catch (e) {
      console.error('Could not stamp legal.customUpdatedAt:', e);
    }
  };

  if (isNewPage) {
    // For new pages, use addDoc to generate a unique ID
    const docRef = await addDoc(collection(db, 'pages'), withShopId(pageData, shopId));
    const pageId = docRef.id;
    await stampLegalEdit();
    return pageId;
  }
  // For existing pages, use setDoc with the existing ID. This is a FULL
  // overwrite (not merge), so we must re-stamp shopId or it would be
  // stripped from an already-tagged doc.
  await setDoc(doc(db, 'pages', id), withShopId(pageData, shopId));
  await stampLegalEdit();
  return id;
}
