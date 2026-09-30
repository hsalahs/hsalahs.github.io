const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { stubFirebase, seedFakeFirebase } = require('./helpers');

// Real .xlsx files (tests/fixtures), written by openpyxl and xlsxwriter — the
// second in both its normal and its inline-string flavours — so the reader
// is checked against what Excel-style writers actually produce.
const FX = (name) => path.join(__dirname, 'fixtures', name);
const JSZIP = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'jszip', 'dist', 'jszip.min.js'), 'utf8');

const EVENT = { name: 'حفل تجريبي', ownerUid: 'u1', date: '2026-01-01', venue: 'الرياض', theme: 'gold', createdAt: { seconds: 1 } };

async function open(page, eventExtra = {}, { withZip = true } = {}) {
  await stubFirebase(page);
  if (withZip) {
    // helpers.js blocks every third-party host; serve the library the page asks the CDN for.
    await page.route('https://cdnjs.cloudflare.com/ajax/libs/jszip/**', (r) => r.fulfill({ contentType: 'text/javascript', body: JSZIP }));
  }
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: { events: { e1: { ...EVENT, paid: true, guestCount: 0, ...eventExtra } }, 'events/e1/guests': {}, 'events/e1/requests': {} },
  });
  const messages = [];
  page.on('dialog', (d) => { messages.push(d.message()); d.accept(); });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  return messages;
}

async function importFile(page, name) {
  await page.locator('#csv-import').setInputFiles(FX(name));
}

const namesOnPage = (page) => page.evaluate(() => Object.values(window.__fakeFirebase.store['events/e1/guests']).map(g => g.name));
const guestCount = (page) => page.evaluate(() => window.__fakeFirebase.store.events.e1.guestCount);

test('a single column of names imports, skipping blank rows and tidying the spaces', async ({ page }) => {
  const messages = await open(page);
  await importFile(page, 'names-only.xlsx');
  await expect(page.locator('.guest-item')).toHaveCount(4);
  await expect.poll(async () => (await namesOnPage(page)).sort()).toEqual(['أحمد الغامدي', 'سارة العتيبي', 'محمد بن سعد القحطاني', 'نورة'].sort());
  expect(messages.join(' ')).toContain('تم استيراد 4 ضيف');
  expect(await guestCount(page)).toBe(4);
});

test('a header row is skipped and only the name column is used, whatever else the sheet holds', async ({ page }) => {
  await open(page);
  await importFile(page, 'with-header.xlsx');
  await expect(page.locator('.guest-item')).toHaveCount(3);
  await expect.poll(async () => (await namesOnPage(page)).sort()).toEqual(['خالد الدوسري', 'ليلى الشهري', 'فهد المطيري'].sort());
});

test('a numbering column ("م") next to the names is not imported as names', async ({ page }) => {
  await open(page);
  await importFile(page, 'numbering-column.xlsx');
  await expect(page.locator('.guest-item')).toHaveCount(3);
  await expect.poll(async () => (await namesOnPage(page)).sort()).toEqual(['عبدالله الزهراني', 'منى الحربي', 'يوسف السبيعي'].sort());
});

test('an English "Name" header is found even when it is not the first column', async ({ page }) => {
  await open(page);
  await importFile(page, 'english-header.xlsx');
  await expect.poll(async () => (await namesOnPage(page)).sort()).toEqual(['John Smith', 'Mary Jones']);
});

test('names sitting in column E, with column A empty, are found by their header', async ({ page }) => {
  await open(page);
  await importFile(page, 'names-in-column-e.xlsx');
  await expect.poll(async () => (await namesOnPage(page)).sort()).toEqual(['سلمان اليامي', 'هند الرشيد']);
});

test('a sheet of bare numbers (tickets 1..4) imports them as entries', async ({ page }) => {
  await open(page);
  await importFile(page, 'numbers-only.xlsx');
  await expect.poll(async () => (await namesOnPage(page)).sort()).toEqual(['1', '2', '3', '4']);
});

test('only the first sheet of the workbook is read', async ({ page }) => {
  await open(page);
  await importFile(page, 'two-sheets.xlsx');
  await expect.poll(() => namesOnPage(page)).toEqual(['ضيف من الورقة الأولى']);
});

