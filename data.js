// Data layer (being introduced for the Supabase migration; no page uses it
// yet). Classic script: firebase-init.js is a deferred module that runs after
// it, so nothing here may read window._db / _fsFns / _authFns / _auth at load
// time. Everything is looked up when a function is called.
(function () {
  // Errors leave the layer as DataError. Only the codes in MAPPED are renamed;
  // anything else keeps the original Firestore/Auth code string (or 'unknown'
  // when there was none), so alerts that print e.code read exactly as before.
  class DataError extends Error {
    constructor(code, message, cause) {
      super(message || code);
      this.name = 'DataError';
      this.code = code;
      this.cause = cause;
    }
  }

  const MAPPED = {
    'permission-denied': 'permission',
    'unavailable': 'offline',
    'deadline-exceeded': 'timeout',
    'not-found': 'not-found',
    'auth/invalid-credential': 'invalid-credential',
    'auth/wrong-password': 'invalid-credential',
    'auth/user-not-found': 'invalid-credential',
    'auth/invalid-email': 'invalid-email',
    'auth/email-already-in-use': 'email-in-use',
    'auth/weak-password': 'weak-password',
    'auth/network-request-failed': 'offline',
  };

  // Page-internal sentinels, thrown as new Error('GATE') etc. and matched on
  // e.message by the pages today.
  const SENTINELS = {
    'GATE': 'cap-reached',
    'ALREADY': 'already-handled',
    'SLUG_TAKEN': 'slug-taken',
  };

  // Same test as window._isFirestoreTerminated in firebase-init.js.
  function isTerminated(err) {
    if (typeof window._isFirestoreTerminated === 'function') return window._isFirestoreTerminated(err);
    return !!(err && /already been terminated/i.test(err.message || ''));
  }

  function normalizeError(err) {
    if (err instanceof DataError) return err;
    const e = err || {};
    if (isTerminated(e)) return new DataError('terminated', e.message, err);
    if (SENTINELS[e.message]) return new DataError(SENTINELS[e.message], e.message, err);
    const raw = e.code ? String(e.code) : '';
    if (MAPPED[raw]) return new DataError(MAPPED[raw], e.message, err);
    return new DataError(raw || 'unknown', e.message, err);
  }

  // Same readiness signal the pages use today: window._auth is set by
  // firebase-init.js, which then fires appDbReady. No timeout on purpose;
  // each page keeps its own stuck-loading UI.
  function ready() {
    return new Promise((resolve) => {
      if (window._auth) { resolve(); return; }
      window.addEventListener('appDbReady', () => resolve(), { once: true });
    });
  }

  const platform = {
    leave(url) {
      if (typeof window._leave === 'function') return window._leave(url);
      location.assign(url);
    },
    isTerminated,
    leaving() { return !!window._leaving; },
  };

  window.Data = { DataError, normalizeError, ready, platform };
})();
