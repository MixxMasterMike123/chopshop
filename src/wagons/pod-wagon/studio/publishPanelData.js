// publishPanelData.js — PublishPanel's pricing and screening sources, for the
// OLDER build (src/App.jsx, vite.config.js): the client formula of
// podPricing.js and the client brand-screening notice, exactly as the panel
// imported them before (CP5 unit FN1 moved the two imports here). The
// Cloudflare admin's build puts its own module in this one's place
// (vite.admin.config.js: src/admin-app/replacements/podPublishPanelData.js):
// there the price floor and Inköp are the server's, per printer article.
export { sellerProfitInkl, sellerMargin, priceFloor, priceForMargin, roundUpTo9, inklMoms, FEE_RATE, FEE_FIXED } from '../podPricing';
import { screeningNotice } from '../../../utils/contentScreening';

/** The panel prices against the one `cost` it is given (podPricing.js). */
export const SERVER_PRICED = false;

/** The server's quote per printer article: none in this build. */
export const useArticleQuotes = () => null;

/** The notice under a successful publish: the client blocklist's hits (A11). */
export const resultScreeningText = (result) =>
  (result?.screeningHits?.length > 0 ? screeningNotice(result.screeningHits) : null);

/** The panel's texts that another build's model changes: none here (null = the panel's own). */
export const PANEL_TEXT = Object.freeze({ connectionNote: null, articleHelp: null, notSold: null, scopeTitle: null, updated: null });

/** The server's numbers per printer article: none in this build (the panel prices against `cost`). */
export const useServerPricing = () => null;
