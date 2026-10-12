const { test, expect } = require('@playwright/test');
const path = require('path');
const { stubFirebase, seedFakeFirebase, stubSupabase, seedFakeSupabase } = require('./helpers');

const DATA_JS = path.join(__dirname, '..', 'data.js');

// data.js is not loaded by any page yet, so it is injected into an existing one.
async function open(page) {
  await stubFirebase(page);
  await seedFakeFirebase(page);
  await page.goto('/app.html');
  await page.addScriptTag({ path: DATA_JS });
}

test('Data is defined and loading it before Firebase is ready does not throw', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/firebase-init.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.goto('/app.html');
  await page.addScriptTag({ path: DATA_JS });
  const shape = await page.evaluate(() => ({
    db: typeof window._db, data: typeof window.Data, ready: typeof window.Data.ready,
    norm: window.Data.normalizeError(new Error('GATE')).code,
  }));
  expect(shape).toEqual({ db: 'undefined', data: 'object', ready: 'function', norm: 'cap-reached' });
  expect(errors).toEqual([]);
});

test('normalizeError maps the known Firestore, Auth and sentinel codes', async ({ page }) => {
  await open(page);
  const out = await page.evaluate(() => {
    const n = (o) => window.Data.normalizeError(o).code;
    const withCode = (code) => Object.assign(new Error('x'), { code });
    return {
      perm: n(withCode('permission-denied')), unav: n(withCode('unavailable')),
      dead: n(withCode('deadline-exceeded')), nf: n(withCode('not-found')),
      ic: n(withCode('auth/invalid-credential')), wp: n(withCode('auth/wrong-password')),
      unf: n(withCode('auth/user-not-found')), ie: n(withCode('auth/invalid-email')),
      eiu: n(withCode('auth/email-already-in-use')), weak: n(withCode('auth/weak-password')),
      net: n(withCode('auth/network-request-failed')),
      gate: n(new Error('GATE')), already: n(new Error('ALREADY')), slug: n(new Error('SLUG_TAKEN')),
      term: n(new Error('Firestore client has already been terminated.')),
    };
  });
  expect(out).toEqual({
    perm: 'permission', unav: 'offline', dead: 'timeout', nf: 'not-found',
    ic: 'invalid-credential', wp: 'invalid-credential', unf: 'invalid-credential', ie: 'invalid-email',
    eiu: 'email-in-use', weak: 'weak-password', net: 'offline',
    gate: 'cap-reached', already: 'already-handled', slug: 'slug-taken', term: 'terminated',
  });
});

test('unknown codes pass through unchanged and keep message and cause', async ({ page }) => {
  await open(page);
  const out = await page.evaluate(() => {
    const orig = Object.assign(new Error('boom'), { code: 'resource-exhausted' });
    const d = window.Data.normalizeError(orig);
    const plain = window.Data.normalizeError(new Error('something odd'));
    const again = window.Data.normalizeError(d);
    return {
      code: d.code, msg: d.message, cause: d.cause === orig, isErr: d instanceof Error,
      isDataErr: d instanceof window.Data.DataError, plain: plain.code, same: again === d,
      nul: window.Data.normalizeError(null).code,
    };
  });
  expect(out).toEqual({ code: 'resource-exhausted', msg: 'boom', cause: true, isErr: true, isDataErr: true, plain: 'unknown', same: true, nul: 'unknown' });
});

test('Data.ready resolves after the Firebase bootstrap', async ({ page }) => {
  await open(page);
  const out = await page.evaluate(async () => {
    await window.Data.ready();
    return typeof window._db;
  });
  expect(out).toBe('object');
});

test('Data.ready waits for appDbReady when Firebase is not up yet', async ({ page }) => {
  await open(page);
  const out = await page.evaluate(async () => {
    const saved = window._auth;
    window._auth = undefined;
    let done = false;
    const p = window.Data.ready().then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 50));
    const before = done;
    window._auth = saved;
    window.dispatchEvent(new Event('appDbReady'));
    await p;
    return { before, after: done };
  });
  expect(out).toEqual({ before: false, after: true });
});

test('platform.leave uses _leave when present, otherwise navigates; leaving() and isTerminated follow the page', async ({ page }) => {
  await open(page);
  const out = await page.evaluate(async () => {
    const calls = [];
    const saved = window._leave;
    window._leave = (u) => { calls.push(u); };
    window.Data.platform.leave('app.html?x=1');
    window._leave = saved;
    window._leaving = true;
    const on = window.Data.platform.leaving();
    window._leaving = false;
    return {
      calls, on, off: window.Data.platform.leaving(),
      t: window.Data.platform.isTerminated(new Error('already been terminated')),
      f: window.Data.platform.isTerminated(new Error('nope')),
    };
  });
  expect(out).toEqual({ calls: ['app.html?x=1'], on: true, off: false, t: true, f: false });

  await page.evaluate(() => { window._leave = undefined; });
  await Promise.all([
    page.waitForURL(/\/index\.html|\/$/),
    page.evaluate(() => window.Data.platform.leave('index.html')),
  ]);
});

// ---- Supabase side ----------------------------------------------------------

