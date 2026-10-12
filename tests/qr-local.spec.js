const { test, expect } = require('@playwright/test');
const { stubFirebase, seedFakeFirebase, routeQr } = require('./helpers');

const USER = { uid: 'u1', email: 'customer@example.com' };
const STORE = () => ({
  events: { e1: { name: 'حفل تجريبي', ownerUid: 'u1', date: '2026-01-01', venue: 'الرياض', theme: 'gold', createdAt: { seconds: 1 }, guestCount: 1 } },
  'events/e1/guests': { g0: { id: 'WD-ABCDEFGHIJKLM', name: 'أحمد', scanned: false } },
  'events/e1/requests': {},
  'events/e1/private': { scan: { scanPin: '1234' } },
});
const STAND_IN = {
  body: `window.QRCode = function (el) { const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d'); x.fillRect(0, 0, 256, 256); x.fillStyle = '#fff'; x.fillRect(64, 64, 128, 128); el.appendChild(c); }; window.QRCode.CorrectLevel = { H: 2 };`,
};

async function open(page) {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: USER, store: STORE() });
}
const build = (page) => page.evaluate(async () => !!(await buildGuestCard(guests[0])));
const qrScripts = (page) => page.evaluate(() => [...document.scripts].filter((s) => /qrcode/.test(s.src)).length);

test('our own copy is used first: one local hit, no CDN hit, a real QR card is built', async ({ page }) => {
  await open(page);
  const q = await routeQr(page, { local: 'ok', cdn: 'abort' });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('.guest-item')).toHaveCount(1);
  expect(q.hits).toEqual({ local: 0, cdn: 0 });
  expect(await build(page)).toBe(true);
  expect(await build(page)).toBe(true);
  expect(q.hits).toEqual({ local: 1, cdn: 0 });
  expect(await qrScripts(page)).toBe(1);
});

for (const bad of ['abort', '404', 'junk', 'html']) {
  test(`local copy "${bad}": falls back to the CDN once and leaves exactly one script tag`, async ({ page }) => {
    await open(page);
    const q = await routeQr(page, { local: bad, cdn: STAND_IN });
    await page.goto('/event.html?id=e1');
    await expect(page.locator('.guest-item')).toHaveCount(1);
    expect(await build(page)).toBe(true);
    expect(q.hits).toEqual({ local: 1, cdn: 1 });
    expect(await qrScripts(page)).toBe(1);
  });
}

test('both sources fail: null, no stray script tags, and the next try starts again from our own copy', async ({ page }) => {
  await open(page);
  const q = await routeQr(page, { local: '404', cdn: 'abort' });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('.guest-item')).toHaveCount(1);
  expect(await build(page)).toBe(false);
  expect(await qrScripts(page)).toBe(0);
  expect(q.hits).toEqual({ local: 1, cdn: 1 });
  q.setLocal('ok');
  expect(await build(page)).toBe(true);
  expect(q.hits).toEqual({ local: 2, cdn: 1 });
});

test('two cards requested together share one download of each source', async ({ page }) => {
  await open(page);
  const q = await routeQr(page, { local: 'abort', cdn: STAND_IN });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('.guest-item')).toHaveCount(1);
  const both = await page.evaluate(async () => (await Promise.all([buildGuestCard(guests[0]), buildGuestCard(guests[0])])).map((c) => !!c));
  expect(both).toEqual([true, true]);
  expect(q.hits).toEqual({ local: 1, cdn: 1 });
});

test('a hanging local copy gives up after 8 s and the CDN is tried; both hanging fail after 8 s + 15 s', async ({ page }) => {
  await page.clock.install();
  await open(page);
  await routeQr(page, { local: 'hang', cdn: 'hang' });
  await page.goto('/event.html?id=e1');
  await page.clock.runFor(1000);
  await page.evaluate(() => { window.__r = 'pending'; buildGuestCard(guests[0]).then((v) => { window.__r = v === null ? 'null' : 'card'; }); });
  await page.clock.runFor(22000);
  expect(await page.evaluate(() => window.__r)).toBe('pending');
  await page.clock.runFor(2000);
  expect(await page.evaluate(() => window.__r)).toBe('null');
  expect(await qrScripts(page)).toBe(0);
});

