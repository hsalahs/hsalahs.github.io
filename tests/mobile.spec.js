const { test, expect } = require('@playwright/test');
const { stubFirebase, seedFakeFirebase } = require('./helpers');

// Narrow phones (320 = the smallest still in use, 375 = the most common): no
// page may scroll sideways, even with long names, emails and links — the
// first mobile audit found a long email pushing the admin's account row past
// the screen edge.
const LONG_EMAIL = 'very.long.customer.email.address@example.com';
const store = {
  events: { e1: { name: 'حفل زفاف أحمد وسارة في قاعة الأفراح الكبرى', ownerUid: 'u1', ownerEmail: LONG_EMAIL, date: '2026-12-20', venue: 'قاعة الأفراح — الرياض حي الملقا', theme: 'gold', slug: 'ahmad-and-sara-wedding-2026', guestCount: 3, scannedCount: 1, paid: true, guestLimit: 100, createdAt: { seconds: 1 } } },
  'events/e1/guests': {
    g0: { id: 'WD-2D7SDOAAY9WJ7', name: 'أحمد عبدالله العتيبي الطويل جدًا في الاسم', scanned: false },
    g1: { id: 'WD-3K9QXZ81LMNOP', name: 'حلا', scanned: false, vip: true },
    g2: { id: 'WD-7Y2WE5RT6UIOP', name: 'سارة محمد', scanned: true },
  },
  'events/e1/requests': {},
  'events/e1/private': { scan: { scanPin: '123456' } },
  users: { u1: { email: LONG_EMAIL, createdAt: { seconds: 1790000000 } } },
};
const OWNER = { uid: 'u1', email: LONG_EMAIL };
const ADMIN = { uid: 'a1', email: 'hsallah@outlook.sa' };

const PAGES = [
  ['landing', '/index.html', null, (p) => p.locator('.hero').waitFor()],
  ['guide', '/guide.html', null, (p) => p.locator('#faq').waitFor()],
  ['organizer events', '/app.html', OWNER, (p) => p.locator('#events-list .event-card').waitFor()],
  ['admin accounts', '/app.html', ADMIN, async (p) => { await p.locator('#admin-accounts-toggle').click(); await p.locator('#admin-accounts-list .acc-row').waitFor(); }],
  ['event dashboard', '/event.html?id=e1', OWNER, (p) => p.locator('.guest-item').first().waitFor()],
  ['event menu', '/event.html?id=e1', OWNER, async (p) => { await p.locator('.guest-item').first().waitFor(); await p.getByRole('button', { name: 'القائمة' }).click(); }],
  ['guest sheet', '/event.html?id=e1', OWNER, async (p) => { await p.locator('.guest-item .more-btn').first().click(); await p.locator('#guest-sheet').waitFor(); }],
  ['event delete modal', '/event.html?id=e1', OWNER, async (p) => { await p.locator('.guest-item').first().waitFor(); await p.getByRole('button', { name: 'القائمة' }).click(); await p.getByRole('button', { name: /تعديل المناسبة/ }).click(); await p.getByRole('button', { name: 'حذف المناسبة نهائيًا' }).click(); await p.locator('#delete-event-modal').waitFor(); }],
  ['organizer delete modal', '/app.html', OWNER, async (p) => { await p.locator('#events-list .event-card').waitFor(); await p.locator('#events-list .event-card').getByRole('button', { name: 'حذف' }).click(); await p.locator('#delete-event-modal').waitFor(); }],
  ['invitation', '/invite.html?event=e1', null, (p) => p.locator('#g-name').waitFor()],
  ['scanner code screen', '/scan.html?event=e1', null, (p) => p.locator('#pin-input').waitFor()],
];

for (const width of [320, 375]) {
  for (const [name, url, user, ready] of PAGES) {
    test(`${width}px: ${name} has no sideways scroll`, async ({ page }) => {
      await page.setViewportSize({ width, height: 760 });
      await stubFirebase(page);
      await seedFakeFirebase(page, { user, store });
      await page.goto(url);
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
  }
}

test('320px: a long event name on the scanner code screen stays clear of the refresh button', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await stubFirebase(page);
  await seedFakeFirebase(page, { store });
  await page.goto('/scan.html?event=e1');
  await page.locator('#pin-input').waitFor();
  await expect(page.locator('#pin-event-name')).not.toBeEmpty();
  const btn = await page.locator('#refresh-btn').boundingBox();
  const range = await page.evaluate(() => {
    const r = document.createRange();
    r.selectNodeContents(document.getElementById('pin-event-name'));
    return Array.from(r.getClientRects()).map(b => ({ left: b.left, right: b.right, top: b.top, bottom: b.bottom }));
  });
  const overlaps = range.some(b => b.left < btn.x + btn.width && b.right > btn.x && b.top < btn.y + btn.height && b.bottom > btn.y);
  expect(overlaps).toBe(false);
});
