const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { stubSupabase, seedScan } = require('./helpers');

// The scanner talks to the server only through Data.scan.* / Data.auth.* (data.js)
// and the fake server in tests/mocks/supabase.stub.js: the door code lives
// there and the page only ever learns ok / wrong / locked. Guests are
// { id, name, scanned?, vip? } rows; the fake server keeps the same counters the
// real triggers keep.

// The page registers sw.js, which would answer the stubbed scripts from the network on a second visit.
test.use({ serviceWorkers: 'block' });

const DEVICE = { id: 'anon-1', is_anonymous: true, email: null };
const OWNER = { id: 'u1', is_anonymous: false, email: 'owner@example.com' };
const ADMIN = { id: 'admin-1', is_anonymous: false, email: 'hsallah@outlook.sa' };
const ADMIN_ACCT = { 'hsallah@outlook.sa': { id: 'admin-1', password: 'correct-password' } };

const unlocked = (guests = [], extra = {}) => ({ user: DEVICE, session: true, guests, ...extra });

async function open(page, opts = {}, url = '/scan.html?event=e1') {
  await stubSupabase(page);
  await seedScan(page, opts);
  await page.goto(url);
}
async function openUnlocked(page, guests = [], extra = {}, url) {
  await open(page, unlocked(guests, extra), url);
  await expect(page.locator('#scanner-view')).toBeVisible();
}
const srv = (page, method, ...args) => page.evaluate(([m, a]) => window.__srv[m](...a), [method, args]);
const fake = (page, fn, arg) => page.evaluate(fn, arg);
const calls = (page, name) => page.evaluate((n) => window.__fakeSupabase.calls.filter((c) => c.name === n), name);
const serverScanned = (page) => page.evaluate(() => window.__srv.door('e1').guests.filter((g) => g.scanned).length);
const G = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: 'WD-G' + (i + 1), name: 'ضيف' + (i + 1), ...extra }));
const unlockWith = async (page, code) => {
  await page.locator('#pin-input').fill(code);
  await page.getByRole('button', { name: 'دخول' }).first().click();
};

test('visiting scan.html with an event remembers it in localStorage', async ({ page }) => {
  await open(page);
  await expect(page.locator('#pin-event-name')).toHaveText('حفل تجريبي');
  expect(await page.evaluate(() => localStorage.getItem('scan_last_event'))).toBe('e1');
});

test('visiting scan.html with no event redirects to the last remembered one (PWA icon launch)', async ({ page }) => {
  await stubSupabase(page);
  await seedScan(page);
  await page.addInitScript(() => localStorage.setItem('scan_last_event', 'e1'));
  await page.goto('/scan.html');
  await expect(page).toHaveURL(/scan\.html\?event=e1/);
  await expect(page.locator('#pin-event-name')).toHaveText('حفل تجريبي');
});

test('visiting scan.html with no event and nothing remembered shows the invalid-link message', async ({ page }) => {
  await open(page, {}, '/scan.html');
  await expect(page.locator('#loading-msg')).toContainText('رابط غير صحيح');
});

test('an event that does not exist shows the not-found message', async ({ page }) => {
  await open(page, {}, '/scan.html?event=nope');
  await expect(page.locator('#loading-msg')).toContainText('هذه المناسبة غير موجودة');
});

test('scan.html runs on data.js and the Supabase client only, with no Firebase left', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'scan.html'), 'utf8');
  expect(html).not.toMatch(/firebase|firestore|_fsFns|_authFns|window\._db|window\._auth/i);
  const order = ['supabase-config.js', 'vendor/supabase.min.js', 'data.js', 'vendor/qr-scanner.umd.min.js', 'icons.js', 'utils.js'].map((f) => html.indexOf('<script src="' + f + '"></script>'));
  expect(order.every((i) => i > 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
});

// ---- the code screen ----

test('the page never keeps the door code — unlocking asks the server, which answers ok / wrong / locked', async ({ page }) => {
  await stubSupabase(page);
  await seedScan(page, { pin: '482913' });
  await page.addInitScript(() => { window.__fakeSupabase.auth.nextAnonUid = 'anon-new'; });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#pin-gate')).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(eventData))).not.toContain('482913');
  await unlockWith(page, '482913');
  await expect(page.locator('#scanner-view')).toBeVisible();
  const st = await page.evaluate(() => ({ user: window.__fakeSupabase.auth.user, session: window.__fakeSupabase.sessions.e1['anon-new'] }));
  expect(st.user.is_anonymous).toBe(true);
  expect(st.session).toBe('482913');
  expect((await calls(page, 'start_scan_session'))[0].args).toEqual({ p_event_id: 'e1', p_pin: '482913' });
});

test('the code field takes six digits', async ({ page }) => {
  await open(page, { pin: '482913' });
  await expect(page.locator('#pin-gate')).toBeVisible();
  await page.locator('#pin-input').pressSequentially('4829139');
  await expect(page.locator('#pin-input')).toHaveValue('482913');
  await page.getByRole('button', { name: 'دخول' }).first().click();
  await expect(page.locator('#scanner-view')).toBeVisible();
});

test('a wrong code shows "رقم غير صحيح" and keeps the scanner locked', async ({ page }) => {
  await open(page);
  await unlockWith(page, '000000');
  await expect(page.locator('#pin-err')).toHaveText('رقم غير صحيح');
  await expect(page.locator('#scanner-view')).toBeHidden();
  expect(await page.evaluate(() => window.__fakeSupabase.sessions.e1 || {})).toEqual({});
});

test('after 10 wrong codes this device is locked: even the right code is refused and no session is made', async ({ page }) => {
  await open(page);
  for (let i = 0; i < 10; i++) {
    await unlockWith(page, '000000');
    await expect(page.locator('#pin-err')).toHaveText('رقم غير صحيح');
  }
  await unlockWith(page, '123456');
  await expect(page.locator('#pin-err')).toBeVisible();
  await expect(page.locator('#pin-err')).toHaveText('الدخول مقفل مؤقتًا، حاول بعد قليل أو كلّم صاحب المناسبة');
  await expect(page.locator('#scanner-view')).toBeHidden();
  expect(await page.evaluate(() => window.__fakeSupabase.sessions.e1 || {})).toEqual({});
  expect(await page.evaluate(() => Data.scan.start('e1', '123456'))).toBe('locked');
});

test('when the event-wide code budget is spent a new device is refused, but a device that already has a session is not', async ({ page }) => {
  await open(page, { pin: '123456' });
  await page.evaluate(() => { window.__srv.door('e1').budgetSpent = true; });
  await unlockWith(page, '123456');
  await expect(page.locator('#pin-err')).toBeVisible();
  await expect(page.locator('#scanner-view')).toBeHidden();
  const p2 = await page.context().newPage();
  await stubSupabase(p2);
  await seedScan(p2, unlocked());
  await p2.addInitScript(() => { window.addEventListener('DOMContentLoaded', () => {}); });
  await p2.goto('/scan.html?event=e1');
  await expect(p2.locator('#scanner-view')).toBeVisible();
});

test('if the anonymous sign-in itself fails, the code screen says it could not connect instead of blaming the code', async ({ page }) => {
  await stubSupabase(page);
  await seedScan(page);
  await page.addInitScript(() => { window.__fakeSupabase.auth.alwaysSignInError = { code: 'anonymous_provider_disabled', message: 'Anonymous sign-ins are disabled', status: 422 }; });
  await page.goto('/scan.html?event=e1');
  await unlockWith(page, '123456');
  await expect(page.locator('#pin-err')).toContainText('تعذّر الاتصال');
  await expect(page.locator('#scanner-view')).toBeHidden();
});

test('a network error while checking the code says it could not connect, not that the code is wrong', async ({ page }) => {
  await open(page, { fail: { start_scan_session: { error: 'network', times: 1 } } });
  await unlockWith(page, '123456');
  await expect(page.locator('#pin-err')).toContainText('تعذّر الاتصال');
  await unlockWith(page, '123456');
  await expect(page.locator('#scanner-view')).toBeVisible();
});

test('a device that proved the code before is let straight back in after a reload', async ({ page }) => {
  await open(page, unlocked());
  await expect(page.locator('#scanner-view')).toBeVisible();
  await expect(page.locator('#pin-gate')).toBeHidden();
});

test('regenerating the door code from the dashboard locks out a device that unlocked with the old one', async ({ page }) => {
  await stubSupabase(page);
  await seedScan(page, unlocked());
  await page.addInitScript(() => { window.__fakeSupabase.doors.e1.pin = '999999'; });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#pin-gate')).toBeVisible();
  await expect(page.locator('#scanner-view')).toBeHidden();
});

// ---- the session is watched ----

test('a code change while the scanner is open sends it back to the code screen within seconds, with a clear reason', async ({ page }) => {
  await page.clock.install();
  await openUnlocked(page);
  await srv(page, 'setPin', 'e1', '999999');
  await page.clock.fastForward(4500);
  await expect(page.locator('#pin-gate')).toBeVisible();
  await expect(page.locator('#pin-err')).toContainText('تغيّر كود الدخول');
  await expect(page.locator('#connection-banner')).toBeHidden();
  await expect(page.locator('#scanner-view')).toBeHidden();
});

test('the session is also asked about directly once a minute, even when the polls cannot get through', async ({ page }) => {
  await page.clock.install();
  await openUnlocked(page);
  await fake(page, () => { window.__fakeSupabase.fail = { door_event: { error: 'network' }, door_guests: { error: 'network' } }; window.__srv.setPin('e1', '999999'); });
  await page.clock.fastForward(30000);
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.clock.fastForward(31000);
  await expect(page.locator('#pin-gate')).toBeVisible();
  await expect(page.locator('#pin-err')).toContainText('تغيّر كود الدخول');
});