test('a hanging local copy: the CDN answer after 8 s still builds the card', async ({ page }) => {
  await page.clock.install();
  await open(page);
  const q = await routeQr(page, { local: 'hang', cdn: 'ok' });
  await page.goto('/event.html?id=e1');
  await page.clock.runFor(1000);
  await page.evaluate(() => { window.__r = 'pending'; buildGuestCard(guests[0]).then((v) => { window.__r = v === null ? 'null' : 'card'; }); });
  await page.clock.runFor(7000);
  expect(await page.evaluate(() => window.__r)).toBe('pending');
  await page.clock.runFor(3000);
  await expect.poll(() => page.evaluate(() => window.__r)).toBe('card');
  expect(q.hits).toEqual({ local: 1, cdn: 1 });
});

test('invite.html draws the card from our own copy without touching the CDN', async ({ page }) => {
  await stubFirebase(page);
  const q = await routeQr(page, { local: 'ok', cdn: 'abort' });
  await seedFakeFirebase(page, {
    store: {
      events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } },
      'events/e1/requests': { 'REQ-1': { name: 'سارة', reqId: 'REQ-1', status: 'approved', guestId: 'WD-ABCDEFGHIJKLM', createdAt: 'x' } },
    },
  });
  await page.addInitScript(() => { localStorage.setItem('inv_reqid_e1', 'REQ-1'); });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card-wrap img')).toBeVisible({ timeout: 10000 });
  expect(q.hits).toEqual({ local: 1, cdn: 0 });
});

test('event.html: a junk local file plus a failing CDN counts as failure, with the friendly text and no page error', async ({ page }) => {
  await open(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const q = await routeQr(page, { local: 'junk', cdn: 'abort' });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('.guest-item')).toHaveCount(1);
  const msgs = [];
  page.on('dialog', (d) => { msgs.push(d.message()); d.accept(); });
  await page.evaluate(() => downloadGuestCard(guests[0].docId));
  await expect.poll(() => msgs.length).toBe(1);
  expect(msgs[0]).toContain('تأكد من الاتصال وجرّب مرة ثانية');
  expect(await page.evaluate(() => typeof window.QRCode === 'function')).toBe(false);
  expect(await qrScripts(page)).toBe(0);
  expect(q.hits).toEqual({ local: 1, cdn: 1 });
  expect(errors).toEqual([]);
});

test('invite.html: both sources hanging give up after 8 s + 15 s with the retry message', async ({ page }) => {
  await page.clock.install();
  await stubFirebase(page);
  await routeQr(page, { local: 'hang', cdn: 'hang' });
  await seedFakeFirebase(page, {
    store: {
      events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } },
      'events/e1/requests': { 'REQ-1': { name: 'سارة', reqId: 'REQ-1', status: 'approved', guestId: 'WD-ABCDEFGHIJKLM', createdAt: 'x' } },
    },
  });
  await page.addInitScript(() => { localStorage.setItem('inv_reqid_e1', 'REQ-1'); });
  await page.goto('/invite.html?event=e1', { waitUntil: 'domcontentloaded' });
  await page.clock.runFor(1000);
  await expect(page.locator('#qr-retry')).toHaveCount(0);
  await page.clock.runFor(25000);
  await expect(page.locator('#qr-retry')).toContainText('تعذّر تجهيز البطاقة', { timeout: 10000 });
  await expect(page.locator('#card-wrap img')).toHaveCount(0);
});

test('invite.html: a junk local file plus a failing CDN shows the retry message and no page error', async ({ page }) => {
  await stubFirebase(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const q = await routeQr(page, { local: 'junk', cdn: 'abort' });
  await seedFakeFirebase(page, {
    store: {
      events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } },
      'events/e1/requests': { 'REQ-1': { name: 'سارة', reqId: 'REQ-1', status: 'approved', guestId: 'WD-ABCDEFGHIJKLM', createdAt: 'x' } },
    },
  });
  await page.addInitScript(() => { localStorage.setItem('inv_reqid_e1', 'REQ-1'); });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#qr-retry')).toContainText('تعذّر تجهيز البطاقة', { timeout: 10000 });
  await expect(page.locator('#card-wrap img')).toHaveCount(0);
  expect(q.hits).toEqual({ local: 1, cdn: 1 });
  expect(errors).toEqual([]);
});
