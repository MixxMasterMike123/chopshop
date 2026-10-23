// The affiliate pages' words, number formats and layout helpers (CP13 A2,
// design §7.2). Pure, no data: both builds' pages read it (the older build's
// data module maps its documents into the same shapes). Money arrives in
// minor units (öre) and is only formatted here, never computed; a rate
// arrives in basis points and is shown as a percent. Tested under Node with
// the admin build's adapter (src/admin-app/adapters/affiliate.test.mjs).

/** Shown on the detail and payout pages while the shop's add-on is OFF (design §4.5). */
export const PROGRAM_OFF_BANNER =
  'Affiliateprogrammet är avstängt av plattformen. Utbetalningar och reskontra kan fortfarande hanteras.';

/** An order whose buyer was the affiliate (or a shop admin): attributed, but nothing earned (design §4.3). */
export const SELF_REFERRAL = 'Självköp – ingen provision';

/** A code change strands the links that carry the old code (design §5.3). */
export const CODE_CHANGE_WARNING = 'Gamla länkar med den tidigare koden slutar fungera.';

export const AFFILIATE_STATUS = {
  active: { label: 'Aktiv', tone: 'success' },
  inactive: { label: 'Inaktiv', tone: 'neutral' },
  suspended: { label: 'Avstängd', tone: 'warning' },
};

export const APPLICATION_STATUS = {
  pending: { label: 'Väntar', tone: 'warning' },
  approved: { label: 'Godkänd', tone: 'success' },
  denied: { label: 'Avslagen', tone: 'neutral' },
};

/** The ledger's row kinds (design §7.2 "Reskontra"). */
export const LEDGER_KIND = {
  accrual: 'Provision',
  reversal: 'Återföring',
  payout: 'Utbetalning',
  payout_void: 'Återkallad utbetalning',
  adjustment: 'Justering',
};

export const PAYOUT_STATUS = {
  requested: { label: 'Begärd', tone: 'warning' },
  paid: { label: 'Betald', tone: 'success' },
  void: { label: 'Avvisad', tone: 'neutral' },
};

/** Where one order's commission stands. */
export const ORDER_STATE = {
  held: { label: 'Under ångerfrist', tone: 'info' },
  payable: { label: 'Att betala', tone: 'success' },
  reversed: { label: 'Återförd', tone: 'neutral' },
  none: { label: 'Ingen provision', tone: 'neutral' },
};

/** How the order found the affiliate. */
export const ATTRIBUTION = { link: 'länk', code: 'kod' };

/** The application form's channels (the API's promotionMethod values). */
export const PROMOTION_METHODS = [
  { value: 'instagram', label: 'Instagram' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'blog', label: 'Blogg' },
  { value: 'forum', label: 'Forum' },
  { value: 'other', label: 'Annat' },
];

export const SOCIALS = [
  { key: 'website', label: 'Webbplats' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'youtube', label: 'YouTube' },
  { key: 'facebook', label: 'Facebook' },
  { key: 'tiktok', label: 'TikTok' },
];

export const LANGUAGES = [
  { value: 'sv', label: 'Svenska' },
  { value: 'en', label: 'Engelska' },
];

export const COUNTRIES = [
  { value: 'SE', label: 'Sverige' },
  { value: 'NO', label: 'Norge' },
  { value: 'DK', label: 'Danmark' },
  { value: 'FI', label: 'Finland' },
  { value: 'DE', label: 'Tyskland' },
  { value: 'GB', label: 'Storbritannien' },
  { value: 'US', label: 'USA' },
];

export const promotionLabel = (value) => PROMOTION_METHODS.find((m) => m.value === value)?.label ?? (value || '–');
export const languageLabel = (value) => LANGUAGES.find((l) => l.value === value)?.label ?? (value || '–');

const amount = (minor) =>
  Math.abs(minor / 100).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Minor units → "54,00 kr" (another currency: "54,00 EUR"); '–' when there is no number. */
