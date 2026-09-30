const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { stubFirebase, seedFakeFirebase } = require('./helpers');

// The reader itself, run directly (no browser needed): the same source file the page loads.
const src = fs.readFileSync(path.join(__dirname, '..', 'guest-names.js'), 'utf8');
const G = new Function(src + '\nreturn { readTextNames, parseDelimited, detectDelimiter, decodeTextFile, isNameHeaderText, cleanGuestName, pickGuestNames };')();
const FX = (n) => path.join(__dirname, 'fixtures', n);
const bytes = (n) => { const b = fs.readFileSync(FX(n)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const enc = (s) => new TextEncoder().encode(s).buffer;

test.describe('reading a list of names from text: any language, any encoding', () => {
  test('a UTF-8 file with the byte-order mark Excel adds: no mark on the first name, header skipped', () => {
    expect(G.readTextNames(bytes('text-utf8-bom-arabic.csv'))).toEqual(['أحمد الغامدي', 'سارة العتيبي', 'محمد بن سعد القحطاني']);
  });
  test('an older Excel "CSV" saved as Windows-1256 reads as proper Arabic, not question marks', () => {
    expect(G.readTextNames(bytes('text-cp1256-arabic.csv'))).toEqual(['أحمد الغامدي', 'سارة العتيبي', 'محمد بن سعد القحطاني']);
  });
  test('Windows-1256 with Arabic and English in the same file and the same name, and a bilingual header', () => {
    expect(G.readTextNames(bytes('text-cp1256-mixed.csv'))).toEqual(['Ahmed أحمد', 'John Smith', 'سارة Sarah', 'نورة']);
  });
  test('an English-only file (plain ASCII) is unaffected', () => {
    expect(G.readTextNames(bytes('text-ascii-english.csv'))).toEqual(['John Smith', 'Mary Jones', 'Zoe']);
  });
  test('Excel "Unicode Text" (UTF-16, tab-separated) with a numbering column: names only', () => {
    expect(G.readTextNames(bytes('text-utf16le-tab.txt'))).toEqual(['عبدالله الزهراني', 'John Doe', 'منى الحربي']);
  });
  test('a semicolon-separated file (Excel in many regions)', () => {
    expect(G.readTextNames(bytes('text-semicolon.csv'))).toEqual(['خالد الدوسري', 'Layla Ali']);
  });
  test('quoted cells: a comma inside a name, doubled quotes, and a name that spans two lines', () => {
    expect(G.readTextNames(bytes('text-quoted.csv'))).toEqual(['Smith, John', 'O"Neil, Pat', 'سعد, أبو محمد', 'Two Lines']);
  });
  test('a plain list, one per line: CRLF, blank lines, and invisible direction marks removed', () => {
    const names = G.readTextNames(bytes('text-plain-mixed.txt'));
    expect(names).toEqual(['أحمد', 'John Smith', 'سارة', 'Sarah Ali', 'محمد Mohammed']);
    for (const n of names) expect(n).not.toMatch(/[​-‏‪-‮]/);
  });
  test('the same person with and without a direction mark is one name, not two', () => {
    expect(G.cleanGuestName('‏سارة‏')).toBe(G.cleanGuestName('سارة'));
  });
  test('a header in Arabic, English, or both is recognised and never imported as a guest', () => {
    for (const h of ['الاسم', 'اسم', 'الأسماء', 'اسم الضيف', 'الاسم الكامل', 'Name', 'NAME', 'Full Name', 'Guest Name', 'الاسم / Name', 'Name - الاسم', 'الاسم (Name)', 'اسم الضيف *', 'الإسم']) {
      expect(G.isNameHeaderText(h), h).toBe(true);
      expect(G.readTextNames(enc(h + '\nخالد\nJohn'))).toEqual(['خالد', 'John']);
    }
  });
  test('a real guest whose name resembles a header word is kept', () => {
    for (const n of ['Ali - Guest', 'أحمد الضيف', 'Namey', 'الاسمر']) expect(G.isNameHeaderText(n), n).toBe(false);
    expect(G.readTextNames(enc('Ali - Guest\nخالد'))).toEqual(['Ali - Guest', 'خالد']);
  });
  test('a phone column before the names is not mistaken for them (no header)', () => {
    expect(G.readTextNames(enc('0501234567,أحمد الغامدي\n0559876543,John Smith'))).toEqual(['أحمد الغامدي', 'John Smith']);
  });
  test('a sheet of bare numbers (tickets 1..3) imports them', () => {
    expect(G.readTextNames(enc('1\n2\n3'))).toEqual(['1', '2', '3']);
  });
  test('Arabic-Indic digits typed inside names are kept as written', () => {
    expect(G.readTextNames(enc('طاولة ٣ أحمد\nTable 4 Sara'))).toEqual(['طاولة ٣ أحمد', 'Table 4 Sara']);
  });
  test('the legacy shapes still work: "Name,Phone" and "A,1"', () => {
    expect(G.readTextNames(enc('Name,Phone\nA,1\nB,2'))).toEqual(['A', 'B']);
    expect(G.readTextNames(enc('A,1\nB,2'))).toEqual(['A', 'B']);
  });
  test('an empty file, or a file with only a header, has no names', () => {
    expect(G.readTextNames(enc(''))).toEqual([]);
    expect(G.readTextNames(enc('الاسم\n'))).toEqual([]);
    expect(G.readTextNames(enc('\n\n  \n'))).toEqual([]);
  });
  test('a binary file is refused rather than imported as garbage names', () => {
    expect(() => G.readTextNames(bytes('text-binary.txt'))).toThrow('NOT_TEXT');
  });
  test('line endings: LF, CRLF and old-Mac CR all split rows', () => {
    for (const nl of ['\n', '\r\n', '\r']) expect(G.readTextNames(enc(['أحمد', 'John', 'سارة'].join(nl)))).toEqual(['أحمد', 'John', 'سارة']);
  });
});

// End to end through the dashboard: the same files, imported by a customer.
const EVENT = { name: 'حفل تجريبي', ownerUid: 'u1', date: '2026-01-01', venue: 'الرياض', theme: 'gold', createdAt: { seconds: 1 } };
async function open(page) {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: { events: { e1: { ...EVENT, paid: true, guestCount: 0 } }, 'events/e1/guests': {}, 'events/e1/requests': {} } });
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  return dialogs;
}
const namesOnPage = (page) => page.evaluate(() => Object.values(window.__fakeFirebase.store['events/e1/guests']).map(g => g.name));

