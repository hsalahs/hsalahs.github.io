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
  await page.addInitScript(() => { window.__fakeFirebase.auth.nextSignInError = { code: 'auth/admin-restricted-operation' }; });
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

  const dupCard = page.locator('#result-duplicate');
  await expect(dupCard).toBeVisible();
  await expect(dupCard).toContainText('تم استخدام هذه الدعوة مسبقًا');
  await expect(dupCard.locator('.result-status.dup')).toHaveCSS('color', 'rgb(244, 67, 54)');
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

  // Second attempt must go through — the failure used to leave scanCooldown
  // stuck on true, so this would have been ignored.
  await page.locator('#manual-code').fill('WD-NET1');
  await page.getByRole('button', { name: 'تحقق ✓' }).click();
  await expect(page.locator('#result-allowed')).toBeVisible();
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
  await expect(page.locator('#splash')).toHaveClass(/hide/, { timeout: 4000 });
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
  await expect(page.locator('#offline-list-results')).toContainText('أحمد العتيبي');
  await expect(page.locator('#offline-list-results')).toContainText('سارة القحطاني');
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

  const fallbackBtn = page.getByRole('button', { name: '📋 عرض آخر نسخة محفوظة بدون إنترنت' });
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
  expect(state.user).toBeNull();
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

  await page.locator('#lock-device-btn').click();
  await expect(page.locator('#pin-gate')).toBeVisible();
  await expect(page.locator('#scanner-view')).toBeHidden();
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
      const css = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).borderColor : null; };
      return { lum: (r + g + b) / 3, allowed: css('#result-allowed'), dup: css('#result-duplicate') };
    });
    expect(c.lum).toBeLessThan(30);
    expect(c.allowed).toBe('rgba(76, 175, 80, 0.3)');
    expect(c.dup).toBe('rgba(244, 67, 54, 0.3)');
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
  await expect(page.locator('#result-denied')).toBeVisible();
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
  await expect(page.locator('#result-allowed')).toBeVisible();
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 1 من 2');
  const ev = await page.evaluate(() => window.__fakeFirebase.store.events.e1);
  expect(ev.scannedCount).toBe(1);

  await page.getByRole('button', { name: /عرض الأسماء/ }).click();
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
  await expect(page.locator('#offline-list-results')).toContainText('لسه');

  await page.locator('#manual-code').fill('WD-A');
  await page.getByRole('button', { name: 'تحقق ✓' }).click();
  await expect(page.locator('#result-allowed')).toBeVisible();
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
  const names = await page.locator('#offline-list-results span').evaluateAll(
    spans => spans.filter((_, i) => i % 2 === 0).map(s => s.textContent)
  );
  expect(names).toEqual(['1', '2', '3', '4', '5']);
});