export function formatMinor(minor, currency = 'SEK') {
  if (!Number.isSafeInteger(minor)) return '–';
  const unit = !currency || currency === 'SEK' ? 'kr' : currency;
  return `${minor < 0 ? '−' : ''}${amount(minor)} ${unit}`;
}

/** A ledger amount with its sign: "+54,00 kr", "−12,00 kr". */
export function formatSignedMinor(minor, currency = 'SEK') {
  if (!Number.isSafeInteger(minor)) return '–';
  return minor > 0 ? `+${formatMinor(minor, currency)}` : formatMinor(minor, currency);
}

/** Basis points → "15 %" (two decimals at most, never rounded to a lie). */
export function formatBp(bp) {
  if (!Number.isFinite(bp)) return '–';
  return `${(bp / 100).toLocaleString('sv-SE', { maximumFractionDigits: 2 })} %`;
}

/** An instant (ISO text or ms) → "23 okt. 2026" in Stockholm; '–' for none. */
export function formatDay(value) {
  if (value === null || value === undefined || value === '') return '–';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '–';
  return date.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Stockholm' });
}

/** A count → "1 234". */
export const formatCount = (n) => (Number.isFinite(n) ? n.toLocaleString('sv-SE') : '–');

// ── layout helpers (no money is derived) ────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC day `YYYY-MM-DD` of an instant (ms). */
export const utcDayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The server's link landings per day (days without one absent) → one count
 * per UTC day, oldest first, `days` long and ending today.
 */
export function clickSeries(clicksByDay, now = Date.now(), days = 30) {
  const byDay = new Map();
  for (const row of Array.isArray(clicksByDay) ? clicksByDay : []) {
    if (row && typeof row.day === 'string' && Number.isSafeInteger(row.count)) byDay.set(row.day, row.count);
  }
  return Array.from({ length: days }, (_, i) => byDay.get(utcDayOf(now - (days - 1 - i) * DAY_MS)) ?? 0);
}

/** The balance in `currency` (the affiliate's own), or a zero one: the server's figures, as they are. */
export function balanceOf(balances, currency) {
  const found = (Array.isArray(balances) ? balances : []).find((b) => b && b.currency === currency);
  return found ?? {
    currency,
    balanceMinor: 0,
    earnedMinor: 0,
    heldMinor: 0,
    paidMinor: 0,
    payableMinor: 0,
    requestedMinor: 0,
  };
}

/** Orders per link visit, as "2,5 %"; '–' without a visit (an aggregate of two counts, design §2.1). */
export function conversionRate(conversions, clicks) {
  if (!Number.isFinite(conversions) || !Number.isFinite(clicks) || clicks <= 0) return '–';
  return `${((conversions / clicks) * 100).toLocaleString('sv-SE', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} %`;
}

/** The edit form's fields from the server's affiliate. */
export function editFormOf(affiliate) {
  const a = affiliate ?? {};
  const socials = a.socials ?? {};
  return {
    name: a.name ?? '',
    phone: a.phone ?? '',
    addressLine1: a.address?.line1 ?? '',
    addressLine2: a.address?.line2 ?? '',
    postalCode: a.address?.postalCode ?? '',
    city: a.address?.city ?? '',
    country: a.address?.country ?? 'SE',
    code: a.code ?? '',
    commissionPercent: Number.isFinite(a.commissionBp) ? String(a.commissionBp / 100) : '',
    discountPercent: Number.isFinite(a.discountBp) ? String(a.discountBp / 100) : '',
    promotionMethod: a.promotionMethod ?? '',
    preferredLang: a.preferredLang === 'en' ? 'en' : 'sv',
    socials: Object.fromEntries(SOCIALS.map(({ key }) => [key, socials[key] ?? ''])),
  };
}

/** Minor units as a person would type the kronor ("54,00"), to pre-fill an amount. */
export const kronorText = (minor) =>
  Number.isSafeInteger(minor)
    ? (minor / 100).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false })
    : '';
