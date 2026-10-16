const { test, expect } = require('@playwright/test');
const { stubSupabase, seedAppStore } = require('./helpers');

// The organizer-side part of data.js (events, account, admin, sign-up, reset
// and the recovery link), run against the fake Supabase. app.html is the
// carrier; its own signed-out screen does nothing that interferes.
const CUST = { id: 'u1', email: 'customer@example.com' };
const ADM = { id: 'admin-uid', email: 'hsallah@outlook.sa' };

async function open(page, seed) {
  await stubSupabase(page);
  await seedAppStore(page, seed);
  await page.goto('/app.html');
  await page.locator('#auth-view, #app-view').first().waitFor({ state: 'attached' });
}
const code = (page, fn, arg) => page.evaluate(async ([src, a]) => {
  try { await new Function('Data', 'a', 'return (' + src + ')(Data, a)')(window.Data, a); return 'ok'; } catch (e) { return e.code; }
}, [fn.toString(), arg]);

test('Data.events.list reads every page: 1203 events, newest first, none twice, tied created_at included', async ({ page }) => {
  const events = [];
  for (let i = 0; i < 1203; i++) events.push({ id: 'ev' + String(i).padStart(5, '0'), name: 'n' + i, created_at: i < 30 ? '2026-01-01T00:00:00.000000+00:00' : '2026-01-02T00:00:00.' + String(i).padStart(6, '0') + '+00:00' });
  await open(page, { user: CUST, events, limits: { u1: { event_limit: 3, event_count: 3 } } });
  const out = await page.evaluate(async () => {
    const list = await Data.events.list();
    const ids = list.map((e) => e.id);
    let ordered = true;
    for (let i = 1; i < list.length; i++) if (!(list[i - 1].createdAt > list[i].createdAt || (list[i - 1].createdAt === list[i].createdAt && list[i - 1].id > list[i].id))) ordered = false;
    const calls = window.__fakeSupabase.calls.filter((c) => c.name === 'list_events' && c.args.p_limit === 1000).length;
    return { n: list.length, unique: new Set(ids).size, ordered, pagedCalls: calls };
  });
  expect(out.n).toBe(1203);
  expect(out.unique).toBe(1203);
  expect(out.ordered).toBe(true);
  expect(out.pagedCalls).toBeGreaterThanOrEqual(2);
});

test('Data.events.list gives the page its field names: camelCase, no nulls it cannot read, ISO times', async ({ page }) => {
  await open(page, { user: CUST, events: [{ id: 'e1', name: 'حفل', maps_link: 'https://m.example/x', guest_limit: 50, paid: true, guest_count: 3, scanned_count: 1 }], limits: { u1: { event_limit: 1, event_count: 1 } } });
  const ev = await page.evaluate(async () => (await Data.events.list())[0]);
  expect(ev).toMatchObject({ id: 'e1', name: 'حفل', mapsLink: 'https://m.example/x', guestLimit: 50, paid: true, guestCount: 3, scannedCount: 1, slug: '', ownerUid: 'u1' });
  expect(ev.createdAt).toBe('2026-01-28T00:00:00.000Z');
  const none = await page.evaluate(async () => { window.__fakeSupabase.events.e1.guest_limit = null; return (await Data.events.list())[0].guestLimit; });
  expect(none).toBeNull();
});

test('Data.events.create / remove: the server id comes back, limits map to codes, a bad name is bad-input', async ({ page }) => {
  await open(page, { user: CUST, events: [] });
  const r = await page.evaluate(async () => {
    const blank = await Data.events.create({ name: '   ' }).then(() => 'ok', (e) => e.code);
    const id = await Data.events.create({ name: ' حفل ', type: 'wedding', date: '2026-10-29', venue: 'الرياض', mapsLink: '', theme: 'gold' });
    const row = window.__fakeSupabase.events[id];
    const second = await Data.events.create({ name: 'ثاني' }).then(() => 'ok', (e) => e.code);
    await Data.events.remove(id);
    return { idLen: id.length > 3, name: row.name, theme: row.theme, second, blank, gone: !window.__fakeSupabase.events[id] };
  });
  expect(r).toEqual({ idLen: true, name: 'حفل', theme: 'gold', second: 'limit-reached', blank: 'bad-input', gone: true });
});

