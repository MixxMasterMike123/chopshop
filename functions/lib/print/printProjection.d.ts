import { type PrintRouting, type PrinterTier } from './printRouting';
export type PlacementSlot = 'front' | 'back' | 'pocket' | 'left_sleeve' | 'right_sleeve' | 'other';
export declare const DEFAULT_SLOT: PlacementSlot;
export declare function slotOf(mapping: any): PlacementSlot;
export declare function slotLabel(slot: PlacementSlot): string;
export declare function mappingSlotLabel(mapping: any, slot: PlacementSlot): string;
export declare function signedUrlFor(storagePath: string, fallbackUrl: string | null, allowedPrefix?: string): Promise<string | null>;
export declare function loadShopMappings(shopId: string): Promise<Map<string, any[]>>;
export type RoutingInputs = {
    routing: PrintRouting;
    printersById: Record<string, PrinterTier>;
};
export declare function loadPrintRoutingInputs(reader?: Pick<FirebaseFirestore.Firestore, 'collection'>): Promise<RoutingInputs>;
export declare function resolveSlots(sku: string, mappingsBySku: Map<string, any[]>): Map<PlacementSlot, any>;
export declare function resolveMapping(sku: string, mappingsBySku: Map<string, any[]>): any | null;
export declare function artworkDeliverable(art: any, shopId: string): {
    deliverable: boolean;
    reason?: string;
};
export declare const PRODUCTION_SNAPSHOT_VERSION = 1;
export type ProductionSnapshotLine = {
    itemIndex: number;
    productName: string;
    sku: string;
    variantLabel: string | null;
    quantity: number;
    placementSlot: PlacementSlot;
    slotLabel: string;
    placement: string;
    profileId: string | null;
    garment: string | null;
    printerUid: string | null;
    printCostSek: number | null;
    itemCostSek: number | null;
    mappingId: string | null;
    artworkId: string | null;
    purpose: string | null;
    artworkVersion: string | null;
    printStoragePath?: string;
    fileName?: string;
    tier?: string | null;
    unresolvedReason?: string;
};
export type ProductionSnapshot = {
    version: 1;
    createdAt: Date;
    lines: ProductionSnapshotLine[];
};
/** Returns null only for legacy orders that predate snapshot enforcement. */
export declare function productionSnapshotLines(order: any): ProductionSnapshotLine[] | null;
export declare function productionSnapshotPending(order: any): boolean;
export declare function isLineVisibleTo(line: {
    printerUid?: string | null;
}, uid: string): boolean;
/**
 * The frozen lines of `order` this printer may see, or null when the order has
 * no snapshot (caller keeps its legacy live-mapping behaviour). An EMPTY array
 * means the order is frozen but entirely someone else's work.
 */
export declare function visibleSnapshotLines(order: any, uid: string): ProductionSnapshotLine[] | null;
/**
 * Split a shop's ordered artworks into "someone else prints this" and the rest,
 * for narrowing the printer's ARTWORK LIBRARY.
 *
 * The library is a REFERENCE view — re-download and printability-check uploads
 * OUTSIDE the order flow — so it is narrowed by EXCLUSION, not by inclusion:
 *
 *   excluded = artworks that appear ONLY on lines routed to another printer.
 *
 * Anything else stays: an artwork on a line routed to me, an artwork on an
 * unrouted line (visible to everyone, per isLineVisibleTo), and — the reason
 * this is an exclusion list — an artwork that has NOT BEEN ORDERED YET. A file
 * uploaded this morning appears on no production line at all; an inclusion list
 * would hide it from the very printer who is meant to vet it.
 *
 * `null` when nothing can be excluded, so callers can skip the filter entirely.
 *
 * This is about relevance and data minimisation, not a security boundary — the
 * shop assignment + pod gate in getPrintShopContext is what keeps foreign shops
 * out, and it is unchanged.
 */
export declare function excludedArtworkIds(orders: any[], uid: string): Set<string> | null;
/**
 * Does this printer have any work in this order? Mirrors orderHasPodLine but
 * per printer — the queue/export predicate. Legacy (unfrozen) orders fall
 * through to orderHasPodLine's shop-level answer.
 */
export declare function orderHasVisiblePodLine(order: any, mappingsBySku: Map<string, any[]>, uid: string): boolean;
/**
 * Resolve and freeze every POD item×slot from the live mapping/artwork graph.
 * Invalid mapped lines are preserved as explicit unresolved rows, never erased.
 * The returned object contains no undefined values and is safe for Firestore.
 *
 * `routingInputs` freezes WHO prints each line and what it costs (Slice 4).
 * Injected like mappingsBySku so the builder stays pure; callers load it once
 * per snapshot with loadPrintRoutingInputs(). Omitting it (tests, and any
 * pre-Slice-4 caller) freezes every line unrouted — printerUid/costs null —
 * which is exactly how a platform with no routing configured behaves.
 */
