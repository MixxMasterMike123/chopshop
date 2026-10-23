// node --test src/admin-app/adapters/affiliate.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  adjustmentBodyOf,
  affiliatePatchOf,
  approveBodyOf,
  balanceOf,
  clickSeries,
  codeOf,
  conversionRate,
  editFormOf,
  inviteBodyOf,
  invoiceFileProblem,
  kronorText,
  oneLine,
  orderAffiliateOf,
  percentOf,
  recordPayoutBodyOf,
  sinceForDays,
} from './affiliate.js';
import { orderFromDetail } from './order.js';
import { formatBp, formatMinor, formatSignedMinor, LEDGER_KIND } from '../../pages/admin/affiliateView.js';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');

const AFFILIATE = {
  affiliateId: 'a1',
  name: 'Anna Berg',
  phone: null,
  address: { line1: 'Storgatan 1', line2: null, postalCode: '111 22', city: 'Stockholm', country: 'SE' },
  code: 'ANNA10',
  commissionBp: 1500,
  discountBp: 1000,
  promotionMethod: 'instagram',
  preferredLang: 'sv',
  socials: { instagram: '@anna' },
};

describe('the copy formats the server\'s numbers', () => {
  it('money from öre, rates from bp, the ledger kinds', () => {
    assert.equal(formatMinor(5400), '54,00 kr');
    assert.equal(formatMinor(-1250), '−12,50 kr');
    assert.equal(formatMinor(5400, 'EUR'), '54,00 EUR');
    assert.equal(formatMinor(null), '–');
    assert.equal(formatSignedMinor(5400), '+54,00 kr');
    assert.equal(formatSignedMinor(-5400), '−54,00 kr');
    assert.equal(formatBp(1500), '15 %');
    assert.equal(formatBp(1250), '12,5 %');
    assert.deepEqual(Object.values(LEDGER_KIND), ['Provision', 'Återföring', 'Utbetalning', 'Återkallad utbetalning', 'Justering']);
  });
});

describe('layout helpers (no money derived)', () => {
  it('clickSeries fills 30 UTC days ending today', () => {
    const series = clickSeries([{ day: '2026-10-23', count: 4 }, { day: '2026-09-24', count: 2 }, { day: '2026-01-01', count: 9 }], NOW);
    assert.equal(series.length, 30);
    assert.equal(series[29], 4);
    assert.equal(series[0], 2);
    assert.equal(series.reduce((a, b) => a + b, 0), 6);
    assert.deepEqual(clickSeries(null, NOW, 3), [0, 0, 0]);
  });

  it('balanceOf picks the affiliate\'s currency, else zeros', () => {
    const sek = { currency: 'SEK', payableMinor: 100 };
    assert.equal(balanceOf([{ currency: 'EUR' }, sek], 'SEK'), sek);
    assert.equal(balanceOf([], 'SEK').payableMinor, 0);
  });

  it('conversionRate and since', () => {
    assert.equal(conversionRate(1, 40), '2,5 %');
    assert.equal(conversionRate(3, 0), '–');
    assert.equal(sinceForDays(30, NOW), '2026-09-23T12:00:00.000Z');
  });

  it('orderAffiliateOf keeps the server\'s member, or null', () => {
    assert.equal(orderAffiliateOf(null), null);
    assert.deepEqual(
      orderAffiliateOf({ attribution: 'link', code: 'ANNA10', affiliateCommissionMinor: 5400, ledgerState: 'held', selfReferral: false }),
      { attribution: 'link', code: 'ANNA10', affiliateCommissionMinor: 5400, ledgerState: 'held', selfReferral: false },
    );
    assert.equal(orderAffiliateOf({ code: 'X', selfReferral: true }).selfReferral, true);
  });
});

