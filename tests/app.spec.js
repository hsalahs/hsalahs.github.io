const { test, expect } = require('@playwright/test');
const { stubSupabase, seedAppStore } = require('./helpers');

const CUST = { id: 'u1', email: 'customer@example.com' };
const ADM = { id: 'admin-uid', email: 'hsallah@outlook.sa' };
const NO_CAP = { u1: { event_limit: 1, event_count: 0 } };

// Runs one poll of the events list now (the real timer is 15 s / 30 s).
const poll = (page) => page.evaluate(() => refreshEvents());
const srv = (page, fn, arg) => page.evaluate(fn, arg);

async function open(page, seed, url = '/app.html') {
  await stubSupabase(page);
  await seedAppStore(page, seed);
  await page.goto(url);
}

test('shows the login form when signed out', async ({ page }) => {
  await open(page, { user: null });
  await expect(page.locator('#auth-view')).toBeVisible();
  await expect(page.locator('#app-view')).toBeHidden();
  await expect(page.locator('#auth-card')).toBeVisible();
  await expect(page.locator('#check-email-card')).toBeHidden();
  await expect(page.locator('#recovery-card')).toBeHidden();
});

test('a customer with no events yet sees the create button', async ({ page }) => {
  await open(page, { user: CUST, events: [] });
  await expect(page.locator('#app-view')).toBeVisible();
  await expect(page.locator('#events-heading')).toHaveText('مناسباتي');
  await expect(page.locator('#create-toggle-btn')).toBeVisible();
  await expect(page.locator('#limit-box')).toBeHidden();
});

test('a customer at their event limit sees the self-serve upgrade button, not the create button', async ({ page }) => {
  await open(page, {
    user: CUST,
    events: [{ id: 'e1', name: 'Test Event', owner_email: CUST.email, date: '2026-01-01' }],
    limits: { u1: { event_limit: 1, event_count: 1 } },
  });
  await expect(page.locator('#create-toggle-btn')).toBeHidden();
  await expect(page.locator('#limit-box')).toBeVisible();
  await expect(page.locator('#request-more-btn')).toHaveText('فتح مناسبة إضافية');
});

test('a customer already at the auto-approve ceiling must request admin approval instead', async ({ page }) => {
  await open(page, {
    user: CUST,
    events: [{ id: 'e1', name: 'E1' }, { id: 'e2', name: 'E2' }, { id: 'e3', name: 'E3' }],
    limits: { u1: { event_limit: 3, event_count: 3 } },
  });
  await expect(page.locator('#request-more-btn')).toHaveText('اطلب مناسبة إضافية');
});

test('the self-serve upgrade raises the limit at once and opens the create button', async ({ page }) => {
  await open(page, {
    user: CUST,
    events: [{ id: 'e1', name: 'E1' }],
    limits: { u1: { event_limit: 1, event_count: 1 } },
  });
  await page.locator('#request-more-btn').click();
  await expect(page.locator('#create-toggle-btn')).toBeVisible();
  await expect(page.locator('#limit-box')).toBeHidden();
  expect(await srv(page, () => window.__fakeSupabase.limits.u1.event_limit)).toBe(2);
});

test('a request for an extra event is sent once, the admin is told once, and the waiting message shows', async ({ page }) => {
  await open(page, {
    user: CUST,
    events: [{ id: 'e1', name: 'E1' }, { id: 'e2', name: 'E2' }, { id: 'e3', name: 'E3' }],
    limits: { u1: { event_limit: 3, event_count: 3 } },
  });
  await page.locator('#request-more-btn').click();
  await expect(page.locator('#pending-request-msg')).toBeVisible();
  await expect(page.locator('#request-more-btn')).toBeHidden();
  const rows = () => srv(page, () => window.__fakeSupabase.eventRequests.map((r) => r.status + ':' + r.uid));
  expect(await rows()).toEqual(['pending:u1']);
  // a stale second tap (the button is gone, so call the handler) changes nothing
  await srv(page, () => { myPendingRequestId = null; return requestExtraEvent(); });
  expect(await rows()).toEqual(['pending:u1']);
});

test('a pending request found on load shows the waiting message', async ({ page }) => {
  await open(page, {
    user: CUST,
    events: [{ id: 'e1', name: 'E1' }, { id: 'e2', name: 'E2' }, { id: 'e3', name: 'E3' }],
    limits: { u1: { event_limit: 3, event_count: 3 } },
    eventRequests: [{ id: 'r1', uid: 'u1', email: CUST.email, status: 'pending', requested_at: '2026-01-01T00:00:00.000000+00:00' }],
  });
  await expect(page.locator('#pending-request-msg')).toBeVisible();
});

test('the admin account sees every event, not just their own, and bypasses the limit', async ({ page }) => {
  await open(page, {
    user: ADM, admin: true,
    events: [
      { id: 'e1', name: 'Customer A Event', owner_uid: 'u1', owner_email: 'a@example.com' },
      { id: 'e2', name: 'Customer B Event', owner_uid: 'u2', owner_email: 'b@example.com' },
    ],
  });
  await expect(page.locator('#events-heading')).toHaveText('كل المناسبات (أدمن)');
  await expect(page.locator('#events-list')).toContainText('Customer A Event');
  await expect(page.locator('#events-list')).toContainText('Customer B Event');
  await expect(page.locator('#create-toggle-btn')).toBeVisible();
});

test('a customer is never shown the admin screens, and only gets their own events', async ({ page }) => {
  await open(page, {
    user: CUST,
    events: [
      { id: 'e1', name: 'Mine', owner_uid: 'u1' },
      { id: 'e2', name: 'Someone else', owner_uid: 'u2' },
    ],
    users: [{ uid: 'u9', email: 'x@y.com', created_at: '2026-01-01T00:00:00.000000+00:00' }],
  });
  await expect(page.locator('#events-list')).toContainText('Mine');
  await expect(page.locator('#events-list')).not.toContainText('Someone else');
  await expect(page.locator('#admin-accounts-section')).toBeHidden();
  await expect(page.locator('#admin-requests-section')).toBeHidden();
  const admin = await srv(page, () => window.__fakeSupabase.calls.map((c) => c.name).filter((n) => /^admin_/.test(n)));
  expect(admin).toEqual([]);
});

test('the admin screens wait for the server\'s answer: an account the server does not call admin gets the customer view', async ({ page }) => {
  // same e-mail as the admin but not in the server's admin list
  await open(page, { user: ADM, admin: false, events: [{ id: 'e1', name: 'Mine', owner_uid: 'admin-uid' }], limits: { 'admin-uid': { event_limit: 1, event_count: 1 } } });
  await expect(page.locator('#events-heading')).toHaveText('مناسباتي');
  await expect(page.locator('#limit-box')).toBeVisible();
});

test('the events list never reads a guest: the numbers come from the event row and follow its changes', async ({ page }) => {
  await open(page, {
    user: ADM, admin: true,
    events: [
      { id: 'e1', name: 'Customer A Event', owner_uid: 'u1', guest_count: 10, scanned_count: 4 },
      { id: 'e2', name: 'Customer B Event', owner_uid: 'u2', guest_count: 0 },
    ],
  });
  await expect(page.locator('#events-list')).toContainText('Customer A Event');
  const stats = (name) => page.locator('.event-card', { hasText: name }).locator('.event-stat .n');
  await expect(stats('Customer A Event')).toHaveText(['10', '4']);
  await expect(page.locator('.event-card', { hasText: 'Customer A Event' }).locator('.att-pct')).toHaveText('40%');
  await srv(page, () => { window.__fakeSupabase.events.e1.scanned_count = 5; });
  await poll(page);
  await expect(stats('Customer A Event')).toHaveText(['10', '5']);
  await expect(page.locator('.event-card', { hasText: 'Customer A Event' }).locator('.att-pct')).toHaveText('50%');
  const names = await srv(page, () => window.__fakeSupabase.calls.map((c) => c.name));
  expect(names.filter((n) => /guest/.test(n))).toEqual([]);
});

