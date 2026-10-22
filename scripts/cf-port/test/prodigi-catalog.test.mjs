// node --test scripts/cf-port/test/prodigi-catalog.test.mjs  — fixtures only, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FLAT_MODELS, MODELS, assertKey, buildFlatCatalog, flatChoice, flatQuoteRequest, matchQuoteItem, areaPx, buildCatalog, buildPricing, colourOfSlug, colourSizes, eurToMinor,
  euVariants, modelFrame, normSize, pickProbes, pxToMm, quoteJobs, readQuote, skuKey, slug, splitSkuKey, variantsFor,
} from "../prodigi-catalog.mjs";

const SAMPLES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/cf-port/prodigi-api-samples");
const load = (name) => JSON.parse(readFileSync(join(SAMPLES, name), "utf8"));
const tee = load("product-GLOBAL-TEE-GIL-64000.json").product;
const SKU_GRAMMAR = /^[A-Za-z0-9._-]{1,64}$/;

test("pxToMm: 300 dpi, integer mm", () => {
  assert.equal(pxToMm(4665), 395);
  assert.equal(pxToMm(5844), 495);
  assert.equal(pxToMm(3307), 280);
  assert.equal(pxToMm(4606), 390);
});

test("slug / key round trip", () => {
  assert.equal(slug("Dark Heather Grey"), "dark-heather-grey");
  assert.equal(colourOfSlug("dark-heather-grey"), "dark heather grey");
  const key = skuKey("GLOBAL-TEE-GIL-64000", "dark heather grey", "2xl");
  assert.equal(key, "GLOBAL-TEE-GIL-64000.dark-heather-grey.2xl");
  assert.deepEqual(splitSkuKey(key), { sku: "GLOBAL-TEE-GIL-64000", color: "dark heather grey", size: "2xl" });
  assert.equal(splitSkuKey("nodots"), null);
});

test("normSize", () => {
  assert.equal(normSize("2xl"), "2XL");
  assert.equal(normSize("m"), "M");
});

test("eurToMinor", () => {
  assert.equal(eurToMinor("11.00"), 1100);
  assert.equal(eurToMinor("5.35"), 535);
  assert.equal(eurToMinor("8"), 800);
  assert.throws(() => eurToMinor("abc"));
});

test("assertKey refuses a non-test key unless live", () => {
  assert.throws(() => assertKey("331cc3c1-0000-0000-0000-000000000000"), /test_/);
  assert.doesNotThrow(() => assertKey("test_00000000-0000-0000-0000-000000000000"));
  assert.doesNotThrow(() => assertKey("331cc3c1-0000-0000-0000-000000000000", true));
  assert.throws(() => assertKey(undefined));
});

test("variantsFor / colourSizes keep only what ships to SE", () => {
  const all = tee.variants.length;
  const se = variantsFor(tee);
  assert.ok(se.length > 0 && se.length < all);
  assert.ok(se.every((v) => v.shipsTo.includes("SE")));
  const pairs = colourSizes(tee);
  assert.ok(pairs.some((p) => p.color === "black" && p.size === "m"));
  assert.equal(new Set(pairs.map((p) => `${p.color}|${p.size}`)).size, pairs.length);
});

test("modelFrame: EU variant area, offsetTopMm 0, integer mm", () => {
  const f = modelFrame(variantsFor(tee), "front");
  assert.equal(f.mm.offsetTopMm, 0);
  assert.ok(Number.isInteger(f.mm.w) && Number.isInteger(f.mm.h));
  for (const v of variantsFor(tee)) {
    const a = areaPx(v, "front");
    if (a) assert.ok(a.w * a.h >= f.px.w * f.px.h);
  }
  assert.equal(modelFrame([], "front"), null);
});

test("readQuote: the real 64000 black M quote", () => {
  const log = load("quotes-GLOBAL-TEE-GIL-64000.json");
  const q = readQuote(log[0].body);
  assert.ok(q);
  const first = Object.values(q.items)[0];
  assert.ok(Number.isInteger(first.unitMinor) && first.unitMinor > 0);
  assert.match(first.lab, /^(pl1|nl2)$/);
  assert.equal(readQuote({ outcome: "ValidationFailed" }), null);
  assert.equal(readQuote(null), null);
});