test('coming back to the page re-checks the session right away', async ({ page }) => {
  await openUnlocked(page);
  await fake(page, () => { window.__srv.setPin('e1', '999999'); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('#pin-gate')).toBeVisible();
  await expect(page.locator('#pin-err')).toContainText('تغيّر كود الدخول');
});

test('a session the server no longer has also counts as revoked', async ({ page }) => {
  await openUnlocked(page);
  await fake(page, () => { delete window.__fakeSupabase.sessions.e1['anon-1']; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('#pin-gate')).toBeVisible();
});

test('a dropped connection during the re-check does not throw door staff out', async ({ page }) => {
  await openUnlocked(page);
  await fake(page, () => {
    window.__fakeSupabase.fail = { scan_session_valid: { error: 'network', times: 1 } };
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => fake(page, () => window.__fakeSupabase.fail.scan_session_valid.times)).toBe(0);
  await page.waitForTimeout(300);
  await expect(page.locator('#scanner-view')).toBeVisible();
  await expect(page.locator('#pin-gate')).toBeHidden();
});

test('the organizer and the admin have no session to re-check, so they are never sent back to the code screen', async ({ page }) => {
  await open(page, { user: OWNER, owner: true });
  await expect(page.locator('#scanner-view')).toBeVisible();
  const before = (await calls(page, 'scan_session_valid')).length;
  await fake(page, () => { document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(300);
  await expect(page.locator('#scanner-view')).toBeVisible();
  expect((await calls(page, 'scan_session_valid')).length).toBe(before);
});

test('after "تسجيل خروج من هذا الجهاز" the re-check is off and nothing pops up on the code screen', async ({ page }) => {
  await openUnlocked(page);
  await page.locator('#lock-device-btn').click();
  await expect(page.locator('#pin-gate')).toBeVisible();
  await fake(page, () => { window.__srv.setPin('e1', '999999'); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(300);
  await expect(page.locator('#pin-err')).toBeHidden();
});

test('locking the device stops the polls', async ({ page }) => {
  await page.clock.install();
  await openUnlocked(page);
  await page.locator('#lock-device-btn').click();
  await expect(page.locator('#pin-gate')).toBeVisible();
  const before = (await calls(page, 'door_event')).length;
  await page.clock.fastForward(30000);
  await page.waitForTimeout(200);
  expect((await calls(page, 'door_event')).length).toBe(before);
});

// ---- check-in basics ----

test('re-scanning an already-checked-in guest shows a clear red "already used" alert, not a soft warning', async ({ page }) => {
  await openUnlocked(page, [{ id: 'WD-DUP123', name: 'ضيف مكرر', scanned: true }]);
  await page.locator('#manual-code').fill('WD-DUP123');
  await page.getByRole('button', { name: 'تحقق ✓' }).click();
  const dupCard = page.locator('#result-overlay.rs-duplicate');
  await expect(dupCard).toBeVisible();
  await expect(dupCard).toContainText('تم استخدام هذه الدعوة مسبقًا');
  await expect(dupCard).toHaveCSS('background-color', 'rgb(183, 28, 28)');
});

test('a check-in that fails on the network resets the scanner instead of silently ignoring every scan after it', async ({ page }) => {
  await openUnlocked(page, [{ id: 'WD-NET1', name: 'ضيف' }]);
  await fake(page, () => { window.__fakeSupabase.fail = { check_in: { error: 'network', times: 1 } }; });
  await page.locator('#manual-code').fill('WD-NET1');
  await page.getByRole('button', { name: 'تحقق ✓' }).click();
  await expect(page.locator('#camera-status')).toContainText('تعذّر تسجيل الدخول');
  await expect(page.locator('#result-overlay.rs-error')).toBeVisible();
  await page.waitForTimeout(500);
  await page.locator('#result-overlay').click();
  await expect(page.locator('#result-overlay')).toBeHidden();
  await page.locator('#manual-code').fill('WD-NET1');
  await page.getByRole('button', { name: 'تحقق ✓' }).click();
  await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
});

test('"مسح جديد" tears the camera down and returns to the start-camera screen, instead of trusting it\'s still healthy', async ({ page }) => {
  await openUnlocked(page);
  const out = await page.evaluate(() => {
    const log = [];
    qrScanner = { stop: () => log.push('stop'), destroy: () => log.push('destroy') };
    document.getElementById('camera-wrapper').style.display = 'block';
    document.getElementById('start-cam-btn').style.display = 'none';
    resetScanState();
    return { log, qrScannerIsNull: qrScanner === null };
  });
  expect(out.log).toEqual(['stop', 'destroy']);
  expect(out.qrScannerIsNull).toBe(true);
  await expect(page.locator('#camera-wrapper')).toBeHidden();
  await expect(page.locator('#start-cam-btn')).toBeVisible();
  await expect(page.locator('#camera-status')).toHaveText('اضغط لتشغيل الكاميرا');
});

// ---- splash and loading ----

test('the splash screen clears on its own even if the data script fails to load — it must never trap the page behind it', async ({ page }) => {
  await stubSupabase(page);
  await page.route('**/data.js', (route) => route.abort());
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 4000 });
});

test('the splash still clears at the 2 s cap when a subresource never answers and the load event never fires', async ({ page }) => {
  await stubSupabase(page);
  await seedScan(page);
  await page.route('**/vendor/qr-scanner.umd.min.js', () => {});
  await page.goto('/scan.html?event=e1', { waitUntil: 'commit' });
  await page.waitForTimeout(1200);
  await expect(page.locator('#splash')).toHaveCount(1);
  expect(await page.evaluate(() => document.readyState)).not.toBe('complete');
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 2000 });
});

test('the splash hides after load and at least 800 ms, well before 2.2 s, and its node is then removed', async ({ page }) => {
  await stubSupabase(page);
  await seedScan(page);
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
  await open(page, { fail: { event_public: { error: 'network', times: 1 } } });
  const msg = page.locator('#loading-msg');
  await expect(msg).toContainText('تعذّر الاتصال');
  await msg.click();
  await expect(page.locator('#pin-event-name')).toHaveText('حفل تجريبي');
});

test('the guest list is cached locally as it syncs, and can be searched read-only from the scanner view', async ({ page }) => {
  await openUnlocked(page, [{ id: 'WD-1', name: 'أحمد العتيبي', scanned: true }, { id: 'WD-2', name: 'سارة القحطاني' }]);
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
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('scan_offline_cache_e1')));
  expect(saved.guests.map((g) => g.id).sort()).toEqual(['WD-1', 'WD-2']);
  expect(saved.syncedAt).toBeTruthy();
});

test('a device that synced before offers the last saved guest list even when the connection is down on a later visit', async ({ page }) => {
  await stubSupabase(page);
  await seedScan(page, { fail: { event_public: { error: 'network' } } });
  await page.addInitScript(() => {
    localStorage.setItem('scan_offline_cache_e1', JSON.stringify({
      eventName: 'حفل تجريبي',
      guests: [{ name: 'محمد الشمري', id: 'WD-9', scanned: false }],
      savedAt: new Date().toISOString(),
    }));
  });
  await page.goto('/scan.html?event=e1');
  const fallbackBtn = page.getByRole('button', { name: 'عرض آخر نسخة محفوظة بدون إنترنت' });
  await expect(fallbackBtn).toBeVisible();
  await fallbackBtn.click();
  await expect(page.locator('#scan-event-name')).toHaveText('حفل تجريبي');
  await expect(page.locator('#offline-list-results')).toContainText('محمد الشمري');
  await expect(page.locator('#start-cam-btn')).toBeHidden();
});

test('scan.html has no web app manifest, so "Add to Home Screen" uses the current address-bar URL as-is', async ({ page }) => {
  await open(page);
  await expect(page.locator('#pin-event-name')).toHaveText('حفل تجريبي');
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(0);
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes');
});

// ---- who may open the scanner ----

test('an admin who is already signed in on this device skips the PIN gate entirely', async ({ page }) => {
  await open(page, { user: ADMIN, admin: true });
  await expect(page.locator('#pin-gate')).toBeHidden();
  await expect(page.locator('#scanner-view')).toBeVisible();
  await expect(page.locator('#scan-event-name')).toHaveText('حفل تجريبي');
  await expect(page.locator('#lock-device-btn')).toBeVisible();
});

test('the event\'s own organizer opening their scan link skips the PIN gate — their sign-in already proves it', async ({ page }) => {
  await open(page, { user: OWNER, owner: true });
  await expect(page.locator('#pin-gate')).toBeHidden();
  await expect(page.locator('#scanner-view')).toBeVisible();
});

test('a signed-in customer who is neither the admin nor this event\'s owner still has to enter the door PIN', async ({ page }) => {
  await open(page, { user: { id: 'u2', is_anonymous: false, email: 'someone-else@example.com' } });
  await expect(page.locator('#pin-gate')).toBeVisible();
  await expect(page.locator('#scanner-view')).toBeHidden();
});

test('a signed-in non-owner customer who already proved the code keeps their session across reloads, like a door device does', async ({ page }) => {
  await open(page, { user: { id: 'u2', is_anonymous: false, email: 'someone-else@example.com' }, session: true });
  await expect(page.locator('#scanner-view')).toBeVisible();
  await expect(page.locator('#pin-gate')).toBeHidden();
  await expect(page.locator('#lock-device-btn')).toContainText('تسجيل خروج من هذا الجهاز');
  await page.locator('#lock-device-btn').click();
  await expect(page.locator('#pin-gate')).toBeVisible();
  expect(await page.evaluate(() => window.__fakeSupabase.sessions.e1.u2)).toBeUndefined();
});

test('"تسجيل خروج من هذا الجهاز" ends the device\'s session, signs it out, and returns to the PIN screen', async ({ page }) => {
  await openUnlocked(page);
  await expect(page.locator('#lock-device-btn')).toBeVisible();
  await page.locator('#lock-device-btn').click();
  await expect(page.locator('#scanner-view')).toBeHidden();
  await expect(page.locator('#pin-gate')).toBeVisible();
  const state = await page.evaluate(() => ({ user: window.__fakeSupabase.auth.user, session: window.__fakeSupabase.sessions.e1['anon-1'], out: window.__fakeSupabase.auth.signOutCalls }));
  expect(state.user === null || state.user.id !== 'anon-1').toBe(true);
  expect(state.session).toBeUndefined();
  expect(state.out).toBe(1);
});

test('an admin can sign in with their real account on a borrowed device, instead of typing the door PIN', async ({ page }) => {
  await open(page, { admins: ['hsallah@outlook.sa'], accounts: ADMIN_ACCT });
  await expect(page.locator('#pin-gate')).toBeVisible();
  await page.locator('#admin-login-toggle a').click();
  await page.locator('#admin-email').fill('hsallah@outlook.sa');
  await page.locator('#admin-pass').fill('correct-password');
  await page.getByRole('button', { name: 'دخول' }).nth(1).click();
  await expect(page.locator('#scanner-view')).toBeVisible();
  await expect(page.locator('#lock-device-btn')).toContainText('إغلاق الماسح');
});

test('signing in with a non-admin account on the admin-login form is rejected and signed back out', async ({ page }) => {
  await open(page, { admins: ['hsallah@outlook.sa'], accounts: { 'customer@example.com': { id: 'c1', password: 'whatever' } } });
  await page.locator('#admin-login-toggle a').click();
  await page.locator('#admin-email').fill('customer@example.com');
  await page.locator('#admin-pass').fill('whatever');
  await page.getByRole('button', { name: 'دخول' }).nth(1).click();
  await expect(page.locator('#admin-login-err')).toContainText('ليس حساب الأدمن');
  await expect(page.locator('#scanner-view')).toBeHidden();
  expect(await page.evaluate(() => !!window.__fakeSupabase.auth.user)).toBe(false);
});

test('a wrong password on the admin-login form shows an error instead of a generic failure', async ({ page }) => {
  await open(page, { admins: ['hsallah@outlook.sa'], accounts: ADMIN_ACCT });
  await page.locator('#admin-login-toggle a').click();
  await page.locator('#admin-email').fill('hsallah@outlook.sa');
  await page.locator('#admin-pass').fill('wrong');
  await page.getByRole('button', { name: 'دخول' }).nth(1).click();
  await expect(page.locator('#admin-login-err')).toContainText('البريد أو كلمة المرور غلط');
  await expect(page.locator('#scanner-view')).toBeHidden();
});

// Signing out in one tab of a browser signs out every tab of that browser.

test('the organizer opens the scanner on their own account, then signs out in another tab: the scanner says they were signed out, not that the code changed', async ({ page }) => {
  await open(page, { user: OWNER, owner: true });
  await expect(page.locator('#scanner-view')).toBeVisible();
  await srv(page, 'signOutElsewhere');
  await expect(page.locator('#pin-gate')).toBeVisible();
  await expect(page.locator('#scanner-view')).toBeHidden();
  await expect(page.locator('#pin-err')).toContainText('تم تسجيل الخروج من الحساب على هذا الجهاز');
  await expect(page.locator('#pin-err')).not.toContainText('تغيّر كود الدخول');
});

test('the same for the admin', async ({ page }) => {
  await open(page, { user: ADMIN, admin: true });
  await expect(page.locator('#scanner-view')).toBeVisible();
  await srv(page, 'signOutElsewhere');
  await expect(page.locator('#pin-err')).toContainText('تم تسجيل الخروج من الحساب على هذا الجهاز');
});

test('a door device that unlocked with the code and then loses its sign-in gets the sign-out message, and can simply type the code again', async ({ page }) => {
  await openUnlocked(page);
  await srv(page, 'signOutElsewhere');
  await expect(page.locator('#pin-gate')).toBeVisible();
  await expect(page.locator('#pin-err')).toContainText('تم تسجيل الخروج من الحساب على هذا الجهاز');
  await fake(page, () => { window.__fakeSupabase.auth.nextAnonUid = 'anon-2'; });
  await page.locator('#pin-input').fill('123456');
  await page.getByRole('button', { name: 'دخول', exact: true }).click();
  await expect(page.locator('#scanner-view')).toBeVisible();
});

test('a real code change still says the code changed (the identity is still there, only its session is refused)', async ({ page }) => {
  await openUnlocked(page);
  await fake(page, () => { window.__srv.setPin('e1', '999999'); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('#pin-err')).toContainText('تغيّر كود الدخول');
  await expect(page.locator('#pin-err')).not.toContainText('تم تسجيل الخروج');
});

test('the wording follows the cause: an organizer identity that is present but refused is neither a sign-out nor a code change', async ({ page }) => {
  await open(page, { user: OWNER, owner: true });
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.evaluate(() => sessionRevoked());
  await expect(page.locator('#pin-err')).toContainText('ما عاد عندك صلاحية على هذا الجهاز');
  await expect(page.locator('#pin-err')).not.toContainText('تغيّر كود الدخول');
});

test('pressing "تسجيل خروج من هذا الجهاز" on purpose goes back to the code screen with no error message', async ({ page }) => {
  await openUnlocked(page);
  await page.locator('#lock-device-btn').click();
  await expect(page.locator('#pin-gate')).toBeVisible();
  await expect(page.locator('#pin-err')).toBeHidden();
});

test('a scanner tab that was never signed in is not disturbed by other tabs signing in and out', async ({ page }) => {
  await open(page);
  await expect(page.locator('#pin-gate')).toBeVisible();
  await srv(page, 'signOutElsewhere');
  await expect(page.locator('#pin-gate')).toBeVisible();
  await expect(page.locator('#pin-err')).toBeHidden();
});

// ---- the sign-in itself is dead (self-heal) ----

test('a stored sign-in the server no longer accepts: the page signs in anonymously again and shows the code screen', async ({ page }) => {
  const jwt = { message: 'JWT expired', code: 'PGRST301', status: 401 };
  await stubSupabase(page);
  await seedScan(page, { user: { id: 'gone-1', is_anonymous: true, email: null }, session: true,
    fail: { door_event: { error: jwt, times: 1 }, scan_session_valid: { error: jwt, times: 1 } } });
  await page.addInitScript(() => { window.__fakeSupabase.auth.refreshFails = true; });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#pin-gate')).toBeVisible();
  await expect(page.locator('#scanner-view')).toBeHidden();
  const st = await page.evaluate(() => ({ user: window.__fakeSupabase.auth.user, anon: window.__fakeSupabase.auth.anonCalls }));
  expect(st.user.is_anonymous).toBe(true);
  expect(st.user.id).not.toBe('gone-1');
  expect(st.anon).toBe(1);
  await fake(page, () => { window.__fakeSupabase.auth.refreshFails = false; });
  await unlockWith(page, '123456');
  await expect(page.locator('#scanner-view')).toBeVisible();
});

test('an expired token that refreshes fine is invisible: the read runs once more and the scanner stays open', async ({ page }) => {
  await stubSupabase(page);
  await seedScan(page, { ...unlocked([{ id: 'WD-A', name: 'أ' }]), fail: { door_event: { error: { message: 'JWT expired', code: 'PGRST301', status: 401 }, times: 1 } } });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  expect(await page.evaluate(() => window.__fakeSupabase.auth.refreshCalls)).toBe(1);
  expect(await page.evaluate(() => window.__fakeSupabase.auth.anonCalls || 0)).toBe(0);
});

test('mid-event the sign-in dies for good: the code screen says they were signed out and a fresh anonymous identity is ready', async ({ page }) => {
  await openUnlocked(page, [{ id: 'WD-A', name: 'أ' }]);
  await fake(page, () => {
    window.__fakeSupabase.auth.refreshFails = true;
    window.__fakeSupabase.fail = { check_in: { error: { message: 'JWT expired', code: 'PGRST301', status: 401 }, times: 1 } };
  });
  await page.locator('#manual-code').fill('WD-A');
  await page.getByRole('button', { name: 'تحقق ✓' }).click();
  await expect(page.locator('#pin-gate')).toBeVisible();
  await expect(page.locator('#pin-err')).toContainText('تم تسجيل الخروج من الحساب على هذا الجهاز');
  expect((await calls(page, 'check_in')).length).toBe(1);
  const u = await page.evaluate(() => window.__fakeSupabase.auth.user);
  expect(u.is_anonymous).toBe(true);
  expect(u.id).not.toBe('anon-1');
  expect(await serverScanned(page)).toBe(0);
});

test('check-in rejected for an expired token that refreshes fine: the error overlay (rescan), not the code screen, and the check-in is not repeated', async ({ page }) => {
  await openUnlocked(page, [{ id: 'WD-A', name: 'أ' }]);
  await fake(page, () => { window.__fakeSupabase.fail = { check_in: { error: { message: 'JWT expired', code: 'PGRST301', status: 401 }, times: 1 } }; });
  await page.locator('#manual-code').fill('WD-A');
  await page.getByRole('button', { name: 'تحقق ✓' }).click();
  await expect(page.locator('#result-overlay.rs-error')).toBeVisible();
  await expect(page.locator('#scanner-view')).toBeVisible();
  expect((await calls(page, 'check_in')).length).toBe(1);
  expect(await page.evaluate(() => window.__fakeSupabase.auth.refreshCalls)).toBe(1);
  await page.waitForTimeout(500);
  await page.locator('#result-overlay').click();
  await page.locator('#manual-code').fill('WD-A');
  await page.getByRole('button', { name: 'تحقق ✓' }).click();
  await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
});

test('a refresh that cannot reach the server keeps the identity and the door session: no new anonymous user, scanner stays open', async ({ page }) => {
  await page.clock.install();
  await openUnlocked(page, [{ id: 'WD-A', name: 'أ' }]);
  await fake(page, () => {
    window.__fakeSupabase.auth.refreshNetworkFails = true;
    window.__fakeSupabase.fail = { door_event: { error: { message: 'JWT expired', code: 'PGRST301', status: 401 }, times: 1 } };
  });
  await page.clock.fastForward(4500);
  await expect.poll(() => fake(page, () => window.__fakeSupabase.auth.refreshCalls)).toBe(1);
  await page.waitForTimeout(200);
  await expect(page.locator('#scanner-view')).toBeVisible();
  const st = await page.evaluate(() => ({ user: window.__fakeSupabase.auth.user, anon: window.__fakeSupabase.auth.anonCalls || 0, out: window.__fakeSupabase.auth.signOutCalls || 0, session: window.__fakeSupabase.sessions.e1['anon-1'] }));
  expect(st).toEqual({ user: { id: 'anon-1', is_anonymous: true, email: null }, anon: 0, out: 0, session: '123456' });
});

// ---- the scanner follows the event's colour theme (accents only) ----

const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };

async function openScanner(page, theme, { isUnlocked = false } = {}) {
  await stubSupabase(page);
  await seedScan(page, isUnlocked ? unlocked([], { event: { theme } }) : { event: { theme } });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator(isUnlocked ? '#scanner-view' : '#pin-gate')).toBeVisible();
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
  ivory:    { title: '#E0BC7A', bg: '#0A0A0A' },
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
  await openScanner(page, 'rose', { isUnlocked: true });
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

// ---- the scanner asks the server about one guest ----

test('the barcode text is the guest\'s id — a code nobody registered under is just "not registered"', async ({ page }) => {
  await openUnlocked(page, [{ id: 'WD-REAL1', name: 'ضيف حقيقي' }]);
  await page.locator('#manual-code').fill('WD-GHOST9');
  await page.getByRole('button', { name: 'تحقق ✓' }).click();
  await expect(page.locator('#result-overlay.rs-denied')).toBeVisible();
  await expect(page.locator('#camera-status')).toContainText('باركود غير مسجّل');
  expect((await calls(page, 'check_in'))[0].args).toEqual({ p_event_id: 'e1', p_guest_id: 'WD-GHOST9' });
});

test('a guest the organizer deleted after this list was read scans as "not registered" and leaves the list', async ({ page }) => {
  await openUnlocked(page, [{ id: 'WD-A', name: 'أ' }, { id: 'WD-B', name: 'ب' }]);
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 0 من 2');
  await srv(page, 'removeGuest', 'e1', 'WD-A');
  await page.locator('#manual-code').fill('WD-A');
  await page.getByRole('button', { name: 'تحقق ✓' }).click();
  await expect(page.locator('#result-overlay.rs-denied')).toBeVisible();
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 0 من 1');
  expect(await page.evaluate(() => guests.map((g) => g.id))).toEqual(['WD-B']);
});

// ---- counter and list ----

test('a successful scan updates the counter and the offline cache right away', async ({ page }) => {
  await openUnlocked(page, [{ id: 'WD-A', name: 'أ' }, { id: 'WD-B', name: 'ب' }]);
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 0 من 2');
  await page.locator('#manual-code').fill('WD-A');
  await page.getByRole('button', { name: 'تحقق ✓' }).click();
  await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 1 من 2');
  expect(await serverScanned(page)).toBe(1);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('scan_offline_cache_e1')));
  expect(saved.guests.find((g) => g.id === 'WD-A').scanned).toBe(true);
  await page.getByRole('button', { name: /عرض الأسماء/ }).click();
  await page.locator('#offline-search').fill('أ');
  await expect(page.locator('#offline-list-results')).toContainText('✓ دخل');
});

