const { test, expect } = require('@playwright/test');
const { stubSupabase, seedInviteStore } = require('./helpers');

const KINDS = ['wedding', 'graduation', 'event'];

for (const type of KINDS) {
  test(`invite page layout shift stays under 0.1 while the ${type} event loads late`, async ({ page }) => {
    await stubSupabase(page);
    await seedInviteStore(page, {
      store: { events: { e1: { name: 'حفل تجريبي طويل الاسم قليلًا', date: '2030-01-01', venue: 'قاعة الأفراح - الرياض', mapsLink: 'https://maps.google.com/?q=1', theme: 'gold', type } } },
      latency: 800,
    });
    await page.addInitScript(() => {
      window.__cls = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.goto('/invite.html?event=e1');
    await expect(page.locator('#g-name')).toBeVisible();
    await page.waitForTimeout(2500);
    await page.evaluate(() => document.fonts.ready);
    const cls = await page.evaluate(() => window.__cls);
    console.log('CLS ' + type + ' = ' + cls.toFixed(4));
    expect(cls).toBeLessThan(0.1);
  });
}