test("quoteJobs: one request per colour, all its sizes", () => {
  const jobs = quoteJobs(MODELS[0], tee);
  const colours = new Set(colourSizes(tee).map((p) => p.color));
  assert.equal(jobs.length, colours.size);
  for (const j of jobs) {
    assert.equal(j.request.destinationCountryCode, "SE");
    assert.equal(j.request.shippingMethod, "Standard");
    assert.ok(j.request.items.every((i) => i.sku === "GLOBAL-TEE-GIL-64000" && i.attributes.color === j.color));
  }
});

function offlineCatalog() {
  const products = {};
  const quotes = {};
  const shipping = {};
  for (const def of MODELS) {
    products[def.model] = load(`product-${def.sku}.json`);
    for (const e of load(`quotes-${def.sku}.json`)) {
      const q = readQuote(e.body);
      if (!q) continue;
      if (e.shippingProbe) {
        const s = q.shipments[0];
        const slot = (shipping[e.shippingProbe.lab] ??= {});
        if (e.shippingProbe.copies === 1) slot.firstMinor = s.shippingMinor;
        else slot.twoCopiesMinor = s.shippingMinor;
        continue;
      }
      e.request.items.forEach((item, i) => {
        if (q.items[String(i + 1)]) quotes[skuKey(item.sku, item.attributes.color, item.attributes.size ?? "one size")] = q.items[String(i + 1)];
      });
    }
  }
  return buildCatalog({ products, quotes, quoteDate: "2026-10-19", shipping, generatedAt: "2026-10-19T00:00:00Z" });
}

test("the built document: shape applyCatalog reads", { skip: !existsSync(join(SAMPLES, "quotes-TEE-SS-STTU755.json")) }, () => {
  const { document } = offlineCatalog();
  assert.equal(Object.keys(document.models).length, MODELS.length);
  for (const [code, m] of Object.entries(document.models)) {
    assert.match(code, /^[A-Za-z0-9._-]{1,64}$/);
    assert.ok(["tee", "hoodie", "sweatshirt", "tank", "tote"].includes(m.garment));
    assert.ok(m.front && m.front.offsetTopMm === 0 && m.front.w > 0 && m.front.h > 0, `${code} front`);
  }
  for (const [key, s] of Object.entries(document.skus)) {
    assert.match(key, SKU_GRAMMAR);
    assert.ok(document.models[s.model], key);
    assert.equal(typeof s.colour, "string");
    assert.equal(typeof s.size, "string");
    const parts = splitSkuKey(key);
    assert.equal(parts.sku, s.prodigiSku);
    assert.equal(parts.color, s.attributes.color.toLowerCase());
    assert.equal(parts.size, slug(s.attributes.size ?? "one size")); // the tote has no size attribute
  }
  assert.ok(JSON.stringify(document).length < 1_048_576, "inside CATALOG_MAX_BYTES");
});

test("pricing basis: <= 16 KiB, EUR minor units, PL shipping", { skip: !existsSync(join(SAMPLES, "quotes-TEE-SS-STTU755.json")) }, () => {
  const { document, shipping } = offlineCatalog();
  const { pricingBasis, applyEur } = buildPricing({ document, shipping, quoteDate: "2026-10-19", extraItemMinor: 100 });
  assert.ok(Buffer.byteLength(JSON.stringify(pricingBasis)) <= 16_384);
  assert.equal(pricingBasis.currency, "EUR");
  assert.equal(pricingBasis.extraItemMinor, 100);
  assert.equal(applyEur.basis, "eur");
  assert.equal(applyEur.extraPrintEurCents, 0);
  for (const [m, v] of Object.entries(applyEur.models)) {
    assert.ok(Number.isInteger(v.baseEurCents) && v.baseEurCents > 0, m);
  }
});

