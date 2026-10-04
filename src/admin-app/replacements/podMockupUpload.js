// src/wagons/pod-wagon/studio/mockupUpload.js for the ADMIN build (CP5 units
// FN1, FN2): no DRAFT copy of a mockup is stored while it is only generated.
// The older build kept one in the shop's private Storage partition (a
// deterministic path per template, side and colour, overwritten on each
// generation); the Worker has no such place, and an object per generation
// would be an orphan whenever the seller generates again.
//
// The mockups become the product's images AT PUBLISH and at "Uppdatera
// produkten" instead (unit FN2: replacements/podStudioImages.js, from the Blob
// each render keeps; only what the product does not already hold is uploaded).
//
// The studio calls this per rendered mockup and treats a null answer as "no
// stored copy" (entry.url stays null): no upload failure is reported for a
// copy that is never attempted.

/** uploadMockup(…) → Promise<null> (no draft copy in this build). */
export const uploadMockup = async () => null;
