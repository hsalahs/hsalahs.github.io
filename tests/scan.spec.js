const { test, expect } = require('@playwright/test');
const { stubFirebase, seedFakeFirebase } = require('./helpers');

// No door code on the event doc — it lives in events/e1/private/scan, which
// scan.html can't read. The page never compares the code itself; it submits
// it and Firestore's rules accept or deny.
const EVENT = {
  name: 'حفل تجريبي', ownerUid: 'u1', date: '2026-01-01', venue: 'الرياض',
  theme: 'gold', createdAt: { seconds: 1 },
};

// A door device that already proved the code: an anonymous identity that
// Firebase restored across reloads, plus its session doc.
const DEVICE = { uid: 'anon-1', isAnonymous: true, email: null };
function unlockedStore(guests = {}) {
  return {
    events: { e1: EVENT },
    'events/e1/guests': guests,
    'events/e1/scanSessions': { 'anon-1': { pin: '1234', createdAt: 'x' } },
  };
}

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

test('the page never receives the door code — unlocking submits it and lets the server rule decide', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    store: { events: { e1: EVENT }, 'events/e1/guests': {}, 'events/e1/private': { scan: { scanPin: '1234' } } },
  });
  await page.addInitScript(() => { window.__fakeFirebase.auth.nextAnonUid = 'anon-new'; });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#pin-gate')).toBeVisible();

  // Nothing secret reached the browser: the event doc it fetched has no code.
  expect(await page.evaluate(() => eventData.scanPin)).toBeUndefined();

  await page.locator('#pin-input').fill('1234');
  await page.getByRole('button', { name: 'دخول' }).first().click();
  await expect(page.locator('#scanner-view')).toBeVisible();

  // What actually happened: an anonymous identity, and a session doc keyed
  // by it carrying the submitted code — the thing the security rule checks.
  const state = await page.evaluate(() => ({
    user: window.__fakeFirebase.auth.user,
    session: window.__fakeFirebase.store['events/e1/scanSessions']['anon-new'],
  }));
  expect(state.user.isAnonymous).toBe(true);
  expect(state.session.pin).toBe('1234');
});

test('the code field takes six digits, and an older four-digit code still works', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    store: { events: { e1: EVENT }, 'events/e1/guests': {}, 'events/e1/private': { scan: { scanPin: '482913' } } },
  });
  await page.addInitScript(() => { window.__fakeFirebase.auth.nextAnonUid = 'anon-six'; });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#pin-gate')).toBeVisible();

  // Typed key by key, so the field's own length limit applies: a seventh
  // digit is dropped, all six are kept.
  await page.locator('#pin-input').pressSequentially('4829139');
  await expect(page.locator('#pin-input')).toHaveValue('482913');
  await page.getByRole('button', { name: 'دخول' }).first().click();
  await expect(page.locator('#scanner-view')).toBeVisible();
  expect(await page.evaluate(() => window.__fakeFirebase.store['events/e1/scanSessions']['anon-six'].pin)).toBe('482913');
});

test('an event that still has an older four-digit code can be unlocked with it', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    store: { events: { e1: EVENT }, 'events/e1/guests': {}, 'events/e1/private': { scan: { scanPin: '1234' } } },
  });
  await page.addInitScript(() => { window.__fakeFirebase.auth.nextAnonUid = 'anon-four'; });
  await page.goto('/scan.html?event=e1');
  await page.locator('#pin-input').pressSequentially('1234');
  await expect(page.locator('#pin-input')).toHaveValue('1234');
  await page.getByRole('button', { name: 'دخول' }).first().click();
  await expect(page.locator('#scanner-view')).toBeVisible();
});

test('a code the server rule rejects shows "رقم غير صحيح" and keeps the scanner locked', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EVENT }, 'events/e1/guests': {} } });
  // The stub has no rules; this is what the real rule's denial looks like.
  await page.addInitScript(() => { window.__fakeFirebase.denyPaths = ['events/e1/scanSessions']; });
  await page.goto('/scan.html?event=e1');

  await page.locator('#pin-input').fill('0000');
  await page.getByRole('button', { name: 'دخول' }).first().click();
  await expect(page.locator('#pin-err')).toHaveText('رقم غير صحيح');
  await expect(page.locator('#scanner-view')).toBeHidden();
});

test('if anonymous sign-in itself is unavailable, the code screen says so instead of blaming the code', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EVENT }, 'events/e1/guests': {} } });
  await page.addInitScript(() => { window.__fakeFirebase.auth.alwaysSignInError = { code: 'auth/admin-restricted-operation' }; });
  await page.goto('/scan.html?event=e1');

  await page.locator('#pin-input').fill('1234');
  await page.getByRole('button', { name: 'دخول' }).first().click();
  await expect(page.locator('#pin-err')).toContainText('تسجيل الدخول المجهول غير مفعّل');
  await expect(page.locator('#scanner-view')).toBeHidden();
});

test('a device that proved the code before is let straight back in after a reload', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: unlockedStore() });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await expect(page.locator('#pin-gate')).toBeHidden();
});

test('regenerating the door code from the dashboard locks out a device that unlocked with the old one', async ({ page }) => {
  // After a code change the rule denies reading the device's own session
  // doc (its stored code no longer matches the live one) — that denial is
  // how the device learns it needs the new code.
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: unlockedStore() });
  await page.addInitScript(() => { window.__fakeFirebase.denyPaths = ['events/e1/scanSessions/anon-1']; });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#pin-gate')).toBeVisible();
  await expect(page.locator('#scanner-view')).toBeHidden();
});

test('a code change while the scanner is open sends it back to the code screen with a clear reason', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: unlockedStore() });
  // Session read still passes (init lets the device in), but the guest
  // listener is then denied — exactly what a revoked session looks like.
  await page.addInitScript(() => { window.__fakeFirebase.denyPaths = ['events/e1/guests']; });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#pin-gate')).toBeVisible();
  await expect(page.locator('#pin-err')).toContainText('تغيّر كود الدخول');
  await expect(page.locator('#connection-banner')).toBeHidden();
});

test('an open scanner re-checks its session every minute and goes back to the code screen once it is revoked', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: unlockedStore() });
  await page.clock.install();
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();

  // The organizer changes the code: from now on this device's session read
  // is denied, but the guest listener that's already open isn't told.
  await page.evaluate(() => { window.__fakeFirebase.denyPaths = ['events/e1/scanSessions']; });
  await page.clock.fastForward(30000);
  await expect(page.locator('#scanner-view')).toBeVisible(); // not yet — the check runs once a minute
  await page.clock.fastForward(31000);
  await expect(page.locator('#pin-gate')).toBeVisible();
  await expect(page.locator('#pin-err')).toContainText('تغيّر كود الدخول');
  await expect(page.locator('#scanner-view')).toBeHidden();
});

test('coming back to the page re-checks the session right away, without waiting for the minute', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: unlockedStore() });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();

  await page.evaluate(() => {
    window.__fakeFirebase.denyPaths = ['events/e1/scanSessions'];
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('#pin-gate')).toBeVisible();
  await expect(page.locator('#pin-err')).toContainText('تغيّر كود الدخول');
});

test('a session document the organizer deleted also counts as revoked', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: unlockedStore() });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();

  await page.evaluate(() => {
    delete window.__fakeFirebase.store['events/e1/scanSessions']['anon-1'];
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('#pin-gate')).toBeVisible();
});

test('a dropped connection during the re-check does not throw door staff out', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: unlockedStore() });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();

  await page.evaluate(() => {
    window.__failNextGetDoc = true; // the re-check's read fails with a plain network error
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => window.__failNextGetDoc === false);
  await page.waitForTimeout(300);
  await expect(page.locator('#scanner-view')).toBeVisible();
  await expect(page.locator('#pin-gate')).toBeHidden();
});

test('the organizer and the admin have no session to re-check, so they are never sent back to the code screen', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: { events: { e1: EVENT }, 'events/e1/guests': {} },
  });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();

  await page.evaluate(() => {
    window.__fakeFirebase.denyPaths = ['events/e1/scanSessions'];
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(300);
  await expect(page.locator('#scanner-view')).toBeVisible();
});

test('after "تسجيل خروج من هذا الجهاز" the re-check is off and nothing pops up on the code screen', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: unlockedStore() });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.locator('#lock-device-btn').click();
  await expect(page.locator('#pin-gate')).toBeVisible();

  await page.evaluate(() => {
    window.__fakeFirebase.denyPaths = ['events/e1/scanSessions'];
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(300);
  await expect(page.locator('#pin-err')).toBeHidden();
});

test('re-scanning an already-checked-in guest shows a clear red "already used" alert, not a soft warning', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: DEVICE,
    store: unlockedStore({ 'WD-DUP123': { name: 'ضيف مكرر', id: 'WD-DUP123', scanned: true } }),
  });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();

  await page.locator('#manual-code').fill('WD-DUP123');
  await page.getByRole('button', { name: 'تحقق ✓' }).click();

  const dupCard = page.locator('#result-overlay.rs-duplicate');
  await expect(dupCard).toBeVisible();
  await expect(dupCard).toContainText('تم استخدام هذه الدعوة مسبقًا');
  await expect(dupCard).toHaveCSS('background-color', 'rgb(183, 28, 28)');
});

test('a check-in write that fails on the network resets the scanner instead of silently ignoring every scan after it', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: DEVICE,
    store: unlockedStore({ 'WD-NET1': { name: 'ضيف', id: 'WD-NET1', scanned: false } }),
  });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();

  // First attempt: the transaction dies mid-flight (bad venue wifi).
  await page.evaluate(() => {
    const real = window._fsFns.runTransaction;
    window._fsFns.runTransaction = () => { window._fsFns.runTransaction = real; return Promise.reject(new Error('network')); };
  });
  await page.locator('#manual-code').fill('WD-NET1');
  await page.getByRole('button', { name: 'تحقق ✓' }).click();
  await expect(page.locator('#camera-status')).toContainText('تعذّر تسجيل الدخول');
  await expect(page.locator('#result-overlay.rs-error')).toBeVisible();
  await page.waitForTimeout(500);
  await page.locator('#result-overlay').click();
  await expect(page.locator('#result-overlay')).toBeHidden();

  // Second attempt must go through — the failure used to leave scanCooldown
  // stuck on true, so this would have been ignored.
  await page.locator('#manual-code').fill('WD-NET1');
  await page.getByRole('button', { name: 'تحقق ✓' }).click();
  await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
});

test('"مسح جديد" tears the camera down and returns to the start-camera screen, instead of trusting it\'s still healthy', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: unlockedStore() });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();

  // Simulate a camera that's already "running" (as if startCamera() had
  // succeeded earlier) using a fake QrScanner-shaped object, then confirm
  // resetScanState() actually stops and destroys it rather than leaving it
  // untouched.
  const calls = await page.evaluate(() => {
    const log = [];
    qrScanner = { stop: () => log.push('stop'), destroy: () => log.push('destroy') };
    document.getElementById('camera-wrapper').style.display = 'block';
    document.getElementById('start-cam-btn').style.display = 'none';
    resetScanState();
    return { log, qrScannerIsNull: qrScanner === null };
  });
  expect(calls.log).toEqual(['stop', 'destroy']);
  expect(calls.qrScannerIsNull).toBe(true);
  await expect(page.locator('#camera-wrapper')).toBeHidden();
  await expect(page.locator('#start-cam-btn')).toBeVisible();
  await expect(page.locator('#camera-status')).toHaveText('اضغط لتشغيل الكاميرا');
});

test('the splash screen clears on its own even if the entire app script fails to load — it must never trap the page behind it', async ({ page }) => {
  // This is the exact failure the splash-hide logic used to be vulnerable
  // to: it lived inside window.addEventListener('load', ...), so if any
  // subresource never loaded (bad venue wifi, a blocked/slow CDN script),
  // `load` never fired and the splash sat there forever with nothing
  // behind it ever appearing — door staff stuck looking at a static
  // "دعوة زفاف" screen with no way to scan anyone in. Simulating that here
  // by blocking firebase-init.js outright, the module the rest of the page
  // depends on entirely.
  await page.route('**/firebase-init.js', (route) => route.abort());
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 4000 });
});

test('the splash still clears at the 2 s cap when a subresource never answers and the load event never fires', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EVENT }, 'events/e1/guests': {} } });
  await page.route('**/vendor/qr-scanner.umd.min.js', () => {});
  await page.goto('/scan.html?event=e1', { waitUntil: 'commit' });
  await page.waitForTimeout(1200);
  await expect(page.locator('#splash')).toHaveCount(1);
  expect(await page.evaluate(() => document.readyState)).not.toBe('complete');
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 2000 });
});

test('the splash hides after load and at least 800 ms, well before 2.2 s, and its node is then removed', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EVENT }, 'events/e1/guests': {} } });
  await page.addInitScript(() => {
    window.__t = { start: performance.now(), load: null, hide: null };
    window.addEventListener('load', () => { window.__t.load = performance.now(); });
    document.addEventListener('DOMContentLoaded', () => {
      const s = document.getElementById('splash');
      new MutationObserver(() => {
        if (s.classList.contains('hide') && !window.__t.hide) window.__t.hide = performance.now();
      }).observe(s, { attributes: true });
    });
  });
  await page.goto('/scan.html?event=e1');
  await page.waitForFunction(() => window.__t.hide, null, { timeout: 4000 });
  const t = await page.evaluate(() => window.__t);
  expect(t.load).not.toBeNull();
  expect(t.hide).toBeGreaterThanOrEqual(t.load);
  expect(t.hide).toBeGreaterThanOrEqual(800);
  expect(t.hide).toBeLessThan(2200);
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 2000 });
});

