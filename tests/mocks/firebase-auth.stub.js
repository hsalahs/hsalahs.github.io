// Test-only stand-in for firebase-auth.js.
const F = () => window.__fakeFirebase;

export function getAuth() {
  // scan.html reads auth.currentUser directly (synchronously) to decide
  // whether it already has an identity before signing in anonymously.
  return { fake: true, get currentUser() { return F().auth.user; } };
}

// firebase-init.js uses initializeAuth (not getAuth) — same fake auth object;
// records the options so a test can check no popup/redirect resolver is set.
export function initializeAuth(app, opts) {
  F().authInitOptions = { persistence: (opts && opts.persistence || []).map(String), hasPopupRedirectResolver: !!(opts && opts.popupRedirectResolver) };
  return getAuth();
}
export const indexedDBLocalPersistence = 'indexedDBLocalPersistence';
export const browserLocalPersistence = 'browserLocalPersistence';
export const browserSessionPersistence = 'browserSessionPersistence';

export function onAuthStateChanged(auth, cb) {
  F().auth.listeners.push(cb);
  cb(F().auth.user);
  return () => {
    F().auth.listeners = F().auth.listeners.filter(l => l !== cb);
  };
}

function notifyAuth() {
  F().auth.listeners.slice().forEach(cb => cb(F().auth.user));
}

// Tests drive sign-in/sign-up outcomes via window.__fakeFirebase.auth.nextSignInResult /
// nextSignInError (set with page.evaluate before clicking submit).
export function createUserWithEmailAndPassword(auth, email, password) {
  return _signIn(email);
}
export function signInWithEmailAndPassword(auth, email, password) {
  return _signIn(email);
}
function _signIn(email) {
  const a = F().auth;
  if (a.nextSignInError) {
    const err = a.nextSignInError;
    a.nextSignInError = null;
    return Promise.reject(err);
  }
  const user = a.nextSignInResult || { uid: 'test-uid', email };
  a.nextSignInResult = null;
  a.user = user;
  notifyAuth();
  return Promise.resolve({ user });
}

// The door-scanner page's identity. Tests can pin the uid with
// auth.nextAnonUid, or make it fail (e.g. the provider being disabled in the
// Firebase console) with auth.nextSignInError.
export function signInAnonymously(auth) {
  const a = F().auth;
  a.anonCalls = (a.anonCalls || 0) + 1;
  if (a.alwaysSignInError) return Promise.reject(a.alwaysSignInError);
  if (a.nextSignInError) {
    const err = a.nextSignInError;
    a.nextSignInError = null;
    return Promise.reject(err);
  }
  const finish = () => {
    const user = { uid: a.nextAnonUid || ('anon-' + Math.random().toString(36).slice(2, 8)), isAnonymous: true, email: null };
    a.nextAnonUid = null;
    a.user = user;
    notifyAuth();
    return { user };
  };
  const ms = window.__signInDelay || 0;
  if (!ms) return Promise.resolve(finish());
  return new Promise((r) => setTimeout(r, ms)).then(finish);
}

export function signOut() {
  F().auth.signOutCalls = (F().auth.signOutCalls || 0) + 1;
  F().auth.user = null;
  notifyAuth();
  return Promise.resolve();
}

export function sendPasswordResetEmail(auth, email) {
  const a = F().auth;
  if (a.nextResetError) {
    const err = a.nextResetError;
    a.nextResetError = null;
    return Promise.reject(err);
  }
  return Promise.resolve();
}
