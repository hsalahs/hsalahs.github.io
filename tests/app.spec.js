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

test('the admin sees a standing list of unpaid events and can activate one from it', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'admin-uid', email: 'hsallah@outlook.sa' },
    store: {
      events: {
        e1: { name: 'Unpaid Event', ownerUid: 'u1', ownerEmail: 'a@example.com', date: '', venue: '', paid: false, createdAt: { seconds: 1 } },
        e2: { name: 'Paid Event', ownerUid: 'u2', ownerEmail: 'b@example.com', date: '', venue: '', paid: true, createdAt: { seconds: 2 } },
      },
    },
  });
  page.on('dialog', d => d.accept());
  await page.goto('/app.html');
  await expect(page.locator('#admin-unpaid-section')).toBeVisible();
  await expect(page.locator('#admin-unpaid-badge')).toHaveText('1');
  await expect(page.locator('#admin-unpaid-list')).toContainText('Unpaid Event');
  await expect(page.locator('#admin-unpaid-list')).not.toContainText('Paid Event');
  await page.locator('#admin-unpaid-list').getByRole('button', { name: '✅ تفعيل' }).click();
  await expect(page.locator('#admin-unpaid-section')).toBeHidden();
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