test('a dropped connection while loading the event shows a tappable retry instead of hanging on "جاري التحميل..." forever', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EVENT }, 'events/e1/guests': {} } });
  await page.addInitScript(() => { window.__failNextGetDoc = true; });
  await page.goto('/scan.html?event=e1');

  const msg = page.locator('#loading-msg');
  await expect(msg).toContainText('تعذّر الاتصال');
  await msg.click();
  await expect(page.locator('#pin-event-name')).toHaveText('حفل تجريبي');
});

test('the guest list is cached locally as it syncs, and can be searched read-only from the scanner view', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: DEVICE,
    store: unlockedStore({
      g1: { name: 'أحمد العتيبي', id: 'WD-1', scanned: true },
      g2: { name: 'سارة القحطاني', id: 'WD-2', scanned: false },
    }),
  });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await expect(page.locator('#offline-list-btn')).toBeVisible();

  await page.locator('#offline-list-btn').click();
  await expect(page.locator('#offline-list-results')).toContainText('سارة القحطاني');
  await expect(page.locator('#offline-list-results')).not.toContainText('أحمد العتيبي');
  await page.locator('#offline-search').fill('أحمد');
  await expect(page.locator('#offline-list-results')).toContainText('أحمد العتيبي');
  await expect(page.locator('#offline-list-results')).toContainText('✓ دخل');

  await page.locator('#offline-search').fill('سارة');
  await expect(page.locator('#offline-list-results')).toContainText('سارة القحطاني');
  await expect(page.locator('#offline-list-results')).not.toContainText('أحمد العتيبي');
});

test('a device that synced before offers the last saved guest list even when the connection is down on a later visit', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EVENT }, 'events/e1/guests': {} } });
  await page.addInitScript(() => {
    localStorage.setItem('scan_offline_cache_e1', JSON.stringify({
      eventName: 'حفل تجريبي',
      guests: [{ name: 'محمد الشمري', id: 'WD-9', scanned: false }],
      savedAt: new Date().toISOString(),
    }));
    window.__failNextGetDoc = true;
  });
  await page.goto('/scan.html?event=e1');

  const fallbackBtn = page.getByRole('button', { name: 'عرض آخر نسخة محفوظة بدون إنترنت' });
  await expect(fallbackBtn).toBeVisible();
  await fallbackBtn.click();

  await expect(page.locator('#scan-event-name')).toHaveText('حفل تجريبي');
  await expect(page.locator('#offline-list-results')).toContainText('محمد الشمري');
  // Read-only fallback — the real scan controls stay hidden since check-in
  // needs a live connection to be trustworthy.
  await expect(page.locator('#start-cam-btn')).toBeHidden();
});

test('scan.html has no web app manifest, so "Add to Home Screen" uses the current address-bar URL as-is', async ({ page }) => {
  // Confirmed on a real device: a <link rel="manifest"> gets read by iOS's
  // "Add to Home Screen" before any per-event JS swap can take effect, so
  // the saved icon always lost the ?event= no matter how early the swap
  // ran. Removing the manifest entirely (the legacy site's approach) lets
  // iOS fall back to the page's own current URL, which already has the
  // right event in it.
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EVENT }, 'events/e1/guests': {} } });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#pin-event-name')).toHaveText('حفل تجريبي');
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(0);
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes');
});

test('an admin who is already signed in on this device skips the PIN gate entirely', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'admin1', email: 'hsallah@outlook.sa' },
    store: { events: { e1: EVENT }, 'events/e1/guests': {} },
  });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#pin-gate')).toBeHidden();
  await expect(page.locator('#scanner-view')).toBeVisible();
  await expect(page.locator('#scan-event-name')).toHaveText('حفل تجريبي');
  // The logout button has to show here too: a device that auto-bypasses
  // because it's already signed in and a device where the admin just
  // signed in manually are indistinguishable after a reload — both are
  // just "a device with a persisted admin session" — so this is the only
  // way to end that session on either kind.
  await expect(page.locator('#lock-device-btn')).toBeVisible();
});

test('the event\'s own organizer opening their scan link skips the PIN gate — their sign-in already proves it', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: { events: { e1: EVENT }, 'events/e1/guests': {} },
  });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#pin-gate')).toBeHidden();
  await expect(page.locator('#scanner-view')).toBeVisible();
});

test('a signed-in customer who is neither the admin nor this event\'s owner still has to enter the door PIN', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u2', email: 'someone-else@example.com' },
    store: { events: { e1: EVENT }, 'events/e1/guests': {} },
  });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#pin-gate')).toBeVisible();
  await expect(page.locator('#scanner-view')).toBeHidden();
});

test('a signed-in non-owner customer who already proved the code keeps their session across reloads, like a door device does', async ({ page }) => {
  // Someone helping at a friend's wedding while signed in to their own
  // account: their real uid holds the session doc instead of an anonymous
  // one, and it should be honoured the same way on the next load.
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u2', email: 'someone-else@example.com' },
    store: {
      events: { e1: EVENT },
      'events/e1/guests': {},
      'events/e1/scanSessions': { u2: { pin: '1234', createdAt: 'x' } },
    },
  });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await expect(page.locator('#pin-gate')).toBeHidden();

  // And logging out drops that session too, not only anonymous ones.
  await page.locator('#lock-device-btn').click();
  await expect(page.locator('#pin-gate')).toBeVisible();
  expect(await page.evaluate(() => window.__fakeFirebase.store['events/e1/scanSessions'].u2)).toBeUndefined();
});

test('"تسجيل خروج من هذا الجهاز" deletes the device\'s session, signs it out, and returns to the PIN screen', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: unlockedStore() });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await expect(page.locator('#lock-device-btn')).toBeVisible();

  await page.locator('#lock-device-btn').click();
  await expect(page.locator('#scanner-view')).toBeHidden();
  await expect(page.locator('#pin-gate')).toBeVisible();
  const state = await page.evaluate(() => ({
    user: window.__fakeFirebase.auth.user,
    session: window.__fakeFirebase.store['events/e1/scanSessions']['anon-1'],
  }));
  expect(state.user === null || state.user.uid !== 'anon-1').toBe(true);
  expect(state.session).toBeUndefined();
});

test('an admin can sign in with their real account on a borrowed device, instead of typing the door PIN', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EVENT }, 'events/e1/guests': {} } });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#pin-gate')).toBeVisible();

  await page.locator('#admin-login-toggle a').click();
  await page.locator('#admin-email').fill('hsallah@outlook.sa');
  await page.locator('#admin-pass').fill('correct-password');
  await page.getByRole('button', { name: 'دخول' }).nth(1).click();

  await expect(page.locator('#scanner-view')).toBeVisible();
  await expect(page.locator('#lock-device-btn')).toBeVisible();
  await expect(page.locator('#lock-device-btn')).toContainText('إغلاق الماسح');
});

test('signing in with a non-admin account on the admin-login form is rejected and signed back out', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EVENT }, 'events/e1/guests': {} } });
  await page.goto('/scan.html?event=e1');

  await page.locator('#admin-login-toggle a').click();
  await page.locator('#admin-email').fill('customer@example.com');
  await page.locator('#admin-pass').fill('whatever');
  await page.getByRole('button', { name: 'دخول' }).nth(1).click();

  await expect(page.locator('#admin-login-err')).toContainText('ليس حساب الأدمن');
  await expect(page.locator('#scanner-view')).toBeHidden();
  const signedIn = await page.evaluate(() => !!window.__fakeFirebase.auth.user);
  expect(signedIn).toBe(false);
});

test('a wrong password on the admin-login form shows an error instead of a generic failure', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EVENT }, 'events/e1/guests': {} } });
  await page.goto('/scan.html?event=e1');
  await page.evaluate(() => { window.__fakeFirebase.auth.nextSignInError = { code: 'auth/invalid-credential' }; });

  await page.locator('#admin-login-toggle a').click();
  await page.locator('#admin-email').fill('hsallah@outlook.sa');
  await page.locator('#admin-pass').fill('wrong');
  await page.getByRole('button', { name: 'دخول' }).nth(1).click();

  await expect(page.locator('#admin-login-err')).toContainText('البريد أو كلمة المرور غلط');
  await expect(page.locator('#scanner-view')).toBeHidden();
});

// Signing out in one tab of a browser signs out every tab of that browser
// (Firebase shares the sign-in between them). The scanner used to answer that
// with "the code changed", which sent the organizer hunting for a code change
// that never happened.
const OWNER = { uid: 'u1', email: 'owner@example.com', isAnonymous: false };

test('the organizer opens the scanner on their own account, then presses "خروج" on the dashboard in another tab: the scanner says they were signed out, not that the code changed', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: OWNER, store: { events: { e1: EVENT }, 'events/e1/guests': {} } });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();   // the owner needs no code

  // The other tab signs out; this tab is told by Firebase.
  await page.evaluate(() => window._authFns.signOut(window._auth));
  await expect(page.locator('#pin-gate')).toBeVisible();
  await expect(page.locator('#scanner-view')).toBeHidden();
  await expect(page.locator('#pin-err')).toContainText('تم تسجيل الخروج من الحساب على هذا الجهاز');
  await expect(page.locator('#pin-err')).not.toContainText('تغيّر كود الدخول');
});

test('the same for the admin', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'admin-1', email: 'hsallah@outlook.sa', isAnonymous: false }, store: { events: { e1: EVENT }, 'events/e1/guests': {} } });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.evaluate(() => window._authFns.signOut(window._auth));
  await expect(page.locator('#pin-err')).toContainText('تم تسجيل الخروج من الحساب على هذا الجهاز');
});

test('a door device that unlocked with the code and then loses its sign-in gets the sign-out message, and can simply type the code again', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: unlockedStore() });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.evaluate(() => window._authFns.signOut(window._auth));
  await expect(page.locator('#pin-gate')).toBeVisible();
  await expect(page.locator('#pin-err')).toContainText('تم تسجيل الخروج من الحساب على هذا الجهاز');
  // Typing the code again works (a fresh anonymous identity is created).
  await page.evaluate(() => { window.__fakeFirebase.auth.nextAnonUid = 'anon-2'; window.__fakeFirebase.store['events/e1/scanSessions'] = {}; });
  await page.locator('#pin-input').fill('123456');
  await page.getByRole('button', { name: 'دخول', exact: true }).click();
  await expect(page.locator('#scanner-view')).toBeVisible();
});

test('a real code change still says the code changed (the identity is still there, only its session is refused)', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: unlockedStore() });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.evaluate(() => { window.__fakeFirebase.denyPaths = ['events/e1/scanSessions']; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('#pin-err')).toContainText('تغيّر كود الدخول');
  await expect(page.locator('#pin-err')).not.toContainText('تم تسجيل الخروج');
});

test('the wording follows the cause when the failure surfaces from Firestore instead of from the sign-in change', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: OWNER, store: { events: { e1: EVENT }, 'events/e1/guests': {} } });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  // Organizer identity present but refused: neither a sign-out nor a code change.
  await page.evaluate(() => sessionRevoked());
  await expect(page.locator('#pin-err')).toContainText('ما عاد عندك صلاحية على هذا الجهاز');
  await expect(page.locator('#pin-err')).not.toContainText('تغيّر كود الدخول');
});

test('pressing "تسجيل خروج من هذا الجهاز" on purpose goes back to the code screen with no error message', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: unlockedStore() });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.locator('#lock-device-btn').click();
  await expect(page.locator('#pin-gate')).toBeVisible();
  await expect(page.locator('#pin-err')).toBeHidden();
});

test('a scanner tab that was never signed in is not disturbed by other tabs signing in and out', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EVENT }, 'events/e1/guests': {} } });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#pin-gate')).toBeVisible();
  await page.evaluate(() => window._authFns.signOut(window._auth));
  await expect(page.locator('#pin-gate')).toBeVisible();
  await expect(page.locator('#pin-err')).toBeHidden();
});

// ---- the scanner follows the event's colour theme (accents only) ----

const fs = require('fs');
const path = require('path');
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };

async function openScanner(page, theme, { unlocked = false } = {}) {
  await stubFirebase(page);
  const store = unlocked ? unlockedStore() : { events: { e1: { ...EVENT, theme } }, 'events/e1/guests': {} };
  if (unlocked) store.events.e1 = { ...EVENT, theme };
  await seedFakeFirebase(page, unlocked ? { user: DEVICE, store } : { store });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator(unlocked ? '#scanner-view' : '#pin-gate')).toBeVisible();
}
const look = (page) => page.evaluate(() => ({
  bg: getComputedStyle(document.body).backgroundColor,
  title: getComputedStyle(document.querySelector('h1')).color,
  attr: document.body.getAttribute('data-theme'),
}));

