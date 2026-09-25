"use strict";
/**
 * Keeps printersPublic/{uid} in sync with printers/{uid} (A13 — contract and
 * field allowlist in ./projectPrinterPublic).
 *
 * Fires on EVERY printers write — the platform's Tryckerier editor (tier,
 * frames, Inaktivera), the seed scripts, any future Admin SDK writer — so the
 * seller-readable mirror follows without any writer knowing it exists.
 *
 * Same shape as catalog/syncProductsPublic.ts, for the same reasons: the event
 * is a SIGNAL only; the handler re-reads the source in a transaction and
 * projects THAT, so out-of-order / retried events all converge on the current
 * truth. set() WITHOUT merge so a field removed at the source disappears from
 * the mirror; delete() when the source is gone (a deleted tier must un-route
 * the printer in the studio too).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncPrintersPublicOnWrite = void 0;
const firestore_1 = require("firebase-functions/v2/firestore");
const database_1 = require("../config/database");
const projectPrinterPublic_1 = require("./projectPrinterPublic");
exports.syncPrintersPublicOnWrite = (0, firestore_1.onDocumentWritten)({
    document: 'printers/{uid}',
    database: 'b8s-reseller-db',
    region: 'us-central1',
    memory: '256MiB'
}, async (event) => {
    const uid = event.params.uid;
    const srcRef = database_1.db.collection('printers').doc(uid);
    const pubRef = database_1.db.collection('printersPublic').doc(uid);
    await database_1.db.runTransaction(async (tx) => {
        const snap = await tx.get(srcRef);
        const pub = (0, projectPrinterPublic_1.projectPrinterPublic)(snap.exists ? snap.data() : null);
        if (pub) {
            tx.set(pubRef, pub);
        }
        else {
            tx.delete(pubRef);
        }
    });
});
//# sourceMappingURL=syncPrintersPublic.js.map