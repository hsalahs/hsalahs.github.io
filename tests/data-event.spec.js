const { test, expect } = require('@playwright/test');
const path = require('path');
const { stubSupabase, seedEvent } = require('./helpers');

// The event dashboard part of data.js (Data.event, Data.guests, Data.requests, Data.door and the live
// watch), run against the fake Supabase. privacy.html is only the carrier page.
const DATA_JS = path.join(__dirname, '..', 'data.js');
const OWNER = { id: 'u1', email: 'owner@example.com' };
const ADM = { id: 'admin-uid', email: 'hsallah@outlook.sa' };
const G = (id, name, extra) => Object.assign({ id, name }, extra);

async function open(page, seed, { fake = false } = {}) {
  if (fake) await page.clock.install();
  await stubSupabase(page);
  await seedEvent(page, seed);
  await page.goto('/privacy.html');
  await page.addScriptTag({ url: '/supabase-config.js' });
  await page.addScriptTag({ url: '/vendor/supabase.min.js' });
  await page.addScriptTag({ path: DATA_JS });
}
const advance = async (page, ms) => { for (let i = 0; i < ms / 500; i++) { await page.clock.runFor(500); await page.evaluate(async () => { for (let k = 0; k < 20; k++) await Promise.resolve(); }); } };
const calls = (page, name) => page.evaluate((n) => window.__fakeSupabase.calls.filter((c) => c.name === n).length, name);
const code = (page, src) => page.evaluate(async (s) => { try { await new Function('Data', 'return (' + s + ')(Data)')(window.Data); return 'ok'; } catch (e) { return e.code; } }, src);

// ---- Data.event ----

test('Data.event.get returns the event in the page\'s field names, and null for a stranger', async ({ page }) => {
  await open(page, { user: OWNER, event: { maps_link: 'https://m.example/x', guest_limit: 50, paid: true, slug: 'my-name', slug_decided: true, welcome_message: 'اهلا' }, guests: [G('WD-1', 'a', { scanned: true }), G('WD-2', 'b')] });
  const ev = await page.evaluate(() => Data.event.get('e1'));
  expect(ev).toMatchObject({ id: 'e1', name: 'حفل تجريبي', type: 'wedding', date: '2026-01-01', venue: 'الرياض', mapsLink: 'https://m.example/x', theme: 'gold', welcomeMessage: 'اهلا',
    paid: true, guestLimit: 50, guestCount: 2, scannedCount: 1, slug: 'my-name', slugDecided: true, ownerUid: 'u1', ownerEmail: 'owner@example.com' });
  expect(ev.createdAt).toBe('2026-01-01T00:00:00.000Z');
  const other = await page.evaluate(async () => { window.__fakeSupabase.auth.user = { id: 'u9', email: 'x@y.z', is_anonymous: false }; return Data.event.get('e1'); });
  expect(other).toBeNull();
});

test('Data.event.update changes the owner fields; a stranger or a protected field is refused', async ({ page }) => {
  await open(page, { user: OWNER });
  const out = await page.evaluate(async () => {
    await Data.event.update('e1', { name: 'جديد', mapsLink: 'https://m.example/y', welcomeMessage: 'مرحبا', paid: true, bogus: 1 });
    const s = window.__fakeSupabase.events.e1;
    const row = { name: s.name, maps: s.maps_link, welcome: s.welcome_message, paid: s.paid, bogus: s.bogus };
    window.__fakeSupabase.auth.user = { id: 'u9', email: 'x@y.z', is_anonymous: false };
    const denied = await Data.event.update('e1', { name: 'x' }).then(() => 'ok', (e) => e.code);
    return { row, denied };
  });
  expect(out.row).toEqual({ name: 'جديد', maps: 'https://m.example/y', welcome: 'مرحبا', paid: false, bogus: undefined });
  expect(out.denied).toBe('permission');
});