test('an event with no check-ins yet shows 0 attended (with the bar at 0%); an empty one shows 0 and 0', async ({ page }) => {
  await open(page, {
    user: CUST,
    events: [{ id: 'e1', name: 'قديمة', guest_count: 7 }, { id: 'e2', name: 'فارغة', guest_count: 0 }],
  });
  const card = (name) => page.locator('.event-card', { hasText: name });
  await expect(card('قديمة').locator('.event-stat .n')).toHaveText(['7', '0']);
  await expect(card('قديمة').locator('.att-pct')).toHaveText('0%');
  await expect(card('فارغة').locator('.event-stat .n')).toHaveText(['0', '0']);
});

test('the admin sees a counter banner for unpaid events, and each event has one unified card with its own activate button', async ({ page }) => {
  await open(page, {
    user: ADM, admin: true,
    events: [
      { id: 'e1', name: 'Zara Wedding', owner_uid: 'u1', owner_email: 'a@example.com', paid: false },
      { id: 'e2', name: 'Layla Wedding', owner_uid: 'u2', owner_email: 'b@example.com', paid: true },
    ],
  });
  page.on('dialog', d => d.type() === 'prompt' ? d.accept('120') : d.accept());
  await expect(page.locator('#admin-unpaid-section')).toBeVisible();
  await expect(page.locator('#admin-unpaid-badge')).toHaveText('1');
  await expect(page.locator('#admin-unpaid-section')).not.toContainText('Zara Wedding');

  const unpaidCard = page.locator('.event-card', { hasText: 'Zara Wedding' });
  await expect(unpaidCard.getByRole('button', { name: 'تفعيل' })).toBeVisible();
  const paidCard = page.locator('.event-card', { hasText: 'Layla Wedding' });
  await expect(paidCard.getByRole('button', { name: 'تفعيل' })).toHaveCount(0);

  await unpaidCard.getByRole('button', { name: 'تفعيل' }).click();
  await expect(page.locator('#admin-unpaid-section')).toBeHidden();
  await expect(unpaidCard.getByRole('button', { name: 'تفعيل' })).toHaveCount(0);
  await expect(unpaidCard).toContainText('مفعّلة (120 ضيف)');
  expect(await srv(page, () => window.__fakeSupabase.events.e1.guest_limit)).toBe(120);
});

test('cancelling the number prompt leaves the event unactivated', async ({ page }) => {
  await open(page, { user: ADM, admin: true, events: [{ id: 'e1', name: 'Zara Wedding', owner_uid: 'u1', paid: false }] });
  page.on('dialog', d => d.dismiss());
  await page.locator('.event-card', { hasText: 'Zara Wedding' }).getByRole('button', { name: 'تفعيل' }).click();
  await expect(page.locator('#admin-unpaid-badge')).toHaveText('1');
  expect(await srv(page, () => window.__fakeSupabase.events.e1.paid)).toBe(false);
  const calls = await srv(page, () => window.__fakeSupabase.calls.map((c) => c.name));
  expect(calls).not.toContain('admin_activate_event');
});

test('the admin sees every account that ever registered, even one with no event', async ({ page }) => {
  await open(page, {
    user: ADM, admin: true, events: [],
    users: [{ uid: 'u1', email: 'noevent@example.com', created_at: '2023-11-14T22:13:20.000000+00:00' }],
  });
  await expect(page.locator('#admin-accounts-section')).toBeVisible();
  await expect(page.locator('#admin-accounts-badge')).toHaveText('1');
  await page.locator('#admin-accounts-toggle').click();
  await expect(page.locator('#admin-accounts-list')).toContainText('noevent@example.com');
});

