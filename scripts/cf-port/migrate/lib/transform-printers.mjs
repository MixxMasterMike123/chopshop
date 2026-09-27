/**
 * scripts/cf-port/migrate/lib/transform-printers.mjs — manifest rows 45 + 46:
 * `printerCatalog` → `printer_catalog`; `printers` → `printers` +
 * `printer_sku_tiers`. D12: only `snapwear`; the two uid-keyed legacy printer
 * tiers are archived, not imported (their ids could not satisfy the 0023
 * `id NOT GLOB '*[^a-z0-9-]*'` CHECK anyway). D59: imported INACTIVE on
 * staging; active on production.
 *
 * The Firebase document prices PER GARMENT
 * (pricing.blankCostSek[garment], pricing.printCostSek[slot] shared across
 * garments — see seed-snapwear-printer.cjs); the Worker prices PER PRINTER
 * SKU (printer_sku_tiers keyed by sku). This module derives one tier per SKU
 * in the printer's catalogue by looking up the SKU's garment (from the
 * catalogue's own `skus[sku].garment`, exactly the field
 * seed-snapwear-printer.cjs's catalog JSON carries) and using that garment's
 * blank/print costs. A SKU whose catalogue entry has no resolvable garment,
 * or whose garment has no cost in the Firebase pricing document, is DROPPED
 * from the tier list and reported — never invented (the brief: "If the
 * derivation needs a number the bundle does not contain, stop... do not
 * invent a price").
 *
 * Money: Firebase pricing is stored in whole SEK kronor (integer); D1 wants
 * integer öre (minor units), so every value is multiplied by 100. Both
 * source values are already integers in the seed script's own output
 * (Math.round), so this multiplication is always exact — no rounding is
 * introduced here. A non-integer kronor value (should never occur; guarded
 * anyway) is reported and its SKU dropped rather than silently truncated.
 */

import { createHash } from 'node:crypto';
import { insertStatement } from './sql.mjs';
import { rowContentHash, carriedRow } from './plan.mjs';
import { formatTime } from './time-columns.mjs';

export const SNAPWEAR_PRINTER_ID = 'snapwear';

const PRINT_SLOTS = new Set(['front', 'back', 'pocket', 'left_sleeve', 'right_sleeve']);

function krToMinorExact(kronor, label, problems) {
  if (typeof kronor !== 'number' || !Number.isFinite(kronor)) {
    problems.push(`${label}: not a finite number (${JSON.stringify(kronor)})`);
    return null;
  }
  const minor = kronor * 100;
  if (!Number.isInteger(minor)) {
    problems.push(`${label}: ${kronor} kr does not convert to an exact integer öre value`);
    return null;
  }
  return minor;
}

/**
 * `printAreasMm` (Firebase, per-garment) → the printer's `capabilities_json`
 * shape (per-model, with a synthetic model key per garment since the source
 * has no separate model/SKU capability split the way the Worker schema
 * does — one model per garment, one SKU per catalogue SKU pointing at its
 * garment's model).
 */
function buildCapabilities(printerDoc, catalogDoc, problems) {
  const printAreasMm = printerDoc.printAreasMm ?? {};
  const provisionalAreas = new Set(printerDoc.provisionalAreas ?? []);
  const models = {};
  for (const garment of Object.keys(printAreasMm)) {
    const areas = {};
    for (const [slot, area] of Object.entries(printAreasMm[garment] ?? {})) {
      if (!PRINT_SLOTS.has(slot)) continue;
      if (typeof area?.w !== 'number' || typeof area?.h !== 'number') continue;
      areas[slot] = area.offsetTopMm !== undefined ? { h: area.h, offsetTopMm: area.offsetTopMm, w: area.w } : { h: area.h, w: area.w };
    }
    models[`garment_${garment}`] = {
      garment,
      printAreasMm: areas,
      ...(provisionalAreas.has(garment) ? { provisional: true } : {}),
    };
  }

  const skus = {};
  const catalogSkus = catalogDoc?.data?.skus ?? {};
  for (const [skuKey, entry] of Object.entries(catalogSkus)) {
    const garment = entry?.garment;
    if (typeof garment !== 'string' || garment.length === 0) continue;
    const modelKey = `garment_${garment}`;
    if (models[modelKey] === undefined) {
      // A SKU whose garment has no print-area entry in printers/snapwear:
      // cannot be offered (fail closed, as the Worker's own model does).
      continue;
    }
    skus[skuKey] = { model: modelKey };
  }

  return { capabilities: { models, skus }, garmentsWithModels: new Set(Object.keys(models).map((k) => k.replace('garment_', ''))) };
}

/**
 * @param {object} args.printerDoc  the bundle doc for printers/snapwear (or null if absent)
 * @param {object} args.catalogDoc  the bundle doc for printerCatalog/snapwear (or null if absent)
 * @param {string} args.env
 * @param {number} args.nowMillis  the run's clock, milliseconds since epoch
 * @returns {{ rows: [...], report: object, problems: string[] }}
 */
