// The affiliate portal's pure parts (CP13, design §7.3): which shops the
// person may open, money and rates as the pages print them, the words of the
// server's states and refusals. No React, no fetch: tested under Node
// (affiliatePortal.test.mjs). Every figure is the server's; nothing here
// computes a commission or a balance.

export const ACCOUNT_AFFILIATE = 'affiliate';

/** The shops of a `/v1/me` answer the portal may open: an affiliate's memberships of an ACTIVE shop. */
export function usableAffiliateShops(me) {
  if (!me || me.accountType !== ACCOUNT_AFFILIATE || !Array.isArray(me.memberships)) return [];
  return me.memberships.filter(
    (m) => m && typeof m.tenantId === 'string' && m.tenantId !== '' && m.role === 'affiliate' && m.status === 'active',
  );
}

/** The shop to open: the one chosen earlier in this tab when still usable, else the only one, else null (the picker). */
export function resolveAffiliateShopId(me, chosen = null) {
  const ids = usableAffiliateShops(me).map((m) => m.tenantId);
  if (chosen && ids.includes(chosen)) return chosen;
  return ids.length === 1 ? ids[0] : null;
}

/**
 * Where a signed-in person who is not an affiliate belongs: the shop admin
 * (`/admin`) or the platform console (`/platform/`); null for an affiliate;
 * '/login' when signed out.
 */
export function homeOfAccount(me) {
  if (!me) return '/login';
  if (me.accountType === ACCOUNT_AFFILIATE) return null;
  if (me.accountType === 'platform_admin') return '/platform/';
  return '/admin';
}

const money = new Map();

/** Öre in a currency as Swedish text ("1 234,50 kr"); '–' for a missing figure. */
export function formatMinor(minor, currency = 'SEK') {
  if (!Number.isSafeInteger(minor)) return '–';
  const code = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : 'SEK';
  if (!money.has(code)) {
    money.set(code, new Intl.NumberFormat('sv-SE', { style: 'currency', currency: code, minimumFractionDigits: 2 }));
  }
  return money.get(code).format(minor / 100);
}

/** Basis points as a Swedish percentage ("15 %", "12,5 %"). */
export function formatBp(bp) {
  if (!Number.isSafeInteger(bp)) return '–';
  const percent = bp / 100;
  return `${Number.isInteger(percent) ? percent : percent.toLocaleString('sv-SE', { maximumFractionDigits: 2 })} %`;
}

/** "Kundrabatt 10 % · Din provision 15 % av nettovärdet (exkl. moms och frakt)". */
export function ratesLine(me) {
  return `Kundrabatt ${formatBp(me?.discountBp)} · Din provision ${formatBp(me?.commissionBp)} av nettovärdet (exkl. moms och frakt)`;
}