const SCAN_LOOKS = {
  rose:     { title: '#E8B4B8', bg: '#14090C' },
  emerald:  { title: '#D4AF7F', bg: '#07120E' },
  sapphire: { title: '#B8C6E0', bg: '#080C16' },
  gold:     { title: '#E0BC7A', bg: '#0A0A0A' },
  ivory:    { title: '#E0BC7A', bg: '#0A0A0A' },   // the light theme stays dark and gold here
};
for (const [theme, want] of Object.entries(SCAN_LOOKS)) {
  test(`the code screen follows the "${theme}" theme`, async ({ page }) => {
    await openScanner(page, theme);
    const got = await look(page);
    expect(got.title).toBe(rgb(want.title));
    expect(got.bg).toBe(rgb(want.bg));
  });
}

test('an unlocked scanner follows the theme too: buttons and frame take the accent', async ({ page }) => {
  await openScanner(page, 'rose', { unlocked: true });
  const btn = await page.evaluate(() => getComputedStyle(document.querySelector('.btn')).backgroundImage);
  expect(btn).toContain(rgb('#C9879A'));
  expect(btn).toContain(rgb('#E8B4B8'));
  expect(btn).not.toContain(rgb('#E0BC7A'));
});

test('an unknown or missing theme falls back to the default gold, never to a broken page', async ({ page }) => {
  for (const theme of [undefined, 'neon', '"><x', '']) {
    await openScanner(page, theme);
    const got = await look(page);
    expect(got.attr).toBeNull();
    expect(got.title).toBe(rgb('#E0BC7A'));
  }
});

test('whatever the theme, the scanner page is dark and the result colours stay green and red', async ({ page }) => {
  for (const theme of Object.keys(SCAN_LOOKS)) {
    await openScanner(page, theme);
    const c = await page.evaluate(() => {
      const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
      const ov = document.getElementById('result-overlay');
      const css = (cls) => { ov.className = cls; return getComputedStyle(ov).backgroundColor; };
      return { lum: (r + g + b) / 3, allowed: css('rs-allowed'), dup: css('rs-duplicate'), denied: css('rs-denied'), error: css('rs-error') };
    });
    expect(c.lum).toBeLessThan(30);
    expect(c.allowed).toBe('rgb(27, 94, 32)');
    expect(c.dup).toBe('rgb(183, 28, 28)');
    expect(c.denied).toBe('rgb(191, 54, 12)');
    expect(c.error).toBe('rgb(93, 64, 55)');
  }
});

test('the scanner uses the very same accent colours as the dashboard for each theme', async () => {
  const ev = fs.readFileSync(path.join(__dirname, '..', 'event.html'), 'utf8');
  const sc = fs.readFileSync(path.join(__dirname, '..', 'scan.html'), 'utf8');
  for (const t of ['rose', 'emerald', 'sapphire']) {
    const grab = (src) => {
      const m = new RegExp('\\[data-theme="' + t + '"\\]\\s*\\{([^}]*)\\}').exec(src)[1];
      return ['--gold', '--gold-deep', '--accent-rgb', '--bg-base'].map(k => new RegExp(k + ':([^;]+);').exec(m)[1].trim());
    };
    expect(grab(sc)).toEqual(grab(ev));
  }
});

// ---- the scanner reads one guest directly, not the whole collection ----

test('the barcode text is the guest\'s Firestore document id — a code nobody registered under is just "not registered"', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: DEVICE,
    store: unlockedStore({ 'WD-REAL1': { name: 'ضيف حقيقي', id: 'WD-REAL1', scanned: false } }),
  });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();

  await page.locator('#manual-code').fill('WD-GHOST9');
  await page.getByRole('button', { name: 'تحقق ✓' }).click();
  await expect(page.locator('#result-overlay.rs-denied')).toBeVisible();
  await expect(page.locator('#camera-status')).toContainText('باركود غير مسجّل');
});

// The counter reads events/{id}.guestCount / .scannedCount — real fixtures
// carry those fields already (the event.html transactions that create
// guests keep guestCount in step; this is the counter's other half).
function counterStore(guests, scannedCount) {
  const s = unlockedStore(guests);
  s.events.e1 = { ...s.events.e1, guestCount: Object.keys(guests).length, scannedCount };
  return s;
}

test('a successful scan updates the counter and the offline cache right away', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: DEVICE,
    store: counterStore({ 'WD-A': { name: 'أ', id: 'WD-A', scanned: false }, 'WD-B': { name: 'ب', id: 'WD-B', scanned: false } }, 0),
  });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 0 من 2');

  await page.locator('#manual-code').fill('WD-A');
  await page.getByRole('button', { name: 'تحقق ✓' }).click();
  await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 1 من 2');
  const ev = await page.evaluate(() => window.__fakeFirebase.store.events.e1);
  expect(ev.scannedCount).toBe(1);

  await page.getByRole('button', { name: /عرض الأسماء/ }).click();
  await page.locator('#offline-search').fill('أ');
  await expect(page.locator('#offline-list-results')).toContainText('✓ دخل');
});

test('the names list, if already open, shows a scan from this device straight away — no reload, no extra read', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: DEVICE,
    store: counterStore({ 'WD-A': { name: 'أ', id: 'WD-A', scanned: false } }, 0),
  });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.getByRole('button', { name: /عرض الأسماء/ }).click();
  await expect(page.locator('#offline-list-results')).toContainText('تسجيل');
  await expect(page.locator('#offline-list-results')).not.toContainText('✓ دخل');

  await page.locator('#manual-code').fill('WD-A');
  await page.getByRole('button', { name: 'تحقق ✓' }).click();
  await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
  await expect(page.locator('#offline-list-results')).toContainText('الكل دخلوا');
  await page.locator('#offline-search').fill('أ');
  await expect(page.locator('#offline-list-results')).toContainText('✓ دخل');
});

test('the names-list search box uses normal text spacing (Arabic letters stay joined)', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: counterStore({}, 0) });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.getByRole('button', { name: /عرض الأسماء/ }).click();
  expect(await page.locator('#offline-search').evaluate(el => getComputedStyle(el).letterSpacing)).toBe('normal');
});

test('the scanned count is a live document listener: a check-in from another device updates it here too', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: counterStore({ 'WD-A': { name: 'أ', id: 'WD-A', scanned: false } }, 0) });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 0 من 1');

  // Another supervisor's device checks WD-A in — same shape as handleScan's
  // own transaction, bumping both fields together.
  await page.evaluate(async () => {
    const { doc, updateDoc } = window._fsFns;
    window.__fakeFirebase.store['events/e1/guests']['WD-A'].scanned = true;
    await updateDoc(doc(window._db, 'events', 'e1'), { scannedCount: 1 });
  });
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 1 من 1');
});

test('the total ignores events/{id}.guestCount — that field only ever goes up (it survives guest deletes) and would overstate a real event\'s guest count', async ({ page }) => {
  await stubFirebase(page);
  // A real-world shape: 3 guests exist, but guestCount was never decreased
  // by earlier deletes (deleteGuest() in event.html doesn't touch it), so
  // it sits stuck at a stale, higher number — exactly what surfaced this.
  const store = unlockedStore({
    'WD-A': { name: 'أ', id: 'WD-A', scanned: false },
    'WD-B': { name: 'ب', id: 'WD-B', scanned: false },
    'WD-C': { name: 'ج', id: 'WD-C', scanned: false },
  });
  store.events.e1.guestCount = 8;
  await seedFakeFirebase(page, { user: DEVICE, store });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 0 من 3');
});

test('the total is read once, on open — a guest the organizer adds afterward does not change it until this scanner reopens', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: counterStore({ 'WD-A': { name: 'أ', id: 'WD-A', scanned: false } }, 0) });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 0 من 1');

  await page.evaluate(() => {
    window.__fakeFirebase.store['events/e1/guests']['WD-C'] = { name: 'ج', id: 'WD-C', scanned: false };
  });
  await page.waitForTimeout(300);
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 0 من 1');
});

test('a refresh button is pinned on screen at all times — loading, the code screen, and the scanner — for a PWA with no address bar', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EVENT }, 'events/e1/guests': {} } });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#pin-gate')).toBeVisible();
  const btn = page.locator('#refresh-btn');
  await expect(btn).toBeVisible();
  await page.evaluate(() => { window.__beforeReload = true; });
  await Promise.all([page.waitForEvent('load'), btn.click()]);
  expect(await page.evaluate(() => window.__beforeReload)).toBeUndefined();
});

test('the offline name list is sorted (numbers by value, then Arabic alphabetically) — not by arrival order or scanned status', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: DEVICE,
    store: unlockedStore({
      'WD-4': { name: '4', id: 'WD-4', scanned: false },
      'WD-5': { name: '5', id: 'WD-5', scanned: false },
      'WD-2': { name: '2', id: 'WD-2', scanned: false },
      'WD-1': { name: '1', id: 'WD-1', scanned: true },
      'WD-3': { name: '3', id: 'WD-3', scanned: false },
    }),
  });
  await page.goto('/scan.html?event=e1');
  await page.locator('#offline-list-btn').click();
  const names = await page.locator('#offline-list-results .ol-name').allTextContents();
  expect(names).toEqual(['2', '3', '4', '5']);
});

// A door phone reopens scan.html often (lock/unlock, the iOS reload in
// firebase-init.js); each fresh list download costs one read per guest.
function seedOfflineCache(page, ageMs) {
  return page.addInitScript((ageMs) => {
    const t = new Date(Date.now() - ageMs).toISOString();
    localStorage.setItem('scan_offline_cache_e1', JSON.stringify({
      eventName: 'x', guests: [{ name: 'من النسخة المحفوظة', id: 'WD-OLD', scanned: false }], savedAt: t, loadedAt: t, syncedAt: t, syncedOn: t,
    }));
  }, ageMs);
}
const serverGuest = { 'WD-NEW': { name: 'من الخادم', id: 'WD-NEW', scanned: false } };

test('reopening the scanner within 3 hours reuses this device\'s saved names list instead of downloading every guest again', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: counterStore(serverGuest, 0) });
  await seedOfflineCache(page, 60 * 60 * 1000);
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.getByRole('button', { name: /عرض الأسماء/ }).click();
  await expect(page.locator('#offline-list-results')).toContainText('من النسخة المحفوظة');
  await expect(page.locator('#offline-list-results')).not.toContainText('من الخادم');
});

test('a saved names list older than 3 hours is downloaded fresh', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: counterStore(serverGuest, 0) });
  await seedOfflineCache(page, 4 * 60 * 60 * 1000);
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.getByRole('button', { name: /عرض الأسماء/ }).click();
  await expect(page.locator('#offline-list-results')).toContainText('من الخادم');
});

test('"تحديث القائمة" downloads the names list fresh even when the saved copy is recent', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: counterStore(serverGuest, 0) });
  await seedOfflineCache(page, 60 * 60 * 1000);
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.getByRole('button', { name: /عرض الأسماء/ }).click();
  await expect(page.locator('#offline-list-results')).toContainText('من النسخة المحفوظة');
  await page.getByRole('button', { name: /تحديث القائمة/ }).click();
  await expect(page.locator('#offline-list-results')).toContainText('من الخادم');
  await expect(page.locator('#offline-list-results')).not.toContainText('من النسخة المحفوظة');
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 0 من 1');
});

test('the names list comes from the dashboard\'s roster document when there is one (names with "|" included)', async ({ page }) => {
  await stubFirebase(page);
  const store = counterStore(serverGuest, 0);
  store['events/e1/roster'] = { list: { guests: ['WD-R1|1|من القائمة | المجمّعة', 'WD-R2|0|ضيف ثاني'], updatedAt: 'x' } };
  await seedFakeFirebase(page, { user: DEVICE, store });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.getByRole('button', { name: /عرض الأسماء/ }).click();
  const list = page.locator('#offline-list-results');
  await expect(list).toContainText('ضيف ثاني');
  await expect(list).not.toContainText('من القائمة | المجمّعة');
  await expect(list).not.toContainText('من الخادم');
  await page.locator('#offline-search').fill('المجمّعة');
  await expect(list).toContainText('من القائمة | المجمّعة');
  await expect(list.locator('div', { hasText: 'من القائمة | المجمّعة' })).toContainText('✓ دخل');
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 0 من 2');
});

test('scanning a VIP guest shows "★ VIP" on the result; a normal guest shows no flag', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: counterStore({
    'WD-V': { name: 'ضيف مهم', id: 'WD-V', scanned: false, vip: true },
    'WD-N': { name: 'ضيف عادي', id: 'WD-N', scanned: false },
  }, 0) });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.locator('#manual-code').fill('WD-V');
  await page.getByRole('button', { name: 'تحقق ✓' }).click();
  await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
  await expect(page.locator('#result-vip')).toBeVisible();
  await page.getByRole('button', { name: /مسح جديد/ }).click();
  await page.locator('#manual-code').fill('WD-N');
  await page.getByRole('button', { name: 'تحقق ✓' }).click();
  await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
  await expect(page.locator('#result-vip')).toBeHidden();
});

const FRESH_STORE = { events: { e1: EVENT }, 'events/e1/guests': {} };

test('scanner batch 2: the anonymous sign-in starts while the code screen is open, so the tap only waits for the write', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: FRESH_STORE });
  await page.addInitScript(() => { window.__signInDelay = 800; window.__setDocDelay = 1500; });
  await page.goto('/scan.html?event=e1&timing=1');
  await expect(page.locator('#pin-gate')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__fakeFirebase.auth.anonCalls || 0)).toBe(1);
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => !!window.__fakeFirebase.auth.user)).toBe(true);

  await page.locator('#pin-input').fill('1234');
  await page.getByRole('button', { name: 'دخول' }).first().click();
  await expect(page.locator('#scanner-view')).toBeVisible();
  const line = await page.locator('#timing-line').textContent();
  const [, identity, write] = line.match(/هوية (\d+) ms · كتابة (\d+) ms/).map(Number);
  expect(identity).toBeLessThan(100);
  expect(write).toBeGreaterThanOrEqual(1400);
  expect(write).toBeLessThan(1900);
  expect(await page.evaluate(() => window.__fakeFirebase.auth.anonCalls)).toBe(1);
});

