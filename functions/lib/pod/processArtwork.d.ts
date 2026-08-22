import { PIPELINE_VERSION } from './artworkPipelineCore';
export { PIPELINE_VERSION };
export declare const processPodArtwork: import("firebase-functions/v2/https").CallableFunction<any, Promise<{
    ok: false;
    reasons: import("./artworkPipelineCore").Reason[];
    notices?: undefined;
    fields?: undefined;
} | {
    ok: true;
    notices: import("./artworkPipelineCore").Notice[];
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
            notices: import("./artworkPipelineCore").Notice[];
            reasons: never[];
            checkedAt: string;
            profileId: string;
            pipelineVersion: number;
        };
    };
    reasons?: undefined;
}>, unknown>;
