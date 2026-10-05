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
  expect(image).toMatch(/^https:\/\/da3wt\.com\/icons\/og-image\.jpg$/);
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
  // The hero note says what's free and what comes after; the "no fees" wording lives in the price section, the link preview and the sign-up note.
  await expect(page.locator('.trial-note')).toHaveText('أول 5 ضيوف مجانًا — وأكثر من كذا نرسل لك عرض سعر، ونفعّل مناسبتك بعد الدفع');
  // Next to the start button, the way to buy is spelled out: a quote request,
  // not just a general "talk to us".
  const quote = page.locator('.hero a[data-wa="quote"]');
  await expect(quote).toContainText('اطلب سعر مناسبتك');
  expect(decodeURIComponent((await quote.getAttribute('href')).split('text=')[1])).toBe('السلام عليكم، أبغى عرض سعر من دعوات لمناسبتي. عدد الضيوف تقريبًا: ');
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

// "ليش دعوات؟" — six cards; one column on phones, a 3x2 grid on large screens.
const FEATURES = [
  ['zap', 'خدمة ذاتية وفورية'],
  ['smartphone', 'بدون تطبيقات أو تحميل'],
  ['gift', 'تجربة مجانية بالكامل'],
  ['ticket', 'بطاقة مصممة لكل ضيف'],
  ['chart-column', 'تحديث وإحصائيات لحظية'],
  ['lock', 'بياناتك خاصة وآمنة'],
];

test('"why Dawaat" has the six cards, each with its own line icon and title, in order', async ({ page }) => {
  await page.goto('/index.html');
  const cards = page.locator('.features .feature');
  await expect(cards).toHaveCount(6);
  for (let i = 0; i < FEATURES.length; i++) {
    const svg = await cards.nth(i).locator('.f-icon svg').innerHTML();
    expect(svg).toBe(await page.evaluate((n) => { const d = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); d.innerHTML = ICON_PATHS[n]; return d.innerHTML; }, FEATURES[i][0]));
    await expect(cards.nth(i).locator('h4')).toHaveText(FEATURES[i][1]);
    expect((await cards.nth(i).locator('p').innerText()).length).toBeGreaterThan(30);
  }
  // No two cards share an icon.
  expect(new Set(FEATURES.map(f => f[0])).size).toBe(6);
});

test('the cards say only what the product does: no invented attendance percentage, and the privacy claim names who else can see the list', async ({ page }) => {
  await page.goto('/index.html');
  const text = await page.locator('.features').innerText();
  // The dashboard shows counts (came / not yet), not a percentage.
  expect(text).not.toContain('نسبة');
  // Door staff holding the code can open the list, so it is not "only you".
  expect(text).toContain('إلا أنت ومن تعطيه رمز الباب');
  expect(text).not.toContain('غيرك');
  expect(text).toContain('حتى 5 ضيوف مجانًا');
});

test('on a phone the cards stack in a single column and the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/index.html');
  const lefts = await page.locator('.features .feature').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().left)));
  expect(new Set(lefts).size).toBe(1);
  const cols = await page.locator('.features').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  expect(cols).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('on a large screen the cards form a 3x2 grid, centred, inside the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/index.html');
  const boxes = await page.locator('.features .feature').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top) }; }));
  expect(new Set(boxes.map(b => b.t)).size).toBe(2);           // two rows
  expect(new Set(boxes.map(b => b.l)).size).toBe(3);           // three columns
  const left = Math.min(...boxes.map(b => b.l));
  const right = Math.max(...boxes.map(b => b.r));
  expect(left).toBeGreaterThanOrEqual(0);
  expect(right).toBeLessThanOrEqual(1280);
  expect(Math.abs(left - (1280 - right))).toBeLessThanOrEqual(2);  // centred
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('in the in-between tablet width the cards stay in one readable column', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto('/index.html');
  const lefts = await page.locator('.features .feature').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().left)));
  expect(new Set(lefts).size).toBe(1);
});

// The link preview image: what WhatsApp and friends fetch. It has to be the
// size the og:image tags promise and light enough that WhatsApp does not skip it.
test('the link-preview image is 1200x630 and small enough for WhatsApp', () => {
  const buf = require('fs').readFileSync(repoFile('icons/og-image.jpg'));
  expect(buf.length).toBeLessThan(300 * 1024);
  // Read the size from the JPEG's start-of-frame marker.
  let i = 2, w = 0, h = 0;
  while (i < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) { h = buf.readUInt16BE(i + 5); w = buf.readUInt16BE(i + 7); break; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  expect([w, h]).toEqual([1200, 630]);
});

// Tools that read the page as plain text (search engines, link previews,
// audits) keep <script> contents but drop HTML comments — a code comment at
// the top of <body> became the first words they saw.
test('read as plain text, the page starts with the product, with no code or code comments before it', async () => {
  const fs = require('fs'); const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const body = src.slice(src.indexOf('<body')).replace(/<!--[\s\S]*?-->/g, '');
  const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  expect(text.indexOf('دعوة أنيقة لكل ضيف')).toBeGreaterThan(-1);
  expect(text.slice(0, text.indexOf('دعوة أنيقة لكل ضيف'))).not.toMatch(/[{}();=]|\/\//);
  for (const m of body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) expect(m[1]).not.toMatch(/^\s*\/\//m);
});

// Some audits read the raw source, HTML comments included, so the landing page
// carries no developer notes at all (HTML, CSS or script comments).
test('the landing page source carries no developer comments', async () => {
  const fs = require('fs'); const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  expect(src).not.toMatch(/<!--/);
  expect(src).not.toMatch(/\/\*/);
  for (const m of src.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) expect(m[1]).not.toMatch(/(^|[\s;{}])\/\/ /m);
});

// Pricing is agreed per customer (and per country) on WhatsApp, so the page
// must say so plainly and show the steps — not call an unshown price "clear".
test('the pricing section says the price depends on the guest count and lists the three steps', async ({ page }) => {
  await page.goto('/index.html');
  const card = page.locator('.price-card');
  await expect(page.locator('.section-sub', { hasText: 'السعر حسب عدد ضيوفك' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('بسيط وواضح');
  await expect(card.locator('p b')).toHaveText(['أول 5 ضيوف مجانًا لكل مناسبة', '1. جرّب مجانًا:', '2. اطلب عرضك:', '3. ادفع ونفعّل:']);
  await expect(card.locator('a[data-wa="pricing"]')).toContainText('اسأل عن الأسعار على واتساب');
});

// A WhatsApp button pinned to the corner follows the visitor as they scroll,
// on the landing page and the guide only (not the organizer's or guests' pages).
for (const [file, msg] of [['index.html', 'السلام عليكم، عندي سؤال عن خدمة دعوات.'], ['guide.html', 'السلام عليكم، عندي سؤال عن استخدام دعوات.']]) {
  test(`${file}: a floating WhatsApp button stays visible from top to bottom`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 760 });
    await page.goto('/' + file);
    const btn = page.locator('a.wa-float');
    await expect(btn).toHaveAttribute('aria-label', 'تواصل معنا على واتساب');
    expect(decodeURIComponent((await btn.getAttribute('href')).split('text=')[1])).toBe(msg);
    await expect(btn).toBeInViewport();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(btn).toBeInViewport();
    const box = await btn.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.x).toBeGreaterThan(390 / 2);   // the right-hand corner
  });
}

test('the splash leaves the page after it hides, so its endless animations stop', async ({ page }) => {
  await stubFirebase(page);
  await page.goto('/index.html');
  await expect(page.locator('#splash')).toHaveCount(1);
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 6000 });
});
