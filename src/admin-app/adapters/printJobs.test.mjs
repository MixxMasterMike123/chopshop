// node --test src/admin-app/adapters/printJobs.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_FILTERS,
  REFUSED_ORDER_STATUSES,
  actionBlockText,
  cursorBefore,
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
    assert.deepEqual(listParams(DEFAULT_FILTERS), { state: undefined, dispatchState: 'accepted', tenantId: undefined, printerId: undefined });
    assert.equal(keepsJob(DEFAULT_FILTERS, { state: 'shipped' }), false);
    assert.equal(keepsJob(DEFAULT_FILTERS, { state: 'produced' }), true);
    assert.equal(keepsJob({ ...DEFAULT_FILTERS, state: 'all' }, { state: 'shipped' }), true);
    assert.equal(isDefaultFilters(DEFAULT_FILTERS), true);
  });

  it('one value per filter; "all" leaves the key out', () => {
    assert.deepEqual(listParams({ state: 'none', dispatchState: 'all', tenantId: 'test-shop-c', printerId: 'fake-printer' }),
      { state: 'none', dispatchState: undefined, tenantId: 'test-shop-c', printerId: 'fake-printer' });
    assert.equal(isDefaultFilters({ ...DEFAULT_FILTERS, tenantId: 'x' }), false);
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
