import type { Bucket } from '@google-cloud/storage';
export declare const slugify: (str: string) => string;
export declare const skuFromName: (name: string) => string;
export declare const uniqueSku: (base: string, takenSkus: Set<string>) => string;
export interface RawGroup {
    label: string;
    sku?: string;
    price?: string | number;
    images: string[];
    sizes: string[];
}
export interface CleanGroup {
    label: string;
    sku: string;
    price: number | null;
    image: string;
    images: string[];
    sizes: string[];
}
export interface VariantRow {
    sku: string;
    label: string;
    price: number;
    image: string;
    images: string[];
    group: string;
    size: string | null;
}
export declare function deriveVariantsFromGroups(groups: RawGroup[], { productSku, productPrice }: {
    productSku: string;
    productPrice: number;
}): {
    cleanGroups: CleanGroup[];
    cleanVariants: VariantRow[];
};
export declare const isBlockedHost: (host: string) => boolean;
export declare const makeReuploadImage: (bucket: Bucket) => (srcUrl: string, destPath: string) => Promise<string | null>;
export type MigrationPhase = 'fetching' | 'creating' | 'done' | 'error';
export declare function writeProgress(migrationId: string, patch: Record<string, unknown>): Promise<void>;
