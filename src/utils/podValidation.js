// podValidation.js — the POD artwork GATE engine. Pure functions, no I/O.
//
// SSOT for the rules: docs/POD_PRINT_SPEC.md (print shop's real specs, locked
// 2026-07-27). The gate is BLOCKING: artwork that fails does not enter the
// library. One rule, zero user choices: the motif must hold ≥ profile.min_dpi
// (300) at the LARGEST size it can physically print — its contain-fit inside the
// profile's print area (largest surface = rygg 300×400 mm for apparel), aspect
// preserved. Wide/tall motifs therefore need fewer pixels on the short side —
// COVER math (old effectiveDpiFor semantics) must NOT be used for the gate, it
// would wrongly fail wide logos.
//
// The client runs this for instant feedback; the SERVER verdict is authoritative
// (functions/src/pod/processArtwork.ts mirrors this math — keep the two in sync).

const MM_PER_INCH = 25.4;

// Hard ceiling on source pixels (protects the sharp pipeline; spec §8).
export const MAX_SOURCE_PX = 10000;

/**
 * Effective DPI achieved by widthPx×heightPx printed onto EXACTLY a w×h mm area
 * (cover semantics: the limiting axis). Used by the Design Studio compositor
 * against the seller's chosen placement size — where the artwork IS printed at
 * that size, so cover math is correct. NOT for the upload gate (see containDpiFor).
 * ROUND (not floor): a file at exactly the required pixels computes to e.g.
 * 299.97 DPI, which must read as 300, not a spurious 299.
 */
export const effectiveDpiFor = (widthPx, heightPx, areaMm) => {
  const dpiW = widthPx / (areaMm.w / MM_PER_INCH);
  const dpiH = heightPx / (areaMm.h / MM_PER_INCH);
  return Math.round(Math.min(dpiW, dpiH));
};

/**
 * The largest physical size (mm) this artwork can print inside `areaMm`:
 * contain-fit, aspect preserved. A 5:1 wordmark in 300×400 → 300×60 mm.
 */
export const maxPrintMmFor = (widthPx, heightPx, areaMm) => {
  const aspect = widthPx / heightPx;
  const w = Math.min(areaMm.w, areaMm.h * aspect);
  return { w, h: w / aspect };
};

/** DPI at that largest printable size (the gate's measure). */
export const containDpiFor = (widthPx, heightPx, areaMm) => {
  const { w } = maxPrintMmFor(widthPx, heightPx, areaMm);
  return Math.round(widthPx / (w / MM_PER_INCH));
};

/** Pixels required for THIS artwork's aspect ratio to pass at `dpi`. */
export const requiredPxFor = (widthPx, heightPx, areaMm, dpi) => {
  const { w, h } = maxPrintMmFor(widthPx, heightPx, areaMm);
  return { w: Math.round((w / MM_PER_INCH) * dpi), h: Math.round((h / MM_PER_INCH) * dpi) };
};

// mm → "30 × 6 cm" (Swedish comma, 1 decimal only when needed).
export const formatMmAsCm = (mm) => {
  const cm = mm / 10;
  const r = Math.round(cm * 10) / 10;
  return Number.isInteger(r) ? String(r) : String(r).replace('.', ',');
};

const norm = (s) => String(s || '').trim().toLowerCase();
const ALIAS = { jpeg: 'jpg', tif: 'tiff', heif: 'heic' };
export const normalizeExt = (ext) => { const e = norm(ext); return ALIAS[e] || e; };

// Formats that get a DEDICATED rejection message regardless of profile —
// the generic "not accepted" would leave these users stranded (spec §8).
const SPECIAL_FORMAT_FAIL = {
  heic:
    'iPhone-bild (HEIC) stöds inte. Välj "Mest kompatibel" under Inställningar → Kamera → Format, ' +
    'eller exportera bilden som JPG/PNG och ladda upp igen.',
  pdf:
    'PDF stöds inte för tryck på textil. Exportera motivet som PNG i full storlek från ditt designprogram.',
  svg:
    'SVG stöds inte ännu. Exportera motivet som PNG i full storlek (behåll transparent bakgrund).',
  gif:
    'GIF är ett webbformat, inte ett tryckformat. Exportera motivet som PNG.',
};