test('each account shows what it has done; the filters narrow the list; tapping one shows only its events', async ({ page }) => {
  await open(page, {
    user: ADM, admin: true,
    events: [
      { id: 'e1', name: 'حفل تجربة', owner_uid: 'u1', owner_email: 'trial@example.com', paid: false, guest_count: 1 },
      { id: 'e2', name: 'حفل مدفوع', owner_uid: 'u2', owner_email: 'paid@example.com', paid: true, guest_limit: 100 },
    ],
    users: [
      { uid: 'u1', email: 'trial@example.com', created_at: '2023-11-14T22:13:23.000000+00:00' },
      { uid: 'u2', email: 'paid@example.com', created_at: '2023-11-14T22:13:22.000000+00:00' },
      { uid: 'u3', email: 'none@example.com', created_at: '2023-11-14T22:13:21.000000+00:00' },
    ],
  });
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
  await open(page, {
    user: ADM, admin: true, events: [],
    users: [
      { uid: 'u1', email: 'first@example.com', created_at: '2023-11-14T22:13:20.000000+00:00' },
      { uid: 'u2', email: 'second@other.com', created_at: '2023-11-14T22:15:00.000000+00:00' },
    ],
  });
  await expect(page.locator('#admin-accounts-badge')).toHaveText('2');
  await expect(page.locator('#admin-accounts-body')).toBeHidden();
  const reads = () => srv(page, () => ({
    full: window.__fakeSupabase.calls.filter((c) => c.name === 'admin_list_users').length,
    count: window.__fakeSupabase.calls.filter((c) => c.name === 'admin_user_count').length,
  }));
  const first = await reads();
  expect(first.full).toBe(0);
  expect(first.count).toBeGreaterThanOrEqual(1);

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

test('the admin can remove an account from the list — only its list row, never the customer\'s events', async ({ page }) => {
  await open(page, {
    user: ADM, admin: true,
    events: [{ id: 'e1', name: 'Kept Event', owner_uid: 'u1', owner_email: 'gone@example.com' }],
    users: [
      { uid: 'u1', email: 'gone@example.com', created_at: '2023-11-14T22:13:20.000000+00:00' },
      { uid: 'u2', email: 'stays@example.com', created_at: '2023-11-14T22:15:00.000000+00:00' },
    ],
  });
  await page.locator('#admin-accounts-toggle').click();
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  await page.locator('#admin-accounts-list .event-card-top', { hasText: 'gone@example.com' }).locator('.acc-del-btn').click();
  await expect(page.locator('#admin-accounts-list .event-name')).toHaveText(['stays@example.com']);
  await expect(page.locator('#admin-accounts-badge')).toHaveText('1');
  expect(dialogs[0]).toContain('حساب العميل ومناسباته ما تتأثر');
  const st = await srv(page, () => ({ users: window.__fakeSupabase.users.map((u) => u.uid), ev: window.__fakeSupabase.events.e1.name }));
  expect(st).toEqual({ users: ['u2'], ev: 'Kept Event' });
  const calls = await srv(page, () => window.__fakeSupabase.calls.map((c) => c.name));
  expect(calls).toContain('admin_remove_user_record');
  expect(calls).not.toContain('admin_delete_user');
});

test('cancelling the confirmation keeps the account in the list', async ({ page }) => {
  await open(page, { user: ADM, admin: true, events: [], users: [{ uid: 'u1', email: 'keep@example.com', created_at: '2023-11-14T22:13:20.000000+00:00' }] });
  await page.locator('#admin-accounts-toggle').click();
  page.on('dialog', d => d.dismiss());
  await page.locator('.acc-del-btn').click();
  await expect(page.locator('#admin-accounts-list .event-name')).toHaveText(['keep@example.com']);
  expect(await srv(page, () => window.__fakeSupabase.users.map((u) => u.uid))).toEqual(['u1']);
});

test.describe('in Riyadh time', () => {
  test.use({ timezoneId: 'Asia/Riyadh' });
  test('each account shows the time it registered, 12-hour with ص/م and Western digits', async ({ page }) => {
    await open(page, {
      user: ADM, admin: true, events: [],
      users: [
        { uid: 'u1', email: 'night@example.com', created_at: '2023-11-14T22:13:20.000000+00:00' },  // 01:13 Riyadh
        { uid: 'u2', email: 'noon@example.com', created_at: '2023-11-15T10:00:00.000000+00:00' },   // 13:00 Riyadh
      ],
    });
    await page.locator('#admin-accounts-toggle').click();
    const list = page.locator('#admin-accounts-list');
    await expect(list).toContainText('سجّل: 15 نوفمبر 2023 · 1:13 ص');
    await expect(list).toContainText('سجّل: 15 نوفمبر 2023 · 1:00 م');
    expect(await list.innerText()).not.toMatch(/[٠-٩]/);
  });
});

test('the admin sees the pending extra-event requests and can accept or refuse them', async ({ page }) => {
  await open(page, {
    user: ADM, admin: true, events: [],
    limits: { u1: { event_limit: 3, event_count: 3 } },
    eventRequests: [
      { id: 'r1', uid: 'u1', email: 'one@example.com', status: 'pending', requested_at: '2026-01-01T00:00:00.000000+00:00' },
      { id: 'r2', uid: 'u2', email: 'two@example.com', status: 'pending', requested_at: '2026-01-02T00:00:00.000000+00:00' },
    ],
  });
  await expect(page.locator('#admin-requests-badge')).toHaveText('2');
  const card = (mail) => page.locator('#admin-requests-list .card', { hasText: mail });
  await card('one@example.com').getByRole('button', { name: 'قبول' }).click();
  await expect(page.locator('#admin-requests-badge')).toHaveText('1');
  await card('two@example.com').getByRole('button', { name: 'رفض' }).click();
  await expect(page.locator('#admin-requests-section')).toBeHidden();
  const st = await srv(page, () => ({ lim: window.__fakeSupabase.limits.u1.event_limit, l2: window.__fakeSupabase.limits.u2, st: window.__fakeSupabase.eventRequests.map((r) => r.status) }));
  expect(st).toEqual({ lim: 4, l2: undefined, st: ['approved', 'rejected'] });
});

test('a request someone else already handled is not an error for the admin', async ({ page }) => {
  await open(page, {
    user: ADM, admin: true, events: [],
    eventRequests: [{ id: 'r1', uid: 'u1', email: 'one@example.com', status: 'pending', requested_at: '2026-01-01T00:00:00.000000+00:00' }],
  });
  const alerts = [];
  page.on('dialog', d => { alerts.push(d.message()); d.accept(); });
  await expect(page.locator('#admin-requests-badge')).toHaveText('1');
  await srv(page, () => { window.__fakeSupabase.eventRequests[0].status = 'approved'; });
  await page.locator('#admin-requests-list').getByRole('button', { name: 'قبول' }).click();
  await expect(page.locator('#admin-requests-section')).toBeHidden();
  expect(alerts).toEqual([]);
});

test('the admin is told when an event with an admin-set number reaches it', async ({ page }) => {
  await open(page, { user: ADM, admin: true, events: [{ id: 'e1', name: 'Big Wedding', owner_uid: 'u1', paid: true, guest_limit: 50, guest_count: 49 }] });
  await expect(page.locator('.event-card', { hasText: 'Big Wedding' })).toContainText('مفعّلة (50 ضيف)');
  await srv(page, () => { window.__fakeSupabase.events.e1.guest_count = 50; });
  await poll(page);
  await expect(page.locator('#toast')).toContainText('Big Wedding');
  await expect(page.locator('#toast')).toContainText('لحد الضيوف (50)');
});

test('the admin gets a live toast when an event crosses the free-guest cap while watching, not for ones already capped on load', async ({ page }) => {
  await open(page, {
    user: ADM, admin: true,
    events: [
      { id: 'e1', name: 'Already Capped', owner_uid: 'u1', paid: false, guest_count: 5 },
      { id: 'e2', name: 'About To Cap', owner_uid: 'u2', paid: false, guest_count: 4 },
    ],
  });
  await expect(page.locator('#admin-unpaid-badge')).toHaveText('2');
  await expect(page.locator('#toast')).not.toContainText('Already Capped');
  await srv(page, () => { window.__fakeSupabase.events.e2.guest_count = 5; });
  await poll(page);
  await expect(page.locator('#toast')).toContainText('About To Cap');
});

test('the admin gets a one-time nudge toast on a fresh page load when unpaid events are already capped', async ({ page }) => {
  await open(page, {
    user: ADM, admin: true,
    events: [
      { id: 'e1', name: 'Already Capped 1', owner_uid: 'u1', paid: false, guest_count: 5 },
      { id: 'e2', name: 'Already Capped 2', owner_uid: 'u2', paid: false, guest_count: 6 },
    ],
  });
  await expect(page.locator('#toast')).toContainText('2 مناسبتين وصلت لحد الضيوف');
  await expect(page.locator('#toast')).not.toContainText('Already Capped');
});

test('an anonymous door-scanner identity left on the same browser does not pass for a logged-in customer', async ({ page }) => {
  await stubSupabase(page);
  const { seedFakeSupabase } = require('./helpers');
  await seedFakeSupabase(page, { user: { id: 'anon-1', is_anonymous: true, email: null } });
  await page.goto('/app.html');
  await expect(page.locator('#auth-view')).toBeVisible();
  await expect(page.locator('#app-view')).toBeHidden();
});

test('the events list shows each event date as words with Western digits', async ({ page }) => {
  await open(page, { user: CUST, events: [{ id: 'e1', name: 'Test Event', date: '2026-10-29', venue: 'الرياض' }], limits: { u1: { event_limit: 1, event_count: 1 } } });
  await expect(page.locator('.event-date').first()).toContainText('الخميس 29 أكتوبر 2026');
});

test('the new-event form has a cancel button that closes it and clears what was typed, without creating anything', async ({ page }) => {
  await open(page, { user: CUST, events: [] });
  let dialogs = 0;
  page.on('dialog', (d) => { dialogs++; d.accept(); });
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
  expect(dialogs).toBe(0);
  expect(await srv(page, () => Object.keys(window.__fakeSupabase.events).length)).toBe(0);
  expect(await srv(page, () => window.__fakeSupabase.calls.filter((c) => c.name === 'create_event').length)).toBe(0);

  await page.locator('#create-toggle-btn').click();
  for (const id of ['ev-name', 'ev-date', 'ev-venue', 'ev-maps']) await expect(page.locator('#' + id)).toHaveValue('');
});

test('cancelling an untouched form just closes it, and creating an event still works afterwards', async ({ page }) => {
  await open(page, { user: CUST, events: [] });
  page.on('dialog', (d) => d.accept());
  await page.locator('#create-toggle-btn').click();
  await page.locator('#create-cancel-btn').click();
  await expect(page.locator('#create-form')).toBeHidden();

  await page.locator('#create-toggle-btn').click();
  await page.getByRole('radio', { name: 'زفاف' }).click();
  await page.locator('#ev-name').fill('عرس حقيقي');
  await page.getByRole('button', { name: 'إنشاء', exact: true }).click();
  await expect(page).toHaveURL(/event\.html\?id=/);
});

test('creating an event needs its kind; the kind and its starting colour are saved, and the name example follows it', async ({ page }) => {
  await stubSupabase(page);
  const saved = [];
  await page.exposeFunction('__onCreateEvent', (json) => { saved.push(JSON.parse(json)); });
  await seedAppStore(page, { user: CUST, events: [] });
  const alerts = [];
  page.on('dialog', (d) => { alerts.push(d.message()); d.accept(); });
  await page.goto('/app.html');
  await page.locator('#create-toggle-btn').click();
  await expect(page.locator('#ev-type-picker .type-btn.on')).toHaveCount(0);
  await expect(page.locator('#ev-name')).toHaveAttribute('placeholder', /حفل تخرج دفعة 2026/, { timeout: 6000 });

  await page.locator('#ev-name').fill('تخرج نورة');
  await page.getByRole('button', { name: 'إنشاء', exact: true }).click();
  await expect.poll(() => alerts.length).toBe(1);
  expect(alerts[0]).toContain('اختر نوع المناسبة');
  await expect(page).toHaveURL(/app\.html/);

  await page.getByRole('radio', { name: 'تخرج' }).click();
  await expect(page.getByRole('radio', { name: 'تخرج' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#ev-name')).toHaveAttribute('placeholder', 'اسم المناسبة (مثال: حفل تخرج دفعة 2026)');
  await page.getByRole('button', { name: 'إنشاء', exact: true }).click();
  await page.waitForURL(/event\.html\?id=/);
  expect(saved.map(e => ({ type: e.type, theme: e.theme, name: e.name }))).toEqual([{ type: 'graduation', theme: 'sapphire', name: 'تخرج نورة' }]);
});

test('hitting the event limit on the server shows the limit message and refreshes the page state', async ({ page }) => {
  await open(page, { user: CUST, events: [], limits: { u1: { event_limit: 1, event_count: 0 } } });
  const alerts = [];
  page.on('dialog', (d) => { alerts.push(d.message()); d.accept(); });
  await page.locator('#create-toggle-btn').click();
  await page.getByRole('radio', { name: 'زفاف' }).click();
  await page.locator('#ev-name').fill('عرس');
  // another tab used the only slot meanwhile
  await srv(page, () => { window.__fakeSupabase.limits.u1.event_count = 1; });
  await page.getByRole('button', { name: 'إنشاء', exact: true }).click();
  await expect.poll(() => alerts.length).toBe(1);
  expect(alerts[0]).toContain('عندك مناسبة وحدة مفعّلة');
  await expect(page.locator('#limit-box')).toBeVisible();
  await expect(page.locator('#create-submit-btn')).toBeEnabled();
});

test('a refresh button forces a real reload — no address bar to pull down on, installed as a PWA', async ({ page }) => {
  await open(page, { user: CUST, events: [] });
  await expect(page.locator('#app-view')).toBeVisible();
  await page.evaluate(() => { window.__beforeReload = true; });
  await Promise.all([page.waitForEvent('load'), page.getByTitle('تحديث الصفحة').click()]);
  expect(await page.evaluate(() => window.__beforeReload)).toBeUndefined();
});

test('Arabic counted nouns: 1 singular, 2 dual, 3-10 plural, 11+ singular again', async ({ page }) => {
  await open(page, { user: null });
  const words = await page.evaluate(() => [0, 1, 2, 3, 5, 10, 11, 15, 100, 200].map(n => guestWord(n)));
  expect(words).toEqual(['ضيف', 'ضيف', 'ضيفين', 'ضيوف', 'ضيوف', 'ضيوف', 'ضيف', 'ضيف', 'ضيف', 'ضيف']);
  const days = await page.evaluate(() => [1, 2, 4, 12].map(n => arPlural(n, 'يوم', 'يومين', 'أيام')));
  expect(days).toEqual(['يوم', 'يومين', 'أيام', 'يوم']);
});

test('the create-event button shows it is working, and Enter on the keyboard submits the form', async ({ page }) => {
  await open(page, { user: CUST, events: [], limits: { u1: { event_limit: 3, event_count: 0 } } });
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

  await open(page, { user: CUST, events: [] });
  await page.locator('#create-toggle-btn').click();
  await page.getByRole('radio', { name: 'زفاف' }).click();
  await page.locator('#ev-name').fill('زفاف ثاني');
  await page.locator('#ev-venue').fill('الرياض');
  await page.locator('#ev-venue').press('Enter');
  await page.waitForURL(/event\.html\?id=/);
});

test('the create form limits the name, venue and map link to 80, 100 and 300 characters', async ({ page }) => {
  await open(page, { user: CUST, events: [] });
  await expect(page.locator('#ev-name')).toHaveAttribute('maxlength', '80');
  await expect(page.locator('#ev-venue')).toHaveAttribute('maxlength', '100');
  await expect(page.locator('#ev-maps')).toHaveAttribute('maxlength', '300');
});

test('the events list remembers each event\'s kind for its splash, with no extra reads', async ({ page }) => {
  await open(page, {
    user: CUST,
    events: [
      { id: 'e1', name: 'زفاف' },
      { id: 'e2', name: 'تخرج', type: 'graduation' },
      { id: 'e3', name: 'فعالية', type: 'event' },
    ],
    limits: { u1: { event_limit: 3, event_count: 3 } },
  });
  await expect(page.locator('#events-list')).toContainText('تخرج');
  const kinds = await page.evaluate(() => ['e1', 'e2', 'e3'].map(i => localStorage.getItem('ev_kind_' + i)));
  expect(kinds).toEqual(['wedding', 'graduation', 'event']);
});

const DEL_EVENT = { id: 'e1', name: 'زفاف "سارة" <b>x</b>', owner_uid: 'u1' };

test('the trash button on an event card asks for «حذف» in a modal; cancelling keeps the event', async ({ page }) => {
  await open(page, { user: CUST, events: [DEL_EVENT], limits: { u1: { event_limit: 1, event_count: 1 } } });
  await page.locator('.event-card').getByRole('button', { name: 'حذف' }).click();
  const modal = page.locator('#delete-event-modal');
  await expect(modal).toBeVisible();
  await expect(modal.locator('.del-ev-name')).toHaveText('زفاف "سارة" <b>x</b>');
  await expect(modal.locator('.del-ev-name b')).toHaveCount(0);
  await expect(modal.locator('.del-ev-confirm')).toBeDisabled();
  await modal.locator('.del-ev-cancel').click();
  await expect(modal).toHaveCount(0);
  expect(await srv(page, () => !!window.__fakeSupabase.events.e1)).toBe(true);
});

test('typing «حذف» in the modal and confirming removes the event, gives the slot back and clears the list', async ({ page }) => {
  await open(page, { user: CUST, events: [DEL_EVENT], limits: { u1: { event_limit: 1, event_count: 1 } } });
  await page.locator('.event-card').getByRole('button', { name: 'حذف' }).click();
  await page.locator('#del-ev-input').fill('حذف');
  await page.locator('#delete-event-modal .del-ev-confirm').click();
  await expect(page.locator('.event-card')).toHaveCount(0);
  expect(await srv(page, () => !!window.__fakeSupabase.events.e1)).toBe(false);
  expect(await srv(page, () => window.__fakeSupabase.limits.u1.event_count)).toBe(0);
  await expect(page.locator('#create-toggle-btn')).toBeVisible();
});

test('the create form refuses a map link that is not http(s) and creates nothing', async ({ page }) => {
  await open(page, { user: CUST, events: [] });
  const alerts = [];
  page.on('dialog', (d) => { alerts.push(d.message()); d.accept(); });
  await page.locator('#create-toggle-btn').click();
  await page.getByRole('radio', { name: 'زفاف' }).click();
  await page.locator('#ev-name').fill('عرس تجريبي');
  await page.locator('#ev-maps').fill('data:text/html,<script>alert(1)</script>');
  await page.getByRole('button', { name: 'إنشاء', exact: true }).click();
  await expect.poll(() => alerts.length).toBe(1);
  expect(alerts[0]).toContain('http');
  expect(await srv(page, () => window.__fakeSupabase.calls.filter((c) => c.name === 'create_event').length)).toBe(0);
  await page.locator('#ev-maps').fill('https://maps.example.com/x');
  await page.getByRole('button', { name: 'إنشاء', exact: true }).click();
  await expect(page).toHaveURL(/event\.html\?id=/);
});

// ---- sign-in, sign-up, forgot password -----------------------------------------

test('the phone keyboard\'s Go key (Enter in the password field) logs in — a real form, not just a button', async ({ page }) => {
  await open(page, { user: null, accounts: { 'someone@example.com': { id: 'u5', password: 'whatever123', confirmed: true } } });
  await page.locator('#auth-email').fill('someone@example.com');
  await page.locator('#auth-pass').fill('whatever123');
  await page.locator('#auth-pass').press('Enter');
  await expect(page.locator('#app-view')).toBeVisible();
  await expect(page.locator('#auth-email')).toHaveAttribute('autocomplete', 'email');
});

test('the login button shows it is working and can\'t be pressed twice while waiting', async ({ page }) => {
  await open(page, { user: null, accounts: { 'someone@example.com': { id: 'u5', password: 'whatever123' } } });
  await page.locator('#auth-email').fill('someone@example.com');
  await page.locator('#auth-pass').fill('whatever123');
  const state = await page.evaluate(() => {
    submitAuth();
    const b = document.getElementById('auth-submit-btn');
    return { disabled: b.disabled, text: b.textContent };
  });
  expect(state).toEqual({ disabled: true, text: '⏳ جاري الدخول...' });
});

test('empty fields, a wrong password and an unknown e-mail are told apart from a network failure', async ({ page }) => {
  await open(page, { user: null, accounts: { 'a@example.com': { id: 'u5', password: 'right-pass' } } });
  const err = page.locator('#auth-err');
  await page.locator('#auth-submit-btn').click();
  await expect(err).toHaveText('عبّي البريد وكلمة المرور');
  await page.locator('#auth-email').fill('a@example.com');
  await page.locator('#auth-pass').fill('wrong-pass');
  await page.locator('#auth-submit-btn').click();
  await expect(err).toHaveText('البريد أو كلمة المرور غلط');
  await srv(page, () => { window.__fakeSupabase.auth.nextSignInError = { code: '', message: 'Failed to fetch', name: 'AuthRetryableFetchError', status: 0 }; });
  await page.locator('#auth-submit-btn').click();
  await expect(err).toHaveText('تعذّر الاتصال — تأكد من الإنترنت وجرّب مرة ثانية');
  await srv(page, () => { window.__fakeSupabase.auth.nextSignInError = { code: 'over_request_rate_limit', message: 'rate', status: 429 }; });
  await page.locator('#auth-submit-btn').click();
  await expect(err).toHaveText('محاولات كثيرة — انتظر شوي وجرّب مرة ثانية');
  await srv(page, () => { window.__fakeSupabase.auth.nextSignInError = { message: 'DATA_TIMEOUT', name: 'DataTimeout' }; });
  await page.locator('#auth-submit-btn').click();
  await expect(err).toHaveText('الاتصال بطيء — جرّب مرة ثانية');
});

test('an account whose e-mail is not confirmed yet is told so, and can ask for the link again', async ({ page }) => {
  await open(page, { user: null, confirmEmail: true, accounts: { 'new@example.com': { id: 'u5', password: 'secret12', confirmed: false } } });
  await srv(page, () => { window.__fakeSupabase.auth.nextSignInError = { code: 'email_not_confirmed', message: 'Email not confirmed', status: 400 }; });
  await page.locator('#auth-email').fill('new@example.com');
  await page.locator('#auth-pass').fill('secret12');
  await page.locator('#auth-submit-btn').click();
  await expect(page.locator('#auth-err')).toHaveText('فعّل بريدك أولًا — افتح الرابط اللي وصلك على بريدك');
  await expect(page.locator('#resend-row')).toBeVisible();
  await page.locator('#resend-row a').click();
  await expect(page.locator('#toast')).toContainText('أرسلنا الرابط مرة ثانية');
  expect(await srv(page, () => window.__fakeSupabase.auth.resendCalls)).toEqual(['new@example.com']);
});

test('sign-up with confirmation off goes straight in, and the account is listed for the admin', async ({ page }) => {
  await open(page, { user: null });
  await page.locator('#auth-toggle a').click();
  await expect(page.locator('#auth-submit-btn')).toHaveText('إنشاء حساب');
  await page.locator('#auth-email').fill('newcustomer@example.com');
  await page.locator('#auth-pass').fill('whatever123');
  await page.locator('#auth-submit-btn').click();
  await expect(page.locator('#app-view')).toBeVisible();
  expect(await srv(page, () => window.__fakeSupabase.users.map((u) => u.email))).toEqual(['newcustomer@example.com']);
});

test('sign-up with confirmation on shows «تفقّد بريدك», does not sign in, and can resend or go back', async ({ page }) => {
  await open(page, { user: null, confirmEmail: true });
  await page.locator('#auth-toggle a').click();
  await page.locator('#auth-email').fill('newcustomer@example.com');
  await page.locator('#auth-pass').fill('whatever123');
  await page.locator('#auth-submit-btn').click();
  const card = page.locator('#check-email-card');
  await expect(card).toBeVisible();
  await expect(page.locator('#auth-card')).toBeHidden();
  await expect(page.locator('#app-view')).toBeHidden();
  await expect(card).toContainText('تفقّد بريدك');
  await expect(page.locator('#check-email-addr')).toHaveText('newcustomer@example.com');
  await expect(card).toContainText('لو ما وصلك، شوف السبام');
  const redirect = await srv(page, () => window.__fakeSupabase.auth.signUpCalls[0].redirectTo);
  expect(redirect).toMatch(/\/app\.html$/);

  await page.locator('#check-resend-btn').click();
  await expect(page.locator('#toast')).toContainText('أرسلنا الرابط مرة ثانية');
  expect(await srv(page, () => window.__fakeSupabase.auth.resendCalls)).toEqual(['newcustomer@example.com']);
  await srv(page, () => { window.__fakeSupabase.auth.nextResendError = { code: 'over_email_send_rate_limit', message: 'rate', status: 429 }; });
  await page.locator('#check-resend-btn').click();
  await expect(page.locator('#check-email-err')).toHaveText('محاولات كثيرة — انتظر شوي وجرّب مرة ثانية');

  await card.getByText('رجوع لتسجيل الدخول').click();
  await expect(page.locator('#auth-card')).toBeVisible();
  await expect(card).toBeHidden();
  await expect(page.locator('#auth-submit-btn')).toHaveText('دخول');
});

test('signing up with an address that already exists says so, with confirmation on or off', async ({ page }) => {
  for (const confirmEmail of [false, true]) {
    await open(page, { user: null, confirmEmail, accounts: { 'taken@example.com': { id: 'u5', password: 'secret12', confirmed: true } } });
    await page.locator('#auth-toggle a').click();
    await page.locator('#auth-email').fill('taken@example.com');
    await page.locator('#auth-pass').fill('whatever123');
    await page.locator('#auth-submit-btn').click();
    await expect(page.locator('#auth-err')).toHaveText('البريد مسجّل مسبقًا — جرب تسجّل دخول');
    await expect(page.locator('#check-email-card')).toBeHidden();
  }
});

test('a weak password at sign-up is refused with the existing message', async ({ page }) => {
  await open(page, { user: null });
  await page.locator('#auth-toggle a').click();
  await page.locator('#auth-email').fill('a@example.com');
  await page.locator('#auth-pass').fill('123');
  await page.locator('#auth-submit-btn').click();
  await expect(page.locator('#auth-err')).toHaveText('كلمة المرور لازم تكون 6 أحرف على الأقل');
});

test('forgot password: needs an address first, then gives the same answer for any address', async ({ page }) => {
  await open(page, { user: null, accounts: { 'known@example.com': { id: 'u5', password: 'secret12' } } });
  await page.locator('#forgot-pass-row a').click();
  await expect(page.locator('#auth-err')).toContainText('اكتب بريدك الإلكتروني فوق الأول');
  const answers = [];
  for (const mail of ['known@example.com', 'nobody@example.com']) {
    await page.locator('#auth-email').fill(mail);
    await page.locator('#forgot-pass-row a').click();
    await expect(page.locator('#auth-ok')).toBeVisible();
    answers.push(await page.locator('#auth-ok').innerText());
    await expect(page.locator('#auth-err')).toBeHidden();
  }
  expect(answers[0]).toBe(answers[1]);
  expect(answers[0]).toContain('إذا كان البريد مسجّلًا وصلك رابط تغيير كلمة المرور');
  expect(answers[0]).toContain('تأكد من كتابة البريد صح، وتفقّد السبام');
  const calls = await srv(page, () => window.__fakeSupabase.auth.resetCalls);
  expect(calls.map((c) => c.email)).toEqual(['known@example.com', 'nobody@example.com']);
  expect(calls[0].redirectTo).toMatch(/\/app\.html$/);
});

test('forgot password: a bad address, rate limit and no network show their own message', async ({ page }) => {
  await open(page, { user: null });
  await page.locator('#auth-email').fill('bad');
  const cases = [
    [{ code: 'email_address_invalid', message: 'x', status: 400 }, 'صيغة البريد غير صحيحة'],
    [{ code: 'over_email_send_rate_limit', message: 'x', status: 429 }, 'محاولات كثيرة — انتظر شوي وجرّب مرة ثانية'],
    [{ name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 }, 'تعذّر الاتصال — تأكد من الإنترنت وجرّب مرة ثانية'],
  ];
  for (const [e, text] of cases) {
    await srv(page, (x) => { window.__fakeSupabase.auth.nextResetError = x; }, e);
    await page.locator('#forgot-pass-row a').click();
    await expect(page.locator('#auth-err')).toHaveText(text);
    await expect(page.locator('#auth-ok')).toBeHidden();
  }
});

// ---- the reset-password link and the new-password screen -------------------------

const RECOVERY = { id: 'u5', email: 'known@example.com' };
const ACCTS = { 'known@example.com': { id: 'u5', password: 'old-secret', confirmed: true } };
async function openRecovery(page, hash, extra = {}) {
  await stubSupabase(page);
  await seedAppStore(page, { user: null, accounts: ACCTS, recoveryUser: RECOVERY, ...extra });
  await page.goto('/app.html' + hash);
}

test('the reset link opens the new-password screen (same card as sign-in), never the app, and clears the tokens from the address', async ({ page }) => {
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await openRecovery(page, '#access_token=good-access&refresh_token=r-tok&expires_in=3600&token_type=bearer&type=recovery');
  await expect(page.locator('#recovery-card')).toBeVisible();
  await expect(page.locator('#auth-card')).toBeHidden();
  await expect(page.locator('#app-view')).toBeHidden();
  await expect(page.locator('#auth-sub')).toHaveText('اختر كلمة مرور جديدة لحسابك');
  await expect(page.locator('#new-pass')).toHaveAttribute('autocomplete', 'new-password');
  await expect(page.locator('#recovery-submit-btn')).toHaveText('حفظ كلمة المرور');
  expect(page.url()).not.toMatch(/access_token|refresh_token|type=recovery/);
  expect(await page.evaluate(() => location.hash)).toBe('');
  expect(logs.join('\n')).not.toMatch(/good-access|r-tok/);
  // nothing in storage keeps the raw link either
  expect(await page.evaluate(() => JSON.stringify(Object.assign({}, localStorage, sessionStorage)))).not.toMatch(/good-access|r-tok/);
});

test('saving a new password: checks the two fields, then signs the person into the app', async ({ page }) => {
  await openRecovery(page, '#access_token=good-access&refresh_token=r&type=recovery');
  const err = page.locator('#recovery-err');
  await page.locator('#recovery-submit-btn').click();
  await expect(err).toHaveText('اكتب كلمة المرور مرتين');
  await page.locator('#new-pass').fill('123');
  await page.locator('#new-pass2').fill('123');
  await page.locator('#recovery-submit-btn').click();
  await expect(err).toHaveText('كلمة المرور لازم تكون 6 أحرف على الأقل');
  await page.locator('#new-pass').fill('brand-new-1');
  await page.locator('#new-pass2').fill('brand-new-2');
  await page.locator('#recovery-submit-btn').click();
  await expect(err).toHaveText('كلمتا المرور غير متطابقتين');
  expect(await srv(page, () => window.__fakeSupabase.auth.passwordUpdates || 0)).toBe(0);

  await page.locator('#new-pass2').fill('brand-new-1');
  await page.locator('#recovery-submit-btn').click();
  await expect(page.locator('#app-view')).toBeVisible();
  await expect(page.locator('#recovery-card')).toBeHidden();
  await expect(page.locator('#toast')).toContainText('تم تغيير كلمة المرور');
  await expect(page.locator('#current-email')).toHaveText('known@example.com');
  expect(await srv(page, () => window.__fakeSupabase.auth.accounts['known@example.com'].password)).toBe('brand-new-1');
});

test('the same old password is refused with its own message and the screen stays', async ({ page }) => {
  await openRecovery(page, '#access_token=good-access&refresh_token=r&type=recovery');
  await page.locator('#new-pass').fill('old-secret');
  await page.locator('#new-pass2').fill('old-secret');
  await page.locator('#recovery-submit-btn').click();
  await expect(page.locator('#recovery-err')).toHaveText('اختر كلمة مرور مختلفة عن القديمة');
  await expect(page.locator('#recovery-card')).toBeVisible();
  await expect(page.locator('#recovery-submit-btn')).toBeEnabled();
});

test('the session ending while the person types shows the expired-link message', async ({ page }) => {
  await openRecovery(page, '#access_token=good-access&refresh_token=r&type=recovery');
  await srv(page, () => { window.__fakeSupabase.auth.nextUpdateError = { code: 'session_not_found', message: 'Auth session missing!', status: 401 }; });
  await page.locator('#new-pass').fill('brand-new-1');
  await page.locator('#new-pass2').fill('brand-new-1');
  await page.locator('#recovery-submit-btn').click();
  await expect(page.locator('#recovery-err')).toHaveText('انتهت صلاحية الرابط — اطلب رابط جديد من "نسيت كلمة المرور؟"');
});

test('cancelling the new-password screen signs out and returns to the sign-in form', async ({ page }) => {
  await openRecovery(page, '#access_token=good-access&refresh_token=r&type=recovery');
  await page.locator('#recovery-card').getByText('إلغاء').click();
  await expect(page.locator('#auth-card')).toBeVisible();
  await expect(page.locator('#app-view')).toBeHidden();
  await expect(page.locator('#auth-sub')).toHaveText('لوحة تحكم المنظّم — أنشئ دعوة رقمية لمناسبتك');
  expect(await srv(page, () => window.__fakeSupabase.auth.user)).toBeNull();
});

test('a token_hash link (custom e-mail template) works the same way', async ({ page }) => {
  await openRecovery(page, '?token_hash=good-hash&type=recovery');
  await expect(page.locator('#recovery-card')).toBeVisible();
  expect(page.url()).not.toMatch(/token_hash|type=recovery/);
  expect(await srv(page, () => window.__fakeSupabase.auth.verifyCalls)).toEqual(['recovery']);
});

test('an expired or already used link says so on the sign-in screen, and the address is cleaned', async ({ page }) => {
  for (const hash of ['#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', '#access_token=dead&refresh_token=x&type=recovery', '?token_hash=dead&type=recovery']) {
    await page.goto('about:blank');
    await openRecovery(page, hash);
    await expect(page.locator('#auth-card')).toBeVisible();
    await expect(page.locator('#recovery-card')).toBeHidden();
    await expect(page.locator('#auth-err')).toHaveText('الرابط منتهي أو مستخدم من قبل — اطلب رابط جديد من "نسيت كلمة المرور؟"');
    expect(page.url()).not.toMatch(/error|token|type=recovery/);
  }
});

test('opening the link with no network says so instead of calling it expired', async ({ page }) => {
  await openRecovery(page, '#access_token=good-access&refresh_token=r&type=recovery', { networkDown: true });
  await expect(page.locator('#auth-card')).toBeVisible();
  await expect(page.locator('#auth-err')).toHaveText('تعذّر الاتصال — افتح الرابط مرة ثانية');
});

test('a customer who is already signed in on this browser is not shown the new-password screen for a normal visit', async ({ page }) => {
  await open(page, { user: CUST, events: [] });
  await expect(page.locator('#app-view')).toBeVisible();
  await expect(page.locator('#recovery-card')).toBeHidden();
});

test('a confirmation link (type=signup) opens the app with a welcome toast and cleans the address', async ({ page }) => {
  await stubSupabase(page);
  await seedAppStore(page, { user: null, accounts: ACCTS, recoveryUser: RECOVERY });
  await page.goto('/app.html#access_token=good-access&refresh_token=r&type=signup');
  await expect(page.locator('#app-view')).toBeVisible();
  await expect(page.locator('#toast')).toContainText('تم تفعيل بريدك');
  expect(page.url()).not.toMatch(/token/);
});

test('the new-password flow works on an iPhone and an Android phone profile (Chromium with their screen, touch and user agent)', async ({ browser }) => {
  const { devices } = require('@playwright/test');
  for (const name of ['iPhone 13', 'Pixel 5']) {
    const { defaultBrowserType, ...profile } = devices[name];
    const ctx = await browser.newContext(profile);
    const page = await ctx.newPage();
    await openRecovery(page, '#access_token=good-access&refresh_token=r&type=recovery');
    await expect(page.locator('#recovery-card')).toBeVisible();
    const box = await page.locator('#recovery-submit-btn').boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(40);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator('#new-pass').fill('brand-new-1');
    await page.locator('#new-pass2').fill('brand-new-1');
    await page.locator('#new-pass2').press('Enter');
    await expect(page.locator('#app-view')).toBeVisible();
    await ctx.close();
  }
});

// ---- polling, cache, sign-out ---------------------------------------------------------

test('the customer\'s list and account are read again every 15 s, the admin\'s every 30 s', async ({ page }) => {
  await stubSupabase(page);
  await seedAppStore(page, { user: CUST, events: [{ id: 'e1', name: 'E1' }] });
  await page.clock.install();
  await page.goto('/app.html');
  await expect(page.locator('#events-list .event-card')).toHaveCount(1);
  const reads = () => srv(page, () => window.__fakeSupabase.calls.filter((c) => c.name === 'list_events').length);
  await page.waitForTimeout(300);
  const base = await reads();
  const acctBase = await srv(page, () => window.__fakeSupabase.calls.filter((c) => c.name === 'my_account').length);
  await page.clock.fastForward(8000);
  expect(await reads()).toBe(base);
  await page.clock.fastForward(9000);
  await expect.poll(reads).toBe(base + 1);
  expect(await srv(page, () => window.__fakeSupabase.calls.filter((c) => c.name === 'my_account').length)).toBe(acctBase + 1);
});

test('admin polls: events and requests every 30 s', async ({ page }) => {
  await stubSupabase(page);
  await seedAppStore(page, { user: ADM, admin: true, events: [] });
  await page.clock.install();
  await page.goto('/app.html');
  await expect(page.locator('#app-view')).toBeVisible();
  const n = (name) => srv(page, (x) => window.__fakeSupabase.calls.filter((c) => c.name === x).length, name);
  await expect.poll(() => n('admin_pending_requests')).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(300);
  const reqs = await n('admin_pending_requests'), evs = await n('list_events');
  await page.clock.fastForward(20000);
  expect(await n('admin_pending_requests')).toBe(reqs);
  expect(await n('list_events')).toBe(evs);
  await page.clock.fastForward(12000);
  await expect.poll(() => n('admin_pending_requests')).toBe(reqs + 1);
  await expect.poll(() => n('list_events')).toBe(evs + 1);
});

test('a new request that arrives while the admin watches shows up on the next poll', async ({ page }) => {
  await open(page, { user: ADM, admin: true, events: [] });
  await expect(page.locator('#admin-requests-section')).toBeHidden();
  await srv(page, () => { window.__fakeSupabase.eventRequests.push({ id: 'r9', uid: 'u9', email: 'late@example.com', status: 'pending', requested_at: '2026-02-01T00:00:00.000000+00:00' }); });
  await page.evaluate(() => refreshAdmin());
  await expect(page.locator('#admin-requests-list')).toContainText('late@example.com');
});

test('a redraw is skipped when the polled data did not change', async ({ page }) => {
  await open(page, { user: CUST, events: [{ id: 'e1', name: 'E1' }] });
  await expect(page.locator('#events-list .event-card')).toHaveCount(1);
  await page.evaluate(() => { document.querySelector('#events-list .event-card').dataset.mark = '1'; });
  await poll(page);
  expect(await page.evaluate(() => document.querySelector('#events-list .event-card').dataset.mark)).toBe('1');
});

test('the last list is painted from this browser at once, before the server answers', async ({ page }) => {
  await stubSupabase(page);
  await seedAppStore(page, { user: CUST, events: [{ id: 'e1', name: 'مناسبة جديدة' }], latency: 1500 });
  await page.addInitScript(() => {
    try {
      localStorage.setItem('app_cache_v1', JSON.stringify({ uid: 'u1', admin: false,
        events: [{ id: 'e1', ownerUid: 'u1', name: 'من الذاكرة', guestCount: 3, scannedCount: 0, paid: false, createdAt: '2026-01-01T00:00:00.000Z' }],
        acct: { eventLimit: 1, eventCount: 1, pendingRequest: null } }));
    } catch (e) {}
  });
  await page.goto('/app.html');
  await expect(page.locator('#events-list')).toContainText('من الذاكرة', { timeout: 1200 });
  await expect(page.locator('#events-list')).toContainText('مناسبة جديدة');
  await expect(page.locator('#events-list')).not.toContainText('من الذاكرة');
});

test('another account\'s cached list is never painted', async ({ page }) => {
  await stubSupabase(page);
  await seedAppStore(page, { user: CUST, events: [], latency: 1500 });
  await page.addInitScript(() => {
    try { localStorage.setItem('app_cache_v1', JSON.stringify({ uid: 'someone-else', admin: false, events: [{ id: 'x', ownerUid: 'someone-else', name: 'سر', guestCount: 0, createdAt: '2026-01-01T00:00:00.000Z' }], acct: null })); } catch (e) {}
  });
  await page.goto('/app.html');
  await expect(page.locator('#app-view')).toBeVisible();
  await expect(page.locator('#events-list')).not.toContainText('سر');
});

test('signing out stops the polling, clears the screen and the cached list', async ({ page }) => {
  await stubSupabase(page);
  await seedAppStore(page, { user: CUST, events: [{ id: 'e1', name: 'E1' }] });
  await page.clock.install();
  await page.goto('/app.html');
  await expect(page.locator('#events-list .event-card')).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem('app_cache_v1'))).toContain('E1');
  await page.getByRole('button', { name: 'خروج' }).click();
  await expect(page.locator('#auth-view')).toBeVisible();
  await expect(page.locator('#app-view')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('app_cache_v1'))).toBeNull();
  const reads = () => srv(page, () => window.__fakeSupabase.calls.filter((c) => c.name === 'list_events').length);
  const base = await reads();
  await page.clock.fastForward(60000);
  expect(await reads()).toBe(base);
  await expect(page.locator('#events-list')).toHaveText('');
});

test('the token refresh events of the same account do not redraw or reload anything', async ({ page }) => {
  await open(page, { user: CUST, events: [{ id: 'e1', name: 'E1' }] });
  await expect(page.locator('#events-list .event-card')).toHaveCount(1);
  const before = await srv(page, () => window.__fakeSupabase.calls.length);
  await srv(page, () => { const A = window.__fakeSupabase.auth; A.listeners.slice().forEach((fn) => fn('TOKEN_REFRESHED', { user: A.user })); });
  await page.waitForTimeout(200);
  expect(await srv(page, () => window.__fakeSupabase.calls.length)).toBe(before);
});

test('a failed first load shows a retry message when nothing is cached, and the next poll recovers', async ({ page }) => {
  await open(page, { user: CUST, events: [{ id: 'e1', name: 'E1' }], fail: { list_events: { error: 'network', times: 99 } } });
  await expect(page.locator('#events-list')).toContainText('تعذّر تحميل المناسبات');
  await srv(page, () => { window.__fakeSupabase.fail = {}; });
  await poll(page);
  await expect(page.locator('#events-list .event-card')).toHaveCount(1);
});

test('the page works with localStorage blocked', async ({ page }) => {
  await stubSupabase(page);
  await seedAppStore(page, { user: CUST, events: [{ id: 'e1', name: 'E1' }] });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });
  });
  await page.goto('/app.html');
  await expect(page.locator('#events-list .event-card')).toHaveCount(1);
});