test('scanner batch 2: tapping before the warm-up finishes still works and signs in only once', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: FRESH_STORE });
  await page.addInitScript(() => { window.__signInDelay = 2000; });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#pin-gate')).toBeVisible();
  await page.evaluate(() => { document.getElementById('pin-input').value = '1234'; checkPin(); });
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.waitForTimeout(2500);
  await expect(page.locator('#scanner-view')).toBeVisible();
  const st = await page.evaluate(() => ({
    calls: window.__fakeFirebase.auth.anonCalls,
    uid: window.__fakeFirebase.auth.user.uid,
    keys: Object.keys(window.__fakeFirebase.store['events/e1/scanSessions'] || {}),
  }));
  expect(st.calls).toBe(1);
  expect(st.keys).toEqual([st.uid]);
});

test('scanner batch 2: tapping right after locking the device signs in only once and the session matches the user', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: unlockedStore() });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.evaluate(() => { window.__signInDelay = 2000; window.__fakeFirebase.auth.anonCalls = 0; });
  await page.locator('#lock-device-btn').click();
  await expect(page.locator('#pin-gate')).toBeVisible();
  await page.evaluate(() => { document.getElementById('pin-input').value = '1234'; checkPin(); });
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.waitForTimeout(2500);
  await expect(page.locator('#scanner-view')).toBeVisible();
  const st = await page.evaluate(() => ({
    calls: window.__fakeFirebase.auth.anonCalls,
    uid: window.__fakeFirebase.auth.user.uid,
    keys: Object.keys(window.__fakeFirebase.store['events/e1/scanSessions'] || {}),
  }));
  expect(st.calls).toBe(1);
  expect(st.uid).not.toBe('anon-1');
  expect(st.keys).toEqual([st.uid]);
});

test('scanner batch 2: an admin sign-in during a slow warm-up ends with the admin, not an anonymous user', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EVENT }, 'events/e1/guests': {} } });
  await page.addInitScript(() => { window.__signInDelay = 2000; });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#pin-gate')).toBeVisible();
  await page.evaluate(() => { window.__fakeFirebase.auth.nextSignInResult = { uid: 'admin-1', email: 'hsallah@outlook.sa', isAnonymous: false }; });
  await page.evaluate(() => {
    showAdminLogin();
    document.getElementById('admin-email').value = 'hsallah@outlook.sa';
    document.getElementById('admin-pass').value = 'secret123';
    submitAdminLogin();
  });
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.waitForTimeout(2500);
  const u = await page.evaluate(() => window.__fakeFirebase.auth.user);
  expect(u.uid).toBe('admin-1');
  expect(u.isAnonymous).toBeFalsy();
});

test('scanner batch 2: a device that already has a user does not sign in again', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'owner-x', isAnonymous: false, email: 'o@x.com' }, store: FRESH_STORE });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#pin-gate')).toBeVisible();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__fakeFirebase.auth.anonCalls || 0)).toBe(0);
});

test('cross-tab auth: locking the device as a signed-in organizer signs out and does not sign in anonymously', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'owner-x', isAnonymous: false, email: 'o@x.com' }, store: FRESH_STORE });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#pin-gate')).toBeVisible();
  await page.locator('#pin-input').fill('1234');
  await page.getByRole('button', { name: 'دخول' }).first().click();
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.locator('#lock-device-btn').click();
  await expect(page.locator('#pin-gate')).toBeVisible();
  await page.waitForTimeout(500);
  const st = await page.evaluate(() => ({ user: window.__fakeFirebase.auth.user, calls: window.__fakeFirebase.auth.anonCalls || 0 }));
  expect(st.user).toBeNull();
  expect(st.calls).toBe(0);
});

test('cross-tab auth: a door-code device that locks returns to the code screen and a later tap signs in once', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: unlockedStore() });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.evaluate(() => { window.__fakeFirebase.auth.anonCalls = 0; });
  await page.locator('#lock-device-btn').click();
  await expect(page.locator('#pin-gate')).toBeVisible();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__fakeFirebase.auth.anonCalls || 0)).toBe(0);
  await page.locator('#pin-input').fill('1234');
  await page.getByRole('button', { name: 'دخول' }).first().click();
  await expect(page.locator('#scanner-view')).toBeVisible();
  expect(await page.evaluate(() => window.__fakeFirebase.auth.anonCalls || 0)).toBe(1);
});

test('scanner batch 2: the scanner view does not wait for the roster or the counter', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: unlockedStore() });
  await page.addInitScript(() => { window.__getDocDelays = { 'events/e1/roster/list': 4000 }; });
  const t0 = Date.now();
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  expect(Date.now() - t0).toBeLessThan(2500);
});

test('scanner batch 2: the timing line shows only with ?timing=1', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: FRESH_STORE });
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.goto('/scan.html?event=e1&timing=1');
  await page.locator('#pin-input').fill('1234');
  await page.getByRole('button', { name: 'دخول' }).first().click();
  await expect(page.locator('#scanner-view')).toBeVisible();
  await expect(page.locator('#timing-line')).toHaveText(/^هوية \d+ ms · كتابة \d+ ms · المجموع \d+ ms · تأخير النقرة \d+ ms$/);
  expect(logs.some((l) => l.includes('scan timing:'))).toBe(true);

  await page.goto('/scan.html?event=e1');
  await page.locator('#pin-input').fill('1234');
  await page.getByRole('button', { name: 'دخول' }).first().click();
  await expect(page.locator('#scanner-view')).toBeVisible();
  await expect(page.locator('#timing-line')).toHaveCount(0);
});

test('scanner batch 2: qr-scanner is served locally, precached by sw.js, and a failed local copy shows the reload bar', async ({ page }) => {
  const fs = require('fs');
  const html = fs.readFileSync('scan.html', 'utf8');
  expect(html).not.toContain('unpkg.com');
  expect(html).toContain('<script src="vendor/qr-scanner.umd.min.js"></script>');
  const sw = fs.readFileSync('sw.js', 'utf8');
  expect(sw).toMatch(/SHELL_FILES = \[[^\]]*'vendor\/qr-scanner\.umd\.min\.js'/);
  expect(sw).toContain("CACHE_NAME = 'dawaat-scan-v16'");
  expect(fs.readFileSync('vendor/qr-scanner.umd.min.js', 'utf8')).toContain('QrScanner');

  const requested = [];
  page.on('request', (r) => requested.push(r.url()));
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: FRESH_STORE });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#pin-gate')).toBeVisible();
  expect(requested.some((u) => u.includes('unpkg.com'))).toBe(false);
  expect(await page.evaluate(() => typeof QrScanner)).toBe('function');

  await page.route('**/vendor/qr-scanner.umd.min.js', (r) => r.abort());
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#load-fail')).toBeVisible();
});


test('old Android compat: no html file declares inset: or uses aspect-ratio', async () => {
  const fs = require('fs');
  const files = fs.readdirSync('.').filter((f) => f.endsWith('.html') || f.endsWith('.css'));
  expect(files.length).toBeGreaterThan(5);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    expect(src, f + ' uses the inset shorthand').not.toMatch(/(^|[^-\w])inset\s*:/);
    expect(src, f + ' uses aspect-ratio').not.toMatch(/aspect-ratio/);
  }
});

test('old Android compat: the camera box is a square and the scan frame is 65% centred in it', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: unlockedStore() });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.evaluate(() => { document.getElementById('camera-wrapper').style.display = 'block'; });
  const w = await page.locator('#camera-wrapper').boundingBox();
  expect(Math.abs(w.width - w.height)).toBeLessThanOrEqual(1);
  expect(w.width).toBeLessThanOrEqual(320);
  expect(w.width).toBeGreaterThan(250);
  const v = await page.locator('#camera-video').boundingBox();
  expect(Math.abs(v.width - (w.width - 4))).toBeLessThanOrEqual(1);
  expect(Math.abs(v.height - (w.height - 4))).toBeLessThanOrEqual(1);
  const f = await page.locator('.scan-frame').boundingBox();
  const inner = w.width - 4;
  expect(Math.abs(f.width - inner * 0.65)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(f.height - inner * 0.65)).toBeLessThanOrEqual(1.5);
  expect(Math.abs((f.x + f.width / 2) - (w.x + w.width / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs((f.y + f.height / 2) - (w.y + w.height / 2))).toBeLessThanOrEqual(1);
  const line = await page.locator('.scan-line').boundingBox();
  expect(line.width).toBeGreaterThan(0);
});

test('old Android compat: the landing sample card QR is still a square', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/index.html');
  const q = await page.locator('.card-preview .cp-qr').boundingBox();
  expect(q.width).toBeGreaterThan(50);
  expect(Math.abs(q.width - q.height)).toBeLessThanOrEqual(1);
});

test('scanner debug panel: appears only with debug=1', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: unlockedStore() });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await expect(page.locator('#debug-panel')).toHaveCount(0);

  await page.goto('/scan.html?event=e1&debug=1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  const panel = page.locator('#debug-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('BarcodeDetector');
  await expect(panel).toContainText('hasCamera');
  await expect(panel).toContainText('قراءات ناجحة: 0');
  await expect(panel).toContainText('QrScanner بدأ: no');
});


async function clickCloseAndProbe(page) {
  await page.route('**/event.html*', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>x</title>' }));
  await page.evaluate(() => {
    window.addEventListener('beforeunload', () => {
      const a = window.__fakeFirebase.auth;
      sessionStorage.setItem('probe', JSON.stringify({ uid: a.user && a.user.uid, out: a.signOutCalls || 0, anon: a.anonCalls || 0 }));
    });
  });
  await page.locator('#lock-device-btn').click();
  await page.waitForURL(/event\.html\?id=e1/);
  return JSON.parse(await page.evaluate(() => sessionStorage.getItem('probe')));
}

test('close scanner: the organizer sees "إغلاق الماسح", returns to the dashboard and stays signed in', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: OWNER, store: { events: { e1: EVENT }, 'events/e1/guests': {} } });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  const btn = page.locator('#lock-device-btn');
  await expect(btn).toContainText('إغلاق الماسح');
  await expect(btn).toHaveAttribute('aria-label', 'إغلاق الماسح');
  const probe = await clickCloseAndProbe(page);
  expect(probe).toEqual({ uid: 'u1', out: 0, anon: 0 });
});

test('close scanner: an admin signed in on the page gets the same button and keeps the sign-in', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'admin-1', email: 'hsallah@outlook.sa', isAnonymous: false }, store: { events: { e1: EVENT }, 'events/e1/guests': {} } });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await expect(page.locator('#lock-device-btn')).toHaveAttribute('aria-label', 'إغلاق الماسح');
  const probe = await clickCloseAndProbe(page);
  expect(probe).toEqual({ uid: 'admin-1', out: 0, anon: 0 });
});

test('close scanner: a door-code device keeps "تسجيل خروج من هذا الجهاز"', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: unlockedStore() });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  const btn = page.locator('#lock-device-btn');
  await expect(btn).toContainText('تسجيل خروج من هذا الجهاز');
  await expect(btn).toHaveAttribute('aria-label', 'تسجيل خروج من هذا الجهاز');
});


// Full-screen scan result overlay (RESULT_UI in scan.html)
async function scanManual(page, code) {
  await page.locator('#manual-code').fill(code);
  await page.getByRole('button', { name: 'تحقق ✓' }).click();
}
const overlayStore = () => counterStore({
  'WD-A': { name: 'أ', id: 'WD-A', scanned: false },
  'WD-B': { name: 'ب', id: 'WD-B', scanned: false },
  'WD-D': { name: 'مكرر', id: 'WD-D', scanned: true },
}, 1);
async function openOverlayScanner(page, user = DEVICE, vp) {
  if (vp) await page.setViewportSize(vp);
  await stubFirebase(page);
  await seedFakeFirebase(page, { user, store: overlayStore() });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.waitForTimeout(1700);
}

