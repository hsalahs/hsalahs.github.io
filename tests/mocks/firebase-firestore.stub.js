// Test-only stand-in for firebase-firestore.js: a tiny in-memory Firestore
// clone covering exactly the operations this project uses (no indexes, no
// real query planner — just enough to drive deterministic UI tests).
//
// It enforces no security rules. Tests that need to see how a page reacts
// to a rule denying something (a wrong door code, a revoked scanner session,
// rules not deployed yet) list path prefixes in
// window.__fakeFirebase.denyPaths — any read or write whose path starts with
// one of them fails with the SDK's permission-denied error shape.
const F = () => window.__fakeFirebase;

function ensureColl(path) {
  const s = F().store;
  if (!s[path]) s[path] = {};
  return s[path];
}

function isDenied(path) {
  return (F().denyPaths || []).some(prefix => path.startsWith(prefix));
}

// Listing a collection (a collection ref or a query on it) denied while
// opening a single document inside it stays allowed — the same split the
// security rules make for guest requests (allow get / allow list). Exact
// collection paths, unlike denyPaths' prefixes.
function isListDenied(path) {
  return (F().denyLists || []).includes(path);
}

function permissionDenied(path) {
  const e = new Error('Missing or insufficient permissions. (' + path + ')');
  e.code = 'permission-denied';
  return e;
}

function notify(path) {
  const ls = F().listeners[path];
  if (!ls) return;
  // Doc-listener entries wrap their own re-fetch in `cb` (see onSnapshot)
  // and ignore whatever's passed in; only query/collection entries need a
  // freshly built snapshot (with docChanges) handed to them here.
  ls.slice().forEach(entry => entry.cb(entry.kind === 'doc' ? undefined : snapshotWithChanges(path, entry)));
}

function matchesFilters(data, filters) {
  return filters.every(f => {
    const v = data[f.field];
    switch (f.op) {
      case '==': return v === f.value;
      case '!=': return v !== f.value;
      case '<': return v < f.value;
      case '<=': return v <= f.value;
      case '>': return v > f.value;
      case '>=': return v >= f.value;
      default: return true;
    }
  });
}

function orderValue(v) {
  // Sortable key for both a plain number/string and this stub's
  // serverTimestamp() shape ({ __serverTimestamp: true, seconds }).
  return v && typeof v === 'object' && 'seconds' in v ? v.seconds : v;
}

function buildQuerySnapshot(path, filters, order) {
  const coll = F().store[path] || {};
  let ids = Object.keys(coll).filter(id => !filters || matchesFilters(coll[id], filters));
  if (order) {
    const dir = order.direction === 'desc' ? -1 : 1;
    ids = ids.sort((a, b) => {
      const av = orderValue(coll[a][order.orderField]);
      const bv = orderValue(coll[b][order.orderField]);
      return av < bv ? -dir : av > bv ? dir : 0;
    });
  }
  const docs = ids.map(id => makeDocSnap(path, id, coll[id]));
  return {
    docs,
    size: docs.length,
    empty: docs.length === 0,
    forEach(cb) { docs.forEach(cb); },
  };
}

// Adds docChanges() to a query/collection snapshot — which added, modified
// or removed document just produced this snapshot, matching the real SDK's
// method. `entry` carries the listener's own memory of the ids+data it last
// saw (one listener's view can differ from another's, e.g. different
// filters), which this call both reads and updates.
function snapshotWithChanges(path, entry) {
  const snap = buildQuerySnapshot(path, entry.filters, entry.order);
  const prev = entry.prevDocsById || {};
  const next = {};
  const changes = [];
  snap.docs.forEach(d => {
    const json = JSON.stringify(d.data());
    next[d.id] = json;
    if (!(d.id in prev)) changes.push({ type: 'added', doc: d });
    else if (prev[d.id] !== json) changes.push({ type: 'modified', doc: d });
  });
  Object.keys(prev).forEach(id => {
    if (!(id in next)) changes.push({ type: 'removed', doc: makeDocSnap(path, id, undefined) });
  });
  entry.prevDocsById = next;
  snap.docChanges = () => changes;
  return snap;
}

function makeDocSnap(path, id, data) {
  return {
    id,
    exists: () => data !== undefined,
    data: () => (data === undefined ? undefined : { ...data }),
    ref: { __type: 'doc', path: path + '/' + id, collPath: path, id },
  };
}

