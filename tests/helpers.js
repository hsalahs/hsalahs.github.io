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
const blocked = new WeakSet();
async function blockExternal(page) {
  if (blocked.has(page)) return;
  blocked.add(page);
  await page.route(/^https:\/\/(?!.*127\.0\.0\.1).*$/, (route) => route.abort());
  await page.route('**/vendor/qrcode.min.js*', (route) => route.abort());
}

async function stubFirebase(page) {
  // Playwright matches routes in reverse registration order (last registered
  // wins), so the broad blocker must be registered FIRST and the specific
  // Firebase stub routes SECOND, or the blocker shadows them.
  //
  // Any other external host: fail fast instead of hanging on a blocked
  // sandbox proxy. Pages under test don't exercise QR/ZIP/camera features,
  // so missing qrcodejs/jszip/qr-scanner globals are fine for these specs.
  await blockExternal(page);

  // The pages now try our own copy of qrcodejs first. It is aborted by default
  // so the older specs, which stub the CDN copy, keep their meaning; a spec
  // that wants the local file calls routeQr() afterwards.

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

// Replaces the Supabase client (vendor/supabase.min.js) with the in-memory
// fake in tests/mocks/supabase.stub.js and gives the page a test config, so
// pages that load supabase-config.js + vendor/supabase.min.js + data.js run
// offline. Same external-host blocking as stubFirebase. Call before page.goto().
async function stubSupabase(page) {
  await blockExternal(page);
  const stub = fs.readFileSync(path.join(__dirname, 'mocks', 'supabase.stub.js'), 'utf8');
  await page.route('**/vendor/supabase.min.js*', (route) => route.fulfill({ contentType: 'text/javascript', body: stub }));
  await page.route('**/supabase-config.js*', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: "window.SUPABASE_CONFIG = { url: 'https://stub.supabase.test', anonKey: 'anon-test-key' };",
  }));
}

// Seeds the fake Supabase server before the page's own script runs. Rows use
// the database's snake_case names:
//   events:   { id: { name, type, date, venue, maps_link, theme, welcome_message, paid, guest_limit } }
//   slugs:    { slug: eventId }
//   requests: { eventId: { reqId: { status, guest_id, vip, name } } }
//   tables:   { tableName: [rows] }   (plain table reads, capped by maxRows)
// fail: { rpcName: { error: { message, code } | 'network', times } }
async function seedFakeSupabase(page, { events = {}, slugs = {}, requests = {}, tables = {}, user = null, fail = {}, latency = 0, maxRows = 1000,
  doors = {}, sessions = {}, owners = {}, admins = [], accounts = {}, limits = {}, eventRequests = [], users = [], authExtra = {} } = {}) {
  await page.addInitScript((seed) => {
    window.__fakeSupabase = Object.assign({
      calls: [],
      denyRpc: [],
      auth: Object.assign({ user: seed.user, listeners: [], accounts: seed.accounts, nextSignInError: null, nextResetError: null, nextAnonUid: null }, seed.authExtra),
    }, seed.state);
  }, { user, accounts, authExtra, state: { events, slugs, requests, tables, fail, latency, maxRows, doors, sessions, owners, admins, limits, eventRequests, users } });
}

// The door scanner's server in one call. Defaults: event e1 'حفل تجريبي', door code
// 123456, no guests. guests: [{ id, name, scanned?, vip?, scanned_at?, changed_at? }].
// session: true gives `user` a session on the current code (a device that unlocked
// before). owner / admin: the signed-in user is that event's owner / the admin.
// Plain-object options after these are passed to seedFakeSupabase.
async function seedScan(page, { event = {}, pin = '123456', guests = [], user = null, session = false, owner = false, admin = false,
  lastChange = '2026-01-01T00:00:00.000000+00:00', ...rest } = {}) {
  const ev = Object.assign({ name: 'حفل تجريبي', type: 'wedding', date: '2026-01-01', venue: 'الرياض', theme: 'gold' }, event);
  const rows = guests.map((g) => Object.assign({ scanned: false, scanned_at: null, vip: false, changed_at: '2026-01-01T00:00:00.000000+00:00' },
    g, g.scanned && !g.scanned_at ? { scanned_at: '2026-01-01T00:00:00.000000+00:00' } : {}));
  const opts = { events: { e1: ev }, doors: { e1: { pin, guests: rows, lastChange } }, user, ...rest };
  if (user && session) opts.sessions = { e1: { [user.id]: pin } };
  if (user && owner) opts.owners = { e1: user.id };
  if (user && admin) opts.admins = [user.email];
  return seedFakeSupabase(page, opts);
}

// Turns the Firebase-shaped store the invite specs were written with
// ({ events, slugs, 'events/<id>/requests' }) into a fake Supabase seed, so a
// spec reads the same: camelCase event fields become the database's columns,
// slugs become slug -> event id, requests move under their event. Extra
// options (fail, latency, user ...) are passed through to seedFakeSupabase.
async function seedInviteStore(page, { store = {}, ...rest } = {}) {
  const events = {};
  for (const [id, e] of Object.entries(store.events || {})) {
    const { mapsLink, welcomeMessage, guestLimit, ...keep } = e;
    events[id] = { ...keep };
    if (mapsLink !== undefined) events[id].maps_link = mapsLink;
    if (welcomeMessage !== undefined) events[id].welcome_message = welcomeMessage;
    if (guestLimit !== undefined) events[id].guest_limit = guestLimit;
  }
  const slugs = {};
  for (const [name, v] of Object.entries(store.slugs || {})) slugs[name] = v.eventId;
  const requests = {};
  for (const [key, docs] of Object.entries(store)) {
    const m = key.match(/^events\/([^/]+)\/requests$/);
    if (!m) continue;
    requests[m[1]] = {};
    for (const [rid, r] of Object.entries(docs)) {
      requests[m[1]][rid] = { status: r.status, guest_id: r.guestId || null, vip: !!r.vip, name: r.name };
    }
  }
  return seedFakeSupabase(page, { events, slugs, requests, ...rest });
}

// The organizer app's server (app.html). user: { id, email } (signed in, not anonymous)
// or null. events: [{ id, name, ... database columns }]: owner_uid defaults to
// the user, created_at to a falling date so the first one is the newest.
// limits: { uid: { event_limit, event_count } }; eventRequests: [{ id, uid, email, status, requested_at }];
// users: [{ uid, email, created_at }]. admin: true makes `user` the admin.
// confirmEmail / recoveryUser (a { id, email }) go to the fake auth: see supabase.stub.js.
async function seedAppStore(page, { user = null, admin = false, events = [], confirmEmail = false, recoveryUser = null, networkDown = false, accounts = {}, ...rest } = {}) {
  const evs = {};
  events.forEach((e, i) => {
    const { id, ...row } = e;
    evs[id] = Object.assign({ owner_uid: user ? user.id : null, created_at: '2026-01-' + String(28 - i).padStart(2, '0') + 'T00:00:00.000000+00:00' }, row);
  });
  const u = user ? Object.assign({ is_anonymous: false }, user) : null;
  const acc = Object.assign({}, accounts);
  if (u && !acc[u.email]) acc[u.email] = { id: u.id, password: 'secret12', confirmed: true };
  return seedFakeSupabase(page, {
    events: evs, user: u, admins: admin && u ? [u.email] : [], accounts: acc,
    authExtra: { confirmEmail, recoveryUser, networkDown }, ...rest,
  });
}

module.exports = { stubFirebase, seedFakeFirebase, routeQr, stubSupabase, seedFakeSupabase, seedInviteStore, seedScan, seedAppStore };
