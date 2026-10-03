// The platform printers page's adapter (CP5 unit FK): the Worker's printer
// (PlatformPrinterView, cloudflare/src/pod/printers.ts) ↔ the page's printer
// doc (the shape of the older build's printers/{uid}: garments, pricing in
// kronor per garment and per print slot, print frames per garment × slot,
// provisional garments). Pure; tested under Node (platformPrinters.test.mjs).
//
// PLATFORM-ONLY: prices, print frames and supplier facts. Only the platform
// console's printer data module imports this file (the seller sees ONE
// number); no module of the admin tree may.
//
// THE TWO MODELS. The page edits one blank price per GARMENT, one print price
// per SLOT for the whole printer, and one frame per garment × slot. The Worker
// stores a capability document of MODELS (each with a garment, its frames and
// a provisional flag) and SKUs (each pointing at a model), and one price tier
// per SKU (blank + a price per slot). The imported printer has one model per
// garment and uniform prices per garment (scripts/cf-port/migrate/lib/
// transform-printers.mjs), and the catalogue's apply prices per model, so the
// page's shape is usually exact. Where it is not — two models of one garment
// with different frames, SKUs of one garment with different prices — the
// value is "mixed": the form shows it empty, the editor's note says so, and a
// save leaves an untouched mixed field exactly as the server holds it.
//
// THE WRITE IS A DIFF against what the page was shown (the projected doc):
// only a field the operator changed is written, to every model or SKU tier of
// its garment (a print price: to every tier). Never a price computed here:
// kronor typed by the operator become öre (×100, exactly, at most two
// decimals), and öre from the server become kronor for the form (÷100).

import { POD_GARMENTS, garmentLabel } from '../../config/podGarments.js';
import { PRICED_SLOTS } from '../../components/platform/printerTierForm.js';

/** The Worker's print slots (printers.ts PRINT_SLOTS) = the page's priced and framed slots. */
export const SLOT_IDS = PRICED_SLOTS.map((s) => s.id);
const SLOT_LABEL = Object.fromEntries(PRICED_SLOTS.map((s) => [s.id, s.label]));
const GARMENT_IDS = POD_GARMENTS.map((g) => g.id);
const KNOWN_GARMENT = new Set(GARMENT_IDS);

/** printers.ts MAX_COST_MINOR and MAX_AREA_MM. */
export const MAX_COST_MINOR = 10_000_000;
export const MAX_AREA_MM = 2_000;

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;

