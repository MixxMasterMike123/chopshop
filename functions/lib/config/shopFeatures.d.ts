/**
 * Is `key` enabled for `shopId`? Legacy keys are default-ON: true unless the
 * flag is the literal boolean false. OPT_IN_KEYS are the inverse: false unless
 * the flag is the literal boolean true (missing doc/map/flag → OFF). Both fail
 * OPEN (return true) on a READ ERROR only, so a transient Firestore problem
 * never disables a paid feature mid-checkout (for pod: never blocks a POD
 * shop's checkout snapshot; the printer's shop ASSIGNMENT remains the primary
 * access control regardless).
 */
export declare const isShopFeatureEnabled: (shopId: string | undefined, key: string) => Promise<boolean>;