test('Data.event.setGuestLimit: 1..2000 activates, 0 deactivates, anything else is bad-input, a customer is refused', async ({ page }) => {
  await open(page, { user: ADM, admin: true, event: { owner_uid: 'u1' } });
  const out = await page.evaluate(async () => {
    const e = () => window.__fakeSupabase.events.e1;
    await Data.event.setGuestLimit('e1', 300);
    const a = [e().paid, e().guest_limit];
    await Data.event.setGuestLimit('e1', 0);
    const b = [e().paid, e().guest_limit];
    const bad = await Promise.all([2001, -1, 1.5, null].map((n) => Data.event.setGuestLimit('e1', n).then(() => 'ok', (x) => x.code)));
    window.__fakeSupabase.auth.user = { id: 'u1', email: 'c@x.z', is_anonymous: false };
    const denied = await Data.event.setGuestLimit('e1', 10).then(() => 'ok', (x) => x.code);
    return { a, b, bad, denied };
  });
  expect(out).toEqual({ a: [true, 300], b: [false, null], bad: ['bad-input', 'bad-input', 'bad-input', 'bad-input'], denied: 'permission' });
});

test('Data.event.claimSlug / autoClaimSlug: the name held comes back; taken and invalid names map to codes', async ({ page }) => {
  await open(page, { user: OWNER, seedExtra: 1, slugs: { taken: 'other' } });
  const out = await page.evaluate(async () => {
    const auto = await Data.event.autoClaimSlug('e1', 'hafl');
    const same = await Data.event.autoClaimSlug('e1', 'hafl2');
    const claimed = await Data.event.claimSlug('e1', 'my-party');
    const taken = await Data.event.claimSlug('e1', 'taken').then(() => 'ok', (e) => e.code);
    const bad = await Data.event.claimSlug('e1', 'Bad Name!').then(() => 'ok', (e) => e.code);
    const released = await Data.event.claimSlug('e1', '');
    return { auto, same, claimed, taken, bad, released, resolves: !!window.__fakeSupabase.slugs['my-party'] };
  });
  expect(out).toEqual({ auto: 'hafl', same: 'hafl', claimed: 'my-party', taken: 'slug-taken', bad: 'bad-input', released: null, resolves: false });
});

// ---- Data.guests ----

test('Data.guests.add: names over 100 characters are cut and counted, the cap blocks all-or-nothing, partial adds what fits', async ({ page }) => {
  await open(page, { user: OWNER, guests: [G('WD-1', 'a'), G('WD-2', 'b'), G('WD-3', 'c')] });
  const out = await page.evaluate(async () => {
    const long = 'ا'.repeat(130);
    const emoji = '😀'.repeat(100);
    const r1 = await Data.guests.add('e1', [{ name: '  أحمد  ' }, { name: long, vip: true }, { name: emoji }], false);
    const names = window.__fakeSupabase.doors.e1.guests.map((g) => g.name);
    const sent = window.__fakeSupabase.calls.filter((c) => c.name === 'add_guests')[0].args.p_guests;
    // the free cap is 5 and 3 are used (the first call was blocked: nothing was added)
    const r2 = await Data.guests.add('e1', [{ name: 'x' }, { name: 'y' }, { name: 'z' }], true);
    const r3 = await Data.guests.add('e1', [{ name: 'w' }], false);
    const none = await Data.guests.add('e1', [], false);
    return { r1: [r1.added, r1.blocked, r1.trimmed, r1.ids.length], count: names.length, sent: sent.map((g) => [Array.from(g.name).length, !!g.vip]), r2: [r2.added, r2.blocked, r2.ids.length, r2.trimmed], r3: [r3.added, r3.blocked], none, final: window.__fakeSupabase.doors.e1.guests.length };
  });
  expect(out.r1).toEqual([0, true, 1, 0]);
  expect(out.count).toBe(3);   // the blocked call added nothing
  expect(out.sent).toEqual([[4, false], [100, true], [100, false]]);
  expect(out.r2).toEqual([2, true, 2, 0]);
  expect(out.r3).toEqual([0, true]);
  expect(out.final).toBe(5);
  expect(out.none).toEqual({ added: 0, blocked: false, ids: [], trimmed: 0 });
});

test('Data.guests.add on a paid event returns the new ids (WD- + 12 hex) and the trimmed count', async ({ page }) => {
  await open(page, { user: OWNER, event: { paid: true } });
  const out = await page.evaluate(async () => {
    const r = await Data.guests.add('e1', [{ name: 'ب'.repeat(101) }, { name: 'ok' }], true);
    return { r, names: window.__fakeSupabase.doors.e1.guests.map((g) => Array.from(g.name).length) };
  });
  expect(out.r.added).toBe(2);
  expect(out.r.trimmed).toBe(1);
  expect(out.r.blocked).toBe(false);
  for (const id of out.r.ids) expect(id).toMatch(/^WD-[0-9A-F]{12}$/);
  expect(out.names).toEqual([100, 2]);
});

