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
      'events/e1/requests': { r1: { name: 'سارة', reqId: 'REQ-1', status: 'approved', guestId: 'WD-ABC', createdAt: 'x' } },
    },
  });
  await page.addInitScript(() => {
    localStorage.setItem('inv_reqid_e1', 'REQ-1');
    // The guests collection is no longer world-readable — prove this page
    // doesn't need it.
    window.__fakeFirebase.denyPaths = ['events/e1/guests'];
  });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card')).toContainText('تم تأكيد حضورك');
});

test('an approval that predates the barcode-id-on-request change shows "preparing your card", then the card once it is filled in', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    store: {
      events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } },
      'events/e1/requests': { r1: { name: 'سارة', reqId: 'REQ-1', status: 'approved', createdAt: 'x' } },
    },
  });
  await page.addInitScript(() => { localStorage.setItem('inv_reqid_e1', 'REQ-1'); });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card')).toContainText('جاري تجهيز بطاقتك');

  // The organizer opening their dashboard backfills the id; the same
  // listener picks it up.
  await page.evaluate(() => {
    const { doc, updateDoc } = window._fsFns;
    return updateDoc(doc(window._db, 'events', 'e1', 'requests', 'r1'), { guestId: 'WD-LATE' });
  });
  await expect(page.locator('#card')).toContainText('تم تأكيد حضورك');
});