export function getFirestore() {
  return { fake: true };
}

// initializeFirestore(app, { localCache }) — the stub has no real IndexedDB
// cache to set up, so this is just getFirestore under the real SDK's name,
// keeping firebase-init.js's import list the same in tests and in prod.
export function initializeFirestore() {
  return { fake: true };
}
export function persistentLocalCache(settings) {
  return { kind: 'persistent', settings };
}
export function persistentMultipleTabManager() {
  return { kind: 'multi-tab' };
}

export function doc(db, ...segs) {
  // doc(db, 'events', id) or doc(db, 'events', id, 'guests', gid)
  const id = segs[segs.length - 1];
  const collPath = segs.slice(0, -1).join('/');
  return { __type: 'doc', path: segs.join('/'), collPath, id };
}

export function collection(db, ...segs) {
  return { __type: 'collection', path: segs.join('/') };
}

export function query(collRef, ...clauses) {
  return {
    __type: 'query',
    path: collRef.path,
    filters: clauses.filter(c => c && c.field),
    order: clauses.find(c => c && c.orderField) || null,
  };
}

export function where(field, op, value) {
  return { field, op, value };
}

export function orderBy(field, direction) {
  return { orderField: field, direction: direction || 'asc' };
}

export function serverTimestamp() {
  const seconds = Math.floor(Date.now() / 1000);
  return { __serverTimestamp: true, seconds, toDate: () => new Date(seconds * 1000) };
}

export function increment(n) {
  return { __increment: n };
}

export function deleteField() {
  return { __deleteField: true };
}

