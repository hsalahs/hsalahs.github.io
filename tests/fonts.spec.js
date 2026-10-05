const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const PAGES = ['index', 'invite', 'app', 'event', 'scan', 'guide'];

function fontBlock(file) {
  const html = fs.readFileSync(path.join(root, file), 'utf8');
  return html.split('\n').filter((l) => l.startsWith('@font-face{')).join('\n');
}

test('no page, script or service worker references Google Fonts', () => {
  const files = fs.readdirSync(root).filter((f) => /\.(html|js)$/.test(f));
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    expect(src, f).not.toMatch(/fonts\.googleapis\.com\/css|fonts\.gstatic\.com/);
  }
  for (const p of [...PAGES, '404']) {
    expect(fs.readFileSync(path.join(root, p + '.html'), 'utf8'), p).not.toContain('<link rel="stylesheet" href="https://fonts');
  }
});

test('every font file is a real woff2 and every @font-face points at one', () => {
  const dir = path.join(root, 'fonts');
  const files = fs.readdirSync(dir);
  expect(files.length).toBe(9);
  for (const f of files) {
    expect(fs.readFileSync(path.join(dir, f)).subarray(0, 4).toString('latin1'), f).toBe('wOF2');
  }
  const block = fontBlock('index.html');
  const urls = [...block.matchAll(/url\(fonts\/([^)]+)\)/g)].map((m) => m[1]);
  expect(urls.sort()).toEqual(files.sort());
  expect(block).not.toMatch(/https?:/);
});

test('all pages carry the identical inline font block', () => {
  const ref = fontBlock('index.html');
  expect(ref.split('\n').length).toBe(9);
  for (const p of PAGES) expect(fontBlock(p + '.html'), p).toBe(ref);
});

test('index and invite preload the above-the-fold fonts (at most 2)', () => {
  for (const p of ['index', 'invite']) {
    const html = fs.readFileSync(path.join(root, p + '.html'), 'utf8');
    const pre = html.match(/<link rel="preload" as="font" type="font\/woff2" href="fonts\/[^"]+" crossorigin>/g) || [];
    expect(pre.length, p).toBeGreaterThan(0);
    expect(pre.length, p).toBeLessThanOrEqual(2);
    expect(pre[0]).toContain('ibm-plex-sans-arabic-400-arabic.woff2');
  }
});

test('the scanner precaches the font files it uses and every shell file exists', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const shell = [...sw.match(/SHELL_FILES = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  expect(shell).toContain('fonts/ibm-plex-sans-arabic-400-arabic.woff2');
  expect(shell).toContain('fonts/ibm-plex-sans-arabic-400-latin.woff2');
  for (const f of shell) expect(fs.existsSync(path.join(root, f)), f).toBe(true);
});

test('the local fonts really load on the landing page', async ({ page }) => {
  await page.route(/^https:\/\/(?!.*127\.0\.0\.1).*$/, (r) => r.abort());
  await page.goto('/index.html');
  const ok = await page.evaluate(async () => {
    await document.fonts.load("400 16px 'IBM Plex Sans Arabic'", 'دعوة');
    return document.fonts.check("400 16px 'IBM Plex Sans Arabic'", 'دعوة');
  });
  expect(ok).toBe(true);
});
