const { test, expect } = require('@playwright/test');
const path = require('path');
const { stubFirebase, seedFakeFirebase } = require('./helpers');

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
    const plain = window.Data.normalizeError(new Error('LIMIT_REACHED'));
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