test('Data.events: an anonymous door identity and a stranger are refused', async ({ page }) => {
  await open(page, { user: null });
  await page.evaluate(() => Data.auth.signInAnon());
  expect(await code(page, (D) => D.events.list())).toBe('permission');
  expect(await code(page, (D) => D.events.create({ name: 'x' }))).toBe('permission');
  expect(await code(page, (D) => D.account.get())).toBe('permission');
  expect(await code(page, (D) => D.account.requestExtraEvent())).toBe('permission');
});

test('Data.account: defaults, the self-serve bump up to the ceiling, and an idempotent request', async ({ page }) => {
  await open(page, { user: CUST, events: [], limits: { u1: { event_limit: 1, event_count: 1 } } });
  const r = await page.evaluate(async () => {
    const a0 = await Data.account.get();
    const b1 = await Data.account.bumpLimit();
    const b2 = await Data.account.bumpLimit();
    const b3 = await Data.account.bumpLimit().then(() => 'ok', (e) => e.code);
    const q1 = await Data.account.requestExtraEvent();
    const q2 = await Data.account.requestExtraEvent();
    const a1 = await Data.account.get();
    return { a0, b1, b2, b3, same: q1.id === q2.id, c1: q1.created, c2: q2.created, pending: a1.pendingRequest === q1.id, rows: window.__fakeSupabase.eventRequests.length };
  });
  expect(r).toEqual({ a0: { eventLimit: 1, eventCount: 1, pendingRequest: null }, b1: 2, b2: 3, b3: 'ceiling-reached', same: true, c1: true, c2: false, pending: true, rows: 1 });
});

test('Data.admin: requests, approve / reject twice, activate, accounts paged, remove record; a customer is refused everywhere', async ({ page }) => {
  const users = [];
  for (let i = 0; i < 1100; i++) users.push({ uid: 'u' + String(i).padStart(5, '0'), email: 'm' + i + '@x.com', created_at: '2026-01-01T00:00:' + String(i % 60).padStart(2, '0') + '.' + String(i).padStart(6, '0') + '+00:00' });
  await open(page, {
    user: ADM, admin: true, users, events: [{ id: 'e1', name: 'E', owner_uid: 'u1' }],
    eventRequests: [
      { id: 'r1', uid: 'u1', email: 'a@x.com', status: 'pending', requested_at: '2026-01-01T00:00:00.000000+00:00' },
      { id: 'r2', uid: 'u2', email: 'b@x.com', status: 'pending', requested_at: '2026-01-02T00:00:00.000000+00:00' },
    ],
  });
  const r = await page.evaluate(async () => {
    const reqs = await Data.admin.requests();
    await Data.admin.approveRequest('r1');
    const again = await Data.admin.approveRequest('r1').then(() => 'ok', (e) => e.code);
    await Data.admin.rejectRequest('r2');
    const again2 = await Data.admin.rejectRequest('r2').then(() => 'ok', (e) => e.code);
    const missing = await Data.admin.rejectRequest('nope').then(() => 'ok', (e) => e.code);
    await Data.admin.activateEvent('e1', 120);
    const bad = await Data.admin.activateEvent('e1', -5).then(() => 'ok', (e) => e.code);
    const nf = await Data.admin.activateEvent('zz', 5).then(() => 'ok', (e) => e.code);
    const count = await Data.admin.accountsCount();
    const accounts = await Data.admin.accounts();
    const removed = await Data.admin.removeAccountRecord('u00005');
    const removedAgain = await Data.admin.removeAccountRecord('u00005');
    const ev = window.__fakeSupabase.events.e1;
    return {
      reqs: reqs.map((x) => x.id + ':' + x.email), again, again2, missing, paid: ev.paid + '/' + ev.guest_limit, bad, nf, count,
      n: accounts.length, unique: new Set(accounts.map((a) => a.uid)).size, removed, removedAgain, limit: window.__fakeSupabase.limits.u1.event_limit,
    };
  });
  expect(r).toEqual({ reqs: ['r1:a@x.com', 'r2:b@x.com'], again: 'already-handled', again2: 'already-handled', missing: 'not-found', paid: 'true/120', bad: 'bad-input', nf: 'not-found', count: 1100, n: 1100, unique: 1100, removed: true, removedAgain: false, limit: 2 });
});