export declare function buildProductionSnapshot(order: any, mappingsBySku: Map<string, any[]>, dbRef: FirebaseFirestore.Firestore, routingInputs?: RoutingInputs): Promise<ProductionSnapshot>;
/** Read mappings + artwork through an existing transaction for a consistent graph. */
export declare function buildProductionSnapshotInTransaction(order: any, tx: FirebaseFirestore.Transaction): Promise<ProductionSnapshot>;
/** Read mappings + artwork in one Firestore transaction for a consistent graph. */
export declare function buildProductionSnapshotAtomically(order: any): Promise<ProductionSnapshot>;
export declare function findUnresolvedPodLines(order: any, mappingsBySku: Map<string, any[]>, dbRef: FirebaseFirestore.Firestore, artifactAccessCheck?: (storagePath: string, allowedPrefix: string) => Promise<boolean>): Promise<string[]>;
export declare function orderHasPodLine(order: any, mappingsBySku: Map<string, any[]>): boolean;
export declare function toPrintNotificationLines(order: any, mappingsBySku: Map<string, any[]>): Array<{
    productName: string;
    sku: string;
    quantity: number;
    placement: string;
}>;
export declare function toQueueRow(orderId: string, order: any, shopName: string, mappingsBySku: Map<string, any[]>, viewerUid?: string): {
    orderId: string;
    orderNumber: any;
    orderDate: any;
    shopId: any;
    shopName: any;
    status: any;
    podLineCount: number;
    deliveryMethod: string;
    shipToCity: any;
    shipToCountry: any;
};
export declare function toPrintJob(orderId: string, order: any, shopName: string, mappingsBySku: Map<string, any[]>, viewerUid?: string): Promise<{
    order: {
        orderNumber: any;
        orderDate: any;
        status: any;
        orderRef: string;
    };
    shopName: any;
    deliveryMethod: string;
    pickup: {
        name: any;
        address: any;
        date: any;
    } | null;
    shipTo: {
        name: any;
        line1: any;
        line2: any;
        postalCode: any;
        city: any;
        country: any;
    } | null;
    lines: ({
        purpose: string | null;
        artwork: {
            unresolved: boolean;
            reason: string;
            tier?: undefined;
            fileName?: undefined;
            ext?: undefined;
            isPrintFile?: undefined;
            downloadUrl?: undefined;
            previewUrl?: undefined;
        };
        productName: string;
        sku: string;
        variantLabel: string | null;
        quantity: number;
        placementSlot: PlacementSlot;
        slotLabel: string;
        placement: string;
        profileId: string | null;
        garment: string | null;
        printerUid: string | null;
        mockupUrl: string | null;
    } | {
        purpose: string | null;
        artwork: {
            tier: string | null;
            fileName: string;
            ext: string;
            isPrintFile: boolean;
            downloadUrl: string;
            previewUrl: null;
            unresolved?: undefined;
            reason?: undefined;
        };
        productName: string;
        sku: string;
        variantLabel: string | null;
        quantity: number;
        placementSlot: PlacementSlot;
        slotLabel: string;
        placement: string;
        profileId: string | null;
        garment: string | null;
        printerUid: string | null;
        mockupUrl: string | null;
    } | {
        purpose: any;
        artwork: {
            unresolved: boolean;
            reason: string | undefined;
            tier?: undefined;
            fileName?: undefined;
            ext?: undefined;
            isPrintFile?: undefined;
            downloadUrl?: undefined;
            previewUrl?: undefined;
        };
        productName: any;
        sku: any;
        variantLabel: any;
        quantity: any;
        placementSlot: PlacementSlot;
        slotLabel: string;
        placement: string;
        profileId: any;
        garment: string | null;
        mockupUrl: string | null;
    } | {
        purpose: any;
        artwork: {
            tier: any;
            fileName: any;
            ext: any;
            isPrintFile: any;
            downloadUrl: string | null;
            previewUrl: any;
            unresolved?: undefined;
            reason?: undefined;
        };
        productName: any;
        sku: any;
        variantLabel: any;
        quantity: any;
        placementSlot: PlacementSlot;
        slotLabel: string;
        placement: string;
        profileId: any;
        garment: string | null;
        mockupUrl: string | null;
    })[];
}>;
