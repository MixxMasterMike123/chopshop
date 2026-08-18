// processArtwork.ts — the SERVER-AUTHORITATIVE POD artwork pipeline (sharp).
//
// SSOT for the rules: docs/POD_PRINT_SPEC.md (print shop specs, locked 2026-07-27).
// The printer requires: transparent PNG, RGB, ≥300 DPI. This callable is the only
// path into the artwork library's READY state:
//
//   decode (by CONTENT, not extension) → EXIF-rotate → auto-trim transparent
//   margins → ICC/CMYK → sRGB (8-bit) → GATE (contain-fit ≥ min_dpi) → write
//   print PNG + 800px preview WebP → return verdict + notices.
//
// The client's gateArtwork (src/utils/podValidation.js) is fast-feedback ONLY —
// this verdict is the one that admits a file. KEEP THE GATE MATH IN SYNC with
// podValidation.js (contain semantics, ROUND at the boundary).
//
// Delivery teeth (three layers, because podArtwork doc fields are client-
// writable): (1) storage.rules denies client create/update under
// pod-artwork/{shopId}/print/** — only this callable writes print PNGs;
// (2) printProjection only honours printStoragePath inside the order's own
// shop's print/ folder; (3) both modes here prefix-validate originalStoragePath
// before touching Storage with Admin SDK credentials.
//
// Two modes:
//   NEW UPLOAD  { shopId, originalStoragePath, profileId }
//     → processes the just-uploaded original; on REJECT deletes it (no orphans).
//       Returns the fields the client persists on the new podArtwork doc.
//   REPROCESS   { shopId, artworkId }
//     → re-runs the pipeline on an EXISTING doc's original (legacy revalidation
//       after the 2026-07-27 spec tightening; original is kept on reject) and
//       UPDATES the doc server-side (status ready/rejected).
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getStorage } from 'firebase-admin/storage';
import { FieldValue } from 'firebase-admin/firestore';
import { randomUUID } from 'crypto';
import sharp, { type Metadata } from 'sharp';
import { db } from '../config/database';
import { appUrls } from '../config/app-urls';
import { requireAdminOfShop } from '../email-orchestrator/functions/authGuard';
import { isShopFeatureEnabled } from '../config/shopFeatures';

export const PIPELINE_VERSION = 1;

// libvips' operation cache holds decoded pixels across WARM invocations — with
// ~200MB raw per 7000px image that intermittently OOMed the instance (observed
// live 2026-07-27: "Memory limit of 1024 MiB exceeded"). Trade cache hits (none
// here — every call is a new image) for a flat memory profile.
sharp.cache(false);
sharp.concurrency(1);

const MM_PER_INCH = 25.4;
// Hard ceiling on source pixels (spec §8) — protects this function's memory.
const MAX_SOURCE_PX = 10000;
const PREVIEW_MAX_EDGE = 800;
// Alpha thresholds: <250 counts as "not fully opaque" (parity with the legacy
// client probe); trim threshold ~5% alpha; semi-band = 5%..95%.
const OPAQUE_RATIO = 0.005;
const TRIM_THRESHOLD = 13; // 0..255 ≈ 5% alpha
const SEMI_LO = 13;
const SEMI_HI = 242;
const SEMI_NOTICE_RATIO = 0.05;

interface ProfileDoc {
  id: string;
  label: string;
  accepted_formats?: Array<{ ext: string; preferred?: boolean }>;
  print_area_mm: { w: number; h: number };
  min_dpi: number;
  max_file_mb?: number;
}

// ---- gate math (MIRRORS src/utils/podValidation.js — keep in sync) ----------
const maxPrintMmFor = (widthPx: number, heightPx: number, area: { w: number; h: number }) => {
  const aspect = widthPx / heightPx;
  const w = Math.min(area.w, area.h * aspect);
  return { w, h: w / aspect };
};
const containDpiFor = (widthPx: number, heightPx: number, area: { w: number; h: number }) => {
  const { w } = maxPrintMmFor(widthPx, heightPx, area);
  return Math.round(widthPx / (w / MM_PER_INCH));
};
const requiredPxFor = (widthPx: number, heightPx: number, area: { w: number; h: number }, dpi: number) => {
  const { w, h } = maxPrintMmFor(widthPx, heightPx, area);
  return { w: Math.round((w / MM_PER_INCH) * dpi), h: Math.round((h / MM_PER_INCH) * dpi) };
};
const formatMmAsCm = (mm: number) => {
  const r = Math.round(mm) / 10;
  const s = Math.round(r * 10) / 10;
  return Number.isInteger(s) ? String(s) : String(s).replace('.', ',');
};

