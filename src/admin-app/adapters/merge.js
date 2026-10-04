// A form over a server projection, three ways (unit CP5-FP), pure, tested
// under Node in merge.test.mjs. Nothing here talks to the API.
//
//   sameValue(a, b)                 deep equality: plain objects key by key
//                                   (their key order does not count, an
//                                   undefined value is an absent key), arrays
//                                   item by item, everything else by ===
//   mergeThree(mine, base, theirs)  what a page shows after a write was refused
//                                   because the server's copy moved (or after a
//                                   write whose answer is the stored copy):
//                                   `mine` is the page's form (what it loaded,
//                                   with the person's edits), `base` what it
//                                   loaded, `theirs` what the server holds now

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const definedKeys = (object) => Object.keys(object).filter((key) => object[key] !== undefined);

export function sameValue(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = definedKeys(a);
    return keys.length === definedKeys(b).length && keys.every((key) => b[key] !== undefined && sameValue(a[key], b[key]));
  }
  return false;
}

/**
 * → { value, lost }. A value only one side changed takes that side's; one
 * both changed alike is kept. Plain objects are merged key by key at every
 * depth, so two changes to different fields of one object both stay. A value
 * both changed differently takes the SERVER's (it is stored; the page's is
 * not) and its path is in `lost` (['social', 'facebook']), so the page can say
 * which change of the person's was not kept. Arrays, strings, numbers and
 * null are one value each. A key whose merged value is undefined is left out.
 */
export function mergeThree(mine, base, theirs, path = []) {
  if (sameValue(mine, base)) return { value: theirs, lost: [] };
  if (sameValue(theirs, base)) return { value: mine, lost: [] };
  if (sameValue(mine, theirs)) return { value: theirs, lost: [] };
  if (isPlainObject(mine) && isPlainObject(theirs) && (base === undefined || base === null || isPlainObject(base))) {
    const from = isPlainObject(base) ? base : {};
    const value = {};
    const lost = [];
    for (const key of new Set([...Object.keys(theirs), ...Object.keys(mine), ...Object.keys(from)])) {
      const merged = mergeThree(mine[key], from[key], theirs[key], [...path, key]);
      if (merged.value !== undefined) value[key] = merged.value;
      lost.push(...merged.lost);
    }
    return { value, lost };
  }
  return { value: theirs, lost: [path] };
}
