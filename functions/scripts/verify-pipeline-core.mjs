#!/usr/bin/env node
// verify-pipeline-core.mjs — the BEHAVIOR PIN for the extracted artwork pipeline.
//
// There is no test framework in functions/, and the checkpoint-26 extraction moved
// live, money-adjacent, print-shop-contract code between files. This script is the
// substitute: it imports the COMPILED core (lib/pod/artworkPipelineCore.js) from a
// bare node process — which also proves the purity contract, since a module that
// had picked up firebase-admin, Firestore or auth imports would not load here at
// all — synthesizes fixtures with sharp in memory, and asserts the verdicts,
// messages and numbers the spec (docs/POD_PRINT_SPEC.md) and the pre-extraction
// code promise.
//
//   cd functions && npm run build && node scripts/verify-pipeline-core.mjs
//
// Expectations are derived from the SPEC and the gate math, NOT from running the
// code and recording whatever it printed — the numbers below are computed by hand
// in the comments so a wrong extraction fails instead of being blessed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { runArtworkPipeline, PIPELINE_VERSION } from '../lib/pod/artworkPipelineCore.js';

const MM_PER_INCH = 25.4;

// The real front_a3 profile shape (docs/POD_PRINT_SPEC.md: front print area
// 250 × 350 mm, 300 DPI minimum).
const PROFILE = {
  id: 'front_a3',
  min_dpi: 300,
  print_area_mm: { w: 250, h: 350 },
  max_file_mb: 150,
  accepted_formats: [{ ext: 'png' }, { ext: 'jpg' }, { ext: 'tiff' }, { ext: 'webp' }],
};

