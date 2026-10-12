const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { stubSupabase, seedScan } = require('./helpers');

const DEVICE = { id: 'anon-1', is_anonymous: true, email: null };

test.use({
  permissions: ['camera'],
  launchOptions: {
    ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
});

test('starting the camera loads the vendored qr-scanner worker; without it no code is ever read', async ({ page }) => {
  const errors = [];
  const workerStatuses = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => { if (/qr-scanner-worker\.min\.js/.test(r.url())) workerStatuses.push(r.status()); });
  await page.addInitScript(() => { delete window.BarcodeDetector; });
  await stubSupabase(page);
  await seedScan(page, { user: DEVICE, session: true });
  await page.goto('/scan.html?event=e1');
  await expect(page.locator('#scanner-view')).toBeVisible();
  await page.locator('#start-cam-btn').click();
  await expect(page.locator('#camera-status')).toHaveText('وجّه الكاميرا نحو الباركود');
  await expect.poll(() => workerStatuses.length, { timeout: 5000 }).toBeGreaterThan(0);
  expect(workerStatuses.every((s) => s === 200)).toBe(true);
  expect(errors.filter((m) => /dynamically imported/.test(m))).toEqual([]);
});

test('every file the vendored qr-scanner imports sits in vendor/ and is precached by sw.js', () => {
  const umd = fs.readFileSync(path.join(__dirname, '..', 'vendor', 'qr-scanner.umd.min.js'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  const needed = [...new Set([...umd.matchAll(/qr-scanner-worker\.min\.js/g)].map((m) => m[0]))];
  expect(needed.length).toBeGreaterThan(0);
  for (const f of needed) {
    expect(fs.existsSync(path.join(__dirname, '..', 'vendor', f))).toBe(true);
    expect(sw).toContain("'vendor/" + f + "'");
  }
});
