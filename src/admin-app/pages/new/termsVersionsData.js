// The data of the console's "Inställningar → Plattformsvillkor" page (unit
// CP5-FL): the versions, one version's archived text, a new version, and the
// archiving of a text for a version published without one (the 0031 seed):
// the operator supplies the exact text, the server checks it by its hash.
// Platform requests only (no X-Shop-Id). Tested under Node against the dev API
// (pagesData.test.mjs).
//
// The code's own text of the seed (src/config/platformTerms.js) is NOT
// imported: its personuppgiftsbiträdesavtal names the source system's
// provider as a sub-processor, and the admin bundle must not carry that name
// (cloudflare/admin/check-admin-build.mjs). CP3_E_REPORT.md §2 has the command
// that prints it.
//
// A version's text never changes once archived (it is addressed by its
// SHA-256), so a text read once is kept for the page's life. A publish or an
// archive whose answer is lost is read back by the version's text: the same
// text → it was done; none → it was not.

import {
  archiveTermsVersionText,
  getTermsVersionText,
  listTermsVersions,
  publishTermsVersion,
} from '../../../api/admin/platform.js';
import { isLostAnswer } from '../../adapters/platformModels.js';
import { readFailureMessage } from '../../adapters/platformSettings.js';
import { newVersionBody, parseTermsText, termsRefusalMessage, versionRows } from '../../adapters/termsVersions.js';
import { pageError } from './platformSettingsData.js';

const texts = new Map(); // version → { text, parsed, sha256, publishedAt }

/** The versions as the page lists them (versionRows). */
export async function loadVersions() {
  try {
    return versionRows(await listTermsVersions());
  } catch (error) {
    throw pageError(readFailureMessage(error, 'Villkorsversionerna'), error);
  }
}

/** One version's archived text → { text, parsed ({terms, dpa} or null), sha256, publishedAt } (text null: none archived). */
export async function loadVersionText(version) {
  if (texts.has(version)) return texts.get(version);
  let answer;
  try {
    answer = await getTermsVersionText(version);
  } catch (error) {
    if (error?.status === 404 && error?.code !== 'unauthenticated') {
      throw pageError('Texten kunde inte läsas: servern hittar inte versionen, eller så är villkorsarkivet inte påslaget i den här miljön.', error);
    }
    throw pageError(readFailureMessage(error, 'Texten'), error);
  }
  const held = {
    text: typeof answer?.text === 'string' ? answer.text : null,
    parsed: parseTermsText(answer?.text),
    sha256: answer?.sha256 ?? null,
    publishedAt: answer?.publishedAt ?? null,
  };
  if (held.text !== null) texts.set(version, held);
  return held;
}

/**
 * The documents a new version starts from: the current version's archived
 * text, else empty (`fromCurrent` says which).
 */
export async function startingDocuments(currentVersion) {
  if (currentVersion) {
    try {
      const held = await loadVersionText(currentVersion);
      if (held.parsed) return { ...held.parsed, fromCurrent: true };
    } catch {
      // An unreadable text starts the form empty.
    }
  }
  return { terms: '', dpa: '', fromCurrent: false };
}

/**
 * The text a file holds: the request body CP3_E_REPORT.md §2 writes
 * (`{ "text": … }`), or the text itself.
 */
export function textOfFile(content) {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.text === 'string' && Object.keys(parsed).length === 1) {
      return parsed.text;
    }
  } catch {
    // Not JSON: the file is the text.
  }
  return content;
}

async function readBackText(version, what, cause) {
  try {
    texts.delete(version);
    return await getTermsVersionText(version);
  } catch (error) {
    if (error?.status === 404 && error?.code !== 'unauthenticated') return null;
    throw pageError(`Anslutningen bröts och det är oklart om ${what}. Ladda om sidan och kontrollera innan du försöker igen.`, cause);
  }
}

/** The version in force among the rows (versionRows), or null when none is. */
export const currentVersionOf = (rows) => (rows ?? []).find((r) => r.state === 'current')?.version ?? null;

/**
 * Publishes a new version now. `form` = { version, terms, dpa };
 * `confirmedCurrent` = the version in force that the operator's confirm named
 * (null: none). What a publish does to every shop depends on it (a shop that
 * accepted THAT version keeps its checkout for 14 days; any older acceptance
 * closes it at once), so the versions are read again first: when another
 * version came into force since the confirm was written, nothing is sent and
 * the error carries `currentMoved`, `current` and `rows` for a new confirm.
 * A taken name is refused before sending, on the rows just read.
 * → the version as the server published it ({ version, publishedAt, sha256, … }).
 */
export async function publishVersion(form, confirmedCurrent) {
  const rows = await loadVersions();
  const current = currentVersionOf(rows);
  if (current !== (confirmedCurrent ?? null)) {
    throw pageError(
      current
        ? `Version ${current} har börjat gälla sedan bekräftelsen skrevs. Ingenting är publicerat. Läs bekräftelsen igen: den utgår nu från ${current}.`
        : 'Ingen version gäller längre. Ingenting är publicerat. Läs bekräftelsen igen.',
      null,
      { currentMoved: true, current, rows },
    );
  }
  const body = newVersionBody(form, rows);
  if (body.problem) throw pageError(body.problem);
  try {
    const published = await publishTermsVersion(body);
    if (!published?.version) throw Object.assign(new Error('No version in the answer'), { code: 'bad_response' });
    return published;
  } catch (error) {
    if (!isLostAnswer(error)) throw pageError(termsRefusalMessage(error), error);
    const back = await readBackText(body.version, 'versionen publicerades', error);
    if (back && back.text === body.text) {
      return { version: back.version, publishedAt: back.publishedAt, sha256: back.sha256, textArchived: true };
    }
    if (back) {
      throw pageError(`Anslutningen bröts, och en version som heter ${body.version} finns nu med en annan text. Ladda om sidan.`, error);
    }
    throw pageError('Anslutningen bröts och versionen publicerades inte. Försök igen.', error);
  }
}

/**
 * Archives the exact text of a version published without one. The server
 * takes it only when it hashes to the version's SHA-256. → { version, created }.
 */
export async function archiveText(version, text) {
  if (typeof text !== 'string' || text === '') throw pageError('Klistra in texten, eller välj en fil med den.');
  try {
    const answer = await archiveTermsVersionText(version, text);
    if (!answer.version) throw Object.assign(new Error('No version in the answer'), { code: 'bad_response' });
    texts.delete(version);
    return answer;
  } catch (error) {
    if (!isLostAnswer(error)) throw pageError(termsRefusalMessage(error, 'Arkiveringen'), error);
    const back = await readBackText(version, 'texten arkiverades', error);
    if (back?.textArchived && back.text === text) return { version: back, created: true };
    throw pageError('Anslutningen bröts och texten arkiverades inte. Försök igen.', error);
  }
}