test('Data.guests: setScanned, setVip, rename, remove, and a refused caller gets permission', async ({ page }) => {
  await open(page, { user: OWNER, guests: [G('WD-1', 'a'), G('WD-2', 'b')] });
  const out = await page.evaluate(async () => {
    const g = () => window.__fakeSupabase.doors.e1.guests;
    const a = await Data.guests.setScanned('e1', 'WD-1', true);
    const sc = g()[0].scanned;
    const b = await Data.guests.setScanned('e1', 'WD-1', false);
    const v = await Data.guests.setVip('e1', 'WD-1', true);
    const rn = await Data.guests.rename('e1', 'WD-1', '  جديد  ');
    const snap = [g()[0].vip, g()[0].name, g()[0].scanned];
    const missing = await Data.guests.rename('e1', 'WD-NO', 'x');
    const rm = await Data.guests.remove('e1', 'WD-2');
    const rm2 = await Data.guests.remove('e1', 'WD-2');
    window.__fakeSupabase.auth.user = { id: 'u9', email: 'x@y.z', is_anonymous: false };
    const denied = await Data.guests.setVip('e1', 'WD-1', false).then(() => 'ok', (e) => e.code);
    return { a, sc, b, v, rn, snap, missing, rm, rm2, denied };
  });
  expect(out).toEqual({ a: true, sc: true, b: true, v: true, rn: true, snap: [true, 'جديد', false], missing: false, rm: true, rm2: false, denied: 'permission' });
});

test('Data.guests.removeMany sends chunks of 200 and adds the counts up', async ({ page }) => {
  const guests = [];
  for (let i = 0; i < 450; i++) guests.push(G('WD-' + i, 'g' + i));
  await open(page, { user: OWNER, event: { paid: true }, guests });
  const out = await page.evaluate(async () => {
    const ids = Array.from({ length: 450 }, (_, i) => 'WD-' + i).concat(['WD-0', 'WD-NOPE']);
    const n = await Data.guests.removeMany('e1', ids);
    const sizes = window.__fakeSupabase.calls.filter((c) => c.name === 'remove_guests').map((c) => c.args.p_ids.length);
    return { n, sizes, left: window.__fakeSupabase.doors.e1.guests.length };
  });
  expect(out).toEqual({ n: 450, sizes: [200, 200, 51], left: 0 });
});

test('Data.guests.list reads every page in name order: 2300 guests, none twice', async ({ page }) => {
  const guests = [];
  for (let i = 0; i < 2300; i++) guests.push(G('WD-' + String(i).padStart(5, '0'), 'name ' + String(i % 500).padStart(4, '0')));
  await open(page, { user: OWNER, event: { paid: true }, guests });
  const out = await page.evaluate(async () => {
    const rows = await Data.guests.list('e1');
    let ordered = true;
    for (let i = 1; i < rows.length; i++) if (!(rows[i - 1].name < rows[i].name || (rows[i - 1].name === rows[i].name && rows[i - 1].id < rows[i].id))) ordered = false;
    return { n: rows.length, unique: new Set(rows.map((r) => r.id)).size, ordered, hasReg: typeof rows[0].registeredAt, pages: window.__fakeSupabase.calls.filter((c) => c.name === 'owner_guests').length };
  });
  expect(out).toEqual({ n: 2300, unique: 2300, ordered: true, hasReg: 'string', pages: 3 });
});

// ---- Data.requests ----