test('the names list, if already open, shows a scan from this device straight away — no reload, no extra request', async ({ page }) => {
  await openUnlocked(page, [{ id: 'WD-A', name: 'أ' }]);
  await page.getByRole('button', { name: /عرض الأسماء/ }).click();
  await expect(page.locator('#offline-list-results')).toContainText('تسجيل');
  await expect(page.locator('#offline-list-results')).not.toContainText('✓ دخل');
  const before = (await calls(page, 'door_guests')).length;
  await page.locator('#manual-code').fill('WD-A');
  await page.getByRole('button', { name: 'تحقق ✓' }).click();
  await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
  await expect(page.locator('#offline-list-results')).toContainText('الكل دخلوا');
  await page.locator('#offline-search').fill('أ');
  await expect(page.locator('#offline-list-results')).toContainText('✓ دخل');
  expect((await calls(page, 'door_guests')).length).toBe(before);
});

test('the names-list search box uses normal text spacing (Arabic letters stay joined)', async ({ page }) => {
  await openUnlocked(page);
  await page.getByRole('button', { name: /عرض الأسماء/ }).click();
  expect(await page.locator('#offline-search').evaluate(el => getComputedStyle(el).letterSpacing)).toBe('normal');
});

test('the scanned count follows the server: a check-in from another device updates it here within a few seconds', async ({ page }) => {
  await page.clock.install();
  await openUnlocked(page, [{ id: 'WD-A', name: 'أ' }]);
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 0 من 1');
  await srv(page, 'checkIn', 'e1', 'WD-A');
  await page.clock.fastForward(4500);
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 1 من 1');
});