test('Data.admin refuses a customer on every call', async ({ page }) => {
  await open(page, { user: CUST, events: [] });
  const out = await page.evaluate(async () => {
    const names = ['requests', 'accountsCount', 'accounts'];
    const res = {};
    for (const n of names) res[n] = await Data.admin[n]().then(() => 'ok', (e) => e.code);
    for (const [n, args] of [['approveRequest', ['r1']], ['rejectRequest', ['r1']], ['activateEvent', ['e1', 5]], ['removeAccountRecord', ['u2']]]) {
      res[n] = await Data.admin[n](...args).then(() => 'ok', (e) => e.code);
    }
    return res;
  });
  for (const v of Object.values(out)) expect(v).toBe('permission');
});

test('normalizeError: a check violation is bad-input, same_password and an expired link have their own codes', async ({ page }) => {
  await open(page, { user: null });
  const out = await page.evaluate(() => {
    const n = (o) => Data.normalizeError(o).code;
    return {
      check: n({ message: 'new row violates check constraint', code: '23514' }), range: n({ message: 'x', code: '22023' }),
      same: n({ code: 'same_password', message: 'x' }), exp: n({ code: 'otp_expired', message: 'x' }),
    };
  });
  expect(out).toEqual({ check: 'bad-input', range: 'bad-input', same: 'same-password', exp: 'link-expired' });
});

test('Data.auth.signUp: confirmed or waiting for the e-mail, an existing address, a weak password', async ({ page }) => {
  await open(page, { user: null, accounts: { 'taken@x.com': { id: 'u8', password: 'secret12', confirmed: true } } });
  const run = (mail, pw) => page.evaluate(([m, p]) => Data.auth.signUp(m, p, 'https://da3wt.com/app.html').then((r) => ({ confirmed: r.confirmed, email: r.user.email }), (e) => ({ code: e.code })), [mail, pw]);
  expect(await run('new@x.com', 'secret12')).toEqual({ confirmed: true, email: 'new@x.com' });
  await page.evaluate(() => Data.auth.signOut());
  expect(await run('taken@x.com', 'secret12')).toEqual({ code: 'email-in-use' });
  expect(await run('weak@x.com', '123')).toEqual({ code: 'weak-password' });
  await page.evaluate(() => { window.__fakeSupabase.auth.confirmEmail = true; });
  expect(await run('later@x.com', 'secret12')).toEqual({ confirmed: false, email: 'later@x.com' });
  expect(await run('taken@x.com', 'secret12')).toEqual({ code: 'email-in-use' });
  expect(await page.evaluate(() => window.__fakeSupabase.auth.signUpCalls.map((c) => c.redirectTo).every((u) => u === 'https://da3wt.com/app.html'))).toBe(true);
  expect(await page.evaluate(() => Data.auth.current())).toBeNull();
});

