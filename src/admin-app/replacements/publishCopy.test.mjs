// The words for a shop's publication, per build (CP5-FX, finding 5), under Node:
//   node --test src/admin-app/replacements/publishCopy.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as admin from './publishCopy.js';
import * as older from '../../pages/platform/publishCopy.js';

const NAMES = ['SHOP_DETAIL_PUBLISH_COPY', 'SHOP_LIST_PUBLISH_COPY', 'NEW_SHOP_NOTE'];

/** Every text of a copy object, its functions called with sample values. */
const textsOf = (copy) => Object.values(copy).map((v) => (typeof v === 'function' ? v('Testbutiken', '\n\nOBS: något.') : v));

const statusOff = (c) => `${c.offLead}${c.offWord}${c.offMiddle}${c.offWord2}${c.offTail}`;
const statusOn = (c) => `${c.onLead}${c.onWord}${c.onTail} <adress>.`;

describe('the two builds name the same words', () => {
  it('the same exports with the same keys', () => {
    for (const name of NAMES) {
      assert.deepEqual(Object.keys(admin[name]).sort(), Object.keys(older[name]).sort(), name);
    }
  });
});

describe('the admin build says what unpublishing does here: the shop closes; the admin can preview it', () => {
  it('no word promises a shop open by link, only hidden from search', () => {
    for (const name of NAMES) {
      for (const text of textsOf(admin[name])) {
        assert.doesNotMatch(text, /öppen via länk|förblir öppen|köpbar|noindex|dold för sök|sökbar|TA UR SÖK/i, `${name}: ${text}`);
      }
    }
  });

  it('the confirm before unpublishing says it closes the shop and that a preview remains', () => {
    const confirm = admin.SHOP_DETAIL_PUBLISH_COPY.confirmUnpublish('Testbutiken');
    assert.match(confirm, /"Testbutiken"/);
    assert.match(confirm, /stängs för besökare/);
    assert.match(confirm, /förhandsgranskas/);
  });

  it('the card, the list and the new-shop note say closed, not hidden', () => {
    const detail = admin.SHOP_DETAIL_PUBLISH_COPY;
    assert.equal(statusOff(detail), 'Butiken är opublicerad — stängd för besökare och sökmotorer. Den kan bara förhandsgranskas inifrån admin tills du klickar GO LIVE.');
    assert.equal(statusOn(detail), 'Butiken är publicerad — öppen för besökare, och Google och Bing får indexera <adress>.');
    assert.equal(detail.unpublishButton, 'AVPUBLICERA');
    assert.match(detail.confirmPublish('Testbutiken', ''), /öppnas för besökare/);
    assert.match(admin.SHOP_LIST_PUBLISH_COPY.titleOff, /^Stängd för besökare/);
    const note = admin.NEW_SHOP_NOTE;
    assert.match(`${note.lead}${note.word}${note.tail}`, /^Butiken skapas opublicerad \(stängd för besökare och sökmotorer\)/);
  });
});

describe('the older build keeps today\'s words, unchanged', () => {
  it('the detail page', () => {
    const c = older.SHOP_DETAIL_PUBLISH_COPY;
    assert.equal(statusOff(c), 'Butiken är dold för sökmotorer (noindex). Den är fortfarande öppen och köpbar via länk — bara osynlig i Google/Bing tills du klickar GO LIVE.');
    assert.equal(statusOn(c), 'Butiken är sökbar — Google och Bing får indexera <adress>.');
    assert.equal(c.confirmUnpublish('X'), 'Vill du dölja "X" från sökmotorer? Butiken förblir öppen via länk.');
    assert.equal(c.confirmPublish('X', '!'), 'Vill du göra "X" sökbar (GO LIVE)?!');
    assert.deepEqual(
      [c.heading, c.badgeOn, c.badgeOff, c.unpublishButton, c.publishedToast, c.unpublishedToast, c.failedToast],
      ['Sökbarhet', 'Sökbar', 'Dold för sök', 'TA UR SÖK', 'Butiken är nu sökbar (indexeras)', 'Butiken är nu dold för sökmotorer', 'Kunde inte ändra sökbarhet'],
    );
  });

  it('the list and the new-shop note', () => {
    assert.deepEqual({ ...older.SHOP_LIST_PUBLISH_COPY }, {
      column: 'Sök',
      badgeOn: 'Sökbar',
      badgeOff: 'Dold',
      titleOn: 'Indexeras av Google/Bing',
      titleOff: 'Dold för sökmotorer (noindex) — butiken är ändå öppen via länk',
    });
    const n = older.NEW_SHOP_NOTE;
    assert.equal(
      `${n.lead}${n.word}${n.tail}`,
      'Butiken skapas dold för sökmotorer (öppen via länk) — gör den sökbar via GO LIVE på butikens detaljsida när den är klar. Ägare/användare läggs till i ett senare steg. Branding och funktioner kan justeras efteråt.',
    );
  });
});
