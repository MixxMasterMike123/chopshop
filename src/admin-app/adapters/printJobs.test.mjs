// node --test src/admin-app/adapters/printJobs.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_FILTERS,
  EXCEPTION_FILTERS,
  REFUSED_ORDER_STATUSES,
  actionBlockText,
  actionBody,
  actionConfirm,
  actionDoneText,
  actionGoneText,
  actionMovedText,
  actionToastText,
  cursorBefore,
  exceptionActions,
  exceptionConfirm,
  exceptionDoneText,
  exceptionState,
  exceptionText,
  offersAction,
  emptyViewText,
  isDefaultFilters,
  keepsJob,
  listParams,
  nextStates,
  sameJobFacts,
  statusBody,
  statusConfirm,
  statusDoneText,
  statusHolds,
  statusRefusalText,
} from './printJobs.js';

const JOB = {
  jobId: '1a2b3c4d-0000-4000-8000-000000001042-1', orderId: '1a2b3c4d-0000-4000-8000-000000001042', lineNo: 1,
  tenantId: 'test-shop-a', shopName: 'Test Shop A', orderNumber: '1042', orderStatus: 'paid',
  name: 'T-shirt', sku: 'POD-TEE', variantLabel: 'Svart · M', quantity: 1,
  dispatchState: 'accepted', state: null, trackingNumber: null, trackingUrl: null, carrier: null,
};

describe('what a row may do (the status route\'s rules)', () => {
  it('forward only, from the state the job has', () => {
    assert.deepEqual(nextStates(JOB), ['in_production', 'produced', 'shipped']);
    assert.deepEqual(nextStates({ ...JOB, state: 'in_production' }), ['produced', 'shipped']);
    assert.deepEqual(nextStates({ ...JOB, state: 'produced' }), ['shipped']);
    assert.deepEqual(nextStates({ ...JOB, state: 'shipped' }), []);
  });

  it('nothing on a cancelled or refunded order, or a job the printer has not accepted', () => {
    assert.deepEqual(REFUSED_ORDER_STATUSES, ['cancelled', 'refunded']);
    for (const orderStatus of ['cancelled', 'refunded']) assert.deepEqual(nextStates({ ...JOB, orderStatus }), []);
    assert.deepEqual(nextStates({ ...JOB, orderStatus: 'partially_refunded' }).length, 3);
    for (const dispatchState of [null, 'pending', 'submitting', 'unknown', 'failed', 'cancelled']) {
      assert.deepEqual(nextStates({ ...JOB, dispatchState }), []);
    }
  });

  it('says why a row has no action; an unknown job only shows its state', () => {
    assert.equal(actionBlockText(JOB), null);
    assert.match(actionBlockText({ ...JOB, orderStatus: 'cancelled' }), /Ordern är avbruten/);
    assert.match(actionBlockText({ ...JOB, orderStatus: 'refunded' }), /återbetald/);
    assert.match(actionBlockText({ ...JOB, dispatchState: 'cancelled' }), /Raden är avbruten/);
    assert.match(actionBlockText({ ...JOB, dispatchState: null }), /inte tagit emot/);
    assert.equal(actionBlockText({ ...JOB, dispatchState: 'unknown' }), null);
    assert.equal(actionBlockText({ ...JOB, state: 'shipped' }), null);
  });
});

describe('the filters', () => {
  it('the default view asks for accepted jobs without a state and leaves the shipped out', () => {
    assert.deepEqual(listParams(DEFAULT_FILTERS), { state: undefined, dispatchState: 'accepted', exception: undefined, tenantId: undefined, printerId: undefined });
    assert.equal(keepsJob(DEFAULT_FILTERS, { state: 'shipped' }), false);
    assert.equal(keepsJob(DEFAULT_FILTERS, { state: 'produced' }), true);
    assert.equal(keepsJob({ ...DEFAULT_FILTERS, state: 'all' }, { state: 'shipped' }), true);
    assert.equal(isDefaultFilters(DEFAULT_FILTERS), true);
  });

  it('one value per filter; "all" leaves the key out', () => {
    assert.deepEqual(listParams({ state: 'none', dispatchState: 'all', tenantId: 'test-shop-c', printerId: 'fake-printer' }),
      { state: 'none', dispatchState: undefined, exception: undefined, tenantId: 'test-shop-c', printerId: 'fake-printer' });
    assert.equal(isDefaultFilters({ ...DEFAULT_FILTERS, tenantId: 'x' }), false);
    // An empty view says "none" only when the list was read to its end.
    assert.match(emptyViewText(DEFAULT_FILTERS, false), /Inga tryckjobb att hantera/);
    assert.match(emptyViewText({ ...DEFAULT_FILTERS, tenantId: 'x' }, false), /matchar filtret/);
    for (const filters of [DEFAULT_FILTERS, { ...DEFAULT_FILTERS, tenantId: 'x' }]) {
      assert.match(emptyViewText(filters, true), /Listan fortsätter/);
      assert.doesNotMatch(emptyViewText(filters, true), /Inga tryckjobb/);
    }
  });
});