test('Data.requests.pending pages through 2300 requests, oldest first; rejected and approved ones are left out', async ({ page }) => {
  const requests = [];
  for (let i = 0; i < 2300; i++) requests.push({ id: 'rq' + String(i).padStart(20, '0'), name: 'r' + i, created_at: i < 40 ? '2026-01-01T00:00:00.000000+00:00' : '2026-01-02T00:00:00.' + String(i).padStart(6, '0') + '+00:00' });
  requests.push({ id: 'rejected' + 'x'.repeat(14), name: 'no', status: 'rejected' }, { id: 'approved' + 'x'.repeat(14), name: 'yes', status: 'approved' });
  await open(page, { user: OWNER, event: { paid: true }, requests });
  const out = await page.evaluate(async () => {
    const list = await Data.requests.pending('e1');
    let ordered = true;
    for (let i = 1; i < list.length; i++) if (!(list[i - 1].createdAt < list[i].createdAt || (list[i - 1].createdAt === list[i].createdAt && list[i - 1].id < list[i].id))) ordered = false;
    return { n: list.length, unique: new Set(list.map((r) => r.id)).size, ordered, first: Object.keys(list[0]).sort() };
  });
  expect(out).toEqual({ n: 2300, unique: 2300, ordered: true, first: ['createdAt', 'id', 'name', 'vip'] });
});

test('Data.requests.approve works in chunks of 25 and stops at the guest limit; reject marks a request, and approve skips it', async ({ page }) => {
  const requests = [];
  for (let i = 0; i < 60; i++) requests.push({ id: 'rq' + String(i).padStart(20, '0'), name: 'r' + i, vip: i === 1 });
  await open(page, { user: OWNER, event: { paid: true, guest_limit: 50 }, requests });
  const out = await page.evaluate(async () => {
    const id = (i) => 'rq' + String(i).padStart(20, '0');
    const rej = await Data.requests.reject('e1', id(0));
    const rejAgain = await Data.requests.reject('e1', id(0));
    const all = Array.from({ length: 60 }, (_, i) => ({ reqId: id(i), vip: i === 2 ? true : undefined }));
    const r = await Data.requests.approve('e1', all);
    const sizes = window.__fakeSupabase.calls.filter((c) => c.name === 'approve_requests').map((c) => c.args.p_items.length);
    const guests = window.__fakeSupabase.doors.e1.guests;
    const reqs = window.__fakeSupabase.requests.e1;
    return { rej, rejAgain, approved: r.approved.length, blocked: r.blocked, sizes, guests: guests.length, rejectedHasGuest: guests.some((g) => g.req_id === id(0)),
      status0: reqs[id(0)].status, vip1: guests.find((g) => g.req_id === id(1)).vip, vip2: guests.find((g) => g.req_id === id(2)).vip,
      stillPending: Object.values(reqs).filter((x) => x.status === 'pending').length };
  });
  expect(out).toEqual({ rej: true, rejAgain: false, approved: 50, blocked: true, sizes: [25, 25, 10], guests: 50, rejectedHasGuest: false, status0: 'rejected', vip1: true, vip2: true, stillPending: 9 });
});

test('a rejected request is still readable by the guest\'s own page (status rejected) and does not count toward the pending cap', async ({ page }) => {
  const requests = [{ id: 'q'.repeat(20), name: 'one' }];
  for (let i = 0; i < 49; i++) requests.push({ id: 'p' + String(i).padStart(19, '0'), name: 'p' + i });
  await open(page, { user: OWNER, requests });
  const out = await page.evaluate(async () => {
    await Data.requests.reject('e1', 'q'.repeat(20));
    const seen = await Data.invite.getRequest('e1', 'q'.repeat(20));
    await Data.invite.submitRequest('e1', 'n'.repeat(20), 'fiftieth');
    const full = await Data.invite.submitRequest('e1', 'm'.repeat(20), 'fifty-first').then(() => 'ok', (e) => e.code);
    return { status: seen.status, full };
  });
  expect(out).toEqual({ status: 'rejected', full: 'requests-full' });
});

// ---- Data.door ----

test('Data.door: code reads the secret (owner only), regenerate gives a new 6-digit code and cuts the old sessions', async ({ page }) => {
  await open(page, { user: OWNER, pin: '012345' });
  const out = await page.evaluate(async () => {
    const before = await Data.door.code('e1');
    const fresh = await Data.door.regenerate('e1');
    const after = await Data.door.code('e1');
    window.__fakeSupabase.auth.user = { id: 'u9', email: 'x@y.z', is_anonymous: false };
    const stranger = await Data.door.code('e1');
    const denied = await Data.door.regenerate('e1').then(() => 'ok', (e) => e.code);
    return { before, shape: /^[0-9]{6}$/.test(fresh), same: fresh === after, stranger, denied };
  });
  expect(out).toEqual({ before: '012345', shape: true, same: true, stranger: null, denied: 'permission' });
});

