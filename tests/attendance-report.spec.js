const { test, expect } = require('@playwright/test');
const { stubFirebase, seedFakeFirebase } = require('./helpers');

const EVENT = { name: 'حفل زفاف أحمد & سارة', ownerUid: 'u1', date: '2026-10-29', venue: 'قاعة الأفراح — الرياض', theme: 'gold', createdAt: { seconds: 1 } };

function store(list) {
  const g = {};
  list.forEach((x, i) => { g['g' + i] = { id: 'WD-' + String(i + 1).padStart(4, '0'), name: x.name, scanned: !!x.scanned, scannedAt: x.scanned ? (x.at || '2026-10-29T19:45:00.000Z') : null, registeredAt: '2026-10-01T08:00:00.000Z' }; });
  return { events: { e1: { ...EVENT, paid: true, guestCount: list.length } }, 'events/e1/guests': g, 'events/e1/requests': {} };
}

async function open(page, list) {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: store(list) });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  if (list.length) await expect(page.locator('.guest-item')).toHaveCount(list.length);
}

async function openReport(page) {
  const [report] = await Promise.all([
    page.context().waitForEvent('page'),
    (async () => { await page.getByRole('button', { name: 'القائمة' }).click(); await page.getByRole('button', { name: 'كشف الحضور (طباعة / PDF)' }).click(); })(),
  ]);
  await report.waitForLoadState('domcontentloaded');
  return report;
}

const LIST = [
  { name: 'أحمد بن سعد القحطاني', scanned: true },
  { name: 'John Smith', scanned: true },
  { name: 'Ahmed أحمد', scanned: false },
  { name: 'سارة Sarah', scanned: true },
  { name: 'نورة', scanned: false },
];

test('the menu opens a report in a new tab with the event, the summary and every guest', async ({ page }) => {
  await open(page, LIST);
  const report = await openReport(page);
  expect(report.url()).toMatch(/^blob:/);
  await expect(report).toHaveTitle('كشف الحضور — حفل زفاف أحمد & سارة');
  await expect(report.locator('h1')).toHaveText('كشف الحضور');
  await expect(report.locator('.ev')).toHaveText('حفل زفاف أحمد & سارة');
  await expect(report.locator('.meta')).toHaveText('الخميس 29 أكتوبر 2026 · قاعة الأفراح — الرياض');
  const tiles = await report.locator('.tile').evaluateAll(t => t.map(x => x.textContent));
  expect(tiles).toEqual(['5إجمالي الضيوف', '3حضروا', '2لم يحضروا', '60%نسبة الحضور']);
  await expect(report.locator('tbody tr')).toHaveCount(5);
  const names = await report.locator('td.name').allInnerTexts();
  expect(names.sort()).toEqual(LIST.map(g => g.name).sort());
  // Attended rows say so and carry an entry time; the others do not.
  const rows = await report.locator('tbody tr').evaluateAll(trs => trs.map(tr => [...tr.children].map(td => td.textContent)));
  for (const r of rows) {
    if (r[3] === 'حضر') expect(r[4]).toMatch(/^2026-10-29 \d{2}:\d{2}$/);
    else { expect(r[3]).toBe('لم يحضر'); expect(r[4]).toBe(''); }
  }
  expect(rows.map(r => r[0])).toEqual(['1', '2', '3', '4', '5']);
  expect(rows.every(r => /^WD-\d{4}$/.test(r[2]))).toBe(true);
  await expect(report.locator('.scope')).toHaveText('القائمة: كل الضيوف — 5 من 5');
});