for (const [file, expected] of [
  ['text-cp1256-arabic.csv', ['أحمد الغامدي', 'سارة العتيبي', 'محمد بن سعد القحطاني']],
  ['text-cp1256-mixed.csv', ['Ahmed أحمد', 'John Smith', 'سارة Sarah', 'نورة']],
  ['text-utf16le-tab.txt', ['عبدالله الزهراني', 'John Doe', 'منى الحربي']],
  ['text-ascii-english.csv', ['John Smith', 'Mary Jones', 'Zoe']],
  ['text-plain-mixed.txt', ['أحمد', 'John Smith', 'سارة', 'Sarah Ali', 'محمد Mohammed']],
]) {
  test('importing ' + file + ' through the dashboard adds exactly those guests', async ({ page }) => {
    await open(page);
    await page.locator('#csv-import').setInputFiles(FX(file));
    await expect.poll(async () => (await namesOnPage(page)).sort()).toEqual(expected.slice().sort());
  });
}

test('a binary file renamed .csv is refused with a clear message and adds nothing', async ({ page }) => {
  const dialogs = await open(page);
  await page.locator('#csv-import').setInputFiles(FX('text-binary.txt'));
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toContain('ما يبدو قائمة أسماء');
  expect(await namesOnPage(page)).toEqual([]);
});

test('an Excel workbook that was saved with a .csv name is still read as a workbook', async ({ page }) => {
  const JSZIP = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'jszip', 'dist', 'jszip.min.js'), 'utf8');
  await stubFirebase(page);
  await page.route('https://cdnjs.cloudflare.com/ajax/libs/jszip/**', (r) => r.fulfill({ contentType: 'text/javascript', body: JSZIP }));
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: { events: { e1: { ...EVENT, paid: true, guestCount: 0 } }, 'events/e1/guests': {}, 'events/e1/requests': {} } });
  page.on('dialog', (d) => d.accept());
  await page.goto('/event.html?id=e1');
  await page.locator('#csv-import').setInputFiles({ name: 'guests.csv', mimeType: 'text/csv', buffer: fs.readFileSync(FX('names-only.xlsx')) });
  await expect.poll(async () => (await namesOnPage(page)).length).toBe(4);
});

test('the file picker accepts tab-separated files as well', async ({ page }) => {
  await open(page);
  await expect(page.locator('#csv-import')).toHaveAttribute('accept', /\.tsv/);
});
