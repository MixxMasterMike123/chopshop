export type PlacementSlot = 'front' | 'back' | 'pocket' | 'left_sleeve' | 'right_sleeve' | 'other';
export declare const DEFAULT_SLOT: PlacementSlot;
export declare function slotOf(mapping: any): PlacementSlot;
export declare function slotLabel(slot: PlacementSlot): string;
export declare function mappingSlotLabel(mapping: any, slot: PlacementSlot): string;
export declare function signedUrlFor(storagePath: string, fallbackUrl: string | null, allowedPrefix?: string): Promise<string | null>;
export declare function loadShopMappings(shopId: string): Promise<Map<string, any[]>>;
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
/**
 * Resolve and freeze every POD item×slot from the live mapping/artwork graph.
 * Invalid mapped lines are preserved as explicit unresolved rows, never erased.
 * The returned object contains no undefined values and is safe for Firestore.
 */
export declare function buildProductionSnapshot(order: any, mappingsBySku: Map<string, any[]>, dbRef: FirebaseFirestore.Firestore): Promise<ProductionSnapshot>;
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
export declare function toQueueRow(orderId: string, order: any, shopName: string, mappingsBySku: Map<string, any[]>): {
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
export declare function toPrintJob(orderId: string, order: any, shopName: string, mappingsBySku: Map<string, any[]>): Promise<{
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