describe('forms → bodies', () => {
  it('percentOf and codeOf', () => {
    assert.equal(percentOf('15'), 15);
    assert.equal(percentOf(' 0 '), 0);
    assert.equal(percentOf('101'), null);
    assert.equal(percentOf('12.5'), null);
    assert.equal(codeOf(' anna10 '), 'ANNA10');
    assert.equal(codeOf(''), '');
    assert.equal(codeOf('ab'), null);
    assert.equal(codeOf('ANNA 10'), null);
  });

  it('approve: code optional, rates whole percent', () => {
    assert.deepEqual(approveBodyOf({ code: '', commissionPercent: '15', discountPercent: '10' }), { body: { commissionPercent: 15, discountPercent: 10 } });
    assert.deepEqual(approveBodyOf({ code: 'anna10', commissionPercent: '20', discountPercent: '0' }).body, { code: 'ANNA10', commissionPercent: 20, discountPercent: 0 });
    assert.match(approveBodyOf({ code: 'a', commissionPercent: '15', discountPercent: '10' }).error, /A–Z/);
    assert.match(approveBodyOf({ commissionPercent: '150', discountPercent: '10' }).error, /Provisionen/);
  });

  it('invite: name and address required, language sv by default', () => {
    assert.deepEqual(inviteBodyOf({ name: ' Anna ', email: 'ANNA@Example.com', commissionPercent: '15', discountPercent: '10' }).body, {
      name: 'Anna', email: 'anna@example.com', commissionPercent: 15, discountPercent: 10, preferredLang: 'sv',
    });
    assert.match(inviteBodyOf({ name: '', email: 'a@b.se', commissionPercent: '15', discountPercent: '10' }).error, /namn/);
    assert.match(inviteBodyOf({ name: 'A', email: 'nope', commissionPercent: '15', discountPercent: '10' }).error, /e-post/);
  });

  it('the edit sends only what changed', () => {
    const form = editFormOf(AFFILIATE);
    assert.equal(form.commissionPercent, '15');
    assert.deepEqual(affiliatePatchOf(AFFILIATE, form), { body: null });
    const changed = { ...form, phone: '070-1', code: 'anna15', discountPercent: '15', socials: { ...form.socials, tiktok: '@a' }, addressLine2: '' };
    assert.deepEqual(affiliatePatchOf(AFFILIATE, changed).body, {
      phone: '070-1', code: 'ANNA15', discountPercent: 15, socials: { instagram: '@anna', tiktok: '@a' },
    });
    assert.deepEqual(affiliatePatchOf(AFFILIATE, { ...form, city: '' }).body, { city: null });
    assert.match(affiliatePatchOf(AFFILIATE, { ...form, code: '' }).error, /A–Z/);
    assert.match(affiliatePatchOf(AFFILIATE, { ...form, name: ' ' }).error, /Namnet/);
  });

  it('adjustment: a signed kronor amount and a reason', () => {
    assert.deepEqual(adjustmentBodyOf({ amount: '−50', reason: ' Fel ' }).body, { amountMinor: -5000, reason: 'Fel' });
    assert.deepEqual(adjustmentBodyOf({ amount: '+25,50', reason: 'Bonus' }).body, { amountMinor: 2550, reason: 'Bonus' });
    assert.match(adjustmentBodyOf({ amount: '0', reason: 'x' }).error, /belopp/);
    assert.match(adjustmentBodyOf({ amount: '10', reason: '' }).error, /orsak/);
  });

  it('record payout: at most the payable the server said, the optional fields only when filled', () => {
    assert.deepEqual(recordPayoutBodyOf({ amount: '54,00', invoiceNumber: ' F-1 ', reference: '', notes: '' }, 5400).body, { amountMinor: 5400, invoiceNumber: 'F-1' });
    assert.match(recordPayoutBodyOf({ amount: '54,01' }, 5400).error, /större än/);
    assert.match(recordPayoutBodyOf({ amount: '0' }, 5400).error, /större än 0/);
    assert.equal(kronorText(5400), '54,00');
  });

  it('a textarea\'s line breaks are sent as one line (the server refuses control characters)', () => {
    assert.equal(recordPayoutBodyOf({ amount: '10', notes: 'Rad ett\r\n\n  rad två  ' }, 5400).body.notes, 'Rad ett rad två');
    assert.equal(oneLine(' a\nb\r\nc '), 'a b c');
    assert.equal(/[\u0000-\u001f]/.test(recordPayoutBodyOf({ amount: '1', notes: 'x\ny', reference: 'r\n1' }, 5400).body.notes), false);
  });

  it('the invoice file: a PDF of at most 10 MB', () => {
    assert.equal(invoiceFileProblem(null), null);
    assert.equal(invoiceFileProblem({ type: 'application/pdf', size: 1000 }), null);
    assert.match(invoiceFileProblem({ type: 'image/png', size: 1000 }), /PDF/);
    assert.match(invoiceFileProblem({ type: 'application/pdf', size: 11 * 1024 * 1024 }), /10 MB/);
  });
});

describe('the order detail carries the affiliate member (A14: the shop\'s own cost, shown)', () => {
  const base = { orderId: 'o1', orderNumber: '1001', items: [], totals: { discountMinor: 6960, discountCode: 'ANNA10' }, money: {} };
  it('absent without an affiliate: no field at all', () => {
    const order = orderFromDetail(base);
    assert.equal('affiliate' in order, false);
    assert.equal('affiliateCommission' in order, false);
    assert.equal(order.discountCode, 'ANNA10');
  });
  it('present on an attributed order, with the kronor the export reads', () => {
    const order = orderFromDetail({
      ...base,
      affiliate: { attribution: 'code', code: 'ANNA10', affiliateCommissionMinor: 5400, ledgerState: 'payable', selfReferral: false },
    });
    assert.deepEqual(order.affiliate, { code: 'ANNA10', attribution: 'code', affiliateCommissionMinor: 5400, ledgerState: 'payable', selfReferral: false });
    assert.equal(order.affiliateCommission, 54);
  });
});

describe('the platform console\'s user filter (CP13 A2)', async () => {
  const { USER_FILTERS, accountTypesOf, userRowOf } = await import('./platformConsole.js');
  it('Administratörer by default, Affiliates by accountType=affiliate', () => {
    assert.deepEqual(USER_FILTERS.map((f) => f.label), ['Administratörer', 'Affiliates']);
    assert.deepEqual([...accountTypesOf('admins')], ['platform_admin', 'tenant_admin']);
    assert.deepEqual([...accountTypesOf('affiliate')], ['affiliate']);
    assert.deepEqual([...accountTypesOf('nonsense')], ['platform_admin', 'tenant_admin']);
  });
  it('an affiliate row names its shops and is neither a platform nor a shop admin', () => {
    const row = userRowOf({
      userId: 'u1', email: 'anna@example.com', name: 'Anna', accountType: 'affiliate', status: 'active',
      memberships: [{ tenantId: 'shop-a', role: 'affiliate', status: 'active' }, { tenantId: 'shop-b', role: 'affiliate', status: 'revoked' }],
    });
    assert.equal(row.affiliate, true);
    assert.equal(row.platform, false);
    assert.equal(row.shopId, 'shop-a');
  });
});
