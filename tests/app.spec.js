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
  await expect(page.locator('#request-more-btn')).toHaveText('فتح مناسبة إضافية');
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
  await expect(page.locator('#request-more-btn')).toHaveText('اطلب مناسبة إضافية');
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

test('changing one event does not re-read every other listed event\'s guest list', async ({ page }) => {
  // Regression test for the admin dashboard, which watches every customer's
  // events at once: one customer's change used to re-fetch EVERY listed
  // event's full guest subcollection, not just the one that changed.
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'admin-uid', email: 'hsallah@outlook.sa' },
    store: {
      events: {
        e1: { name: 'Customer A Event', ownerUid: 'u1', date: '', venue: '', createdAt: { seconds: 1 }, guestCount: 0 },
        e2: { name: 'Customer B Event', ownerUid: 'u2', date: '', venue: '', createdAt: { seconds: 2 }, guestCount: 0 },
      },
      'events/e1/guests': {}, 'events/e2/guests': {},
    },
  });
  await page.goto('/app.html');
  await expect(page.locator('#events-list')).toContainText('Customer A Event');

  const guestReads = (p) => page.evaluate((path) =>
    (window.__fakeFirebase.getDocsPaths || []).filter(x => x === path).length, p);

  // Initial load reads both events' guest lists once each.
  await expect.poll(() => guestReads('events/e1/guests')).toBe(1);
  await expect.poll(() => guestReads('events/e2/guests')).toBe(1);

  // Something changes on e1 only — e2's own doc is untouched.
  await page.evaluate(() => {
    const { doc, updateDoc } = window._fsFns;
    return updateDoc(doc(window._db, 'events', 'e1'), { guestCount: 1 });
  });

  // e1's stats re-read, but e2's guest list is NOT read again.
  await expect.poll(() => guestReads('events/e1/guests')).toBe(2);
  expect(await guestReads('events/e2/guests')).toBe(1);
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
  await expect(unpaidCard.getByRole('button', { name: 'تفعيل' })).toBeVisible();
  const paidCard = page.locator('.event-card', { hasText: 'Layla Wedding' });
  await expect(paidCard.getByRole('button', { name: 'تفعيل' })).toHaveCount(0);

  await unpaidCard.getByRole('button', { name: 'تفعيل' }).click();
  await expect(page.locator('#admin-unpaid-section')).toBeHidden();
  await expect(unpaidCard.getByRole('button', { name: 'تفعيل' })).toHaveCount(0);
  // Activating saved the number the admin typed, and the card shows it.
  await expect(unpaidCard).toContainText('مفعّلة (120 ضيف)');
  expect(await page.evaluate(() => window.__fakeFirebase.store.events.e1.guestLimit)).toBe(120);
});

test('the admin sees every account that ever registered, even one with no event', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'admin-uid', email: 'hsallah@outlook.sa' },
    store: {
      events: {},
      users: { u1: { email: 'noevent@example.com', createdAt: { seconds: 1700000000 } } },
    },
  });
  await page.goto('/app.html');
  await expect(page.locator('#admin-accounts-section')).toBeVisible();
  await expect(page.locator('#admin-accounts-badge')).toHaveText('1');
  await page.locator('#admin-accounts-toggle').click();
  await expect(page.locator('#admin-accounts-list')).toContainText('noevent@example.com');
});