let passed = 0;
let failed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message.split('\n').join('\n      ')}`);
    failed++;
  }
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * A transparent PNG with an opaque red motif filling a centred fraction of the
 * canvas. `motifFraction: 1` means the motif fills the canvas edge-to-edge, so
 * auto-trim is a no-op and the gate measures exactly w × h.
 */
async function transparentPng(w, h, motifFraction = 1, motifAlpha = 255) {
  const mw = Math.max(1, Math.round(w * motifFraction));
  const mh = Math.max(1, Math.round(h * motifFraction));
  const motif = await sharp({
    create: { width: mw, height: mh, channels: 4, background: { r: 220, g: 30, b: 40, alpha: motifAlpha / 255 } },
  }).png().toBuffer();
  return sharp({
    create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: motif, left: Math.floor((w - mw) / 2), top: Math.floor((h - mh) / 2) }])
    .png()
    .toBuffer();
}

async function opaqueJpeg(w, h) {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 180, b: 60 } } })
    .jpeg({ quality: 90 })
    .toBuffer();
}

// ─── (1) large transparent PNG comfortably over the DPI requirement ──────────
// 3200 × 3200 square. Contain into 250×350: aspect 1 ⇒ w = min(250, 350) = 250 mm.
// effectiveDpi = round(3200 / (250/25.4)) = round(3200 / 9.8425) = 325 ≥ 300 ⇒ PASS.
await check('(1) 3200x3200 transparent PNG passes the gate with correct meta', async () => {
  const src = await transparentPng(3200, 3200, 1);
  const res = await runArtworkPipeline(src, PROFILE);
  assert.equal(res.ok, true, `expected ok:true, got reasons ${JSON.stringify(res.reasons)}`);

  assert.equal(res.meta.widthPx, 3200);
  assert.equal(res.meta.heightPx, 3200);
  const expectedDpi = Math.round(3200 / (250 / MM_PER_INCH)); // 325
  assert.equal(expectedDpi, 325, 'hand-computed DPI sanity');
  assert.equal(res.meta.effectiveDpi, expectedDpi);
  assert.deepEqual(res.meta.maxPrintMm, { w: 250, h: 250 });
  assert.equal(res.meta.profileId, 'front_a3');
  assert.equal(res.meta.pipelineVersion, PIPELINE_VERSION);

  // Alpha must survive the PNG re-encode untouched (spec: printer needs transparency).
  const printMeta = await sharp(res.printPng).metadata();
  assert.equal(printMeta.format, 'png');
  assert.equal(printMeta.hasAlpha, true, 'print PNG lost its alpha channel');
  assert.equal(printMeta.width, 3200);
  assert.equal(printMeta.height, 3200);

  // Preview: WebP, longest edge ≤ 800 (PREVIEW_MAX_EDGE).
  const prevMeta = await sharp(res.previewWebp).metadata();
  assert.equal(prevMeta.format, 'webp');
  assert.ok(Math.max(prevMeta.width, prevMeta.height) <= 800,
    `preview longest edge ${Math.max(prevMeta.width, prevMeta.height)} > 800`);
});

// ─── (2) undersized image → resolution_too_low with the exact required px ────
// 900 × 900 square. w = 250 mm ⇒ effectiveDpi = round(900 / 9.8425) = 91 < 300 ⇒ FAIL.
// requiredPx = round(250/25.4 * 300) = round(2952.75) = 2953 on BOTH axes.
await check('(2) 900x900 rejects with resolution_too_low and the promised numbers', async () => {
  const src = await transparentPng(900, 900, 1);
  const res = await runArtworkPipeline(src, PROFILE);
  assert.equal(res.ok, false, 'expected a rejection');
  assert.equal(res.reasons.length, 1);
  assert.equal(res.reasons[0].code, 'resolution_too_low');

  const expectedDpi = Math.round(900 / (250 / MM_PER_INCH)); // 91
  assert.equal(expectedDpi, 91, 'hand-computed DPI sanity');
  const requiredPx = Math.round((250 / MM_PER_INCH) * 300); // 2953
  assert.equal(requiredPx, 2953, 'hand-computed required-px sanity');

  const msg = res.reasons[0].message;
  assert.ok(msg.includes('Motivet är 900 × 900 px'), `missing dimensions: ${msg}`);
  assert.ok(msg.includes('25 × 25 cm'), `missing cm readout (250mm ⇒ "25"): ${msg}`);
  assert.ok(msg.includes(`blir det ${expectedDpi} DPI`), `missing effective DPI: ${msg}`);
  assert.ok(msg.includes('minimikravet är 300 DPI'), `missing min_dpi: ${msg}`);
  assert.ok(msg.includes(`minst ${requiredPx} × ${requiredPx} px`), `missing required px: ${msg}`);
});

// ─── (3) oversized bytes vs max_file_mb → file_too_large ─────────────────────
// The size gate is the FIRST check, before sharp identifies anything, so a tiny
// max_file_mb rejects a legitimate file on bytes alone.
await check('(3) file over max_file_mb rejects with file_too_large', async () => {
  const src = await transparentPng(3200, 3200, 1);
  const mb = src.length / 1024 / 1024;
  assert.ok(mb > 0.05, 'fixture too small to exercise the byte gate meaningfully');
  const tinyProfile = { ...PROFILE, max_file_mb: 0.01 }; // 10 KiB cap
  const res = await runArtworkPipeline(src, tinyProfile);
  assert.equal(res.ok, false, 'expected a rejection');
  assert.equal(res.reasons.length, 1);
  assert.equal(res.reasons[0].code, 'file_too_large');
  assert.ok(res.reasons[0].message.includes(`${mb.toFixed(1)} MB`),
    `message should report the actual size ${mb.toFixed(1)} MB: ${res.reasons[0].message}`);
  assert.ok(res.reasons[0].message.includes('max 0.01 MB'), res.reasons[0].message);
});

// ─── (4) disallowed format vs accepted_formats → format_not_accepted ─────────
// Identification is by CONTENT: a WebP is rejected by a PNG-only profile even
// though the bytes are a perfectly valid image.
await check('(4) webp against a png-only profile rejects with format_not_accepted', async () => {
  const webp = await sharp({
    create: { width: 3200, height: 3200, channels: 4, background: { r: 10, g: 10, b: 10, alpha: 1 } },
  }).webp().toBuffer();
  const pngOnly = { ...PROFILE, accepted_formats: [{ ext: 'png' }] };
  const res = await runArtworkPipeline(webp, pngOnly);
  assert.equal(res.ok, false, 'expected a rejection');
  assert.equal(res.reasons.length, 1);
  assert.equal(res.reasons[0].code, 'format_not_accepted');
  assert.ok(res.reasons[0].message.includes('Formatet .webp stöds inte'), res.reasons[0].message);
  assert.ok(res.reasons[0].message.includes('Tillåtna format: PNG.'), res.reasons[0].message);
});

// ─── (5) JPEG, no alpha → PASSES with the `opaque` notice (inform-only) ──────
// Spec: transparency is INFORM-ONLY. An opaque file is print-legal; the notice
// is the whole mechanism, so a rejection here would be a spec violation.
await check('(5) opaque JPEG passes and carries the inform-only `opaque` notice', async () => {
  const src = await opaqueJpeg(3200, 3200);
  const res = await runArtworkPipeline(src, PROFILE);
  assert.equal(res.ok, true, `expected ok:true, got ${JSON.stringify(res.reasons)}`);
  const codes = res.notices.map((n) => n.code);
  assert.ok(codes.includes('opaque'), `expected an "opaque" notice, got ${JSON.stringify(codes)}`);
  assert.ok(!codes.includes('trimmed'), 'a no-alpha image must not report a trim');
  const notice = res.notices.find((n) => n.code === 'opaque');
  assert.ok(notice.message.includes('saknar transparent bakgrund'), notice.message);
  // Output is still a PNG (the printer's format), whatever went in.
  assert.equal((await sharp(res.printPng).metadata()).format, 'png');
  assert.equal(res.meta.widthPx, 3200);
  assert.equal(res.meta.heightPx, 3200);
});

// ─── (5b) transparent margins are trimmed and REPORTED ───────────────────────
// The gate must measure the MOTIF, not the artboard. A 4000px canvas holding a
// 3200px motif (0.8) trims to 3200 and notices it. Guards the trim step, which
// is the difference between an honest cm readout and a lying one.
await check('(5b) transparent margins trim to the motif and report it', async () => {
  const src = await transparentPng(4000, 4000, 0.8);
  const res = await runArtworkPipeline(src, PROFILE);
  assert.equal(res.ok, true, `expected ok:true, got ${JSON.stringify(res.reasons)}`);
  assert.equal(res.meta.widthPx, 3200, 'trim should have reduced the canvas to the motif');
  assert.equal(res.meta.heightPx, 3200);
  const trimmed = res.notices.find((n) => n.code === 'trimmed');
  assert.ok(trimmed, `expected a "trimmed" notice, got ${JSON.stringify(res.notices.map((n) => n.code))}`);
  assert.ok(trimmed.message.includes('4000 × 4000 → 3200 × 3200 px'), trimmed.message);
});

// ─── (5c) a fully transparent image has no motif → rejection ────────────────
await check('(5c) fully transparent image rejects with fully_transparent', async () => {
  const src = await sharp({
    create: { width: 3200, height: 3200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).png().toBuffer();
  const res = await runArtworkPipeline(src, PROFILE);
  assert.equal(res.ok, false, 'expected a rejection');
  assert.equal(res.reasons[0].code, 'fully_transparent');
});

// ─── (6) determinism: same input twice → identical output bytes ─────────────
// Contract principle 3 ("pure function — same job in, same bytes out"): replay
// safety is by construction, and the Worker may compare the reported sha256s.
// NOTE the fixture arithmetic: the gate measures the TRIMMED motif, so a 0.9
// motif on a 3200 canvas is 2880 px ⇒ 293 DPI ⇒ correctly REJECTED. The canvas
// is sized so the trimmed motif (3600 × 0.9 = 3240 px ⇒ 329 DPI) still passes.
await check('(6) same input twice produces byte-identical outputs', async () => {
  const src = await transparentPng(3600, 3600, 0.9);
  const a = await runArtworkPipeline(src, PROFILE);
  const b = await runArtworkPipeline(src, PROFILE);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(sha256(a.printPng), sha256(b.printPng), 'print PNG is not deterministic');
  assert.equal(sha256(a.previewWebp), sha256(b.previewWebp), 'preview WebP is not deterministic');
  assert.deepEqual(a.meta, b.meta);
  assert.deepEqual(a.notices, b.notices);
});

console.log('');
console.log(`${failed === 0 ? 'ALL PASS' : 'FAILURES'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
