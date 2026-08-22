"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processPodArtwork = exports.PIPELINE_VERSION = void 0;
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
const https_1 = require("firebase-functions/v2/https");
const storage_1 = require("firebase-admin/storage");
const firestore_1 = require("firebase-admin/firestore");
const crypto_1 = require("crypto");
const database_1 = require("../config/database");
const app_urls_1 = require("../config/app-urls");
const authGuard_1 = require("../email-orchestrator/functions/authGuard");
const shopFeatures_1 = require("../config/shopFeatures");
const artworkPipelineCore_1 = require("./artworkPipelineCore");
Object.defineProperty(exports, "PIPELINE_VERSION", { enumerable: true, get: function () { return artworkPipelineCore_1.PIPELINE_VERSION; } });
async function loadProfile(profileId) {
    const snap = await database_1.db.collection('settings').doc('podProfiles').get();
    const profiles = (snap.exists && snap.data()?.profiles) || [];
    const p = profiles.find((x) => x.id === profileId);
    if (!p)
        throw new https_1.HttpsError('failed-precondition', `Tryckprofilen "${profileId}" finns inte.`);
    return p;
}
const tokenUrl = (bucketName, path, token) => `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
/**
 * The Storage-bound wrapper around the pure core. Returns either a rejection
 * ({ ok:false, reasons }) or the full set of artwork-doc fields ({ ok:true,
 * fields, notices }) — the exact shape the client has always persisted.
 */
async function runPipeline(shopId, originalStoragePath, profile) {
    const bucket = (0, storage_1.getStorage)().bucket();
    const file = bucket.file(originalStoragePath);
    const [exists] = await file.exists();
    if (!exists)
        throw new https_1.HttpsError('not-found', 'Originalfilen hittades inte i lagringen.');
    const [buf] = await file.download();
    const result = await (0, artworkPipelineCore_1.runArtworkPipeline)(buf, profile);
    if (!result.ok)
        return { ok: false, reasons: result.reasons };
    const { printPng, previewWebp, notices, meta } = result;
    // ---- write print PNG + preview WebP ----
    const id = (0, crypto_1.randomUUID)();
    const printStoragePath = `pod-artwork/${shopId}/print/${id}.png`;
    const previewStoragePath = `pod-artwork/${shopId}/previews/${id}.webp`;
    const printToken = (0, crypto_1.randomUUID)();
    const previewToken = (0, crypto_1.randomUUID)();
    await bucket.file(printStoragePath).save(printPng, {
        metadata: { contentType: 'image/png', metadata: { firebaseStorageDownloadTokens: printToken } },
    });
    await bucket.file(previewStoragePath).save(previewWebp, {
        metadata: { contentType: 'image/webp', metadata: { firebaseStorageDownloadTokens: previewToken } },
    });
    return {
        ok: true,
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
                tier: 'PASS',
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
const OPTS = { region: 'us-central1', memory: '2GiB', timeoutSeconds: 300, cors: app_urls_1.appUrls.CORS_ORIGINS };
exports.processPodArtwork = (0, https_1.onCall)(OPTS, async (request) => {
    const shopId = String(request.data?.shopId || '').trim();
    await (0, authGuard_1.requireAdminOfShop)(shopId, request.auth?.uid);
    // D6/Slice C: pod-disabled shops get no artwork pipeline — same predicate as
    // everywhere else (isShopFeatureEnabled), default-ON until D3 flips polarity.
    if (!(await (0, shopFeatures_1.isShopFeatureEnabled)(shopId, 'pod'))) {
        throw new https_1.HttpsError('failed-precondition', 'Print on demand is not enabled for this shop.');
    }
    const artworkId = String(request.data?.artworkId || '').trim();
    // ---- REPROCESS mode: revalidate an existing doc's original ----
    if (artworkId) {
        const ref = database_1.db.collection('podArtwork').doc(artworkId);
        const snap = await ref.get();
        const art = snap.exists ? snap.data() : null;
        if (!art || art.shopId !== shopId)
            throw new https_1.HttpsError('not-found', 'Originalet hittades inte.');
        // originalStoragePath is a CLIENT-WRITABLE doc field — without this prefix
        // guard a hand-edited doc could make the Admin SDK read ANY bucket object
        // (cross-tenant exfiltration). Same guard as the NEW-UPLOAD mode.
        const originalPath = String(art.originalStoragePath || '');
        if (!originalPath.startsWith(`pod-artwork/${shopId}/originals/`)) {
            throw new https_1.HttpsError('failed-precondition', 'Ogiltig sökväg för originalfilen.');
        }
        const profile = await loadProfile(String(art.purpose || ''));
        const result = await runPipeline(shopId, originalPath, profile);
        if (result.ok) {
            await ref.update({ ...result.fields, updatedAt: firestore_1.FieldValue.serverTimestamp() });
            // Best-effort: drop the OLD preview. The old print PNG is deliberately KEPT —
            // an open printer queue may hold a live signed URL to it; orphans are only
            // storage cost and can be swept by a lifecycle rule.
            const oldPreview = art.previewStoragePath;
            if (oldPreview && oldPreview !== result.fields.previewStoragePath) {
                try {
                    await (0, storage_1.getStorage)().bucket().file(String(oldPreview)).delete();
                }
                catch { /* non-fatal */ }
            }
        }
        else {
            await ref.update({
                status: 'rejected',
                'validation.gate': 'FAIL',
                'validation.tier': 'FAIL',
                'validation.reasons': result.reasons,
                'validation.checkedAt': new Date().toISOString(),
                'validation.pipelineVersion': artworkPipelineCore_1.PIPELINE_VERSION,
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
        }
        return result;
    }
    // ---- NEW UPLOAD mode ----
    const originalStoragePath = String(request.data?.originalStoragePath || '').trim();
    const profileId = String(request.data?.profileId || '').trim();
    if (!originalStoragePath.startsWith(`pod-artwork/${shopId}/originals/`)) {
        throw new https_1.HttpsError('invalid-argument', 'Ogiltig sökväg för originalfilen.');
    }
    const profile = await loadProfile(profileId);
    const result = await runPipeline(shopId, originalStoragePath, profile);
    if (!result.ok) {
        // No orphans: a rejected upload's original is removed (spec: failed files
        // never enter the library). Best-effort — a leftover blob is only cost.
        try {
            await (0, storage_1.getStorage)().bucket().file(originalStoragePath).delete();
        }
        catch { /* non-fatal */ }
    }
    return result;
});
//# sourceMappingURL=processArtwork.js.map