/** Order-independent JSON, so two equal frames or tiers compare equal. */
const stable = (v) => JSON.stringify(v ?? null, (_k, x) => (isObject(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

/** öre → kronor for the form (undefined when not a stored amount). */
export const kronorOf = (minor) => (isInt(minor, 0, MAX_COST_MINOR) ? minor / 100 : undefined);

/**
 * kronor (a number from the form, see printerTierForm.js) → öre. undefined
 * stays undefined ("no price"); more than two decimals or out of bounds →
 * NaN (refused).
 */
export function minorOf(kronor) {
  if (kronor === undefined || kronor === null) return undefined;
  if (typeof kronor !== 'number' || !Number.isFinite(kronor) || kronor < 0) return Number.NaN;
  const minor = Math.round(kronor * 100);
  if (Math.abs(kronor * 100 - minor) > 1e-6 || minor > MAX_COST_MINOR) return Number.NaN;
  return minor;
}

/** A stored frame → { w, h, offsetTopMm? }, or null when it is not one. */
function frameOf(area) {
  if (!isObject(area) || !isInt(area.w, 1, MAX_AREA_MM) || !isInt(area.h, 1, MAX_AREA_MM)) return null;
  return isInt(area.offsetTopMm, 0, MAX_AREA_MM)
    ? { w: area.w, h: area.h, offsetTopMm: area.offsetTopMm }
    : { w: area.w, h: area.h };
}

function capabilitiesOf(view) {
  const caps = isObject(view?.capabilities) ? view.capabilities : {};
  return { models: isObject(caps.models) ? caps.models : {}, skus: isObject(caps.skus) ? caps.skus : {} };
}

/** sku → { blankCostMinor, printCostsMinor } (only valid amounts and slots kept). */
function tiersOf(view) {
  const tiers = new Map();
  for (const tier of Array.isArray(view?.tiers) ? view.tiers : []) {
    if (typeof tier?.sku !== 'string' || !isInt(tier.blankCostMinor, 0, MAX_COST_MINOR)) continue;
    const prints = {};
    if (isObject(tier.printCostsMinor)) {
      for (const [slot, cost] of Object.entries(tier.printCostsMinor)) {
        if (SLOT_IDS.includes(slot) && isInt(cost, 0, MAX_COST_MINOR)) prints[slot] = cost;
      }
    }
    tiers.set(tier.sku, { blankCostMinor: tier.blankCostMinor, printCostsMinor: prints });
  }
  return tiers;
}

/** The models and SKUs of each garment the page knows. */
function garmentIndex(caps) {
  const index = {};
  for (const g of GARMENT_IDS) {
    const models = Object.keys(caps.models).filter((key) => caps.models[key]?.garment === g);
    const skus = Object.keys(caps.skus).filter((sku) => models.includes(caps.skus[sku]?.model));
    index[g] = { models, skus };
  }
  return index;
}

const MIXED = Symbol('mixed');

/** One value when all agree (null = all absent), MIXED when they differ, null for none. */
function agreed(values) {
  if (values.length === 0) return null;
  const first = stable(values[0]);
  return values.every((v) => stable(v) === first) ? values[0] : MIXED;
}

/**
 * The page's printer doc of one PlatformPrinterView: what PlatformPrinters
 * and PrinterRow read (name, type, active, garments, pricing, printAreasMm,
 * provisionalAreas) plus what the next edit needs (`view`, `revision`) and
 * the fields the form cannot show as one value (`mixed`).
 */
export function printerDocOf(view) {
  const caps = capabilitiesOf(view);
  const tiers = tiersOf(view);
  const index = garmentIndex(caps);
  const mixed = { blank: [], print: [], areas: [], provisional: [] };

  const garments = GARMENT_IDS.filter((g) => index[g].models.length > 0);
  const blankCostSek = {};
  const printAreasMm = {};
  const provisionalAreas = [];
  for (const g of garments) {
    const { models, skus } = index[g];
    if (skus.length > 0) {
      const blank = agreed(skus.map((sku) => tiers.get(sku)?.blankCostMinor ?? null));
      if (blank === MIXED) mixed.blank.push(g);
      else if (blank !== null) blankCostSek[g] = kronorOf(blank);
    }
    const frames = {};
    for (const slot of SLOT_IDS) {
      const frame = agreed(models.map((key) => frameOf(caps.models[key]?.printAreasMm?.[slot])));
      if (frame === MIXED) mixed.areas.push(`${g}/${slot}`);
      else if (frame !== null) frames[slot] = frame;
    }
    // Every offered garment gets an entry, an empty one when it has no frame
    // (printerTierForm.js formToPrintAreas: {} = printable nowhere).
    printAreasMm[g] = frames;
    const provisional = agreed(models.map((key) => caps.models[key]?.provisional === true));
    if (provisional === MIXED) mixed.provisional.push(g);
    else if (provisional === true) provisionalAreas.push(g);
  }

  const printCostSek = {};
  const allTiers = [...tiers.values()];
  for (const slot of SLOT_IDS) {
    const cost = agreed(allTiers.map((t) => t.printCostsMinor[slot] ?? null));
    if (cost === MIXED) mixed.print.push(slot);
    else if (cost !== null) printCostSek[slot] = kronorOf(cost);
  }

  return {
    id: view.printerId,
    name: typeof view.name === 'string' ? view.name : view.printerId,
    type: view.type,
    active: view.status === 'active',
    tenantId: view.tenantId ?? null,
    currency: view.currency,
    revision: view.revision,
    garments,
    pricing: { blankCostSek, printCostSek },
    printAreasMm,
    provisionalAreas,
    mixed,
    view,
  };
}

const garmentNames = (ids) => ids.map(garmentLabel).join(', ');

/** The line shown when the tier editor opens, or null: what the form cannot show or save. */
export function tierEditorNoteOf(doc) {
  if (!doc?.view) return null;
  if (doc.tenantId) return 'Det här är en butiks eget tryckeri: det redigeras inte här.';
  if (doc.view.capabilitiesValid === false) {
    return 'Tryckeriets lagrade plagg- och ytdokument är ogiltigt: plagg, priser och tryckytor kan inte sparas här.';
  }
  const m = doc.mixed;
  const parts = [
    ...m.blank.map((g) => `${garmentLabel(g)} (blankpris)`),
    ...m.print.map((s) => `${SLOT_LABEL[s]} (tryckpris)`),
    ...m.areas.map((key) => {
      const [g, s] = key.split('/');
      return `${garmentLabel(g)} ${SLOT_LABEL[s].toLowerCase()} (tryckyta)`;
    }),
    ...m.provisional.map((g) => `${garmentLabel(g)} (preliminära mått)`),
  ];
  if (parts.length === 0) return null;
  return `Olika värden per artikel för: ${parts.join(', ')}. Ett sådant fält visas tomt och lämnas orört när du sparar; ett ifyllt värde gäller alla artiklar av plagget.`;
}

/**
 * The PATCH body of one tier-editor save: the diff between what the page was
 * shown (`doc`, from printerDocOf) and what the operator saves (`payload`:
 * { garments, pricing: { blankCostSek, printCostSek }, printAreasMm,
 * provisionalAreas }, built by printerTierForm.js). → { body } (null when
 * nothing changed) or { problems: [Swedish lines] } (nothing is sent).
 */
export function printerPatchOf(doc, payload) {
  const view = doc?.view;
  if (!view) return { problems: ['Tryckeriet hittades inte. Ladda om sidan.'] };
  if (doc.tenantId) return { problems: ['Butikens eget tryckeri redigeras inte här.'] };
  if (view.capabilitiesValid === false) {
    return { problems: ['Tryckeriets lagrade plagg- och ytdokument är ogiltigt och kan inte sparas här.'] };
  }
  const problems = [];

  // The garments: the catalogue decides them (a garment is its models and SKUs).
  const had = new Set(doc.garments);
  const has = new Set((payload.garments || []).filter((g) => KNOWN_GARMENT.has(g)));
  const added = GARMENT_IDS.filter((g) => has.has(g) && !had.has(g));
  const removed = GARMENT_IDS.filter((g) => had.has(g) && !has.has(g));
  if (added.length) problems.push(`${garmentNames(added)} finns inte i tryckeriets katalog och kan inte läggas till här.`);
  if (removed.length) problems.push(`${garmentNames(removed)} tas inte bort ur tryckeriets utbud här (det görs i katalogen).`);
  const kept = GARMENT_IDS.filter((g) => had.has(g) && has.has(g));

  const caps = structuredClone(capabilitiesOf(view));
  const index = garmentIndex(caps);
  let capsChanged = false;

  // The frames and the provisional flag: to every model of the garment.
  for (const g of kept) {
    const { models } = index[g];
    for (const slot of SLOT_IDS) {
      const before = doc.printAreasMm?.[g]?.[slot];
      const after = payload.printAreasMm?.[g]?.[slot];
      if (stable(before) === stable(after)) continue;
      let frame = null;
      if (after !== undefined) {
        frame = frameOf(after);
        const topOk = after.offsetTopMm === undefined || isInt(after.offsetTopMm, 0, MAX_AREA_MM);
        if (frame === null || !topOk) {
          problems.push(`${garmentLabel(g)} ${SLOT_LABEL[slot].toLowerCase()}: tryckytan anges i hela millimeter (1–${MAX_AREA_MM}, topp 0–${MAX_AREA_MM}).`);
          continue;
        }
      }
      for (const key of models) {
        const areas = { ...(isObject(caps.models[key].printAreasMm) ? caps.models[key].printAreasMm : {}) };
        if (frame) areas[slot] = frame;
        else delete areas[slot];
        caps.models[key].printAreasMm = areas;
      }
      capsChanged = true;
    }
    const wasProvisional = (doc.provisionalAreas || []).includes(g);
    const isProvisional = (payload.provisionalAreas || []).includes(g);
    if (wasProvisional !== isProvisional) {
      for (const key of models) {
        if (isProvisional) caps.models[key].provisional = true;
        else delete caps.models[key].provisional;
      }
      capsChanged = true;
    }
  }

  // The prices: a blank price to every SKU of its garment, a print price to every tier.
  const blankChange = new Map();
  for (const g of kept) {
    const before = minorOf(doc.pricing?.blankCostSek?.[g]);
    const after = minorOf(payload.pricing?.blankCostSek?.[g]);
    if (Number.isNaN(after)) {
      problems.push(`${garmentLabel(g)}: blankpriset anges i kronor med högst två decimaler.`);
    } else if (before !== after) {
      if (after !== undefined && index[g].skus.length === 0) {
        problems.push(`${garmentLabel(g)}: tryckeriet har inga artiklar av plagget att prissätta.`);
      } else {
        blankChange.set(g, after);
      }
    }
  }
  const printAfter = {};
  const printChange = new Map();
  for (const slot of SLOT_IDS) {
    const before = minorOf(doc.pricing?.printCostSek?.[slot]);
    const after = minorOf(payload.pricing?.printCostSek?.[slot]);
    if (Number.isNaN(after)) {
      problems.push(`${SLOT_LABEL[slot]}: tryckpriset anges i kronor med högst två decimaler.`);
      continue;
    }
    if (after !== undefined) printAfter[slot] = after;
    if (before !== after) printChange.set(slot, after);
  }
  if ((blankChange.size > 0 || printChange.size > 0) && view.currency !== 'SEK') {
    problems.push(`Tryckeriet prissätts i ${view.currency}; priserna här är i kronor och kan inte sparas.`);
  }
  if (problems.length > 0) return { problems };

  const garmentOfModel = Object.fromEntries(Object.entries(caps.models).map(([key, m]) => [key, m?.garment]));
  const tiers = tiersOf(view);
  const upsert = [];
  const remove = [];
  for (const sku of Object.keys(caps.skus).sort()) {
    const g = garmentOfModel[caps.skus[sku]?.model];
    const old = tiers.get(sku);
    let blank;
    if (kept.includes(g) && blankChange.has(g)) {
      blank = blankChange.get(g);
      if (blank === undefined) {
        // An emptied blank price = not priced: the tier goes (a mapping of it is then refused).
        if (old) remove.push(sku);
        continue;
      }
    } else if (old) {
      blank = old.blankCostMinor;
    } else {
      continue; // unpriced and its price not given: it stays unpriced
    }
    let prints;
    if (old) {
      prints = { ...old.printCostsMinor };
      for (const [slot, cost] of printChange) {
        if (cost === undefined) delete prints[slot];
        else prints[slot] = cost;
      }
    } else {
      prints = { ...printAfter };
    }
    const next = { blankCostMinor: blank, printCostsMinor: prints };
    if (!old || stable(old) !== stable(next)) upsert.push({ sku, ...next });
  }

  if (!capsChanged && upsert.length === 0 && remove.length === 0) return { body: null };
  const body = {};
  if (Number.isSafeInteger(view.revision) && view.revision >= 0) body.expectedRevision = view.revision;
  if (capsChanged) body.capabilities = caps;
  if (upsert.length || remove.length) {
    body.tiers = {};
    if (upsert.length) body.tiers.upsert = upsert;
    if (remove.length) body.tiers.remove = remove;
  }
  return { body };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The extra line of the save's toast, from the server's answer: what the edit did to live products. Or null. */
export function saveNoteOf({ diff, suspendedMappings } = {}) {
  const lines = [];
  if (Number.isInteger(suspendedMappings) && suspendedMappings > 0) {
    lines.push(`${plural(suspendedMappings, 'produktkoppling', 'produktkopplingar')} pausades: tryckeriet kan inte längre göra ${suspendedMappings === 1 ? 'den' : 'dem'}.`);
  }
  const floor = diff?.belowFloor;
  if (floor?.tooManyToCheck === true) {
    lines.push('Prisgolvet kunde inte kontrolleras för alla produkter (för många).');
  } else if (Number.isInteger(floor?.count) && floor.count > 0) {
    lines.push(`${plural(floor.count, 'produkt', 'produkter')} ligger nu under prisgolvet.`);
  }
  return lines.length ? lines.join(' ') : null;
}

/** An API error of the printer routes → a line in the page's language, or null (the page's own text). */
export function printerErrorMessage(error) {
  const problems = Array.isArray(error?.details?.problems) ? error.details.problems.filter((p) => typeof p === 'string') : [];
  switch (error?.code) {
    case 'revision_mismatch':
    case 'concurrent_edit':
      return 'Tryckeriet har ändrats sedan sidan laddades. Ladda om sidan och gör ändringen igen.';
    case 'tenant_printer':
      return error.status === 422
        ? 'Ett butikstryckeri kan inte vara standardtryckeri.'
        : 'Butikens eget tryckeri redigeras inte här.';
    case 'too_many_mappings':
      return 'Tryckeriet har för många aktiva produktkopplingar för att ändras i ett steg.';
    case 'printer_not_allowed':
      return 'Det här tryckeriet kan inte ändras i den här miljön (det är inte miljöns tryckeri).';
    case 'invalid_tiers':
    case 'invalid_capabilities':
      return `Servern godtog inte ändringen${problems.length ? `: ${problems.join('; ')}` : '.'}`;
    case 'printer_not_found':
    case 'printer_inactive':
      return 'Standardtryckeriet måste finnas och vara aktivt.';
    case 'invalid_request':
      return 'Servern godtog inte värdena.';
    case 'not_found':
      return 'Tryckeriet hittades inte. Ladda om sidan.';
    case 'network_error':
      return 'Servern kunde inte nås.';
    default:
      return null;
  }
}