// A static page with data.js on it and the fake Supabase client (or, with
// real: true, the vendored one) behind window.supabase.
async function openSb(page, { real = false, seed = {} } = {}) {
  if (!real) {
    await stubSupabase(page);
    await seedFakeSupabase(page, seed);
  }
  await page.goto('/privacy.html');
  if (real) {
    await page.evaluate(() => { window.SUPABASE_CONFIG = { url: 'https://sb.example.test', anonKey: 'anon-key-for-test' }; });
    await page.addScriptTag({ path: path.join(__dirname, '..', 'vendor', 'supabase.min.js') });
  } else {
    await page.addScriptTag({ url: '/supabase-config.js' });
    await page.addScriptTag({ url: '/vendor/supabase.min.js' });
  }
  await page.addScriptTag({ path: DATA_JS });
}

test('normalizeError maps the SQL error names, Postgres codes and Auth codes of the Supabase side', async ({ page }) => {
  await openSb(page);
  const out = await page.evaluate(() => {
    const n = (o) => window.Data.normalizeError(o).code;
    return {
      cap: n({ message: 'GUEST_LIMIT_REACHED', code: 'P0001' }),
      limit: n({ message: 'LIMIT_REACHED', code: 'P0001' }),
      ceiling: n({ message: 'CEILING_REACHED', code: 'P0001' }),
      full: n({ message: 'REQUESTS_FULL', code: 'P0001' }),
      slug: n({ message: 'SLUG_TAKEN', code: 'P0001' }),
      nosession: n({ message: 'NO_SESSION', code: '42501' }),
      notAllowed: n({ message: 'NOT_ALLOWED', code: '42501' }),
      rls: n({ message: 'new row violates row-level security policy', code: '42501' }),
      dup: n({ message: 'duplicate key', code: '23505' }),
      single: n({ message: 'JSON object requested', code: 'PGRST116' }),
      evNf: n({ message: 'EVENT_NOT_FOUND', code: 'P0002' }),
      reqNf: n({ message: 'REQUEST_NOT_FOUND', code: 'P0002' }),
      userNf: n({ message: 'USER_NOT_FOUND', code: 'P0002' }),
      badName: n({ message: 'BAD_NAME', code: '22023' }),
      badInput: n({ message: 'BAD_INPUT', code: '22023' }),
      badReq: n({ message: 'BAD_REQUEST_ID', code: '22023' }),
      badSlug: n({ message: 'BAD_SLUG', code: '22023' }),
      batch: n({ message: 'BATCH_TOO_LARGE', code: '22023' }),
      notPending: n({ message: 'NOT_PENDING', code: 'P0001' }),
      noDelAdmin: n({ message: 'CANNOT_DELETE_ADMIN', code: 'P0001' }),
      cred: n({ code: 'invalid_credentials', message: 'Invalid login credentials', status: 400 }),
      credMsg: n({ message: 'Invalid login credentials' }),
      exists: n({ code: 'email_exists', message: 'x', status: 422 }),
      userExists: n({ code: 'user_already_exists', message: 'x', status: 422 }),
      weak: n({ code: 'weak_password', message: 'x', status: 422 }),
      unconfirmed: n({ code: 'email_not_confirmed', message: 'x', status: 400 }),
      rate: n({ code: 'over_request_rate_limit', message: 'x', status: 429 }),
      mailRate: n({ code: 'over_email_send_rate_limit', message: 'x', status: 429 }),
      status429: n({ message: 'slow down', status: 429 }),
      badEmail: n({ code: 'email_address_invalid', message: 'x', status: 400 }),
      jwt: n({ message: 'JWT expired', code: 'PGRST301' }),
      noAuthSession: n({ message: 'Auth session missing!', name: 'AuthSessionMissingError' }),
      offline: n({ message: 'TypeError: Failed to fetch', code: '' }),
      authFetch: n({ name: 'AuthRetryableFetchError', message: 'x', status: 0 }),
      timeout: n({ message: 'DATA_TIMEOUT' }),
      unknown: n({ message: 'weird', code: 'XX000' }),
      notAWord: n({ message: 'SOME_BAD_NAME_HERE' }),
    };
  });
  expect(out).toEqual({
    cap: 'cap-reached', limit: 'limit-reached', ceiling: 'ceiling-reached', full: 'requests-full', slug: 'slug-taken',
    nosession: 'no-session', notAllowed: 'permission', rls: 'permission', dup: '23505', single: 'not-found',
    evNf: 'not-found', reqNf: 'not-found', userNf: 'not-found',
    badName: 'bad-input', badInput: 'bad-input', badReq: 'bad-input', badSlug: 'bad-input', batch: 'bad-input',
    notPending: 'already-handled', noDelAdmin: 'cannot-delete-admin',
    cred: 'invalid-credential', credMsg: 'invalid-credential', exists: 'email-in-use', userExists: 'email-in-use',
    weak: 'weak-password', unconfirmed: 'email-not-confirmed', rate: 'rate-limited', mailRate: 'rate-limited',
    status429: 'rate-limited', badEmail: 'invalid-email', jwt: 'no-session', noAuthSession: 'no-session',
    offline: 'offline', authFetch: 'offline', timeout: 'timeout', unknown: 'XX000', notAWord: 'unknown',
  });
});