for (const vp of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) {
  test(`result overlay covers the whole viewport at ${vp.width}x${vp.height}, long name included`, async ({ page }) => {
    await openOverlayScanner(page, DEVICE, vp);
    await page.evaluate(() => { window.__fakeFirebase.store['events/e1/guests']['WD-A'].name = 'عبدالرحمن بن محمد بن عبدالعزيز آل سعود الكبير جدا جدا'; });
    await scanManual(page, 'WD-A');
    const ov = page.locator('#result-overlay');
    await expect(ov).toBeVisible();
    await page.waitForTimeout(400);
    const box = await ov.boundingBox();
    expect(box).toEqual({ x: 0, y: 0, width: vp.width, height: vp.height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.getElementById('result-overlay').scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('#result-icon svg')).toBeVisible();
  });
}

test('result overlay: allowed closes by itself after about 5 s, duplicate and denied after about 6 s', async ({ page }) => {
  await openOverlayScanner(page);
  const ov = page.locator('#result-overlay');
  const timeIt = async (code, cls) => {
    await scanManual(page, code);
    await expect(page.locator('#result-overlay.' + cls)).toBeVisible();
    const t0 = Date.now();
    await expect(ov).toBeHidden({ timeout: 8000 });
    return Date.now() - t0;
  };
  const a = await timeIt('WD-A', 'rs-allowed');
  expect(a).toBeGreaterThan(4000); expect(a).toBeLessThan(5600);
  const d = await timeIt('WD-D', 'rs-duplicate');
  expect(d).toBeGreaterThan(5000); expect(d).toBeLessThan(6600);
  await page.waitForTimeout(700);
  const n = await timeIt('WD-GHOST', 'rs-denied');
  expect(n).toBeGreaterThan(5000); expect(n).toBeLessThan(6600);
  expect(await page.evaluate(() => scanCooldown)).toBe(false);
  await expect(page.locator('#camera-status')).toHaveText('وجّه الكاميرا نحو الباركود');
});

test('result overlay: an error stays until tapped; a tap in the first 400 ms is ignored, a later one closes it and frees scanCooldown', async ({ page }) => {
  await openOverlayScanner(page);
  await page.evaluate(() => { window._fsFns.runTransaction = () => Promise.reject(new Error('network')); });
  await scanManual(page, 'WD-A');
  const ov = page.locator('#result-overlay.rs-error');
  await expect(ov).toBeVisible();
  await ov.dispatchEvent('click');
  await expect(ov).toBeVisible();
  expect(await page.evaluate(() => scanCooldown)).toBe(true);
  await page.waitForTimeout(4000);
  await expect(ov).toBeVisible();
  await ov.click();
  await expect(page.locator('#result-overlay')).toBeHidden();
  expect(await page.evaluate(() => scanCooldown)).toBe(false);
  await expect(page.locator('#camera-status')).toHaveText('وجّه الكاميرا نحو الباركود');
});

test('result overlay: the same card re-read within 600 ms of closing is ignored, a different guest scans at once', async ({ page }) => {
  await openOverlayScanner(page);
  await scanManual(page, 'WD-A');
  const ov = page.locator('#result-overlay');
  await expect(ov).toBeVisible();
  await page.waitForTimeout(500);
  await ov.click();
  await expect(ov).toBeHidden();
  await page.evaluate(() => handleScan('WD-A'));
  await page.waitForTimeout(200);
  await expect(ov).toBeHidden();
  await page.evaluate(() => handleScan('WD-B'));
  await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
  await expect(page.locator('#result-name')).toHaveText('ب');
  await expect(ov).toBeHidden({ timeout: 8000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => handleScan('WD-A'));
  await expect(page.locator('#result-overlay.rs-duplicate')).toBeVisible();
});

test('result overlay: manual entry shows it and closes the keyboard (input blurred)', async ({ page }) => {
  await openOverlayScanner(page);
  await page.locator('#manual-code').fill('WD-A');
  await page.locator('#manual-code').focus();
  await page.locator('#manual-code').press('Enter');
  await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
  expect(await page.evaluate(() => document.activeElement === document.getElementById('manual-code'))).toBe(false);
});

test('result overlay: VIP pill and name show; resetScanState hides it', async ({ page }) => {
  await openOverlayScanner(page);
  await page.evaluate(() => { window.__fakeFirebase.store['events/e1/guests']['WD-D'].vip = true; });
  await scanManual(page, 'WD-D');
  await expect(page.locator('#result-name')).toHaveText('مكرر');
  await expect(page.locator('#result-vip')).toBeVisible();
  await page.evaluate(() => resetScanState());
  await expect(page.locator('#result-overlay')).toBeHidden();
});

test('result overlay: sessionRevoked hides it so it never stays over the code gate', async ({ page }) => {
  await openOverlayScanner(page);
  await page.evaluate(() => { window._fsFns.runTransaction = () => Promise.reject(new Error('network')); });
  await scanManual(page, 'WD-A');
  await expect(page.locator('#result-overlay')).toBeVisible();
  await page.evaluate(() => sessionRevoked());
  await expect(page.locator('#result-overlay')).toBeHidden();
  await expect(page.locator('#pin-gate')).toBeVisible();
});

test('result overlay: lockDevice and lockOrClose hide it', async ({ page }) => {
  await openOverlayScanner(page);
  await scanManual(page, 'WD-D');
  await expect(page.locator('#result-overlay')).toBeVisible();
  await page.evaluate(() => lockDevice());
  await expect(page.locator('#result-overlay')).toBeHidden();
  await expect(page.locator('#pin-gate')).toBeVisible();

  await page.route('**/event.html*', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>x</title>' }));
  const ownerPage = await page.context().newPage();
  await stubFirebase(ownerPage);
  await seedFakeFirebase(ownerPage, { user: OWNER, store: overlayStore() });
  await ownerPage.route('**/event.html*', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>x</title>' }));
  await ownerPage.goto('/scan.html?event=e1');
  await expect(ownerPage.locator('#scanner-view')).toBeVisible();
  await ownerPage.evaluate(() => { window.__hid = 0; const f = hideResult; hideResult = function () { window.__hid++; return f.apply(this, arguments); }; });
  await ownerPage.evaluate(() => { handleScan('WD-D'); });
  await expect(ownerPage.locator('#result-overlay')).toBeVisible();
  await ownerPage.locator('#lock-device-btn').click({ force: true });
  expect(await ownerPage.evaluate(() => window.__hid)).toBeGreaterThan(0);
});

test('result overlay: beep and vibrate patterns per state, and no crash without AudioContext', async ({ page }) => {
  await page.addInitScript(() => {
    window.__vib = [];
    navigator.vibrate = (p) => { window.__vib.push(p); return true; };
    window.AudioContext = undefined; window.webkitAudioContext = undefined;
  });
  await openOverlayScanner(page);
  await page.evaluate(() => { window._fsFns.runTransaction = () => Promise.reject(new Error('network')); });
  await scanManual(page, 'WD-A');
  await expect(page.locator('#result-overlay.rs-error')).toBeVisible();
  await page.evaluate(() => hideResult(true));
  await page.evaluate(() => { showResult('allowed', 'x', false); showResult('duplicate', 'x', false); showResult('denied', 'x', false); });
  expect(await page.evaluate(() => window.__vib)).toEqual([300, 80, [150, 80, 150], 300]);
});

test('result overlay: honours reduced motion (no animation)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openOverlayScanner(page);
  await scanManual(page, 'WD-D');
  await expect(page.locator('#result-overlay')).toHaveCSS('animation-name', 'none');
});

const holdCheckIn = (page) => page.evaluate(() => {
  window._fsFns.runTransaction = () => new Promise((resolve, reject) => { window.__held = { resolve, reject }; });
});

for (const teardown of ['lockDevice()', 'resetScanState()', 'sessionRevoked()']) {
  for (const settle of ['ok', 'dup', 'missing', 'fail']) {
    test(`result overlay: a check-in still pending when ${teardown} runs never pops the overlay (${settle})`, async ({ page }) => {
      await openOverlayScanner(page);
      await holdCheckIn(page);
      await scanManual(page, 'WD-A');
      await expect(page.locator('#camera-status')).toHaveText('🔍 جاري التحقق...');
      await page.evaluate((t) => { window.eval(t); }, teardown);
      await page.waitForTimeout(300);
      await page.evaluate((s) => { if (s === 'fail') window.__held.reject(new Error('network')); else window.__held.resolve(s); }, settle);
      await page.waitForTimeout(500);
      await expect(page.locator('#result-overlay')).toBeHidden();
      expect(await page.evaluate(() => resultUp)).toBe(false);
      if (teardown === 'resetScanState()') await expect(page.locator('#start-cam-btn')).toBeVisible();
      else await expect(page.locator('#scanner-view')).toBeHidden();
    });
  }
}

test('result overlay: showResult is a no-op while the scanner view is hidden', async ({ page }) => {
  await openOverlayScanner(page);
  await page.evaluate(() => { document.getElementById('scanner-view').style.display = 'none'; showResult('error', 'x', false, 'y'); });
  await expect(page.locator('#result-overlay')).toBeHidden();
});

test('audio: the camera-start tap unlocks a suspended AudioContext and each beep resumes it again without throwing', async ({ page }) => {
  await page.addInitScript(() => {
    window.__ac = { made: 0, resumes: 0 };
    class FakeAC {
      constructor() { window.__ac.made++; this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
      resume() { window.__ac.resumes++; return Promise.reject(new Error('blocked')); }
      createOscillator() { return { connect() {}, start() {}, stop() {}, frequency: {} }; }
      createGain() { return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
    }
    window.AudioContext = FakeAC;
  });
  await openOverlayScanner(page);
  await page.locator('#start-cam-btn').click();
  expect(await page.evaluate(() => window.__ac)).toEqual({ made: 1, resumes: 1 });
  await scanManual(page, 'WD-A');
  await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
  const ac = await page.evaluate(() => window.__ac);
  expect(ac.made).toBe(1);
  expect(ac.resumes).toBeGreaterThanOrEqual(3);
});

function manyGuests(n) {
  const g = {};
  for (let i = 1; i <= n; i++) g['WD-G' + i] = { name: 'ضيف' + i, id: 'WD-G' + i, scanned: false };
  return g;
}
async function openCounterScanner(page, guests, scannedCount) {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: counterStore(guests, scannedCount) });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
}
const storeCount = (page) => page.evaluate(() => window.__fakeFirebase.store.events.e1.scannedCount);

test('check-in counter: simultaneous check-ins of different guests all count and nobody is kicked out', async ({ page }) => {
  await openCounterScanner(page, manyGuests(6), 0);
  await page.evaluate(async () => {
    // another phone bumps the counter between this phone's read and write
    const real = window._fsFns.runTransaction;
    window._fsFns.runTransaction = (db, fn) => real(db, async (tx) => {
      const r = await fn(tx);
      const ev = window.__fakeFirebase.store.events.e1;
      ev.scannedCount = (ev.scannedCount || 0) + 1;
      return r;
    });
    await Promise.all(['WD-G1', 'WD-G2', 'WD-G3', 'WD-G4', 'WD-G5', 'WD-G6'].map((c) => handleScan(c)));
  });
  expect(await storeCount(page)).toBe(12);
  await expect(page.locator('#scanner-view')).toBeVisible();
  await expect(page.locator('#pin-gate')).toBeHidden();
});

test('check-in counter: plain concurrent check-ins end with scannedCount equal to N', async ({ page }) => {
  await openCounterScanner(page, manyGuests(5), 0);
  await page.evaluate(() => Promise.all(['WD-G1', 'WD-G2', 'WD-G3', 'WD-G4', 'WD-G5'].map((c) => handleScan(c))));
  expect(await storeCount(page)).toBe(5);
  await expect(page.locator('#scanner-view')).toBeVisible();
});

test('check-in counter: an event with no scannedCount goes to 1', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: unlockedStore(manyGuests(1)) });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.evaluate(() => handleScan('WD-G1'));
  expect(await storeCount(page)).toBe(1);
});

test('check-in counter: a duplicate scan does not bump the count', async ({ page }) => {
  const g = manyGuests(1);
  g['WD-G1'].scanned = true;
  await openCounterScanner(page, g, 1);
  await page.evaluate(() => handleScan('WD-G1'));
  await expect(page.locator('#result-overlay.rs-duplicate')).toBeVisible();
  expect(await storeCount(page)).toBe(1);
});

test('check-in retry: a one-off permission-denied with a valid session retries and succeeds', async ({ page }) => {
  await openCounterScanner(page, manyGuests(1), 0);
  await page.evaluate(() => {
    const real = window._fsFns.runTransaction;
    window.__tries = 0;
    window._fsFns.runTransaction = (db, fn) => {
      window.__tries++;
      if (window.__tries === 1) { const e = new Error('denied'); e.code = 'permission-denied'; return Promise.reject(e); }
      return real(db, fn);
    };
  });
  await page.evaluate(() => handleScan('WD-G1'));
  await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
  expect(await page.evaluate(() => window.__tries)).toBe(2);
  expect(await storeCount(page)).toBe(1);
  await expect(page.locator('#scanner-view')).toBeVisible();
});

test('check-in retry: gives up after 2 retries and revokes the device', async ({ page }) => {
  await openCounterScanner(page, manyGuests(1), 0);
  await page.evaluate(() => {
    window.__tries = 0;
    window._fsFns.runTransaction = () => { window.__tries++; const e = new Error('denied'); e.code = 'permission-denied'; return Promise.reject(e); };
  });
  await page.evaluate(() => handleScan('WD-G1'));
  await expect(page.locator('#pin-gate')).toBeVisible();
  expect(await page.evaluate(() => window.__tries)).toBe(3);
});

test('check-in retry: permission-denied with a deleted session revokes at once, no retry', async ({ page }) => {
  await openCounterScanner(page, manyGuests(1), 0);
  await page.evaluate(() => {
    window.__tries = 0;
    delete window.__fakeFirebase.store['events/e1/scanSessions']['anon-1'];
    window._fsFns.runTransaction = () => { window.__tries++; const e = new Error('denied'); e.code = 'permission-denied'; return Promise.reject(e); };
  });
  await page.evaluate(() => handleScan('WD-G1'));
  await expect(page.locator('#pin-gate')).toBeVisible();
  expect(await page.evaluate(() => window.__tries)).toBe(1);
});