test('the page has no Firebase left: it loads the Supabase scripts and nothing from Google', async ({ page }) => {
  const hosts = [];
  page.on('request', (r) => { try { hosts.push(new URL(r.url()).host); } catch (e) {} });
  await open(page, { user: CUST, events: [] });
  await expect(page.locator('#app-view')).toBeVisible();
  expect(hosts.filter((h) => /google|firebase|gstatic/.test(h))).toEqual([]);
  const srcs = await page.evaluate(() => [...document.scripts].map((x) => x.src).filter(Boolean));
  expect(srcs.filter((x) => /firebase/.test(x))).toEqual([]);
  expect(srcs.some((x) => /vendor\/supabase\.min\.js/.test(x))).toBe(true);
  expect(await page.evaluate(() => typeof window._auth + typeof window._fsFns)).toBe('undefinedundefined');
});

// ---- a shared phone: another account's state never survives a recovery link ---------------

const OTHER = { id: 'u5', email: 'known@example.com' };
const OTHER_EVENTS = [{ id: 'k1', name: 'مناسبة الحساب الثاني', owner_uid: 'u5' }];
async function openAsAdminWithLink(page, hash) {
  await stubSupabase(page);
  await seedAppStore(page, {
    user: ADM, admin: true, recoveryUser: OTHER,
    accounts: { 'known@example.com': { id: 'u5', password: 'old-secret', confirmed: true } },
    events: [{ id: 'a1', name: 'سر الأدمن', owner_uid: 'u9', owner_email: 'x@y.com' }, ...OTHER_EVENTS],
    users: [{ uid: 'u9', email: 'x@y.com', created_at: '2026-01-01T00:00:00.000000+00:00' }],
    limits: { u5: { event_limit: 1, event_count: 1 } },
    eventRequests: [{ id: 'r1', uid: 'u9', email: 'req@y.com', status: 'pending', requested_at: '2026-01-01T00:00:00.000000+00:00' }],
  });
  await page.addInitScript(() => {
    try { if (!localStorage.getItem('seeded')) { localStorage.setItem('seeded', '1'); localStorage.setItem('app_cache_v1', JSON.stringify({ uid: 'admin-uid', admin: true, events: [{ id: 'a1', ownerUid: 'u9', name: 'سر الأدمن', guestCount: 0, createdAt: '2026-01-01T00:00:00.000Z' }], acct: null })); } } catch (e) {}
  });
  await page.goto('/app.html' + hash);
}

