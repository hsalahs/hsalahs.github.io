const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { stubFirebase, seedFakeFirebase } = require('./helpers');

const WHATSAPP = '966546664459';
const repoFile = (f) => path.join(__dirname, '..', f);

test('sharing the link shows a proper card: title, description and a real image with an absolute address', async ({ page }) => {
  await page.goto('/index.html');
  const meta = (sel) => page.locator(sel).getAttribute('content');
  expect(await meta('meta[name="description"]')).toContain('دعوة');
  expect(await meta('meta[property="og:title"]')).toContain('دعوات');
  expect(await meta('meta[property="og:description"]')).toBeTruthy();
  expect(await meta('meta[name="twitter:card"]')).toBe('summary_large_image');
  expect(await meta('meta[property="og:image:width"]')).toBe('1200');
  expect(await meta('meta[property="og:image:height"]')).toBe('630');

  // WhatsApp and friends fetch the image from the public address, so it must
  // be absolute, and the file it points at must actually be in the repo.
  const image = await meta('meta[property="og:image"]');
  expect(image).toMatch(/^https:\/\/hsalahs\.github\.io\/icons\/og-image\.jpg$/);
  expect(await meta('meta[name="twitter:image"]')).toBe(image);
  const file = repoFile(new URL(image).pathname.slice(1));
  expect(fs.existsSync(file)).toBe(true);
  // WhatsApp skips preview images that are too heavy.
  expect(fs.statSync(file).size).toBeLessThan(300 * 1024);
});

test('every WhatsApp link points at the business number and carries a ready-made message', async ({ page }) => {
  await page.goto('/index.html');
  const hrefs = await page.locator('a[href^="https://wa.me/"]').evaluateAll(as => as.map(a => a.href));
  expect(hrefs.length).toBeGreaterThanOrEqual(2); // the top of the page and the pricing section
  for (const h of hrefs) {
    const u = new URL(h);
    expect(u.pathname).toBe('/' + WHATSAPP);
    expect(u.searchParams.get('text')).toContain('دعوات');
  }
  // Different questions get different messages, so the conversation starts
  // with the right context.
  expect(new Set(hrefs).size).toBe(hrefs.length);
});

test('the sample card never shows a date that has already passed', async ({ page }) => {
  await page.goto('/index.html');
  const iso = await page.locator('#cp-date').getAttribute('data-iso');
  expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(iso > new Date().toISOString().slice(0, 10)).toBe(true);
});

test('the page says what it costs without inventing prices, and offers a live sample', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.getByText('كم السعر؟')).toBeVisible();
  await expect(page.getByText('أول 5 ضيوف مجانًا لكل مناسبة')).toBeVisible();
  await expect(page.locator('a[href="invite.html?demo=1"]')).toBeVisible();
  // No currency amounts anywhere: the price is the owner's to state.
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/\d\s*(ريال|ر\.س|SAR|﷼)/);
});

// "بطاقة" is also what this product calls an invitation card, so "بدون بطاقة"
// ("no card") can be read as "no invitation card". The reassurance means no
// payment details are needed, and says so plainly.
test('the free-tier reassurance says "no fees", never the ambiguous "no card", on every page and in the link preview', async ({ page }) => {
  const fs = require('fs'), path = require('path');
  for (const f of fs.readdirSync(path.join(__dirname, '..')).filter(n => n.endsWith('.html'))) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    expect(src, f + ' should not say "بدون بطاقة"').not.toContain('بدون بطاقة');
  }
  await page.goto('/index.html');
  await expect(page.locator('.trial-note')).toContainText('بدون دفع رسوم');
  await expect(page.locator('.price-card')).toContainText('بدون دفع رسوم');
  expect(await page.locator('meta[property="og:description"]').getAttribute('content')).toContain('بدون دفع رسوم');
  await page.goto('/guide.html');
  await expect(page.locator('#start .note')).toContainText('بدون دفع رسوم');
});

test('the landing page opens with the product splash, not a wedding one', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('#splash .splash-title')).toHaveText('دعوات');
  await expect(page.locator('#splash .splash-subtitle')).toHaveText('Digital Invitations');
  await expect(page.locator('#splash .splash-rings img')).toHaveAttribute('src', 'icons/logo.svg');
  await expect(page.locator('nav .logo img')).toHaveAttribute('src', 'icons/logo.svg');
});

test('the sample card starts as a wedding, then shows a graduation and an event, and comes back around', async ({ page }) => {
  await page.clock.install();
  await page.goto('/index.html');
  const title = page.locator('.cp-title');
  await expect(title).toHaveText('دعوة زفاف');
  await page.clock.runFor(3000);
  await expect(title).toHaveText('دعوة حفل تخرج');
  await page.clock.runFor(3000);
  await expect(title).toHaveText('دعوة فعالية');
  await page.clock.runFor(3000);
  await expect(title).toHaveText('دعوة زفاف');
});

test('for a visitor who asked their device for reduced motion, the sample card keeps its first title', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.goto('/index.html');
  await page.clock.runFor(15000);
  await expect(page.locator('.cp-title')).toHaveText('دعوة زفاف');
});

test('the sample card date reads as words with Western digits', async ({ page }) => {
  await page.goto('/index.html');
  const text = await page.locator('#cp-date').textContent();
  expect(text).toMatch(/^(الأحد|الاثنين|الثلاثاء|الأربعاء|الخميس|الجمعة|السبت) \d{1,2} \S+ \d{4}$/);
  expect(text).not.toMatch(/[\u0660-\u0669]/);
});

test('the steps are numbered 1, 2, 3 in Western digits', async ({ page }) => {
  await page.goto('/index.html');
  expect(await page.locator('.step-num').allTextContents()).toEqual(['1', '2', '3']);
});
