// podUpload.js — POD artwork upload + measurement.
//
// CRITICAL: print originals must NEVER go through imageUpload.js
// (compressImageForUpload WebP-compresses + resizes — that destroys a print file).
// uploadPodOriginal uploads the file BYTE-FOR-BYTE via uploadBytes (mirrors
// fileUpload.uploadFile / affiliatePayouts.uploadInvoicePDF). The server pipeline
// (processPodArtwork, sharp) then derives the print PNG + web preview from it.
//
// Storage layout (shopId-partitioned, matches storage.rules pod-artwork block):
//   pod-artwork/{shopId}/originals/{ts}_{safeName}   ← untouched upload (insurance)
//   pod-artwork/{shopId}/print/{id}.png              ← THE print file (server-written)
//   pod-artwork/{shopId}/previews/{id}.webp          ← ~800px web preview (server-written)
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { storage } from '../firebase/config';

// File extension (lowercase, no dot) from a filename.
export const extOf = (name) => {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
};

const safeName = (name) => String(name || 'artwork').replace(/[^a-zA-Z0-9.-]/g, '_');

// Formats the browser's Image() can decode to read pixel dimensions + alpha.
// PDF/SVG/TIFF generally cannot be decoded this way — we degrade gracefully.
const RASTER_DECODABLE = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);

/**
 * readImageDimensions(file) → Promise<{ width, height }>
 * Natural pixel dims via the Image() DOM API. Returns { width:null, height:null }
 * for formats the browser can't decode (PDF/SVG/TIFF) or on decode error — the
 * validation engine treats null dims as "dimensions_unknown" (WARN, not crash).
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

// NOTE 2026-07-27: the web preview + print PNG are now generated SERVER-SIDE by
// the processPodArtwork callable (sharp) — the old client-canvas generatePodPreview
// is gone. The modal's pre-commit alpha probe (probeAlpha) remains client-side for
// instant feedback only.

/** SHA-256 of a file's bytes as lowercase hex — duplicate detection in the library. */
export const sha256Hex = async (file) => {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
};

/**
 * uploadPodOriginal(file, shopId, profile) → Promise<{ originalUrl, originalStoragePath, fileName, fileSizeBytes, mimeType, ext }>
 * Uploads the ORIGINAL file untouched. Hard-rejects (throws) only on a too-large
 * file vs the profile cap (a server-side guardrail before the bytes leave the
 * browser); format/quality WARN/FAIL is the validation engine's job (advisory).
 */
export const uploadPodOriginal = async (file, shopId, profile) => {
  if (!shopId) throw new Error('shopId krävs för uppladdning.');
  const ext = extOf(file.name);
  const maxBytes = (profile?.max_file_mb || 0) * 1024 * 1024;
  if (maxBytes && file.size > maxBytes) {
    throw new Error(`Filen är för stor (${(file.size / 1024 / 1024).toFixed(1)} MB, max ${profile.max_file_mb} MB).`);
  }

  const fileName = `${Date.now()}_${safeName(file.name)}`;
  const originalStoragePath = `pod-artwork/${shopId}/originals/${fileName}`;
  const snap = await uploadBytes(ref(storage, originalStoragePath), file); // NO compression
  const originalUrl = await getDownloadURL(snap.ref);

  return {
    originalUrl,
    originalStoragePath,
    fileName: file.name,
    fileSizeBytes: file.size,
    mimeType: file.type || '',
    ext,
  };
};