test("pickProbes: one probe per lab not yet probed", () => {
  const log = load("quotes-GLOBAL-TEE-GIL-5000.json").filter((e) => !e.shippingProbe);
  const probes = pickProbes(log);
  const labs = probes.map((p) => p.lab);
  assert.equal(new Set(labs).size, labs.length);
  assert.ok(labs.includes("pl1"));
  assert.ok(probes.every((p) => p.item.sku === "GLOBAL-TEE-GIL-5000"));
  // already probed labs are not probed again
  assert.deepEqual(pickProbes(load("quotes-GLOBAL-TEE-GIL-5000.json")), []);
});

test("shipping probes in the saved quotes: PL first item 1185, NL 535, +100 per extra item", () => {
  const { shipping } = offlineCatalog();
  assert.equal(shipping.pl1.firstMinor, 1185);
  assert.equal(shipping.nl2.firstMinor, 535);
  assert.equal(shipping.pl1.twoCopiesMinor - shipping.pl1.firstMinor, 100);
});

test("the committed docs/cf-port/prodigi-catalog.json agrees with the fixtures", () => {
  const committed = JSON.parse(readFileSync(join(SAMPLES, "../prodigi-catalog.json"), "utf8"));
  const { document } = offlineCatalog();
  assert.deepEqual(committed.models, document.models);
  assert.deepEqual(committed.skus, document.skus);
});

// ── CP11-U4B: 18600 (required `edge`) and the tote (no size, print area "default") ──
test("U4B models are registered with confirmed SKU strings", () => {
  const by = Object.fromEntries(MODELS.map((m) => [m.model, m]));
  assert.equal(by["64000L"].sku, "GLOBAL-TEE-GIL-64000L");
  assert.equal(by["18600"].sku, "GLOBAL-HOOD-GIL-18600");
  assert.equal(by["64200"].sku, "GLOBAL-TT-GIL-64200");
  assert.equal(by["JH001F"].sku, "HOOD-AWD-JH001F");
  assert.equal(by["STAU773"].sku, "H-BAG-LTOTE");
  assert.equal(by["STAU773"].garment, "tote");
});

test("18600: edge is carried into the quote attributes (Zip for white, Drawstring otherwise)", () => {
  const zip = load("product-GLOBAL-HOOD-GIL-18600.json").product;
  const pairs = colourSizes(zip);
  assert.ok(pairs.length > 0 && pairs.every((p) => p.edge === "Zip" || p.edge === "Drawstring"));
  assert.ok(pairs.filter((p) => p.color === "white").every((p) => p.edge === "Zip"));
  const jobs = quoteJobs({ model: "18600", sku: "GLOBAL-HOOD-GIL-18600" }, zip);
  assert.ok(jobs.every((j) => j.request.items.every((i) => typeof i.attributes.edge === "string")));
  // a product with a single edge value never sends one
  const hood = load("product-GLOBAL-HOOD-GIL-18500.json").product;
  assert.ok(colourSizes(hood).every((p) => p.edge === undefined));
});

test("tote: no size attribute, one size key, print area from slot default, quote asks for default", () => {
  const tote = load("product-H-BAG-LTOTE.json").product;
  const pairs = colourSizes(tote);
  assert.equal(pairs.length, 13);
  assert.ok(pairs.every((p) => p.sizeless && p.size === "one size"));
  const jobs = quoteJobs({ model: "STAU773", sku: "H-BAG-LTOTE" }, tote);
  assert.deepEqual(jobs[0].request.items[0].attributes, { color: jobs[0].color });
  assert.equal(jobs[0].request.items[0].assets[0].printArea, "default");
  const key = skuKey("H-BAG-LTOTE", "natural raw", "one size");
  assert.equal(key, "H-BAG-LTOTE.natural-raw.one-size");
  assert.match(key, SKU_GRAMMAR);
});