test('check-in retry: the organizer (no session doc) is not retried', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', isAnonymous: false, email: 'o@x.com' }, store: counterStore(manyGuests(1), 0) });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.evaluate(() => {
    window.__tries = 0;
    window._fsFns.runTransaction = () => { window.__tries++; const e = new Error('denied'); e.code = 'permission-denied'; return Promise.reject(e); };
  });
  await page.evaluate(() => handleScan('WD-G1'));
  expect(await page.evaluate(() => window.__tries)).toBe(1);
});

test('check-in counter: the event doc is never read in the transaction and the counter patch is an increment', async ({ page }) => {
  await openCounterScanner(page, manyGuests(1), 0);
  await page.evaluate(() => {
    const real = window._fsFns.runTransaction;
    window.__txGets = []; window.__txUpdates = [];
    window._fsFns.runTransaction = (db, fn) => real(db, (tx) => fn({
      get: (ref) => { window.__txGets.push(ref.path); return tx.get(ref); },
      update: (ref, patch) => { window.__txUpdates.push({ path: ref.path, patch }); return tx.update(ref, patch); },
    }));
  });
  await page.evaluate(() => handleScan('WD-G1'));
  const gets = await page.evaluate(() => window.__txGets);
  const updates = await page.evaluate(() => window.__txUpdates);
  expect(gets).toEqual(['events/e1/guests/WD-G1']);
  const ev = updates.find((u) => u.path === 'events/e1');
  expect(ev.patch).toEqual({ scannedCount: { __increment: 1 } });
});

test('check-in retry: locking the device during the backoff cancels the retry, no overlay, one try', async ({ page }) => {
  await openCounterScanner(page, manyGuests(1), 0);
  await page.evaluate(() => {
    window.__tries = 0;
    window._fsFns.runTransaction = () => { window.__tries++; const e = new Error('denied'); e.code = 'permission-denied'; return Promise.reject(e); };
    window.__scanDone = handleScan('WD-G1');
    window.__scanDone.then(() => { window.__finished = true; });
  });
  await page.waitForTimeout(30);
  await page.evaluate(() => lockDevice());
  await page.waitForFunction(() => window.__finished === true);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__tries)).toBe(1);
  await expect(page.locator('#result-overlay')).toBeHidden();
});

// ---- Check-in by name (the names list) ----
const LIST = {
  'WD-AB12X': { name: 'خالد الزهراني', id: 'WD-AB12X', scanned: false },
  'WD-CD34Y': { name: 'نورة السبيعي', id: 'WD-CD34Y', scanned: false },
  'WD-EF56Z': { name: 'فهد المطيري', id: 'WD-EF56Z', scanned: true },
};
const listRow = (page, id) => page.locator('#offline-list-results [data-id="' + id + '"]');
const closeOverlay = (page) => page.evaluate(() => hideResult());
async function openList(page, guests, count = 0, user = DEVICE) {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user, store: counterStore(guests, count) });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.locator('#offline-list-btn').click();
}

test('names list: every unscanned row has a register button and a code tag; scanned rows show "✓ دخل" and no button; meta line explains', async ({ page }) => {
  await openList(page, LIST, 1);
  await expect(page.locator('#offline-list-meta')).toContainText('لم يدخل: 2 من 3');
  await expect(page.locator('#offline-list-meta')).not.toContainText('للقراءة فقط');
  await expect(listRow(page, 'WD-AB12X').getByRole('button', { name: 'تسجيل' })).toBeVisible();
  await expect(listRow(page, 'WD-AB12X').locator('.ol-tag')).toHaveText('AB12');
  await page.locator('#offline-search').fill('فهد');
  await expect(listRow(page, 'WD-EF56Z')).toContainText('✓ دخل');
  await expect(listRow(page, 'WD-EF56Z').locator('button')).toHaveCount(0);
});

test('names list: search by name and by code (code needs 3+ chars or a WD prefix)', async ({ page }) => {
  await openList(page, LIST);
  const rows = page.locator('#offline-list-results .ol-name');
  await page.locator('#offline-search').fill('نورة');
  await expect(rows).toHaveCount(1);
  await page.locator('#offline-search').fill('cd3');
  await expect(rows).toHaveText(['نورة السبيعي']);
  await page.locator('#offline-search').fill('wd-ef');
  await expect(rows).toHaveText(['فهد المطيري']);
  await page.locator('#offline-search').fill('cd');
  await expect(page.locator('#offline-list-results')).toContainText('ما فيه نتائج');
});

test('names list: confirm flow — cancel writes nothing; confirm checks in through the QR path', async ({ page }) => {
  await openList(page, LIST);
  await listRow(page, 'WD-AB12X').getByRole('button', { name: 'تسجيل' }).click();
  await expect(listRow(page, 'WD-AB12X')).toContainText('الكود: WD-AB12X');
  await expect(listRow(page, 'WD-AB12X').getByRole('button', { name: 'تأكيد الدخول' })).toBeVisible();
  await listRow(page, 'WD-AB12X').getByRole('button', { name: 'إلغاء' }).click();
  await expect(listRow(page, 'WD-AB12X').getByRole('button', { name: 'تسجيل' })).toBeVisible();
  expect(await page.evaluate(() => window.__fakeFirebase.store['events/e1/guests']['WD-AB12X'].scanned)).toBe(false);
  expect(await storeCount(page)).toBe(0);

  await listRow(page, 'WD-AB12X').getByRole('button', { name: 'تسجيل' }).click();
  await page.waitForTimeout(450);
  await listRow(page, 'WD-AB12X').getByRole('button', { name: 'تأكيد الدخول' }).click();
  await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
  await expect(page.locator('#result-name')).toHaveText('خالد الزهراني');
  expect(await page.evaluate(() => window.__fakeFirebase.store['events/e1/guests']['WD-AB12X'].scanned)).toBe(true);
  expect(await storeCount(page)).toBe(1);
  await closeOverlay(page);
  await expect(listRow(page, 'WD-AB12X')).toHaveCount(0);
  await page.locator('#offline-search').fill('خالد');
  await expect(listRow(page, 'WD-AB12X')).toContainText(/✓ دخل \d\d:\d\d/);
  await expect(listRow(page, 'WD-AB12X').locator('button')).toHaveCount(0);
});

test('names list: a tap on "تأكيد الدخول" in the first 400 ms is ignored', async ({ page }) => {
  await openList(page, LIST);
  await page.evaluate(() => { armListRow('WD-AB12X'); checkInFromList('WD-AB12X'); });
  await page.waitForTimeout(300);
  expect(await storeCount(page)).toBe(0);
  await expect(listRow(page, 'WD-AB12X').getByRole('button', { name: 'تأكيد الدخول' })).toBeVisible();
});

test('names list: only one row is open at a time; a new search, a row tap elsewhere or closing the list clears it', async ({ page }) => {
  await openList(page, LIST);
  await listRow(page, 'WD-AB12X').getByRole('button', { name: 'تسجيل' }).click();
  await listRow(page, 'WD-CD34Y').getByRole('button', { name: 'تسجيل' }).click();
  await expect(page.locator('.ol-confirm')).toHaveCount(1);
  await expect(listRow(page, 'WD-CD34Y')).toHaveClass(/ol-confirm/);
  await page.locator('#offline-search').fill('نورة');
  await expect(page.locator('.ol-confirm')).toHaveCount(0);
  await listRow(page, 'WD-CD34Y').getByRole('button', { name: 'تسجيل' }).click();
  await page.locator('#offline-list-btn').click();
  await page.locator('#offline-list-btn').click();
  await expect(page.locator('.ol-confirm')).toHaveCount(0);
});

test('names list: second check-in via list, QR path or manual code is a duplicate and the counter stays 1', async ({ page }) => {
  await openList(page, LIST);
  await listRow(page, 'WD-AB12X').getByRole('button', { name: 'تسجيل' }).click();
  await page.waitForTimeout(450);
  await listRow(page, 'WD-AB12X').getByRole('button', { name: 'تأكيد الدخول' }).click();
  await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
  await closeOverlay(page);
  await page.locator('#manual-code').fill('WD-AB12X');
  await page.getByRole('button', { name: 'تحقق ✓' }).click();
  await expect(page.locator('#result-overlay.rs-duplicate')).toBeVisible();
  expect(await storeCount(page)).toBe(1);
});

test('names list: a stale row (already scanned elsewhere) gives a duplicate and the row flips', async ({ page }) => {
  await openList(page, LIST);
  await page.evaluate(() => { window.__fakeFirebase.store['events/e1/guests']['WD-CD34Y'].scanned = true; });
  await listRow(page, 'WD-CD34Y').getByRole('button', { name: 'تسجيل' }).click();
  await page.waitForTimeout(450);
  await listRow(page, 'WD-CD34Y').getByRole('button', { name: 'تأكيد الدخول' }).click();
  await expect(page.locator('#result-overlay.rs-duplicate')).toBeVisible();
  await expect(listRow(page, 'WD-CD34Y')).toHaveCount(0);
  await page.locator('#offline-search').fill('نورة');
  await expect(listRow(page, 'WD-CD34Y')).toContainText('✓ دخل');
  await expect(listRow(page, 'WD-CD34Y').locator('button')).toHaveCount(0);
  expect(await storeCount(page)).toBe(0);
});

test('names list: a VIP guest shows the VIP flag after a list check-in', async ({ page }) => {
  await openList(page, { 'WD-VIP1': { name: 'ضيف مهم', id: 'WD-VIP1', scanned: false, vip: true } });
  await listRow(page, 'WD-VIP1').getByRole('button', { name: 'تسجيل' }).click();
  await page.waitForTimeout(450);
  await listRow(page, 'WD-VIP1').getByRole('button', { name: 'تأكيد الدخول' }).click();
  await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
  await expect(page.locator('#result-vip')).toBeVisible();
});

test('names list: two guests with the same name show different code tags and confirming one flips only that row', async ({ page }) => {
  await openList(page, {
    'WD-AAAA1': { name: 'محمد العتيبي', id: 'WD-AAAA1', scanned: false },
    'WD-BBBB2': { name: 'محمد العتيبي', id: 'WD-BBBB2', scanned: false },
  });
  await expect(listRow(page, 'WD-AAAA1').locator('.ol-tag')).toHaveText('AAAA');
  await expect(listRow(page, 'WD-BBBB2').locator('.ol-tag')).toHaveText('BBBB');
  await listRow(page, 'WD-BBBB2').getByRole('button', { name: 'تسجيل' }).click();
  await page.waitForTimeout(450);
  await listRow(page, 'WD-BBBB2').getByRole('button', { name: 'تأكيد الدخول' }).click();
  await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
  await closeOverlay(page);
  await page.locator('#offline-search').fill('محمد');
  await expect(listRow(page, 'WD-BBBB2')).toContainText('✓ دخل');
  await expect(listRow(page, 'WD-AAAA1').getByRole('button', { name: 'تسجيل' })).toBeVisible();
});

test('names list: list-only mode (event doc failed to load) has no register buttons and stays read-only', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EVENT }, 'events/e1/guests': {} } });
  await page.addInitScript(() => {
    localStorage.setItem('scan_offline_cache_e1', JSON.stringify({
      eventName: 'حفل تجريبي',
      guests: [{ name: 'محمد الشمري', id: 'WD-9', scanned: false }, { name: 'سارة', id: 'WD-8', scanned: true }],
      savedAt: new Date().toISOString(),
    }));
    window.__failNextGetDoc = true;
  });
  await page.goto('/scan.html?event=e1');
  await page.getByRole('button', { name: 'عرض آخر نسخة محفوظة بدون إنترنت' }).click();
  await expect(page.locator('#offline-list-results')).toContainText('محمد الشمري');
  await expect(page.locator('#offline-list-results button')).toHaveCount(0);
  await expect(page.locator('#offline-list-meta')).toContainText('للقراءة فقط');
});

test('names list: permission-denied on the write takes the session-revoked path and clears the confirm state', async ({ page }) => {
  await openList(page, LIST);
  await page.evaluate(() => {
    delete window.__fakeFirebase.store['events/e1/scanSessions']['anon-1'];
    window._fsFns.runTransaction = () => { const e = new Error('denied'); e.code = 'permission-denied'; return Promise.reject(e); };
  });
  await listRow(page, 'WD-AB12X').getByRole('button', { name: 'تسجيل' }).click();
  await page.waitForTimeout(450);
  await listRow(page, 'WD-AB12X').getByRole('button', { name: 'تأكيد الدخول' }).click();
  await expect(page.locator('#pin-gate')).toBeVisible();
  expect(await page.evaluate(() => [pendingListId, listBusyId])).toEqual([null, null]);
});

test('names list: 700 guests render at most 60 rows, show the rest note, and fast typing renders once', async ({ page }) => {
  await openList(page, manyGuests(700));
  await expect(page.locator('#offline-list-results .ol-row')).toHaveCount(60);
  await expect(page.locator('#offline-list-results .ol-note')).toContainText('يوجد 640 ضيف آخر لم يدخل — اكتب للبحث');
  await page.evaluate(() => {
    window.__renders = 0;
    const real = window.renderOfflineList;
    renderOfflineList = function () { window.__renders++; return real.apply(this, arguments); };
  });
  await page.evaluate(() => {
    const el = document.getElementById('offline-search');
    'ضيف70'.split('').forEach((_, i, a) => { el.value = a.slice(0, i + 1).join(''); el.dispatchEvent(new Event('input')); });
  });
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__renders)).toBe(1);
  await expect(page.locator('#offline-list-results .ol-row')).toHaveCount(2);
});

