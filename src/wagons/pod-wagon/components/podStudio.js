// The Studio tab of PodAdminPage, reached through this module so that a build
// without the studio can put a stand-in in its place (CP5 unit FM: the
// Cloudflare admin's build aliases this module to
// src/admin-app/replacements/podStudio.jsx until the studio's unit, FN).
export { default as DesignStudio } from '../studio/DesignStudio';

/** The studio is in this build: "Fortsätt till Designstudion" leads to it. */
export const STUDIO_AVAILABLE = true;