test('camel() renames keys deeply and leaves values alone; iso() normalises timestamps', async ({ page }) => {
  await openSb(page);
  const out = await page.evaluate(() => {
    const { camel, iso } = window.Data;
    return {
      row: camel({ maps_link: 'a_b', welcome_message: null, guest_id: 'WD-1', nested: { door_pin_2: 1 }, list: [{ changed_at: 'x' }] }),
      arr: camel([{ a_b: 1 }]), str: camel('snake_case'), nul: camel(null), date: camel(new Date(0)) instanceof Date,
      a: iso('2026-10-12 10:00:00+03:00'), b: iso('2026-10-12T07:00:00.000Z'), c: iso(null), d: iso('nonsense'), e: iso(''),
    };
  });
  expect(out).toEqual({
    row: { mapsLink: 'a_b', welcomeMessage: null, guestId: 'WD-1', nested: { doorPin2: 1 }, list: [{ changedAt: 'x' }] },
    arr: [{ aB: 1 }], str: 'snake_case', nul: null, date: true,
    a: '2026-10-12T07:00:00.000Z', b: '2026-10-12T07:00:00.000Z', c: '', d: '', e: '',
  });
});

test('the client is created once with persisted sessions, our storage, no navigator lock and the timed fetch', async ({ page }) => {
  await openSb(page);
  const out = await page.evaluate(async () => {
    const c1 = window.Data.client(); const c2 = window.Data.client();
    const a = window.__fakeSupabase.createArgs;
    const o = a[0].opts;
    const lockResult = await o.auth.lock('x', 1000, async () => 42);
    o.auth.storage.setItem('k', 'v');
    return {
      same: c1 === c2, count: a.length, url: a[0].url, key: a[0].key,
      persist: o.auth.persistSession, refresh: o.auth.autoRefreshToken, inUrl: o.auth.detectSessionInUrl,
      lockResult, fetchIsOurs: o.global.fetch === window.Data.timedFetch,
      stored: o.auth.storage.getItem('k'), real: localStorage.getItem('k'),
    };
  });
  expect(out).toEqual({
    same: true, count: 1, url: 'https://stub.supabase.test', key: 'anon-test-key',
    persist: true, refresh: true, inUrl: false, lockResult: 42, fetchIsOurs: true, stored: 'v', real: 'v',
  });
});

test('the session storage falls back to memory when localStorage throws', async ({ page }) => {
  await stubSupabase(page);
  await seedFakeSupabase(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('SecurityError'); } });
  });
  await page.goto('/privacy.html');
  await page.addScriptTag({ url: '/supabase-config.js' });
  await page.addScriptTag({ url: '/vendor/supabase.min.js' });
  await page.addScriptTag({ path: DATA_JS });
  const out = await page.evaluate(() => {
    window.Data.client();
    const st = window.__fakeSupabase.createArgs[0].opts.auth.storage;
    const before = st.getItem('sb');
    st.setItem('sb', 'token');
    const mid = st.getItem('sb');
    st.removeItem('sb');
    return { before, mid, after: st.getItem('sb') };
  });
  expect(out).toEqual({ before: null, mid: 'token', after: null });
});

test('a missing client or config surfaces as a DataError instead of a TypeError', async ({ page }) => {
  await page.goto('/privacy.html');
  await page.addScriptTag({ path: DATA_JS });
  const out = await page.evaluate(async () => {
    try { await window.Data.invite.event('e1'); return 'no error'; } catch (e) { return [e instanceof window.Data.DataError, e.code]; }
  });
  expect(out).toEqual([true, 'offline']);
});

test('Data.ready resolves at once when the Supabase config and client are present', async ({ page }) => {
  await openSb(page);
  const out = await page.evaluate(async () => { await window.Data.ready(); return 'ok'; });
  expect(out).toBe('ok');
});

