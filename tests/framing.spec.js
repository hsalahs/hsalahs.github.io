const { test, expect } = require('@playwright/test');
const { stubFirebase, seedFakeFirebase } = require('./helpers');

// GitHub Pages can't send X-Frame-Options / frame-ancestors, so the pages
// with buttons that change data refuse to run inside someone else's frame.
for (const path of ['/app.html', '/event.html?id=e1', '/scan.html?event=e1']) {
  test('framed inside another page, ' + path + ' hides itself and takes over the whole window', async ({ page }) => {
    await stubFirebase(page);
    await seedFakeFirebase(page, { user: null, store: { events: {} } });
    await page.route('**/framer-test.html', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>framer</title><iframe src="' + path + '" style="width:400px;height:400px"></iframe>' }));
    await page.goto('/framer-test.html');
    // The framed page breaks out: the top window ends up on the real page.
    await page.waitForURL((u) => u.pathname === path.split('?')[0], { timeout: 10000 });
    expect(await page.evaluate(() => window.top === window.self)).toBe(true);
  });
}

test('opened normally, the pages are not affected', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: null });
  await page.goto('/app.html');
  await expect(page.locator('#auth-view')).toBeVisible();
});

test('robots.txt points to the sitemap, and the sitemap lists only the public pages', async ({ request }) => {
  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toContain('Sitemap: https://da3wt.com/sitemap.xml');
  for (const p of ['/app.html', '/event.html', '/scan.html', '/invite.html']) expect(robots).toContain('Disallow: ' + p);
  const sitemap = await (await request.get('/sitemap.xml')).text();
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  expect(locs).toEqual(['https://da3wt.com/', 'https://da3wt.com/guide.html']);
});
