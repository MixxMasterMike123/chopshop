// src/pages/platform/platformModelsData.js for the ADMIN build (CP5 unit FO):
// the alias list of vite.admin.config.js puts this module in place of the
// older build's (Firebase). Everything is platformModelsCore.js (the API, the
// cache, the read-back of a lost answer; tested under Node) but the browser
// half of a colourway's upload, here because it draws on a canvas.
//
// The upload: the same checks and the same web derivatives as the older build
// (src/utils/pod3dUpload.js: validateModelAssetSet, makeWebDerivative,
// measureMapContrastSd, unchanged), then each derivative as a studio file
// (POST /v1/platform/pod/studio-files). The raw originals are not sent: the
// Worker has no home for them. Their size (`original`) is still stored as the
// view's originalDims and still checks the next colourway. The canvases read
// only the operator's own files (blob: addresses, same origin): no image of
// the public bucket is read back into a canvas on this page.

import { makeWebDerivative, measureMapContrastSd, validateModelAssetSet } from '../../utils/pod3dUpload.js';
import { uploadPreparedColorway } from './platformModelsCore.js';

export * from './platformModelsCore.js';

/**
 * uploadModelColorwayAssets({ modelId, viewId, colorwayId, photoFile,
 *   displacementFile, maskFile?, expectedOriginalDims? })
 *   → Promise<{ photoUrl, displacementUrl, maskUrl?, fileIds, derivative, original, mapContrastSd }>
 */
export const uploadModelColorwayAssets = async ({
  modelId,
  viewId,
  colorwayId,
  photoFile,
  displacementFile,
  maskFile,
  expectedOriginalDims,
} = {}) => {
  if (!modelId) throw new Error('Modell-id saknas.');
  if (!viewId) throw new Error('Vy-id saknas.');
  if (!colorwayId) throw new Error('Färgväg-id saknas.');
  if (!photoFile) throw new Error('Fotofil saknas.');
  if (!displacementFile) throw new Error('Displacement-karta saknas.');

  // 1) Registration gate (also vs the view's existing original dims when given).
  const original = await validateModelAssetSet({ photoFile, displacementFile, maskFile }, expectedOriginalDims);

  // 2) The web derivatives (what the studio renders, and all that is sent).
  const photo = await makeWebDerivative(photoFile);
  const map = await makeWebDerivative(displacementFile);
  // Originals shared dims + deterministic downscale ⇒ derivatives share dims. Assert.
  if (photo.w !== map.w || photo.h !== map.h) {
    throw new Error(
      `Internt fel: foto- och kart-derivaten fick olika pixelmått ` +
      `(${photo.w}×${photo.h} vs ${map.w}×${map.h}).`
    );
  }
  // Measured on the map's derivative canvas (the exact pixels the studio warps with).
  const mapContrastSd = map.canvas ? measureMapContrastSd(map.canvas) : null;
  const mask = maskFile ? await makeWebDerivative(maskFile) : null;

  // 3) Each derivative as a studio file (refused before any request when over the cap).
  return uploadPreparedColorway({ photo, map, mask, original, mapContrastSd });
};
