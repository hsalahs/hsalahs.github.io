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

  // The pages now try our own copy of qrcodejs first. It is aborted by default
  // so the older specs, which stub the CDN copy, keep their meaning; a spec
  // that wants the local file calls routeQr() afterwards.
  await page.route('**/vendor/qrcode.min.js*', (route) => route.abort());

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

const QR_LOCAL_GLOB = '**/vendor/qrcode.min.js*';
const QR_CDN_RE = /qrcodejs.*qrcode\.min\.js/;
const QR_REAL = () => fs.readFileSync(path.join(__dirname, '..', 'vendor', 'qrcode.min.js'), 'utf8');

// Controls the two places the QR library can come from. Each side takes
// 'ok' (the real file), 'abort', 'hang', '404', 'junk' (200 JS that is not the
// library), 'html' (200 with an HTML body), { body, delay } (a stand-in), or a
// route handler function. A bare function as the 2nd argument is the old
// "stub the CDN copy" form (local stays aborted). Returns live hit counters
// and setters so a spec can flip a side between attempts.
async function routeQr(page, opts = {}) {
  const o = typeof opts === 'function' ? { cdn: opts } : opts;
  const hits = { local: 0, cdn: 0 };
  const state = { local: o.local || 'abort', cdn: o.cdn || 'abort' };
  const JS = 'text/javascript';
  const run = (mode, route) => {
    if (typeof mode === 'function') return mode(route);
    if (mode === 'ok') return route.fulfill({ contentType: JS, body: QR_REAL() });
    if (mode === 'abort') return route.abort();
    if (mode === 'hang') return undefined;
    if (mode === '404') return route.fulfill({ status: 404, contentType: 'text/html', body: '<!doctype html><h1>404</h1>' });
    if (mode === 'junk') return route.fulfill({ contentType: JS, body: 'window.QRCode = {};' });
    if (mode === 'html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body>portal</body>' });
    const m = mode;
    return new Promise((r) => setTimeout(r, m.delay || 0)).then(() => route.fulfill({ contentType: JS, body: m.body }));
  };
  await page.route(QR_LOCAL_GLOB, (route) => { hits.local++; return run(state.local, route); });
  await page.route(QR_CDN_RE, (route) => { hits.cdn++; return run(state.cdn, route); });
  return { hits, setLocal: (m) => { state.local = m; }, setCdn: (m) => { state.cdn = m; } };
}

module.exports = { stubFirebase, seedFakeFirebase, routeQr };