test('Data.door.alert and reopen use the owner functions and map the numbers', async ({ page }) => {
  await open(page, { user: OWNER });
  const out = await page.evaluate(async () => {
    window.__fakeSupabase.doors.e1.alert = { failed_last_hour: 12, failed_last_day: 40, door_locked: false };
    const a = await Data.door.alert('e1');
    await Data.door.reopen('e1');
    const b = await Data.door.alert('e1');
    return { a, b };
  });
  expect(out.a).toEqual({ failedLastHour: 12, failedLastDay: 40, doorLocked: false });
  expect(out.b).toEqual({ failedLastHour: 0, failedLastDay: 0, doorLocked: false });
});

test('error mapping: not-yours is permission, the cap error maps to cap-reached, an oversize batch is bad-input, offline stays offline', async ({ page }) => {
  await open(page, { user: OWNER, guests: [G('WD-1', 'a')] });
  const out = await page.evaluate(async () => {
    const map = {};
    window.__fakeSupabase.fail = { add_guests: { error: { message: 'GUEST_LIMIT_REACHED', code: 'P0001' } } };
    map.cap = await Data.guests.add('e1', [{ name: 'x' }], false).then(() => 'ok', (e) => e.code);
    window.__fakeSupabase.fail = { remove_guests: { error: { message: 'BATCH_TOO_LARGE', code: '22023' } }, owner_requests: { error: 'network' } };
    map.big = await Data.guests.removeMany('e1', ['WD-1']).then(() => 'ok', (e) => e.code);
    map.offline = await Data.requests.pending('e1').then(() => 'ok', (e) => e.code);
    window.__fakeSupabase.fail = {};
    window.__fakeSupabase.auth.user = { id: 'u9', email: 'x@y.z', is_anonymous: false };
    map.perm = await Data.guests.list('e1').then(() => 'ok', (e) => e.code);
    map.permLive = await Data.client().rpc('event_live', { p_event_id: 'e1' }).then((r) => r.error && Data.normalizeError(r.error).code);
    return map;
  });
  expect(out).toEqual({ cap: 'cap-reached', big: 'bad-input', offline: 'offline', perm: 'permission', permLive: 'permission' });
});

// ---- Data.event.watch ----

async function watch(page, extra) {
  await page.evaluate((x) => {
    window.__log = { live: [], guests: [], requests: [], errors: [] };
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => !!window.__hidden });
    window.__w = Data.event.watch('e1', Object.assign({
      onLive: (l) => window.__log.live.push(l), onGuests: (g) => window.__log.guests.push(g),
      onRequests: (r) => window.__log.requests.push(r), onError: (e) => window.__log.errors.push(e.code),
    }, x || {}));
  }, extra);
}
const log = (page) => page.evaluate(() => window.__log);

test('watch: the first poll reads the live row, the full list and the pending requests', async ({ page }) => {
  await open(page, { user: OWNER, guests: [G('WD-2', 'b'), G('WD-1', 'a', { scanned: true })], requests: [{ id: 'q'.repeat(20), name: 'r' }] }, { fake: true });
  await watch(page);
  await advance(page, 500);
  const l = await log(page);
  expect(l.live.length).toBe(1);
  expect(l.live[0]).toMatchObject({ guestCount: 2, scannedCount: 1, pendingCount: 1, paid: false, guestLimit: null });
  expect(l.guests.length).toBe(1);
  expect(l.guests[0].full).toBe(true);
  expect(l.guests[0].rows.map((r) => r.id)).toEqual(['WD-1', 'WD-2']);
  expect(l.requests[0].map((r) => r.name)).toEqual(['r']);
});

test('watch: an idle poll makes no owner_guests and no owner_requests call', async ({ page }) => {
  await open(page, { user: OWNER, guests: [G('WD-1', 'a')], requests: [{ id: 'q'.repeat(20), name: 'r' }] }, { fake: true });
  await watch(page);
  await advance(page, 500);
  const g0 = await calls(page, 'owner_guests'), r0 = await calls(page, 'owner_requests'), l0 = await calls(page, 'event_live');
  await advance(page, 60000);
  expect(await calls(page, 'event_live')).toBeGreaterThanOrEqual(l0 + 9);
  expect(await calls(page, 'owner_guests')).toBe(g0);
  expect(await calls(page, 'owner_requests')).toBe(r0);
  expect((await log(page)).guests.length).toBe(1);
});

