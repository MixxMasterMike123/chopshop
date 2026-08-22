/// <reference types="node" />
/// <reference types="node" />
export declare const PIPELINE_VERSION = 1;
/**
 * The EXACT profile field set the pipeline consumes. The callable's Firestore
 * `ProfileDoc` is a superset (it also carries `label`); the render farm receives
 * precisely these five fields inline in the job envelope, which is what frees
 * the farm from needing a profile store at all.
 */
export interface PipelineProfile {
    id: string;
    accepted_formats?: Array<{
        ext: string;
        preferred?: boolean;
    }>;
    print_area_mm: {
        w: number;
        h: number;
    };
    min_dpi: number;
    max_file_mb?: number;
}
export interface Reason {
    code: string;
    message: string;
}
export interface Notice {
    code: string;
    message: string;
}
/** The measured facts. No storage paths, no URLs, no tenant — by construction. */
export interface PipelineMeta {
    widthPx: number;
    heightPx: number;
    effectiveDpi: number;
    maxPrintMm: {
        w: number;
        h: number;
    };
    profileId: string;
    pipelineVersion: number;
}
export type PipelineResult = {
    ok: false;
    reasons: Reason[];
} | {
    ok: true;
    printPng: Buffer;
    previewWebp: Buffer;
    notices: Notice[];
    meta: PipelineMeta;
};
/**
 * The pipeline core. Returns either a rejection ({ ok:false, reasons }) or the
 * two output buffers plus the measured facts ({ ok:true, printPng, previewWebp,
 * notices, meta }).
 *
 * Every check below — order, threshold and message — is byte-identical to the
 * pre-extraction `runPipeline`, minus the Storage download at the top and the
 * uploads/URL assembly at the bottom, which the wrapper still owns.
 */
export declare function runArtworkPipeline(buf: Buffer, profile: PipelineProfile): Promise<PipelineResult>;
