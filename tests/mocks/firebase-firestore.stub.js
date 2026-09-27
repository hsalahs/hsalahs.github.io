// Test-only stand-in for firebase-firestore.js: a tiny in-memory Firestore
// clone covering exactly the operations this project uses (no indexes, no
// real query planner — just enough to drive deterministic UI tests).
const F = () => window.__fakeFirebase;

function ensureColl(path) {
  const s = F().store;
  if (!s[path]) s[path] = {};
  return s[path];
}

function notify(path) {
  const ls = F().listeners[path];
  if (!ls) return;
  ls.slice().forEach(entry => entry.cb(buildQuerySnapshot(path, entry.filters)));
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

function buildQuerySnapshot(path, filters) {
  const coll = F().store[path] || {};
  const docs = Object.keys(coll)
    .filter(id => !filters || matchesFilters(coll[id], filters))
    .map(id => makeDocSnap(path, id, coll[id]));
  return {
    docs,
    size: docs.length,
    empty: docs.length === 0,
    forEach(cb) { docs.forEach(cb); },
  };
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
  return { __type: 'query', path: collRef.path, filters: clauses.filter(c => c && c.field) };
}

export function where(field, op, value) {
  return { field, op, value };
}

export function serverTimestamp() {
  return { __serverTimestamp: true, seconds: Math.floor(Date.now() / 1000) };
}

export function increment(n) {
  return { __increment: n };
}

function resolveIncrements(existing, patch) {
  const out = { ...existing };
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v && typeof v === 'object' && '__increment' in v) {
      out[k] = (existing && typeof existing[k] === 'number' ? existing[k] : 0) + v.__increment;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function setDoc(ref, data, opts) {
  const coll = ensureColl(ref.collPath);
  coll[ref.id] = opts && opts.merge ? resolveIncrements(coll[ref.id] || {}, data) : { ...data };
  notify(ref.collPath);
  notify(ref.path);
  return Promise.resolve();
}

export function addDoc(collRef, data) {
  const coll = ensureColl(collRef.path);
  const id = 'auto_' + Math.random().toString(36).slice(2, 10);
  coll[id] = { ...data };
  notify(collRef.path);
  return Promise.resolve({ id, path: collRef.path + '/' + id });
}

export function getDoc(ref) {
  const coll = F().store[ref.collPath] || {};
  return Promise.resolve(makeDocSnap(ref.collPath, ref.id, coll[ref.id]));
}

export function getDocs(refOrQuery) {
  if (refOrQuery.__type === 'query') {
    return Promise.resolve(buildQuerySnapshot(refOrQuery.path, refOrQuery.filters));
  }
  return Promise.resolve(buildQuerySnapshot(refOrQuery.path, null));
}

export function updateDoc(ref, patch) {
  const coll = ensureColl(ref.collPath);
  if (!coll[ref.id]) return Promise.reject(new Error('not-found: ' + ref.path));
  coll[ref.id] = resolveIncrements(coll[ref.id], patch);
  notify(ref.collPath);
  notify(ref.path);
  return Promise.resolve();
}

export function deleteDoc(ref) {
  const coll = ensureColl(ref.collPath);
  delete coll[ref.id];
  notify(ref.collPath);
  notify(ref.path);
  return Promise.resolve();
}

export function onSnapshot(refOrQuery, cb) {
  const path = refOrQuery.path;
  if (refOrQuery.__type === 'doc') {
    const emit = () => {
      const coll = F().store[refOrQuery.collPath] || {};
      cb(makeDocSnap(refOrQuery.collPath, refOrQuery.id, coll[refOrQuery.id]));
    };
    const entry = { cb: emit, filters: null };
    F().listeners[path] = F().listeners[path] || [];
    F().listeners[path].push(entry);
    emit();
    return () => {
      F().listeners[path] = (F().listeners[path] || []).filter(e => e !== entry);
    };
  }
  const filters = refOrQuery.__type === 'query' ? refOrQuery.filters : null;
  const entry = { cb, filters };
  F().listeners[path] = F().listeners[path] || [];
  F().listeners[path].push(entry);
  cb(buildQuerySnapshot(path, filters));
  return () => {
    F().listeners[path] = (F().listeners[path] || []).filter(e => e !== entry);
  };
}

export function runTransaction(db, updateFn) {
  const touched = new Set();
  const tx = {
    get(ref) {
      const coll = F().store[ref.collPath] || {};
      return Promise.resolve(makeDocSnap(ref.collPath, ref.id, coll[ref.id]));
    },
    set(ref, data) {
      ensureColl(ref.collPath)[ref.id] = { ...data };
      touched.add(ref.collPath); touched.add(ref.path);
    },
    update(ref, patch) {
      const coll = ensureColl(ref.collPath);
      coll[ref.id] = resolveIncrements(coll[ref.id] || {}, patch);
      touched.add(ref.collPath); touched.add(ref.path);
    },
    delete(ref) {
      delete ensureColl(ref.collPath)[ref.id];
      touched.add(ref.collPath); touched.add(ref.path);
    },
  };
  return Promise.resolve(updateFn(tx)).then((result) => {
    touched.forEach(notify);
    return result;
  });
}