test('each account shows what it has done; the filters narrow the list; tapping one shows only its events', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'admin-uid', email: 'hsallah@outlook.sa' },
    store: {
      events: {
        e1: { name: 'حفل تجربة', ownerUid: 'u1', ownerEmail: 'trial@example.com', paid: false, guestCount: 1, createdAt: { seconds: 3 } },
        e2: { name: 'حفل مدفوع', ownerUid: 'u2', ownerEmail: 'paid@example.com', paid: true, guestLimit: 100, guestCount: 0, createdAt: { seconds: 2 } },
      },
      users: {
        u1: { email: 'trial@example.com', createdAt: { seconds: 1700000003 } },
        u2: { email: 'paid@example.com', createdAt: { seconds: 1700000002 } },
        u3: { email: 'none@example.com', createdAt: { seconds: 1700000001 } },
      },
    },
  });
  await page.goto('/app.html');
  await page.locator('#admin-accounts-toggle').click();
  const row = (email) => page.locator('#admin-accounts-list .acc-row', { hasText: email });
  await expect(row('trial@example.com').locator('.acc-tag')).toHaveText(['1 مناسبة', 'يجرّب مجانًا']);
  await expect(row('paid@example.com').locator('.acc-tag')).toHaveText(['1 مناسبة', '✓ مفعّلة (100 ضيف)']);
  await expect(row('none@example.com').locator('.acc-tag')).toHaveText(['بدون مناسبة']);

  const rows = page.locator('#admin-accounts-list .acc-row');
  await page.getByRole('button', { name: 'عندهم مناسبة مفعّلة' }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('paid@example.com');
  await page.getByRole('button', { name: 'يجرّبون' }).click();
  await expect(rows).toContainText('trial@example.com');
  await page.getByRole('button', { name: 'بدون مناسبة' }).click();
  await expect(rows).toContainText('none@example.com');
  await page.getByRole('button', { name: 'الكل', exact: true }).click();
  await expect(rows).toHaveCount(3);

  await expect(page.locator('#events-list .event-card')).toHaveCount(2);
  await row('paid@example.com').locator('.event-name').click();
  await expect(page.locator('#owner-filter-bar')).toBeVisible();
  await expect(page.locator('#owner-filter-email')).toHaveText('paid@example.com');
  await expect(page.locator('#events-list .event-card')).toHaveCount(1);
  await expect(page.locator('#events-list')).toContainText('حفل مدفوع');
  await row('none@example.com').locator('.event-name').click();
  await expect(page.locator('#events-list')).toContainText('هذا الحساب ما عنده مناسبات');
  await page.locator('#owner-filter-bar').getByRole('button', { name: 'عرض الكل' }).click();
  await expect(page.locator('#owner-filter-bar')).toBeHidden();
  await expect(page.locator('#events-list .event-card')).toHaveCount(2);
});

test('the accounts list is collapsed by default and only read when opened — the badge comes from a cheap count', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'admin-uid', email: 'hsallah@outlook.sa' },
    store: {
      events: {},
      users: {
        u1: { email: 'first@example.com', createdAt: { seconds: 1700000000 } },
        u2: { email: 'second@other.com', createdAt: { seconds: 1700000100 } },
      },
    },
  });
  await page.goto('/app.html');
  await expect(page.locator('#admin-accounts-badge')).toHaveText('2');
  await expect(page.locator('#admin-accounts-body')).toBeHidden();
  const reads = () => page.evaluate(() => ({
    full: (window.__fakeFirebase.getDocsPaths || []).filter(p => p === 'users').length,
    count: (window.__fakeFirebase.countPaths || []).filter(p => p === 'users').length,
  }));
  expect(await reads()).toEqual({ full: 0, count: 1 });

  await page.locator('#admin-accounts-toggle').click();
  await expect(page.locator('#admin-accounts-list .event-name')).toHaveText(['second@other.com', 'first@example.com']);
  await expect(page.locator('#admin-accounts-arrow')).toHaveText('▴');

  await page.locator('#admin-accounts-search').fill('OTHER');
  await expect(page.locator('#admin-accounts-list .event-name')).toHaveText(['second@other.com']);
  await page.locator('#admin-accounts-search').fill('nobody');
  await expect(page.locator('#admin-accounts-list')).toContainText('لا يوجد حساب بهذا الإيميل');

  await page.locator('#admin-accounts-toggle').click();
  await expect(page.locator('#admin-accounts-body')).toBeHidden();
  await page.locator('#admin-accounts-toggle').click();
  await expect(page.locator('#admin-accounts-body')).toBeVisible();
  expect((await reads()).full).toBe(1);
});

