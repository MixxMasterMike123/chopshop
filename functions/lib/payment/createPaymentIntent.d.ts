/**
 * Firebase Function: Create Stripe Payment Intent
 * Handles server-side payment intent creation for B2C checkout
 */
export declare function shopCheckoutBlockReason(shop: any): string | null;
export declare function resolvePickupLocation(shop: any, pickupLocationId: unknown, pickupLocationDate?: unknown, todayIso?: string): {
    id: string;
    name: string;
    address: string;
    date: string;
} | null;
export declare function withdrawalConsentBlockReason(hasPersonalizedItem: boolean, consent: any): string | null;
export interface ServerCartLine {
    productId: string;
    variantSku: string | null;
    quantity: number;
    price: number;
    sku: string;
    name: string;
    label: string;
    image: string;
    isPersonalized: boolean;
    isPodProduct: boolean;
}
export declare function validateCartLine(product: any, item: {
    productId?: string;
    id?: string;
    variantSku?: string | null;
    quantity: number;
}, shopId: string, deliveryMethod: string): ServerCartLine;
export declare const createPaymentIntentV2: import("firebase-functions/v2/https").HttpsFunction;