test('a recovery link opened while the admin is shown leaves nothing of the admin visible, in memory or in storage', async ({ page }) => {
  await openAsAdminWithLink(page, '#access_token=good-access&refresh_token=r&type=recovery');
  await expect(page.locator('#recovery-card')).toBeVisible();
  await expect(page.locator('#app-view')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('app_cache_v1'))).toBeNull();
  const st = await page.evaluate(() => ({ uid: shownUid, admin: shownAdmin, ev: allEvents.length, json: lastEventsJson, acc: allAccounts, pend: myPendingRequestId, list: document.getElementById('events-list').innerHTML, req: document.getElementById('admin-requests-list').innerHTML, secs: ['admin-unpaid-section', 'admin-requests-section', 'admin-accounts-section'].map((i) => document.getElementById(i).style.display) }));
  expect(st).toEqual({ uid: null, admin: false, ev: 0, json: '', acc: null, pend: null, list: '', req: '', secs: ['none', 'none', 'none'] });
  // no poll of the admin's data keeps running behind the screen
  const before = await page.evaluate(() => window.__fakeSupabase.calls.length);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__fakeSupabase.calls.length)).toBe(before);
});

test('changing the password then shows the RIGHT account\'s list, never the admin\'s', async ({ page }) => {
  await openAsAdminWithLink(page, '#access_token=good-access&refresh_token=r&type=recovery');
  await page.locator('#new-pass').fill('brand-new-1');
  await page.locator('#new-pass2').fill('brand-new-1');
  await page.locator('#recovery-submit-btn').click();
  await expect(page.locator('#app-view')).toBeVisible();
  await expect(page.locator('#current-email')).toHaveText('known@example.com');
  await expect(page.locator('#events-heading')).toHaveText('مناسباتي');
  await expect(page.locator('#events-list')).toContainText('مناسبة الحساب الثاني');
  await expect(page.locator('#events-list')).not.toContainText('سر الأدمن');
  await expect(page.locator('#admin-requests-section')).toBeHidden();
  await expect(page.locator('#admin-accounts-section')).toBeHidden();
  await expect(page.locator('#limit-box')).toBeVisible();
});

