// usePodLibrary for the ADMIN build (CP5 unit FM): the alias list of
// vite.admin.config.js puts this module in place of
// src/wagons/pod-wagon/components/usePodLibrary.js (the older build's,
// Firestore). Same return value: { mappings, artwork, profiles, products,
// productSkus, loading, refresh }, in the older documents' shapes
// (podLibraryLoad.js, adapters/pod.js).
//
// One load feeds the library, the mapping tab and the banner. While an
// artwork is still being processed, its detail is asked again (2 s, doubling,
// at most 10 s apart); when one has a verdict the whole library is read again
// (quietly: the list does not flash "Laddar…"). The page is mounted afresh
// when the tab's shop changes, so nothing of another shop survives here, and
// every read drops an answer that arrives after such a change.

import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { pollDelay } from '../adapters/pod.js';
import { loadPodLibrary, renderNews } from './podLibraryLoad.js';

export default function usePodLibrary(shopId) {
  const [mappings, setMappings] = useState([]);
  const [artwork, setArtwork] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [products, setProducts] = useState([]);
  const [productSkus, setProductSkus] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  const loadSeq = useRef(0);

  const load = useCallback(async ({ quiet = false } = {}) => {
    const seq = ++loadSeq.current;
    if (!quiet) setLoading(true);
    try {
      const next = await loadPodLibrary(shopId);
      if (!alive.current || seq !== loadSeq.current) return; // a newer load is under way
      setMappings(next.mappings);
      setArtwork(next.artwork);
      setProfiles(next.profiles);
      setProducts(next.products);
      setProductSkus(next.productSkus);
    } catch (e) {
      if (!alive.current || seq !== loadSeq.current) return;
      console.error('usePodLibrary load failed:', e);
      toast.error(e?.code === 'unauthenticated' ? 'Sessionen har gått ut. Logga in igen.' : 'Kunde inte ladda POD-data.');
    } finally {
      if (alive.current && seq === loadSeq.current) setLoading(false);
    }
  }, [shopId]);

  const refresh = useCallback(() => load(), [load]);

  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  // The renders still processing: look again until each has a verdict.
  const processingKey = artwork.filter((a) => a.status === 'processing').map((a) => a.id).join(',');
  useEffect(() => {
    if (!processingKey) return undefined;
    const ids = processingKey.split(',');
    let attempt = 0;
    let timer = null;
    let stopped = false;
    const tick = async () => {
      let news = false;
      try {
        news = await renderNews(shopId, ids);
      } catch {
        news = false;
      }
      if (stopped) return;
      if (news) {
        load({ quiet: true });
        return;
      }
      attempt += 1;
      timer = setTimeout(tick, pollDelay(attempt));
    };
    timer = setTimeout(tick, pollDelay(0));
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [processingKey, shopId, load]);

  return { mappings, artwork, profiles, products, productSkus, loading, refresh };
}