test('Data.invite: resolveSlug, event, submitRequest and getRequest talk to the right functions and shape their answers', async ({ page }) => {
  await openSb(page, { seed: {
    events: { e1: { name: 'حفل', type: 'event', date: '2026-10-29', venue: 'الرياض', maps_link: 'https://m.example/x', theme: 'emerald', welcome_message: 'أهلا', paid: true, guest_limit: 100 } },
    slugs: { 'hala-turki': 'e1' },
  } });
  const out = await page.evaluate(async () => {
    const I = window.Data.invite;
    const rid = 'REQ-' + 'A'.repeat(32);
    const r = {};
    r.slug = await I.resolveSlug('hala-turki');
    r.noSlug = await I.resolveSlug('nothing');
    r.event = await I.event('e1');
    r.noEvent = await I.event('nope');
    r.before = await I.getRequest('e1', rid);
    await I.submitRequest('e1', rid, '  سارة  ');
    r.after = await I.getRequest('e1', rid);
    await I.submitRequest('e1', rid, 'سارة');
    r.pendingCount = Object.keys(window.__fakeSupabase.requests.e1).length;
    r.errs = {};
    for (const [k, args] of Object.entries({ badId: ['e1', 'short', 'x'], badName: ['e1', rid + 'B', '   '], noEvent: ['zzz', rid + 'C', 'x'] })) {
      try { await I.submitRequest(...args); r.errs[k] = 'none'; } catch (e) { r.errs[k] = e.code; }
    }
    r.leaked = JSON.stringify(r.event);
    return r;
  });
  expect(out.slug).toBe('e1');
  expect(out.noSlug).toBeNull();
  expect(out.event).toEqual({ name: 'حفل', type: 'event', date: '2026-10-29', venue: 'الرياض', mapsLink: 'https://m.example/x', theme: 'emerald', welcomeMessage: 'أهلا' });
  expect(out.noEvent).toBeNull();
  expect(out.before).toBeNull();
  expect(out.after).toEqual({ status: 'pending', guestId: null, vip: false, name: 'سارة' });
  expect(out.pendingCount).toBe(1);                 // the same id twice is one request
  expect(out.errs).toEqual({ badId: 'bad-input', badName: 'bad-input', noEvent: 'not-found' });
  expect(out.leaked).not.toMatch(/paid|guest_limit|guestLimit|owner/);
});

test('the fake server refuses a request once pending ones reach max(limit, 50), and caps table reads at 1000 rows', async ({ page }) => {
  const rows = Array.from({ length: 1500 }, (_, i) => ({ id: i }));
  await openSb(page, { seed: { events: { e1: { name: 'x', date: 'd' } }, tables: { guests: rows } } });
  const out = await page.evaluate(async () => {
    const I = window.Data.invite;
    for (let i = 0; i < 50; i++) await I.submitRequest('e1', 'REQ-' + String(i).padStart(20, '0'), 'ض' + i);
    let full = null;
    try { await I.submitRequest('e1', 'REQ-' + 'Z'.repeat(20), 'one more'); } catch (e) { full = e.code; }
    const c = window.Data.client();
    const a = await c.from('guests').select('*');
    const b = await c.from('guests').select('*').range(1000, 1999);
    return { full, first: a.data.length, second: b.data.length };
  });
  expect(out).toEqual({ full: 'requests-full', first: 1000, second: 500 });
});

test('watchRequest polls every 12 s, also after approval, reports each answer, and stops when the request is gone', async ({ page }) => {
  await page.clock.install();
  const rid = 'REQ-' + 'B'.repeat(32);
  await openSb(page, { seed: { events: { e1: { name: 'x', date: 'd' } }, requests: { e1: { [rid]: { status: 'pending', guest_id: null, vip: false, name: 'سارة' } } } } });
  await page.evaluate((rid) => {
    window.__seen = [];
    window.__w = window.Data.invite.watchRequest('e1', rid, { onChange: (r) => window.__seen.push(r && r.status), onError: () => window.__seen.push('err') });
  }, rid);
  const calls = () => page.evaluate(() => window.__fakeSupabase.calls.filter((c) => c.name === 'get_request').length);
  await expect.poll(calls).toBe(1);
  await page.clock.fastForward(10000);
  expect(await calls()).toBe(1);                     // not before ~10.8 s
  await page.clock.fastForward(3500);
  await expect.poll(calls).toBe(2);
  await page.evaluate((rid) => { Object.assign(window.__fakeSupabase.requests.e1[rid], { status: 'approved', guest_id: 'WD-1' }); }, rid);
  await page.clock.fastForward(13500);
  await expect.poll(calls).toBe(3);
  await page.clock.fastForward(13500);
  await expect.poll(calls).toBe(4);                  // still polling after approval
  await page.evaluate((rid) => { delete window.__fakeSupabase.requests.e1[rid]; }, rid);
  await page.clock.fastForward(13500);
  await expect.poll(calls).toBe(5);
  await page.clock.fastForward(120000);
  await page.waitForTimeout(100);
  expect(await calls()).toBe(5);                     // gone: stopped
  expect(await page.evaluate(() => window.__seen)).toEqual(['pending', 'pending', 'approved', 'approved', null]);
});

test('watchRequest.stop() ends it, and an answer that arrives after stop() is ignored', async ({ page }) => {
  await page.clock.install();
  const rid = 'REQ-' + 'C'.repeat(32);
  await openSb(page, { seed: { events: { e1: { name: 'x', date: 'd' } }, requests: { e1: { [rid]: { status: 'pending', guest_id: null, vip: false, name: 'س' } } }, latency: 500 } });
  await page.evaluate((rid) => {
    window.__seen = 0;
    window.__w = window.Data.invite.watchRequest('e1', rid, { onChange: () => { window.__seen++; } });
    window.__w.stop();
  }, rid);
  await page.clock.fastForward(60000);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__seen)).toBe(0);
  expect(await page.evaluate(() => window.__fakeSupabase.calls.filter((c) => c.name === 'get_request').length)).toBeLessThanOrEqual(1);
});

// ---- the poller, on a fake clock ----