test('names list: the organizer (no door code) can check in by name too', async ({ page }) => {
  await openList(page, LIST, 0, OWNER);
  await listRow(page, 'WD-CD34Y').getByRole('button', { name: 'تسجيل' }).click();
  await page.waitForTimeout(450);
  await listRow(page, 'WD-CD34Y').getByRole('button', { name: 'تأكيد الدخول' }).click();
  await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
  expect(await storeCount(page)).toBe(1);
});

test('names list: a long name wraps at 320 px without sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openList(page, { 'WD-LONG1': { name: 'عبدالرحمن بن محمد بن عبدالعزيز بن سلطان الشمري القحطاني الدوسري'.repeat(2), id: 'WD-LONG1', scanned: false } });
  await expect(listRow(page, 'WD-LONG1').getByRole('button', { name: 'تسجيل' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await listRow(page, 'WD-LONG1').getByRole('button', { name: 'تسجيل' }).click();
  await expect(listRow(page, 'WD-LONG1').getByRole('button', { name: 'تأكيد الدخول' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('names list: a QR scan of a guest missing from the saved-copy fallback does not shrink the list or the counter total', async ({ page }) => {
  await openList(page, LIST);
  await page.evaluate(() => {
    guests = [];
    listFallback = { guests: [{ id: 'WD-OLD1', name: 'قديم', scanned: false }, { id: 'WD-OLD2', name: 'قديم ثاني', scanned: false }], savedAt: new Date().toISOString() };
    listCacheSavedAt = listFallback.savedAt;
    renderOfflineList();
  });
  await expect(page.locator('#offline-list-results .ol-name')).toHaveCount(2);
  await page.evaluate(() => handleScan('WD-AB12X'));
  await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
  expect(await page.evaluate(() => guests.length)).toBe(0);
  await expect(page.locator('#offline-list-results .ol-name')).toHaveCount(2);
});

test('names list: tapping "تسجيل" within 200 ms of typing keeps the new confirm state open', async ({ page }) => {
  await openList(page, LIST);
  await listRow(page, 'WD-AB12X').getByRole('button', { name: 'تسجيل' }).click();
  await page.evaluate(() => {
    const el = document.getElementById('offline-search');
    el.value = 'ا';
    el.dispatchEvent(new Event('input'));
    armListRow('WD-CD34Y');
  });
  await page.waitForTimeout(400);
  await expect(page.locator('.ol-confirm')).toHaveCount(1);
  await expect(listRow(page, 'WD-CD34Y')).toHaveClass(/ol-confirm/);
});

test('names list: a guest name with HTML renders as text in the row and in the confirm state', async ({ page }) => {
  await openList(page, { 'WD-XSS01': { name: '<img src=x onerror=alert(1)>', id: 'WD-XSS01', scanned: false } });
  await expect(listRow(page, 'WD-XSS01')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#offline-list-results img')).toHaveCount(0);
  await listRow(page, 'WD-XSS01').getByRole('button', { name: 'تسجيل' }).click();
  await expect(listRow(page, 'WD-XSS01')).toHaveClass(/ol-confirm/);
  await expect(listRow(page, 'WD-XSS01')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#offline-list-results img')).toHaveCount(0);
});

for (const fn of ['lockDevice', 'lockOrClose', 'resetScanState']) {
  test('names list: ' + fn + ' clears the open confirm state', async ({ page }) => {
    await openList(page, LIST);
    await listRow(page, 'WD-AB12X').getByRole('button', { name: 'تسجيل' }).click();
    await expect(page.locator('.ol-confirm')).toHaveCount(1);
    await page.evaluate((f) => { window[f](); }, fn);
    await expect.poll(() => page.evaluate(() => [pendingListId, listBusyId])).toEqual([null, null]);
    await expect(page.locator('.ol-confirm')).toHaveCount(0);
  });
}

// ---- Names list delta sync (who entered on other phones) ----
const ROSTER_MS = Date.now() - 6 * 3600 * 1000;
function rosterStore(rosterEntries, guestDocs) {
  const store = counterStore(guestDocs, 0);
  store['events/e1/roster'] = { list: { guests: rosterEntries, updatedAt: { __timestampMs: ROSTER_MS } } };
  return store;
}
async function openRosterList(page, rosterEntries, guestDocs, init, initArg) {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: DEVICE, store: rosterStore(rosterEntries, guestDocs) });
  if (init) await page.addInitScript(init, initArg);
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
}
const guestQueries = (page) => page.evaluate(() => (window.__fakeFirebase.getDocsQueries || []).filter(q => q.path === 'events/e1/guests'));
const NOW_ISO = () => new Date().toISOString();

test('delta sync: opening the list issues exactly one scannedAt range query and never reads the whole guests collection', async ({ page }) => {
  await openRosterList(page, ['WD-A|0|أحمد', 'WD-B|0|بدر'], {
    'WD-A': { name: 'أحمد', id: 'WD-A', scanned: false },
    'WD-B': { name: 'بدر', id: 'WD-B', scanned: false },
  });
  await page.locator('#offline-list-btn').click();
  await expect.poll(() => guestQueries(page)).toHaveLength(1);
  const [q] = await guestQueries(page);
  expect(q.filters).toHaveLength(1);
  expect(q.filters[0].field).toBe('scannedAt');
  expect(q.filters[0].op).toBe('>');
  expect(q.filters[0].value).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
  expect(q.filters[0].value).toBe(new Date(ROSTER_MS - 5 * 60 * 1000).toISOString());
  expect(q.returned).toBe(0);
});

test('delta sync: a guest admitted on another phone shows as entered (with the time); null and old scannedAt are not returned', async ({ page }) => {
  const at = '2026-10-06T17:14:00.000Z';
  await openRosterList(page, ['WD-A|0|أحمد', 'WD-B|0|بدر', 'WD-C|0|جاسم'], {
    'WD-A': { name: 'أحمد', id: 'WD-A', scanned: true, scannedAt: at },
    'WD-B': { name: 'بدر', id: 'WD-B', scanned: false, scannedAt: null },
    'WD-C': { name: 'جاسم', id: 'WD-C', scanned: false },
  });
  await page.locator('#offline-list-btn').click();
  await expect(page.locator('#offline-list-meta')).toContainText('لم يدخل: 2 من 3');
  const [q] = await guestQueries(page);
  expect(q.returned).toBe(1);
  await expect(listRow(page, 'WD-A')).toHaveCount(0);
  await page.locator('#offline-search').fill('أحمد');
  const expected = await page.evaluate((iso) => listTime(new Date(iso)), at);
  await expect(listRow(page, 'WD-A')).toContainText('✓ دخل ' + expected);
});

test('delta sync: a guest admitted but missing from the roster is added and the total grows', async ({ page }) => {
  await openRosterList(page, ['WD-A|0|أحمد'], {
    'WD-A': { name: 'أحمد', id: 'WD-A', scanned: false },
    'WD-N': { name: 'ضيف جديد', id: 'WD-N', scanned: true, scannedAt: NOW_ISO() },
  });
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 0 من 1');
  await page.locator('#offline-list-btn').click();
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 0 من 2');
  await expect(page.locator('#offline-list-meta')).toContainText('لم يدخل: 1 من 2');
  await page.getByRole('button', { name: /تحديث القائمة/ }).click();
  await expect(page.getByRole('button', { name: /تحديث القائمة/ })).toBeEnabled();
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 0 من 2');
});

test('delta sync: a failed query keeps the list, says "تعذّر التحديث" and does not show the connection banner', async ({ page }) => {
  await openRosterList(page, ['WD-A|0|أحمد'], { 'WD-A': { name: 'أحمد', id: 'WD-A', scanned: false } });
  await page.evaluate(() => { window.__failNextGetDocs = true; });
  await page.locator('#offline-list-btn').click();
  await expect(page.locator('#offline-list-meta')).toContainText('تعذّر التحديث — الأسماء من');
  await expect(listRow(page, 'WD-A')).toBeVisible();
  await expect(page.locator('#connection-banner')).toBeHidden();
});

test('delta sync: a query that never answers times out after 8 seconds with the same message', async ({ page }) => {
  await openRosterList(page, ['WD-A|0|أحمد'], { 'WD-A': { name: 'أحمد', id: 'WD-A', scanned: false } });
  await page.evaluate(() => { window.__getDocsDelay = 20000; });
  await page.locator('#offline-list-btn').click();
  await expect(page.locator('#offline-list-meta')).toContainText('تعذّر التحديث', { timeout: 12000 });
  await expect(listRow(page, 'WD-A')).toBeVisible();
  await expect(page.locator('#connection-banner')).toBeHidden();
});

test('delta sync: permission-denied on the query leads to the session-revoked screen', async ({ page }) => {
  await openRosterList(page, ['WD-A|0|أحمد'], { 'WD-A': { name: 'أحمد', id: 'WD-A', scanned: false } });
  await page.evaluate(() => { window.__fakeFirebase.denyLists.push('events/e1/guests'); });
  await page.locator('#offline-list-btn').click();
  await expect(page.locator('#pin-gate')).toBeVisible();
});

test('delta sync: an open confirm card turns into "✓ دخل" when the guest was admitted elsewhere', async ({ page }) => {
  await openRosterList(page, ['WD-A|0|أحمد', 'WD-B|0|بدر'], {
    'WD-A': { name: 'أحمد', id: 'WD-A', scanned: true, scannedAt: NOW_ISO() },
    'WD-B': { name: 'بدر', id: 'WD-B', scanned: false },
  }, () => { window.__getDocsDelay = 1200; });
  await page.locator('#offline-list-btn').click();
  await listRow(page, 'WD-A').getByRole('button', { name: 'تسجيل' }).click();
  await expect(listRow(page, 'WD-A')).toHaveClass(/ol-confirm/);
  await expect(page.locator('#offline-list-meta')).toContainText('لم يدخل: 1 من 2', { timeout: 6000 });
  await expect(page.locator('.ol-confirm')).toHaveCount(0);
  expect(await page.evaluate(() => pendingListId)).toBeNull();
  await page.locator('#offline-search').fill('أحمد');
  await expect(listRow(page, 'WD-A')).toContainText('✓ دخل');
});

test('delta sync: "تحديث القائمة" re-reads the roster and runs the delta, without reading the whole guests collection', async ({ page }) => {
  await openRosterList(page, ['WD-A|0|أحمد', 'WD-B|0|بدر'], {
    'WD-A': { name: 'أحمد', id: 'WD-A', scanned: false },
    'WD-B': { name: 'بدر', id: 'WD-B', scanned: false },
  });
  await page.locator('#offline-list-btn').click();
  await expect.poll(() => guestQueries(page)).toHaveLength(1);
  await page.evaluate(() => {
    const c = window.__fakeFirebase.store['events/e1/guests'];
    c['WD-B'] = { ...c['WD-B'], scanned: true, scannedAt: new Date().toISOString() };
  });
  await page.getByRole('button', { name: /تحديث القائمة/ }).click();
  await expect(page.locator('#offline-list-meta')).toContainText('لم يدخل: 1 من 2');
  const qs = await guestQueries(page);
  expect(qs).toHaveLength(2);
  expect(qs.every(q => q.filters && q.filters[0].field === 'scannedAt')).toBe(true);
});

test('delta sync: a refresh never turns a guest this device admitted back into "not entered"', async ({ page }) => {
  await openRosterList(page, ['WD-A|0|أحمد', 'WD-B|0|بدر'], {
    'WD-A': { name: 'أحمد', id: 'WD-A', scanned: false },
    'WD-B': { name: 'بدر', id: 'WD-B', scanned: false },
  });
  await page.locator('#offline-list-btn').click();
  await page.evaluate(() => { guests.find(g => g.id === 'WD-A').scanned = true; });
  await page.getByRole('button', { name: /تحديث القائمة/ }).click();
  await expect(page.locator('#offline-list-meta')).toContainText('لم يدخل: 1 من 2');
});

test('delta sync: a saved copy without syncedAt (old format) is reloaded once from the roster', async ({ page }) => {
  await openRosterList(page, ['WD-R|0|من القائمة'], { 'WD-R': { name: 'من القائمة', id: 'WD-R', scanned: false } }, () => {
    const t = new Date().toISOString();
    localStorage.setItem('scan_offline_cache_e1', JSON.stringify({
      eventName: 'x', guests: [{ name: 'نسخة قديمة', id: 'WD-OLD', scanned: false }], savedAt: t, loadedAt: t,
    }));
  });
  await page.locator('#offline-list-btn').click();
  await expect(page.locator('#offline-list-results')).toContainText('من القائمة');
  await expect(page.locator('#offline-list-results')).not.toContainText('نسخة قديمة');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('scan_offline_cache_e1')));
  expect(saved.syncedAt).toMatch(/Z$/);
});

test('delta sync: a recent saved copy with syncedAt is reused, and the query uses its cursor', async ({ page }) => {
  const cursor = '2026-01-01T00:00:00.000Z';
  await openRosterList(page, [], {}, (c) => {
    const t = new Date(Date.now() - 3600000).toISOString();
    localStorage.setItem('scan_offline_cache_e1', JSON.stringify({
      eventName: 'x', guests: [{ name: 'من النسخة المحفوظة', id: 'WD-OLD', scanned: false }], savedAt: t, loadedAt: t, syncedAt: '2026-01-01T00:00:00.000Z', syncedOn: t,
    }));
  });
  await page.locator('#offline-list-btn').click();
  await expect(page.locator('#offline-list-results')).toContainText('من النسخة المحفوظة');
  await expect.poll(() => guestQueries(page)).toHaveLength(1);
  expect((await guestQueries(page))[0].filters[0].value).toBe(cursor);
});

test('names list view: empty search shows only who has not entered; search shows everyone; meta says how many', async ({ page }) => {
  await openList(page, LIST, 1);
  await expect(page.locator('#offline-list-meta')).toContainText('لم يدخل: 2 من 3');
  await expect(page.locator('#offline-list-meta')).toContainText('آخر تحديث');
  await expect(listRow(page, 'WD-AB12X')).toBeVisible();
  await expect(listRow(page, 'WD-EF56Z')).toHaveCount(0);
  await expect(page.locator('#offline-search')).toHaveAttribute('placeholder', 'ابحث بالاسم أو الكود — لإظهار من دخل');
  await page.locator('#offline-search').fill('فهد');
  await expect(listRow(page, 'WD-EF56Z')).toContainText('✓ دخل');
});

test('names list view: more than 60 unscanned shows the "N ضيف آخر لم يدخل" note; everyone entered shows "الكل دخلوا"', async ({ page }) => {
  await openList(page, manyGuests(70));
  await expect(page.locator('#offline-list-results .ol-row')).toHaveCount(60);
  await expect(page.locator('#offline-list-results .ol-note')).toHaveText('يوجد 10 ضيف آخر لم يدخل — اكتب للبحث');
});
test('names list view: when everyone entered the list says "الكل دخلوا ✓ (M من M)"; a search with no match says no results', async ({ page }) => {
  await openList(page, { 'WD-E1': { name: 'أ', id: 'WD-E1', scanned: true }, 'WD-E2': { name: 'ب', id: 'WD-E2', scanned: true } }, 2);
  await expect(page.locator('#offline-list-results')).toContainText('الكل دخلوا ✓ (2 من 2)');
  await page.locator('#offline-search').fill('زززز');
  await expect(page.locator('#offline-list-results')).toContainText('ما فيه نتائج');
});

test('names list view: after 10 minutes without a sync the meta line turns amber and asks for a refresh', async ({ page }) => {
  await openList(page, LIST, 1);
  await expect(page.locator('#offline-list-meta')).not.toHaveClass(/ol-stale/);
  await page.evaluate(() => { lastSyncAt = Date.now() - 11 * 60 * 1000; renderOfflineList(); });
  await expect(page.locator('#offline-list-meta')).toHaveClass(/ol-stale/);
  await expect(page.locator('#offline-list-meta')).toContainText('اضغط تحديث القائمة');
});

test('delta sync regression: a guest checked in by name stays "✓ دخل" (with the time) after "تحديث القائمة" even when the roster still says not entered', async ({ page }) => {
  await openRosterList(page, ['WD-A|0|أحمد', 'WD-B|0|بدر'], {
    'WD-A': { name: 'أحمد', id: 'WD-A', scanned: false },
    'WD-B': { name: 'بدر', id: 'WD-B', scanned: false },
  });
  await page.locator('#offline-list-btn').click();
  await listRow(page, 'WD-A').getByRole('button', { name: 'تسجيل' }).click();
  await page.waitForTimeout(450);
  await listRow(page, 'WD-A').getByRole('button', { name: 'تأكيد الدخول' }).click();
  await expect(page.locator('#result-overlay')).toHaveClass(/rs-allowed/);
  await closeOverlay(page);
  await expect(page.locator('#offline-list-meta')).toContainText('لم يدخل: 1 من 2');
  const time = await page.evaluate(() => localCheckinTimes['WD-A']);
  expect(time).toMatch(/^\d\d:\d\d$/);
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: /تحديث القائمة/ }).click();
    await expect(page.getByRole('button', { name: /تحديث القائمة/ })).toBeEnabled();
    await expect(page.locator('#offline-list-meta')).toContainText('لم يدخل: 1 من 2');
    await expect(listRow(page, 'WD-A')).toHaveCount(0);
    await expect(listRow(page, 'WD-B').getByRole('button', { name: 'تسجيل' })).toHaveCount(1);
  }
  await page.locator('#offline-search').fill('أحمد');
  await expect(listRow(page, 'WD-A')).toContainText('✓ دخل ' + time);
  await expect(listRow(page, 'WD-A').getByRole('button')).toHaveCount(0);
  await page.locator('#offline-list-btn').click();
  await page.locator('#offline-list-btn').click();
  await page.locator('#offline-search').fill('أحمد');
  await expect(listRow(page, 'WD-A')).toContainText('✓ دخل ' + time);
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 1 من 2');
});

test('delta sync: a refresh after a first sync never moves the cursor back and reads almost nothing', async ({ page }) => {
  const old = new Date(ROSTER_MS + 3600 * 1000).toISOString();
  await openRosterList(page, ['WD-A|0|أحمد', 'WD-B|0|بدر', 'WD-C|0|جاسم'], {
    'WD-A': { name: 'أحمد', id: 'WD-A', scanned: true, scannedAt: old },
    'WD-B': { name: 'بدر', id: 'WD-B', scanned: true, scannedAt: old },
    'WD-C': { name: 'جاسم', id: 'WD-C', scanned: false },
  });
  await page.locator('#offline-list-btn').click();
  await expect.poll(() => guestQueries(page)).toHaveLength(1);
  await expect(page.locator('#offline-list-meta')).toContainText('لم يدخل: 1 من 3');
  await page.getByRole('button', { name: /تحديث القائمة/ }).click();
  await expect.poll(() => guestQueries(page)).toHaveLength(2);
  const [q1, q2] = await guestQueries(page);
  expect(q1.returned).toBe(2);
  expect(q2.filters[0].value >= q1.filters[0].value).toBe(true);
  expect(q2.returned).toBe(0);
});

test('delta sync: a failed roster read on refresh keeps the old list, shows the failure and downloads no guests', async ({ page }) => {
  await openRosterList(page, ['WD-A|0|أحمد'], { 'WD-A': { name: 'أحمد', id: 'WD-A', scanned: false } });
  await page.locator('#offline-list-btn').click();
  await expect.poll(() => guestQueries(page)).toHaveLength(1);
  await page.evaluate(() => { window.__failNextGetDoc = true; });
  await page.getByRole('button', { name: /تحديث القائمة/ }).click();
  await expect(page.locator('#offline-list-meta')).toContainText('تعذّر التحديث — الأسماء من');
  await expect(page.getByRole('button', { name: /تحديث القائمة/ })).toBeEnabled();
  await expect(listRow(page, 'WD-A')).toBeVisible();
  await expect(page.locator('#connection-banner')).toBeHidden();
  const qs = await guestQueries(page);
  expect(qs.filter(q => !q.filters)).toHaveLength(0);
  expect(qs).toHaveLength(1);
});

for (const fn of ['lockDevice', 'lockOrClose', 'resetScanState']) {
  test('delta sync: ' + fn + ' during a sync resets the busy flag and the late answer touches nothing', async ({ page }) => {
    await openRosterList(page, ['WD-A|0|أحمد'], {
      'WD-A': { name: 'أحمد', id: 'WD-A', scanned: true, scannedAt: NOW_ISO() },
    }, () => { window.__getDocsDelay = 1500; });
    await page.locator('#offline-list-btn').click();
    await expect.poll(() => page.evaluate(() => deltaBusy)).toBe(true);
    const cursor = await page.evaluate(() => syncCursor);
    await page.evaluate((f) => { window[f](); }, fn);
    expect(await page.evaluate(() => deltaBusy)).toBe(false);
    await page.waitForTimeout(2200);
    expect(await page.evaluate(() => [guests.find(g => g.id === 'WD-A').scanned, syncCursor, deltaBusy])).toEqual([false, cursor, false]);
  });
}

test('delta sync: a terminated Firestore client during the sync reloads the page', async ({ page }) => {
  await openRosterList(page, ['WD-A|0|أحمد'], { 'WD-A': { name: 'أحمد', id: 'WD-A', scanned: false } });
  await page.evaluate(() => { window.__marker = 1; window.__failNextGetDocs = true; window._isFirestoreTerminated = () => true; });
  await Promise.all([page.waitForEvent('load'), page.locator('#offline-list-btn').click()]);
  expect(await page.evaluate(() => window.__marker)).toBeUndefined();
});

test('delta sync: a refresh tap during the automatic sync still runs its own forced sync', async ({ page }) => {
  await openRosterList(page, ['WD-A|0|أحمد'], { 'WD-A': { name: 'أحمد', id: 'WD-A', scanned: false } }, () => { window.__getDocsDelay = 800; });
  await page.locator('#offline-list-btn').click();
  await expect.poll(() => page.evaluate(() => deltaBusy)).toBe(true);
  await page.getByRole('button', { name: /تحديث القائمة/ }).click();
  await expect.poll(() => guestQueries(page), { timeout: 8000 }).toHaveLength(2);
  await expect(page.getByRole('button', { name: /تحديث القائمة/ })).toBeEnabled();
});

test('delta sync: a cache-served roster read on refresh keeps the list, no whole-collection read, cursor not advanced', async ({ page }) => {
  await openRosterList(page, ['WD-A|0|أحمد'], { 'WD-A': { name: 'أحمد', id: 'WD-A', scanned: false } });
  await page.locator('#offline-list-btn').click();
  await expect.poll(() => guestQueries(page)).toHaveLength(1);
  await expect(page.locator('#offline-list-meta')).toContainText('آخر تحديث');
  const before = await page.evaluate(() => [syncCursor, lastSyncAt]);
  await page.evaluate(() => { window.__rosterFromCache = true; });
  await page.getByRole('button', { name: /تحديث القائمة/ }).click();
  await expect(page.locator('#offline-list-meta')).toContainText('تعذّر التحديث — الأسماء من');
  await expect(listRow(page, 'WD-A')).toBeVisible();
  expect(await page.evaluate(() => [syncCursor, lastSyncAt])).toEqual(before);
  const qs = await guestQueries(page);
  expect(qs.filter(q => !q.filters)).toHaveLength(0);
  expect(qs).toHaveLength(1);
});

test('delta sync: an expired saved copy with syncedAt keeps its cursor (not older than the copy) and its entered guests', async ({ page }) => {
  const syncedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const loaded = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
  await openRosterList(page, ['WD-A|0|أحمد', 'WD-B|0|بدر'], {
    'WD-A': { name: 'أحمد', id: 'WD-A', scanned: false },
    'WD-B': { name: 'بدر', id: 'WD-B', scanned: false },
  }, ([s, l]) => {
    localStorage.setItem('scan_offline_cache_e1', JSON.stringify({
      eventName: 'x', guests: [{ name: 'أحمد', id: 'WD-A', scanned: true }, { name: 'بدر', id: 'WD-B', scanned: false }],
      savedAt: l, loadedAt: l, syncedAt: s, syncedOn: s,
    }));
  }, [syncedAt, loaded]);
  await page.locator('#offline-list-btn').click();
  await expect.poll(() => guestQueries(page)).toHaveLength(1);
  const [q] = await guestQueries(page);
  expect(q.filters[0].value >= syncedAt).toBe(true);
  expect(q.filters[0].value).toBe(syncedAt);
  await expect(page.locator('#offline-list-meta')).toContainText('لم يدخل: 1 من 2');
  await expect(listRow(page, 'WD-A')).toHaveCount(0);
});

test('delta sync: a roster document that exists without a guests list keeps the list on refresh and downloads nothing', async ({ page }) => {
  await openRosterList(page, ['WD-A|0|أحمد'], { 'WD-A': { name: 'أحمد', id: 'WD-A', scanned: false } });
  await page.locator('#offline-list-btn').click();
  await expect.poll(() => guestQueries(page)).toHaveLength(1);
  await page.evaluate(() => { delete window.__fakeFirebase.store['events/e1/roster'].list.guests; });
  await page.getByRole('button', { name: /تحديث القائمة/ }).click();
  await expect(page.locator('#offline-list-meta')).toContainText('تعذّر التحديث — الأسماء من');
  await expect(listRow(page, 'WD-A')).toBeVisible();
  expect((await guestQueries(page)).filter(q => !q.filters)).toHaveLength(0);
});

test('delta sync: a roster read that never answers times out after 8 seconds on refresh and keeps the list', async ({ page }) => {
  await openRosterList(page, ['WD-A|0|أحمد'], { 'WD-A': { name: 'أحمد', id: 'WD-A', scanned: false } });
  await page.locator('#offline-list-btn').click();
  await expect.poll(() => guestQueries(page)).toHaveLength(1);
  await page.evaluate(() => { window.__getDocDelays = { 'events/e1/roster/list': 20000 }; });
  await page.getByRole('button', { name: /تحديث القائمة/ }).click();
  await expect(page.locator('#offline-list-meta')).toContainText('تعذّر التحديث', { timeout: 12000 });
  await expect(page.getByRole('button', { name: /تحديث القائمة/ })).toBeEnabled();
  await expect(listRow(page, 'WD-A')).toBeVisible();
  expect((await guestQueries(page)).filter(q => !q.filters)).toHaveLength(0);
});
