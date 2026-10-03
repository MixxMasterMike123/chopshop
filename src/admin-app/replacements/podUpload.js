// src/utils/podUpload.js for the ADMIN build (CP5 unit FM). The measuring
// helpers are the original's, copied (the original imports Firebase Storage,
// so it cannot be imported here); the upload goes to the object store as a
// PRIVATE `artwork_original` object (src/api/admin/uploads.js: sha256 →
// reserve → bytes), byte for byte, never recompressed. The print file and the
// preview are made by the server's render pipeline, not here.

import { uploadObject } from '../../api/admin/uploads.js';

// File extension (lowercase, no dot) from a filename.
export const extOf = (name) => {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
};

// Formats the browser's Image() can decode to read pixel dimensions.
const RASTER_DECODABLE = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);

/**
 * readImageDimensions(file) → Promise<{ width, height }>
 * Natural pixel dims via the Image() DOM API; { width: null, height: null }
 * for formats the browser can't decode (PDF/SVG/TIFF) or on decode error.
 * Shown to the seller only: the server measures for the verdict.
 */
export const readImageDimensions = (file) =>
  new Promise((resolve) => {
    if (!RASTER_DECODABLE.has(extOf(file.name))) {
      resolve({ width: null, height: null });
      return;
    }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const out = { width: img.naturalWidth || null, height: img.naturalHeight || null };
      URL.revokeObjectURL(url);
      resolve(out);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ width: null, height: null });
    };
    img.src = url;
  });

/** SHA-256 of a file's bytes as lowercase hex — duplicate detection in the library. */
export const sha256Hex = async (file) => {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
};

/**
 * uploadPodOriginal(file, shopId, profile) → { objectId, fileName, fileSizeBytes, mimeType, ext }
 * The original, untouched, as a private object of the shop. Refuses (throws)
 * before sending only a file over the profile's own size cap; the format and
 * the print quality are the server's verdict.
 */
export const uploadPodOriginal = async (file, shopId, profile) => {
  if (!shopId) throw new Error('shopId krävs för uppladdning.');
  const maxBytes = (profile?.max_file_mb || 0) * 1024 * 1024;
  if (maxBytes && file.size > maxBytes) {
    throw new Error(`Filen är för stor (${(file.size / 1024 / 1024).toFixed(1)} MB, max ${profile.max_file_mb} MB).`);
  }
  const { objectId } = await uploadObject(file, { kind: 'artwork_original', shopId });
  return {
    objectId,
    originalUrl: null,
    originalStoragePath: null,
    fileName: file.name,
    fileSizeBytes: file.size,
    mimeType: file.type || '',
    ext: extOf(file.name),
  };
};
