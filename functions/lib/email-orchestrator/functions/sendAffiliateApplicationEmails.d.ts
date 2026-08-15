interface AffiliateApplicationEmailsRequest {
    applicationId: string;
    language?: string;
}
export declare const sendAffiliateApplicationEmails: import("firebase-functions/v2/https").CallableFunction<AffiliateApplicationEmailsRequest, any, unknown>;
export {};
