/**
 * scripts/cf-port/migrate/lib/typed-json.mjs — typed encoding for Firestore
 * values, per docs/cf-port/MIGRATION_MANIFEST.md §(c).
 *
 * Firestore document data can hold types plain JSON cannot represent
 * (Timestamp, DocumentReference, GeoPoint, Bytes) and values JSON.stringify
 * mangles (NaN, Infinity, -Infinity → null).
 *
 * REVIEW ROUND 1 FIX 1: detection is no longer duck typing on shape alone.
 * A value is only ever treated as a Firestore type when it is a CLASS
 * INSTANCE — i.e. `Object.getPrototypeOf(value)` is neither `Object.prototype`
 * nor `null`. Real Firestore Timestamp/GeoPoint/DocumentReference/Bytes are
 * class instances; a plain map coming back from `doc.data()` (e.g. a shop's
 * `pickupLocations[].location = { latitude, longitude, label }`) is a PLAIN
 * OBJECT and must never be misread as a GeoPoint just because it happens to
 * carry `latitude`/`longitude` keys — that would silently drop `label`.
 * Once "is a class instance" gates entry, the field-shape checks below only
 * decide WHICH known class it is.
 *
 * REVIEW ROUND 1 FIX 2: a class instance that passes the "not a plain
 * object" gate but matches NONE of the four known shapes is an UNKNOWN
 * FIRESTORE TYPE (e.g. a future Firestore SDK type). Encoding it as though
 * it were a plain map would silently lose whatever behaviour/meaning the
 * class carried. `encode()` throws in that case, naming the constructor —
 * never the field contents. The caller (`bundleDocFromSnapshot` in
 * export.mjs) wraps the call and adds the document PATH (only the path,
 * never the data) to the thrown message.
 *
 * decode() reconstructs `ts`/`ref`/`geo` as instances of small internal
 * classes (not plain objects), so a decoded value passes the "is a class
 * instance" gate again and re-encodes to byte-identical output.
 *
 * ESCAPING: a plain object that ALREADY has a `__t` key would be ambiguous
 * with our envelope on decode, so the encoder escapes it by wrapping it as
 * `{"__t":"esc","v":{...original keys, recursively encoded...}}`. The decoder
 * reverses this by unwrapping `esc` back to the plain object. This composes:
 * an object with `__t` whose value is ITSELF such an object is escaped once
 * per level, and decoding is the exact inverse, so round-tripping is lossless
 * at any nesting depth.
 */

// A "plain object" is one made with `{}` or `Object.create(Object.prototype)`
// (what `doc.data()` returns for a map field) or with `Object.create(null)`.
// Anything else — a class instance — is a candidate Firestore type.
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isClassInstance(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isPlainObject(value) && !(value instanceof Date);
}

function looksLikeTimestamp(value) {
  return (
    isClassInstance(value) &&
    typeof value.seconds === 'number' &&
    typeof value.nanoseconds === 'number' &&
    typeof value.toDate === 'function'
  );
}

function looksLikeDocumentReference(value) {
  return isClassInstance(value) && typeof value.path === 'string' && typeof value.firestore === 'object' && value.firestore !== null;
}

function looksLikeGeoPoint(value) {
  return isClassInstance(value) && typeof value.latitude === 'number' && typeof value.longitude === 'number';
}

function looksLikeBytes(value) {
  if (Buffer.isBuffer(value)) return true;
  if (value instanceof Uint8Array) return true;
  if (isClassInstance(value) && typeof value.toUint8Array === 'function') return true;
  return false;
}

function toUint8Array(value) {
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  return value.toUint8Array();
}

function base64OfBytes(value) {
  return Buffer.from(toUint8Array(value)).toString('base64');
}

function isSpecialNumber(value) {
  return typeof value === 'number' && (Number.isNaN(value) || value === Infinity || value === -Infinity);
}

function specialNumberTag(value) {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  return '-Infinity';
}

function specialNumberFromTag(tag) {
  if (tag === 'NaN') return NaN;
  if (tag === 'Infinity') return Infinity;
  if (tag === '-Infinity') return -Infinity;
  throw new Error(`typed-json: unknown special number tag ${JSON.stringify(tag)}`);
}

/** Thrown by encode() when a value is a class instance but matches none of
 * the known Firestore types. Never includes field contents — only the
 * constructor name. export.mjs's bundleDocFromSnapshot() catches this and
 * re-throws with the document path added. */
class UnknownFirestoreTypeError extends Error {
  constructor(constructorName, documentPath = null) {
    super(
      `typed-json: encountered a class instance of unknown type "${constructorName}"` +
        (documentPath === null ? '' : ` in document "${documentPath}"`) +
        ` — refusing to encode it as a plain map (it may be a Firestore type this encoder doesn't know about yet)`,
    );
    this.name = 'UnknownFirestoreTypeError';
    this.constructorName = constructorName;
    this.documentPath = documentPath;
  }
}

