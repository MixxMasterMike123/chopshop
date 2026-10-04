// src/config/shopConfig.js for the admin build (alias list,
// vite.admin.config.js): the same names, fed by the API of the active shop.
//
//   loadShopConfig(shopId)    GET /v1/admin/settings + GET /v1/admin/shop, in the
//                             flat shape the Firestore storeIdentity had
//                             (providers/shapes.js settingsFromAdmin). The
//                             settings read is kept as the BASELINE of the page
//                             that loaded it (below).
//   loadShopFeatures(shopId)  the `features` of GET /v1/admin/shop
//   saveShopConfig(patch, shopId)  the FENCED PARTIAL WRITE (unit CP5-FP):
//                             PATCH /v1/admin/settings with only the top-level
//                             identity keys and gate fields the patch changes
//                             against the baseline (adapters/settings.js
//                             settingsPatchBody; an object patch is merged into
//                             the stored object as Firestore's merge write did),
//                             fenced on the baseline's updatedAt. The platform's
//                             keys (D99) are never sent. Resolves
//                             { settings, saved, readBack, follow }: the page's
//                             form follows what is stored (`follow(form, formOf)`
//                             → { value, lost }, adapters/merge.js mergeThree,
//                             `formOf` the page's own rule from flat settings to
//                             its form). Rejects:
//                               - code `settings_conflict` (409: the settings
//                                 moved since the page read them; nothing was
//                                 written): `before` and `saved` (flat), and
//                                 `follow`, whose `message` says which of the
//                                 person's edits could not be kept;
//                               - a lost answer is read back first: done → it
//                                 resolves (`readBack`); not done → "sparades
//                                 inte"; another write landed → as a conflict;
//                                 the read fails → "oklart, ladda om";
//                               - the API's refusals as they are (400 …).
//                             This tab's saves run one after another, each on
//                             the baseline the one before left.
//   load/saveCartRecovery, load/saveReviewSettings: the two add-ons are not
//                             ported (D81): the loads answer {}, the saves refuse.
//
// THE BASELINE belongs to the page that loaded it: the latest load of a shop
// owns it. A write's answer moves it forward, unless a load started since the
// write was asked for (another page now owns the baseline; the write's answer
// is not its). A save asked for by a page whose baseline a later load replaced
// is refused, never diffed against a form it was not built on. A page whose
// load failed has no baseline, and its save is refused: diffing the defaults
// it shows against the stored settings would overwrite them. That holds after
// an earlier page's load succeeded too: each load starts by dropping the baseline.

import { adminRequest, getRequestShopId, notAvailable } from '../../api/admin/client.js';
import { getSettings, patchSettings } from '../../api/admin/settings.js';
import { STORE } from '../../config/store.js';
import { mergeThree } from '../adapters/merge.js';
import { isLostAnswer } from '../adapters/platformModels.js';
import {
  GATE_KEYS,
  gateFieldsOf,
  patchHolds,
  settingsAfterPatch,
  settingsConflictMessage,
  settingsPatchBody,
} from '../adapters/settings.js';
import { featuresOf, settingsFromAdmin } from '../providers/shapes.js';
import { readForShop } from '../providers/ordersForShop.js';

const shopOption = (shopId) => (shopId && shopId !== '__unresolved__' ? { shopId } : {});
const keyOf = (shopId) => shopOption(shopId).shopId ?? getRequestShopId();

// shopId → { generation, settings }: `generation` counts the loads started.
const held = new Map();

function heldOf(key) {
  if (!held.has(key)) held.set(key, { generation: 0, settings: null });
  return held.get(key);
}

export const loadShopConfig = async (shopId) => {
  const key = keyOf(shopId);
  const entry = key ? heldOf(key) : null;
  const generation = entry ? ++entry.generation : 0;
  // The page that loads now owns the baseline, and has none until its own read
  // answers: a load that fails must not leave the page before's settings as the
  // baseline of a form that shows defaults.
  if (entry) entry.settings = null;
  const option = shopOption(shopId);
  const [settings, shop] = await Promise.all([
    adminRequest('GET', '/v1/admin/settings', option).then(({ data }) => data?.settings ?? null),
    adminRequest('GET', '/v1/admin/shop', option).then(({ data }) => data?.shop ?? null),
  ]);
  if (entry && entry.generation === generation) entry.settings = settings;
  return settingsFromAdmin(settings, shop);
};

export const loadShopFeatures = async (shopId) => {
  const { data } = await adminRequest('GET', '/v1/admin/shop', shopOption(shopId));
  return featuresOf(data?.shop);
};