const formatEntry = (profile, ext) =>
  (profile.accepted_formats || []).find((f) => normalizeExt(f.ext) === normalizeExt(ext)) || null;

/**
 * gateArtwork(measured, profile) → { ok, effectiveDpi, maxPrintMm, requiredPx, reasons }
 *
 * BLOCKING verdict. `reasons` are plain-Swedish, actionable rejection messages
 * ({ code, message }); ok === false ⇒ the file must not be saved.
 *
 * measured:
 *   widthPx, heightPx   pixel dims. null ⇒ the caller couldn't decode (e.g. TIFF
 *                       in the browser): px checks are SKIPPED here and the
 *                       server (which always decodes) is the authority.
 *   ext                 file extension
 *   fileSizeBytes       number
 *
 * Advisory notices (transparency, CMYK, trim) are NOT the gate's job — they
 * never block and are assembled by the caller/server (spec §4, §8).
 */
export const gateArtwork = (measured, profile) => {
  const reasons = [];
  const add = (code, message) => reasons.push({ code, message });

  if (!profile) {
    return { ok: false, effectiveDpi: null, maxPrintMm: null, requiredPx: null, reasons: [{ code: 'no_profile', message: 'Ingen tryckprofil vald.' }] };
  }

  const { widthPx, heightPx, ext, fileSizeBytes } = measured || {};
  const e = normalizeExt(ext);
  const dimsKnown = widthPx != null && heightPx != null && widthPx > 0 && heightPx > 0;

  // ---- format (by EXTENSION — only trustworthy when the browser could NOT
  // decode the file). The server identifies by CONTENT, so a decodable file
  // with a wrong/odd extension (PNG named .bmp, HEIC named .png in Safari)
  // must pass through to the server's verdict, not die on a filename check. ----
  if (!dimsKnown) {
    if (SPECIAL_FORMAT_FAIL[e]) {
      add(`format_${e}`, SPECIAL_FORMAT_FAIL[e]);
    } else if (!formatEntry(profile, e)) {
      const allowed = (profile.accepted_formats || []).map((f) => f.ext.toUpperCase()).join(', ');
      add('format_not_accepted', `Formatet .${e || '?'} stöds inte. Tillåtna format: ${allowed || '—'}.`);
    }
  }

  // ---- file size ----
  const maxBytes = (profile.max_file_mb || 0) * 1024 * 1024;
  if (maxBytes && typeof fileSizeBytes === 'number' && fileSizeBytes > maxBytes) {
    add('file_too_large', `Filen är ${(fileSizeBytes / 1024 / 1024).toFixed(1)} MB — max ${profile.max_file_mb} MB.`);
  }

  // ---- pixel checks (only when dims are known; server always knows) ----
  let effectiveDpi = null;
  let maxPrintMm = null;
  let requiredPx = null;
  if (dimsKnown) {
    const area = profile.print_area_mm;
    maxPrintMm = maxPrintMmFor(widthPx, heightPx, area);
    requiredPx = requiredPxFor(widthPx, heightPx, area, profile.min_dpi);
    effectiveDpi = containDpiFor(widthPx, heightPx, area);

    if (Math.max(widthPx, heightPx) > MAX_SOURCE_PX) {
      add('px_too_large',
        `Bilden är ${widthPx} × ${heightPx} px — max ${MAX_SOURCE_PX} px på längsta sidan. Skala ner filen.`);
    } else if (effectiveDpi < profile.min_dpi) {
      add('resolution_too_low',
        `Din bild är ${widthPx} × ${heightPx} px. I sin största tryckstorlek ` +
        `${formatMmAsCm(maxPrintMm.w)} × ${formatMmAsCm(maxPrintMm.h)} cm blir det ${effectiveDpi} DPI — ` +
        `minimikravet är ${profile.min_dpi} DPI. För din bilds proportioner krävs minst ` +
        `${requiredPx.w} × ${requiredPx.h} px. Exportera om från originalet i full storlek — ` +
        `uppskalning i efterhand hjälper inte, det skapar bara suddiga pixlar.`);
    }
  }

  return { ok: reasons.length === 0, effectiveDpi, maxPrintMm, requiredPx, reasons };
};

export default gateArtwork;
