const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const png = (f) => {
  const b = fs.readFileSync(path.join(root, f));
  expect(b.subarray(0, 8).toString('hex'), f + ' should be a PNG').toBe('89504e470d0a1a0a');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};

test('the app and browser icons are the logo, at the sizes the manifest and pages promise', () => {
  expect(png('icons/icon-512.png')).toEqual({ w: 512, h: 512 });
  expect(png('icons/icon-192.png')).toEqual({ w: 192, h: 192 });
  expect(png('icons/apple-touch-icon.png')).toEqual({ w: 180, h: 180 });
  expect(png('icons/favicon-32.png')).toEqual({ w: 32, h: 32 });
  // Every icon the manifest names exists.
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  for (const i of manifest.icons) expect(fs.existsSync(path.join(root, i.src)), i.src).toBe(true);
});

test('the logo and the three occasion artworks are real, self-contained, light SVG files', () => {
  for (const [f, maxKB] of [['logo.svg', 4], ['kind-wedding.svg', 40], ['kind-graduation.svg', 40], ['kind-event.svg', 40]]) {
    const svg = fs.readFileSync(path.join(root, 'icons', f), 'utf8');
    expect(svg, f).toMatch(/^<svg [^>]*viewBox="0 0 \d+ \d+"/);
    expect(svg, f).toContain('<path');
    expect(svg, f).not.toMatch(/<image|href="http|<script|font-family/);   // no embedded bitmaps, network fetches, scripts, or fonts to go missing
    expect(svg.length / 1024, f + ' size in KB').toBeLessThan(maxKB);
  }
});

test('no page still draws the old wedding rings as its logo', () => {
  for (const f of fs.readdirSync(root).filter(n => n.endsWith('.html'))) {
    expect(fs.readFileSync(path.join(root, f), 'utf8'), f).not.toContain('id="ringGold"');
  }
});

test('the opening screen of every page shows a real, loadable picture', async ({ page }) => {
  for (const url of ['/index.html', '/guide.html', '/invite.html?event=none']) {
    await page.goto(url);
    const imgs = page.locator('#splash img, nav img, .logo img');
    const n = await imgs.count();
    for (let i = 0; i < n; i++) {
      await expect.poll(() => imgs.nth(i).evaluate(el => el.complete && el.naturalWidth > 0), { message: url + ' image ' + i }).toBe(true);
    }
  }
});

test('the scanner keeps its opening logo available offline', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  expect(sw).toContain("'icons/logo.svg'");
});
