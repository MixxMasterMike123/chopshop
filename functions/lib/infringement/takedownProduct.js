"use strict";
/**
 * takedownProduct — PLATFORM-only: switch a reported/flagged product off the
 * storefront (SnapWear A10 notice & takedown, also the "Avpublicera" action in
 * the A11 screening queue).
 *
 * One transaction:
 *   products/{productId}      isActive=false + takedown { reportId, at, by, note }
 *                             (+ screening.status='taken_down' when screened, so
 *                             it leaves the Granskning queue)
 *   infringementReports/{id}  status='taken_down', note, handledAt, handledBy
 *                             (only when reportId is given)
 *   auditLogs/{auto}          append-only record, same shape as the existing
 *                             customer-admin entries (shopId-stamped).
 *
 * Hiding needs nothing else: projectPublicProduct drops any product whose
 * isActive !== true, so syncProductsPublicOnWrite deletes the public mirror
 * and the storefront stops listing/selling it.
 *
 * firestore.rules forbid a shop admin from writing `takedown`, and from
 * flipping isActive while `takedown` is set — the seller can't quietly switch
 * it back on. Reinstating is a platform act (set the report to 'rejected' and
 * re-activate in the product form, which clears the stamp for platform users).
 *
 * NOT built: payout hold. Destination charges have no per-item hold primitive;
 * if an order for the product is still inside the payout window the platform
 * can reverse that transfer manually in the Stripe dashboard.
 * TODO(payout-hold): revisit if takedowns become frequent.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.takedownProduct = void 0;
const https_1 = require("firebase-functions/v2/https");
const logger = __importStar(require("firebase-functions/logger"));
const firestore_1 = require("firebase-admin/firestore");
const database_1 = require("../config/database");
const app_urls_1 = require("../config/app-urls");
const authGuard_1 = require("../email-orchestrator/functions/authGuard");
const clip = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
exports.takedownProduct = (0, https_1.onCall)({
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 60,
    cors: app_urls_1.appUrls.CORS_ORIGINS,
}, async (request) => {
    const uid = request.auth?.uid;
    await (0, authGuard_1.requirePlatform)(uid);
    const data = request.data || {};
    const productId = clip(data.productId, 128);
    const reportId = clip(data.reportId, 128) || null;
    const note = clip(data.note, 2000);
    if (!productId || !ID_RE.test(productId)) {
        throw new https_1.HttpsError('invalid-argument', 'productId is required.');
    }
    if (reportId && !ID_RE.test(reportId)) {
        throw new https_1.HttpsError('invalid-argument', 'Invalid reportId.');
    }
    const productRef = database_1.db.collection('products').doc(productId);
    const reportRef = reportId ? database_1.db.collection('infringementReports').doc(reportId) : null;
    const auditRef = database_1.db.collection('auditLogs').doc();
    const result = await database_1.db.runTransaction(async (tx) => {
        const productSnap = await tx.get(productRef);
        if (!productSnap.exists) {
            throw new https_1.HttpsError('not-found', 'Produkten finns inte.');
        }
        const product = productSnap.data() || {};
        const shopId = product.shopId || null;
        let report = null;
        if (reportRef) {
            const reportSnap = await tx.get(reportRef);
            if (!reportSnap.exists) {
                throw new https_1.HttpsError('not-found', 'Anmälan finns inte.');
            }
            report = reportSnap.data() || {};
            // A report is filed against ONE shop; acting on another shop's product
            // under its id would stamp the wrong audit trail.
            if (report.shopId !== shopId) {
                throw new https_1.HttpsError('failed-precondition', 'Produkten tillhör inte butiken i anmälan.');
            }
            if (report.productId && report.productId !== productId) {
                throw new https_1.HttpsError('failed-precondition', 'Anmälan gäller en annan produkt.');
            }
        }
        const productUpdate = {
            isActive: false,
            takedown: { reportId, at: firestore_1.FieldValue.serverTimestamp(), by: uid, note },
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        };
        if (product.screening && typeof product.screening === 'object') {
            productUpdate['screening.status'] = 'taken_down';
        }
        tx.update(productRef, productUpdate);
        if (reportRef) {
            tx.update(reportRef, {
                status: 'taken_down',
                // A report without a matched product gets the one acted on, so the
                // queue shows what was switched off.
                ...(report?.productId ? {} : { productId }),
                note,
                handledAt: firestore_1.FieldValue.serverTimestamp(),
                handledBy: uid,
            });
        }
        tx.set(auditRef, {
            shopId,
            action: 'takedown_product',
            targetId: productId,
            targetType: 'product',
            targetName: typeof product.name === 'string' ? product.name : null,
            performedBy: uid,
            performedAt: firestore_1.FieldValue.serverTimestamp(),
            details: {
                reportId,
                note,
                source: reportId ? 'infringement_report' : 'screening_queue',
                wasActive: product.isActive === true,
            },
        });
        return { shopId };
    });
    logger.info(`takedownProduct: ${productId} (${result.shopId}) taken down by ${uid}${reportId ? ` for report ${reportId}` : ''}`);
    return { success: true, productId, reportId };
});
//# sourceMappingURL=takedownProduct.js.map