/**
 * Recursively encodes a Firestore-shaped value into a plain-JSON-safe value
 * using the `__t` envelope scheme. Object keys are NOT sorted here (see
 * canonicalStringify for that) — encode() only handles typing.
 *
 * Throws UnknownFirestoreTypeError for a class instance matching none of the
 * known shapes (see the file header, fix 2).
 */
function encode(value) {
  if (value === null || value === undefined) {
    return value === undefined ? null : null;
  }
  if (isSpecialNumber(value)) {
    return { __t: 'num', v: specialNumberTag(value) };
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => encode(entry));
  }
  if (looksLikeTimestamp(value)) {
    return {
      __t: 'ts',
      s: value.seconds,
      ns: value.nanoseconds,
      iso: value.toDate().toISOString(),
    };
  }
  if (looksLikeDocumentReference(value)) {
    return { __t: 'ref', path: value.path };
  }
  if (looksLikeGeoPoint(value)) {
    return { __t: 'geo', lat: value.latitude, lng: value.longitude };
  }
  if (looksLikeBytes(value)) {
    return { __t: 'bytes', b64: base64OfBytes(value) };
  }
  if (value instanceof Date) {
    // Not a Firestore Timestamp, but dates leak in from JS-side data too.
    // Preserve it losslessly the same way a Timestamp would be.
    return { __t: 'ts', s: Math.floor(value.getTime() / 1000), ns: (value.getTime() % 1000) * 1e6, iso: value.toISOString() };
  }
  if (isClassInstance(value)) {
    // Not a plain map, not Date, and matched none of the known shapes above:
    // an unknown Firestore (or other) type. Fail loudly rather than silently
    // flattening it into a plain object and losing its meaning.
    throw new UnknownFirestoreTypeError(value.constructor?.name ?? '(anonymous)');
  }
  // Plain object: recurse, then escape if the ORIGINAL had a __t key.
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = encode(entry);
  }
  if (Object.prototype.hasOwnProperty.call(value, '__t')) {
    return { __t: 'esc', v: out };
  }
  return out;
}

// Small internal classes so decode() reconstructs CLASS INSTANCES (not plain
// objects) for ts/ref/geo — required so a decoded value re-encodes to the
// identical bytes under the "class instance" gate above (fix 2).
class DecodedTimestamp {
  constructor(seconds, nanoseconds, iso) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
    this._iso = iso;
  }
  toDate() {
    return new Date(this._iso);
  }
}

class DecodedDocumentReference {
  constructor(refPath) {
    this.path = refPath;
    this.firestore = {};
  }
}

class DecodedGeoPoint {
  constructor(latitude, longitude) {
    this.latitude = latitude;
    this.longitude = longitude;
  }
}

/**
 * Reverses encode(). Firestore-typed envelopes become class-instance
 * reconstructions (DecodedTimestamp/DecodedDocumentReference/DecodedGeoPoint)
 * so a re-encode is byte-identical:
 *   ts    → DecodedTimestamp { seconds, nanoseconds, toDate() }
 *   ref   → DecodedDocumentReference { path, firestore: {} }
 *   geo   → DecodedGeoPoint { latitude, longitude }
 *   bytes → Buffer
 *   num   → the special number
 *   esc   → the unwrapped plain object (recursively decoded)
 */
function decode(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => decode(entry));
  }
  if (Object.prototype.hasOwnProperty.call(value, '__t')) {
    switch (value.__t) {
      case 'ts':
        return new DecodedTimestamp(value.s, value.ns, value.iso);
      case 'ref':
        return new DecodedDocumentReference(value.path);
      case 'geo':
        return new DecodedGeoPoint(value.lat, value.lng);
      case 'bytes':
        return Buffer.from(value.b64, 'base64');
      case 'num':
        return specialNumberFromTag(value.v);
      case 'esc': {
        const out = {};
        for (const [key, entry] of Object.entries(value.v)) {
          out[key] = decode(entry);
        }
        return out;
      }
      default:
        throw new Error(`typed-json: unknown __t tag ${JSON.stringify(value.__t)}`);
    }
  }
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = decode(entry);
  }
  return out;
}

/** Recursively sorts object keys (arrays keep their order) so JSON.stringify
 * output is byte-deterministic regardless of insertion order. */
function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sortKeysDeep(entry));
  }
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

/** JSON.stringify with recursively sorted keys — the canonical, deterministic
 * form used for every line written to a bundle and for content hashing. */
function canonicalStringify(value) {
  return JSON.stringify(sortKeysDeep(value));
}

export {
  encode,
  decode,
  canonicalStringify,
  sortKeysDeep,
  isPlainObject,
  isClassInstance,
  UnknownFirestoreTypeError,
  DecodedTimestamp,
  DecodedDocumentReference,
  DecodedGeoPoint,
};
