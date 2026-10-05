const { test, expect } = require('@playwright/test');
const { stubFirebase, seedFakeFirebase } = require('./helpers');

const ANDROID = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const EVENT = { name: 'حفل تجريبي', ownerUid: 'u1', date: '2026-01-01', venue: 'الرياض', theme: 'gold', createdAt: { seconds: 1 } };
const QR_STAND_IN = `window.QRCode = function (el) {
  var c = document.createElement('canvas'); c.width = 10; c.height = 10;
  c.getContext('2d').fillRect(0, 0, 10, 10); el.appendChild(c);
  this.makeCode = function () {};
};
window.QRCode.CorrectLevel = { H: 2, M: 0, L: 1, Q: 3 };`;

async function stubShare(page) {
  await page.addInitScript(() => {
    window.__shared = 0;
    navigator.canShare = () => true;
    navigator.share = () => { window.__shared++; return Promise.resolve(); };
  });
}

async function openEvent(page) {
  await stubFirebase(page);
  await page.route(/qrcodejs.*qrcode\.min\.js/, (route) => route.fulfill({ contentType: 'text/javascript', body: QR_STAND_IN }));
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: {
      events: { e1: EVENT },
      'events/e1/guests': { g0: { id: 'WD-1', name: 'أحمد', scanned: false } },
      'events/e1/requests': {},
      'events/e1/private': { scan: { scanPin: '1234' } },
    },
  });
  await stubShare(page);
  await page.goto('/event.html?id=e1');
  await expect(page.locator('.guest-item .dl-btn')).toBeVisible();
}

async function openInvite(page) {
  await stubFirebase(page);
  await page.route(/qrcodejs.*qrcode\.min\.js/, (route) => route.fulfill({ contentType: 'text/javascript', body: QR_STAND_IN }));
  await seedFakeFirebase(page, {
    store: {
      events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } },
      'events/e1/requests': { 'REQ-1': { name: 'سارة', reqId: 'REQ-1', status: 'approved', guestId: 'WD-ABC', createdAt: 'x' } },
    },
  });
  await page.addInitScript(() => { localStorage.setItem('inv_reqid_e1', 'REQ-1'); });
  await stubShare(page);
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#save-btn')).toBeVisible({ timeout: 10000 });
}

const pages = [
  { name: 'event.html', open: openEvent, btn: '.guest-item .dl-btn' },
  { name: 'invite.html', open: openInvite, btn: '#save-btn' },
];

for (const p of pages) {
  test.describe(p.name + ' on Android', () => {
    test.use({ userAgent: ANDROID });
    test('saves the PNG directly and never opens the share sheet', async ({ page }) => {
      await p.open(page);
      const [dl] = await Promise.all([page.waitForEvent('download'), page.locator(p.btn).click()]);
            expect(await page.evaluate(() => window.__shared)).toBe(0);
      await expect(page.locator('#toast')).toContainText('تم حفظ صورة الدعوة في جوالك');
    });
  });
  test.describe(p.name + ' on iPhone', () => {
    test.use({ userAgent: IPHONE });
    test('opens the share sheet and does not download', async ({ page }) => {
      await p.open(page);
      let downloaded = false;
      page.on('download', () => { downloaded = true; });
      await page.locator(p.btn).click();
      await expect.poll(() => page.evaluate(() => window.__shared)).toBe(1);
      expect(downloaded).toBe(false);
    });
  });
  test.describe(p.name + ' on desktop', () => {
    test.use({ userAgent: DESKTOP });
    test('keeps the share sheet when files can be shared', async ({ page }) => {
      await p.open(page);
      await page.locator(p.btn).click();
      await expect.poll(() => page.evaluate(() => window.__shared)).toBe(1);
    });
    test('downloads when files cannot be shared', async ({ page }) => {
      await p.open(page);
      await page.evaluate(() => { navigator.canShare = () => false; });
      const [dl] = await Promise.all([page.waitForEvent('download'), page.locator(p.btn).click()]);
            expect(await page.evaluate(() => window.__shared)).toBe(0);
    });
  });
}
