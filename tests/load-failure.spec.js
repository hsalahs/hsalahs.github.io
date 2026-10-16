const { test, expect } = require('@playwright/test');
const { stubSupabase, seedScan, seedAppStore, seedEvent, seedFakeSupabase } = require('./helpers');

// A weak phone signal can drop one of the page's own script files. The page
// used to open half-working with no message (a dashboard with no invite link,
// a login button that did nothing); now a red bar offers a reload.
const PAGES = [
  ['app.html', 'utils.js'],
  ['event.html?id=e1', 'format.js'],
  ['invite.html?event=e1', 'utils.js'],
  ['scan.html?event=e1', 'icons.js'],
];

for (const [url, dropped] of PAGES) {
  test(`${url.split('?')[0]}: if ${dropped} fails to download, a reload bar appears and reloads the page`, async ({ page }) => {
    await stubSupabase(page);
    if (url.startsWith('scan.html')) await seedScan(page);
    else if (url.startsWith('app.html')) await seedAppStore(page, { user: { id: 'u1', email: 'customer@example.com' }, events: [] });
    else if (url.startsWith('event.html')) await seedEvent(page, { user: { id: 'u1', email: 'customer@example.com' } });
    else await seedFakeSupabase(page, {});
    let drop = true;
    await page.route('**/' + dropped, (route) => (drop ? route.abort() : route.continue()));
    await page.goto('/' + url);
    const bar = page.locator('#load-fail');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('اضغط هنا لإعادة التحميل');
    drop = false;
    await Promise.all([page.waitForEvent('load'), bar.click()]);
    await expect(page.locator('#load-fail')).toHaveCount(0);
  });
}

test('a page whose files all load shows no reload bar', async ({ page }) => {
  await stubSupabase(page);
  await seedAppStore(page, { user: { id: 'u1', email: 'customer@example.com' }, events: [] });
  await page.goto('/app.html');
  await expect(page.locator('#app-view')).toBeVisible();
  await expect(page.locator('#load-fail')).toHaveCount(0);
});