async function poller(page) {
  await page.clock.install();
  await openSb(page);
  await page.evaluate(() => {
    window.__t = [];
    window.__mode = 'ok';
    window.__pending = null;
    window.__hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
    window.__p = window.Data.makePoller(() => {
      window.__t.push(Date.now());
      if (window.__mode === 'fail') return Promise.reject(new Error('x'));
      if (window.__mode === 'hang') return new Promise((r) => { window.__pending = r; });
      return Promise.resolve();
    }, 10000);
  });
}
const times = (page) => page.evaluate(() => window.__t);
const advance = async (page, ms) => { for (let i = 0; i < ms / 500; i++) { await page.clock.runFor(500); await page.evaluate(() => 0); } };

test('poller: first run at once, then every interval with up to 10% jitter either way', async ({ page }) => {
  await poller(page);
  await page.evaluate(() => window.__p.start());
  await advance(page, 200000);
  const t = await times(page);
  expect(t.length).toBeGreaterThanOrEqual(18);
  const gaps = t.slice(1).map((v, i) => v - t[i]);
  for (const g of gaps) { expect(g).toBeGreaterThanOrEqual(8900); expect(g).toBeLessThanOrEqual(11600); }
  expect(new Set(gaps).size).toBeGreaterThan(3);      // really jittered
});

test('poller: one request at a time — a slow answer is never overlapped', async ({ page }) => {
  await poller(page);
  await page.evaluate(() => { window.__mode = 'hang'; window.__p.start(); });
  await advance(page, 60000);
  expect((await times(page)).length).toBe(1);
  await page.evaluate(() => { window.__mode = 'ok'; window.__pending(); });
  await advance(page, 12000);
  expect((await times(page)).length).toBe(2);
});

test('poller: failures double the wait up to 60 s, and the first success returns to the interval', async ({ page }) => {
  await poller(page);
  await page.evaluate(() => { window.__mode = 'fail'; window.__p.start(); });
  await advance(page, 300000);
  const t = await times(page);
  const gaps = t.slice(1).map((v, i) => v - t[i]);
  const near = (g, base) => g >= base * 0.89 && g <= base * 1.11 + 600;
  expect(near(gaps[0], 20000)).toBe(true);
  expect(near(gaps[1], 40000)).toBe(true);
  expect(near(gaps[2], 60000)).toBe(true);
  expect(near(gaps[3], 60000)).toBe(true);
  await page.evaluate(() => { window.__mode = 'ok'; });
  await advance(page, 70000);
  const t2 = await times(page);
  const g2 = t2.slice(1).map((v, i) => v - t2[i]);
  expect(near(g2[g2.length - 1], 10000)).toBe(true);
});

test('poller: paused while hidden, runs at once when visible, focused or restored from the back-forward cache', async ({ page }) => {
  await poller(page);
  await page.evaluate(() => window.__p.start());
  await advance(page, 1000);
  const hide = (h) => page.evaluate((hidden) => { window.__hidden = hidden; document.dispatchEvent(new Event('visibilitychange')); }, h);
  await hide(true);
  const n0 = (await times(page)).length;
  await advance(page, 120000);
  expect((await times(page)).length).toBe(n0);
  await hide(false);
  await advance(page, 500);
  expect((await times(page)).length).toBe(n0 + 1);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await advance(page, 500);
  expect((await times(page)).length).toBe(n0 + 2);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await advance(page, 60000);
  expect((await times(page)).length).toBe(n0 + 2);
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await advance(page, 500);
  expect((await times(page)).length).toBe(n0 + 3);
});

test('poller: stop() ends it for good, even on focus; start() again works', async ({ page }) => {
  await poller(page);
  await page.evaluate(() => window.__p.start());
  await advance(page, 500);
  await page.evaluate(() => window.__p.stop());
  const n = (await times(page)).length;
  await advance(page, 60000);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pageshow')); });
  await advance(page, 60000);
  expect((await times(page)).length).toBe(n);
  await page.evaluate(() => window.__p.start());
  await advance(page, 500);
  expect((await times(page)).length).toBe(n + 1);
});

// ---- timeouts ----

test('the timed fetch gives up after 15 s (8 s for check_in) with DATA_TIMEOUT, which maps to «timeout»', async ({ page }) => {
  await page.clock.install();
  await page.route('**/hang/**', () => {});
  await openSb(page);
  await page.evaluate(() => {
    window.__r = {};
    const run = (key, url) => window.Data.timedFetch(url).then(() => { window.__r[key] = 'ok'; }, (e) => { window.__r[key] = window.Data.normalizeError(e).code + '|' + e.message; });
    run('normal', '/hang/rest/v1/rpc/get_request');
    run('checkin', '/hang/rest/v1/rpc/check_in');
  });
  await advance(page, 7000);
  expect(await page.evaluate(() => window.__r)).toEqual({});
  await advance(page, 1500);
  expect(await page.evaluate(() => window.__r)).toEqual({ checkin: 'timeout|DATA_TIMEOUT' });
  await advance(page, 6000);
  expect(await page.evaluate(() => window.__r)).toEqual({ checkin: 'timeout|DATA_TIMEOUT' });
  await advance(page, 1500);
  expect(await page.evaluate(() => window.__r)).toEqual({ checkin: 'timeout|DATA_TIMEOUT', normal: 'timeout|DATA_TIMEOUT' });
});

