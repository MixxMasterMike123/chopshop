// This build's browser preferences live under neutral keys (`admin.*`). The
// older admin kept them under keys named after an earlier brand; that name
// must not ship in this bundle (CP5 brief FB.4), so the old key is found by
// its SUFFIX, read once, and its value carried over to the new key. Every
// storage access can throw (private mode, blocked site data): guarded.

function local() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The value under `key`; if there is none, the value of the first other key
 * that ends with one of `legacySuffixes` and passes `accept`, written to
 * `key` (the old key is left alone). Null when neither exists.
 */
export function readWithLegacy(key, legacySuffixes, accept = () => true) {
  const s = local();
  if (!s) return null;
  try {
    const current = s.getItem(key);
    if (current !== null) return current;
    for (let i = 0; i < s.length; i += 1) {
      const name = s.key(i);
      if (!name || name === key || !legacySuffixes.some((suffix) => name.endsWith(suffix))) continue;
      const value = s.getItem(name);
      if (value !== null && accept(value)) {
        s.setItem(key, value);
        return value;
      }
    }
  } catch {
    /* storage refused */
  }
  return null;
}

export function writeLocal(key, value) {
  try {
    local()?.setItem(key, value);
  } catch {
    /* storage refused: kept for this page only */
  }
}