test('watch: a change elsewhere is read as a delta and merged by id (a check-in, a rename, a new guest)', async ({ page }) => {
  await open(page, { user: OWNER, event: { paid: true }, guests: [G('WD-1', 'a'), G('WD-2', 'b')] }, { fake: true });
  await watch(page);
  await advance(page, 500);
  await page.evaluate(() => { __srv.checkIn('e1', 'WD-1'); __srv.rename('e1', 'WD-2', 'bb'); __srv.addGuest('e1', { id: 'WD-3', name: 'c', registered_at: __srv.stamp() }); });
  await advance(page, 6000);
  const l = await log(page);
  expect(l.guests.length).toBe(2);
  expect(l.guests[1].full).toBe(false);
  expect(l.guests[1].rows.map((r) => [r.id, r.name, r.scanned])).toEqual([['WD-1', 'a', true], ['WD-2', 'bb', false], ['WD-3', 'c', false]]);
  expect(l.live[l.live.length - 1]).toMatchObject({ guestCount: 3, scannedCount: 1 });
  expect(await calls(page, 'owner_guests')).toBe(2);
  const since = await page.evaluate(() => window.__fakeSupabase.calls.filter((c) => c.name === 'owner_guests')[1].args.p_since);
  expect(since).not.toBeNull();
  // applying the same delta twice changes nothing
  await page.evaluate(() => __srv.rename('e1', 'WD-2', 'bb'));
  await advance(page, 6000);
  const l2 = await log(page);
  expect(l2.guests[l2.guests.length - 1].rows.length).toBe(3);
});

test('watch: a guest deleted elsewhere (a delta cannot show it) triggers ONE full read, and at most one per 15 s', async ({ page }) => {
  await open(page, { user: OWNER, event: { paid: true }, guests: [G('WD-1', 'a'), G('WD-2', 'b'), G('WD-3', 'c')] }, { fake: true });
  await watch(page);
  await advance(page, 500);
  const fullCalls = () => page.evaluate(() => window.__fakeSupabase.calls.filter((c) => c.name === 'owner_guests' && c.args.p_since == null).length);
  expect(await fullCalls()).toBe(1);
  await page.evaluate(() => __srv.removeGuest('e1', 'WD-2'));
  await advance(page, 6000);
  expect(await fullCalls()).toBe(2);
  const l = await log(page);
  expect(l.guests[l.guests.length - 1].rows.map((r) => r.id)).toEqual(['WD-1', 'WD-3']);
  // a second delete 5 s later: the ghost read is throttled, so it waits for the 15 s gap
  await page.evaluate(() => __srv.removeGuest('e1', 'WD-3'));
  await advance(page, 6000);
  expect(await fullCalls()).toBe(2);
  await page.evaluate(() => __srv.rename('e1', 'WD-1', 'a2'));
  await advance(page, 12000);
  expect(await fullCalls()).toBe(3);
  const l2 = await log(page);
  expect(l2.guests[l2.guests.length - 1].rows.map((r) => r.id)).toEqual(['WD-1']);
});

test('watch: a full read every 5 minutes even when nothing moved', async ({ page }) => {
  await open(page, { user: OWNER, guests: [G('WD-1', 'a')] }, { fake: true });
  await watch(page);
  await advance(page, 500);
  await advance(page, 4 * 60000);
  expect(await page.evaluate(() => window.__fakeSupabase.calls.filter((c) => c.name === 'owner_guests').length)).toBe(1);
  await advance(page, 70000);
  expect(await page.evaluate(() => window.__fakeSupabase.calls.filter((c) => c.name === 'owner_guests').length)).toBe(2);
});

