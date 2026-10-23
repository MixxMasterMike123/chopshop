// The affiliate portal's pure parts (CP13), under Node:
//   node --test src/admin-app/adapters/affiliatePortal.test.mjs
// Invented data only.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BLOCKER_TEXT,
  clickSeries,
  formatBp,
  formatMinor,
  homeOfAccount,
  kronorToMinor,
  minorToKronorText,
  orderStateOf,
  payoutBlockReasons,
  payoutRefusalText,
  payoutStatusOf,
  profileFormOf,
  profilePatchOf,
  ratesLine,
  resolveAffiliateShopId,
  usableAffiliateShops,
} from './affiliatePortal.js';

const ME = {
  user: { id: 'u1', email: 'anna@example.test', name: 'Anna' },
  accountType: 'affiliate',
  platform: false,
  actingAs: [],
  memberships: [
    { tenantId: 'provbutik', shopName: 'Provbutiken', status: 'active', published: true, role: 'affiliate' },
    { tenantId: 'andra-butiken', shopName: 'Andra butiken', status: 'active', published: true, role: 'affiliate' },
    { tenantId: 'stangd', shopName: 'Stängd', status: 'suspended', published: true, role: 'affiliate' },
    { tenantId: 'admin-butik', shopName: 'X', status: 'active', published: true, role: 'admin' },
  ],
};

describe('the shops an affiliate may open', () => {
  it('only its active affiliate memberships', () => {
    assert.deepEqual(usableAffiliateShops(ME).map((m) => m.tenantId), ['provbutik', 'andra-butiken']);
    assert.deepEqual(usableAffiliateShops({ ...ME, accountType: 'tenant_admin' }), []);
    assert.deepEqual(usableAffiliateShops(null), []);
  });

  it('the chosen one when usable, else the only one, else the picker (null)', () => {
    assert.equal(resolveAffiliateShopId(ME, 'andra-butiken'), 'andra-butiken');
    assert.equal(resolveAffiliateShopId(ME, 'stangd'), null);
    assert.equal(resolveAffiliateShopId(ME, null), null);
    const one = { ...ME, memberships: [ME.memberships[0]] };
    assert.equal(resolveAffiliateShopId(one, null), 'provbutik');
    assert.equal(resolveAffiliateShopId(one, 'admin-butik'), 'provbutik');
  });

  it('anyone else is sent home: signed out → /login, an admin → /admin, a platform user → /platform/', () => {
    assert.equal(homeOfAccount(ME), null);
    assert.equal(homeOfAccount(null), '/login');
    assert.equal(homeOfAccount({ ...ME, accountType: 'tenant_admin' }), '/admin');
    assert.equal(homeOfAccount({ ...ME, accountType: 'platform_admin', platform: true }), '/platform/');
  });
});

describe('figures as the pages print them', () => {
  it('money in öre, rates in basis points', () => {
    assert.equal(formatMinor(540_000, 'SEK').replace(/\s/g, ' '), '5 400,00 kr');
    assert.equal(formatMinor(null), '–');
    assert.equal(formatMinor(12.5), '–');
    assert.equal(formatBp(1_500), '15 %');
    assert.equal(formatBp(1_250), '12,5 %');
    assert.equal(formatBp(undefined), '–');
    assert.equal(ratesLine({ commissionBp: 1_500, discountBp: 1_000 }), 'Kundrabatt 10 % · Din provision 15 % av nettovärdet (exkl. moms och frakt)');
  });

  it('the amount field: kronor in, öre out, nothing guessed', () => {
    assert.equal(kronorToMinor('250'), 25_000);
    assert.equal(kronorToMinor('250,5'), 25_050);
    assert.equal(kronorToMinor(' 1 250,50 '), 125_050);
    assert.equal(kronorToMinor('250.05'), 25_005);
    for (const bad of ['', '0', '0,00', '-5', '1,234', 'abc', '12,3,4']) assert.equal(kronorToMinor(bad), null, bad);
    assert.equal(minorToKronorText(125_050), '1250,50');
    assert.equal(minorToKronorText(5), '0,05');
    assert.equal(minorToKronorText(0), '');
  });

  it('the states: order commission and payout', () => {
    assert.deepEqual(orderStateOf('held'), ['Under ångerfrist', 'attention']);
    assert.deepEqual(orderStateOf('payable'), ['Att betala', 'success']);
    assert.deepEqual(orderStateOf('reversed'), ['Återförd', 'neutral']);
    assert.deepEqual(orderStateOf('???'), ['Ingen provision', 'neutral']);
    assert.deepEqual(payoutStatusOf('requested'), ['Begärd', 'attention']);
    assert.deepEqual(payoutStatusOf('paid'), ['Betald', 'success']);
    assert.deepEqual(payoutStatusOf('void'), ['Avvisad', 'danger']);
  });

  it('the link landings: the last 30 days, zero where none', () => {
    const now = Date.UTC(2026, 9, 23, 10);
    const series = clickSeries([{ day: '2026-10-23', count: 4 }, { day: '2026-09-24', count: 1 }, { day: '2026-01-01', count: 9 }, null], now);
    assert.equal(series.length, 30);
    assert.deepEqual(series[0], { day: '2026-09-24', count: 1 });
    assert.deepEqual(series[29], { day: '2026-10-23', count: 4 });
    assert.equal(series.reduce((sum, d) => sum + d.count, 0), 5);
  });
});