test('the first sheet is the first one in the workbook, even when it is stored as sheet2.xml', async ({ page }) => {
  await open(page);
  // workbook.xml lists "ورقة ثانية" first; its file is xl/worksheets/sheet2.xml.
  await importFile(page, 'first-sheet-is-not-sheet1.xlsx');
  await expect.poll(async () => (await namesOnPage(page)).sort()).toEqual(['لا تستورد', 'هذا الاسم'].sort());
});

for (const file of ['xlsxwriter-shared.xlsx', 'xlsxwriter-inline.xlsx']) {
  test('a workbook from another writer (' + file + ') imports too', async ({ page }) => {
    await open(page);
    await importFile(page, file);
    await expect.poll(async () => (await namesOnPage(page)).sort()).toEqual(['بدر العنزي', 'رنا الشمري']);
  });
}

test('an empty sheet says there are no names and adds nothing', async ({ page }) => {
  const messages = await open(page);
  await importFile(page, 'blank.xlsx');
  await expect.poll(() => messages.length).toBe(1);
  expect(messages[0]).toContain('ما لقينا أي أسماء صالحة');
  expect(await namesOnPage(page)).toEqual([]);
});

test('a file that is not really a workbook gets a clear message and adds nothing', async ({ page }) => {
  const messages = await open(page);
  await importFile(page, 'not-a-workbook.xlsx');
  await expect.poll(() => messages.length).toBe(1);
  expect(messages[0]).toContain('ما قدرنا نقرأ ملف Excel');
  expect(await namesOnPage(page)).toEqual([]);
});

test('an old .xls file is refused with instructions to save it as .xlsx', async ({ page }) => {
  const messages = await open(page);
  await importFile(page, 'legacy.xls');
  await expect.poll(() => messages.length).toBe(1);
  expect(messages[0]).toContain('.xlsx');
  expect(await namesOnPage(page)).toEqual([]);
});

test('if the zip library could not be loaded, the customer is told to reload or use CSV', async ({ page }) => {
  const messages = await open(page, {}, { withZip: false });
  await importFile(page, 'names-only.xlsx');
  await expect.poll(() => messages.length).toBe(1);
  expect(messages[0]).toContain('CSV');
  expect(await namesOnPage(page)).toEqual([]);
});

test('an Excel import stops at the guest limit like a CSV one, and says how many were left out', async ({ page }) => {
  const messages = await open(page, { guestLimit: 100, guestCount: 0 });
  await importFile(page, 'large-300.xlsx');
  await expect.poll(() => guestCount(page), { timeout: 20000 }).toBe(100);
  expect(messages.join(' ')).toContain('وصلت لحد الـ100 ضيف، 200 اسم ما انضاف');
});

test('the same names already on the list are counted as duplicates, not added twice', async ({ page }) => {
  const messages = await open(page);
  await importFile(page, 'names-only.xlsx');
  await expect(page.locator('.guest-item')).toHaveCount(4);
  await importFile(page, 'names-only.xlsx');
  await expect.poll(() => messages.length).toBe(2);
  expect(messages[1]).toContain('تم استيراد 0 ضيف (تجاهلنا 4 مكرر)');
  expect(await guestCount(page)).toBe(4);
});

test('the file picker offers Excel files, and the menu says so', async ({ page }) => {
  await open(page);
  await expect(page.locator('#csv-import')).toHaveAttribute('accept', /\.xlsx/);
  await page.getByRole('button', { name: '☰' }).click();
  await expect(page.getByRole('button', { name: '📂 استيراد قائمة (Excel / CSV / أسماء)' })).toBeVisible();
});

test('a plain CSV still imports exactly as before', async ({ page }) => {
  await open(page);
  await page.locator('#csv-import').setInputFiles({ name: 'g.csv', mimeType: 'text/csv', buffer: Buffer.from('Name,Phone\nA,1\nB,2') });
  await expect(page.locator('.guest-item')).toHaveCount(2);
  await expect.poll(async () => (await namesOnPage(page)).sort()).toEqual(['A', 'B']);
});
