const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { stubFirebase, seedFakeFirebase } = require('./helpers');

const JSZIP_BROWSER = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'jszip', 'dist', 'jszip.min.js'), 'utf8');
const EVENT = { name: 'حفل تجريبي', ownerUid: 'u1', date: '2026-01-01', venue: 'الرياض', theme: 'gold', createdAt: { seconds: 1 } };

// Names of every shape a customer's list might hold.
const ARABIC = ['أحمد بن سعد القحطاني', 'نورة عبدالله', 'عبدالرحمن'];
const ENGLISH = ['John Smith', 'Mary-Ann O\'Neil', 'Zoe'];
const MIXED = ['Ahmed أحمد', 'سارة Sarah', 'د. Khalid العتيبي (VIP)'];
const AWKWARD = [
  '=HYPERLINK("http://example.com","click")',   // would run as a formula if written as one
  '+966501234567',
  '-1+1',
  '@SUM(A1:A2)',
  '  spaced  name  ',
  'Tom & Jerry <b>"quoted"</b>',
  'اسم بأرقام ٣٤٥ و 678',
  'emoji 🎉 name',
  'tab\tinside',
  'ctrl\u0001char\u0008here',
];

function guestsStore(names, extra = {}) {
  const g = {};
  names.forEach((name, i) => {
    g['g' + i] = { id: 'WD-' + String(i + 1).padStart(4, '0'), name, scanned: i % 2 === 0, registeredAt: '2026-03-0' + ((i % 9) + 1) + 'T10:15:00.000Z', ...(extra[i] || {}) };
  });
  return { events: { e1: { ...EVENT, paid: true, guestCount: names.length } }, 'events/e1/guests': g, 'events/e1/requests': {} };
}

async function open(page, names, { withZip = true } = {}) {
  await stubFirebase(page);
  if (withZip) await page.route('https://cdnjs.cloudflare.com/ajax/libs/jszip/**', (r) => r.fulfill({ contentType: 'text/javascript', body: JSZIP_BROWSER }));
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: guestsStore(names) });
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('.guest-item')).toHaveCount(names.length);
  return dialogs;
}

async function exportXlsx(page) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    (async () => { await page.getByRole('button', { name: 'القائمة' }).click(); await page.getByRole('button', { name: 'تصدير قائمة الضيوف (Excel)' }).click(); })(),
  ]);
  const file = await download.path();
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  return { download, zip, bytes: fs.readFileSync(file) };
}

