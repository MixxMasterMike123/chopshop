/**
 * contentScreening — SERVER TWIN of src/utils/contentScreening.js (SnapWear A11).
 *
 * Same matcher, byte-for-byte in behaviour: the functions build cannot compile
 * a file from the app's src/ (tsconfig rootDir: "src"), so the client module
 * and this one are logic twins, held together by
 * rules-tests/content-screening-parity.test.cjs. Change one, change both.
 *
 * Plus decideScreening(): the PURE state machine the screenProductOnWrite
 * trigger runs, kept here (no firebase imports) so it is unit-testable too.
 */
export interface BlocklistEntry {
    term: string;
    kind: string;
    hardBlock: boolean;
}
type AnyDoc = Record<string, unknown>;
export declare const foldText: (value: unknown) => string;
export declare const tokenize: (value: unknown) => string;
export declare const productScreeningTexts: (product: AnyDoc | null | undefined, artworkFileNames?: unknown[]) => string[];
export declare const normalizeBlocklist: (raw: unknown) => BlocklistEntry[];
export declare const findScreeningHits: (texts: unknown, blocklist: unknown) => BlocklistEntry[];
export declare const screenProduct: (product: AnyDoc | null | undefined, blocklist: unknown, artworkFileNames?: unknown[]) => string[];
/** Statuses on products/{id}.screening. Queue = flagged | review | blocked. */
export type ScreeningStatus = 'ok' | 'review' | 'flagged' | 'blocked' | 'cleared' | 'taken_down';
export interface ScreeningState {
    status: ScreeningStatus;
    hits: string[];
    /** Terms seen on earlier versions — a rename that drops a hit keeps them. */
    earlierHits?: string[];
}
export interface ScreeningDecisionInput {
    prev: ScreeningState | null;
    /** Hit terms on the CURRENT product text. */
    terms: string[];
    /** Any hit term is hard-blocked (per-term flag or settings.hardBlock). */
    hardBlock: boolean;
    /** Other live products this shop already has (only needed when prev is null). */
    shopPublishedCount: number;
    reviewFirstProducts: number;
}
export interface ScreeningDecision {
    /** New screening state to write, or null to leave it untouched. */
    screening: ScreeningState | null;
    /** Force isActive=false (hard block). */
    deactivate: boolean;
}
/**
 * Decide what to stamp on a LIVE product. Returns { screening: null,
 * deactivate: false } for "nothing to do" — the trigger's own write re-fires
 * the trigger, so an unchanged input MUST converge to a no-op.
 *
 *   - hits present         → flagged (or blocked + deactivate when hard-blocked);
 *   - no hits, first time  → review when the shop has < reviewFirstProducts
 *                            other live products (new shop), else ok;
 *   - hits dropped         → keep the status (a rename that dodges the list
 *                            still needs the human look), remember earlierHits;
 *   - platform 'cleared'   → sticks while no NEW term appears;
 *   - 'taken_down'         → sticks (reinstating is a platform action).
 */
export declare function decideScreening(input: ScreeningDecisionInput): ScreeningDecision;
export {};