export function transformSnapwearPrinter({ catalogDoc, env, nowMillis, printerDoc }) {
  const problems = [];
  const rows = [];
  const report = { garmentsOffered: [], importedBy: 'import', skuCount: 0, skusDropped: [], status: env === 'staging' ? 'inactive' : 'active' };

  if (!printerDoc || !catalogDoc) {
    problems.push('printers/snapwear or printerCatalog/snapwear is absent from the bundle — nothing imported for row 45/46');
    return { problems, report, rows };
  }

  const pdata = printerDoc.data ?? {};
  const cdata = catalogDoc.data ?? {};

  const { capabilities, garmentsWithModels } = buildCapabilities(pdata, catalogDoc, problems);
  report.garmentsOffered = [...garmentsWithModels].sort();

  const capabilitiesJson = JSON.stringify(capabilities);
  const printersColumns = ['id', 'tenant_id', 'type', 'name', 'status', 'currency', 'shipping_cost_minor', 'capabilities_json', 'created_at', 'updated_at'];
  const printersRow = {
    capabilities_json: capabilitiesJson,
    created_at: formatTime('printers', 'created_at', nowMillis),
    currency: 'SEK',
    id: SNAPWEAR_PRINTER_ID,
    name: typeof pdata.name === 'string' ? pdata.name : 'SnapWear',
    shipping_cost_minor: typeof pdata.shippingSek === 'number' ? Math.round(pdata.shippingSek * 100) : 0,
    status: env === 'staging' ? 'inactive' : 'active',
    tenant_id: null,
    type: 'api',
    updated_at: formatTime('printers', 'updated_at', nowMillis),
  };
  rows.push(
    carriedRow('printers', SNAPWEAR_PRINTER_ID, insertStatement('printers', printersColumns, printersRow), rowContentHash('printers', printersColumns, printersRow)),
  );

  // Tiers: one per catalogue SKU that resolved to a modelled garment.
  const blankCostSek = pdata.pricing?.blankCostSek ?? {};
  const printCostSek = pdata.pricing?.printCostSek ?? {};
  const catalogSkus = cdata.skus ?? {};
  let skuCount = 0;
  for (const [skuKey, entry] of Object.entries(catalogSkus)) {
    const garment = entry?.garment;
    if (typeof garment !== 'string' || !garmentsWithModels.has(garment)) {
      continue; // not offered (no print area) — not a "missing price" problem
    }
    const blankKr = blankCostSek[garment];
    if (blankKr === undefined) {
      problems.push(`SKU ${skuKey} (garment ${garment}): no blankCostSek entry for this garment — dropped`);
      report.skusDropped.push(skuKey);
      continue;
    }
    const blankMinor = krToMinorExact(blankKr, `blankCostSek.${garment}`, problems);
    if (blankMinor === null) {
      report.skusDropped.push(skuKey);
      continue;
    }
    const printCosts = {};
    let printProblem = false;
    for (const slot of ['front', 'back', 'pocket']) {
      const kr = printCostSek[slot];
      if (kr === undefined) continue;
      const minor = krToMinorExact(kr, `printCostSek.${slot}`, problems);
      if (minor === null) {
        printProblem = true;
        break;
      }
      printCosts[slot] = minor;
    }
    if (printProblem) {
      report.skusDropped.push(skuKey);
      continue;
    }
    const tiersColumns = ['printer_id', 'tenant_id', 'sku', 'blank_cost_minor', 'print_costs_json', 'created_at', 'updated_at'];
    const tiersRow = {
      blank_cost_minor: blankMinor,
      created_at: formatTime('printer_sku_tiers', 'created_at', nowMillis),
      print_costs_json: JSON.stringify(printCosts),
      printer_id: SNAPWEAR_PRINTER_ID,
      sku: skuKey,
      tenant_id: null,
      updated_at: formatTime('printer_sku_tiers', 'updated_at', nowMillis),
    };
    rows.push(
      carriedRow(
        'printer_sku_tiers',
        `${SNAPWEAR_PRINTER_ID}:${skuKey}`,
        insertStatement('printer_sku_tiers', tiersColumns, tiersRow),
        rowContentHash('printer_sku_tiers', tiersColumns, tiersRow),
      ),
    );
    skuCount += 1;
  }
  report.skuCount = skuCount;

  // printer_catalog: sha256 over the exact stored bytes (canonical JSON of
  // the catalogue document as it will be stored — models + skus + source).
  const catalogStored = { models: cdata.models ?? {}, skus: cdata.skus ?? {} };
  const catalogJson = JSON.stringify(catalogStored);
  const contentSha256 = createHash('sha256').update(catalogJson, 'utf8').digest('hex');
  const catalogColumns = ['printer_id', 'catalog_json', 'source', 'pricing_basis_json', 'content_sha256', 'imported_at', 'imported_by'];
  const pricingBasisJson = cdata.pricingBasis ? JSON.stringify(cdata.pricingBasis) : null;
  const catalogRow = {
    catalog_json: catalogJson,
    content_sha256: contentSha256,
    imported_at: formatTime('printer_catalog', 'imported_at', nowMillis),
    imported_by: 'import',
    pricing_basis_json: pricingBasisJson,
    printer_id: SNAPWEAR_PRINTER_ID,
    source: typeof cdata.source?.generator === 'string' ? cdata.source.generator : null,
  };
  rows.push(
    carriedRow('printer_catalog', SNAPWEAR_PRINTER_ID, insertStatement('printer_catalog', catalogColumns, catalogRow), rowContentHash('printer_catalog', catalogColumns, catalogRow)),
  );

  return { problems, report, rows };
}