test('the total follows guests the organizer adds (through the changed-names poll)', async ({ page }) => {
  await page.clock.install();
  await openUnlocked(page, [{ id: 'WD-A', name: 'أ' }]);
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 0 من 1');
  await srv(page, 'addGuest', 'e1', { id: 'WD-C', name: 'ج' });
  await page.clock.fastForward(4500);
  await page.clock.fastForward(10500);
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 0 من 2');
});

test('a refresh button is pinned on screen at all times — loading, the code screen, and the scanner — for a PWA with no address bar', async ({ page }) => {
  await open(page);
  await expect(page.locator('#pin-gate')).toBeVisible();
  const btn = page.locator('#refresh-btn');
  await expect(btn).toBeVisible();
  await page.evaluate(() => { window.__beforeReload = true; });
  await Promise.all([page.waitForEvent('load'), btn.click()]);
  expect(await page.evaluate(() => window.__beforeReload)).toBeUndefined();
});

test('the offline name list is sorted (numbers by value, then Arabic alphabetically) — not by arrival order or scanned status', async ({ page }) => {
  await openUnlocked(page, [
    { id: 'WD-4', name: '4' }, { id: 'WD-5', name: '5' }, { id: 'WD-2', name: '2' },
    { id: 'WD-1', name: '1', scanned: true }, { id: 'WD-3', name: '3' },
  ]);
  await page.locator('#offline-list-btn').click();
  expect(await page.locator('#offline-list-results .ol-name').allTextContents()).toEqual(['2', '3', '4', '5']);
});

function seedOfflineCache(page, ageMs) {
  return page.addInitScript((ageMs) => {
    const t = new Date(Date.now() - ageMs).toISOString();
    localStorage.setItem('scan_offline_cache_e1', JSON.stringify({
      eventName: 'x', guests: [{ name: 'من النسخة المحفوظة', id: 'WD-OLD', scanned: false }], savedAt: t, loadedAt: t, syncedAt: t, syncedOn: t,
    }));
  }, ageMs);
}
const SERVER_GUEST = [{ id: 'WD-NEW', name: 'من الخادم' }];

test('reopening the scanner within 3 hours shows this device\'s saved names list at once, then catches up from its cursor (a delta, not the whole list)', async ({ page }) => {
  await page.clock.install();
  await stubSupabase(page);
  await seedScan(page, unlocked([{ ...SERVER_GUEST[0], changed_at: new Date().toISOString() }]));
  await seedOfflineCache(page, 60 * 60 * 1000);
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.getByRole('button', { name: /عرض الأسماء/ }).click();
  await expect(page.locator('#offline-list-results')).toContainText('من النسخة المحفوظة');
  await page.clock.fastForward(4500);
  await page.clock.fastForward(10500);
  const gs = await calls(page, 'door_guests');
  expect(gs.length).toBeGreaterThanOrEqual(1);
  expect(gs[0].args.p_since).not.toBeNull();
  await expect(page.locator('#offline-list-results')).toContainText('من الخادم');
});

test('a saved names list older than 3 hours is downloaded fresh', async ({ page }) => {
  await stubSupabase(page);
  await seedScan(page, unlocked(SERVER_GUEST));
  await seedOfflineCache(page, 4 * 60 * 60 * 1000);
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.getByRole('button', { name: /عرض الأسماء/ }).click();
  await expect(page.locator('#offline-list-results')).toContainText('من الخادم');
  await expect(page.locator('#offline-list-results')).not.toContainText('من النسخة المحفوظة');
  expect((await calls(page, 'door_guests'))[0].args.p_since).toBeNull();
});

test('"تحديث القائمة" downloads the whole names list fresh even when the saved copy is recent', async ({ page }) => {
  await stubSupabase(page);
  await seedScan(page, unlocked(SERVER_GUEST));
  await seedOfflineCache(page, 60 * 60 * 1000);
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.getByRole('button', { name: /عرض الأسماء/ }).click();
  await expect(page.locator('#offline-list-results')).toContainText('من النسخة المحفوظة');
  await page.getByRole('button', { name: /تحديث القائمة/ }).click();
  await expect(page.locator('#offline-list-results')).toContainText('من الخادم');
  await expect(page.locator('#offline-list-results')).not.toContainText('من النسخة المحفوظة');
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 0 من 1');
  const gs = await calls(page, 'door_guests');
  expect(gs[gs.length - 1].args.p_since).toBeNull();
});

test('scanning a VIP guest shows "★ VIP" on the result; a normal guest shows no flag', async ({ page }) => {
  await openUnlocked(page, [{ id: 'WD-V', name: 'ضيف مهم', vip: true }, { id: 'WD-N', name: 'ضيف عادي' }]);
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

// ---- entering: speed and identity ----

test('scanner batch 2: the anonymous sign-in starts while the code screen is open, so the tap only waits for the session request', async ({ page }) => {
  await stubSupabase(page);
  await seedScan(page);
  await page.addInitScript(() => { window.__fakeSupabase.auth.signInDelay = 800; window.__fakeSupabase.rpcDelay = { start_scan_session: 1500 }; });
  await page.goto('/scan.html?event=e1&timing=1');
  await expect(page.locator('#pin-gate')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__fakeSupabase.auth.anonCalls || 0)).toBe(1);
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => !!window.__fakeSupabase.auth.user)).toBe(true);
  await unlockWith(page, '123456');
  await expect(page.locator('#scanner-view')).toBeVisible();
  const line = await page.locator('#timing-line').textContent();
  const [, identity, write] = line.match(/هوية (\d+) ms · كتابة (\d+) ms/).map(Number);
  expect(identity).toBeLessThan(100);
  expect(write).toBeGreaterThanOrEqual(1400);
  expect(write).toBeLessThan(1900);
  expect(await page.evaluate(() => window.__fakeSupabase.auth.anonCalls)).toBe(1);
});

test('scanner batch 2: tapping before the warm-up finishes still works and signs in only once', async ({ page }) => {
  await stubSupabase(page);
  await seedScan(page);
  await page.addInitScript(() => { window.__fakeSupabase.auth.signInDelay = 2000; });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#pin-gate')).toBeVisible();
  await page.evaluate(() => { document.getElementById('pin-input').value = '123456'; checkPin(); });
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.waitForTimeout(2500);
  await expect(page.locator('#scanner-view')).toBeVisible();
  const st = await page.evaluate(() => ({ calls: window.__fakeSupabase.auth.anonCalls, uid: window.__fakeSupabase.auth.user.id, keys: Object.keys(window.__fakeSupabase.sessions.e1 || {}) }));
  expect(st.calls).toBe(1);
  expect(st.keys).toEqual([st.uid]);
});

test('scanner batch 2: tapping right after locking the device signs in only once and the session matches the user', async ({ page }) => {
  await openUnlocked(page);
  await page.evaluate(() => { window.__fakeSupabase.auth.signInDelay = 2000; window.__fakeSupabase.auth.anonCalls = 0; });
  await page.locator('#lock-device-btn').click();
  await expect(page.locator('#pin-gate')).toBeVisible();
  await page.evaluate(() => { document.getElementById('pin-input').value = '123456'; checkPin(); });
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.waitForTimeout(2500);
  await expect(page.locator('#scanner-view')).toBeVisible();
  const st = await page.evaluate(() => ({ calls: window.__fakeSupabase.auth.anonCalls, uid: window.__fakeSupabase.auth.user.id, keys: Object.keys(window.__fakeSupabase.sessions.e1 || {}) }));
  expect(st.calls).toBe(1);
  expect(st.uid).not.toBe('anon-1');
  expect(st.keys).toEqual([st.uid]);
});