describe('reading one job through the list', () => {
  it('the cursor before a job: the line before, or the last line of the order id before', () => {
    assert.equal(cursorBefore({ ...JOB, lineNo: 3 }), `${JOB.orderId}-2`);
    assert.equal(cursorBefore(JOB), '1a2b3c4d-0000-4000-8000-000000001041-9999');
    assert.equal(cursorBefore({ orderId: '1a2b3c4d-0000-4000-8000-000000001000', lineNo: 1 }), '1a2b3c4d-0000-4000-8000-000000000fff-9999');
    assert.equal(cursorBefore({ orderId: '00000000-0000-4000-0000-000000000000', lineNo: 1 }), '00000000-0000-3fff-ffff-ffffffffffff-9999');
    assert.equal(cursorBefore({ orderId: '00000000-0000-0000-0000-000000000000', lineNo: 1 }), null);
  });

  it('the facts a confirm is built on', () => {
    assert.equal(sameJobFacts(JOB, { ...JOB, name: 'other' }), true);
    assert.equal(sameJobFacts(JOB, { ...JOB, state: 'in_production' }), false);
    assert.equal(sameJobFacts(JOB, { ...JOB, orderStatus: 'cancelled' }), false);
  });
});

describe('the status body (production-status.ts parseProductionStatusInput)', () => {
  it('tracking only with shipped; trimmed; empty fields left out', () => {
    assert.deepEqual(statusBody('produced', { trackingNumber: 'X' }), { body: { state: 'produced' } });
    assert.deepEqual(statusBody('shipped', { trackingNumber: ' SE1 ', carrier: '', trackingUrl: ' https://t.example/1 ' }),
      { body: { state: 'shipped', trackingNumber: 'SE1', trackingUrl: 'https://t.example/1' } });
    assert.deepEqual(statusBody('shipped', {}), { body: { state: 'shipped' } });
  });

  it('refuses what the route refuses, in words', () => {
    assert.match(statusBody('shipped', { trackingNumber: 'x'.repeat(101) }).problems.join(), /högst 100/);
    assert.match(statusBody('shipped', { carrier: 'a\nb' }).problems.join(), /Fraktbolaget/);
    for (const url of ['http://t.example/1', 'https://user:pw@t.example', 'https://t.example/a b', 'not a url']) {
      assert.match(statusBody('shipped', { trackingUrl: url }).problems.join(), /https-adress/, url);
    }
  });

  it('a lost answer holds when the state and every tracking fact are stored', () => {
    const body = { state: 'shipped', trackingNumber: 'SE1' };
    assert.equal(statusHolds({ ...JOB, state: 'shipped', trackingNumber: 'SE1' }, body), true);
    assert.equal(statusHolds({ ...JOB, state: 'shipped', trackingNumber: 'SE2' }, body), false);
    assert.equal(statusHolds({ ...JOB, state: 'produced' }, { state: 'produced' }), true);
  });
});

describe('the confirm says what the write does beyond the line', () => {
  it('in production: forward only, the order can still be cancelled', () => {
    const c = statusConfirm(JOB, 'in_production');
    assert.match(c.title, /"I produktion".*order 1042, rad 1/);
    assert.match(c.lines.join(' '), /bara framåt/);
    assert.match(c.lines.join(' '), /kan fortfarande avbrytas eller återbetalas helt.*ärende om att avbryta jobbet hos tryckeriet/);
    assert.doesNotMatch(c.lines.join(' '), /mejl/);
  });

  it('shipped: the return case, the seller\'s shipping, the order and the buyer\'s one mail, the write-once tracking', () => {
    const text = statusConfirm(JOB, 'shipped').lines.join(' ');
    assert.match(text, /returärende/);
    assert.match(text, /butiken markera ordern som skickad eller klar att hämta/);
    assert.match(text, /sista oskickade raden.*hela ordern som skickad.*köparen får ett mejl/);
    assert.match(text, /kan inte läggas till eller ändras efteråt.*visas inte för köparen eller butiken/);
    assert.match(text, /loggas/);
  });

  it('after the answer', () => {
    assert.match(statusDoneText(JOB, 'shipped', { orderShipped: true }), /Hela ordern är nu markerad som skickad/);
    assert.match(statusDoneText(JOB, 'produced', { changed: false }), /ingenting ändrades/);
    assert.match(statusDoneText(JOB, 'shipped', { readBack: true }), /Svaret kom aldrig fram.*kunde inte läsas/);
  });

  it('each refusal of the route in words', () => {
    const refusal = (reason) => statusRefusalText({ status: 409, code: 'print_job_status_not_allowed', reason });
    assert.match(refusal('backwards'), /senare status/);
    assert.match(refusal('not_accepted'), /inte tagit emot/);
    assert.match(refusal('tracking_differs'), /andra spårningsuppgifter/);
    assert.match(statusRefusalText({ status: 409, code: 'conflict' }), /ändrades samtidigt/);
    assert.match(statusRefusalText({ status: 404, code: 'not_found' }), /finns inte/);
  });
});