test('a failure after the password was saved is never shown as a password-change failure', async ({ page }) => {
  await openAsAdminWithLink(page, '#access_token=good-access&refresh_token=r&type=recovery');
  await page.evaluate(() => { window.__fakeSupabase.fail = { is_admin_me: { error: 'network' } }; });
  await page.locator('#new-pass').fill('brand-new-1');
  await page.locator('#new-pass2').fill('brand-new-1');
  await page.locator('#recovery-submit-btn').click();
  await expect(page.locator('#recovery-err')).toBeHidden();
  await expect(page.locator('#toast')).toContainText('تم تغيير كلمة المرور');
  expect(await page.evaluate(() => window.__fakeSupabase.auth.passwordUpdates)).toBe(1);
  await expect(page.locator('#recovery-card')).toBeHidden();
});

test('cancelling the new-password screen clears the cached list too', async ({ page }) => {
  await openAsAdminWithLink(page, '#access_token=good-access&refresh_token=r&type=recovery');
  await page.evaluate(() => localStorage.setItem('app_cache_v1', '{"uid":"x","admin":false,"events":[],"acct":null}'));
  await page.locator('#recovery-card').getByText('إلغاء').click();
  await expect(page.locator('#auth-card')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('app_cache_v1'))).toBeNull();
});

