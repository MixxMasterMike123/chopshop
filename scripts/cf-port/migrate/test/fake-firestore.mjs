/**
 * scripts/cf-port/migrate/test/fake-firestore.mjs — an in-memory fake of the
 * tiny slice of the Firestore Admin SDK that export.mjs uses, plus a fake
 * Auth client. No network, no firebase-admin import. Every method call is
 * RECORDED so tests can assert which methods were (and were not) invoked —
 * used by the drop-collections-never-read test and the source-scan test's
 * companion runtime check.
 *
 * REVIEW ROUND 1 FIX 4: rewritten as a generic recursive tree so a document
 * can hold ARBITRARY named subcollections to arbitrary depth (not just the
 * two the manifest names), and `docRef.listCollections()` reports exactly
 * the subcollection names actually present under that doc — the primitive
 * export.mjs now uses to discover subcollections the manifest doesn't know
 * about.
 *
 * Schema shape:
 * {
 *   collectionName: {
 *     docId: {
 *       data: {...} | undefined,        // undefined/absent = a phantom parent
 *       createTime, updateTime,          // optional, defaulted
 *       subcollections: {
 *         subName: { docId: { ...same shape, recursively... } }
 *       }
 *     },
 *     ...
 *   },
 *   ...
 * }
 * A "phantom parent" is a docId entry with no `data` key at all (or an entry
 * that exists ONLY because it's referenced as a key under `subcollections`
 * one level up — see `_allParentIds`).
 *
 * Class-instance fakes for Timestamp/DocumentReference/GeoPoint/Bytes are
 * exported too, for the typed-json round-trip tests.
 */

class FakeFieldPath {
  static documentId() {
    return { __fakeFieldPath: 'documentId' };
  }
}

class FakeTimestamp {
  constructor(seconds, nanoseconds) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
  }
  toDate() {
    return new Date(this.seconds * 1000 + this.nanoseconds / 1e6);
  }
  static fromDate(date) {
    const ms = date.getTime();
    return new FakeTimestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6);
  }
}

class FakeDocumentReference {
  constructor(path, firestore) {
    this.path = path;
    this.firestore = firestore ?? {};
  }
}

class FakeGeoPoint {
  constructor(latitude, longitude) {
    this.latitude = latitude;
    this.longitude = longitude;
  }
}

class FakeBytes {
  constructor(buffer) {
    this._buffer = buffer;
  }
  toUint8Array() {
    return new Uint8Array(this._buffer);
  }
}

/** A class instance matching NONE of the known Firestore type shapes — used
 * to test that encode() throws loudly instead of silently flattening it. */
class FakeUnknownFirestoreType {
  constructor(value) {
    this.value = value;
  }
}

class FakeQuerySnapshot {
  constructor(docs) {
    this.docs = docs;
    this.empty = docs.length === 0;
  }
}

class FakeCountSnapshot {
  constructor(count) {
    this._count = count;
  }
  data() {
    return { count: this._count };
  }
}

class FakeDocumentSnapshot {
  constructor(id, node) {
    this.id = id;
    this.createTime = node?.createTime ?? new FakeTimestamp(1_700_000_000, 0);
    this.updateTime = node?.updateTime ?? new FakeTimestamp(1_700_000_000, 0);
    this._dataValue = node?.data ?? {};
  }
  data() {
    return this._dataValue;
  }
}

/** Looks up the tree node at a `pathSegments` array of alternating
 * [collectionName, docId, collectionName, docId, ...] under `schema`.
 * Returns undefined if any segment along the way doesn't exist. */
function lookupNode(schema, pathSegments) {
  let level = schema;
  let node;
  for (let i = 0; i < pathSegments.length; i += 2) {
    const collectionName = pathSegments[i];
    const docId = pathSegments[i + 1];
    if (level === undefined) return undefined;
    const collection = level[collectionName];
    if (collection === undefined) return undefined;
    node = collection[docId];
    if (node === undefined) return undefined;
    level = node.subcollections;
  }
  return node;
}

/** Returns the map of { docId: node } for the collection at `pathSegments`
 * (a full collection path, alternating collection/doc names ending in a
 * collection name), or {} if it doesn't exist. */
function lookupCollection(schema, pathSegments) {
  if (pathSegments.length === 1) {
    return schema[pathSegments[0]] ?? {};
  }
  const parentNode = lookupNode(schema, pathSegments.slice(0, -1));
  const collectionName = pathSegments[pathSegments.length - 1];
  return parentNode?.subcollections?.[collectionName] ?? {};
}

/** Every doc id that should be visited by listDocuments() for the collection
 * at `pathSegments`: ids with a `data` key OR ids that only exist because
 * they hold subcollections (phantom parents). */
function allDocIdsInCollection(schema, pathSegments) {
  const collection = lookupCollection(schema, pathSegments);
  return Object.keys(collection).sort();
}

/** The subcollection NAMES actually present under the doc at `pathSegments`
 * (a full doc path, alternating collection/doc names ending in a doc id). */
