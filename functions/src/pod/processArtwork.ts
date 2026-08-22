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
// ⚠️ 2026-08-22 (checkpoint 26): the COMPUTE half of that pipeline now lives in
// ./artworkPipelineCore.ts and was MOVED there verbatim — same checks, same
// order, same thresholds, same Swedish messages, same notice/reason codes. This
// file is the Firebase WRAPPER: auth guard, feature gate, storage-path prefix
// guards, download, upload, tokenised URLs, Firestore doc-field assembly and
// orphan cleanup. The extraction exists because the render-farm job endpoint
// (src/render-farm/) must run the identical pipeline without any Firebase in
// the path (docs/RENDER_FARM_CONTRACT.md). Nothing the client sees changed.
//
// The client's gateArtwork (src/utils/podValidation.js) is fast-feedback ONLY —
// this verdict is the one that admits a file. KEEP THE GATE MATH IN SYNC with
// podValidation.js (contain semantics, ROUND at the boundary) — the gate math
// now sits in artworkPipelineCore.ts.
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
import { db } from '../config/database';
import { appUrls } from '../config/app-urls';
import { requireAdminOfShop } from '../email-orchestrator/functions/authGuard';
import { isShopFeatureEnabled } from '../config/shopFeatures';
import { PIPELINE_VERSION, runArtworkPipeline, type PipelineProfile } from './artworkPipelineCore';

// Re-exported so existing importers of PIPELINE_VERSION from this module keep
// working; the constant itself now lives with the pipeline it versions.
export { PIPELINE_VERSION };

// The Firestore profile doc: the pipeline's five fields plus `label`, which is
// display-only and never reaches the core.
interface ProfileDoc extends PipelineProfile {
  label: string;
}

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
 * The Storage-bound wrapper around the pure core. Returns either a rejection
 * ({ ok:false, reasons }) or the full set of artwork-doc fields ({ ok:true,
 * fields, notices }) — the exact shape the client has always persisted.
 */
async function runPipeline(shopId: string, originalStoragePath: string, profile: ProfileDoc) {
  const bucket = getStorage().bucket();
  const file = bucket.file(originalStoragePath);

  const [exists] = await file.exists();
  if (!exists) throw new HttpsError('not-found', 'Originalfilen hittades inte i lagringen.');

  const [buf] = await file.download();

  const result = await runArtworkPipeline(buf, profile);
  if (!result.ok) return { ok: false as const, reasons: result.reasons };

  const { printPng, previewWebp, notices, meta } = result;

  // ---- write print PNG + preview WebP ----
  const id = randomUUID();
  const printStoragePath = `pod-artwork/${shopId}/print/${id}.png`;
  const previewStoragePath = `pod-artwork/${shopId}/previews/${id}.webp`;
  const printToken = randomUUID();
  const previewToken = randomUUID();

  await bucket.file(printStoragePath).save(printPng, {
    metadata: { contentType: 'image/png', metadata: { firebaseStorageDownloadTokens: printToken } },
  });
  await bucket.file(previewStoragePath).save(previewWebp, {
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
      sourceWidthPx: meta.widthPx,
      sourceHeightPx: meta.heightPx,
      validation: {
        gate: 'PASS',
        tier: 'PASS', // legacy readers (StatusPill) key off tier
        effectiveDpi: meta.effectiveDpi,
        maxPrintMm: meta.maxPrintMm,
        notices,
        reasons: [],
        checkedAt: new Date().toISOString(),
        profileId: meta.profileId,
        pipelineVersion: meta.pipelineVersion,
      },
    },
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