test('signing out clears the cache even when no account was recorded on the page', async ({ page }) => {
  await open(page, { user: CUST, events: [{ id: 'e1', name: 'E1' }] });
  await expect(page.locator('#events-list .event-card')).toHaveCount(1);
  await page.evaluate(() => { shownUid = null; localStorage.setItem('app_cache_v1', '{"uid":"u1","admin":false,"events":[],"acct":null}'); });
  await page.evaluate(() => handleAuthUser(null));
  expect(await page.evaluate(() => localStorage.getItem('app_cache_v1'))).toBeNull();
});

test('a signup link carrying a recovery-looking token opens the app, not the new-password screen', async ({ page }) => {
  await stubSupabase(page);
  await seedAppStore(page, { user: null, accounts: ACCTS, recoveryUser: RECOVERY });
  await page.goto('/app.html#access_token=good-access&refresh_token=r&type=signup');
  await expect(page.locator('#app-view')).toBeVisible();
  await expect(page.locator('#recovery-card')).toBeHidden();
  expect(await page.evaluate(() => window.__fakeSupabase.auth.passwordUpdates || 0)).toBe(0);
});

test('leaving mid-recovery without saving: the next visit has no tokens in the address and no pending state', async ({ page }) => {
  await openRecovery(page, '#access_token=good-access&refresh_token=r&type=recovery');
  await expect(page.locator('#recovery-card')).toBeVisible();
  expect(await page.evaluate(() => location.href)).not.toMatch(/token/);
  // the tab is closed and the browser still holds the opened session: a plain visit later
  await page.close();
  const page2 = await page.context().newPage();
  await stubSupabase(page2);
  await seedAppStore(page2, { user: { id: 'u5', email: 'known@example.com' }, events: [] });
  await page2.goto('/app.html');
  await expect(page2.locator('#recovery-card')).toBeHidden();
  expect(page2.url()).not.toMatch(/token|recovery/);
});