test('the admin can remove an account from the list — only its users record, never the customer\'s events', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'admin-uid', email: 'hsallah@outlook.sa' },
    store: {
      events: { e1: { name: 'Kept Event', ownerUid: 'u1', ownerEmail: 'gone@example.com', date: '', venue: '', createdAt: { seconds: 1 } } },
      users: {
        u1: { email: 'gone@example.com', createdAt: { seconds: 1700000000 } },
        u2: { email: 'stays@example.com', createdAt: { seconds: 1700000100 } },
      },
    },
  });
  await page.goto('/app.html');
  await page.locator('#admin-accounts-toggle').click();
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  await page.locator('#admin-accounts-list .event-card-top', { hasText: 'gone@example.com' }).locator('.acc-del-btn').click();
  await expect(page.locator('#admin-accounts-list .event-name')).toHaveText(['stays@example.com']);
  await expect(page.locator('#admin-accounts-badge')).toHaveText('1');
  expect(dialogs[0]).toContain('حساب العميل ومناسباته ما تتأثر');
  const store = await page.evaluate(() => window.__fakeFirebase.store);
  expect(Object.keys(store.users)).toEqual(['u2']);
  expect(store.events.e1.name).toBe('Kept Event');
});

test('cancelling the confirmation keeps the account in the list', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'admin-uid', email: 'hsallah@outlook.sa' },
    store: { events: {}, users: { u1: { email: 'keep@example.com', createdAt: { seconds: 1700000000 } } } },
  });
  await page.goto('/app.html');
  await page.locator('#admin-accounts-toggle').click();
  page.on('dialog', d => d.dismiss());
  await page.locator('.acc-del-btn').click();
  await expect(page.locator('#admin-accounts-list .event-name')).toHaveText(['keep@example.com']);
  expect(await page.evaluate(() => Object.keys(window.__fakeFirebase.store.users))).toEqual(['u1']);
});

test.describe('in Riyadh time', () => {
  test.use({ timezoneId: 'Asia/Riyadh' });
  test('each account shows the time it registered, 12-hour with ص/م and Western digits', async ({ page }) => {
    await stubFirebase(page);
    await seedFakeFirebase(page, {
      user: { uid: 'admin-uid', email: 'hsallah@outlook.sa' },
      store: {
        events: {},
        users: {
          u1: { email: 'night@example.com', createdAt: { seconds: 1700000000 } }, // 2023-11-15 01:13 Riyadh
          u2: { email: 'noon@example.com', createdAt: { seconds: 1700042400 } },  // 2023-11-15 13:00 Riyadh
        },
      },
    });
    await page.goto('/app.html');
    await page.locator('#admin-accounts-toggle').click();
    const list = page.locator('#admin-accounts-list');
    await expect(list).toContainText('سجّل: 15 نوفمبر 2023 · 1:13 ص');
    await expect(list).toContainText('سجّل: 15 نوفمبر 2023 · 1:00 م');
    expect(await list.innerText()).not.toMatch(/[\u0660-\u0669]/);
  });
});

test('signing up writes a record the admin can see later, even if the account never creates an event', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: null });
  await page.goto('/app.html');
  await page.locator('#auth-toggle a').click();
  await page.locator('#auth-email').fill('newcustomer@example.com');
  await page.locator('#auth-pass').fill('whatever123');
  await page.locator('#auth-submit-btn').click();
  await expect(page.locator('#app-view')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const u = window.__fakeFirebase.store.users && window.__fakeFirebase.store.users['test-uid'];
    return u ? u.email : null;
  })).toBe('newcustomer@example.com');
});

test('cancelling the number prompt leaves the event unactivated', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'admin-uid', email: 'hsallah@outlook.sa' },
    store: { events: { e1: { name: 'Zara Wedding', ownerUid: 'u1', ownerEmail: 'a@example.com', date: '', venue: '', paid: false, createdAt: { seconds: 1 } } } },
  });
  page.on('dialog', d => d.dismiss());
  await page.goto('/app.html');
  await page.locator('.event-card', { hasText: 'Zara Wedding' }).getByRole('button', { name: 'تفعيل' }).click();
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
  await expect(page.locator('#toast')).toContainText('2 مناسبتين وصلت لحد الضيوف');
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