/** An ISO time as a Swedish date ("23 okt. 2026"); '–' when missing. */
export function formatDate(iso) {
  const at = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return '–';
  return new Date(at).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The amount field (kronor as typed, "123,45" or "123.45") as öre, or null
 * when it is not a positive amount with at most two decimals.
 */
export function kronorToMinor(text) {
  const raw = String(text ?? '').trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

/** Öre as the amount field's text ("1234,50"). */
export function minorToKronorText(minor) {
  if (!Number.isSafeInteger(minor) || minor <= 0) return '';
  const whole = Math.floor(minor / 100);
  const fraction = String(minor % 100).padStart(2, '0');
  return `${whole},${fraction}`;
}

/** An order's commission state: [label, StatusPill tone]. */
export const ORDER_STATE = {
  held: ['Under ångerfrist', 'attention'],
  payable: ['Att betala', 'success'],
  reversed: ['Återförd', 'neutral'],
  none: ['Ingen provision', 'neutral'],
};

export function orderStateOf(state) {
  return ORDER_STATE[state] ?? ORDER_STATE.none;
}

/** A payout's status: [label, tone] — Begärd / Betald / Avvisad. */
export const PAYOUT_STATUS = {
  requested: ['Begärd', 'attention'],
  paid: ['Betald', 'success'],
  void: ['Avvisad', 'danger'],
};

export function payoutStatusOf(status) {
  return PAYOUT_STATUS[status] ?? [String(status ?? '–'), 'neutral'];
}

/** Why "Begär utbetalning" is disabled, for each blocker of `payoutBlockers`. */
export const BLOCKER_TEXT = {
  terms_required: 'Godkänn de nya villkoren först.',
  profile_incomplete: 'Fyll i namn och adress i din profil först.',
  payout_open: 'Du har redan en öppen begäran.',
  nothing_payable: 'Det finns inget belopp att betala ut än.',
};

/** The disabled-reasons of a PortalMe, in a fixed order; [] when a payout may be requested. */
export function payoutBlockReasons(me) {
  const blockers = Array.isArray(me?.payoutBlockers) ? me.payoutBlockers : [];
  return ['terms_required', 'profile_incomplete', 'payout_open', 'nothing_payable']
    .filter((key) => blockers.includes(key))
    .map((key) => ({ key, text: BLOCKER_TEXT[key] }));
}

/** The words of a refused payout request (409 codes) and of the other answers. */
export function payoutRefusalText(error) {
  switch (error?.code) {
    case 'payout_open':
      return BLOCKER_TEXT.payout_open;
    case 'insufficient_balance':
      return 'Beloppet är större än det som finns att betala ut.';
    case 'profile_incomplete':
      return BLOCKER_TEXT.profile_incomplete;
    case 'terms_required':
      return BLOCKER_TEXT.terms_required;
    case 'invalid_invoice':
      return 'Fakturan kunde inte kopplas till begäran. Ladda upp den igen.';
    case 'too_many_pending_invoices':
      return 'Du har för många uppladdade fakturor som inte hör till någon begäran. Kontakta butiken.';
    case 'rate_limited':
      return 'För många uppladdningar i dag. Försök igen i morgon.';
    case 'payload_too_large':
      return 'Fakturan får vara högst 10 MB.';
    case 'invalid_file':
    case 'invalid_request':
      return error?.reason === 'type_not_as_stated' || error?.code === 'invalid_file'
        ? 'Fakturan måste vara en PDF.'
        : 'Uppgifterna kunde inte tas emot. Kontrollera beloppet och fakturanumret.';
    default:
      return 'Begäran kunde inte skickas. Försök igen.';
  }
}

/** The profile form's state from a PortalMe. */
export function profileFormOf(me) {
  const socials = me?.socials && typeof me.socials === 'object' ? me.socials : {};
  return {
    name: me?.name ?? '',
    phone: me?.phone ?? '',
    addressLine1: me?.address?.line1 ?? '',
    addressLine2: me?.address?.line2 ?? '',
    postalCode: me?.address?.postalCode ?? '',
    city: me?.address?.city ?? '',
    country: me?.address?.country ?? 'SE',
    preferredLang: me?.preferredLang === 'en' ? 'en' : 'sv',
    socials: {
      website: socials.website ?? '',
      instagram: socials.instagram ?? '',
      youtube: socials.youtube ?? '',
      facebook: socials.facebook ?? '',
      tiktok: socials.tiktok ?? '',
    },
  };
}

/**
 * PATCH /v1/affiliate/profile's body from the form: every field the portal
 * owns, trimmed; an emptied optional field is sent as null (the server clears
 * it). The name is required by the server and sent as typed.
 */
export function profilePatchOf(form) {
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  const orNull = (value) => text(value) || null;
  const socials = {};
  for (const [key, value] of Object.entries(form?.socials ?? {})) {
    if (text(value)) socials[key] = text(value);
  }
  return {
    name: text(form?.name),
    phone: orNull(form?.phone),
    addressLine1: orNull(form?.addressLine1),
    addressLine2: orNull(form?.addressLine2),
    postalCode: orNull(form?.postalCode),
    city: orNull(form?.city),
    country: text(form?.country).toUpperCase() || 'SE',
    preferredLang: form?.preferredLang === 'en' ? 'en' : 'sv',
    socials: Object.keys(socials).length > 0 ? socials : null,
  };
}

/** The last `days` days (UTC) ending today with each day's count (0 where the server lists none). */
export function clickSeries(clicksByDay, now = Date.now(), days = 30) {
  const byDay = new Map();
  for (const row of Array.isArray(clicksByDay) ? clicksByDay : []) {
    if (row && typeof row.day === 'string' && Number.isSafeInteger(row.count)) byDay.set(row.day, row.count);
  }
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day, count: byDay.get(day) ?? 0 });
  }
  return out;
}

/**
 * The banner over every portal page, or null (CP13 review): the affiliate's
 * OWN status first (inactive / suspended by the shop), then the shop's
 * program switched off (`programActive` false while the affiliate is active).
 */
export function portalBannerOf(affiliate) {
  if (!affiliate) return null;
  if (affiliate.status === 'inactive') return 'Ditt affiliatekonto är inaktivt. Kontakta butiken.';
  if (affiliate.status === 'suspended') return 'Ditt affiliatekonto är avstängt. Kontakta butiken.';
  if (affiliate.programActive === false) {
    return 'Programmet är pausat av butiken. Din kod ger ingen rabatt just nu, men du kan se din historik och begära utbetalning av det du har tjänat.';
  }
  return null;
}

// A portal address to come back to after signing in: /affiliate or below,
// plain path characters only (never another host, never a scheme).
const RETURN_PATH = /^\/affiliate(?:\/[A-Za-z0-9/_-]*)?$/;

/** The `next` of the sign-in page when it is a portal address; else null. */
export function affiliateReturnPath(next) {
  return typeof next === 'string' && RETURN_PATH.test(next) && !next.includes('//') ? next : null;
}

/** The sign-in page that brings the person back to `pathname` (a portal address) afterwards. */
export function signInUrlFor(pathname) {
  const back = affiliateReturnPath(pathname);
  return back && back !== '/affiliate' ? `/login?next=${encodeURIComponent(back)}` : '/login';
}
