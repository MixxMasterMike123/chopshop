// The Studio tab of PodAdminPage, reached through this module so that a build
// without the studio can put a stand-in in its place. Both builds use the real
// studio since CP5 unit FN1 (the Cloudflare admin's build swaps the studio's
// data modules instead: vite.admin.config.js, "Unit FN1").
export { default as DesignStudio } from '../studio/DesignStudio';

/** The studio is in this build: "Fortsätt till Designstudion" leads to it. */
export const STUDIO_AVAILABLE = true;