describe('the printer\'s exception (CP6-PS4; production-status.ts decideProductionStatus)', () => {
  const OPEN = { ...JOB, exception: 'out_of_stock', exceptionResolvedAt: null };
  const RESTOCKED = { ...OPEN, state: 'shipped' };
  const RESOLVED = { ...OPEN, exceptionResolvedAt: '2026-10-04T09:15:00.000Z' };

  it('where it stands: none, open, restocked (shipped after all), resolved', () => {
    assert.equal(exceptionState(JOB), null);
    assert.equal(exceptionState({ ...JOB, exception: null, exceptionResolvedAt: null }), null);
    assert.equal(exceptionState(OPEN), 'open');
    assert.equal(exceptionState({ ...OPEN, state: 'in_production' }), 'open');
    assert.equal(exceptionState(RESTOCKED), 'restocked');
    assert.equal(exceptionState(RESOLVED), 'resolved');
    assert.equal(exceptionState({ ...RESOLVED, state: 'in_production' }), 'resolved');
  });

  it('the state steps: only "shipped" while it is open, nothing after a resolution', () => {
    assert.deepEqual(nextStates(OPEN), ['shipped']);
    assert.deepEqual(nextStates({ ...OPEN, state: 'in_production' }), ['shipped']);
    assert.deepEqual(nextStates(RESTOCKED), []);
    assert.deepEqual(nextStates(RESOLVED), []);
    for (const orderStatus of REFUSED_ORDER_STATUSES) assert.deepEqual(nextStates({ ...OPEN, orderStatus }), []);
  });

  it('recording: an accepted line of an open order, not produced or shipped, with none yet', () => {
    assert.deepEqual(exceptionActions(JOB), ['out_of_stock']);
    assert.deepEqual(exceptionActions({ ...JOB, state: 'in_production' }), ['out_of_stock']);
    assert.deepEqual(exceptionActions({ ...JOB, orderStatus: 'partially_refunded' }), ['out_of_stock']);
    for (const state of ['produced', 'shipped']) assert.deepEqual(exceptionActions({ ...JOB, state }), [], state);
    for (const orderStatus of ['cancelled', 'refunded']) assert.deepEqual(exceptionActions({ ...JOB, orderStatus }), [], orderStatus);
    for (const dispatchState of [null, 'pending', 'submitting', 'unknown', 'failed', 'cancelled']) {
      assert.deepEqual(exceptionActions({ ...JOB, dispatchState }), [], String(dispatchState));
    }
  });

  it('closing: an open exception only, on a closed order too; never a restocked or a closed one', () => {
    assert.deepEqual(exceptionActions(OPEN), ['resolved']);
    for (const orderStatus of ['cancelled', 'refunded']) assert.deepEqual(exceptionActions({ ...OPEN, orderStatus }), ['resolved'], orderStatus);
    assert.deepEqual(exceptionActions({ ...OPEN, dispatchState: 'cancelled' }), ['resolved']);
    assert.deepEqual(exceptionActions(RESTOCKED), []);
    assert.deepEqual(exceptionActions(RESOLVED), []);
    assert.equal(offersAction(OPEN, 'resolved'), true);
    assert.equal(offersAction(OPEN, 'out_of_stock'), false);
    assert.equal(offersAction(OPEN, 'shipped'), true);
    assert.equal(offersAction(OPEN, 'produced'), false);
    assert.equal(offersAction(JOB, 'out_of_stock'), true);
    assert.equal(offersAction(JOB, 'resolved'), false);
  });

  it('the row\'s line about it, and why no step is offered', () => {
    assert.match(exceptionText(OPEN), /slut i lager\. Ordern hålls kvar/);
    for (const orderStatus of REFUSED_ORDER_STATUSES) {
      assert.equal(exceptionText({ ...OPEN, orderStatus }), 'Tryckeriet har meddelat att plagget är slut i lager.', orderStatus);
    }
    assert.match(exceptionText(RESTOCKED), /har skickat raden/);
    assert.match(exceptionText(RESOLVED), /^Undantaget stängdes .*: tryckeriet skickar inte raden\.$/);
    assert.match(exceptionText({ ...RESOLVED, exceptionResolvedAt: 'x' }), /^Undantaget stängdes: /);
    assert.equal(exceptionText(JOB), null);
    assert.equal(actionBlockText(OPEN), null);
    assert.match(actionBlockText({ ...OPEN, orderStatus: 'cancelled' }), /Ordern är avbruten/);
    assert.equal(actionBlockText(RESOLVED), null, 'the resolved line says it itself');
    assert.equal(actionBlockText({ ...RESOLVED, orderStatus: 'cancelled' }), null, 'on a closed order too');
  });

  it('the filter: "open" asks for every reported line and keeps the open ones', () => {
    assert.deepEqual(EXCEPTION_FILTERS.map(([v]) => v), ['all', 'open', 'none']);
    assert.equal(listParams({ ...DEFAULT_FILTERS, exception: 'open' }).exception, 'out_of_stock');
    assert.equal(listParams({ ...DEFAULT_FILTERS, exception: 'none' }).exception, 'none');
    assert.equal(listParams(DEFAULT_FILTERS).exception, undefined);
    const open = { ...DEFAULT_FILTERS, state: 'all', exception: 'open' };
    assert.deepEqual([OPEN, RESTOCKED, RESOLVED, JOB].map((j) => keepsJob(open, j)), [true, false, false, false]);
    assert.deepEqual([OPEN, RESOLVED, JOB].map((j) => keepsJob(DEFAULT_FILTERS, j)), [true, true, true]);
    assert.equal(isDefaultFilters({ ...DEFAULT_FILTERS, exception: 'open' }), false);
  });

  it('the bodies, and a lost answer read back', () => {
    assert.deepEqual(actionBody('out_of_stock', { trackingNumber: 'X' }), { body: { exception: 'out_of_stock' } });
    assert.deepEqual(actionBody('resolved'), { body: { exception: 'resolved' } });
    assert.deepEqual(actionBody('produced'), { body: { state: 'produced' } });
    assert.equal(statusHolds(OPEN, { exception: 'out_of_stock' }), true);
    assert.equal(statusHolds(JOB, { exception: 'out_of_stock' }), false);
    assert.equal(statusHolds(RESOLVED, { exception: 'resolved' }), true);
    assert.equal(statusHolds(OPEN, { exception: 'resolved' }), false);
    assert.equal(sameJobFacts(JOB, OPEN), false);
    assert.equal(sameJobFacts(OPEN, RESOLVED), false);
  });

  it('recording, confirmed: what happens, as the route does it', () => {
    const c = exceptionConfirm(JOB, 'out_of_stock');
    const text = c.lines.join(' ');
    assert.match(c.title, /"slut i lager" för order 1042, rad 1/);
    assert.match(text, /kan inte tas bort efteråt/);
    assert.match(text, /Ordern hålls kvar: butiken kan inte markera den som skickad eller klar att hämta, och den markeras inte som skickad av sig själv/);
    assert.match(text, /I butikens order står raden som misslyckad/);
    assert.match(text, /Ett larm skapas för plattformen, ett per rad/);
    assert.match(text, /Inga pengar flyttas, och köparen får inget mejl/);
    assert.match(text, /bara rapporteras som skickad/);
    assert.match(text, /loggas/);
    assert.equal(c.tone, 'primary');
    assert.deepEqual(actionConfirm(JOB, 'out_of_stock'), c);
    assert.deepEqual(actionConfirm(JOB, 'produced'), statusConfirm(JOB, 'produced'));
  });

  it('closing, confirmed: settled by hand first; the line is never sent; the order\'s mail only when it is open', () => {
    const open = exceptionConfirm(OPEN, 'resolved');
    const text = open.lines.join(' ');
    assert.match(open.title, /^Stäng undantaget för order 1042, rad 1\?$/);
    assert.match(text, /köparen och butiken redan har fått det utrett för hand/);
    assert.match(text, /Raden skickas inte, och ingen status kan rapporteras på den efteråt\. Det går inte att ångra/);
    assert.match(text, /håller inte längre kvar ordern/);
    assert.match(text, /sista oskickade raden.*en annan rad redan är skickad, markeras hela ordern som skickad direkt, och köparen får ett mejl/);
    assert.match(text, /Inga pengar flyttas.*Larmet om slut i lager stängs inte/);
    assert.equal(open.tone, 'danger');
    for (const [orderStatus, word] of [['cancelled', 'avbruten'], ['refunded', 'återbetald']]) {
      const closed = exceptionConfirm({ ...OPEN, orderStatus }, 'resolved').lines.join(' ');
      assert.match(closed, new RegExp(`Ordern är ${word}, så ingenting mer händer med den, och inget mejl skickas`));
      assert.doesNotMatch(closed, /köparen får ett mejl om att den är skickad/);
      assert.doesNotMatch(closed, /håller inte längre kvar ordern/);
    }
  });

  it('after the answer, and when the job moved', () => {
    assert.match(exceptionDoneText(JOB, 'out_of_stock'), /slut i lager är rapporterat\. Ordern hålls kvar/);
    assert.match(exceptionDoneText(JOB, 'out_of_stock', { changed: false }), /var redan rapporterat; ingenting ändrades/);
    assert.match(exceptionDoneText(JOB, 'out_of_stock', { readBack: true }), /Svaret kom aldrig fram, men ändringen är sparad/);
    assert.match(exceptionDoneText(OPEN, 'resolved'), /undantaget är stängt, och raden skickas inte\.$/);
    assert.match(exceptionDoneText(OPEN, 'resolved', { orderShipped: true }), /Hela ordern är nu markerad som skickad/);
    assert.match(exceptionDoneText(OPEN, 'resolved', { changed: false }), /var redan stängt/);
    assert.match(exceptionDoneText(OPEN, 'resolved', { readBack: true }), /ändringen är sparad\. Om hela ordern därmed markerades som skickad kunde inte läsas här/);
    assert.equal(actionDoneText(JOB, 'produced', {}), statusDoneText(JOB, 'produced', {}));
    assert.deepEqual(
      [actionToastText('out_of_stock'), actionToastText('resolved'), actionToastText('resolved', { orderShipped: true }), actionToastText('shipped', { orderShipped: true })],
      ['Slut i lager är rapporterat.', 'Undantaget är stängt.', 'Undantaget är stängt och ordern är skickad.', 'Statusen är sparad och ordern är skickad.'],
    );
    assert.match(actionMovedText(JOB, 'out_of_stock'), /slut i lager kan inte rapporteras nu/);
    assert.match(actionMovedText(JOB, 'resolved'), /undantaget kan inte stängas nu/);
    assert.match(actionMovedText(JOB, 'produced'), /kan inte få statusen "producerad" nu/);
    assert.match(actionGoneText('resolved'), /ändringen kan inte göras nu/);
    assert.match(actionGoneText('shipped'), /kan inte få den statusen nu/);
  });

  it('each of the four new refusals in its own words; `produced` per body', () => {
    const refusal = (reason, body) => statusRefusalText({ status: 409, code: 'print_job_status_not_allowed', reason }, body);
    const generic = refusal('something_new');
    assert.equal(generic, 'Tryckjobbet kan inte få den statusen.');
    const texts = {
      out_of_stock: refusal('out_of_stock', { state: 'produced' }),
      exception_resolved: refusal('exception_resolved', { state: 'shipped' }),
      no_exception: refusal('no_exception', { exception: 'resolved' }),
      producedRecord: refusal('produced', { exception: 'out_of_stock' }),
      producedResolve: refusal('produced', { exception: 'resolved' }),
    };
    assert.match(texts.out_of_stock, /rapporterat slut i lager.*bara rapporteras som skickad/);
    assert.match(texts.exception_resolved, /Undantaget för raden är stängt/);
    assert.match(texts.no_exception, /inte rapporterat slut i lager.*inget undantag att stänga/);
    assert.match(texts.producedRecord, /plagget fanns i lager: slut i lager kan inte rapporteras/);
    assert.match(texts.producedResolve, /redan skickad, så det finns inget undantag att stänga/);
    assert.equal(new Set(Object.values(texts)).size, 5);
    assert.ok(Object.values(texts).every((t) => t !== generic));
    assert.equal(refusal('produced'), generic, 'a produced refusal without a known body says nothing it cannot know');
  });
});
