// AdminPages' data layer — the OLDER build's implementation (Firebase).
//
// The page (AdminPages.jsx) reaches its data only through this module, so one
// page serves two builds: the older build (vite.config.js) uses this file as it
// is; the admin build (vite.admin.config.js) swaps it, by its alias list, for
// src/admin-app/replacements/adminPagesData.js (the API). Both files export
// the same names with the same meaning.
//
// Everything here is the page's former inline code, moved and unchanged.

import { collection, query, onSnapshot, deleteDoc, doc, where } from 'firebase/firestore';
import { db } from '../../firebase/config';

/**
 * Listens to the shop's pages. `onPages(pages)` gets every page document as
 * `{ id, ...data }` each time they change; `onError(error)` is called when the
 * listener fails. → the function that stops listening.
 */
export function subscribeToPages(shopId, onPages, onError) {
  try {
    // Scope to this shop's pages.
    const pagesQuery = query(collection(db, 'pages'), where('shopId', '==', shopId));

    const unsubscribe = onSnapshot(pagesQuery, (snapshot) => {
      const pagesData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      onPages(pagesData);
    }, (error) => {
      console.error('Error fetching pages:', error);

      // If it's an index error, try without orderBy
      if (error.code === 'failed-precondition' || error.message.includes('index')) {
        const fallbackQuery = query(collection(db, 'pages'), where('shopId', '==', shopId));

        const fallbackUnsubscribe = onSnapshot(fallbackQuery, (snapshot) => {
          const pagesData = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
          }));
          // Sort in memory if no index available
          pagesData.sort((a, b) => {
            const aTime = a.updatedAt?.toMillis?.() || 0;
            const bTime = b.updatedAt?.toMillis?.() || 0;
            return bTime - aTime;
          });
          onPages(pagesData);
        }, (fallbackError) => {
          console.error('Fallback query also failed:', fallbackError);
          onError(fallbackError);
        });

        return () => fallbackUnsubscribe();
      } else {
        onError(error);
      }
    });

    return () => unsubscribe();
  } catch (error) {
    console.error('Error setting up pages query:', error);
    onError(error);
    return () => {};
  }
}

export async function deleteShopPage(pageId) {
  await deleteDoc(doc(db, 'pages', pageId));
}
