const { test, expect } = require('@playwright/test');
const { stubFirebase, seedFakeFirebase } = require('./helpers');

const EVENT = {
  name: 'حفل تجريبي', ownerUid: 'u1', date: '2026-01-01', venue: 'الرياض',
  scanPin: '1234', theme: 'gold', createdAt: { seconds: 1 },
};

function baseStore(guests) {
  const g = {};
  guests.forEach((data, i) => { g['g' + i] = data; });
  return {
    events: { e1: EVENT },
    'events/e1/guests': g,
    'events/e1/requests': {},
  };
}

test('guest list sorts numeric names first (in numeric order), then alphabetical', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: baseStore([
      { id: 'WD-1', name: 'زينب', scanned: false },
      { id: 'WD-2', name: '10', scanned: false },
      { id: 'WD-3', name: '2', scanned: false },
      { id: 'WD-4', name: 'أحمد', scanned: false },
    ]),
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  const names = await page.locator('.guest-item .name').allTextContents();
  expect(names).toEqual(['2', '10', 'أحمد', 'زينب']);
});

test('stat tiles reflect attended vs pending counts', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: baseStore([
      { id: 'WD-1', name: 'A', scanned: true },
      { id: 'WD-2', name: 'B', scanned: false },
      { id: 'WD-3', name: 'C', scanned: false },
    ]),
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#stat-total')).toHaveText('3');
  await expect(page.locator('#stat-attended')).toHaveText('1');
  await expect(page.locator('#stat-pending')).toHaveText('2');
});

test('guest search filters the visible list by name', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: baseStore([
      { id: 'WD-1', name: 'Hassan Sallah', scanned: false },
      { id: 'WD-2', name: 'Fatima Ali', scanned: false },
    ]),
  });
  await page.goto('/event.html?id=e1');
  await page.getByRole('button', { name: '👥 الضيوف' }).click();
  await expect(page.locator('.guest-item')).toHaveCount(2);
  await page.locator('#guest-search').fill('fatima');
  await expect(page.locator('.guest-item')).toHaveCount(1);
  await expect(page.locator('.guest-item .name')).toHaveText('Fatima Ali');
});

test('someone who is not the event owner is denied access', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'someone-else', email: 'not-the-owner@example.com' },
    store: baseStore([]),
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#denied-msg')).toBeVisible();
  await expect(page.locator('#dashboard')).toBeHidden();
});

test('the admin account can open a customer event it does not own', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'admin-uid', email: 'hsallah@outlook.sa' },
    store: baseStore([{ id: 'WD-1', name: 'Guest', scanned: false }]),
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#denied-msg')).toBeHidden();
});

test('an unpaid event blocks the owner from adding a guest, and shows the payment gate', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: { events: { e1: { ...EVENT, paid: false } }, 'events/e1/guests': {}, 'events/e1/requests': {} },
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#payment-gate')).toBeVisible();
  await page.getByRole('button', { name: '👥 الضيوف' }).click();
  await page.locator('#new-guest-name').fill('ضيف جديد');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('.guest-item')).toHaveCount(0);
});

test('a paid event lets the owner add a guest normally, and hides the payment gate', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: { events: { e1: { ...EVENT, paid: true } }, 'events/e1/guests': {}, 'events/e1/requests': {} },
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#payment-gate')).toBeHidden();
  await page.getByRole('button', { name: '👥 الضيوف' }).click();
  await page.locator('#new-guest-name').fill('ضيف جديد');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('.guest-item')).toHaveCount(1);
});
