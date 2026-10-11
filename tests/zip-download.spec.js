const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { stubFirebase, seedFakeFirebase } = require('./helpers');

const JSZIP_BROWSER = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'jszip', 'dist', 'jszip.min.js'), 'utf8');
const EVENT = { name: 'حفل تجريبي', ownerUid: 'u1', date: '2026-01-01', venue: 'الرياض', theme: 'gold', createdAt: { seconds: 1 } };

function guestsStore(names) {
  const g = {};
  names.forEach((name, i) => {
    g['g' + i] = { id: 'WD-' + String(i + 1).padStart(4, '0'), name, scanned: false, registeredAt: '2026-03-01T10:15:00.000Z' };
  });
  return { events: { e1: { ...EVENT, paid: true, guestCount: names.length } }, 'events/e1/guests': g, 'events/e1/requests': {} };
}
const numbered = (n) => Array.from({ length: n }, (_, i) => 'ضيف ' + (i + 1));

// Cards are cheap 8x8 canvases (the real card builder is covered in event.spec.js);
// failAll makes every card fail the way a blocked canvas does.
async function open(page, names, { failAll = false, noZip = false } = {}) {
  await stubFirebase(page);
  if (!noZip) await page.route('https://cdnjs.cloudflare.com/ajax/libs/jszip/**', (r) => r.fulfill({ contentType: 'text/javascript', body: JSZIP_BROWSER }));
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: guestsStore(names) });
  const dialogs = [];
  page.on('dialog', (d) => {
    dialogs.push({ type: d.type(), message: d.message() });
    return d.accept();
  });
  // Headless Chromium reports any non-ASCII download name as "download", so the
  // names the page asks for are recorded from the anchor's download attribute.
  await page.addInitScript(() => {
    window.__dlNames = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) window.__dlNames.push(this.download); return click.call(this); };
  });
  const downloads = [];
  page.on('download', (d) => downloads.push(d));
  await page.goto('/event.html?id=e1');
  await expect(page.locator('.guest-item')).toHaveCount(names.length);
  await page.evaluate((failAll) => {
    window.buildGuestCard = async () => {
      if (failAll) return null;
      const c = document.createElement('canvas'); c.width = c.height = 8;
      c.getContext('2d').fillRect(0, 0, 8, 8);
      return c;
    };
    const orig = window.showToast;
    window.__toasts = [];
    window.showToast = (m) => { window.__toasts.push(m); return orig(m); };
  }, failAll);
  return { dialogs, downloads };
}

async function zipFiles(download) {
  const zip = await JSZip.loadAsync(fs.readFileSync(await download.path()));
  return Object.keys(zip.files).sort();
}
const clickAll = async (page) => {
  await page.getByRole('button', { name: 'القائمة' }).click();
  await page.getByRole('button', { name: /تحميل كل الدعوات/ }).click();
};

test('250 guests download as ONE Invitations.zip with every guest, no question, Western-digit progress', async ({ page }) => {
  const { dialogs, downloads } = await open(page, numbered(250));
  await clickAll(page);
  await expect.poll(() => downloads.length, { timeout: 40000 }).toBe(1);
  expect(await page.evaluate(() => window.__dlNames)).toEqual(['Invitations.zip']);
  expect((await zipFiles(downloads[0])).length).toBe(250);
  expect(dialogs).toHaveLength(0);
  const toasts = await page.evaluate(() => window.__toasts);
  expect(toasts).toContain('⏳ 150 / 250 تم...');
  expect(toasts.some(t => /✅ تم تحميل الملف/.test(t))).toBe(true);
  expect(toasts.some(t => /الجزء/.test(t))).toBe(false);
  expect(toasts.join(' ')).not.toMatch(/[٠-٩]/);
});

test('80 guests download as one Invitations.zip', async ({ page }) => {
  const { downloads } = await open(page, numbered(80));
  await clickAll(page);
  await expect.poll(() => downloads.length, { timeout: 20000 }).toBe(1);
  expect(downloads[0].suggestedFilename()).toBe('Invitations.zip');
  expect((await zipFiles(downloads[0])).length).toBe(80);
});

test('a manual range stays one file even above 100 cards', async ({ page }) => {
  const { dialogs, downloads } = await open(page, numbered(150));
  page.removeAllListeners('dialog');
  const answers = ['1', '120'];
  page.on('dialog', (d) => { if (d.type() === 'prompt') d.accept(answers.shift()); else d.accept(); });
  await page.getByRole('button', { name: 'القائمة' }).click();
  await page.getByRole('button', { name: /تحميل نطاق معيّن/ }).click();
  await expect.poll(() => downloads.length, { timeout: 20000 }).toBe(1);
  expect(downloads[0].suggestedFilename()).toBe('Invitations-1-120.zip');
  expect((await zipFiles(downloads[0])).length).toBe(120);
});

test('duplicate names are numbered so no card overwrites another', async ({ page }) => {
  const names = Array.from({ length: 105 }, () => 'نفس الاسم');
  const { downloads } = await open(page, names);
  await clickAll(page);
  await expect.poll(() => downloads.length, { timeout: 30000 }).toBe(1);
  const files = await zipFiles(downloads[0]);
  expect(files).toContain('Invitation-نفس الاسم.png');
  expect(files).toContain('Invitation-نفس الاسم (105).png');
  expect(new Set(files).size).toBe(105);
});

test('every card failing shows the message and downloads nothing', async ({ page }) => {
  const { downloads } = await open(page, numbered(120), { failAll: true });
  await clickAll(page);
  await expect.poll(() => page.evaluate(() => window.__toasts.some(t => /ما قدرنا ننشئ أي بطاقة/.test(t))), { timeout: 20000 }).toBe(true);
  await page.waitForTimeout(500);
  expect(downloads).toHaveLength(0);
});

test('without the ZIP library a friendly message shows instead of a crash', async ({ page }) => {
  await open(page, numbered(3), { noZip: true }).then(async ({ downloads }) => {
    await page.route('https://cdnjs.cloudflare.com/ajax/libs/jszip/**', (r) => r.abort());
    await page.evaluate(() => { window.JSZip = undefined; });
    await clickAll(page);
    await expect.poll(() => page.evaluate(() => window.__toasts.some(t => /أداة الضغط/.test(t)))).toBe(true);
    expect(downloads).toHaveLength(0);
  });
});

