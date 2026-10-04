// AdminDiscountCodes' shapes on the API, under Node:
//   node --test "src/admin-app/**/*.test.mjs"
// Invented data only.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { stockholmDayStart } from '../../api/admin/time.js';
import {
  dayEndMs,
  dayStartMs,
  discountCodeBodyFromForm,
  discountCodeRowFromApi,
  formatStockholmDay,
  stockholmDayOf,
} from './discountCode.js';

const FORM = {
  active: true,
  code: 'SOMMAR20',
  endsDay: '',
  maxUses: null,
  minSpend: null,
  productIds: [],
  scope: 'all',
  startsDay: '',
  type: 'percent',
  value: 12.5,
};

describe('the body the page sends', () => {
  it('percent → basis points, kronor → öre, rounded half up', () => {
    assert.equal(discountCodeBodyFromForm({ ...FORM, value: 12.5 }).percentBp, 1250);
    assert.equal(discountCodeBodyFromForm({ ...FORM, value: 33.335 }).percentBp, 3334);
    const fixed = discountCodeBodyFromForm({ ...FORM, type: 'fixed', value: 49.9 });
    assert.equal(fixed.valueMinor, 4990);
    assert.equal('percentBp' in fixed, false);
    assert.equal(discountCodeBodyFromForm({ ...FORM, type: 'fixed', value: 0.285 }).valueMinor, 29);
    assert.equal('valueMinor' in discountCodeBodyFromForm(FORM), false);
  });

  it('the minimum floored to whole kronor', () => {
    assert.equal(discountCodeBodyFromForm({ ...FORM, minSpend: 199.9 }).minSpendMinor, 19900);
    assert.equal(discountCodeBodyFromForm({ ...FORM, minSpend: 0 }).minSpendMinor, 0);
    assert.equal(discountCodeBodyFromForm(FORM).minSpendMinor, null);
  });

  it('the start day is its first instant in Stockholm', () => {
    const body = discountCodeBodyFromForm({ ...FORM, startsDay: '2026-10-01' });
    assert.equal(body.startsAt, stockholmDayStart('2026-10-01').getTime());
    // 00:00 CEST = 22:00 UTC the day before.
    assert.equal(new Date(body.startsAt).toISOString(), '2026-09-30T22:00:00.000Z');
  });

  it('the end day counts in full: the next day\'s start − 1, across the DST change of 2026-10-25', () => {
    const body = discountCodeBodyFromForm({ ...FORM, endsDay: '2026-10-31' });
    assert.equal(body.endsAt, stockholmDayStart('2026-11-01').getTime() - 1);
    assert.equal(new Date(body.endsAt).toISOString(), '2026-10-31T22:59:59.999Z');
    // The day the clocks go back is 25 hours long.
    assert.equal(dayEndMs('2026-10-25') - dayStartMs('2026-10-25'), 25 * 60 * 60 * 1000 - 1);
    // And the day they go forward, 23.
    assert.equal(dayEndMs('2026-03-29') - dayStartMs('2026-03-29'), 23 * 60 * 60 * 1000 - 1);
    assert.equal(dayEndMs('2026-12-31'), stockholmDayStart('2027-01-01').getTime() - 1);
  });

  it('no dates, no cap: nulls, which clear them on an edit', () => {
    const body = discountCodeBodyFromForm(FORM);
    assert.deepEqual([body.startsAt, body.endsAt, body.maxUses], [null, null, null]);
    assert.equal(discountCodeBodyFromForm({ ...FORM, maxUses: 10 }).maxUses, 10);
  });

  it('the product list only for a products-scoped code, and the Worker\'s keys only', () => {
    assert.equal('productIds' in discountCodeBodyFromForm(FORM), false);
    const scoped = discountCodeBodyFromForm({ ...FORM, productIds: ['p1', 'p2'], scope: 'products' });
    assert.deepEqual(scoped.productIds, ['p1', 'p2']);
    const allowed = ['active', 'code', 'endsAt', 'maxUses', 'minSpendMinor', 'percentBp', 'productIds', 'scope', 'startsAt', 'type', 'valueMinor'];
    for (const key of Object.keys(scoped)) assert.ok(allowed.includes(key), key);
  });
});

describe('the row the page reads', () => {
  const API = {
    active: true,
    code: 'SOMMAR20',
    discountCodeId: 'd1',
    endsAt: stockholmDayStart('2026-11-01').getTime() - 1,
    heldCount: 2,
    maxUses: 10,
    minSpendMinor: 19900,
    percentBp: 1250,
    productIds: null,
    scope: 'all',
    startsAt: stockholmDayStart('2026-10-01').getTime(),
    type: 'percent',
    usedCount: 3,
    valueMinor: null,
  };

  it('kronor, percent and counts as the page shows them', () => {
    assert.deepEqual(discountCodeRowFromApi(API), {
      active: true,
      code: 'SOMMAR20',
      endsAt: API.endsAt,
      heldCount: 2,
      id: 'd1',
      maxUses: 10,
      minSpend: 199,
      productIds: [],
      scope: 'all',
      startsAt: API.startsAt,
      type: 'percent',
      usedCount: 3,
      value: 12.5,
    });
    assert.equal(discountCodeRowFromApi({ ...API, percentBp: null, type: 'fixed', valueMinor: 4990 }).value, 49.9);
    assert.equal(discountCodeRowFromApi(null), null);
  });

  it('and back: the dates are the days that were saved, in Stockholm whatever the browser\'s zone', () => {
    assert.equal(stockholmDayOf(API.startsAt), '2026-10-01');
    assert.equal(stockholmDayOf(API.endsAt), '2026-10-31');
    assert.equal(formatStockholmDay(API.endsAt), '2026-10-31');
    assert.equal(stockholmDayOf(null), '');
    const resaved = discountCodeBodyFromForm({ ...FORM, endsDay: stockholmDayOf(API.endsAt), startsDay: stockholmDayOf(API.startsAt) });
    assert.deepEqual([resaved.startsAt, resaved.endsAt], [API.startsAt, API.endsAt]);
  });
});
