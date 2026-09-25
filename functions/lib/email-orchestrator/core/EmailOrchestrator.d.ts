import { OrderContext } from '../services/UserResolver';
export type EmailType = 'ORDER_CONFIRMATION' | 'ORDER_STATUS_UPDATE' | 'ORDER_NOTIFICATION_ADMIN' | 'PASSWORD_RESET' | 'LOGIN_CREDENTIALS' | 'AFFILIATE_WELCOME' | 'EMAIL_VERIFICATION' | 'AFFILIATE_APPLICATION_RECEIVED' | 'AFFILIATE_APPLICATION_NOTIFICATION_ADMIN' | 'LEAD_NOTIFICATION_ADMIN' | 'INFRINGEMENT_REPORT_ADMIN' | 'WITHDRAWAL_ACKNOWLEDGMENT' | 'REFUND_CONFIRMATION' | 'DISPUTE_ALERT_ADMIN' | 'CONNECT_STATUS_CHANGE' | 'ABANDONED_CHECKOUT_REMINDER' | 'REVIEW_REQUEST' | 'PRINT_ORDER_NOTIFICATION';
export interface EmailContext extends OrderContext {
    emailType: EmailType;
    orderData?: any;
    additionalData?: any;
    language?: string;
    adminEmail?: boolean;
    /** Tenant whose identity the email is sent under (from-name + reply-to). */
    shopId?: string;
}
export declare class EmailOrchestrator {
    private userResolver;
    private emailService;
    constructor();
    /**
     * The shop's ACTIVE admin users' emails — the zero-configuration tier of the
     * admin-notification resolution (after storeIdentity fields / ownerEmail,
     * before the platform fallback). Excludes platform operators (they manage
     * many shops but run none) and inactive users; capped to avoid spamming a
     * shop that has many staff accounts. Reply-To is NOT affected by this — a
     * personal admin email must never become the customer-facing reply address
     * unless the shop explicitly sets it as Support-e-post.
     */
    private resolveShopAdminEmails;
    /**
     * The ACTIVE print_shop users assigned to a shop — the recipients of the
     * "Ny POD-order" notification. A printer is assigned when its printShopShops
     * array contains this shopId; role must be print_shop and active must not be
     * false (mirrors printGuard's live-doc authority). Emails validated with the
     * same isRealEmail placeholder guard used everywhere else, deduped, capped to 5.
     * Returns [] when no printer is assigned — the caller then SKIPS the send (there
     * is deliberately NO platform fallback for this type: a POD order with no printer
     * must not spam the platform inbox; it is a shop-configuration gap surfaced in logs).
     */
    private resolvePrinterEmails;
    /**
     * Send the "Ny POD-order" notification to a shop's assigned printers. Fully
     * self-contained: no UserResolver, no customer/admin routing. Resolves the
     * printers off the live user docs; if none, SKIPS (no platform fallback). The
     * order data (order number, POD lines, delivery method) is passed by the caller
     * in orderData/additionalData — production-scoped, no customer PII.
     */
    private sendPrintOrderNotification;
    /**
     * Master email sending method
     * Single entry point for ALL emails in the system
     */
    sendEmail(context: EmailContext): Promise<{
        success: boolean;
        messageId?: string;
        error?: string;
        details?: any;
    }>;
    /**
     * Generate email template based on type and context
     */
    private loadShopIdentity;
    private generateTemplate;
    /**
     * Get appropriate from address based on email type and user type
     */
    private getFromAddress;
    /**
     * Test the complete email orchestrator system
     */
    testSystem(): Promise<{
        success: boolean;
        error?: string;
        details?: any;
    }>;
}