test("the committed catalogue carries the U4B models", () => {
  const cat = JSON.parse(readFileSync(join(SAMPLES, "../prodigi-catalog.json"), "utf8"));
  for (const m of ["64000L", "18600", "64200", "JH001F", "STAU773"]) assert.ok(cat.models[m], m);
  assert.equal(cat.models.STAU773.front.w, 270);
  assert.equal(cat.unquoted.length, 0);
  assert.ok(Object.values(cat.skus).filter((s) => s.model === "STAU773").every((s) => !("size" in s.attributes)));
});

// ── CP11-U8: F8 (opaque quote item ids) ──────────────────────────────────
/** A real saved quote with every item id (and the shipment references) replaced by an opaque `qit_…` string, order shuffled. */
function opaque(body) {
  const copy = structuredClone(body);
  const q = copy.quotes[0];
  const map = new Map(q.items.map((it, i) => [it.id, `qit_${(i * 7919 + 13).toString(36)}x${i}`]));
  q.items.forEach((it) => (it.id = map.get(it.id)));
  q.items.reverse();
  q.shipments.forEach((sh) => (sh.items = sh.items.map((id) => map.get(id))));
  return copy;
}

test("F8: readQuote + matchQuoteItem work with opaque qit_ ids and a reordered response", () => {
  const e = load("quotes-GLOBAL-TEE-GIL-5000.json")[0];
  const plain = readQuote(e.body);
  const o = readQuote(opaque(e.body));
  assert.ok(Object.keys(o.items).every((id) => id.startsWith("qit_")));
  for (const item of e.request.items) {
    const a = matchQuoteItem(plain, item);
    const b = matchQuoteItem(o, item);
    assert.equal(b.unitMinor, a.unitMinor);
    assert.equal(b.lab, a.lab);
    assert.ok(b.id.startsWith("qit_"));
  }
  assert.equal(o.shipments[0].itemIds.every((id) => id.startsWith("qit_")), true);
});

test("F8: pickProbes finds the same probes when the ids are opaque (it returned none before)", () => {
  const log = load("quotes-GLOBAL-TEE-GIL-5000.json").filter((x) => !x.shippingProbe);
  const want = pickProbes(log).map((p) => p.lab).sort();
  assert.ok(want.length > 0);
  const got = pickProbes(log.map((x) => ({ ...x, body: opaque(x.body) }))).map((p) => p.lab).sort();
  assert.deepEqual(got, want);
});

test("F8: no match and an ambiguous match both throw", () => {
  const e = load("quotes-GLOBAL-TEE-GIL-5000.json")[0];
  const q = readQuote(opaque(e.body));
  assert.throws(() => matchQuoteItem(q, { ...e.request.items[0], sku: "NOPE" }), /not found/);
  assert.throws(() => matchQuoteItem(q, { ...e.request.items[0], attributes: { color: "no-such" } }), /not found/);
  const dup = { ...q, list: [...q.list, { ...q.list[0], id: "qit_dup" }] };
  assert.throws(() => matchQuoteItem(dup, e.request.items.find((i) => i.attributes.size === q.list[0].attributes.size && i.attributes.color === q.list[0].attributes.color)), /ambiguous/);
  // duplicate ids make the quote unusable rather than silently overwriting
  const bad = structuredClone(e.body);
  bad.quotes[0].items[1].id = bad.quotes[0].items[0].id;
  assert.equal(readQuote(bad), null);
});

test("F8: every request asks for EUR", () => {
  assert.ok(quoteJobs(MODELS[0], tee).every((j) => j.request.currencyCode === "EUR"));
  assert.equal(flatQuoteRequest(FLAT_MODELS[0], {}).currencyCode, "EUR");
});

// ── CP11-U8: the flat catalogue (framed posters) ─────────────────────────
const flatProducts = () => Object.fromEntries(FLAT_MODELS.map((d) => [d.model, load(`product-${d.sku}.json`)]));
const flatQuotesOf = (ids) =>
  Object.fromEntries(
    FLAT_MODELS.map((d) => {
      const e = load(`quotes-${d.sku}.json`)[0];
      return [d.model, matchQuoteItem(readQuote(ids ? opaque(e.body) : e.body), e.request.items[0])];
    }),
  );

