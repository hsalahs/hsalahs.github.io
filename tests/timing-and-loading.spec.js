const { test, expect } = require('@playwright/test');
const fs = require('fs');
const { stubFirebase, seedFakeFirebase } = require('./helpers');

const USER = { uid: 'u1', email: 'customer@example.com' };
const EVENT = { name: 'حفل تجريبي', ownerUid: 'u1', date: '2026-01-01', venue: 'الرياض', theme: 'gold', createdAt: { seconds: 1 }, guestCount: 2 };
const STORE = () => ({
  events: { e1: { ...EVENT } },
  'events/e1/guests': { g0: { id: 'WD-1', name: 'أحمد', scanned: false }, g1: { id: 'WD-2', name: 'سارة', scanned: true } },
  'events/e1/requests': {},
  'events/e1/private': { scan: { scanPin: '1234' } },
});

const QR_STAND_IN = `window.QRCode = function (el) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, 256, 256); x.fillStyle = '#fff'; x.fillRect(64, 64, 128, 128);
  el.appendChild(c);
};
window.QRCode.CorrectLevel = { H: 2, M: 0, L: 1, Q: 3 };`;

async function setup(page, store = STORE()) {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: USER, store });
}

// utils.js with one of its functions made to throw, to force an exception
// inside the page's sign-in callback.
async function breakUtils(page, fn) {
  const src = fs.readFileSync('utils.js', 'utf8');
  await page.route('**/utils.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: src + '\nfunction ' + fn + '() { throw new Error("boom-from-test"); }\n' }));
}

test.describe('?timing=1 on app.html', () => {
  test('nothing is added without the param', async ({ page }) => {
    await setup(page);
    await page.goto('/app.html');
    await expect(page.locator('.event-card')).toHaveCount(1);
    await expect(page.locator('#timing-line')).toHaveCount(0);
  });

  test('shows the marks line, keeps it after load and logs to the console', async ({ page }) => {
    const logs = [];
    page.on('console', (m) => logs.push(m.text()));
    await setup(page);
    await page.goto('/app.html?timing=1');
    await expect(page.locator('.event-card')).toHaveCount(1);
    const line = page.locator('#timing-line');
    await expect(line).toBeVisible();
    const text = await line.textContent();
    expect(text).toMatch(/script \d+/);
    expect(text).toMatch(/appDbReady( \(already\))? \d+/);
    expect(text).toMatch(/auth user \d+/);
    expect(text).toMatch(/events (cache|server) n=1 \d+/);
    expect(text).toMatch(/utils\.js:\d+/);
    expect(text).toMatch(/icons\.js:\d+/);
    expect(text).toMatch(/firebase-init\.js:[\d…]+/);
    expect(text).toContain('sw:no');
    expect(await line.evaluate((el) => getComputedStyle(el).userSelect)).toBe('text');
    expect(logs.some((l) => l.startsWith('timing:'))).toBe(true);
  });

  test('records the first error message', async ({ page }) => {
    await setup(page);
    await page.addInitScript(() => { window.addEventListener('DOMContentLoaded', () => setTimeout(() => { throw new Error('late-failure-xyz'); }, 50)); });
    await page.goto('/app.html?timing=1');
    await expect(page.locator('#timing-line')).toContainText('err: Uncaught Error: late-failure-xyz');
  });
});

test.describe('?timing=1 on event.html', () => {
  test('nothing is added without the param', async ({ page }) => {
    await setup(page);
    await page.goto('/event.html?id=e1');
    await expect(page.locator('.guest-item')).toHaveCount(2);
    await expect(page.locator('#timing-line')).toHaveCount(0);
  });

  test('shows the stages in order and keeps the line after load', async ({ page }) => {
    await setup(page);
    await page.goto('/event.html?id=e1&timing=1');
    await expect(page.locator('.guest-item')).toHaveCount(2);
    const line = page.locator('#timing-line');
    await expect(line).toContainText('render ');
    const text = await line.textContent();
    const order = ['script ', 'appDbReady', 'auth user', 'getDoc done', 'dashboard shown', 'guests server n=2', 'render '];
    let at = -1;
    for (const k of order) {
      const i = text.indexOf(k);
      expect(i, k).toBeGreaterThan(at);
      at = i;
    }
    expect(text).toMatch(/utils\.js:\d+/);
    expect(text).toContain('sw:no');
  });
});

test.describe('an exception inside the sign-in callback', () => {
  test('app.html replaces the loading text with a tap-to-refresh message', async ({ page }) => {
    await setup(page);
    await breakUtils(page, 'isAdmin');
    await page.goto('/app.html?timing=1');
    const el = page.locator('#auth-loading');
    await expect(el).toBeVisible();
    await expect(el).toHaveText('تعذّر تشغيل الصفحة — اضغط هنا للتحديث');
    await expect(page.locator('#timing-line')).toContainText('boom-from-test');
    const reloaded = page.waitForEvent('load');
    await el.click();
    await reloaded;
  });

  test('event.html replaces the loading text with a tap-to-refresh message', async ({ page }) => {
    await setup(page);
    await breakUtils(page, 'guestCapOf');
    await page.goto('/event.html?id=e1');
    const el = page.locator('#loading-msg');
    await expect(el).toBeVisible();
    await expect(el).toHaveText('تعذّر تشغيل الصفحة — اضغط هنا للتحديث');
  });
});

test.describe('staged slow-connection message', () => {
  test('app.html: plain at first, «الاتصال بطيء» at 8 s without a link, tap-to-retry at 25 s', async ({ page }) => {
    await page.clock.install();
    await setup(page);
    await page.addInitScript(() => { window.__hangAuth = true; });
    await page.goto('/app.html');
    const el = page.locator('#auth-loading');
    await expect(el).toHaveText('جاري التحميل...');
    await page.clock.runFor(9000);
    await expect(el).toHaveText('الاتصال بطيء، لحظات…');
    expect(await el.evaluate((n) => n.style.cursor)).toBe('');
    await page.clock.runFor(17000);
    await expect(el).toContainText('التحميل تأخر — اضغط هنا للمحاولة مرة ثانية');
    const reloaded = page.waitForEvent('load');
    await el.click();
    await reloaded;
  });

  test('the stage marks show up in the timing line', async ({ page }) => {
    await page.clock.install();
    await setup(page);
    await page.addInitScript(() => { window.__hangAuth = true; });
    await page.goto('/app.html?timing=1');
    await page.clock.runFor(26000);
    const text = await page.locator('#timing-line').textContent();
    expect(text).toContain('slow ');
    expect(text).toContain('stuck ');
  });

  for (const [pageUrl, host] of [['/app.html', '#auth-loading'], ['/event.html?id=e1', '#loading-msg']]) {
    test(`${pageUrl} without ?timing=1: no line while loading, the line appears once stuck (home-screen app)`, async ({ page }) => {
      await page.clock.install();
      await setup(page);
      await page.addInitScript(() => { window.__hangAuth = true; });
      await page.goto(pageUrl);
      await expect(page.locator(host)).toHaveText('جاري التحميل...');
      await page.clock.runFor(9000);
      await expect(page.locator('#timing-line')).toHaveCount(0);
      await page.clock.runFor(17000);
      await expect(page.locator(host)).toContainText('التحميل تأخر');
      const text = await page.locator('#timing-line').textContent();
      expect(text).toContain('script ');
      expect(text).toContain('slow ');
      expect(text).toContain('stuck ');
      expect(text).toContain('sw:');
    });
  }

  test('event.html: a page that recovers after getting stuck drops the line again', async ({ page }) => {
    await page.clock.install();
    await setup(page);
    await page.addInitScript(() => { window.__hangAuth = true; });
    await page.goto('/event.html?id=e1');
    await page.clock.runFor(26000);
    await expect(page.locator('#timing-line')).toHaveCount(1);
    await page.evaluate(() => { document.getElementById('loading-msg').style.display = 'none'; tmark('dashboard shown'); });
    await expect(page.locator('#timing-line')).toHaveCount(0);
  });
});

test('both pages preconnect to the sign-in hosts, and to no font host', async () => {
  for (const f of ['app.html', 'event.html']) {
    const html = fs.readFileSync(f, 'utf8');
    expect(html).toContain('<link rel="preconnect" href="https://identitytoolkit.googleapis.com" crossorigin>');
    expect(html).toContain('<link rel="preconnect" href="https://securetoken.googleapis.com" crossorigin>');
    expect((html.match(/rel="preconnect"/g) || []).length).toBe(3);
    expect(html).not.toMatch(/preconnect[^>]*fonts\.(googleapis|gstatic)/);
  }
});

test.describe('event.html loads qrcode.js only when a card is built', () => {
  test('the dashboard opens without requesting it; building a card fetches it once', async ({ page }) => {
    const hits = [];
    await setup(page);
    await page.route(/qrcodejs.*qrcode\.min\.js/, (route) => { hits.push(route.request().url()); route.fulfill({ contentType: 'text/javascript', body: QR_STAND_IN }); });
    expect(fs.readFileSync('event.html', 'utf8')).not.toMatch(/<script src="https:\/\/cdnjs[^>]*qrcode/);
    await page.goto('/event.html?id=e1');
    await expect(page.locator('.guest-item')).toHaveCount(2);
    expect(hits.length).toBe(0);
    const ok = await page.evaluate(async () => {
      const a = await buildGuestCard(guests[0]);
      const b = await buildGuestCard(guests[1]);
      return !!a && !!b;
    });
    expect(ok).toBe(true);
    expect(hits.length).toBe(1);
  });

  test('with the CDN blocked the page still works and a card build gives null, then retries the download', async ({ page }) => {
    let hits = 0;
    let fail = true;
    await setup(page);
    await page.route(/qrcodejs.*qrcode\.min\.js/, (route) => {
      hits++;
      if (fail) return route.abort();
      return route.fulfill({ contentType: 'text/javascript', body: QR_STAND_IN });
    });
    await page.goto('/event.html?id=e1');
    await expect(page.locator('.guest-item')).toHaveCount(2);
    expect(await page.evaluate(async () => await buildGuestCard(guests[0]))).toBeNull();
    fail = false;
    expect(await page.evaluate(async () => !!(await buildGuestCard(guests[0])))).toBe(true);
    expect(hits).toBe(2);
  });
});

test.describe('sortGuestsByName with a shared collator', () => {
  const NAMES = ['10', '2', 'سارة', 'أحمد', 'محمد 10', 'محمد 2', 'محمد 2', '1', 'علي', 'Zed', 'adam', '150', 'خالد'];
  const run = (page) => page.evaluate((names) => {
    const list = names.map((n, i) => ({ name: n, i }));
    return sortGuestsByName(list).map((g) => g.name);
  }, NAMES);
  const expected = () => {
    const nums = NAMES.filter((n) => /^\d+$/.test(n)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    const rest = NAMES.filter((n) => !/^\d+$/.test(n)).sort((a, b) => a.localeCompare(b, 'ar', { numeric: true }));
    return nums.concat(rest);
  };

  test('digits first by value, then names in the same order localeCompare gave; numeric inside names; equal names kept', async ({ page }) => {
    await setup(page);
    await page.goto('/event.html?id=e1');
    const got = await run(page);
    expect(got.slice(0, 4)).toEqual(['1', '2', '10', '150']);
    expect(got).toEqual(expected());
    expect(got.indexOf('محمد 2')).toBeLessThan(got.indexOf('محمد 10'));
  });

  test('falls back to localeCompare when Intl.Collator throws, with the same order', async ({ page }) => {
    await setup(page);
    await page.addInitScript(() => { Intl.Collator = function () { throw new Error('no collator'); }; });
    await page.goto('/event.html?id=e1');
    expect(await page.evaluate(() => nameCollator)).toBeNull();
    expect(await run(page)).toEqual(expected());
  });

  test('uses one module-level collator, not localeCompare per comparison', () => {
    const src = fs.readFileSync('utils.js', 'utf8');
    expect(src).toContain("new Intl.Collator('ar', { numeric: true })");
    expect(src).not.toMatch(/a\.name\.localeCompare/);
  });
});

test.describe('card building and starting the dashboard', () => {
  test('the QR library load gives up after 15 s, so a hanging CDN cannot hang a download', async ({ page }) => {
    await page.clock.install();
    await setup(page);
    let cdnHits = 0;
    await page.route(/qrcodejs.*qrcode\.min\.js/, () => { cdnHits++; });
    await page.goto('/event.html?id=e1');
    await page.clock.runFor(1000);
    await page.evaluate(() => { window.__r = 'pending'; buildGuestCard(guests[0]).then((v) => { window.__r = v === null ? 'null' : 'card'; }); });
    await expect.poll(() => cdnHits).toBe(1);
    await page.clock.runFor(14000);
    expect(await page.evaluate(() => window.__r)).toBe('pending');
    await page.clock.runFor(2000);
    expect(await page.evaluate(() => window.__r)).toBe('null');
  });

  test('a library failure says to check the connection (single card and ZIP); a real canvas failure keeps the old text', async ({ page }) => {
    await setup(page);
    await page.route(/qrcodejs.*qrcode\.min\.js/, (route) => route.abort());
    await page.route(/jszip/, (route) => route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync('node_modules/jszip/dist/jszip.min.js', 'utf8') }));
    await page.goto('/event.html?id=e1');
    await expect(page.locator('.guest-item')).toHaveCount(2);
    const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
    await page.evaluate(() => downloadGuestCard(guests[0].docId));
    expect(dialogs[0]).toContain('تأكد من الاتصال وجرّب مرة ثانية');
    const toast = await page.evaluate(async () => {
      const seen = [];
      const orig = window.showToast;
      window.showToast = (m) => { seen.push(m); };
      await downloadAllCards();
      window.showToast = orig;
      return seen[seen.length - 1];
    });
    expect(toast).toContain('تأكد من الاتصال وجرّب مرة ثانية');
    expect(toast).not.toContain('إضافات الخصوصية');

    await page.evaluate(() => { window.QRCode = function (el) { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 64, 64); el.appendChild(c); }; window.QRCode.CorrectLevel = { H: 2 }; });
    const toast2 = await page.evaluate(async () => {
      const seen = [];
      window.showToast = (m) => { seen.push(m); };
      await downloadAllCards();
      return seen[seen.length - 1];
    });
    expect(toast2).toContain('إضافات الخصوصية');
  });

  test('a double tap on one guest\'s card while the library loads builds and shares once', async ({ page }) => {
    let hits = 0;
    await setup(page);
    await page.route(/qrcodejs.*qrcode\.min\.js/, async (route) => { hits++; await new Promise((r) => setTimeout(r, 400)); route.fulfill({ contentType: 'text/javascript', body: QR_STAND_IN }); });
    await page.goto('/event.html?id=e1');
    await expect(page.locator('.guest-item')).toHaveCount(2);
    const shares = await page.evaluate(async () => {
      let n = 0;
      navigator.canShare = () => true;
      navigator.share = async () => { n++; };
      const id = guests[0].docId;
      await Promise.all([downloadGuestCard(id), downloadGuestCard(id)]);
      await downloadGuestCard(id);
      return n;
    });
    expect(shares).toBe(2);
    expect(hits).toBe(1);
  });

  test('retrying after a failed first read starts the listeners exactly once even if auth fires again', async ({ page }) => {
    await setup(page);
    await page.addInitScript(() => { window.__failGetDocOnce = true; });
    await page.goto('/event.html?id=e1');
    const msg = page.locator('#loading-msg');
    await expect(msg).toContainText('تعذّر الاتصال');
    await page.evaluate(() => {
      window.__guestListeners = 0;
      const orig = window._fsFns.onSnapshot;
      window._fsFns.onSnapshot = function (ref) { if (/guests$/.test(ref.path)) window.__guestListeners++; return orig.apply(this, arguments); };
    });
    await msg.click();
    await page.evaluate(() => { const a = window.__fakeFirebase.auth; a.listeners.slice().forEach((cb) => cb(a.user)); });
    await expect(page.locator('.guest-item')).toHaveCount(2);
    expect(await page.evaluate(() => window.__guestListeners)).toBe(1);
  });
});