function subcollectionNamesUnderDoc(schema, pathSegments) {
  const node = lookupNode(schema, pathSegments);
  return Object.keys(node?.subcollections ?? {}).sort();
}

class FakeFirestore {
  constructor(schema, callLog = []) {
    this._schema = schema;
    this._callLog = callLog;
  }

  _log(entry) {
    this._callLog.push(entry);
  }

  async listCollections() {
    this._log({ method: 'listCollections' });
    return Object.keys(this._schema).map((name) => new FakeCollectionRef(this, [name]));
  }

  collection(name) {
    return new FakeCollectionRef(this, [name]);
  }
}

/**
 * A collection reference identified by `pathSegments`: an array alternating
 * collection name / doc id, ending in a collection name, e.g. `['users']`
 * (top-level) or `['users', 'u1', 'marketingMaterials']` (subcollection).
 */
class FakeCollectionRef {
  constructor(firestore, pathSegments) {
    this._firestore = firestore;
    this._pathSegments = pathSegments;
    this.id = pathSegments[pathSegments.length - 1];
    this.path = pathSegments.join('/');
  }

  _label() {
    return this._pathSegments.join('/');
  }

  async listDocuments() {
    this._firestore._log({ method: 'listDocuments', collection: this._label() });
    const ids = allDocIdsInCollection(this._firestore._schema, this._pathSegments);
    return ids.map((id) => new FakeDocumentRefLite(this._firestore, [...this._pathSegments, id]));
  }

  orderBy() {
    return new FakeQuery(this, null);
  }

  async get() {
    this._firestore._log({ method: 'get', collection: this._label() });
    const collection = lookupCollection(this._firestore._schema, this._pathSegments);
    const snaps = Object.keys(collection)
      .sort()
      .map((id) => new FakeDocumentSnapshot(id, collection[id]));
    return new FakeQuerySnapshot(snaps);
  }

  count() {
    return {
      get: async () => {
        this._firestore._log({ method: 'count', collection: this._label() });
        const collection = lookupCollection(this._firestore._schema, this._pathSegments);
        return new FakeCountSnapshot(Object.keys(collection).length);
      },
    };
  }
}

class FakeDocumentRefLite {
  constructor(firestore, pathSegments) {
    this._firestore = firestore;
    this._pathSegments = pathSegments;
    this.id = pathSegments[pathSegments.length - 1];
    this.path = pathSegments.join('/');
  }

  collection(subName) {
    return new FakeCollectionRef(this._firestore, [...this._pathSegments, subName]);
  }

  /** The primitive fix 4 relies on: the subcollection NAMES actually present
   * under this document (read-only; never returns anything to write). */
  async listCollections() {
    this._firestore._log({ method: 'listCollections(doc)', doc: this.path });
    const names = subcollectionNamesUnderDoc(this._firestore._schema, this._pathSegments);
    return names.map((name) => new FakeCollectionRef(this._firestore, [...this._pathSegments, name]));
  }
}

class FakeQuery {
  constructor(collectionRef, startAfterId, limitN = null) {
    this._collectionRef = collectionRef;
    this._startAfterId = startAfterId;
    this._limitN = limitN;
  }
  orderBy() {
    return this;
  }
  startAfter(id) {
    return new FakeQuery(this._collectionRef, id, this._limitN);
  }
  limit(n) {
    return new FakeQuery(this._collectionRef, this._startAfterId, n);
  }
  async get() {
    this._collectionRef._firestore._log({
      method: 'get',
      collection: this._collectionRef._label(),
      paged: true,
    });
    const collection = lookupCollection(this._collectionRef._firestore._schema, this._collectionRef._pathSegments);
    let ids = Object.keys(collection).sort();
    if (this._startAfterId !== null) {
      const idx = ids.indexOf(this._startAfterId);
      ids = idx === -1 ? [] : ids.slice(idx + 1);
    }
    if (this._limitN !== null) {
      ids = ids.slice(0, this._limitN);
    }
    const snaps = ids.map((id) => new FakeDocumentSnapshot(id, collection[id]));
    return new FakeQuerySnapshot(snaps);
  }
}

/** A fake Auth client: construct with an array of user objects (already in
 * the shape auth.listUsers() would hand back, including forbidden fields
 * like passwordHash so the allowlist test can prove they're dropped). */
class FakeAuth {
  constructor(users, callLog = []) {
    this._users = users;
    this._callLog = callLog;
  }
  async listUsers(maxResults = 1000, pageToken) {
    this._callLog.push({ method: 'listUsers', maxResults, pageToken });
    const start = pageToken ? Number(pageToken) : 0;
    const page = this._users.slice(start, start + maxResults);
    const nextToken = start + maxResults < this._users.length ? String(start + maxResults) : undefined;
    return { users: page, pageToken: nextToken };
  }
}

export {
  FakeFirestore,
  FakeAuth,
  FakeFieldPath,
  FakeTimestamp,
  FakeDocumentReference,
  FakeGeoPoint,
  FakeBytes,
  FakeUnknownFirestoreType,
};
