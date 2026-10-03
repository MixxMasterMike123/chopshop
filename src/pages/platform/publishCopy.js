// The words for a shop's publication on the platform pages — the OLDER
// build's (Firebase): `published === false` only hides the shop from search
// engines (noindex); the storefront stays open and shoppable by link.
//
// The data modules hand these to the pages (platformShopDetailData.js,
// platformShopsData.js, components/platform/provisionShopData.js); the admin
// build's data modules hand src/admin-app/replacements/publishCopy.js
// instead, under the same names, because there an unpublished shop is CLOSED
// (D57). The texts are today's, unchanged; a highlighted word is its own key
// so the pages keep their markup.

/** PlatformShopDetail: the publication card, its badge, button, confirms and toasts. */
export const SHOP_DETAIL_PUBLISH_COPY = Object.freeze({
  heading: 'Sökbarhet',
  badgeOn: 'Sökbar',
  badgeOff: 'Dold för sök',
  // "Butiken är <sökbar> — Google och Bing får indexera <the address>."
  onLead: 'Butiken är ',
  onWord: 'sökbar',
  onTail: ' — Google och Bing får indexera',
  // "Butiken är <dold för sökmotorer> (noindex). Den är fortfarande <öppen och köpbar> via länk — …"
  offLead: 'Butiken är ',
  offWord: 'dold för sökmotorer',
  offMiddle: ' (noindex). Den är fortfarande ',
  offWord2: 'öppen och köpbar',
  offTail: ' via länk — bara osynlig i Google/Bing tills du klickar GO LIVE.',
  unpublishButton: 'TA UR SÖK',
  confirmPublish: (name, warn) => `Vill du göra "${name}" sökbar (GO LIVE)?${warn}`,
  confirmUnpublish: (name) => `Vill du dölja "${name}" från sökmotorer? Butiken förblir öppen via länk.`,
  publishedToast: 'Butiken är nu sökbar (indexeras)',
  unpublishedToast: 'Butiken är nu dold för sökmotorer',
  failedToast: 'Kunde inte ändra sökbarhet',
});

/** PlatformShops: the publication column. */
export const SHOP_LIST_PUBLISH_COPY = Object.freeze({
  column: 'Sök',
  badgeOn: 'Sökbar',
  badgeOff: 'Dold',
  titleOn: 'Indexeras av Google/Bing',
  titleOff: 'Dold för sökmotorer (noindex) — butiken är ändå öppen via länk',
});

/** ProvisionShopModal: the note under the form ("Butiken skapas <word> …"). */
export const NEW_SHOP_NOTE = Object.freeze({
  lead: 'Butiken skapas ',
  word: 'dold för sökmotorer',
  tail: ' (öppen via länk) — gör den sökbar via GO LIVE på butikens detaljsida när den är klar. Ägare/användare läggs till i ett senare steg. Branding och funktioner kan justeras efteråt.',
});
