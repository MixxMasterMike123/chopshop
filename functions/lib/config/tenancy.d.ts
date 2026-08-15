export declare const UNRESOLVED_SHOP_ID = "__unresolved__";
/** Back-compat alias for the remaining `shopId || DEFAULT_SHOP_ID` guard sites. */
export declare const DEFAULT_SHOP_ID = "__unresolved__";
/** True when a shopId is missing or the unresolved sentinel (i.e. no real shop). */
export declare const isUnresolvedShopId: (shopId?: string | null) => boolean;