test("flatChoice: black is preferred but does not exist; white is the only colour common to all four", () => {
  for (const d of FLAT_MODELS) {
    const c = flatChoice(load(`product-${d.sku}.json`).product);
    assert.equal(c.color, "white");
    assert.equal(c.attributes.mount, "No mount / Mat");
  }
});

test("buildFlatCatalog: the 12x16 poster (kind flat, one default area, fixed attributes, SKU key grammar)", () => {
  const doc = buildFlatCatalog({ products: flatProducts(), quotes: flatQuotesOf(true), quoteDate: "2026-10-20", generatedAt: "x" });
  const m = doc.models["BFP-12X16"];
  assert.equal(m.kind, "flat");
  assert.equal(m.garment, "poster");
  assert.equal(m.prodigiPrintArea, "default");
  assert.deepEqual(m.requiredSlots, ["front"]);
  assert.deepEqual(m.printAreaPx.front, { w: 3543, h: 4724 });
  assert.deepEqual(m.front, { h: 400, offsetTopMm: 0, w: 300 });
  const key = "GLOBAL-BFP-12X16.white-frame.12x16";
  assert.match(key, SKU_GRAMMAR);
  assert.equal(doc.skus[key].unitCostMinor, 1900);
  assert.equal(doc.skus[key].lab, "prodigi_eu");
  assert.deepEqual(doc.skus[key].attributes, m.attributes);
  assert.deepEqual(Object.keys(doc.skus).length, 4);
  assert.deepEqual(doc.unquoted, []);
  assert.equal(doc.pricingBasis.shippingCostMinor, 1395);
  assert.deepEqual(doc.applyPricingEur.models["BFP-18X24"], { baseEurCents: 2800 });
});

test("the committed docs/cf-port/prodigi-prints-catalog.json agrees with the fixtures", () => {
  const committed = JSON.parse(readFileSync(join(SAMPLES, "../prodigi-prints-catalog.json"), "utf8"));
  const doc = buildFlatCatalog({ products: flatProducts(), quotes: flatQuotesOf(false), quoteDate: committed.source.quoteDate, generatedAt: committed.generatedAt });
  assert.deepEqual(committed, JSON.parse(JSON.stringify(doc)));
});

test("EU variant rule: the regional (non-US, smallest shipsTo) variant wins over global and US-only", () => {
  const eu = Array.from({ length: 30 }, (_, i) => (i === 0 ? "SE" : `E${i}`));
  const glob = ["SE", "US", ...Array.from({ length: 200 }, (_, i) => `G${i}`)];
  const area = (w, h) => ({ front: { horizontalResolution: w, verticalResolution: h } });
  const vs = [
    { shipsTo: glob, printAreaSizes: area(4677, 5881) },
    { shipsTo: eu, printAreaSizes: area(2480, 3507) },
    { shipsTo: ["US"], printAreaSizes: area(2490, 3510) },
  ];
  const f = modelFrame(variantsFor({ variants: vs }), "front");
  assert.equal(f.rule, "eu");
  assert.deepEqual(f.px, { w: 2480, h: 3507 });
  assert.deepEqual(f.mm, { w: 210, h: 297, offsetTopMm: 0 });
  // EU larger than global would still win (not "smallest")
  const big = [{ shipsTo: glob, printAreaSizes: area(1000, 1000) }, { shipsTo: eu, printAreaSizes: area(2480, 3507) }];
  assert.deepEqual(modelFrame(big, "front").px, { w: 2480, h: 3507 });
  // no regional variant: smallest-fallback
  const g = modelFrame([vs[0], { shipsTo: glob, printAreaSizes: area(3000, 4000) }], "front");
  assert.equal(g.rule, "smallest-fallback");
  assert.deepEqual(g.px, { w: 3000, h: 4000 });
  assert.equal(euVariants([vs[0]]).rule, "smallest-fallback");
});
