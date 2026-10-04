// src/wagons/pod-wagon/studio/mockupUpload.js for the ADMIN build (CP5 unit
// FN1): the generated mockups are NOT uploaded in this build until unit FN2.
// They are rendered in the browser as before (step 7 shows them and each can
// be downloaded); the older build stored a draft copy in the shop's private
// Storage, which nothing here has a route for yet.
//
// The studio calls this per rendered mockup and treats a null answer as "no
// stored copy" (entry.url stays null): no upload failure is reported for a
// copy that was never attempted.
//
// FN2 replaces this with: the blob as a `product_media` object
// (src/api/admin/uploads.js uploadObject: sha256 → reserve → PUT content),
// answering { objectId, url }; and the publish sequence
// (podStudioPublish.js) then PUTs the product's images from those objects.
// NOTE for FN2: the older publish fetches the mockup by its blob: address
// (fetch(objectUrl)); the admin CSP's connect-src has no `blob:`, so keep the
// Blob from the render instead of fetching it back.

/** uploadMockup(…) → Promise<null> (no stored copy in this build). */
export const uploadMockup = async () => null;

/** For FN2 and the report: whether this build stores mockups. */
export const MOCKUP_UPLOAD_AVAILABLE = false;
