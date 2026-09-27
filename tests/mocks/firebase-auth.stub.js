// Test-only stand-in for firebase-auth.js.
const F = () => window.__fakeFirebase;

export function getAuth() {
  return { fake: true };
}

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

export function signOut() {
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