test('the timed fetch passes a fast answer through, and turns a network failure into «offline»', async ({ page }) => {
  await page.route('**/fast/**', (r) => r.fulfill({ contentType: 'application/json', body: '{"a":1}' }));
  await page.route('**/dead/**', (r) => r.abort());
  await openSb(page);
  const out = await page.evaluate(async () => {
    const ok = await window.Data.timedFetch('/fast/x').then((r) => r.json());
    let off = null;
    try { await window.Data.timedFetch('/dead/x'); } catch (e) { off = window.Data.normalizeError(e).code; }
    const ctl = new AbortController();
    const p = window.Data.timedFetch('/fast/x', { signal: ctl.signal });
    ctl.abort();
    let aborted = null;
    try { await p; aborted = 'resolved'; } catch (e) { aborted = e.name; }
    return { ok, off, aborted };
  });
  expect(out.ok).toEqual({ a: 1 });
  expect(out.off).toBe('offline');
  expect(['AbortError', 'resolved']).toContain(out.aborted);
});

// ---- the real vendored client ----

test('the vendored supabase.min.js is the real client: createClient works, and a call goes out through our fetch with the key', async ({ page }) => {
  const seen = [];
  await page.route('https://sb.example.test/**', async (route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (req.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return; }
    seen.push({ url: req.url(), key: req.headers()['apikey'], auth: req.headers()['authorization'] });
    const u = req.url();
    if (u.includes('/rpc/resolve_slug')) await route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: '"e1"' });
    else if (u.includes('/rpc/event_public')) await route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify([{ name: 'حفل', type: null, date: '2026-10-29', venue: 'x', maps_link: null, theme: 'gold', welcome_message: 'م' }]) });
    else if (u.includes('/rpc/submit_request')) await route.fulfill({ status: 400, headers: cors, contentType: 'application/json', body: '{"code":"22023","message":"BAD_NAME","details":null,"hint":null}' });
    else if (u.includes('/rpc/get_request')) await route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: '[{"status":"approved","guest_id":"WD-1","vip":true,"name":"س"}]' });
    else await route.fulfill({ status: 404, headers: cors, contentType: 'application/json', body: '{"code":"PGRST202","message":"nope"}' });
  });
  await openSb(page, { real: true });
  const out = await page.evaluate(async () => {
    const I = window.Data.invite;
    const r = {};
    r.type = typeof window.supabase.createClient;
    r.client = typeof window.Data.client().rpc;
    r.slug = await I.resolveSlug('x');
    r.event = await I.event('e1');
    r.req = await I.getRequest('e1', 'REQ-' + 'A'.repeat(32));
    try { await I.submitRequest('e1', 'REQ-' + 'A'.repeat(32), 'x'); r.err = 'none'; } catch (e) { r.err = e.code; }
    return r;
  });
  expect(out).toEqual({
    type: 'function', client: 'function', slug: 'e1',
    event: { name: 'حفل', type: null, date: '2026-10-29', venue: 'x', mapsLink: null, theme: 'gold', welcomeMessage: 'م' },
    req: { status: 'approved', guestId: 'WD-1', vip: true, name: 'س' },
    err: 'bad-input',
  });
  expect(seen.length).toBe(4);
  for (const s of seen) { expect(s.key).toBe('anon-key-for-test'); expect(s.url).toContain('/rest/v1/rpc/'); }
  expect(seen.some((s) => /\/auth\/v1\//.test(s.url))).toBe(false);
});

test('the vendored supabase.min.js is the pinned file: version string, size and hash', async () => {
  const fs = require('fs'); const crypto = require('crypto');
  const buf = fs.readFileSync(path.join(__dirname, '..', 'vendor', 'supabase.min.js'));
  expect(buf.length).toBe(217945);
  expect(buf.toString('utf8')).toContain('2.117.2');
  expect(crypto.createHash('sha256').update(buf).digest('hex')).toBe('59d39487c3589843b410322d8a3d562ce022aba1e5ccb16898ef3fb2a0da2ecd');
  expect(fs.readFileSync(path.join(__dirname, '..', 'vendor', 'supabase.LICENSE.txt'), 'utf8')).toContain('MIT License');
});

test('supabase-config.js holds only a public key: empty, sb_publishable_..., or a JWT whose role is anon', async () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'supabase-config.js'), 'utf8');
  const cfg = {};
  new Function('window', src)(cfg);
  const key = cfg.SUPABASE_CONFIG.anonKey;
  expect(cfg.SUPABASE_CONFIG.url).toBe('https://gunizkapwatixvbfliva.supabase.co');
  if (key === '') return;
  if (key.startsWith('sb_publishable_')) return;
  const parts = key.split('.');
  expect(parts.length).toBe(3);
  const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  expect(payload.role).toBe('anon');
});