test('Data.auth.resetPassword sends the redirect, updatePassword maps weak, same and missing-session errors', async ({ page }) => {
  await open(page, { user: CUST, events: [] });
  const r = await page.evaluate(async () => {
    await Data.auth.resetPassword('a@x.com', 'https://da3wt.com/app.html');
    const sent = window.__fakeSupabase.auth.resetCalls[0];
    const weak = await Data.auth.updatePassword('123').then(() => 'ok', (e) => e.code);
    const same = await Data.auth.updatePassword('secret12').then(() => 'ok', (e) => e.code);
    await Data.auth.updatePassword('another-one');
    await Data.auth.signOut();
    const none = await Data.auth.updatePassword('another-two').then(() => 'ok', (e) => e.code);
    return { sent, weak, same, none, saved: window.__fakeSupabase.auth.accounts['customer@example.com'].password };
  });
  expect(r).toEqual({ sent: { email: 'a@x.com', redirectTo: 'https://da3wt.com/app.html' }, weak: 'weak-password', same: 'same-password', none: 'no-session', saved: 'another-one' });
});

const RECOVERY = { id: 'u5', email: 'known@example.com' };
async function link(page, url, seedExtra = {}) {
  await open(page, { user: null, recoveryUser: RECOVERY, accounts: { 'known@example.com': { id: 'u5', password: 'old-secret' } }, ...seedExtra });
  await page.evaluate((u) => history.replaceState(null, '', u), url);
  return page.evaluate(async () => {
    const r = await Data.auth.recoveryFromUrl();
    return { r, url: location.pathname + location.search + location.hash };
  });
}

test('recoveryFromUrl: not a recovery link leaves the page alone', async ({ page }) => {
  for (const u of ['/app.html', '/app.html#section', '/app.html?x=1', '/app.html#access_token=a&refresh_token=b&type=magiclink']) {
    const out = await link(page, u);
    expect(out.r).toBeNull();
    expect(out.url).toBe(u);
  }
});

test('recoveryFromUrl: tokens in the hash open the session, are cleared from the address, other query parameters stay', async ({ page }) => {
  const out = await link(page, '/app.html?keep=1#access_token=good-access&refresh_token=r&expires_in=3600&type=recovery');
  expect(out.r).toEqual({ user: { uid: 'u5', email: 'known@example.com', isAnonymous: false }, kind: 'recovery' });
  expect(out.url).toBe('/app.html?keep=1');
  expect(await page.evaluate(() => window.__fakeSupabase.auth.user.email)).toBe('known@example.com');
});

test('recoveryFromUrl: token_hash in the query works and is cleared', async ({ page }) => {
  const out = await link(page, '/app.html?token_hash=good-hash&type=recovery');
  expect(out.r.kind).toBe('recovery');
  expect(out.url).toBe('/app.html');
  expect(await page.evaluate(() => window.__fakeSupabase.auth.verifyCalls)).toEqual(['recovery']);
});

test('recoveryFromUrl: a signup confirmation link opens the session with kind signup', async ({ page }) => {
  const out = await link(page, '/app.html#access_token=good-access&refresh_token=r&type=signup');
  expect(out.r.kind).toBe('signup');
  expect(out.url).toBe('/app.html');
});

test('recoveryFromUrl: dead tokens, an error hash and a missing refresh token are link-expired; no network is offline', async ({ page }) => {
  for (const u of ['/app.html#access_token=dead&refresh_token=r&type=recovery', '/app.html#error=access_denied&error_code=otp_expired&type=recovery', '/app.html?token_hash=dead&type=recovery', '/app.html#access_token=good-access&type=recovery']) {
    const out = await link(page, u);
    expect(out.r).toEqual({ error: 'link-expired' });
    expect(out.url).toBe('/app.html');
    expect(await page.evaluate(() => window.__fakeSupabase.auth.user)).toBeNull();
  }
  const off = await link(page, '/app.html#access_token=good-access&refresh_token=r&type=recovery', { networkDown: true });
  expect(off.r).toEqual({ error: 'offline' });
});

test('recoveryFromUrl never logs the tokens', async ({ page }) => {
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await link(page, '/app.html#access_token=good-access&refresh_token=secret-refresh&type=recovery');
  await link(page, '/app.html#access_token=dead-access&refresh_token=secret-refresh2&type=recovery');
  expect(logs.join('\n')).not.toMatch(/good-access|secret-refresh|dead-access/);
});
