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

test('the page still loads even if localStorage throws (Safari private browsing, storage-blocking policies)', async ({ page }) => {
  // localStorage.getItem() used to run unguarded as the very first thing in
  // the page's script — an uncaught throw there would silently kill
  // everything defined after it, including init() itself, leaving the
  // guest stuck on the loading placeholder forever with no way out.
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    store: { events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } } },
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() { throw new Error('SecurityError: storage is disabled'); },
    });
  });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#g-name')).toBeVisible();
  await expect(page.locator('#card')).toContainText('حفل تجريبي');
});

test('a dropped connection while loading the event shows a tappable retry instead of hanging on "جاري التحميل..." forever', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    store: { events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } } },
  });
  await page.addInitScript(() => { window.__failNextGetDoc = true; });
  await page.goto('/invite.html?event=e1');

  const retry = page.locator('#retry-msg');
  await expect(retry).toContainText('تعذّر الاتصال');
  await retry.click();
  await expect(page.locator('#card')).toContainText('حفل تجريبي');
});

test('an approved guest gets their card from the request itself — the invite page no longer reads the guests collection', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    store: {
      events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } },
      'events/e1/requests': { 'REQ-1': { name: 'سارة', reqId: 'REQ-1', status: 'approved', guestId: 'WD-ABC', createdAt: 'x' } },
    },
  });
  await page.addInitScript(() => {
    localStorage.setItem('inv_reqid_e1', 'REQ-1');
    // The guests collection is no longer world-readable — prove this page
    // doesn't need it.
    window.__fakeFirebase.denyPaths = ['events/e1/guests'];
    window.__fakeFirebase.denyLists = ['events/e1/requests']; // listing requests is not open to guests
  });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card')).toContainText('تم تأكيد حضورك');
});

test('an approval that predates the barcode-id-on-request change shows "preparing your card", then the card once it is filled in', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    store: {
      events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } },
      'events/e1/requests': { 'REQ-1': { name: 'سارة', reqId: 'REQ-1', status: 'approved', createdAt: 'x' } },
    },
  });
  await page.addInitScript(() => { localStorage.setItem('inv_reqid_e1', 'REQ-1'); });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card')).toContainText('جاري تجهيز بطاقتك');

  // The organizer opening their dashboard backfills the id; the same
  // listener picks it up.
  await page.evaluate(() => {
    const { doc, updateDoc } = window._fsFns;
    return updateDoc(doc(window._db, 'events', 'e1', 'requests', 'REQ-1'), { guestId: 'WD-LATE' });
  });
  await expect(page.locator('#card')).toContainText('تم تأكيد حضورك');
});

const EVENT = { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' };

test('registering creates the request under its own secret id — and works when listing requests is denied', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EVENT }, 'events/e1/requests': {} } });
  await page.addInitScript(() => { window.__fakeFirebase.denyLists = ['events/e1/requests']; });
  await page.goto('/invite.html?event=e1');
  await page.locator('#g-name').fill('سارة');
  await page.getByRole('button', { name: 'تأكيد الحضور' }).click();
  await expect(page.locator('#card')).toContainText('بانتظار موافقة المنظّم');

  const state = await page.evaluate(() => ({
    stored: localStorage.getItem('inv_reqid_e1'),
    docs: window.__fakeFirebase.store['events/e1/requests'],
  }));
  // 128 random bits, in hex.
  expect(state.stored).toMatch(/^REQ-[0-9A-F]{32}$/);
  // The document is named after it, and carries the same value.
  expect(Object.keys(state.docs)).toEqual([state.stored]);
  expect(state.docs[state.stored]).toMatchObject({ name: 'سارة', reqId: state.stored, status: 'pending' });
});

test('two registrations never get the same id', async ({ browser }) => {
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await stubFirebase(page);
    await seedFakeFirebase(page, { store: { events: { e1: EVENT }, 'events/e1/requests': {} } });
    await page.goto('/invite.html?event=e1');
    await page.locator('#g-name').fill('ضيف ' + i);
    await page.getByRole('button', { name: 'تأكيد الحضور' }).click();
    await expect(page.locator('#card')).toContainText('بانتظار موافقة المنظّم');
    ids.push(await page.evaluate(() => localStorage.getItem('inv_reqid_e1')));
    await context.close();
  }
  expect(ids[0]).not.toBe(ids[1]);
});

