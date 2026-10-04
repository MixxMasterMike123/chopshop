// The versions of the platform terms (unit CP5-FL): the list's states, the text
// format the seller's pages read, the consequences said before a publish, and
// the server's refusals as Swedish sentences.
// PURE: no React, no fetch; tested under Node (termsVersions.test.mjs).
//
// What publishing a version does (cloudflare/src/legal/platform-terms.ts,
// CP3_E_REPORT.md §3, DECISIONS D47, D48, D54):
//   - it is CURRENT from its publish instant; every shop must accept it again
//     (only the shop's own admin can: an acting-as platform user is refused);
//   - the admin's terms gate asks every shop that has not accepted it;
//   - checkout (THE gate): a shop that accepted the immediately previous
//     version stays open for 14 days from the publish instant (D47); a shop
//     that never accepted, or is two or more versions behind, gets no grace
//     and is closed until it accepts (D54). A checkout already opened can be
//     paid inside its 24 h window (D48);
//   - the storefront's "Plattformsvillkor" page shows the new text;
//   - the label and the text are immutable: the version row is never changed,
//     the text is archived content-addressed with its SHA-256, nothing deletes
//     either.
// The TEXT FORMAT is the seed's, which the seller's gate and the storefront
// read (src/storefront/adapters/legal.js toPagePlatformTerms): the JSON
// `{ version, terms, dpa }`, the two documents as markdown. A text in another
// format cannot be shown to a seller, so the gate lets every seller through
// while the checkout stays closed: this module only writes the format.

export const TERMS_VERSION_PATTERN = /^[0-9A-Za-z._-]{1,32}$/;
export const TERMS_TEXT_MAX_BYTES = 262_144;

const text = (v) => (typeof v === 'string' && v !== '' ? v : null);

/** "4 okt. 2026 14:02" (Swedish), "—" for no time. */
export function dateTimeText(iso) {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(ms)
    ? new Date(ms).toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'short' })
    : '—';
}

/** "4 okt. 2026" (Swedish), "—" for no time. */
export function dateText(iso) {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString('sv-SE', { dateStyle: 'medium' }) : '—';
}

/**
 * The API's list (newest first, `current` on the one in force) → rows with a
 * state: 'current', 'scheduled' (listed before the current one: published
 * later, not yet in force) or 'superseded'. Without a current version every
 * listed one is scheduled.
 */
export function versionRows(versions) {
  const list = (Array.isArray(versions) ? versions : []).filter((v) => text(v?.version));
  const currentIndex = list.findIndex((v) => v.current === true);
  return list.map((v, i) => ({
    version: v.version,
    publishedAt: text(v.publishedAt),
    sha256: text(v.sha256),
    textArchived: v.textArchived === true,
    state: i === currentIndex ? 'current' : currentIndex === -1 || i < currentIndex ? 'scheduled' : 'superseded',
  }));
}

export const STATE_LABELS = Object.freeze({
  current: 'Gäller nu',
  scheduled: 'Schemalagd',
  superseded: 'Ersatt',
});

/** The text of a version as the seller's pages read it. */
export function composeTermsText({ version, terms, dpa }) {
  return JSON.stringify({ version, terms, dpa });
}

