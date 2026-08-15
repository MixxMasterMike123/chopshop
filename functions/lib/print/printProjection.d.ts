export type PlacementSlot = 'front' | 'back' | 'pocket' | 'left_sleeve' | 'right_sleeve' | 'other';
export declare const DEFAULT_SLOT: PlacementSlot;
export declare function slotOf(mapping: any): PlacementSlot;
export declare function slotLabel(slot: PlacementSlot): string;
export declare function mappingSlotLabel(mapping: any, slot: PlacementSlot): string;
export declare function signedUrlFor(storagePath: string, fallbackUrl: string | null): Promise<string | null>;
export declare function loadShopMappings(shopId: string): Promise<Map<string, any[]>>;
export declare function resolveSlots(sku: string, mappingsBySku: Map<string, any[]>): Map<PlacementSlot, any>;
export declare function resolveMapping(sku: string, mappingsBySku: Map<string, any[]>): any | null;
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
            reason: string;
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
        mockupUrl: string | null;
    })[];
}>;