test.describe('review round 3', () => {
  test('a ZIP with a hanging QR library fails after one 15 s wait with the network wording', async ({ page }) => {
    await page.clock.install();
    const store = STORE();
    for (let i = 0; i < 30; i++) store['events/e1/guests']['x' + i] = { id: 'X-' + i, name: 'ضيف ' + i, scanned: false };
    await setup(page, store);
    let cdnHits = 0;
    await page.route(/qrcodejs.*qrcode\.min\.js/, () => { cdnHits++; });
    await page.route(/jszip/, (route) => route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync('node_modules/jszip/dist/jszip.min.js', 'utf8') }));
    await page.goto('/event.html?id=e1');
    await page.clock.runFor(1000);
    await page.evaluate(() => {
      window.__toasts = [];
      window.showToast = (m) => { window.__toasts.push(m); };
      window.__zipDone = false;
      downloadAllCards().then(() => { window.__zipDone = true; });
    });
    await expect.poll(() => cdnHits).toBe(1);
    await page.clock.runFor(14000);
    expect(await page.evaluate(() => window.__zipDone)).toBe(false);
    await page.clock.runFor(3000);
    await expect.poll(() => page.evaluate(() => window.__zipDone)).toBe(true);
    const last = await page.evaluate(() => window.__toasts[window.__toasts.length - 1]);
    expect(last).toContain('تأكد من الاتصال وجرّب مرة ثانية');
  });

  test('a late library load after the timeout still works on the next try, and the timer is cleared on success', async ({ page }) => {
    await setup(page);
    let hold = true;
    await page.route(/qrcodejs.*qrcode\.min\.js/, (route) => hold ? route.abort() : route.fulfill({ contentType: 'text/javascript', body: QR_STAND_IN }));
    await page.goto('/event.html?id=e1');
    expect(await page.evaluate(async () => await buildGuestCard(guests[0]))).toBeNull();
    hold = false;
    expect(await page.evaluate(async () => !!(await buildGuestCard(guests[0])))).toBe(true);
    const src = fs.readFileSync('event.html', 'utf8');
    expect(src).toContain('clearTimeout(timer)');
    expect(src).toContain('if (qrLibPromise === p) qrLibPromise = null');
  });

  test('signing out during the first read never starts the dashboard for the old user', async ({ page }) => {
    await setup(page);
    await page.addInitScript(() => { window.__getDocDelays = { 'events/e1': 600 }; });
    await page.goto('/event.html?id=e1');
    await page.evaluate(() => {
      const a = window.__fakeFirebase.auth;
      a.user = null;
      a.listeners.slice().forEach((cb) => cb(null));
    });
    await page.waitForTimeout(1500);
    await expect(page.locator('#dashboard')).toBeHidden();
  });

  test('an account switch during the first read is evaluated for the NEW user', async ({ page }) => {
    await setup(page);
    await page.addInitScript(() => { window.__getDocDelays = { 'events/e1': 600 }; });
    await page.goto('/event.html?id=e1');
    await page.evaluate(() => {
      const a = window.__fakeFirebase.auth;
      a.user = { uid: 'u2', email: 'other@example.com' };
      a.listeners.slice().forEach((cb) => cb(a.user));
    });
    await expect(page.locator('#denied-msg')).toBeVisible();
    await expect(page.locator('#dashboard')).toBeHidden();
  });
});
