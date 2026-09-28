const { test, expect } = require('@playwright/test');
const { stubFirebase, seedFakeFirebase } = require('./helpers');

const EVENT = {
  name: 'حفل تجريبي', ownerUid: 'u1', date: '2026-01-01', venue: 'الرياض',
  scanPin: '1234', theme: 'gold', createdAt: { seconds: 1 },
};

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

test('re-scanning an already-checked-in guest shows a clear red "already used" alert, not a soft warning', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    store: {
      events: { e1: EVENT },
      'events/e1/guests': { g1: { name: 'ضيف مكرر', id: 'WD-DUP123', scanned: true } },
    },
  });
  await page.addInitScript(() => localStorage.setItem('scan_unlocked_e1', '1'));
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();

  await page.locator('#manual-code').fill('WD-DUP123');
  await page.getByRole('button', { name: 'تحقق ✓' }).click();

  const dupCard = page.locator('#result-duplicate');
  await expect(dupCard).toBeVisible();
  await expect(dupCard).toContainText('تم استخدام هذه الدعوة مسبقًا');
  await expect(dupCard.locator('.result-status.dup')).toHaveCSS('color', 'rgb(244, 67, 54)');
});

test('"مسح جديد" tears the camera down and returns to the start-camera screen, instead of trusting it\'s still healthy', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EVENT }, 'events/e1/guests': {} } });
  await page.addInitScript(() => localStorage.setItem('scan_unlocked_e1', '1'));
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
    store: {
      events: { e1: EVENT },
      'events/e1/guests': {
        g1: { name: 'أحمد العتيبي', id: 'WD-1', scanned: true },
        g2: { name: 'سارة القحطاني', id: 'WD-2', scanned: false },
      },
    },
  });
  await page.addInitScript(() => localStorage.setItem('scan_unlocked_e1', '1'));
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