test('Arabic-only, English-only and mixed names are all shown intact, each cell isolated so neighbours do not reorder', async ({ page }) => {
  await open(page, LIST);
  const report = await openReport(page);
  const cells = await report.locator('td.name bdi').count();
  expect(cells).toBe(LIST.length);
  await expect(report.locator('td.code bdi').first()).toHaveAttribute('dir', 'ltr');
  await expect(report.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(report.locator('html')).toHaveAttribute('lang', 'ar');
});

test('a guest cannot run code in the report by choosing a clever name: everything is escaped and the policy blocks stray scripts', async ({ page }) => {
  const evil = [
    { name: '</script><script>window.__pwned=1</script>' },
    { name: '<img src=x onerror="window.__pwned=1">' },
    { name: '"><svg onload="window.__pwned=1">' },
    { name: "'; window.__pwned=1; //" },
    { name: '<b>bold</b> & "quotes" \'single\'', scanned: true },
  ];
  await open(page, evil);
  const report = await openReport(page);
  await report.waitForTimeout(500);
  expect(await report.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await report.locator('tbody img, tbody svg, tbody b, tbody script').count()).toBe(0);
  const names = await report.locator('td.name').allInnerTexts();
  expect(names.sort()).toEqual(evil.map(g => g.name).sort());
  // Exactly one script — the print button's — and a policy that only admits it.
  expect(await report.locator('script').count()).toBe(1);
  const csp = await report.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("default-src 'none'");
  expect(csp).toMatch(/script-src 'nonce-[0-9a-f]{32}'/);
  expect(csp).not.toContain('unsafe-eval');
  expect(await report.locator('script').getAttribute('nonce')).toBe(csp.match(/'nonce-([0-9a-f]{32})'/)[1]);
});

test('every report gets a fresh nonce', async ({ page }) => {
  await open(page, LIST);
  const nonces = [];
  for (let i = 0; i < 2; i++) {
    const report = await openReport(page);
    nonces.push(await report.locator('script').getAttribute('nonce'));
    await report.close();
  }
  expect(nonces[0]).not.toBe(nonces[1]);
});

test('the report follows the dashboard view: the attendance filter and search change the rows, never the summary', async ({ page }) => {
  await open(page, LIST);
  await page.locator('#box-attended').click();
  let report = await openReport(page);
  expect((await report.locator('td.name').allInnerTexts()).sort()).toEqual(['John Smith', 'سارة Sarah', 'أحمد بن سعد القحطاني'].sort());
  await expect(report.locator('.scope')).toHaveText('القائمة: الحاضرون فقط — 3 من 5');
  expect(await report.locator('.tile b').allInnerTexts()).toEqual(['5', '3', '2', '60%']);
  await report.close();

  await page.locator('#box-all').click();
  await page.locator('#guest-search').fill('john');
  report = await openReport(page);
  expect(await report.locator('td.name').allInnerTexts()).toEqual(['John Smith']);
  await expect(report.locator('.scope')).toHaveText('القائمة: كل الضيوف — بحث: «john» — 1 من 5');
});

test('a view with no matching names says so instead of printing an empty table', async ({ page }) => {
  await open(page, LIST);
  await page.locator('#guest-search').fill('zzzz-no-match');
  const report = await openReport(page);
  await expect(report.locator('td.empty')).toHaveText('لا توجد أسماء ضمن هذا العرض');
  await expect(report.locator('.tile b').first()).toHaveText('5');
});

test('with no guests at all there is nothing to report: a toast, and no new tab', async ({ page }) => {
  await open(page, []);
  let opened = false;
  page.context().on('page', () => { opened = true; });
  await page.getByRole('button', { name: 'القائمة' }).click();
  await page.getByRole('button', { name: 'كشف الحضور (طباعة / PDF)' }).click();
  await expect(page.locator('#toast')).toContainText('لا يوجد ضيوف بعد');
  await page.waitForTimeout(400);
  expect(opened).toBe(false);
});

test('an event with no attendance yet reports 0%, not NaN', async ({ page }) => {
  await open(page, [{ name: 'A' }, { name: 'B' }]);
  const report = await openReport(page);
  expect(await report.locator('.tile b').allInnerTexts()).toEqual(['2', '0', '2', '0%']);
});

test('the print button calls the browser print dialog', async ({ page }) => {
  await open(page, LIST);
  const report = await openReport(page);
  await report.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
  await report.locator('#print-btn').click();
  expect(await report.evaluate(() => window.__printed)).toBe(1);
});

test('on paper: the toolbar disappears, the sheet loses its screen frame, the header repeats on every page and rows do not split', async ({ page }) => {
  await open(page, LIST);
  const report = await openReport(page);
  await expect(report.locator('.bar')).toBeVisible();
  await report.emulateMedia({ media: 'print' });
  await expect(report.locator('.bar')).toBeHidden();
  const sheet = await report.locator('.sheet').evaluate(el => { const s = getComputedStyle(el); return { shadow: s.boxShadow, bg: getComputedStyle(document.body).backgroundColor }; });
  expect(sheet.shadow).toBe('none');
  expect(sheet.bg).toBe('rgb(255, 255, 255)');
  expect(await report.locator('thead').evaluate(el => getComputedStyle(el).display)).toBe('table-header-group');
  expect(await report.locator('tbody tr').first().evaluate(el => getComputedStyle(el).breakInside)).toBe('avoid');
});

test('a real PDF of a long list: several A4 pages, and nothing is lost between them', async ({ page }) => {
  const many = Array.from({ length: 220 }, (_, i) => ({ name: (i % 3 === 0 ? 'ضيف رقم ' : i % 3 === 1 ? 'Guest number ' : 'ضيف Guest ') + (i + 1), scanned: i % 2 === 0 }));
  await open(page, many);
  const report = await openReport(page);
  await expect(report.locator('tbody tr')).toHaveCount(220);
  const pdf = await report.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
  expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  expect(pages).toBeGreaterThanOrEqual(4);
  expect(pages).toBeLessThanOrEqual(12);
});

test('on a phone the report fits the screen: no sideways scroll, even with a very long name', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await open(page, [...LIST, { name: 'عبدالرحمن'.repeat(11), scanned: true }, { name: 'AVeryLongEnglishNameWithoutAnySpacesAtAll'.repeat(2) }]);
  const report = await openReport(page);
  await report.setViewportSize({ width: 390, height: 800 });
  expect(await report.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const grid = await report.locator('.tiles').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  expect(grid).toBe(2);
});

test('the report uses Western digits only, and the logo comes from the site', async ({ page }) => {
  await open(page, LIST);
  const report = await openReport(page);
  const text = await report.locator('body').innerText();
  expect(text).not.toMatch(/[٠-٩۰-۹]/);
  const logo = report.locator('img.logo');
  await expect(logo).toHaveAttribute('src', /\/icons\/logo\.svg$/);
  await expect.poll(() => logo.evaluate(i => i.complete && i.naturalWidth > 0)).toBe(true);
});
