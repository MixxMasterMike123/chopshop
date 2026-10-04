// The data of the console's "Inställningar → Allmänt" and "Varumärkesfilter"
// pages (unit CP5-FL). Platform requests only (no X-Shop-Id). Tested under
// Node against the dev API (platformSettingsData.test.mjs).
//
// A write whose answer is lost (no answer, an unreadable 2xx, a 5xx) is read
// back before the page says anything: the settings by GET, a term by the
// list. A change of a setting first reads the server's value again, so the
// confirm says "from" the value that is really stored, and a value someone
// else changed meanwhile is not overwritten unseen (the PATCH has no fence).

import {
  addScreeningTerm,
  deleteScreeningTerm,
  getPlatformSettings,
  patchPlatformSettings,
  readAllScreeningTerms,
  rescreenStale,
  updateScreeningTerm,
} from '../../../api/admin/platform.js';
import { isLostAnswer } from '../../adapters/platformModels.js';
import {
  findAddedTerm,
  patchApplied,
  readFailureMessage,
  refusalMessage,
  staleFields,
  staleSettingMessage,
  termHolds,
} from '../../adapters/platformSettings.js';

/** An Error the page shows as it is (`userMessage`); `extra` rides along (e.g. `fresh`). */
export function pageError(message, cause, extra = {}) {
  const error = new Error(message);
  error.userMessage = message;
  if (cause) error.cause = cause;
  return Object.assign(error, extra);
}

/** A 2xx whose body lacks what it must carry: the outcome is unknown, as with no answer. */
function badAnswer() {
  const error = new Error('The answer did not carry the result');
  error.code = 'bad_response';
  return error;
}

const unclear = (what, cause) =>
  pageError(`Anslutningen bröts och det är oklart om ${what}. Ladda om sidan och kontrollera innan du försöker igen.`, cause);

// ── settings ────────────────────────────────────────────────────────────────

export async function loadSettings() {
  try {
    const settings = await getPlatformSettings();
    if (!settings) throw badAnswer();
    return settings;
  } catch (error) {
    throw pageError(readFailureMessage(error, 'Inställningarna'), error);
  }
}

/**
 * The server's settings now, before a change is confirmed. Throws (with
 * `fresh`, the values now) when a value the patch changes moved since the
 * page read `loaded`.
 */
export async function freshSettingsFor(loaded, patch) {
  const fresh = await loadSettings();
  const moved = staleFields(loaded, fresh, patch);
  if (moved.length > 0) throw pageError(staleSettingMessage(moved[0], fresh), null, { fresh });
  return fresh;
}

/** PATCH the named settings → { settings, rescreen, readBack }. */
export async function saveSettings(patch) {
  try {
    const answer = await patchPlatformSettings(patch);
    if (!answer.settings) throw badAnswer();
    return { ...answer, readBack: false };
  } catch (error) {
    if (!isLostAnswer(error)) throw pageError(refusalMessage(error), error);
    let back;
    try {
      back = await getPlatformSettings();
    } catch {
      throw unclear('ändringen sparades', error);
    }
    if (patchApplied(back, patch)) return { settings: back, rescreen: null, readBack: true };
    throw pageError('Anslutningen bröts och ändringen sparades inte. Försök igen.', error, { fresh: back ?? undefined });
  }
}

// ── the brand filter ────────────────────────────────────────────────────────

/** Every term → { terms, termsVersion }. */
export async function loadTerms() {
  try {
    return await readAllScreeningTerms();
  } catch (error) {
    throw pageError(readFailureMessage(error, 'Varumärkesfiltret'), error);
  }
}

/**
 * Whether "Alla träffar spärrar" is on, as the server holds it now: true or
 * false, or null when it cannot be read. Null is never read as "off": while
 * it is not known the page takes no filter write (policyKnown), because what
 * an add, a change, a removal or a re-screen does in the shops depends on it.
 */
export async function loadGlobalHardBlock() {
  try {
    const flag = (await loadSettings()).screeningHardBlock;
    return typeof flag === 'boolean' ? flag : null;
  } catch {
    return null;
  }
}

/** The brand filter's page → { terms, termsVersion, globalHardBlock (true / false / null: not known) }. */
export async function loadScreening() {
  const [list, globalHardBlock] = await Promise.all([loadTerms(), loadGlobalHardBlock()]);
  return { terms: list.terms, termsVersion: list.termsVersion, globalHardBlock };
}

async function readBackTerms(what, cause) {
  try {
    return (await readAllScreeningTerms()).terms;
  } catch {
    throw unclear(what, cause);
  }
}

/**
 * Adds a term (`body` from newTermBody). `before`: the terms the page shows,
 * to tell the new one in a read-back. → { term, rescreen, readBack }.
 */
export async function addTerm(body, before) {
  try {
    const answer = await addScreeningTerm(body);
    if (!answer.term) throw badAnswer();
    return { ...answer, readBack: false };
  } catch (error) {
    if (!isLostAnswer(error)) throw pageError(refusalMessage(error, { what: 'Ordet', term: true }), error);
    const after = await readBackTerms('ordet lades till', error);
    const found = findAddedTerm(before, after, body);
    if (found === 'unclear') throw unclear('ordet lades till', error);
    if (found) return { term: found, rescreen: null, readBack: true };
    throw pageError('Anslutningen bröts och ordet lades inte till. Försök igen.', error);
  }
}

/** Changes the named fields of a term. → { term, rescreen, readBack }. */
export async function updateTerm(term, changes) {
  try {
    const answer = await updateScreeningTerm(term.termKey, changes);
    if (!answer.term) throw badAnswer();
    return { ...answer, readBack: false };
  } catch (error) {
    if (!isLostAnswer(error)) throw pageError(refusalMessage(error, { term: true }), error);
    const after = await readBackTerms('ändringen sparades', error);
    const found = after.find((t) => t.termKey === term.termKey);
    if (!found) throw pageError('Ordet finns inte längre i filtret: någon annan har tagit bort det. Ladda om sidan.', error);
    if (termHolds(found, changes)) return { term: found, rescreen: null, readBack: true };
    throw pageError('Anslutningen bröts och ändringen sparades inte. Försök igen.', error);
  }
}

/** Removes a term. → { rescreen, readBack }. */
export async function removeTerm(term) {
  try {
    const answer = await deleteScreeningTerm(term.termKey);
    if (!answer.deleted) throw badAnswer();
    return { rescreen: answer.rescreen, readBack: false };
  } catch (error) {
    if (!isLostAnswer(error)) throw pageError(refusalMessage(error, { what: 'Borttagningen', term: true }), error);
    const after = await readBackTerms('ordet togs bort', error);
    if (!after.some((t) => t.termKey === term.termKey)) return { rescreen: null, readBack: true };
    throw pageError('Anslutningen bröts och ordet togs inte bort. Försök igen.', error);
  }
}

/**
 * One re-screen run → { rescreened, pending, unverified }. Nothing can be
 * read back after a lost answer (the run leaves no record a route shows), so
 * the page says what is known: it may have run, and the timer runs it anyway.
 */
export async function runRescreen() {
  try {
    const result = await rescreenStale();
    if (!result || !Number.isInteger(result.rescreened)) throw badAnswer();
    return result;
  } catch (error) {
    if (!isLostAnswer(error)) throw pageError(refusalMessage(error, { what: 'Omgranskningen' }), error);
    throw pageError('Anslutningen bröts, så det är oklart om omgranskningen kördes. Den automatiska omgranskningen fortsätter var 15:e minut; du kan också försöka igen.', error);
  }
}
