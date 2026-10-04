// The platform settings' and brand filter's adapter under Node (unit CP5-FL).
//   node --test src/admin-app/adapters/platformSettings.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SETTING_MEANINGS,
  addTermConfirm,
  commissionConfirm,
  deleteTermConfirm,
  findAddedTerm,
  hardBlockConfirm,
  newTermBody,
  parsePercent,
  parseReviewCount,
  patchApplied,
  percentInput,
  percentText,
  refusalMessage,
  rescreenConfirm,
  rescreenResultText,
  rescreenSummaryText,
  staleFields,
  staleSettingMessage,
  termChanges,
  termHolds,
  updateTermConfirm,
} from './platformSettings.js';

describe('the fee: typed percent ↔ basis points, exactly', () => {
  it('parses whole and two-decimal percentages with a comma or a dot, no rounding', () => {
    assert.deepEqual(parsePercent('6'), { bps: 600 });
    assert.deepEqual(parsePercent('6,5'), { bps: 650 });
    assert.deepEqual(parsePercent(' 6.25 % '), { bps: 625 });
    assert.deepEqual(parsePercent('0'), { bps: 0 });
    assert.deepEqual(parsePercent('8'), { bps: 800 });
  });

  it('refuses three decimals, words, negatives and anything over the Worker\'s 8 %', () => {
    for (const bad of ['6,255', 'sex', '-1', '', '8,01', '100']) assert.ok(parsePercent(bad).problem, bad);
    assert.match(parsePercent('9').problem, /högst 8,00 %/);
  });

  it('shows the server\'s value in Swedish and starts the input from it', () => {
    assert.equal(percentText(500), '5,00 %');
    assert.equal(percentText(525), '5,25 %');
    assert.equal(percentText(5), '0,05 %');
    assert.equal(percentText(null), '—');
    assert.equal(percentInput(500), '5');
    assert.equal(percentInput(550), '5,5');
    assert.equal(percentInput(505), '5,05');
    for (const bps of [0, 1, 99, 500, 525, 550, 800]) assert.deepEqual(parsePercent(percentInput(bps)), { bps });
  });

  it('the review count: an integer 0..100', () => {
    assert.deepEqual(parseReviewCount(' 3 '), { value: 3 });
    assert.deepEqual(parseReviewCount('0'), { value: 0 });
    for (const bad of ['101', '2,5', 'två', '']) assert.ok(parseReviewCount(bad).problem, bad);
  });
});

describe('what the page says', () => {
  it('every field of the GET answer has its meaning (the timestamps are shown as "Senast ändrad")', () => {
    const fields = ['defaultCommissionBps', 'refundApplicationFee', 'reverseDisputeOnCreated', 'reviewFirstProducts',
      'screeningHardBlock', 'screeningTermsVersion'];
    assert.deepEqual(Object.keys(SETTING_MEANINGS).sort(), fields.sort());
  });

  it('the fee confirm says from what, to what, for whom and from when', () => {
    const c = commissionConfirm(500, 650);
    assert.equal(c.title, 'Ändra standardavgiften från 5,00 % till 6,50 %?');
    assert.ok(c.lines.some((l) => /egen avgift påverkas inte/.test(l)));
    assert.ok(c.lines.some((l) => /startar efter att du sparat/.test(l) && /behåller sin avgift/.test(l)));
    assert.equal(c.confirmLabel, 'Ändra till 6,50 %');
  });

  it('the hard block: on blocks at once (danger), off lifts no block', () => {
    assert.equal(hardBlockConfirm(true).tone, 'danger');
    assert.ok(hardBlockConfirm(true).lines.some((l) => /Direkt när du sparar/.test(l)));
    assert.ok(hardBlockConfirm(false).lines.some((l) => /ligger kvar spärrade/.test(l)));
  });

  it('a stale value is named with what the server holds now', () => {
    assert.deepEqual(staleFields({ defaultCommissionBps: 500 }, { defaultCommissionBps: 525 }, { defaultCommissionBps: 600 }), ['defaultCommissionBps']);
    assert.deepEqual(staleFields({ a: 1, b: 1 }, { a: 1, b: 2 }, { a: 3 }), []); // another field moving is not this change's business
    assert.match(staleSettingMessage('defaultCommissionBps', { defaultCommissionBps: 525 }), /nu 5,25 %/);
    assert.equal(patchApplied({ a: 1, b: 2 }, { a: 1 }), true);
    assert.equal(patchApplied({ a: 2 }, { a: 1 }), false);
    assert.equal(patchApplied(null, { a: 1 }), false);
  });

  it('the server\'s counts as sentences; nothing when there is nothing to say', () => {
    assert.equal(rescreenSummaryText(null), null);
    assert.equal(rescreenSummaryText({ blockedNow: 0, pending: 0, unverified: 0 }), null);
    assert.equal(rescreenSummaryText({ blockedNow: 2, pending: 1, unverified: 0 }),
      '2 produkter togs bort ur butikerna direkt. 1 publicerad produkt väntar på omgranskning.');
    assert.match(rescreenResultText({ rescreened: 25, pending: 12, unverified: 2 }), /^25 produkter granskades om\. 12 publicerade produkter väntar/);
    assert.match(rescreenResultText({ rescreened: 0, pending: 0, unverified: 0 }), /Ingen produkt behövde granskas om\. Alla publicerade produkter är granskade/);
    assert.ok(rescreenConfirm(false).lines.some((l) => /ligger kvar i butiken/.test(l)));
    assert.ok(rescreenConfirm(true).lines.some((l) => /något ord i filtret tas bort/.test(l)));
    assert.ok(!rescreenConfirm(true).lines.some((l) => /ligger kvar i butiken/.test(l)));
  });
});