interface Reason { code: string; message: string }
interface Notice { code: string; message: string }

// Dedicated rejections for formats users realistically try (spec §8).
const SPECIAL_FORMAT_FAIL: Record<string, string> = {
  heif: 'iPhone-bild (HEIC) stöds inte. Välj "Mest kompatibel" under Inställningar → Kamera → Format, eller exportera bilden som JPG/PNG och ladda upp igen.',
  pdf: 'PDF stöds inte för tryck på textil. Exportera motivet som PNG i full storlek från ditt designprogram.',
  svg: 'SVG stöds inte ännu. Exportera motivet som PNG i full storlek (behåll transparent bakgrund).',
  gif: 'GIF är ett webbformat, inte ett tryckformat. Exportera motivet som PNG.',
};
// sharp metadata().format → our profile format vocabulary.
const FORMAT_TO_EXT: Record<string, string> = { jpeg: 'jpg', png: 'png', tiff: 'tiff', webp: 'webp' };

// HEIC often fails to DECODE (no codec) rather than identify — sniff the magic
// bytes so iPhone users get the dedicated message, not "korrupt fil".
const looksLikeHeic = (buf: Buffer) =>
  buf.length > 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp' &&
  /^(heic|heix|heif|hevc|mif1|msf1)/.test(buf.subarray(8, 12).toString('ascii'));

async function loadProfile(profileId: string): Promise<ProfileDoc> {
  const snap = await db.collection('settings').doc('podProfiles').get();
  const profiles: ProfileDoc[] = (snap.exists && (snap.data()?.profiles as ProfileDoc[])) || [];
  const p = profiles.find((x) => x.id === profileId);
  if (!p) throw new HttpsError('failed-precondition', `Tryckprofilen "${profileId}" finns inte.`);
  return p;
}

