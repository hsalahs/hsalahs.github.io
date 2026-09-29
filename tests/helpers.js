const fs = require('fs');
const path = require('path');

const STUBS = {
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js': 'firebase-app.stub.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js': 'firebase-auth.stub.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js': 'firebase-firestore.stub.js',
};

// Replaces the real Firebase SDK with the in-memory fake, and short-circuits
// every other third-party host (fonts, qrcodejs, jszip, qr-scanner CDNs) so
// tests run fully offline and deterministically. Call before page.goto().
async function stubFirebase(page) {
  // Playwright matches routes in reverse registration order (last registered
  // wins), so the broad blocker must be registered FIRST and the specific
  // Firebase stub routes SECOND, or the blocker shadows them.
  //
  // Any other external host: fail fast instead of hanging on a blocked
  // sandbox proxy. Pages under test don't exercise QR/ZIP/camera features,
  // so missing qrcodejs/jszip/qr-scanner globals are fine for these specs.
  await page.route(/^https:\/\/(?!.*127\.0\.0\.1).*$/, (route) => route.abort());

  for (const [url, file] of Object.entries(STUBS)) {
    const body = fs.readFileSync(path.join(__dirname, 'mocks', file), 'utf8');
    await page.route(url, (route) => route.fulfill({ contentType: 'text/javascript', body }));
  }
}

// Seeds the fake Firebase auth/Firestore state before the page's own script
// runs, so onAuthStateChanged etc. fire against this data on first load.
async function seedFakeFirebase(page, { user = null, store = {} } = {}) {
  await page.addInitScript(({ user, store }) => {
    window.__fakeFirebase = {
      auth: { user, listeners: [], nextSignInResult: null, nextSignInError: null, nextResetError: null, nextAnonUid: null },
      store,
      listeners: {},
      // Path prefixes the stub should reject with permission-denied — see the
      // firestore stub. Tests set this in an addInitScript registered after
      // seedFakeFirebase (init scripts run in registration order).
      denyPaths: [],
      denyLists: [],
    };
  }, { user, store });
}

module.exports = { stubFirebase, seedFakeFirebase };
