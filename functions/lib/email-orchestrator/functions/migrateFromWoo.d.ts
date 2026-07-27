interface MigrateWooRequest {
    shopId: string;
    wooDomain: string;
    migrationId: string;
    limit?: number;
}
export declare const migrateFromWoo: import("firebase-functions/v2/https").CallableFunction<MigrateWooRequest, any, unknown>;
export {};