test('the new-event form has a cancel button that closes it and clears what was typed, without creating anything', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: { events: {} } });
  let dialogs = 0;
  page.on('dialog', (d) => { dialogs++; d.accept(); });
  await page.goto('/app.html');
  await page.locator('#create-toggle-btn').click();
  await expect(page.locator('#create-form')).toBeVisible();
  await expect(page.getByRole('button', { name: 'إنشاء', exact: true })).toBeVisible();
  await expect(page.locator('#create-cancel-btn')).toHaveText('إلغاء');

  await page.getByRole('radio', { name: 'زفاف' }).click();
  await page.locator('#ev-name').fill('عرس تجريبي');
  await expect(page.locator('label[for="ev-date"]')).toHaveText('تاريخ المناسبة');
  await page.locator('#ev-date').fill('2026-12-01');
  await page.locator('#ev-venue').fill('الرياض');
  await page.locator('#ev-maps').fill('https://maps.example.com/x');
  await page.locator('#create-cancel-btn').click();

  await expect(page.locator('#create-form')).toBeHidden();
  await expect(page.locator('#create-toggle-btn')).toBeVisible();
  expect(dialogs).toBe(0);                       // cancelling is silent: no "write the name" alert
  const store = await page.evaluate(() => window.__fakeFirebase.store);
  expect(Object.keys(store.events || {})).toHaveLength(0);
  expect(store.accountLimits).toBeUndefined();  // nothing was counted against the customer's limit

  // Reopening shows an empty form.
  await page.locator('#create-toggle-btn').click();
  for (const id of ['ev-name', 'ev-date', 'ev-venue', 'ev-maps']) await expect(page.locator('#' + id)).toHaveValue('');
});

test('cancelling an untouched form just closes it, and creating an event still works afterwards', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: { events: {} } });
  page.on('dialog', (d) => d.accept());
  await page.goto('/app.html');
  await page.locator('#create-toggle-btn').click();
  await page.locator('#create-cancel-btn').click();
  await expect(page.locator('#create-form')).toBeHidden();

  await page.locator('#create-toggle-btn').click();
  await page.getByRole('radio', { name: 'زفاف' }).click();
  await page.locator('#ev-name').fill('عرس حقيقي');
  await page.getByRole('button', { name: 'إنشاء', exact: true }).click();
  // A created event opens its own dashboard.
  await expect(page).toHaveURL(/event\.html\?id=/);
});

test('creating an event needs its kind; the kind and its starting colour are saved, and the name example follows it', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: { events: {} } });
  const alerts = [];
  page.on('dialog', (d) => { alerts.push(d.message()); d.accept(); });
  await page.goto('/app.html');
  await page.locator('#create-toggle-btn').click();
  await expect(page.locator('#ev-type-picker .type-btn.on')).toHaveCount(0);
  // Until a kind is picked, the example cycles through the kinds.
  await expect(page.locator('#ev-name')).toHaveAttribute('placeholder', /حفل تخرج دفعة 2026/, { timeout: 6000 });

  await page.locator('#ev-name').fill('تخرج نورة');
  await page.getByRole('button', { name: 'إنشاء', exact: true }).click();
  await expect.poll(() => alerts.length).toBe(1);
  expect(alerts[0]).toContain('اختر نوع المناسبة');
  await expect(page).toHaveURL(/app\.html/);

  await page.getByRole('radio', { name: 'تخرج' }).click();
  await expect(page.getByRole('radio', { name: 'تخرج' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#ev-name')).toHaveAttribute('placeholder', 'اسم المناسبة (مثال: حفل تخرج دفعة 2026)');
  // The page moves on to the new dashboard (and the fake store resets) as soon
  // as the event is saved, so the saved event is copied into sessionStorage,
  // which survives that move.
  await page.evaluate(() => {
    const orig = window._fsFns.runTransaction;
    window._fsFns.runTransaction = async (...args) => {
      const r = await orig(...args);
      sessionStorage.setItem('__savedEvents', JSON.stringify(Object.values(window.__fakeFirebase.store.events || {})));
      return r;
    };
  });
  await page.getByRole('button', { name: 'إنشاء', exact: true }).click();
  await page.waitForURL(/event\.html\?id=/);
  const saved = JSON.parse(await page.evaluate(() => sessionStorage.getItem('__savedEvents')));
  expect(saved.map(e => ({ type: e.type, theme: e.theme }))).toEqual([{ type: 'graduation', theme: 'sapphire' }]);
});

test('a refresh button forces a real reload — no address bar to pull down on, installed as a PWA', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: { events: {} } });
  await page.goto('/app.html');
  await expect(page.locator('#app-view')).toBeVisible();
  await page.evaluate(() => { window.__beforeReload = true; });
  await Promise.all([page.waitForEvent('load'), page.getByTitle('تحديث الصفحة').click()]);
  expect(await page.evaluate(() => window.__beforeReload)).toBeUndefined();
});

