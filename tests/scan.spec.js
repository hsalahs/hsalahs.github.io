const { test, expect } = require('@playwright/test');
const { stubFirebase, seedFakeFirebase } = require('./helpers');

const EVENT = {
  name: 'حفل تجريبي', ownerUid: 'u1', date: '2026-01-01', venue: 'الرياض',
  scanPin: '1234', theme: 'gold', createdAt: { seconds: 1 },
};

test('visiting scan.html with an event remembers it in localStorage', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EVENT }, 'events/e1/guests': {} } });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#pin-event-name')).toHaveText('حفل تجريبي');
  const remembered = await page.evaluate(() => localStorage.getItem('scan_last_event'));
  expect(remembered).toBe('e1');
});

test('visiting scan.html with no event redirects to the last remembered one (PWA icon launch)', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EVENT }, 'events/e1/guests': {} } });
  await page.addInitScript(() => localStorage.setItem('scan_last_event', 'e1'));
  await page.goto('/scan.html');
  await expect(page).toHaveURL(/scan\.html\?event=e1/);
  await expect(page.locator('#pin-event-name')).toHaveText('حفل تجريبي');
});

test('visiting scan.html with no event and nothing remembered shows the invalid-link message', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: {} } });
  await page.goto('/scan.html');
  await expect(page.locator('#loading-msg')).toContainText('رابط غير صحيح');
});