const tokenUrl = (bucketName: string, path: string, token: string) =>
  `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;

/**
 * The pipeline core. Returns either a rejection ({ ok:false, reasons }) or the
 * full set of artwork-doc fields ({ ok:true, fields, notices }).
 */
async function runPipeline(shopId: string, originalStoragePath: string, profile: ProfileDoc) {
  const bucket = getStorage().bucket();
  const file = bucket.file(originalStoragePath);

  const [exists] = await file.exists();
  if (!exists) throw new HttpsError('not-found', 'Originalfilen hittades inte i lagringen.');

  const [buf] = await file.download();
  const reasons: Reason[] = [];
  const notices: Notice[] = [];

  // ---- size gate ----
  const maxBytes = (profile.max_file_mb || 0) * 1024 * 1024;
  if (maxBytes && buf.length > maxBytes) {
    reasons.push({ code: 'file_too_large', message: `Filen är ${(buf.length / 1024 / 1024).toFixed(1)} MB — max ${profile.max_file_mb} MB.` });
    return { ok: false as const, reasons };
  }

  // ---- identify by CONTENT (wrong extensions are normalized away here) ----
  // metadata() only reads headers, so NO pixel limit here — an oversized image
  // must reach the px_too_large branch below (actionable "Skala ner" message),
  // not die in this try as "korrupt fil". Decode ops keep the limit as backstop.
  let meta: Metadata;
  try {
    meta = await sharp(buf, { limitInputPixels: false }).metadata();
  } catch (e: any) {
    if (looksLikeHeic(buf)) return { ok: false as const, reasons: [{ code: 'format_heic', message: SPECIAL_FORMAT_FAIL.heif }] };
    return { ok: false as const, reasons: [{ code: 'unreadable', message: 'Filen kunde inte läsas — den kan vara skadad. Ladda ner originalet igen och försök på nytt.' }] };
  }

  const fmt = meta.format || '';
  if (SPECIAL_FORMAT_FAIL[fmt]) {
    return { ok: false as const, reasons: [{ code: `format_${fmt}`, message: SPECIAL_FORMAT_FAIL[fmt] }] };
  }
  const ext = FORMAT_TO_EXT[fmt];
  const accepted = (profile.accepted_formats || []).map((f) => String(f.ext).toLowerCase());
  if (!ext || !accepted.includes(ext)) {
    const allowed = accepted.map((a) => a.toUpperCase()).join(', ');
    return { ok: false as const, reasons: [{ code: 'format_not_accepted', message: `Formatet ${fmt ? '.' + fmt : ''} stöds inte. Tillåtna format: ${allowed}.` }] };
  }

  if (!meta.width || !meta.height) {
    return { ok: false as const, reasons: [{ code: 'unreadable', message: 'Kunde inte läsa bildens mått — filen kan vara skadad.' }] };
  }
  // EXIF orientation 5-8 swaps the axes; measure in DISPLAY orientation.
  const swapped = (meta.orientation || 1) >= 5;
  const srcW = swapped ? meta.height : meta.width;
  const srcH = swapped ? meta.width : meta.height;
  if (Math.max(srcW, srcH) > MAX_SOURCE_PX) {
    return { ok: false as const, reasons: [{ code: 'px_too_large', message: `Bilden är ${srcW} × ${srcH} px — max ${MAX_SOURCE_PX} px på längsta sidan. Skala ner filen.` }] };
  }

  // ---- normalize: rotate → trim transparent margins → sRGB 8-bit PNG ----
  // toColourspace('srgb') converts CMYK/wide-gamut (via embedded ICC when present)
  // to 8-bit sRGB — spec §8 "Färg". Alpha survives PNG re-encode untouched.
  let work = sharp(buf, { limitInputPixels: (MAX_SOURCE_PX + 2000) * (MAX_SOURCE_PX + 2000) }).rotate();

  const hadCmyk = meta.space === 'cmyk';
  if (hadCmyk) {
    notices.push({ code: 'cmyk_converted', message: 'Filen var i CMYK och har konverterats till RGB — färgerna kan skifta något. Kontrollera mockupen.' });
  }

  // ONE decode+encode pass produces the final PNG (rotate → [trim] → sRGB).
  // No intermediate full-size buffers: a 7000px image is ~200MB raw, and an
  // extra encode pass was part of the observed 1GiB OOM.
  let trimApplied = false;
  let png: Buffer;
  if (meta.hasAlpha) {
    // Auto-trim transparent padding so the GATE measures the MOTIF, not the
    // artboard (spec §8 — without this the gate + cm readouts lie). Trim keys on
    // fully-transparent background; threshold tolerates stray near-zero alpha.
    try {
      png = await work
        .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: TRIM_THRESHOLD })
        .toColourspace('srgb')
        .png()
        .toBuffer();
      trimApplied = true;
    } catch {
      // Trim failure: proceed untrimmed (never block on the optimizer). A fully
      // transparent image passes trim UNCHANGED (probed empirically) — that case
      // is caught below via alpha stats, not here.
      png = await sharp(buf, { limitInputPixels: (MAX_SOURCE_PX + 2000) * (MAX_SOURCE_PX + 2000) })
        .rotate()
        .toColourspace('srgb')
        .png()
        .toBuffer();
    }
  } else {
    png = await work.toColourspace('srgb').png().toBuffer();
  }
  const outMeta = await sharp(png).metadata();
  const width = outMeta.width || 0;
  const height = outMeta.height || 0;
  if (!width || !height) {
    return { ok: false as const, reasons: [{ code: 'unreadable', message: 'Bearbetningen gav en tom bild — filen kan vara skadad.' }] };
  }
  if (trimApplied && (width !== srcW || height !== srcH)) {
    notices.push({
      code: 'trimmed',
      message: `Genomskinliga marginaler beskars automatiskt (${srcW} × ${srcH} → ${width} × ${height} px) så att måtten gäller själva motivet.`,
    });
  }

  // ---- THE GATE: contain-fit ≥ min_dpi on the processed (trimmed) motif ----
  const area = profile.print_area_mm;
  const maxPrintMm = maxPrintMmFor(width, height, area);
  const effectiveDpi = containDpiFor(width, height, area);
  const requiredPx = requiredPxFor(width, height, area, profile.min_dpi);
  if (effectiveDpi < profile.min_dpi) {
    reasons.push({
      code: 'resolution_too_low',
      message:
        `Motivet är ${width} × ${height} px. I sin största tryckstorlek ` +
        `${formatMmAsCm(maxPrintMm.w)} × ${formatMmAsCm(maxPrintMm.h)} cm blir det ${effectiveDpi} DPI — ` +
        `minimikravet är ${profile.min_dpi} DPI. För din bilds proportioner krävs minst ${requiredPx.w} × ${requiredPx.h} px. ` +
        `Exportera om från originalet i full storlek — uppskalning i efterhand hjälper inte.`,
    });
    return { ok: false as const, reasons };
  }

  // ---- transparency: fully-empty reject + notices (spec §4, §8) ----
  const alphaStats = await alphaProfile(png);
  if (alphaStats.visibleRatio === 0 && alphaStats.hasAlphaChannel) {
    // Nothing above the visibility threshold anywhere — there is no motif.
    return { ok: false as const, reasons: [{ code: 'fully_transparent', message: 'Bilden är helt genomskinlig — det finns inget motiv att trycka.' }] };
  }
  if (!alphaStats.hasTransparency) {
    notices.push({
      code: 'opaque',
      message: 'Bilden saknar transparent bakgrund — hela rektangeln trycks, inklusive ev. vit bakgrund. Är motivet en logga? Exportera som PNG med transparens.',
    });
  } else if (alphaStats.semiRatio > SEMI_NOTICE_RATIO) {
    notices.push({
      code: 'semi_transparent',
      message: 'Motivet innehåller halvgenomskinliga partier (t.ex. skuggor) — de kan se annorlunda ut i tryck på mörka plagg.',
    });
  }

  // ---- write print PNG + preview WebP ----
  const id = randomUUID();
  const printStoragePath = `pod-artwork/${shopId}/print/${id}.png`;
  const previewStoragePath = `pod-artwork/${shopId}/previews/${id}.webp`;
  const printToken = randomUUID();
  const previewToken = randomUUID();

  const preview = await sharp(png)
    .resize({ width: PREVIEW_MAX_EDGE, height: PREVIEW_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 70 })
    .toBuffer();

  await bucket.file(printStoragePath).save(png, {
    metadata: { contentType: 'image/png', metadata: { firebaseStorageDownloadTokens: printToken } },
  });
  await bucket.file(previewStoragePath).save(preview, {
    metadata: { contentType: 'image/webp', metadata: { firebaseStorageDownloadTokens: previewToken } },
  });

  return {
    ok: true as const,
    notices,
    fields: {
      status: 'ready',
      printUrl: tokenUrl(bucket.name, printStoragePath, printToken),
      printStoragePath,
      previewUrl: tokenUrl(bucket.name, previewStoragePath, previewToken),
      previewStoragePath,
      sourceWidthPx: width,
      sourceHeightPx: height,
      validation: {
        gate: 'PASS',
        tier: 'PASS', // legacy readers (StatusPill) key off tier
        effectiveDpi,
        maxPrintMm: { w: Math.round(maxPrintMm.w), h: Math.round(maxPrintMm.h) },
        notices,
        reasons: [],
        checkedAt: new Date().toISOString(),
        profileId: profile.id,
        pipelineVersion: PIPELINE_VERSION,
      },
    },
  };
}

// Alpha profile of the FINAL png, sampled on a ≤512px derivative:
//   hasAlphaChannel — the png has an alpha channel at all
//   hasTransparency — any meaningful share of pixels below 250 (opaque-notice key)
//   semiRatio       — fraction in the 5–95% band (soft shadows/glows)
//   visibleRatio    — fraction ABOVE the visibility threshold; 0 ⇒ no motif at all
async function alphaProfile(png: Buffer) {
  const meta = await sharp(png).metadata();
  if (!meta.hasAlpha) return { hasAlphaChannel: false, hasTransparency: false, semiRatio: 0, visibleRatio: 1 };
  const { data, info } = await sharp(png)
    .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const total = info.width * info.height;
  let below250 = 0;
  let semi = 0;
  let visible = 0;
  for (let i = 0; i < data.length; i++) {
    const a = data[i];
    if (a < 250) below250++;
    if (a >= SEMI_LO && a <= SEMI_HI) semi++;
    if (a >= TRIM_THRESHOLD) visible++;
  }
  return {
    hasAlphaChannel: true,
    hasTransparency: total > 0 && below250 / total >= OPAQUE_RATIO,
    semiRatio: total > 0 ? semi / total : 0,
    visibleRatio: total > 0 ? visible / total : 0,
  };
}

// 2GiB: a 10000px-side image decodes to ~400MB of raw pixels, and the pipeline
// legitimately holds input + decoded + output at its peak. 1GiB OOMed in prod
// on 7087px files (2026-07-27) even before the double-encode was removed.
const OPTS = { region: 'us-central1', memory: '2GiB', timeoutSeconds: 300, cors: appUrls.CORS_ORIGINS } as const;

export const processPodArtwork = onCall(OPTS, async (request) => {
  const shopId = String(request.data?.shopId || '').trim();
  await requireAdminOfShop(shopId, request.auth?.uid);

  // D6/Slice C: pod-disabled shops get no artwork pipeline — same predicate as
  // everywhere else (isShopFeatureEnabled), default-ON until D3 flips polarity.
  if (!(await isShopFeatureEnabled(shopId, 'pod'))) {
    throw new HttpsError('failed-precondition', 'Print on demand is not enabled for this shop.');
  }

  const artworkId = String(request.data?.artworkId || '').trim();

  // ---- REPROCESS mode: revalidate an existing doc's original ----
  if (artworkId) {
    const ref = db.collection('podArtwork').doc(artworkId);
    const snap = await ref.get();
    const art = snap.exists ? snap.data() : null;
    if (!art || art.shopId !== shopId) throw new HttpsError('not-found', 'Originalet hittades inte.');
    // originalStoragePath is a CLIENT-WRITABLE doc field — without this prefix
    // guard a hand-edited doc could make the Admin SDK read ANY bucket object
    // (cross-tenant exfiltration). Same guard as the NEW-UPLOAD mode.
    const originalPath = String(art.originalStoragePath || '');
    if (!originalPath.startsWith(`pod-artwork/${shopId}/originals/`)) {
      throw new HttpsError('failed-precondition', 'Ogiltig sökväg för originalfilen.');
    }
    const profile = await loadProfile(String(art.purpose || ''));

    const result = await runPipeline(shopId, originalPath, profile);
    if (result.ok) {
      await ref.update({ ...result.fields, updatedAt: FieldValue.serverTimestamp() });
      // Best-effort: drop the OLD preview. The old print PNG is deliberately KEPT —
      // an open printer queue may hold a live signed URL to it; orphans are only
      // storage cost and can be swept by a lifecycle rule.
      const oldPreview = art.previewStoragePath;
      if (oldPreview && oldPreview !== result.fields.previewStoragePath) {
        try { await getStorage().bucket().file(String(oldPreview)).delete(); } catch { /* non-fatal */ }
      }
    } else {
      await ref.update({
        status: 'rejected',
        'validation.gate': 'FAIL',
        'validation.tier': 'FAIL',
        'validation.reasons': result.reasons,
        'validation.checkedAt': new Date().toISOString(),
        'validation.pipelineVersion': PIPELINE_VERSION,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    return result;
  }

  // ---- NEW UPLOAD mode ----
  const originalStoragePath = String(request.data?.originalStoragePath || '').trim();
  const profileId = String(request.data?.profileId || '').trim();
  if (!originalStoragePath.startsWith(`pod-artwork/${shopId}/originals/`)) {
    throw new HttpsError('invalid-argument', 'Ogiltig sökväg för originalfilen.');
  }
  const profile = await loadProfile(profileId);

  const result = await runPipeline(shopId, originalStoragePath, profile);
  if (!result.ok) {
    // No orphans: a rejected upload's original is removed (spec: failed files
    // never enter the library). Best-effort — a leftover blob is only cost.
    try { await getStorage().bucket().file(originalStoragePath).delete(); } catch { /* non-fatal */ }
  }
  return result;
});