test('Arabic counted nouns: 1 singular, 2 dual, 3-10 plural, 11+ singular again', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: null });
  await page.goto('/app.html');
  const words = await page.evaluate(() => [0, 1, 2, 3, 5, 10, 11, 15, 100, 200].map(n => guestWord(n)));
  expect(words).toEqual(['ضيف', 'ضيف', 'ضيفين', 'ضيوف', 'ضيوف', 'ضيوف', 'ضيف', 'ضيف', 'ضيف', 'ضيف']);
  const days = await page.evaluate(() => [1, 2, 4, 12].map(n => arPlural(n, 'يوم', 'يومين', 'أيام')));
  expect(days).toEqual(['يوم', 'يومين', 'أيام', 'يوم']);
});

test('the phone keyboard\'s Go key (Enter in the password field) logs in — a real form, not just a button', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: null });
  await page.goto('/app.html');
  await page.locator('#auth-email').fill('someone@example.com');
  await page.locator('#auth-pass').fill('whatever123');
  await page.locator('#auth-pass').press('Enter');
  await expect(page.locator('#app-view')).toBeVisible();
  await expect(page.locator('#auth-email')).toHaveAttribute('autocomplete', 'email');
});

test('the login button shows it is working and can\'t be pressed twice while waiting', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: null });
  await page.goto('/app.html');
  await page.locator('#auth-email').fill('someone@example.com');
  await page.locator('#auth-pass').fill('whatever123');
  const state = await page.evaluate(() => {
    submitAuth();
    const b = document.getElementById('auth-submit-btn');
    return { disabled: b.disabled, text: b.textContent };
  });
  expect(state).toEqual({ disabled: true, text: '⏳ جاري الدخول...' });
});

test('the create-event button shows it is working, and Enter on the keyboard submits the form', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: { events: {} } });
  await page.goto('/app.html');
  await page.locator('#create-toggle-btn').click();
  await page.getByRole('radio', { name: 'زفاف' }).click();
  await page.locator('#ev-name').fill('زفاف تجريبي');
  const state = await page.evaluate(() => {
    createNewEvent();
    const b = document.getElementById('create-submit-btn');
    return { disabled: b.disabled, text: b.textContent };
  });
  expect(state).toEqual({ disabled: true, text: '⏳ جاري الإنشاء...' });
  await page.waitForURL(/event\.html\?id=/);

  await page.goto('/app.html');
  await page.locator('#create-toggle-btn').click();
  await page.getByRole('radio', { name: 'زفاف' }).click();
  await page.locator('#ev-name').fill('زفاف ثاني');
  await page.locator('#ev-venue').fill('الرياض');
  await page.locator('#ev-venue').press('Enter');
  await page.waitForURL(/event\.html\?id=/);
});

