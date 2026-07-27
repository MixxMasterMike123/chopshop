export declare const PIPELINE_VERSION = 1;
interface Reason {
    code: string;
    message: string;
}
interface Notice {
    code: string;
    message: string;
}
export declare const processPodArtwork: import("firebase-functions/v2/https").CallableFunction<any, Promise<{
    ok: false;
    reasons: Reason[];
    notices?: undefined;
    fields?: undefined;
} | {
    ok: true;
    notices: Notice[];
    fields: {
        status: string;
        printUrl: string;
        printStoragePath: string;
        previewUrl: string;
        previewStoragePath: string;
        sourceWidthPx: number;
        sourceHeightPx: number;
        validation: {
            gate: string;
            tier: string;
            effectiveDpi: number;
            maxPrintMm: {
                w: number;
                h: number;
            };
            notices: Notice[];
            reasons: never[];
            checkedAt: string;
            profileId: string;
            pipelineVersion: number;
        };
    };
    reasons?: undefined;
}>, unknown>;
export {};
