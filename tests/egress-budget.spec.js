const { test, expect } = require('@playwright/test');
const path = require('path');
const { stubSupabase, seedEvent } = require('./helpers');

// EGRESS BUDGET (free Supabase plan: 5 GB a month). Response-body bytes of the simulated server over ONE simulated
// hour with 2000 guests, on a fake clock: the dashboard idle with a few changes, one scanner phone in a busy
// check-in rush, and the guest's invite page polling its request. Body bytes only (JSON of the rows), no headers.
const DATA_JS = path.join(__dirname, '..', 'data.js');
const OWNER = { id: 'u1', email: 'owner@example.com' };
const DEVICE = { id: 'anon-1', is_anonymous: true, email: null };
const N = 2000;
const MB = 1024 * 1024;

function guests(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: 'WD-' + (0x9F3A0C7D1E5B + i * 7919).toString(16).toUpperCase().padStart(12, '0'), name: 'ضيف رقم ' + String(i).padStart(4, '0') + ' العتيبي',
      changed_at: '2026-01-01T10:00:00.123456+00:00', registered_at: '2026-01-01T09:00:00.123456+00:00' });
  }
  return out;
}

async function open(page, seed) {
  await page.clock.install();
  await stubSupabase(page);
  await seedEvent(page, seed);
  await page.goto('/privacy.html');
  await page.addScriptTag({ url: '/supabase-config.js' });
  await page.addScriptTag({ url: '/vendor/supabase.min.js' });
  await page.addScriptTag({ path: DATA_JS });
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); });
}
// one simulated hour in 2 s steps; `each(second)` runs every step
async function hour(page, each) {
  for (let t = 0; t < 3600; t += 2) {
    if (each) await each(t);
    await page.clock.runFor(2000);
    await page.evaluate(async () => { for (let k = 0; k < 30; k++) await Promise.resolve(); });
  }
}
const bytes = (page) => page.evaluate(() => ({ total: window.__fakeSupabase.bytes || 0, by: window.__fakeSupabase.bytesBy || {} }));
const report = (label, b) => {
  const parts = Object.entries(b.by).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, v]) => k + ' ' + (v / 1024).toFixed(0) + ' KB').join(', ');
  console.log(`EGRESS ${label}: ${(b.total / MB).toFixed(2)} MB per hour (${parts})`);
};

test.setTimeout(300000);

test('egress: a full list of 2000 guests is about the measured size (calibration of the simulated bodies)', async ({ page }) => {
  await open(page, { user: OWNER, event: { paid: true }, guests: guests(N) });
  const out = await page.evaluate(async () => {
    await Data.guests.list('e1');
    const owner = window.__fakeSupabase.bytesBy.owner_guests;
    await Data.client().rpc('event_live', { p_event_id: 'e1' });
    return { owner, live: window.__fakeSupabase.bytesBy.event_live };
  });
  console.log(`EGRESS calibration: owner list ${(out.owner / 1024).toFixed(0)} KB, event_live ${out.live} B`);
  expect(out.owner).toBeGreaterThan(300 * 1024);
  expect(out.owner).toBeLessThan(600 * 1024);
  expect(out.live).toBeLessThan(400);
});

test('egress: the dashboard open for an hour with 2000 guests and a few changes stays under 3 MB', async ({ page }) => {
  await open(page, { user: OWNER, event: { paid: true }, guests: guests(N) });
  await page.evaluate(() => { window.__w = Data.event.watch('e1', {}); });
  await hour(page, async (t) => {
    // a few changes from other devices during the hour
    if (t % 600 === 300) await page.evaluate((i) => { const g = window.__srv.door('e1').guests[i]; window.__srv.checkIn('e1', g.id); }, t / 10);
    if (t === 1200) await page.evaluate(() => window.__srv.rename('e1', window.__srv.door('e1').guests[5].id, 'اسم معدل'));
    if (t === 2400) await page.evaluate(() => window.__srv.removeGuest('e1', window.__srv.door('e1').guests[9].id));
    if (t === 3000) await page.evaluate(() => Data.invite.submitRequest('e1', 'n'.repeat(20), 'طلب جديد'));
  });
  const b = await bytes(page);
  report('dashboard (idle + 9 changes)', b);
  const fulls = await page.evaluate(() => window.__fakeSupabase.calls.filter((c) => c.name === 'owner_guests' && c.args.p_since == null && c.args.p_after_id == null).length);
  expect(fulls).toBe(1);
  expect(b.total).toBeLessThan(3 * MB);
});

test('egress: one scanner phone in a rush of 600 check-ins in an hour stays under 6 MB', async ({ page }) => {
  await open(page, { user: DEVICE, event: { paid: true, owner_uid: 'someone-else' }, guests: guests(N), sessions: { e1: { 'anon-1': '123456' } } });
  const ids = await page.evaluate(() => window.__srv.door('e1').guests.map((g) => g.id));
  await page.evaluate(async () => {
    const first = await Data.scan.guests('e1', null);
    const ev = await Data.scan.event('e1');
    window.__w = Data.scan.watch('e1', { since: first.cursor, lastChange: ev.lastChange, count: () => first.rows.length, onCounter: () => {}, onGuests: () => {} });
  });
  let done = 0;
  await hour(page, async (t) => {
    if (t % 6 === 0 && done < 600) {
      const id = ids[done++];
      await page.evaluate((x) => Data.scan.checkIn('e1', x), id);
    }
  });
  const b = await bytes(page);
  report('scanner phone (2000 guests, 600 check-ins)', b);
  expect(done).toBe(600);
  const fulls = await page.evaluate(() => window.__fakeSupabase.calls.filter((c) => c.name === 'door_guests' && c.args.p_since == null && c.args.p_after_id == null).length);
  expect(fulls).toBe(1);
  expect(b.total).toBeLessThan(6 * MB);
});

test('egress: a guest\'s invite page polling its request for an hour stays under 0.3 MB', async ({ page }) => {
  const rid = 'q'.repeat(20);
  await open(page, { user: null, event: { paid: true }, guests: guests(N), requests: [{ id: rid, name: 'ضيف', status: 'approved', guest_id: 'WD-1' }] });
  await page.evaluate((r) => { window.__w = Data.invite.watchRequest('e1', r, { onChange: () => {} }); }, rid);
  await hour(page);
  const b = await bytes(page);
  report('invite page (get_request every 12 s)', b);
  expect(b.total).toBeLessThan(0.3 * MB);
});