test('watch: the requests are read again only when the pending count or the newest time changed', async ({ page }) => {
  await open(page, { user: OWNER, requests: [{ id: 'q'.repeat(20), name: 'r1' }] }, { fake: true });
  await watch(page);
  await advance(page, 500);
  expect(await calls(page, 'owner_requests')).toBe(1);
  await page.evaluate(() => Data.invite.submitRequest('e1', 'n'.repeat(20), 'r2'));
  await advance(page, 6000);
  expect(await calls(page, 'owner_requests')).toBe(2);
  const l = await log(page);
  expect(l.requests[1].map((r) => r.name)).toEqual(['r1', 'r2']);
  expect(l.live[l.live.length - 1].pendingCount).toBe(2);
  await page.evaluate(() => Data.requests.reject('e1', 'n'.repeat(20)));
  await advance(page, 6000);
  expect(await calls(page, 'owner_requests')).toBe(3);
  expect((await log(page)).requests[2].map((r) => r.name)).toEqual(['r1']);
});

test('watch: a poll that started before a write is thrown away and run again', async ({ page }) => {
  await open(page, { user: OWNER, guests: [G('WD-1', 'a')] }, { fake: true });
  await page.evaluate(() => { window.__fakeSupabase.holdRpc = { event_live: true }; });
  await watch(page);
  await advance(page, 500);
  expect(await page.evaluate(() => window.__fakeSupabase.held.length)).toBe(1);
  // the owner removes the guest while the first poll waits for its answer
  await page.evaluate(() => { window.__fakeSupabase.holdRpc = {}; return Data.guests.remove('e1', 'WD-1'); });
  await page.evaluate(() => window.__fakeSupabase.held.shift()('ok'));
  await advance(page, 500);
  const l = await log(page);
  expect(await calls(page, 'event_live')).toBe(2);
  expect(l.live.length).toBe(1);
  expect(l.live[0].guestCount).toBe(0);
  expect(l.guests[0].rows).toEqual([]);
});

test('watch: nothing is called while the page is hidden; it runs at once when visible; stop() ends it', async ({ page }) => {
  await open(page, { user: OWNER, guests: [G('WD-1', 'a')] }, { fake: true });
  await watch(page);
  await advance(page, 500);
  const hide = (h) => page.evaluate((x) => { window.__hidden = x; document.dispatchEvent(new Event('visibilitychange')); }, h);
  await hide(true);
  const n0 = await calls(page, 'event_live');
  await advance(page, 60000);
  expect(await calls(page, 'event_live')).toBe(n0);
  await hide(false);
  await advance(page, 500);
  expect(await calls(page, 'event_live')).toBe(n0 + 1);
  await page.evaluate(() => window.__w.stop());
  await advance(page, 60000);
  expect(await calls(page, 'event_live')).toBe(n0 + 1);
});

test('watch: a failed poll reports onError and backs off; the next success carries on; a gone event reports null', async ({ page }) => {
  await open(page, { user: OWNER, guests: [G('WD-1', 'a')] }, { fake: true });
  await page.evaluate(() => { window.__fakeSupabase.fail = { event_live: { error: 'network', times: 1 } }; });
  await watch(page);
  await advance(page, 500);
  expect((await log(page)).errors).toEqual(['offline']);
  await advance(page, 12000);
  expect((await log(page)).live.length).toBeGreaterThanOrEqual(1);
  await page.evaluate(() => { delete window.__fakeSupabase.events.e1; });
  await advance(page, 6000);
  const l = await log(page);
  expect(l.live[l.live.length - 1]).toBeNull();
});

test('makePoller: hiddenIntervalMs keeps a slower poll going while hidden; without it nothing changes', async ({ page }) => {
  await open(page, { user: OWNER }, { fake: true });
  await page.evaluate(() => {
    window.__a = 0; window.__b = 0; window.__hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
    window.__pa = Data.makePoller(() => { window.__a++; return Promise.resolve(); }, 5000, { hiddenIntervalMs: 30000 });
    window.__pb = Data.makePoller(() => { window.__b++; return Promise.resolve(); }, 5000);
    window.__pa.start(); window.__pb.start();
  });
  await advance(page, 500);
  await page.evaluate(() => { window.__hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
  const base = await page.evaluate(() => [window.__a, window.__b]);
  await advance(page, 120000);
  const after = await page.evaluate(() => [window.__a, window.__b]);
  expect(after[1]).toBe(base[1]);
  expect(after[0] - base[0]).toBeGreaterThanOrEqual(3);
  expect(after[0] - base[0]).toBeLessThanOrEqual(5);
});
