// corsImage.js — the ONE loader for every image the studio DRAWS (2D canvas or
// WebGL): the garment photo, the fabric map, the mask and the motif.
//
// A drawn image must arrive with CORS approval, or the canvas is tainted and
// can never be exported. Two things break that even when the server allows the
// admin's origin:
//
//   1. CACHE FOOTGUN. The same address is shown elsewhere on the page by plain
//      <img> tags (picker, canvas, strip) WITHOUT CORS mode. The server answers
//      such a request without Access-Control-Allow-Origin, the browser caches
//      that answer, and may then serve it to the crossOrigin request here, which
//      rejects. A fixed query parameter gives the CORS variant its own cache
//      entry.
//   2. A SIGNED address (a short-lived preview from the private bucket) cannot
//      take that parameter: any added parameter changes what was signed and the
//      server answers 403. It is fetched past the cache instead and handed to
//      the image as a blob.
//
// data: and blob: addresses are untouched (no network, no CORS).

const CORS_PARAM = 'corsbust=2';

/** A signed (query-authenticated) address: nothing may be added to it. */
export const isSignedUrl = (src) => /[?&]X-Amz-Signature=/i.test(String(src ?? ''));

/** The address a drawn image is requested from (see the header). */
export const corsImageUrl = (src) => {
  if (!/^https?:/i.test(String(src ?? '')) || isSignedUrl(src)) return src;
  return `${src}${src.includes('?') ? '&' : '?'}${CORS_PARAM}`;
};

const decode = (src, message, cleanup = () => {}) => new Promise((resolve, reject) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => { cleanup(); resolve(img); };
  img.onerror = () => { cleanup(); reject(new Error(message)); };
  img.src = src;
});

/**
 * Load an image for drawing. Rejects with `message` when it cannot be read
 * (the callers' own Swedish texts; the studio tells an unreadable image apart
 * from other failures by that text).
 */
export const loadCorsImage = async (src, message = 'Kunde inte läsa bilden.') => {
  if (!isSignedUrl(src)) return decode(corsImageUrl(src), message);
  let objectUrl;
  try {
    const response = await fetch(src, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new Error(message);
    objectUrl = URL.createObjectURL(await response.blob());
  } catch {
    throw new Error(message);
  }
  return decode(objectUrl, message, () => URL.revokeObjectURL(objectUrl));
};
