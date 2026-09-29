const { test, expect } = require('@playwright/test');
const { stubFirebase, seedFakeFirebase } = require('./helpers');

test('shows the login form when signed out', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: null });
  await page.goto('/app.html');
  await expect(page.locator('#auth-view')).toBeVisible();
  await expect(page.locator('#app-view')).toBeHidden();
});

test('a customer with no events yet sees the create button', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: { events: {} },
  });
  await page.goto('/app.html');
  await expect(page.locator('#app-view')).toBeVisible();
  await expect(page.locator('#events-heading')).toHaveText('مناسباتي');
  await expect(page.locator('#create-toggle-btn')).toBeVisible();
  await expect(page.locator('#limit-box')).toBeHidden();
});

test('a customer at their event limit sees the self-serve upgrade button, not the create button', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: {
      events: { e1: { name: 'Test Event', ownerUid: 'u1', ownerEmail: 'customer@example.com', date: '2026-01-01', venue: '', createdAt: { seconds: 1 } } },
      accountLimits: { u1: { eventCount: 1, eventLimit: 1 } },
    },
  });
  await page.goto('/app.html');
  await expect(page.locator('#create-toggle-btn')).toBeHidden();
  await expect(page.locator('#limit-box')).toBeVisible();
  await expect(page.locator('#request-more-btn')).toHaveText('➕ فتح مناسبة إضافية');
});

test('a customer already at the auto-approve ceiling must request admin approval instead', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: {
      events: {
        e1: { name: 'E1', ownerUid: 'u1', date: '', venue: '', createdAt: { seconds: 1 } },
        e2: { name: 'E2', ownerUid: 'u1', date: '', venue: '', createdAt: { seconds: 2 } },
        e3: { name: 'E3', ownerUid: 'u1', date: '', venue: '', createdAt: { seconds: 3 } },
      },
      accountLimits: { u1: { eventCount: 3, eventLimit: 3 } },
    },
  });
  await page.goto('/app.html');
  await expect(page.locator('#request-more-btn')).toHaveText('🙋 اطلب مناسبة إضافية');
});

test('the admin account sees every event, not just their own, and bypasses the limit', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'admin-uid', email: 'hsallah@outlook.sa' },
    store: {
      events: {
        e1: { name: 'Customer A Event', ownerUid: 'u1', ownerEmail: 'a@example.com', date: '', venue: '', createdAt: { seconds: 1 } },
        e2: { name: 'Customer B Event', ownerUid: 'u2', ownerEmail: 'b@example.com', date: '', venue: '', createdAt: { seconds: 2 } },
      },
    },
  });
  await page.goto('/app.html');
  await expect(page.locator('#events-heading')).toHaveText('كل المناسبات (أدمن)');
  await expect(page.locator('#events-list')).toContainText('Customer A Event');
  await expect(page.locator('#events-list')).toContainText('Customer B Event');
  await expect(page.locator('#create-toggle-btn')).toBeVisible();
});

test('the admin sees a counter banner for unpaid events, and each event has one unified card with its own activate button', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'admin-uid', email: 'hsallah@outlook.sa' },
    store: {
      events: {
        e1: { name: 'Zara Wedding', ownerUid: 'u1', ownerEmail: 'a@example.com', date: '', venue: '', paid: false, createdAt: { seconds: 1 } },
        e2: { name: 'Layla Wedding', ownerUid: 'u2', ownerEmail: 'b@example.com', date: '', venue: '', paid: true, createdAt: { seconds: 2 } },
      },
    },
  });
  page.on('dialog', d => d.type() === 'prompt' ? d.accept('120') : d.accept());
  await page.goto('/app.html');
  await expect(page.locator('#admin-unpaid-section')).toBeVisible();
  await expect(page.locator('#admin-unpaid-badge')).toHaveText('1');
  // The banner is just a counter now — it no longer renders its own copy of
  // the event, only the one card in the main list does.
  await expect(page.locator('#admin-unpaid-section')).not.toContainText('Zara Wedding');

  const unpaidCard = page.locator('.event-card', { hasText: 'Zara Wedding' });
  await expect(unpaidCard.getByRole('button', { name: '✅ تفعيل' })).toBeVisible();
  const paidCard = page.locator('.event-card', { hasText: 'Layla Wedding' });
  await expect(paidCard.getByRole('button', { name: '✅ تفعيل' })).toHaveCount(0);

  await unpaidCard.getByRole('button', { name: '✅ تفعيل' }).click();
  await expect(page.locator('#admin-unpaid-section')).toBeHidden();
  await expect(unpaidCard.getByRole('button', { name: '✅ تفعيل' })).toHaveCount(0);
  // Activating saved the number the admin typed, and the card shows it.
  await expect(unpaidCard).toContainText('مفعّلة (120 ضيف)');
  expect(await page.evaluate(() => window.__fakeFirebase.store.events.e1.guestLimit)).toBe(120);
});