test('the timed fetch still works and times out when AbortController is missing, and says «unsupported» without fetch', async ({ page }) => {
  await page.clock.install();
  await page.route('**/hang/**', () => {});
  await page.route('**/fast/**', (r) => r.fulfill({ contentType: 'application/json', body: '{"a":1}' }));
  await openSb(page);
  await page.evaluate(() => {
    window.AbortController = undefined;
    window.__r = {};
    window.Data.timedFetch('/fast/x').then((r) => r.json()).then((j) => { window.__r.fast = j; });
    window.Data.timedFetch('/hang/x').catch((e) => { window.__r.hang = window.Data.normalizeError(e).code; });
  });
  await advance(page, 1000);
  expect(await page.evaluate(() => window.__r)).toEqual({ fast: { a: 1 } });
  await advance(page, 15000);
  expect(await page.evaluate(() => window.__r)).toEqual({ fast: { a: 1 }, hang: 'timeout' });
  const code = await page.evaluate(async () => {
    window.fetch = undefined;
    try { await window.Data.timedFetch('/x'); return 'none'; } catch (e) { return window.Data.normalizeError(e).code; }
  });
  expect(code).toBe('unsupported');
});

// ---- Data.scan / Data.auth (the door scanner) ----
const DOOR_SEED = {
  events: { e1: { name: 'x' } },
  doors: { e1: { pin: '123456', guests: [{ id: 'WD-A', name: 'أ', scanned: false, scanned_at: null, vip: false, changed_at: '2026-01-01T00:00:00.000000+00:00' }], lastChange: '2026-01-01T00:00:00.000000+00:00' } },
  sessions: { e1: { 'anon-1': '123456' } },
  user: { id: 'anon-1', is_anonymous: true, email: null },
};

test('Data.scan.start returns ok / wrong / locked and nothing else', async ({ page }) => {
  await openSb(page, { seed: { ...DOOR_SEED, sessions: {}, user: { id: 'anon-2', is_anonymous: true, email: null } } });
  const out = await page.evaluate(async () => {
    const wrong = await Data.scan.start('e1', '000000');
    const ok = await Data.scan.start('e1', '123456');
    window.__fakeSupabase.doors.e1.attempts = { 'anon-2': 10 };
    const locked = await Data.scan.start('e1', '123456');
    return { wrong, ok, locked };
  });
  expect(out).toEqual({ wrong: 'wrong', ok: 'ok', locked: 'locked' });
});

test('Data.scan.checkIn returns the outcome in the page\'s shape and is never repeated by the layer', async ({ page }) => {
  await openSb(page, { seed: DOOR_SEED });
  const out = await page.evaluate(async () => {
    const a = await Data.scan.checkIn('e1', 'WD-A');
    const b = await Data.scan.checkIn('e1', 'WD-A');
    const c = await Data.scan.checkIn('e1', 'WD-NOPE');
    window.__fakeSupabase.fail = { check_in: { error: 'network' } };
    let err = null;
    try { await Data.scan.checkIn('e1', 'WD-A'); } catch (e) { err = e.code; }
    return { a: [a.outcome, a.guestName, a.vip, a.scannedCount, typeof a.scannedAt], b: b.outcome, c: [c.outcome, c.guestName], err, calls: window.__fakeSupabase.calls.filter((x) => x.name === 'check_in').length };
  });
  expect(out).toEqual({ a: ['allowed', 'أ', false, 1, 'string'], b: 'duplicate', c: ['not_found', ''], err: 'offline', calls: 4 });
});

test('Data.scan.event returns name, counts and lastChange; a refused caller gets no-session', async ({ page }) => {
  await openSb(page, { seed: DOOR_SEED });
  const out = await page.evaluate(async () => {
    const ev = await Data.scan.event('e1');
    window.__fakeSupabase.sessions.e1 = {};
    let code = null;
    try { await Data.scan.event('e1'); } catch (e) { code = e.code; }
    return { ev, code };
  });
  expect(out.ev).toEqual({ name: 'x', guestCount: 1, scannedCount: 0, lastChange: '2026-01-01T00:00:00.000000+00:00' });
  expect(out.code).toBe('no-session');
});

test('Data.scan.guests merges by id and the same answer applied twice is the same list', async ({ page }) => {
  await openSb(page, { seed: DOOR_SEED });
  const out = await page.evaluate(async () => {
    const r1 = await Data.scan.guests('e1', null);
    const r2 = await Data.scan.guests('e1', null);
    return { n1: r1.rows.length, same: JSON.stringify(r1.rows) === JSON.stringify(r2.rows), cursor: r1.cursor, full: r1.full };
  });
  expect(out).toEqual({ n1: 1, same: true, cursor: '2025-12-31T23:59:00.000Z', full: true });
});

test('two door calls that hit a dead sign-in at the same moment heal it once (one anonymous sign-in)', async ({ page }) => {
  await openSb(page, { seed: { ...DOOR_SEED, user: { id: 'gone', is_anonymous: true, email: null } } });
  const out = await page.evaluate(async () => {
    const jwt = { message: 'JWT expired', code: 'PGRST301', status: 401 };
    window.__fakeSupabase.auth.refreshFails = true;
    window.__fakeSupabase.fail = { door_event: { error: jwt, times: 1 }, scan_session_valid: { error: jwt, times: 1 } };
    const codes = await Promise.all([Data.scan.event('e1').catch((e) => e.code), Data.scan.valid('e1').catch((e) => e.code)]);
    return { codes, anon: window.__fakeSupabase.auth.anonCalls };
  });
  expect(out).toEqual({ codes: ['auth-lost', 'auth-lost'], anon: 1 });
});

