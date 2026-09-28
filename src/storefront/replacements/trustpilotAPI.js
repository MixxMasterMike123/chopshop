// src/utils/trustpilotAPI.js for the Cloudflare storefront (alias list,
// vite.storefront.config.js). D81: reviews are not ported, so there are no
// reviews to show: the same functions, answering an empty list.
//
// The Firebase module reads a CSV from the site's root (`/x_…_scrape.csv`,
// not shipped; the Firebase host answered it with the application's HTML,
// which it parsed into one empty five-star "review", DESIGN_CONTRACT IN-1).
// On Cloudflare that address answers 404 on the shared host and the
// application's HTML on a shop's own domain, so the same page would show the
// empty review on one host and not on the other. Here it shows none on both.

export const findBusinessUnit = async () => null;

export const fetchTrustpilotReviews = async () => [];

export const getRandomReviews = () => [];

export const getAllReviews = async () => [];

export const getAverageRating = async () => 0;

export const getReviewStats = async () => ({
  totalReviews: 0,
  averageRating: 0,
  distribution: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 },
});

export default {
  getRandomReviews,
  getAllReviews,
  getAverageRating,
  getReviewStats,
  findBusinessUnit,
  fetchTrustpilotReviews,
};
