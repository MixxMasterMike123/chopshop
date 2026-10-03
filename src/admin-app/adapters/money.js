// Money, the shared adapter of the admin build (CP5 brief FA). The API carries
// every amount as integer MINOR units (öre) with the currency beside it; the
// admin pages print and edit kronor. The page shows the server's numbers and
// recomputes none of them (rule 15: the seller sees ONE number; a payout or a
// price floor is the server's, never derived here).

/** Minor units (öre) → kronor; null when not a safe integer. */
export function minorToKronor(minor) {
  return Number.isSafeInteger(minor) ? minor / 100 : null;
}

/**
 * Kronor as a person typed them (number, or text with a comma or a point) →
 * minor units; null when it is not an amount of at most two decimals.
 */
export function kronorToMinor(kronor) {
  if (typeof kronor === 'number') {
    if (!Number.isFinite(kronor)) return null;
    const minor = Math.round(kronor * 100);
    return Math.abs(minor - kronor * 100) < 1e-6 && Number.isSafeInteger(minor) ? minor : null;
  }
  if (typeof kronor !== 'string') return null;
  const text = kronor.trim().replace(/\s/g, '').replace(',', '.');
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  const minor = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(minor)) return null;
  return m[1] === '-' ? -minor : minor;
}