const flat = (settings) => settingsFromAdmin(settings, null);

/** An Error the pages show as it is (`userMessage`). */
function pageError(message, cause, extra = {}) {
  const error = new Error(message);
  error.userMessage = message;
  if (cause) error.cause = cause;
  return Object.assign(error, extra);
}

/** A 2xx without the settings: the outcome is unknown, as with no answer. */
function badAnswer() {
  return Object.assign(new Error('The answer did not carry the settings'), { code: 'bad_response' });
}

/** The page's form following `stored`, from `expected` (what the page took to be stored). */
const followFrom = (expected, stored) => (form, formOf) => mergeThree(form, formOf(flat(expected)), formOf(flat(stored)));

function conflictError(base, stored, cause, lostAnswer) {
  const follow = followFrom(base, stored);
  return pageError(settingsConflictMessage([], { lostAnswer }), cause, {
    code: 'settings_conflict',
    before: flat(base),
    saved: flat(stored),
    lostAnswer,
    follow: (form, formOf) => {
      const merged = follow(form, formOf);
      return { ...merged, message: settingsConflictMessage(merged.lost, { lostAnswer }) };
    },
  });
}

async function writeSettings(patch, key, option, generation) {
  const entry = heldOf(key);
  if (entry.generation !== generation) {
    throw pageError('Sidan lästes in på nytt medan ändringen väntade, så den sparades inte. Gör om den.');
  }
  const base = entry.settings;
  if (!base) {
    throw pageError('Butikens inställningar kunde inte läsas när sidan öppnades, så inget sparas härifrån. Ladda om sidan.');
  }
  // Moves the baseline forward, unless a later load owns it now.
  const keep = (settings) => {
    if (entry.generation === generation) entry.settings = settings;
  };
  const body = settingsPatchBody(base, patch, STORE);
  if (body === null) return { settings: base, saved: flat(base), readBack: false, follow: followFrom(base, base) };
  // What the PAGE held for the keys it sent (a gate field as typed, before the
  // server trims it): the form then follows the stored, normalized value.
  const typed = gateFieldsOf(patch);
  const sentAsTyped = settingsAfterPatch(base, {
    ...body,
    ...Object.fromEntries(GATE_KEYS.filter((key) => Object.hasOwn(body, key)).map((key) => [key, typed[key]])),
  });

  let settings;
  try {
    ({ settings } = await patchSettings(body, option));
    if (!settings) throw badAnswer();
  } catch (error) {
    if (error?.code === 'conflict' && error.stored) {
      keep(error.stored);
      throw conflictError(base, error.stored, error, false);
    }
    if (!isLostAnswer(error)) throw error;
    let stored;
    try {
      stored = await getSettings(option);
    } catch {
      stored = null;
    }
    if (!stored) {
      throw pageError('Anslutningen bröts och det är oklart om ändringen sparades. Ladda om sidan och kontrollera innan du försöker igen.', error);
    }
    keep(stored);
    if (patchHolds(stored, body)) {
      return { settings: stored, saved: flat(stored), readBack: true, follow: followFrom(sentAsTyped, stored) };
    }
    if ((stored.updatedAt ?? null) === (base.updatedAt ?? null)) {
      throw pageError('Anslutningen bröts och ändringen sparades inte. Försök igen.', error);
    }
    throw conflictError(base, stored, error, true);
  }
  keep(settings);
  return { settings, saved: flat(settings), readBack: false, follow: followFrom(sentAsTyped, settings) };
}

// The saves of this tab run one after another: a page's two writes in quick
// succession (a text saved on leaving its field, then the acceptance's save)
// each start from the baseline the one before left. An answer that arrives
// after the tab moved to another shop is dropped (readForShop).
let saveQueue = Promise.resolve();

export const saveShopConfig = (patch, shopId) => {
  const option = shopOption(shopId);
  const key = keyOf(shopId);
  if (!key) return adminRequest('PATCH', '/v1/admin/settings', option); // refuses: no shop
  const generation = heldOf(key).generation;
  const write = saveQueue.then(() => writeSettings(patch, key, option, generation));
  saveQueue = write.catch(() => {});
  return readForShop(key, () => write);
};

export const loadCartRecovery = async () => ({});

export const saveCartRecovery = async () => {
  throw notAvailable('Övergiven kassa');
};

export const loadReviewSettings = async () => ({});

export const saveReviewSettings = async () => {
  throw notAvailable('Recensioner');
};
