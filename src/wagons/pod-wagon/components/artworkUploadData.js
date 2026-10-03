// ArtworkUploadModal's data layer: the OLDER build's implementation
// (Firebase). The code below moved here unchanged from ArtworkUploadModal.jsx
// (CP5 unit FM), so the modal is the same file in both builds; the Cloudflare
// admin's build aliases this module to
// src/admin-app/replacements/podArtworkUploadData.js (vite.admin.config.js),
// which exports the same names.
import { httpsCallable } from 'firebase/functions';
import { uploadPodOriginal } from '../../../utils/podUpload';
import { gateArtwork } from '../../../utils/podValidation';
import { createArtwork, replaceArtworkFile } from '../../../utils/podArtwork';
import { auth, functions } from '../../../firebase/config';

/** The CLIENT pre-check (instant feedback; the server rules at save). */
export const precheckArtwork = (measured, profile) => gateArtwork(measured, profile);

/** What the modal says after a successful upload. */
export const CREATED_NEXT_STEP =
  'Originalet finns nu i biblioteket. Välj det i Designstudion; motiv och placering kopplas automatiskt till produkten när du publicerar.';

/** Never said in this build (the callable answers with the verdict); the modal imports it. */
export const PENDING_NOTE = 'Originalet bearbetas fortfarande.';

/**
 * Upload original → processPodArtwork callable (sharp: PNG-convert, trim,
 * sRGB, authoritative gate, writes print PNG + preview) → on PASS create (or
 * replace) the podArtwork doc; on FAIL nothing persists.
 *   → { rejected: true, reasons } | { replaced: true } | { artworkId, notices }
 */
export const saveArtworkUpload = async ({ file, shopId, profile, label, sha256, replaceTarget = null }) => {
  const isReplace = !!replaceTarget;
  const original = await uploadPodOriginal(file, shopId, profile);
  // The AUTHORITATIVE gate + conversion (sharp). On reject the server has
  // already deleted the uploaded original — nothing persists.
  const call = httpsCallable(functions, 'processPodArtwork');
  const { data: result } = await call({
    shopId,
    originalStoragePath: original.originalStoragePath,
    profileId: profile.id,
  });

  if (!result?.ok) {
    return { rejected: true, reasons: result?.reasons || [{ code: 'unknown', message: 'Filen godkändes inte.' }] };
  }

  const fileFields = {
    originalUrl: original.originalUrl,
    originalStoragePath: original.originalStoragePath,
    fileName: original.fileName,
    fileSizeBytes: original.fileSizeBytes,
    mimeType: original.mimeType,
    ext: original.ext,
    sha256: sha256 || null,
    rightsConfirmed: true,
    ...result.fields, // status/printUrl/printStoragePath/previewUrl/previewStoragePath/sourceWidthPx/sourceHeightPx/validation
  };

  if (isReplace) {
    await replaceArtworkFile(replaceTarget, {
      ...fileFields,
      ...(label.trim() ? { label: label.trim() } : {}),
    });
    return { replaced: true };
  }

  const newId = await createArtwork({
    label: label.trim() || file.name,
    purpose: profile.id,
    ...fileFields,
    createdBy: auth.currentUser?.uid || null,
  }, shopId);
  return { artworkId: newId, notices: result.notices || [] };
};
