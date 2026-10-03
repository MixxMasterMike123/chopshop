// The words for a shop's publication on the platform pages — the ADMIN
// build's (CP5-FX, finding 5). Here unpublishing CLOSES the storefront (D57:
// an unpublished shop's catalogue answers 404, not only noindex); only its
// preview, opened from the admin, shows it. The older build's words
// (src/pages/platform/publishCopy.js) promise a shop that stays open by link,
// which is untrue here. Same names and keys; the data modules hand these to
// the pages (platformShopDetailData.js, platformShopsData.js,
// provisionShopData.js of this folder). No claim about checkouts already
// under way: a checkout opened while the shop was published may still be paid.

/** PlatformShopDetail: the publication card, its badge, button, confirms and toasts. */
export const SHOP_DETAIL_PUBLISH_COPY = Object.freeze({
  heading: 'Publicering',
  badgeOn: 'Publicerad',
  badgeOff: 'Opublicerad',
  // "Butiken är <publicerad> — öppen för besökare, och Google och Bing får indexera <the address>."
  onLead: 'Butiken är ',
  onWord: 'publicerad',
  onTail: ' — öppen för besökare, och Google och Bing får indexera',
  // "Butiken är <opublicerad> — stängd för besökare och sökmotorer. Den kan bara <förhandsgranskas> …"
  offLead: 'Butiken är ',
  offWord: 'opublicerad',
  offMiddle: ' — stängd för besökare och sökmotorer. Den kan bara ',
  offWord2: 'förhandsgranskas',
  offTail: ' inifrån admin tills du klickar GO LIVE.',
  unpublishButton: 'AVPUBLICERA',
  confirmPublish: (name, warn) => `Vill du publicera "${name}" (GO LIVE)? Butiken öppnas för besökare och sökmotorer.${warn}`,
  confirmUnpublish: (name) =>
    `Vill du avpublicera "${name}"? Butiken stängs för besökare och sökmotorer: dess sidor visas inte längre. Den kan fortfarande förhandsgranskas inifrån admin.`,
  publishedToast: 'Butiken är nu publicerad',
  unpublishedToast: 'Butiken är nu stängd för besökare',
  failedToast: 'Kunde inte ändra publiceringen',
});

/** PlatformShops: the publication column. */
export const SHOP_LIST_PUBLISH_COPY = Object.freeze({
  column: 'Publicering',
  badgeOn: 'Publicerad',
  badgeOff: 'Opublicerad',
  titleOn: 'Öppen för besökare och sökmotorer',
  titleOff: 'Stängd för besökare och sökmotorer — kan förhandsgranskas inifrån admin',
});

/** ProvisionShopModal: the note under the form ("Butiken skapas <word> …"). */
export const NEW_SHOP_NOTE = Object.freeze({
  lead: 'Butiken skapas ',
  word: 'opublicerad',
  tail: ' (stängd för besökare och sökmotorer) — öppna den via GO LIVE på butikens detaljsida när den är klar. Ägare/användare läggs till i ett senare steg. Branding och funktioner kan justeras efteråt.',
});
