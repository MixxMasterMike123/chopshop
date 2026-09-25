// Reads the platform blocklist (settings/contentScreening) for the client-side
// publish notice (SnapWear A11). Kept apart from the PURE matcher in
// contentScreening.js so that module stays firebase-free for the parity test.
//
// Best-effort by design: the notice is advisory — the screenProductOnWrite
// trigger is what actually stamps the product — so a missing doc or a failed
// read returns an empty list and publishing carries on.
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase/config';

export const loadScreeningBlocklist = async () => {
  try {
    const snap = await getDoc(doc(db, 'settings', 'contentScreening'));
    return snap.exists() && Array.isArray(snap.data().blocklist) ? snap.data().blocklist : [];
  } catch (e) {
    console.warn('contentScreening: blocklist unavailable, skipping the notice', e);
    return [];
  }
};
