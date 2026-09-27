// Test-only stand-in for firebase-app.js. Served in place of the real CDN
// module via Playwright route interception, so tests never touch a real
// Firebase project or the network.
window.__fakeFirebase = window.__fakeFirebase || {
  auth: { user: null, listeners: [], nextSignInResult: null, nextSignInError: null, nextResetError: null },
  store: {}, // path -> { id -> data }
  listeners: {}, // path -> Set of {cb, filters}
};

export function initializeApp(config) {
  return { config };
}
