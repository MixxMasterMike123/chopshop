// The "Ny butik" form's suggested shop id, pure: node --test src/admin-app/adapters/shopIdSlug.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SHOP_ID_MAX, slugifyShopId } from '../../components/platform/shopIdSlug.js';

// ProvisionShopModal.jsx SHOP_ID_RE: what the form accepts.
const SHOP_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

describe('slugifyShopId', () => {
  it('turns a space into a hyphen, never into a letter (the dry run: "dryorunoartisto")', () => {
    assert.equal(slugifyShopId('Dry Run Artist'), 'dry-run-artist');
    assert.equal(slugifyShopId('Dry Run Artist 2026-10-04'), 'dry-run-artist-2026-10-04');
  });

  it('writes the Swedish letters as their base letters', () => {
    assert.equal(slugifyShopId('Åsa Öberg'), 'asa-oberg');
    assert.equal(slugifyShopId('Kärlek & Mörker'), 'karlek-morker');
    assert.equal(slugifyShopId('ÅÄÖ åäö'), 'aao-aao');
  });

  it('writes the other letters of the region by their usual spelling', () => {
    assert.equal(slugifyShopId('Søren Ærø'), 'soren-aero');
    assert.equal(slugifyShopId('Café Müller'), 'cafe-muller');
    assert.equal(slugifyShopId('Straße'), 'strasse');
    assert.equal(slugifyShopId('Łódź'), 'lodz');
  });

  it('makes punctuation a separator and drops an apostrophe', () => {
    assert.equal(slugifyShopId('Sill & Strid AB'), 'sill-strid-ab');
    assert.equal(slugifyShopId('Sill&Strid'), 'sill-strid');
    assert.equal(slugifyShopId('Rob.Wåtz/Merch'), 'rob-watz-merch');
    assert.equal(slugifyShopId("Kent's Shop"), 'kents-shop');
    assert.equal(slugifyShopId('Kent’s Shop'), 'kents-shop');
    assert.equal(slugifyShopId('"Melodie" (MC)!'), 'melodie-mc');
  });

  it('collapses repeated separators and drops them at the edges', () => {
    assert.equal(slugifyShopId('  Dry   Run  '), 'dry-run');
    assert.equal(slugifyShopId('dry--run'), 'dry-run');
    assert.equal(slugifyShopId('- - dry - - run - -'), 'dry-run');
    assert.equal(slugifyShopId('\tDry\nRun Artist'), 'dry-run-artist');
  });

  it('keeps digits and an id already in shape', () => {
    assert.equal(slugifyShopId('melodie-mc'), 'melodie-mc');
    assert.equal(slugifyShopId('Shop 42'), 'shop-42');
  });

  it('cuts at 30 characters without leaving a hyphen at the end', () => {
    assert.equal(SHOP_ID_MAX, 30);
    // The cut falls right after "-": the old function left "...-" (refused by the form).
    const name = 'abcdefghij abcdefghij abcdefg xyz'; // "-" is the 30th character
    const id = slugifyShopId(name);
    assert.equal(id, 'abcdefghij-abcdefghij-abcdefg');
    assert.ok(id.length <= SHOP_ID_MAX);
    assert.match(id, SHOP_ID_RE);
  });

  it('gives nothing for a name of no letters or digits, and for no name', () => {
    assert.equal(slugifyShopId('!!! ???'), '');
    assert.equal(slugifyShopId(''), '');
    assert.equal(slugifyShopId(undefined), '');
    assert.equal(slugifyShopId(null), '');
  });

  it('always gives what the form accepts, whatever the name', () => {
    for (const name of ['Dry Run Artist', 'Åsa & Öberg AB', "Kent's", ' - x - ', 'a'.repeat(40), 'É-é é', '1 2 3']) {
      const id = slugifyShopId(name);
      assert.ok(id === '' || SHOP_ID_RE.test(id), `${name} → ${id}`);
      assert.ok(id.length <= SHOP_ID_MAX);
    }
  });
});