test('a guest only ever sees their own request — another request in the same event is invisible to them', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    store: {
      events: { e1: EVENT },
      'events/e1/requests': {
        'REQ-MINE': { name: 'سارة', reqId: 'REQ-MINE', status: 'pending', createdAt: 'x' },
        'REQ-THEIRS': { name: 'خالد', reqId: 'REQ-THEIRS', status: 'approved', guestId: 'WD-SECRET', createdAt: 'x' },
      },
    },
  });
  await page.addInitScript(() => {
    localStorage.setItem('inv_reqid_e1', 'REQ-MINE');
    window.__fakeFirebase.denyLists = ['events/e1/requests'];
  });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card')).toContainText('بانتظار موافقة المنظّم');
  await expect(page.locator('body')).not.toContainText('خالد');
  await expect(page.locator('body')).not.toContainText('WD-SECRET');
});

test('a saved request id with no request behind it (an older request, or one the organizer deleted) lets the guest register again', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EVENT }, 'events/e1/requests': {} } });
  await page.addInitScript(() => { localStorage.setItem('inv_reqid_e1', 'REQ-GONE'); });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#g-name')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('inv_reqid_e1'))).toBeNull();
});

test('after a rejection, trying again creates a fresh request under a new id', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    store: {
      events: { e1: EVENT },
      'events/e1/requests': { 'REQ-OLD': { name: 'سارة', reqId: 'REQ-OLD', status: 'rejected', createdAt: 'x' } },
    },
  });
  await page.addInitScript(() => { localStorage.setItem('inv_reqid_e1', 'REQ-OLD'); });
  await page.goto('/invite.html?event=e1');
  await page.getByRole('button', { name: 'حاول مرة ثانية' }).click();
  await page.locator('#g-name').fill('سارة');
  await page.getByRole('button', { name: 'تأكيد الحضور' }).click();
  await expect(page.locator('#card')).toContainText('بانتظار موافقة المنظّم');
  const ids = await page.evaluate(() => Object.keys(window.__fakeFirebase.store['events/e1/requests']));
  expect(ids).toHaveLength(2);
  expect(ids.filter(i => i !== 'REQ-OLD')[0]).toMatch(/^REQ-[0-9A-F]{32}$/);
});

test('the sample invitation (?demo=1) walks through registration and approval without touching the database', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: {} } });
  // Any read or write against these would fail loudly — the demo must not need them.
  await page.addInitScript(() => { window.__fakeFirebase.denyPaths = ['events', 'accountLimits']; });
  await page.goto('/invite.html?demo=1');

  await expect(page.locator('#demo-banner')).toContainText('نموذج تجريبي');
  await expect(page.locator('#card')).toContainText('حفل زفاف أحمد وسارة');
  await page.locator('#g-name').fill('خالد');
  await page.getByRole('button', { name: 'تأكيد الحضور' }).click();
  await expect(page.locator('#card')).toContainText('بانتظار موافقة المنظّم');
  await expect(page.locator('#card')).toContainText('يوافق المنظّم', { timeout: 3000 });
  await expect(page.locator('#card')).toContainText('تم تأكيد حضورك', { timeout: 5000 });

  const state = await page.evaluate(() => ({
    store: JSON.stringify(window.__fakeFirebase.store),
    saved: (() => { try { return localStorage.getItem('inv_reqid_null'); } catch (e) { return null; } })(),
  }));
  expect(state.store).toBe('{"events":{}}');   // nothing was created
  expect(state.saved).toBeNull();               // and nothing remembered on the phone
});

test('the sample invitation does not need the database to load at all', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: {} });
  await page.addInitScript(() => { window.__failNextGetDoc = true; window.__fakeFirebase.denyPaths = ['events']; });
  await page.goto('/invite.html?demo=1');
  await expect(page.locator('#g-name')).toBeVisible();
});