describe('"Begär utbetalning": the reasons it is disabled', () => {
  it('in a fixed order, with the words', () => {
    assert.deepEqual(payoutBlockReasons({ payoutBlockers: [] }), []);
    assert.deepEqual(
      payoutBlockReasons({ payoutBlockers: ['nothing_payable', 'profile_incomplete', 'terms_required'] }).map((r) => r.key),
      ['terms_required', 'profile_incomplete', 'nothing_payable'],
    );
    assert.equal(BLOCKER_TEXT.profile_incomplete, 'Fyll i namn och adress i din profil först.');
    assert.deepEqual(payoutBlockReasons({}), []);
  });

  it('a refused request is worded by its code', () => {
    assert.equal(payoutRefusalText({ code: 'insufficient_balance' }), 'Beloppet är större än det som finns att betala ut.');
    assert.equal(payoutRefusalText({ code: 'payout_open' }), BLOCKER_TEXT.payout_open);
    assert.equal(payoutRefusalText({ code: 'invalid_request', reason: 'type_not_as_stated' }), 'Fakturan måste vara en PDF.');
    assert.equal(payoutRefusalText({ code: 'whatever' }), 'Begäran kunde inte skickas. Försök igen.');
  });
});

describe('the profile', () => {
  const affiliate = {
    name: 'Anna',
    phone: null,
    address: { line1: 'Gatan 1', line2: null, postalCode: '123 45', city: 'Staden', country: 'SE' },
    preferredLang: 'sv',
    socials: { instagram: 'https://instagram.com/anna' },
  };

  it('the form from PortalMe', () => {
    const form = profileFormOf(affiliate);
    assert.equal(form.addressLine1, 'Gatan 1');
    assert.equal(form.addressLine2, '');
    assert.equal(form.phone, '');
    assert.equal(form.socials.instagram, 'https://instagram.com/anna');
    assert.equal(form.socials.tiktok, '');
  });

  it("the PATCH: every field the portal owns, an emptied one as null, never the shop's", () => {
    const patch = profilePatchOf({ ...profileFormOf(affiliate), addressLine1: '  ', country: 'se', socials: { instagram: ' ', website: 'https://anna.test ' } });
    assert.deepEqual(patch, {
      name: 'Anna',
      phone: null,
      addressLine1: null,
      addressLine2: null,
      postalCode: '123 45',
      city: 'Staden',
      country: 'SE',
      preferredLang: 'sv',
      socials: { website: 'https://anna.test' },
    });
    for (const key of ['code', 'commissionPercent', 'discountPercent', 'status', 'promotionMethod']) assert.equal(key in patch, false, key);
    assert.equal(profilePatchOf({ ...profileFormOf(affiliate), socials: {} }).socials, null);
  });
});

describe('CP13 round 1: the banner and the way back after sign-in', () => {
  it("the affiliate's own status before the program's switch", async () => {
    const { portalBannerOf } = await import('./affiliatePortal.js');
    assert.equal(portalBannerOf({ status: 'inactive', programActive: false }), 'Ditt affiliatekonto är inaktivt. Kontakta butiken.');
    assert.equal(portalBannerOf({ status: 'suspended', programActive: false }), 'Ditt affiliatekonto är avstängt. Kontakta butiken.');
    assert.match(portalBannerOf({ status: 'active', programActive: false }), /^Programmet är pausat av butiken\./);
    assert.equal(portalBannerOf({ status: 'active', programActive: true }), null);
    assert.equal(portalBannerOf(null), null);
  });

  it('only a portal address comes back', async () => {
    const { affiliateReturnPath, signInUrlFor } = await import('./affiliatePortal.js');
    assert.equal(affiliateReturnPath('/affiliate/payouts'), '/affiliate/payouts');
    assert.equal(affiliateReturnPath('/affiliate'), '/affiliate');
    for (const bad of ['/admin', '//evil.example', 'https://evil.example/affiliate', '/affiliate//evil', '/affiliatex', '/affiliate/a?b', null, 7]) {
      assert.equal(affiliateReturnPath(bad), null, String(bad));
    }
    assert.equal(signInUrlFor('/affiliate/payouts'), '/login?next=%2Faffiliate%2Fpayouts');
    assert.equal(signInUrlFor('/affiliate'), '/login');
    assert.equal(signInUrlFor('/admin/orders'), '/login');
  });
});