test('scanner batch 2: an admin sign-in during a slow warm-up ends with the admin, not an anonymous user', async ({ page }) => {
  await stubSupabase(page);
  await seedScan(page, { admins: ['hsallah@outlook.sa'], accounts: ADMIN_ACCT });
  await page.addInitScript(() => { window.__fakeSupabase.auth.signInDelay = 2000; });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#pin-gate')).toBeVisible();
  await page.evaluate(() => {
    showAdminLogin();
    document.getElementById('admin-email').value = 'hsallah@outlook.sa';
    document.getElementById('admin-pass').value = 'correct-password';
    submitAdminLogin();
  });
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.waitForTimeout(2500);
  const u = await page.evaluate(() => window.__fakeSupabase.auth.user);
  expect(u.id).toBe('admin-1');
  expect(u.is_anonymous).toBeFalsy();
});

test('scanner batch 2: a device that already has a user does not sign in again', async ({ page }) => {
  await open(page, { user: { id: 'owner-x', is_anonymous: false, email: 'o@x.com' } });
  await expect(page.locator('#pin-gate')).toBeVisible();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__fakeSupabase.auth.anonCalls || 0)).toBe(0);
});

test('cross-tab auth: locking the device as a signed-in customer who typed the code signs out and does not sign in anonymously', async ({ page }) => {
  await open(page, { user: { id: 'owner-x', is_anonymous: false, email: 'o@x.com' } });
  await expect(page.locator('#pin-gate')).toBeVisible();
  await unlockWith(page, '123456');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.locator('#lock-device-btn').click();
  await expect(page.locator('#pin-gate')).toBeVisible();
  await page.waitForTimeout(500);
  const st = await page.evaluate(() => ({ user: window.__fakeSupabase.auth.user, calls: window.__fakeSupabase.auth.anonCalls || 0 }));
  expect(st.user).toBeNull();
  expect(st.calls).toBe(0);
});

test('cross-tab auth: a door-code device that locks returns to the code screen and a later tap signs in once', async ({ page }) => {
  await openUnlocked(page);
  await page.evaluate(() => { window.__fakeSupabase.auth.anonCalls = 0; });
  await page.locator('#lock-device-btn').click();
  await expect(page.locator('#pin-gate')).toBeVisible();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__fakeSupabase.auth.anonCalls || 0)).toBe(0);
  await unlockWith(page, '123456');
  await expect(page.locator('#scanner-view')).toBeVisible();
  expect(await page.evaluate(() => window.__fakeSupabase.auth.anonCalls || 0)).toBe(1);
});

test('scanner batch 2: the scanner view does not wait for the names list', async ({ page }) => {
  await stubSupabase(page);
  await seedScan(page, { ...unlocked(G(3)), rpcDelay: { door_guests: 4000 } });
  const t0 = Date.now();
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  expect(Date.now() - t0).toBeLessThan(2500);
});

test('scanner batch 2: the timing line shows only with ?timing=1', async ({ page }) => {
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await open(page, {}, '/scan.html?event=e1&timing=1');
  await unlockWith(page, '123456');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await expect(page.locator('#timing-line')).toHaveText(/^هوية \d+ ms · كتابة \d+ ms · المجموع \d+ ms · تأخير النقرة \d+ ms$/);
  expect(logs.some((l) => l.includes('scan timing:'))).toBe(true);
  await page.goto('/scan.html?event=e1');
  await unlockWith(page, '123456');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await expect(page.locator('#timing-line')).toHaveCount(0);
});

test('scanner batch 2: qr-scanner is served locally, the shell is precached by sw.js, and a failed local copy shows the reload bar', async ({ page }) => {
  const html = fs.readFileSync('scan.html', 'utf8');
  expect(html).not.toContain('unpkg.com');
  expect(html).toContain('<script src="vendor/qr-scanner.umd.min.js"></script>');
  const sw = fs.readFileSync('sw.js', 'utf8');
  expect(sw).toMatch(/SHELL_FILES = \[[^\]]*'vendor\/qr-scanner\.umd\.min\.js'/);
  for (const f of ['scan.html', 'supabase-config.js', 'data.js', 'vendor/supabase.min.js', 'icons.js', 'utils.js', 'vendor/qr-scanner-worker.min.js']) {
    expect(sw).toMatch(new RegExp("SHELL_FILES = \\[[^\\]]*'" + f.replace(/[.]/g, '\\.') + "'"));
  }
  expect(sw).not.toMatch(/SHELL_FILES = \[[^\]]*firebase-init/);
  expect(sw).toContain("CACHE_NAME = 'dawaat-scan-v20'");
  expect(fs.readFileSync('vendor/qr-scanner.umd.min.js', 'utf8')).toContain('QrScanner');
  const requested = [];
  page.on('request', (r) => requested.push(r.url()));
  await open(page);
  await expect(page.locator('#pin-gate')).toBeVisible();
  expect(requested.some((u) => u.includes('unpkg.com'))).toBe(false);
  expect(await page.evaluate(() => typeof QrScanner)).toBe('function');
  await page.route('**/vendor/qr-scanner.umd.min.js', (r) => r.abort());
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#load-fail')).toBeVisible();
});

test('old Android compat: no html file declares inset: or uses aspect-ratio', async () => {
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
  await openUnlocked(page);
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
  await openUnlocked(page);
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
      const a = window.__fakeSupabase.auth;
      sessionStorage.setItem('probe', JSON.stringify({ uid: a.user && a.user.id, out: a.signOutCalls || 0, anon: a.anonCalls || 0 }));
    });
  });
  await page.locator('#lock-device-btn').click();
  await page.waitForURL(/event\.html\?id=e1/);
  return JSON.parse(await page.evaluate(() => sessionStorage.getItem('probe')));
}

test('close scanner: the organizer sees "إغلاق الماسح", returns to the dashboard and stays signed in', async ({ page }) => {
  await open(page, { user: OWNER, owner: true });
  await expect(page.locator('#scanner-view')).toBeVisible();
  const btn = page.locator('#lock-device-btn');
  await expect(btn).toContainText('إغلاق الماسح');
  await expect(btn).toHaveAttribute('aria-label', 'إغلاق الماسح');
  expect(await clickCloseAndProbe(page)).toEqual({ uid: 'u1', out: 0, anon: 0 });
});

test('close scanner: an admin signed in on the page gets the same button and keeps the sign-in', async ({ page }) => {
  await open(page, { user: ADMIN, admin: true });
  await expect(page.locator('#scanner-view')).toBeVisible();
  await expect(page.locator('#lock-device-btn')).toHaveAttribute('aria-label', 'إغلاق الماسح');
  expect(await clickCloseAndProbe(page)).toEqual({ uid: 'admin-1', out: 0, anon: 0 });
});

test('close scanner: a door-code device keeps "تسجيل خروج من هذا الجهاز"', async ({ page }) => {
  await openUnlocked(page);
  const btn = page.locator('#lock-device-btn');
  await expect(btn).toContainText('تسجيل خروج من هذا الجهاز');
  await expect(btn).toHaveAttribute('aria-label', 'تسجيل خروج من هذا الجهاز');
});

// ---- Full-screen scan result overlay (RESULT_UI in scan.html) ----
async function scanManual(page, code) {
  await page.locator('#manual-code').fill(code);
  await page.getByRole('button', { name: 'تحقق ✓' }).click();
}
const OVERLAY_GUESTS = [{ id: 'WD-A', name: 'أ' }, { id: 'WD-B', name: 'ب' }, { id: 'WD-D', name: 'مكرر', scanned: true }];
async function openOverlayScanner(page, vp) {
  if (vp) await page.setViewportSize(vp);
  await open(page, unlocked(OVERLAY_GUESTS));
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.waitForTimeout(1700);
}
const failCheckIn = (page) => fake(page, () => { window.__fakeSupabase.fail = { check_in: { error: 'network' } }; });

