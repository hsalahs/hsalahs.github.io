const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const formatEventDate = new Function(fs.readFileSync(path.join(root, 'format.js'), 'utf8') + '; return formatEventDate;')();

test('an ISO date reads as weekday, day, month, year — in Western digits', () => {
  expect(formatEventDate('2026-10-29')).toBe('الخميس 29 أكتوبر 2026');
  expect(formatEventDate('2026-01-01')).toBe('الخميس 1 يناير 2026');
  expect(formatEventDate('2026-12-31')).toBe('الخميس 31 ديسمبر 2026');
  expect(formatEventDate('2028-02-29')).toBe('الثلاثاء 29 فبراير 2028'); // a leap day
});

test('every month and weekday name comes out, and never with Arabic-Indic digits', () => {
  const seen = new Set();
  for (let m = 1; m <= 12; m++) {
    const out = formatEventDate('2026-' + String(m).padStart(2, '0') + '-15');
    expect(out).not.toMatch(/[\u0660-\u0669\u06F0-\u06F9]/);
    expect(out).toMatch(/ 15 .+ 2026$/);
    seen.add(out.split(' ')[2]);
  }
  expect(seen.size).toBe(12);
  const weekdays = new Set(Array.from({ length: 7 }, (_, i) => formatEventDate('2026-11-0' + (i + 1)).split(' ')[0]));
  expect(weekdays.size).toBe(7);
});

test('anything that is not a real calendar date comes back unchanged, so nothing an organizer typed is hidden', () => {
  expect(formatEventDate('')).toBe('');
  expect(formatEventDate(undefined)).toBe('');
  expect(formatEventDate(null)).toBe('');
  expect(formatEventDate('قريبًا')).toBe('قريبًا');
  expect(formatEventDate('2026-02-30')).toBe('2026-02-30');   // no such day
  expect(formatEventDate('2027-02-29')).toBe('2027-02-29');   // not a leap year
  expect(formatEventDate('2026-13-01')).toBe('2026-13-01');
  expect(formatEventDate('29/10/2026')).toBe('29/10/2026');
});

test('the day of the week does not depend on the time zone of whoever is looking', async ({ browser }) => {
  // A date-only string parsed as local time would slip a day for anyone west
  // of UTC; the formatter works in UTC, so every zone agrees.
  for (const timezoneId of ['Pacific/Kiritimati', 'Asia/Riyadh', 'UTC', 'America/Los_Angeles', 'Pacific/Pago_Pago']) {
    const context = await browser.newContext({ timezoneId });
    const page = await context.newPage();
    await page.goto('/index.html');
    const out = await page.evaluate(() => formatEventDate('2026-10-29'));
    expect(out, timezoneId).toBe('الخميس 29 أكتوبر 2026');
    await context.close();
  }
});

// The service is written for readers who prefer 0-9 to ٠-٩. This keeps a
// stray Arabic-Indic digit from creeping back into any page, script or manifest.
test('no page, script or manifest contains an Arabic-Indic digit', () => {
  const offenders = [];
  for (const f of fs.readdirSync(root).filter(n => /\.(html|js|webmanifest)$/.test(n))) {
    fs.readFileSync(path.join(root, f), 'utf8').split('\n').forEach((line, i) => {
      if (/[\u0660-\u0669\u06F0-\u06F9]/.test(line)) offenders.push(f + ':' + (i + 1) + '  ' + line.trim().slice(0, 80));
    });
  }
  expect(offenders).toEqual([]);
});