test('sign-in starts without the popup/redirect helper (it made iPhones wait on an extra Google iframe every page load)', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: null });
  await page.goto('/app.html');
  await expect(page.locator('#auth-view')).toBeVisible();
  expect(await page.evaluate(() => window.__fakeFirebase.authInitOptions)).toEqual({
    persistence: ['indexedDBLocalPersistence', 'browserLocalPersistence', 'browserSessionPersistence'],
    hasPopupRedirectResolver: false,
  });
});

test('the create form limits the name, venue and map link to 80, 100 and 300 characters', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: { events: {} } });
  await page.goto('/app.html');
  await expect(page.locator('#ev-name')).toHaveAttribute('maxlength', '80');
  await expect(page.locator('#ev-venue')).toHaveAttribute('maxlength', '100');
  await expect(page.locator('#ev-maps')).toHaveAttribute('maxlength', '300');
});

test('the events list remembers each event\'s kind for its splash, with no extra reads', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: {
      events: {
        e1: { name: 'زفاف', ownerUid: 'u1', date: '', venue: '', createdAt: { seconds: 1 }, guestCount: 0 },
        e2: { name: 'تخرج', ownerUid: 'u1', type: 'graduation', date: '', venue: '', createdAt: { seconds: 2 }, guestCount: 0 },
        e3: { name: 'فعالية', ownerUid: 'u1', type: 'event', date: '', venue: '', createdAt: { seconds: 3 }, guestCount: 0 },
      },
      'events/e1/guests': {}, 'events/e2/guests': {}, 'events/e3/guests': {},
    },
  });
  await page.goto('/app.html');
  await expect(page.locator('#events-list')).toContainText('تخرج');
  const kinds = await page.evaluate(() => ['e1', 'e2', 'e3'].map(i => localStorage.getItem('ev_kind_' + i)));
  expect(kinds).toEqual(['wedding', 'graduation', 'event']);
  await expect.poll(() => page.evaluate(() => (window.__fakeFirebase.getDocsPaths || []).filter(x => x === 'events/e1/guests').length)).toBe(1);
});

const DEL_EVENT = { name: 'زفاف "سارة" <b>x</b>', ownerUid: 'u1', date: '', venue: '', createdAt: { seconds: 1 } };
const DEL_STORE = () => ({
  events: { e1: { ...DEL_EVENT } },
  'events/e1/guests': { g1: { id: 'g1', name: 'أحمد' } },
  'events/e1/requests': {},
});

test('the trash button on an event card asks for «حذف» in a modal; cancelling keeps the event', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: DEL_STORE() });
  await page.goto('/app.html');
  await page.locator('.event-card').getByRole('button', { name: 'حذف' }).click();
  const modal = page.locator('#delete-event-modal');
  await expect(modal).toBeVisible();
  // The name is text, not markup.
  await expect(modal.locator('.del-ev-name')).toHaveText('زفاف "سارة" <b>x</b>');
  await expect(modal.locator('.del-ev-name b')).toHaveCount(0);
  await expect(modal.locator('.del-ev-confirm')).toBeDisabled();
  await modal.locator('.del-ev-cancel').click();
  await expect(modal).toHaveCount(0);
  const store = await page.evaluate(() => window.__fakeFirebase.store);
  expect(store.events.e1).toBeTruthy();
  expect(Object.keys(store['events/e1/guests'])).toEqual(['g1']);
});

test('typing «حذف» in the modal and confirming removes the event from the store and the list', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: DEL_STORE() });
  await page.goto('/app.html');
  await page.locator('.event-card').getByRole('button', { name: 'حذف' }).click();
  await page.locator('#del-ev-input').fill('حذف');
  await page.locator('#delete-event-modal .del-ev-confirm').click();
  await expect.poll(() => page.evaluate(() => !!window.__fakeFirebase.store.events.e1)).toBe(false);
  expect(await page.evaluate(() => Object.keys(window.__fakeFirebase.store['events/e1/guests'] || {}).length)).toBe(0);
  await expect(page.locator('.event-card')).toHaveCount(0);
});