for (const code of ['user_not_found', 'invalid_grant']) {
  test(`a refresh that fails with ${code} means a dead sign-in: the identity is replaced (never stuck offline)`, async ({ page }) => {
    await openSb(page, { seed: { ...DOOR_SEED, user: { id: 'gone', is_anonymous: true, email: null } } });
    const out = await page.evaluate(async (c) => {
      const jwt = { message: 'JWT expired', code: 'PGRST301', status: 401 };
      window.__fakeSupabase.auth.refreshFailCode = c;
      window.__fakeSupabase.fail = { door_event: { error: jwt, times: 1 } };
      const code = await Data.scan.event('e1').catch((e) => e.code);
      return { code, anon: window.__fakeSupabase.auth.anonCalls };
    }, code);
    expect(out).toEqual({ code: 'auth-lost', anon: 1 });
  });
}

test('Data.auth: current, onChange, signInAnon, signInWithPassword, isAdmin, signOut', async ({ page }) => {
  await openSb(page, { seed: { admins: ['a@x.com'], accounts: { 'a@x.com': { id: 'adm', password: 'pw' } } } });
  const out = await page.evaluate(async () => {
    const seen = [];
    const off = Data.auth.onChange((u, ev) => seen.push([ev, u && u.uid]));
    const before = await Data.auth.current();
    const anon = await Data.auth.signInAnon();
    const adminBefore = await Data.auth.isAdmin();
    const adm = await Data.auth.signInWithPassword('a@x.com', 'pw');
    const adminAfter = await Data.auth.isAdmin();
    await Data.auth.signOut();
    const after = await Data.auth.current();
    let bad = null;
    try { await Data.auth.signInWithPassword('a@x.com', 'nope'); } catch (e) { bad = e.code; }
    off();
    return { before, anon: anon.isAnonymous, adminBefore, adm: [adm.uid, adm.isAnonymous], adminAfter, after, bad, events: seen.map((s) => s[0]) };
  });
  expect(out.before).toBeNull();
  expect(out.anon).toBe(true);
  expect(out.adminBefore).toBe(false);
  expect(out.adm).toEqual(['adm', false]);
  expect(out.adminAfter).toBe(true);
  expect(out.after).toBeNull();
  expect(out.bad).toBe('invalid-credential');
  expect(out.events).toEqual(expect.arrayContaining(['SIGNED_IN', 'SIGNED_OUT']));
});

test('normalizeError: PGRST303 (JWT claims) is a lost sign-in like PGRST301', async ({ page }) => {
  await openSb(page);
  const code = await page.evaluate(() => Data.normalizeError({ message: 'JWT cryptographic operation failed', code: 'PGRST303' }).code);
  expect(code).toBe('no-session');
});

test('Data.scan.guests with since set pages a delta of more than 1000 rows without gaps or duplicates', async ({ page }) => {
  const many = Array.from({ length: 2300 }, (_, i) => ({ id: 'WD-' + String(i).padStart(5, '0'), name: 'n' + i, scanned: false, scanned_at: null, vip: false, changed_at: '2026-03-01T10:' + String(Math.floor(i / 60)).padStart(2, '0') + ':' + String(i % 60).padStart(2, '0') + '.000000+00:00' }));
  await openSb(page, { seed: { ...DOOR_SEED, doors: { e1: { pin: '123456', guests: many, lastChange: 'x' } } } });
  const out = await page.evaluate(async () => {
    const r = await Data.scan.guests('e1', '2026-03-01T09:00:00.000Z');
    const pages = window.__fakeSupabase.calls.filter((c) => c.name === 'door_guests');
    return { n: r.rows.length, u: new Set(r.rows.map((x) => x.id)).size, pages: pages.length, second: pages[1].args };
  });
  expect(out.n).toBe(2300);
  expect(out.u).toBe(2300);
  expect(out.pages).toBe(3);
  expect(out.second.p_after_id).toBe('WD-00999');
  expect(out.second.p_since).toMatch(/^2026-03-01T10:16:39/);
});

test('poller: after a long backoff, returning from hidden runs at once and a success returns to the base interval', async ({ page }) => {
  await poller(page);
  await page.evaluate(() => { window.__mode = 'fail'; window.__p.start(); });
  await advance(page, 300000);
  const hide = (h) => page.evaluate((hidden) => { window.__hidden = hidden; document.dispatchEvent(new Event('visibilitychange')); }, h);
  await hide(true);
  const n0 = (await times(page)).length;
  await advance(page, 200000);
  expect((await times(page)).length).toBe(n0);
  await page.evaluate(() => { window.__mode = 'ok'; });
  await hide(false);
  await advance(page, 500);
  expect((await times(page)).length).toBe(n0 + 1);
  await advance(page, 12000);
  expect((await times(page)).length).toBe(n0 + 2);
});
