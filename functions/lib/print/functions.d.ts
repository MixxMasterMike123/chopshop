export declare const getPrintQueue: import("firebase-functions/v2/https").CallableFunction<any, Promise<{
    jobs: any[];
}>, unknown>;
export declare const getPrintJob: import("firebase-functions/v2/https").CallableFunction<any, Promise<{
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
        placementSlot: import("./printProjection").PlacementSlot;
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
        placementSlot: import("./printProjection").PlacementSlot;
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
        placementSlot: import("./printProjection").PlacementSlot;
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
        placementSlot: import("./printProjection").PlacementSlot;
        slotLabel: string;
        placement: string;
        profileId: any;
        garment: string | null;
        mockupUrl: string | null;
    })[];
}>, unknown>;
export declare const getPrintQueueExport: import("firebase-functions/v2/https").CallableFunction<any, Promise<{
    rows: any[];
}>, unknown>;
interface CreatePrintShopUserRequest {
    email: string;
    name?: string;
    printShopShops: string[];
}
export declare const createPrintShopUser: import("firebase-functions/v2/https").CallableFunction<CreatePrintShopUserRequest, any, unknown>;
export declare const getPrintArtworkLibrary: import("firebase-functions/v2/https").CallableFunction<any, Promise<{
    artworks: any[];
}>, unknown>;
export declare const getPrintArtworkDownload: import("firebase-functions/v2/https").CallableFunction<any, Promise<{
    url: string;
    kind: string;
    fileName: any;
    ext: any;
}>, unknown>;
export {};