test('a lost answer from request_extra_event is read back once instead of failing', async ({ page }) => {
  await open(page, { user: CUST, events: [{ id: 'e1', name: 'E1' }, { id: 'e2', name: 'E2' }, { id: 'e3', name: 'E3' }], limits: { u1: { event_limit: 3, event_count: 3 } },
    eventRequests: [{ id: 'r1', uid: 'u1', email: CUST.email, status: 'pending', requested_at: '2026-01-01T00:00:00.000000+00:00' }] });
  const r = await page.evaluate(async () => {
    const client = Data.client();
    const realRpc = client.rpc;
    client.rpc = (name, args) => (name === 'request_extra_event' ? Promise.resolve({ data: [], error: null }) : realRpc(name, args));
    return Data.account.requestExtraEvent();
  });
  expect(r).toEqual({ id: 'r1', created: false });
});

test('a timeout while creating an event: if it was saved the page goes to it, with no «request another event» wording', async ({ page }) => {
  await stubSupabase(page);
  await seedAppStore(page, { user: CUST, events: [], limits: { u1: { event_limit: 1, event_count: 0 } } });
  const alerts = [];
  page.on('dialog', (d) => { alerts.push(d.message()); d.accept(); });
  await page.goto('/app.html');
  await page.locator('#create-toggle-btn').click();
  await page.getByRole('radio', { name: 'زفاف' }).click();
  await page.locator('#ev-name').fill('عرس الشبكة');
  // the server saves the event but the answer is lost
  await page.evaluate(() => { window.__fakeSupabase.dropReply = { create_event: 1 }; });
  await page.getByRole('button', { name: 'إنشاء', exact: true }).click();
  await expect(page).toHaveURL(/event\.html\?id=/);
  expect(alerts).toEqual([]);
});

test('retrying after a lost answer: the limit error finds the event that was already saved', async ({ page }) => {
  await stubSupabase(page);
  await seedAppStore(page, { user: CUST, events: [], limits: { u1: { event_limit: 1, event_count: 0 } } });
  const alerts = [];
  page.on('dialog', (d) => { alerts.push(d.message()); d.accept(); });
  await page.goto('/app.html');
  await page.locator('#create-toggle-btn').click();
  await page.getByRole('radio', { name: 'زفاف' }).click();
  await page.locator('#ev-name').fill('عرس ثاني');
  // the event exists on the server (a first try whose answer never came back)
  await page.evaluate(() => {
    window.__fakeSupabase.events.old1 = { name: 'عرس ثاني', owner_uid: 'u1', created_at: new Date().toISOString().replace('Z', '000+00:00') };
    window.__fakeSupabase.limits.u1.event_count = 1;
  });
  await page.getByRole('button', { name: 'إنشاء', exact: true }).click();
  await expect(page).toHaveURL(/event\.html\?id=old1/);
  expect(alerts).toEqual([]);
});
