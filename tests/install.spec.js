const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { stubFirebase, seedFakeFirebase } = require('./helpers');

// "Add to Home Screen" saves whatever start address the page's web app
// manifest names — or, with no manifest, the page's own address. Each page
// should install as itself: the landing page you show prospective customers
// as the landing page, the organizer panel as the panel, the scanner as the
// scanner.

test('the landing page installs as itself: no manifest, and the home-screen name and icon are set', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(0);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes');
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', 'دعوات');
});

test('the organizer panel still installs as the panel: its manifest starts at app.html', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: null });
  await page.goto('/app.html');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', 'manifest.webmanifest');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.webmanifest'), 'utf8'));
  expect(manifest.start_url).toBe('app.html');
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.length).toBeGreaterThan(0);
});

test('the invite page and the guide have no manifest either, so they install as themselves', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: {} } });
  await page.goto('/invite.html?event=nothing');
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(0);
  await page.goto('/guide.html');
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(0);
});
