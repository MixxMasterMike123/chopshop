import type { ProductionSnapshot } from '../print/printProjection';
interface CheckoutTotals {
    subtotal?: number;
    vat?: number;
    shipping?: number;
    discountAmount?: number;
    total?: number;
}
export interface WriteAbandonedCheckoutParams {
    paymentIntentId: string;
    shopId: string;
    customerInfo: {
        email: string;
        name?: string;
        firstName?: string;
        marketing?: boolean;
        remindMe?: boolean;
        preferredLang?: string;
    };
    /** JSON string from createPaymentIntent.buildItemDetailsJson(false). */
    itemsJson: string;
    totals?: CheckoutTotals;
}
/**
 * Persist the immutable production graph before the PaymentIntent client secret
 * is returned. This write is part of payment correctness (not recovery), so its
 * caller must fail checkout if it cannot complete.
 */
export declare function writeCheckoutProductionSnapshot(paymentIntentId: string, shopId: string, productionSnapshot: ProductionSnapshot): Promise<void>;
/**
 * Write (or overwrite) the abandoned-checkout doc for this PaymentIntent. Keyed
 * on the paymentIntentId so a retried checkout naturally supersedes its own doc.
 */
export declare function writeAbandonedCheckoutDoc(params: WriteAbandonedCheckoutParams): Promise<void>;
export {};