function resolveIncrements(existing, patch) {
  const out = { ...existing };
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v && typeof v === 'object' && '__increment' in v) {
      out[k] = (existing && typeof existing[k] === 'number' ? existing[k] : 0) + v.__increment;
    } else if (v && typeof v === 'object' && '__deleteField' in v) {
      delete out[k];
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function setDoc(ref, data, opts) {
  if (window.__setDocDelay && !ref.__delayed) {
    const ms = window.__setDocDelay;
    return new Promise((r) => setTimeout(r, ms)).then(() => setDoc({ ...ref, __delayed: true }, data, opts));
  }
  if (isDenied(ref.path)) return Promise.reject(permissionDenied(ref.path));
  const coll = ensureColl(ref.collPath);
  coll[ref.id] = opts && opts.merge ? resolveIncrements(coll[ref.id] || {}, data) : { ...data };
  notify(ref.collPath);
  notify(ref.path);
  return Promise.resolve();
}

export function addDoc(collRef, data) {
  if (isDenied(collRef.path)) return Promise.reject(permissionDenied(collRef.path));
  const coll = ensureColl(collRef.path);
  const id = 'auto_' + Math.random().toString(36).slice(2, 10);
  coll[id] = { ...data };
  notify(collRef.path);
  return Promise.resolve({ id, path: collRef.path + '/' + id });
}

export function getDoc(ref) {
  // Lets tests simulate a dropped connection on a specific read, e.g. to
  // verify a page's init() shows a retry option instead of hanging on
  // "جاري التحميل..." forever. Cleared automatically after firing once.
  if (window.__failNextGetDoc) {
    window.__failNextGetDoc = false;
    return Promise.reject(new Error('simulated network failure'));
  }
  // ...and a read that never answers at all (the stuck-loading case).
  if (window.__hangGetDoc) return new Promise(() => {});
  if (window.__getDocDelays && window.__getDocDelays[ref.path] && !ref.__delayed) {
    return new Promise((r) => setTimeout(r, window.__getDocDelays[ref.path])).then(() => getDoc({ ...ref, __delayed: true }));
  }
  if (isDenied(ref.path)) return Promise.reject(permissionDenied(ref.path));
  const coll = F().store[ref.collPath] || {};
  return Promise.resolve(makeDocSnap(ref.collPath, ref.id, coll[ref.id]));
}

export function getDocs(refOrQuery) {
  if (isDenied(refOrQuery.path) || isListDenied(refOrQuery.path)) return Promise.reject(permissionDenied(refOrQuery.path));
  // Test-only tally of which collection paths actually got a real read, so
  // a test can assert a quota-saving change really stopped a redundant one
  // (not just that the UI still ends up showing the right numbers).
  (F().getDocsPaths = F().getDocsPaths || []).push(refOrQuery.path);
  if (refOrQuery.__type === 'query') {
    return Promise.resolve(buildQuerySnapshot(refOrQuery.path, refOrQuery.filters, refOrQuery.order));
  }
  return Promise.resolve(buildQuerySnapshot(refOrQuery.path, null));
}

// A count costs about one read however many documents it counts — the
// tally lets a test tell it apart from a full getDocs.
export function getCountFromServer(refOrQuery) {
  if (isDenied(refOrQuery.path) || isListDenied(refOrQuery.path)) return Promise.reject(permissionDenied(refOrQuery.path));
  (F().countPaths = F().countPaths || []).push(refOrQuery.path);
  const snap = buildQuerySnapshot(refOrQuery.path, refOrQuery.filters || null, refOrQuery.order);
  return Promise.resolve({ data: () => ({ count: snap.docs.length }) });
}

export function updateDoc(ref, patch) {
  if (isDenied(ref.path)) return Promise.reject(permissionDenied(ref.path));
  const coll = ensureColl(ref.collPath);
  if (!coll[ref.id]) return Promise.reject(new Error('not-found: ' + ref.path));
  coll[ref.id] = resolveIncrements(coll[ref.id], patch);
  notify(ref.collPath);
  notify(ref.path);
  return Promise.resolve();
}

export function deleteDoc(ref) {
  if (isDenied(ref.path)) return Promise.reject(permissionDenied(ref.path));
  const coll = ensureColl(ref.collPath);
  delete coll[ref.id];
  notify(ref.collPath);
  notify(ref.path);
  return Promise.resolve();
}

export function onSnapshot(refOrQuery, cb, errCb) {
  const path = refOrQuery.path;
  if (isDenied(path) || (refOrQuery.__type !== 'doc' && isListDenied(path))) {
    // The real SDK reports a denied listener asynchronously through the
    // error callback, and never delivers data.
    Promise.resolve().then(() => errCb && errCb(permissionDenied(path)));
    return () => {};
  }
  if (refOrQuery.__type === 'doc') {
    const emit = () => {
      const coll = F().store[refOrQuery.collPath] || {};
      cb(makeDocSnap(refOrQuery.collPath, refOrQuery.id, coll[refOrQuery.id]));
    };
    const entry = { cb: emit, filters: null, kind: 'doc' };
    F().listeners[path] = F().listeners[path] || [];
    F().listeners[path].push(entry);
    emit();
    return () => {
      F().listeners[path] = (F().listeners[path] || []).filter(e => e !== entry);
    };
  }
  const filters = refOrQuery.__type === 'query' ? refOrQuery.filters : null;
  const order = refOrQuery.__type === 'query' ? refOrQuery.order : null;
  const entry = { cb, filters, order, kind: 'query' };
  F().listeners[path] = F().listeners[path] || [];
  F().listeners[path].push(entry);
  cb(snapshotWithChanges(path, entry));
  return () => {
    F().listeners[path] = (F().listeners[path] || []).filter(e => e !== entry);
  };
}

export function runTransaction(db, updateFn) {
  const touched = new Set();
  const tx = {
    get(ref) {
      if (isDenied(ref.path)) return Promise.reject(permissionDenied(ref.path));
      const coll = F().store[ref.collPath] || {};
      return Promise.resolve(makeDocSnap(ref.collPath, ref.id, coll[ref.id]));
    },
    set(ref, data) {
      if (isDenied(ref.path)) throw permissionDenied(ref.path);
      ensureColl(ref.collPath)[ref.id] = { ...data };
      touched.add(ref.collPath); touched.add(ref.path);
    },
    update(ref, patch) {
      if (isDenied(ref.path)) throw permissionDenied(ref.path);
      const coll = ensureColl(ref.collPath);
      coll[ref.id] = resolveIncrements(coll[ref.id] || {}, patch);
      touched.add(ref.collPath); touched.add(ref.path);
    },
    delete(ref) {
      if (isDenied(ref.path)) throw permissionDenied(ref.path);
      delete ensureColl(ref.collPath)[ref.id];
      touched.add(ref.collPath); touched.add(ref.path);
    },
  };
  return Promise.resolve().then(() => updateFn(tx)).then((result) => {
    touched.forEach(notify);
    return result;
  });
}