for (const vp of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) {
  test(`result overlay covers the whole viewport at ${vp.width}x${vp.height}, long name included`, async ({ page }) => {
    await openOverlayScanner(page, vp);
    await srv(page, 'rename', 'e1', 'WD-A', 'عبدالرحمن بن محمد بن عبدالعزيز آل سعود الكبير جدا جدا');
    await scanManual(page, 'WD-A');
    const ov = page.locator('#result-overlay');
    await expect(ov).toBeVisible();
    await page.waitForTimeout(400);
    expect(await ov.boundingBox()).toEqual({ x: 0, y: 0, width: vp.width, height: vp.height });
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
  await failCheckIn(page);
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
  await srv(page, 'setVip', 'e1', 'WD-D', true);
  await scanManual(page, 'WD-D');
  await expect(page.locator('#result-name')).toHaveText('مكرر');
  await expect(page.locator('#result-vip')).toBeVisible();
  await page.evaluate(() => resetScanState());
  await expect(page.locator('#result-overlay')).toBeHidden();
});

test('result overlay: sessionRevoked hides it so it never stays over the code gate', async ({ page }) => {
  await openOverlayScanner(page);
  await failCheckIn(page);
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

  const ownerPage = await page.context().newPage();
  await stubSupabase(ownerPage);
  await seedScan(ownerPage, { user: OWNER, owner: true, guests: OVERLAY_GUESTS });
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
  await failCheckIn(page);
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

for (const teardown of ['lockDevice()', 'resetScanState()', 'sessionRevoked()']) {
  for (const settle of ['ok', 'dup', 'missing', 'fail']) {
    test(`result overlay: a check-in still pending when ${teardown} runs never pops the overlay (${settle})`, async ({ page }) => {
      await openOverlayScanner(page);
      await fake(page, () => { window.__fakeSupabase.holdRpc = { check_in: true }; });
      await scanManual(page, 'WD-A');
      await expect(page.locator('#camera-status')).toHaveText('🔍 جاري التحقق...');
      await page.evaluate((t) => { window.eval(t); }, teardown);
      await page.waitForTimeout(300);
      if (settle === 'dup') await srv(page, 'checkIn', 'e1', 'WD-A');
      if (settle === 'missing') await srv(page, 'removeGuest', 'e1', 'WD-A');
      await page.evaluate((s) => { window.__fakeSupabase.held.shift()(s === 'fail' ? 'fail' : 'ok'); }, settle);
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

// ---- check-in is one atomic server call, never repeated by the page ----

test('check-in counter: simultaneous check-ins of different guests all count and nobody is kicked out', async ({ page }) => {
  await openUnlocked(page, G(6));
  await page.evaluate(() => Promise.all(['WD-G1', 'WD-G2', 'WD-G3', 'WD-G4', 'WD-G5', 'WD-G6'].map((c) => handleScan(c))));
  expect(await serverScanned(page)).toBe(6);
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 6 من 6');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await expect(page.locator('#pin-gate')).toBeHidden();
});

test('check-in counter: another phone checked the card in first — this one gets "already used"', async ({ page }) => {
  await openUnlocked(page, G(1));
  await srv(page, 'checkIn', 'e1', 'WD-G1');
  await page.evaluate(() => handleScan('WD-G1'));
  await expect(page.locator('#result-overlay.rs-duplicate')).toBeVisible();
  expect(await serverScanned(page)).toBe(1);
});

test('check-in counter: a duplicate scan does not bump the count', async ({ page }) => {
  await openUnlocked(page, G(1, { scanned: true }));
  await page.evaluate(() => handleScan('WD-G1'));
  await expect(page.locator('#result-overlay.rs-duplicate')).toBeVisible();
  expect(await serverScanned(page)).toBe(1);
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 1 من 1');
});

test('check-in is sent once with only the event and the barcode, and there is no automatic retry after a failure', async ({ page }) => {
  await openUnlocked(page, G(1));
  await failCheckIn(page);
  await page.evaluate(() => handleScan('WD-G1'));
  await expect(page.locator('#result-overlay.rs-error')).toBeVisible();
  await page.waitForTimeout(1500);
  const cs = await calls(page, 'check_in');
  expect(cs.length).toBe(1);
  expect(cs[0].args).toEqual({ p_event_id: 'e1', p_guest_id: 'WD-G1' });
});

test('check-in whose answer was lost: the guard scans again and the server says "already used" — never a double entry', async ({ page }) => {
  await openUnlocked(page, G(1));
  await fake(page, () => { window.__fakeSupabase.dropReply = { check_in: 1 }; });
  await page.evaluate(() => handleScan('WD-G1'));
  await expect(page.locator('#result-overlay.rs-error')).toBeVisible();
  expect(await serverScanned(page)).toBe(1);
  await page.waitForTimeout(500);
  await page.locator('#result-overlay').click();
  await page.evaluate(() => handleScan('WD-G1'));
  await expect(page.locator('#result-overlay.rs-duplicate')).toBeVisible();
  expect(await serverScanned(page)).toBe(1);
  expect((await calls(page, 'check_in')).length).toBe(2);
});

test('check-in has an 8 second deadline (the timed fetch used for it)', async ({ page }) => {
  await openUnlocked(page, G(1));
  await fake(page, () => { window.fetch = () => new Promise(() => {}); });
  const t0 = Date.now();
  const out = await page.evaluate(async () => {
    try { await Data.timedFetch('https://stub.supabase.test/rest/v1/rpc/check_in', {}); return 'ok'; } catch (e) { return e.message; }
  });
  expect(out).toBe('DATA_TIMEOUT');
  expect(Date.now() - t0).toBeGreaterThanOrEqual(7900);
  expect(Date.now() - t0).toBeLessThan(9500);
});

test('check-in: no_session means this device lost its session — back to the code screen, no retry', async ({ page }) => {
  await openUnlocked(page, G(1));
  await fake(page, () => { delete window.__fakeSupabase.sessions.e1['anon-1']; });
  await page.evaluate(() => handleScan('WD-G1'));
  await expect(page.locator('#pin-gate')).toBeVisible();
  expect((await calls(page, 'check_in')).length).toBe(1);
  expect(await serverScanned(page)).toBe(0);
});

test('check-in: the organizer is not sent to the code screen by a plain network error and is not retried', async ({ page }) => {
  await open(page, { user: OWNER, owner: true, guests: G(1) });
  await expect(page.locator('#scanner-view')).toBeVisible();
  await failCheckIn(page);
  await page.evaluate(() => handleScan('WD-G1'));
  await expect(page.locator('#result-overlay.rs-error')).toBeVisible();
  expect((await calls(page, 'check_in')).length).toBe(1);
  await expect(page.locator('#scanner-view')).toBeVisible();
});

test('check-in: locking the device while a check-in is on its way shows no overlay afterwards', async ({ page }) => {
  await openUnlocked(page, G(1));
  await fake(page, () => { window.__fakeSupabase.holdRpc = { check_in: true }; });
  await page.evaluate(() => { window.__scanDone = handleScan('WD-G1'); window.__scanDone.then(() => { window.__finished = true; }); });
  await page.waitForTimeout(30);
  await page.evaluate(() => lockDevice());
  await page.evaluate(() => { window.__fakeSupabase.held.shift()('ok'); });
  await page.waitForFunction(() => window.__finished === true);
  await page.waitForTimeout(300);
  await expect(page.locator('#result-overlay')).toBeHidden();
});

test('the counter never goes backwards after this device\'s own check-in, even when a poll that was already on its way answers with the old number', async ({ page }) => {
  await page.clock.install();
  await openUnlocked(page, G(3));
  await page.evaluate(() => handleScan('WD-G1'));
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 1 من 3');
  await fake(page, () => { window.__fakeSupabase.counterOverride = { row: { scanned_count: 0 }, times: 1 }; });
  await page.clock.fastForward(4500);
  await expect.poll(() => fake(page, () => window.__fakeSupabase.counterOverride.times)).toBe(0);
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 1 من 3');
});

test('after 20 seconds the server\'s number is taken as it is, so an undo done on the dashboard shows', async ({ page }) => {
  await page.clock.install();
  await openUnlocked(page, G(3));
  await page.evaluate(() => handleScan('WD-G1'));
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 1 من 3');
  await srv(page, 'undo', 'e1', 'WD-G1');
  await page.clock.fastForward(4500);
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 1 من 3');
  await page.clock.fastForward(21000);
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 0 من 3');
});

test('a changed-names answer that predates this device\'s own check-in does not turn the guest back into "not entered"', async ({ page }) => {
  await page.clock.install();
  await openUnlocked(page, G(2));
  await page.evaluate(() => handleScan('WD-G1'));
  await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
  const stale = { rows: [{ id: 'WD-G1', name: 'ضيف1', scanned: false, scannedAt: '', vip: false, changedAt: '' }], full: false, cursor: null, lastChange: 'x' };
  await page.evaluate((r) => onScanGuests(r), stale);
  expect(await page.evaluate(() => guests.find((g) => g.id === 'WD-G1').scanned)).toBe(true);
  await page.clock.fastForward(21000);
  await page.evaluate((r) => onScanGuests(r), stale);
  expect(await page.evaluate(() => guests.find((g) => g.id === 'WD-G1').scanned)).toBe(false);
});

// ---- Check-in by name (the names list) ----
const LIST = [
  { id: 'WD-AB12X', name: 'خالد الزهراني' },
  { id: 'WD-CD34Y', name: 'نورة السبيعي' },
  { id: 'WD-EF56Z', name: 'فهد المطيري', scanned: true },
];
const listRow = (page, id) => page.locator('#offline-list-results [data-id="' + id + '"]');
const closeOverlay = (page) => page.evaluate(() => hideResult());
async function openList(page, guests, asOwner = false) {
  await open(page, asOwner ? { user: OWNER, owner: true, guests } : unlocked(guests));
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.locator('#offline-list-btn').click();
}

test('names list: every unscanned row has a register button and a code tag; scanned rows show "✓ دخل" and no button; meta line explains', async ({ page }) => {
  await openList(page, LIST);
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

test('names list: confirm flow — cancel sends nothing; confirm checks in through the QR path', async ({ page }) => {
  await openList(page, LIST);
  await listRow(page, 'WD-AB12X').getByRole('button', { name: 'تسجيل' }).click();
  await expect(listRow(page, 'WD-AB12X')).toContainText('الكود: WD-AB12X');
  await expect(listRow(page, 'WD-AB12X').getByRole('button', { name: 'تأكيد الدخول' })).toBeVisible();
  await listRow(page, 'WD-AB12X').getByRole('button', { name: 'إلغاء' }).click();
  await expect(listRow(page, 'WD-AB12X').getByRole('button', { name: 'تسجيل' })).toBeVisible();
  expect((await calls(page, 'check_in')).length).toBe(0);
  expect(await serverScanned(page)).toBe(1);
  await listRow(page, 'WD-AB12X').getByRole('button', { name: 'تسجيل' }).click();
  await page.waitForTimeout(450);
  await listRow(page, 'WD-AB12X').getByRole('button', { name: 'تأكيد الدخول' }).click();
  await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
  await expect(page.locator('#result-name')).toHaveText('خالد الزهراني');
  expect(await serverScanned(page)).toBe(2);
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
  expect((await calls(page, 'check_in')).length).toBe(0);
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

test('names list: second check-in via list, QR path or manual code is a duplicate and the counter stays 2', async ({ page }) => {
  await openList(page, LIST);
  await listRow(page, 'WD-AB12X').getByRole('button', { name: 'تسجيل' }).click();
  await page.waitForTimeout(450);
  await listRow(page, 'WD-AB12X').getByRole('button', { name: 'تأكيد الدخول' }).click();
  await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
  await closeOverlay(page);
  await page.locator('#manual-code').fill('WD-AB12X');
  await page.getByRole('button', { name: 'تحقق ✓' }).click();
  await expect(page.locator('#result-overlay.rs-duplicate')).toBeVisible();
  expect(await serverScanned(page)).toBe(2);
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 2 من 3');
});

test('names list: a stale row (already scanned elsewhere) gives a duplicate and the row flips', async ({ page }) => {
  await openList(page, LIST);
  await srv(page, 'checkIn', 'e1', 'WD-CD34Y');
  await listRow(page, 'WD-CD34Y').getByRole('button', { name: 'تسجيل' }).click();
  await page.waitForTimeout(450);
  await listRow(page, 'WD-CD34Y').getByRole('button', { name: 'تأكيد الدخول' }).click();
  await expect(page.locator('#result-overlay.rs-duplicate')).toBeVisible();
  await expect(listRow(page, 'WD-CD34Y')).toHaveCount(0);
  await page.locator('#offline-search').fill('نورة');
  await expect(listRow(page, 'WD-CD34Y')).toContainText('✓ دخل');
  await expect(listRow(page, 'WD-CD34Y').locator('button')).toHaveCount(0);
  expect(await serverScanned(page)).toBe(2);
});

test('names list: a VIP guest shows the VIP flag after a list check-in', async ({ page }) => {
  await openList(page, [{ id: 'WD-VIP1', name: 'ضيف مهم', vip: true }]);
  await listRow(page, 'WD-VIP1').getByRole('button', { name: 'تسجيل' }).click();
  await page.waitForTimeout(450);
  await listRow(page, 'WD-VIP1').getByRole('button', { name: 'تأكيد الدخول' }).click();
  await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
  await expect(page.locator('#result-vip')).toBeVisible();
});

test('names list: two guests with the same name show different code tags and confirming one flips only that row', async ({ page }) => {
  await openList(page, [{ id: 'WD-AAAA1', name: 'محمد العتيبي' }, { id: 'WD-BBBB2', name: 'محمد العتيبي' }]);
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

test('names list: list-only mode (event could not be loaded) has no register buttons and stays read-only', async ({ page }) => {
  await stubSupabase(page);
  await seedScan(page, { fail: { event_public: { error: 'network' } } });
  await page.addInitScript(() => {
    localStorage.setItem('scan_offline_cache_e1', JSON.stringify({
      eventName: 'حفل تجريبي',
      guests: [{ name: 'محمد الشمري', id: 'WD-9', scanned: false }, { name: 'سارة', id: 'WD-8', scanned: true }],
      savedAt: new Date().toISOString(),
    }));
  });
  await page.goto('/scan.html?event=e1');
  await page.getByRole('button', { name: 'عرض آخر نسخة محفوظة بدون إنترنت' }).click();
  await expect(page.locator('#offline-list-results')).toContainText('محمد الشمري');
  await expect(page.locator('#offline-list-results button')).toHaveCount(0);
  await expect(page.locator('#offline-list-meta')).toContainText('للقراءة فقط');
});

test('names list: a refused check-in from the list takes the session-revoked path and clears the confirm state', async ({ page }) => {
  await openList(page, LIST);
  await fake(page, () => { delete window.__fakeSupabase.sessions.e1['anon-1']; });
  await listRow(page, 'WD-AB12X').getByRole('button', { name: 'تسجيل' }).click();
  await page.waitForTimeout(450);
  await listRow(page, 'WD-AB12X').getByRole('button', { name: 'تأكيد الدخول' }).click();
  await expect(page.locator('#pin-gate')).toBeVisible();
  expect(await page.evaluate(() => [pendingListId, listBusyId])).toEqual([null, null]);
});

test('names list: 700 guests render at most 60 rows, show the rest note, and fast typing renders once', async ({ page }) => {
  await openList(page, G(700));
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
  await openList(page, LIST, true);
  await listRow(page, 'WD-CD34Y').getByRole('button', { name: 'تسجيل' }).click();
  await page.waitForTimeout(450);
  await listRow(page, 'WD-CD34Y').getByRole('button', { name: 'تأكيد الدخول' }).click();
  await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
  expect(await serverScanned(page)).toBe(2);
});

test('names list: a long name wraps at 320 px without sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openList(page, [{ id: 'WD-LONG1', name: 'عبدالرحمن بن محمد بن عبدالعزيز بن سلطان الشمري القحطاني الدوسري' }]);
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
  await openList(page, [{ id: 'WD-XSS01', name: '<img src=x onerror=alert(1)>' }]);
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

test('names list view: empty search shows only who has not entered; search shows everyone; meta says how many', async ({ page }) => {
  await openList(page, LIST);
  await expect(page.locator('#offline-list-meta')).toContainText('لم يدخل: 2 من 3');
  await expect(page.locator('#offline-list-meta')).toContainText('آخر تحديث');
  await expect(listRow(page, 'WD-AB12X')).toBeVisible();
  await expect(listRow(page, 'WD-EF56Z')).toHaveCount(0);
  await expect(page.locator('#offline-search')).toHaveAttribute('placeholder', 'ابحث بالاسم أو الكود — لإظهار من دخل');
  await page.locator('#offline-search').fill('فهد');
  await expect(listRow(page, 'WD-EF56Z')).toContainText('✓ دخل');
});

test('names list view: more than 60 unscanned shows the "N ضيف آخر لم يدخل" note', async ({ page }) => {
  await openList(page, G(70));
  await expect(page.locator('#offline-list-results .ol-row')).toHaveCount(60);
  await expect(page.locator('#offline-list-results .ol-note')).toHaveText('يوجد 10 ضيف آخر لم يدخل — اكتب للبحث');
});

test('names list view: when everyone entered the list says "الكل دخلوا ✓ (M من M)"; a search with no match says no results', async ({ page }) => {
  await openList(page, [{ id: 'WD-E1', name: 'أ', scanned: true }, { id: 'WD-E2', name: 'ب', scanned: true }]);
  await expect(page.locator('#offline-list-results')).toContainText('الكل دخلوا ✓ (2 من 2)');
  await page.locator('#offline-search').fill('زززز');
  await expect(page.locator('#offline-list-results')).toContainText('ما فيه نتائج');
});

test('names list view: after 10 minutes without a sync the meta line turns amber and asks for a refresh', async ({ page }) => {
  await openList(page, LIST);
  await expect(page.locator('#offline-list-meta')).not.toHaveClass(/ol-stale/);
  await page.evaluate(() => { lastSyncAt = Date.now() - 11 * 60 * 1000; renderOfflineList(); });
  await expect(page.locator('#offline-list-meta')).toHaveClass(/ol-stale/);
  await expect(page.locator('#offline-list-meta')).toContainText('اضغط تحديث القائمة');
});

// ---- polling: counter every 4 s, names only when something changed ----

test('polling: while nothing changes the names are not asked for again (only the small counter row is), until the full read after a minute', async ({ page }) => {
  await page.clock.install();
  await openUnlocked(page, G(5));
  expect((await calls(page, 'door_guests')).length).toBe(1);
  for (let i = 0; i < 5; i++) await page.clock.fastForward(10500);
  expect((await calls(page, 'door_guests')).length).toBe(1);
  expect((await calls(page, 'door_event')).length).toBeGreaterThanOrEqual(4);
  await page.clock.fastForward(11000);
  await page.clock.fastForward(11000);
  const gs = await calls(page, 'door_guests');
  expect(gs.length).toBe(2);
  expect(gs[1].args.p_since).toBeNull();
});

test('polling: a change makes the next names poll ask for a delta from the cursor with a one-minute safety margin', async ({ page }) => {
  await page.clock.install();
  await stubSupabase(page);
  await seedScan(page, unlocked([{ id: 'WD-A', name: 'أ', changed_at: '2026-01-01T00:10:00.000000+00:00' }]));
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await srv(page, 'checkIn', 'e1', 'WD-A');
  await page.clock.fastForward(4500);
  await page.clock.fastForward(10500);
  const gs = await calls(page, 'door_guests');
  expect(gs.length).toBe(2);
  expect(gs[1].args.p_since).toBe('2026-01-01T00:09:00.000Z');
  expect(gs[1].args.p_limit).toBe(1000);
});

test('polling: a guest checked in on another phone shows as entered in the names list, with the time', async ({ page }) => {
  await page.clock.install();
  await openUnlocked(page, [{ id: 'WD-A', name: 'أحمد' }, { id: 'WD-B', name: 'بدر' }]);
  await page.locator('#offline-list-btn').click();
  await expect(listRow(page, 'WD-A')).toBeVisible();
  await srv(page, 'checkIn', 'e1', 'WD-A');
  await page.clock.fastForward(4500);
  await page.clock.fastForward(10500);
  await expect(listRow(page, 'WD-A')).toHaveCount(0);
  await page.locator('#offline-search').fill('أحمد');
  await expect(listRow(page, 'WD-A')).toContainText(/✓ دخل \d\d:\d\d/);
});

test('polling: an undo, a rename and a VIP change made on the dashboard reach the list', async ({ page }) => {
  await page.clock.install();
  await openUnlocked(page, [{ id: 'WD-A', name: 'أحمد', scanned: true }, { id: 'WD-B', name: 'بدر' }]);
  await page.locator('#offline-list-btn').click();
  await expect(listRow(page, 'WD-A')).toHaveCount(0);
  await srv(page, 'undo', 'e1', 'WD-A');
  await srv(page, 'rename', 'e1', 'WD-B', 'بدر الجديد');
  await srv(page, 'setVip', 'e1', 'WD-B', true);
  await page.clock.fastForward(4500);
  await page.clock.fastForward(10500);
  await expect(listRow(page, 'WD-A').getByRole('button', { name: 'تسجيل' })).toBeVisible();
  await expect(listRow(page, 'WD-B')).toContainText('بدر الجديد');
  expect(await page.evaluate(() => guests.find((g) => g.id === 'WD-B').vip)).toBe(true);
});

test('polling: a guest the organizer deleted leaves the list at the next full read', async ({ page }) => {
  await page.clock.install();
  await openUnlocked(page, [{ id: 'WD-A', name: 'أ' }, { id: 'WD-B', name: 'ب' }]);
  await srv(page, 'removeGuest', 'e1', 'WD-A');
  await page.clock.fastForward(4500);
  await page.clock.fastForward(10500);
  expect(await page.evaluate(() => guests.length)).toBe(2);
  await page.clock.fastForward(60000);
  await expect.poll(() => page.evaluate(() => guests.length)).toBe(1);
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 0 من 1');
});

test('polling: applying the same changed-names answer twice changes nothing (idempotent merge)', async ({ page }) => {
  await openUnlocked(page, [{ id: 'WD-A', name: 'أ' }, { id: 'WD-B', name: 'ب' }]);
  const snap = () => page.evaluate(() => JSON.stringify(guests.map((g) => [g.id, g.name, g.scanned, g.vip]).sort()));
  const res = { rows: [{ id: 'WD-B', name: 'ب جديد', scanned: true, scannedAt: new Date().toISOString(), vip: true, changedAt: '' }, { id: 'WD-Z', name: 'ز', scanned: false, scannedAt: '', vip: false, changedAt: '' }], full: false, cursor: null, lastChange: 'x' };
  await page.evaluate((r) => onScanGuests(r), res);
  const once = await snap();
  await page.evaluate((r) => onScanGuests(r), res);
  expect(await snap()).toBe(once);
  expect(JSON.parse(once).length).toBe(3);
});

test('polling: pauses while the page is hidden and runs at once when it comes back', async ({ page }) => {
  await page.clock.install();
  await openUnlocked(page, G(2));
  await fake(page, () => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward(1000);
  const before = (await calls(page, 'door_event')).length;
  await page.clock.fastForward(30000);
  await page.clock.fastForward(30000);
  expect((await calls(page, 'door_event')).length).toBe(before);
  await srv(page, 'checkIn', 'e1', 'WD-G1');
  await fake(page, () => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(async () => (await calls(page, 'door_event')).length).toBeGreaterThan(before);
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 1 من 2');
});

test('polling: a returning page (focus) refreshes at once', async ({ page }) => {
  await page.clock.install();
  await openUnlocked(page, G(2));
  const before = (await calls(page, 'door_event')).length;
  await srv(page, 'checkIn', 'e1', 'WD-G2');
  await fake(page, () => { window.dispatchEvent(new Event('focus')); });
  await expect.poll(async () => (await calls(page, 'door_event')).length).toBeGreaterThan(before);
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 1 من 2');
});

test('polling: a failed counter poll is silent (no banner, scanner stays open) and the next good one carries on', async ({ page }) => {
  await page.clock.install();
  await openUnlocked(page, G(2));
  await fake(page, () => { window.__fakeSupabase.fail = { door_event: { error: 'network', times: 1 } }; });
  await page.clock.fastForward(4500);
  await expect.poll(() => fake(page, () => window.__fakeSupabase.fail.door_event.times)).toBe(0);
  await expect(page.locator('#connection-banner')).toBeHidden();
  await expect(page.locator('#scanner-view')).toBeVisible();
  await srv(page, 'checkIn', 'e1', 'WD-G1');
  await page.clock.fastForward(9000);
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 1 من 2');
});

test('polling: a failed names poll keeps the list and says "تعذّر التحديث" without the connection banner', async ({ page }) => {
  await page.clock.install();
  await openUnlocked(page, G(3));
  await page.locator('#offline-list-btn').click();
  await srv(page, 'addGuest', 'e1', { id: 'WD-NEW', name: 'جديد' });
  await fake(page, () => { window.__fakeSupabase.fail = { door_guests: { error: 'network', times: 1 } }; });
  await page.clock.fastForward(4500);
  await page.clock.fastForward(10500);
  await expect(page.locator('#offline-list-meta')).toContainText('تعذّر التحديث');
  await expect(page.locator('#connection-banner')).toBeHidden();
  await expect(page.locator('#offline-list-results')).toContainText('ضيف1');
});

// ---- paging above 1000 names ----

test('paging: 2500 names arrive in three pages with no gaps and no duplicates, and the counter total is exact', async ({ page }) => {
  const many = Array.from({ length: 2500 }, (_, i) => ({ id: 'WD-P' + String(i).padStart(4, '0'), name: 'اسم ' + (i % 700) }));
  await openUnlocked(page, many);
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 0 من 2500');
  const gs = await calls(page, 'door_guests');
  expect(gs.length).toBe(3);
  expect(gs[0].args).toEqual({ p_event_id: 'e1', p_since: null, p_after_name: null, p_after_id: null, p_limit: 1000 });
  expect(gs[1].args.p_after_id).toBeTruthy();
  expect(gs[2].args.p_after_id).not.toBe(gs[1].args.p_after_id);
  const ids = await page.evaluate(() => guests.map((g) => g.id));
  expect(new Set(ids).size).toBe(2500);
});

test('paging: exactly 1000 names need a second (empty) request', async ({ page }) => {
  await openUnlocked(page, G(1000));
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 0 من 1000');
  expect((await calls(page, 'door_guests')).length).toBe(2);
});

test('paging: 999 names need one request', async ({ page }) => {
  await openUnlocked(page, G(999));
  await expect(page.locator('#scan-counter')).toHaveText('تم الدخول: 0 من 999');
  expect((await calls(page, 'door_guests')).length).toBe(1);
});

test('paging: Data.scan.guests pages a changed-names answer too and sets the cursor a minute before the newest change', async ({ page }) => {
  const many = Array.from({ length: 1500 }, (_, i) => ({ id: 'WD-D' + String(i).padStart(4, '0'), name: 'n' + i, changed_at: '2026-03-01T10:00:' + String(Math.floor(i / 100)).padStart(2, '0') + '.000000+00:00' }));
  await openUnlocked(page, many);
  const out = await page.evaluate(() => Data.scan.guests('e1', '2026-03-01T09:00:00.000Z').then((r) => ({ n: r.rows.length, u: new Set(r.rows.map((x) => x.id)).size, cursor: r.cursor, full: r.full })));
  expect(out).toEqual({ n: 1500, u: 1500, cursor: '2026-03-01T09:59:14.000Z', full: false });
});

test('paging: rows that share one changed_at are not lost between pages', async ({ page }) => {
  const same = Array.from({ length: 1200 }, (_, i) => ({ id: 'WD-S' + String(i).padStart(4, '0'), name: 'n' + i, changed_at: '2026-03-01T10:00:00.000000+00:00' }));
  await openUnlocked(page, same);
  const out = await page.evaluate(() => Data.scan.guests('e1', '2026-03-01T09:00:00.000Z').then((r) => new Set(r.rows.map((x) => x.id)).size));
  expect(out).toBe(1200);
});

test('the fake server caps a door_guests page at 1000 even when asked for more', async ({ page }) => {
  await openUnlocked(page, G(1500));
  const n = await page.evaluate(() => window.supabase.createClient('x', 'y').rpc('door_guests', { p_event_id: 'e1', p_limit: 5000 }).then((r) => r.data.length));
  expect(n).toBe(1000);
});

// ---- duplicate overlay: when the guest entered ----

test('duplicate overlay: relative times and plurals', async ({ page }) => {
  await openUnlocked(page, []);
  const out = await page.evaluate(() => {
    const ago = (s) => sinceText(new Date(Date.now() - s * 1000).toISOString());
    return [0, 2, 10, 11, 59, 60, 120, 180, 600, 660, 3000].map(ago);
  });
  expect(out).toEqual([
    'دخل قبل لحظات', 'دخل قبل لحظات', 'دخل قبل 10 ثوانٍ', 'دخل قبل 11 ثانية', 'دخل قبل 59 ثانية',
    'دخل قبل دقيقة', 'دخل قبل دقيقتين', 'دخل قبل 3 دقائق', 'دخل قبل 10 دقائق', 'دخل قبل 11 دقيقة', 'دخل قبل 50 دقيقة',
  ]);
});

test('duplicate overlay: an hour or more shows a 12-hour clock with ص/م and Western digits', async ({ page }) => {
  await openUnlocked(page, []);
  const out = await page.evaluate(() => {
    const at = (h, m) => { const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(h, m, 0, 0); return sinceText(d.toISOString()); };
    return [at(0, 5), at(12, 30), at(17, 32), at(9, 7)];
  });
  expect(out).toEqual(['دخل الساعة 12:05 ص', 'دخل الساعة 12:30 م', 'دخل الساعة 5:32 م', 'دخل الساعة 9:07 ص']);
  for (const s of out) expect(s).not.toMatch(/[٠-٩]/);
});

test('duplicate overlay: shows the line for a duplicate, hidden when scannedAt is missing or for allowed', async ({ page }) => {
  await openUnlocked(page, []);
  const since = page.locator('#result-since');
  await page.evaluate(() => showResult('duplicate', 'x', false, undefined, new Date(Date.now() - 5000).toISOString()));
  await expect(since).toBeVisible();
  await expect(since).toHaveText('دخل قبل 5 ثوانٍ');
  await page.evaluate(() => showResult('duplicate', 'x', false));
  await expect(since).toBeHidden();
  await page.evaluate(() => showResult('allowed', 'x', false));
  await expect(since).toBeHidden();
});

test('duplicate overlay: a real repeat scan shows when the guest entered', async ({ page }) => {
  await openUnlocked(page, [{ id: 'WD-G1', name: 'سارة', scanned: false }]);
  await page.evaluate(() => handleScan('WD-G1'));
  await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
  await page.evaluate(() => hideResult(true));
  await page.evaluate(() => { lastScanned = null; return handleScan('WD-G1'); });
  await expect(page.locator('#result-overlay.rs-duplicate')).toBeVisible();
  await expect(page.locator('#result-since')).toHaveText('دخل قبل لحظات');
});

test('code screen: the error line wraps evenly (text-wrap: balance)', async ({ page }) => {
  await open(page, { user: DEVICE, session: false, guests: [] });
  const tw = await page.evaluate(() => getComputedStyle(document.getElementById('pin-err')).textWrap);
  expect(tw).toBe('balance');
});

// ---- both barcode formats: old Firebase-era 'WD-' + 13 base36, new 'WD-' + 12 hex ----
const OLD_ID = 'WD-K3J9ZQ0X8M2PA';
const NEW_ID = 'WD-9F3A0C7D1E5B';
const FORMATS = [{ id: OLD_ID, name: 'ضيف قديم' }, { id: NEW_ID, name: 'ضيف جديد' }];

for (const [label, id, name] of [['old (13 base36)', OLD_ID, 'ضيف قديم'], ['new (12 hex)', NEW_ID, 'ضيف جديد']]) {
  test(`${label} barcode: typed by hand, in lower case, checks the guest in; a second try is a duplicate`, async ({ page }) => {
    await openUnlocked(page, FORMATS);
    await page.locator('#manual-code').fill(id.toLowerCase());
    await page.getByRole('button', { name: 'تحقق ✓' }).click();
    await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
    await expect(page.locator('#result-name')).toHaveText(name);
    expect((await calls(page, 'check_in')).map((c) => c.args.p_guest_id)).toEqual([id]);
    await page.waitForTimeout(700);
    await page.locator('#result-overlay').click();
    await page.waitForTimeout(700);
    await page.locator('#manual-code').fill(id);
    await page.getByRole('button', { name: 'تحقق ✓' }).click();
    await expect(page.locator('#result-overlay.rs-duplicate')).toBeVisible();
  });

  test(`${label} barcode: the text the camera decodes (also in lower case, or inside a longer text) checks in`, async ({ page }) => {
    await openUnlocked(page, FORMATS);
    await page.evaluate((v) => handleScan(v), 'invite:' + id.toLowerCase() + '\n');
    await expect(page.locator('#result-overlay.rs-allowed')).toBeVisible();
    await expect(page.locator('#result-name')).toHaveText(name);
    expect(await serverScanned(page)).toBe(1);
  });
}

test('both barcode formats show their first 4 characters after WD- as the tag in the names list', async ({ page }) => {
  await openUnlocked(page, FORMATS);
  await page.getByRole('button', { name: /عرض الأسماء/ }).click();
  await expect(page.locator('#offline-list-results .ol-row')).toHaveCount(2);
  await expect(page.locator(`#offline-list-results .ol-row[data-id="${OLD_ID}"] .ol-tag`)).toHaveText('K3J9');
  await expect(page.locator(`#offline-list-results .ol-row[data-id="${NEW_ID}"] .ol-tag`)).toHaveText('9F3A');
});

test('a code that is not a barcode at all is still refused on manual entry', async ({ page }) => {
  await openUnlocked(page, FORMATS);
  await page.locator('#manual-code').fill('K3J9ZQ0X8M2PA');
  await page.getByRole('button', { name: 'تحقق ✓' }).click();
  await expect(page.locator('#camera-status')).toContainText('صيغة الكود غير صحيحة');
  expect((await calls(page, 'check_in')).length).toBe(0);
});