/** An archived text → { terms, dpa } (markdown), or null when it is not in that format. */
export function parseTermsText(value) {
  if (typeof value !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  return parsed && typeof parsed.terms === 'string' && typeof parsed.dpa === 'string'
    ? { terms: parsed.terms, dpa: parsed.dpa }
    : null;
}

/** The size of a text as the Worker counts it (UTF-8 bytes). */
export const byteLength = (value) => new TextEncoder().encode(String(value ?? '')).byteLength;

/** "2026-10-04" for a day (local), with "-2", "-3"… when the label is taken. */
export function suggestedVersionLabel(now, versions = []) {
  const d = now instanceof Date ? now : new Date(now);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const taken = new Set((versions ?? []).map((v) => v?.version));
  if (!taken.has(day)) return day;
  for (let n = 2; n < 100; n += 1) if (!taken.has(`${day}-${n}`)) return `${day}-${n}`;
  return '';
}

/**
 * The form of a new version → { version, text } to send, or { problem } (a
 * Swedish sentence) for what the Worker would refuse.
 */
export function newVersionBody({ version, terms, dpa }, versions = []) {
  const label = String(version ?? '').trim();
  if (!TERMS_VERSION_PATTERN.test(label)) {
    return { problem: 'Versionens namn får bara innehålla bokstäver a–z, siffror, punkt, bindestreck och understreck, högst 32 tecken (t.ex. 2026-10-04).' };
  }
  if ((versions ?? []).some((v) => v?.version === label)) {
    return { problem: `Det finns redan en version som heter ${label}. Välj ett annat namn.` };
  }
  if (String(terms ?? '').trim() === '' || String(dpa ?? '').trim() === '') {
    return { problem: 'Både plattformsvillkoren och personuppgiftsbiträdesavtalet måste ha en text.' };
  }
  const body = composeTermsText({ version: label, terms: String(terms), dpa: String(dpa) });
  if (byteLength(body) > TERMS_TEXT_MAX_BYTES) {
    return { problem: 'Texterna är för långa tillsammans: högst 256 kB.' };
  }
  return { version: label, text: body };
}

/** The confirm of a publish: what it does to every shop, said before it is done. */
export function publishConfirm(label, currentVersion) {
  const lines = currentVersion
    ? [
        `Version ${label} gäller från det ögonblick du publicerar och ersätter ${currentVersion}.`,
        'Varje butiks admin möter de nya villkoren nästa gång de öppnar admin och måste godkänna dem. Bara butikens egen admin kan godkänna, inte du som plattform.',
        `Kassan: en butik som har godkänt ${currentVersion} kan fortsätta ta betalt i 14 dagar från publiceringen. Därefter är kassan stängd tills butiken godkänt ${label}.`,
        `En butik som aldrig godkänt villkoren, eller bara en äldre version än ${currentVersion}, får ingen frist: kassan stängs direkt tills butiken godkänt ${label}.`,
        'En betalning som redan startat kan slutföras inom sitt dygn.',
        'Butikernas sida Plattformsvillkor visar den nya texten direkt.',
        'Namnet och texten kan aldrig ändras eller tas bort efteråt. Texten arkiveras med sin kontrollsumma som bevis på vad säljarna godkänt.',
      ]
    : [
        `Version ${label} gäller från det ögonblick du publicerar. Ingen version gäller i dag, så ingen butik kan ta betalt förrän den godkänt villkoren.`,
        'Varje butiks admin möter villkoren nästa gång de öppnar admin och måste godkänna dem. Bara butikens egen admin kan godkänna, inte du som plattform.',
        'Butikernas sida Plattformsvillkor visar texten direkt.',
        'Namnet och texten kan aldrig ändras eller tas bort efteråt. Texten arkiveras med sin kontrollsumma som bevis på vad säljarna godkänt.',
      ];
  return { title: `Publicera plattformsvillkoren ${label}?`, lines, confirmLabel: `Publicera ${label}`, tone: 'danger' };
}

/** The confirm of archiving a version's missing text. */
export function archiveConfirm(version) {
  return {
    title: `Arkivera texten för ${version}?`,
    lines: [
      'Servern tar bara emot texten om den har exakt den kontrollsumma versionen publicerades med.',
      'Butiker som inte har godkänt versionen möter den i admin nästa gång de öppnar admin och kan då godkänna den. Butikernas sida Plattformsvillkor visar texten.',
      'Texten kan inte ändras eller tas bort efteråt.',
    ],
    confirmLabel: 'Arkivera texten',
    tone: 'primary',
  };
}

/** Any refusal of the terms-version routes → a Swedish sentence. */
export function termsRefusalMessage(error, what = 'Publiceringen') {
  const code = error?.code;
  if (code === 'unauthenticated') return error.message;
  if (code === 'network_error') return `${what} kunde inte skickas: servern kunde inte nås.`;
  if (code === 'terms_version_exists') return 'Det finns redan en version med det namnet. Välj ett annat namn.';
  if (code === 'terms_version_not_latest') {
    return 'En annan version är publicerad eller schemalagd vid samma tid eller senare. En ny version måste publiceras efter den senaste. Ladda om sidan.';
  }
  if (code === 'terms_text_hash_mismatch') {
    return 'Texten stämmer inte med versionens kontrollsumma: det är inte exakt den text versionen publicerades med, så den kan inte arkiveras.';
  }
  if (code === 'payload_too_large' || error?.status === 413) return 'Texten är för lång: högst 256 kB.';
  if (code === 'invalid_request') {
    return 'Servern tog inte emot versionen: namnet får bara innehålla bokstäver a–z, siffror, punkt, bindestreck och understreck (högst 32 tecken), och texten får inte vara tom.';
  }
  if (error?.status === 404) {
    return 'Servern svarade att versionen inte finns, eller att villkorsarkivet inte är påslaget i den här miljön. Ladda om sidan.';
  }
  if (code === 'rate_limited') return 'För många försök på kort tid. Vänta en stund och försök igen.';
  return `${what} gick inte igenom: servern svarade med ett fel (HTTP ${error?.status ?? '?'}).`;
}
