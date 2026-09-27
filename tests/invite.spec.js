const { test, expect } = require('@playwright/test');
const { stubFirebase, seedFakeFirebase } = require('./helpers');

test('shows the RSVP form for a real event and an error for a missing one', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    store: { events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } } },
  });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#g-name')).toBeVisible();
  await expect(page.locator('#card')).toContainText('حفل تجريبي');
});

test('a bad event id shows an error instead of the form', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: {} } });
  await page.goto('/invite.html?event=does-not-exist');
  await expect(page.locator('#card')).toContainText('هذه المناسبة غير موجودة');
});
