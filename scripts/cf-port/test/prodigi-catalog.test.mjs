// node --test scripts/cf-port/test/prodigi-catalog.test.mjs  — fixtures only, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODELS, assertKey, areaPx, buildCatalog, buildPricing, colourOfSlug, colourSizes, eurToMinor,
  modelFrame, normSize, pickProbes, pxToMm, quoteJobs, readQuote, skuKey, slug, splitSkuKey, variantsFor,
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

test("modelFrame: smallest SE area, offsetTopMm 0, integer mm", () => {
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
        if (q.items[String(i + 1)]) quotes[skuKey(item.sku, item.attributes.color, item.attributes.size)] = q.items[String(i + 1)];
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
    assert.ok(["tee", "hoodie", "sweatshirt"].includes(m.garment));
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
    assert.equal(parts.size, slug(s.attributes.size));
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