describe('the brand filter', () => {
  it('a new term: trimmed, a kind of the Worker\'s, a note or null', () => {
    assert.deepEqual(newTermBody({ term: '  Glimmerkraft ', kind: 'band', hardBlock: true, note: ' x ' }),
      { body: { term: 'Glimmerkraft', kind: 'band', hardBlock: true, note: 'x' } });
    assert.deepEqual(newTermBody({ term: 'a', kind: 'brand', hardBlock: false, note: '' }).body.note, null);
    assert.ok(newTermBody({ term: ' ', kind: 'band' }).problem);
    assert.ok(newTermBody({ term: 'a', kind: 'shop' }).problem);
    assert.ok(newTermBody({ term: 'a', kind: 'band', note: 'x'.repeat(501) }).problem);
  });

  it('an edit sends only what changed (the Worker writes the named fields)', () => {
    const t = { term: 'x', kind: 'band', hardBlock: false, note: null };
    assert.deepEqual(termChanges(t, { kind: 'band', hardBlock: false, note: '' }), {});
    assert.deepEqual(termChanges(t, { kind: 'brand', hardBlock: true, note: ' n ' }), { kind: 'brand', hardBlock: true, note: 'n' });
    assert.deepEqual(termChanges({ ...t, note: 'n' }, { kind: 'band', hardBlock: false, note: '' }), { note: null });
    assert.equal(termHolds({ ...t, hardBlock: true }, { hardBlock: true }), true);
    assert.equal(termHolds({ ...t, note: null }, { note: 'n' }), false);
  });

  it('a confirm only where the storefront moves; the global hard block makes every term block', () => {
    assert.equal(addTermConfirm({ term: 'x', hardBlock: false }), null);
    assert.equal(addTermConfirm({ term: 'x', hardBlock: true }).tone, 'danger');
    assert.ok(addTermConfirm({ term: 'x', hardBlock: false }, true).lines.some((l) => /Alla träffar spärrar/.test(l)));
    assert.equal(updateTermConfirm({ term: 'x' }, { note: 'n' }), null);
    assert.equal(updateTermConfirm({ term: 'x' }, { hardBlock: true }).tone, 'danger');
    assert.ok(updateTermConfirm({ term: 'x' }, { hardBlock: false }).lines.some((l) => /ligger kvar spärrade/.test(l)));
    assert.ok(updateTermConfirm({ term: 'x' }, { hardBlock: false }, true).lines.some((l) => /redan/.test(l)));
    assert.ok(deleteTermConfirm({ term: 'x', hardBlock: true }).lines.some((l) => /kommer tillbaka i butiken/.test(l)));
    assert.ok(deleteTermConfirm({ term: 'x', hardBlock: false }).lines.some((l) => /granskningskön/.test(l)));
    assert.ok(deleteTermConfirm({ term: 'x', hardBlock: false }, true).lines.some((l) => /kommer tillbaka i butiken/.test(l)));
  });

  it('a lost add is told by the one new term with the kind, flag and note sent', () => {
    const before = [{ termKey: 'a' }];
    const body = { kind: 'band', hardBlock: false, note: null };
    assert.deepEqual(findAddedTerm(before, [{ termKey: 'a' }, { termKey: 'b', ...body }], body), { termKey: 'b', ...body });
    assert.equal(findAddedTerm(before, [{ termKey: 'a' }], body), null);
    assert.equal(findAddedTerm(before, [{ termKey: 'b', ...body }, { termKey: 'c', ...body }], body), 'unclear');
    assert.equal(findAddedTerm(before, [{ termKey: 'b', kind: 'brand', hardBlock: false, note: null }], body), 'unclear');
  });
});

describe('refusals as Swedish sentences', () => {
  it('names each code of the routes, the field of a settings refusal, and the term only for a term', () => {
    assert.match(refusalMessage({ code: 'duplicate_term' }), /redan ett ord/);
    assert.match(refusalMessage({ code: 'term_limit' }), /2[\s ]000 ord/);
    assert.match(refusalMessage({ code: 'conflict' }), /Ladda om sidan/);
    assert.match(refusalMessage({ code: 'setting_not_editable' }), /låst i koden/);
    assert.match(refusalMessage({ code: 'invalid_request', details: { field: 'defaultCommissionBps' } }), /avgiften/);
    assert.match(refusalMessage({ code: 'invalid_request' }, { term: true }), /latinska alfabetet/);
    assert.doesNotMatch(refusalMessage({ code: 'invalid_request', status: 400 }), /ordet/);
    assert.match(refusalMessage({ status: 404 }, { term: true }), /tagit bort/);
    assert.match(refusalMessage({ code: 'network_error' }), /kunde inte nås/);
    assert.equal(refusalMessage({ code: 'unauthenticated', message: 'Sessionen har gått ut.' }), 'Sessionen har gått ut.');
  });
});
