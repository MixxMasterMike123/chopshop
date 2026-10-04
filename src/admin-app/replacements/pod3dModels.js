// src/config/pod3dModels.js for the ADMIN build (CP5 unit FN1): the studio's
// 3D view is OFF in this build until unit FN2 (STUDIO_FLAGS.studio3d in
// podStudioData.js is false, and the studio says so where the view was).
// The load answers no models WITHOUT a request, so nothing here pretends the
// platform has none: no caller shows this list while the flag is off.
//
// FN2 fills `loadPod3dModels` from GET /v1/admin/pod/3d-models
// (src/api/admin/podStudio.js list3dModels; the shape is the older pod3dModels
// document plus `id`, CP5_WH_REPORT "For unit FN"), keeps the
// localeCompare(…, 'sv') sort of the original, binds the load to the shop as
// podMockupTemplates.js does here, and turns the flag on.

/** loadPod3dModels() → Promise<[]> (FN2: the shop's active models). */
export const loadPod3dModels = async () => [];

/** Find a loaded model by its id. Returns null if absent. */
export const getPod3dModelById = (models, id) =>
  (Array.isArray(models) ? models : []).find((m) => m && m.id === id) || null;

/** Nothing is cached yet. */
export const clearPod3dModelsCache = () => {};