const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
// Rows of text as the sheet holds them: [[A1, B1, ...], [A2, ...], ...]
function sheetRows(sheetXml) {
  return [...sheetXml.matchAll(/<row [^>]*>(.*?)<\/row>/gs)].map(r =>
    [...r[1].matchAll(/<c r="([A-Z]+)\d+"[^>]*>(.*?)<\/c>/gs)].reduce((row, c) => {
      const col = c[1].charCodeAt(0) - 65;
      const t = /<t[^>]*>(.*?)<\/t>/s.exec(c[2]);
      row[col] = t ? unescapeXml(t[1]) : '';
      return row;
    }, []));
}
// What a cleaner would leave of a name: control characters removed.
const cleaned = (s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

for (const [label, names] of [['Arabic-only', ARABIC], ['English-only', ENGLISH], ['mixed Arabic and English', MIXED], ['awkward characters', AWKWARD]]) {
  test('a list of ' + label + ' names exports with every name intact, as text', async ({ page }) => {
    await open(page, names);
    const { zip } = await exportXlsx(page);
    const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
    const rows = sheetRows(xml);
    expect(rows[0]).toEqual(['الاسم', 'الكود', 'الحضور', 'وقت التسجيل']);
    expect(rows.length).toBe(names.length + 1);
    const exported = rows.slice(1).map(r => r[0]).sort();
    expect(exported).toEqual(names.map(cleaned).sort());
    // No formula, number or shared-string cell anywhere: everything is literal text.
    expect(xml).not.toMatch(/<f[ >]/);
    expect(xml).not.toMatch(/<c [^>]*t="(n|s|str|b|e)"/);
  });
}

test('each row carries the code, attendance and a readable registration time with Western digits', async ({ page }) => {
  await open(page, ['أ', 'B', 'ج']);
  const { zip } = await exportXlsx(page);
  const rows = sheetRows(await zip.file('xl/worksheets/sheet1.xml').async('string')).slice(1);
  const byName = Object.fromEntries(rows.map(r => [r[0], r]));
  expect(byName['أ'][1]).toBe('WD-0001'); expect(byName['أ'][2]).toBe('حضر');
  expect(byName['B'][1]).toBe('WD-0002'); expect(byName['B'][2]).toBe('لسه');
  expect(byName['ج'][2]).toBe('حضر');
  for (const r of rows) expect(r[3]).toMatch(/^2026-03-0\d \d{2}:\d{2}$/);
  expect(JSON.stringify(rows)).not.toMatch(/[٠-٩]/);
});

test('the workbook is a well-formed package: every part parses, the sheet reads right-to-left with a frozen header', async ({ page }) => {
  await open(page, [...ARABIC, ...ENGLISH, ...MIXED, ...AWKWARD]);
  const { zip } = await exportXlsx(page);
  const names = Object.keys(zip.files);
  expect(names[0]).toBe('[Content_Types].xml');
  expect(names.sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'].sort());
  const parts = {};
  for (const n of names) parts[n] = await zip.file(n).async('string');
  const problems = await page.evaluate((p) => Object.entries(p).filter(([, xml]) => new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagName('parsererror').length).map(([n]) => n), parts);
  expect(problems).toEqual([]);
  const sheet = parts['xl/worksheets/sheet1.xml'];
  expect(sheet).toContain('rightToLeft="1"');
  expect(sheet).toContain('state="frozen"');
  expect(parts['xl/workbook.xml']).toContain('name="الضيوف"');
  // The workbook and its relationships point at parts that exist.
  expect(parts['xl/_rels/workbook.xml.rels']).toContain('worksheets/sheet1.xml');
  expect(parts['[Content_Types].xml']).toContain('/xl/worksheets/sheet1.xml');
});

test('exporting and importing the same workbook gives back exactly the same names', async ({ page }) => {
  const names = [...ARABIC, ...ENGLISH, ...MIXED, 'اسم بأرقام ٣٤٥ و 678', 'Tom & Jerry <b>"quoted"</b>', 'emoji 🎉 name'];
  await open(page, names);
  const { bytes } = await exportXlsx(page);
  const back = await page.evaluate(async (arr) => readXlsxNames(new Uint8Array(arr).buffer), Array.from(bytes));
  expect(back.slice().sort()).toEqual(names.map(n => n.replace(/\s+/g, ' ').trim()).sort());
});

test('the export follows what the dashboard shows: the attendance filter and the search box apply', async ({ page }) => {
  await open(page, ['Ali', 'Omar', 'Sara', 'Lina']);   // g0 Ali attended, g1 Omar not, g2 Sara attended, g3 Lina not
  await page.locator('#box-attended').click();
  let rows = sheetRows(await (await exportXlsx(page)).zip.file('xl/worksheets/sheet1.xml').async('string')).slice(1);
  expect(rows.map(r => r[0]).sort()).toEqual(['Ali', 'Sara']);
  await page.locator('#box-all').click();
  await page.locator('#guest-search').fill('om');
  rows = sheetRows(await (await exportXlsx(page)).zip.file('xl/worksheets/sheet1.xml').async('string')).slice(1);
  expect(rows.map(r => r[0])).toEqual(['Omar']);
});

test('an empty list says so instead of downloading an empty workbook', async ({ page }) => {
  await open(page, []);
  let downloaded = false;
  page.on('download', () => { downloaded = true; });
  await page.getByRole('button', { name: 'القائمة' }).click();
  await page.getByRole('button', { name: 'تصدير قائمة الضيوف (Excel)' }).click();
  await expect(page.locator('#toast')).toContainText('لا يوجد ضيوف بعد');
  await page.waitForTimeout(400);
  expect(downloaded).toBe(false);
});

test('a big list (1500 names) exports in one piece', async ({ page }) => {
  const names = Array.from({ length: 1500 }, (_, i) => (i % 2 ? 'ضيف ' : 'Guest ') + (i + 1));
  await open(page, names);
  const { zip } = await exportXlsx(page);
  const rows = sheetRows(await zip.file('xl/worksheets/sheet1.xml').async('string'));
  expect(rows.length).toBe(1501);
});

test('if the zip library could not be loaded, the customer is told to reload or use CSV', async ({ page }) => {
  const dialogs = await open(page, ['Ali'], { withZip: false });
  await page.getByRole('button', { name: 'القائمة' }).click();
  await page.getByRole('button', { name: 'تصدير قائمة الضيوف (Excel)' }).click();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toContain('CSV');
});

test('the CSV export neutralises names that would run as formulas in Excel', async ({ page }) => {
  await open(page, ['=HYPERLINK("http://example.com","x")', '+966501234567', '-1+1', '@SUM(A1)', 'Normal Name', 'سارة']);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    (async () => { await page.getByRole('button', { name: 'القائمة' }).click(); await page.getByRole('button', { name: 'تصدير قائمة الضيوف (CSV)' }).click(); })(),
  ]);
  const csv = fs.readFileSync(await download.path(), 'utf8');
  for (const dangerous of ['"=HYPERLINK', '"+966', '"-1+1', '"@SUM']) expect(csv).not.toContain(dangerous);
  expect(csv).toContain(`"'=HYPERLINK(""http://example.com"",""x"")"`);
  expect(csv).toContain(`"'+966501234567"`);
  expect(csv).toContain('"Normal Name"');
  expect(csv).toContain('"سارة"');
});