test('cancelling the number prompt leaves the event unactivated', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'admin-uid', email: 'hsallah@outlook.sa' },
    store: { events: { e1: { name: 'Zara Wedding', ownerUid: 'u1', ownerEmail: 'a@example.com', date: '', venue: '', paid: false, createdAt: { seconds: 1 } } } },
  });
  page.on('dialog', d => d.dismiss());
  await page.goto('/app.html');
  await page.locator('.event-card', { hasText: 'Zara Wedding' }).getByRole('button', { name: '✅ تفعيل' }).click();
  await expect(page.locator('#admin-unpaid-badge')).toHaveText('1');
  expect(await page.evaluate(() => window.__fakeFirebase.store.events.e1.paid)).toBe(false);
});

test('the admin is told when an event with an admin-set number reaches it', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'admin-uid', email: 'hsallah@outlook.sa' },
    store: { events: { e1: { name: 'Big Wedding', ownerUid: 'u1', ownerEmail: 'a@example.com', date: '', venue: '', paid: true, guestLimit: 50, guestCount: 49, createdAt: { seconds: 1 } } } },
  });
  await page.goto('/app.html');
  await expect(page.locator('.event-card', { hasText: 'Big Wedding' })).toContainText('مفعّلة (50 ضيف)');
  await page.evaluate(() => {
    const { doc, updateDoc } = window._fsFns;
    return updateDoc(doc(window._db, 'events', 'e1'), { guestCount: 50 });
  });
  await expect(page.locator('#toast')).toContainText('Big Wedding');
  await expect(page.locator('#toast')).toContainText('لحد الضيوف (50)');
});

test('the admin gets a live toast when an event crosses the free-guest cap while watching, not for ones already capped on load', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'admin-uid', email: 'hsallah@outlook.sa' },
    store: {
      events: {
        e1: { name: 'Already Capped', ownerUid: 'u1', ownerEmail: 'a@example.com', date: '', venue: '', paid: false, guestCount: 5, createdAt: { seconds: 1 } },
        e2: { name: 'About To Cap', ownerUid: 'u2', ownerEmail: 'b@example.com', date: '', venue: '', paid: false, guestCount: 4, createdAt: { seconds: 2 } },
      },
    },
  });
  await page.goto('/app.html');
  await expect(page.locator('#admin-unpaid-badge')).toHaveText('2');
  await expect(page.locator('#toast')).not.toContainText('Already Capped');

  await page.evaluate(() => {
    const { doc, updateDoc } = window._fsFns;
    return updateDoc(doc(window._db, 'events', 'e2'), { guestCount: 5 });
  });
  await expect(page.locator('#toast')).toContainText('About To Cap');
});

test('the admin gets a one-time nudge toast on a fresh page load when unpaid events are already capped', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'admin-uid', email: 'hsallah@outlook.sa' },
    store: {
      events: {
        e1: { name: 'Already Capped 1', ownerUid: 'u1', ownerEmail: 'a@example.com', date: '', venue: '', paid: false, guestCount: 5, createdAt: { seconds: 1 } },
        e2: { name: 'Already Capped 2', ownerUid: 'u2', ownerEmail: 'b@example.com', date: '', venue: '', paid: false, guestCount: 6, createdAt: { seconds: 2 } },
      },
    },
  });
  await page.goto('/app.html');
  await expect(page.locator('#toast')).toContainText('2 مناسبة وصلت لحد الضيوف');
  // Doesn't call out either event by name — that's what the standing list is for.
  await expect(page.locator('#toast')).not.toContainText('Already Capped');
});

test('an anonymous door-scanner identity left on the same browser does not pass for a logged-in customer', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'anon-1', isAnonymous: true, email: null }, store: {} });
  await page.goto('/app.html');
  await expect(page.locator('#auth-view')).toBeVisible();
  await expect(page.locator('#app-view')).toBeHidden();
});

test('the events list shows each event date as words with Western digits', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: {
      events: { e1: { name: 'Test Event', ownerUid: 'u1', ownerEmail: 'customer@example.com', date: '2026-10-29', venue: 'الرياض', createdAt: { seconds: 1 } } },
      accountLimits: { u1: { eventLimit: 1, eventCount: 1 } },
    },
  });
  await page.goto('/app.html');
  await expect(page.locator('.event-date').first()).toContainText('الخميس 29 أكتوبر 2026');
});
