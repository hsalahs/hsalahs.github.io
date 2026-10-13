const { test, expect } = require('@playwright/test');
const fs = require('fs');
const { stubFirebase, seedFakeFirebase, stubSupabase, seedAppStore } = require('./helpers');

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

// app.html runs on Supabase: a signed-in customer with one event.
async function setupApp(page, extra = {}) {
  await stubSupabase(page);
  await seedAppStore(page, { user: { id: 'u1', email: 'customer@example.com' }, events: [{ id: 'e1', name: EVENT.name, owner_uid: 'u1', date: EVENT.date, venue: EVENT.venue, guest_count: 2 }], limits: { u1: { event_limit: 3, event_count: 1 } }, ...extra });
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
    await setupApp(page);
    await page.goto('/app.html');
    await expect(page.locator('.event-card')).toHaveCount(1);
    await expect(page.locator('#timing-line')).toHaveCount(0);
  });

  test('shows the marks line, keeps it after load and logs to the console', async ({ page }) => {
    const logs = [];
    page.on('console', (m) => logs.push(m.text()));
    await setupApp(page);
    await page.goto('/app.html?timing=1');
    await expect(page.locator('.event-card')).toHaveCount(1);
    const line = page.locator('#timing-line');
    await expect(line).toBeVisible();
    const text = await line.textContent();
    expect(text).toMatch(/script \d+/);
    expect(text).toMatch(/supabase \d+/);
    expect(text).toMatch(/auth user \d+/);
    expect(text).toMatch(/events server n=1 \d+/);
    expect(text).toMatch(/utils\.js:\d+/);
    expect(text).toMatch(/icons\.js:\d+/);
    expect(text).toMatch(/data\.js:[\d…]+/);
    expect(text).toContain('sw:no');
    expect(text).not.toMatch(/tab:|mode:/);
    expect(await line.evaluate((el) => getComputedStyle(el).userSelect)).toBe('text');
    expect(logs.some((l) => l.startsWith('timing:'))).toBe(true);
  });

  test('records the first error message', async ({ page }) => {
    await setupApp(page);
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
    await setupApp(page, { fail: { is_admin_me: { error: 'network' } } });
    await page.goto('/app.html?timing=1');
    const el = page.locator('#auth-loading');
    await expect(el).toBeVisible();
    await expect(el).toHaveText('تعذّر تشغيل الصفحة — اضغط هنا للتحديث');
    await expect(page.locator('#timing-line')).toContainText('Failed to fetch');
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
    await setupApp(page, { hangAuth: true });
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
    await setupApp(page, { hangAuth: true });
    await page.goto('/app.html?timing=1');
    await page.clock.runFor(26000);
    const text = await page.locator('#timing-line').textContent();
    expect(text).toContain('slow ');
    expect(text).toContain('stuck ');
  });

  for (const [pageUrl, host] of [['/app.html', '#auth-loading'], ['/event.html?id=e1', '#loading-msg']]) {
    test(`${pageUrl} without ?timing=1: no line while loading, the line appears once stuck (home-screen app)`, async ({ page }) => {
      await page.clock.install();
      if (pageUrl.startsWith('/app')) await setupApp(page, { hangAuth: true });
      else { await setup(page); await page.addInitScript(() => { window.__hangAuth = true; }); }
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

test('event.html preconnects to the sign-in hosts and no font host; app.html to the Supabase host only', async () => {
  const html = fs.readFileSync('event.html', 'utf8');
  expect(html).toContain('<link rel="preconnect" href="https://identitytoolkit.googleapis.com" crossorigin>');
  expect(html).toContain('<link rel="preconnect" href="https://securetoken.googleapis.com" crossorigin>');
  expect((html.match(/rel="preconnect"/g) || []).length).toBe(3);
  expect(html).not.toMatch(/preconnect[^>]*fonts\.(googleapis|gstatic)/);
  const app = fs.readFileSync('app.html', 'utf8');
  expect(app.match(/<link rel="preconnect"[^>]*>/g)).toEqual(['<link rel="preconnect" href="https://gunizkapwatixvbfliva.supabase.co" crossorigin>']);
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

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

test.describe('Firestore tab manager', () => {
  const tab = (page) => page.evaluate(() => ({ mode: window._fsTab, mgr: window.__fsTabManager }));

  test('default (browser tab, desktop) uses the multi-tab manager', async ({ page }) => {
    await setup(page);
    await page.goto('/event.html?id=e1&timing=1');
    await expect(page.locator('.guest-item')).toHaveCount(2);
    const t = await tab(page);
    expect(t.mode).toBe('multi');
    expect(t.mgr.kind).toBe('multi-tab');
    await expect(page.locator('#timing-line')).toContainText('tab:multi');
  });

  test.describe('iPhone home-screen app', () => {
    test.use({ userAgent: IPHONE_UA });
    test('navigator.standalone gives single-tab with forceOwnership', async ({ page }) => {
      await page.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { value: true, configurable: true }); });
      await setup(page);
      await page.goto('/event.html?id=e1&timing=1');
      await expect(page.locator('.guest-item')).toHaveCount(2);
      const t = await tab(page);
      expect(t.mode).toBe('single');
      expect(t.mgr).toEqual({ kind: 'single-tab', settings: { forceOwnership: true } });
      await expect(page.locator('#timing-line')).toContainText('tab:single');
    });
    test('event.html also gets single-tab and still loads', async ({ page }) => {
      await page.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { value: true, configurable: true }); });
      await setup(page);
      await page.goto('/event.html?id=e1&timing=1');
      await expect(page.locator('.guest-item')).toHaveCount(2);
      expect((await tab(page)).mode).toBe('single');
      await expect(page.locator('#timing-line')).toContainText('tab:single');
    });
    test('iPhone Safari tab (not installed) stays multi-tab', async ({ page }) => {
      await setup(page);
      await page.goto('/event.html?id=e1');
      await expect(page.locator('.guest-item')).toHaveCount(2);
      expect((await tab(page)).mode).toBe('multi');
    });
  });

  test.describe('Android installed app', () => {
    test.use({ userAgent: ANDROID_UA });
    test('display-mode standalone on Android stays multi-tab', async ({ page }) => {
      await page.addInitScript(() => {
        const mm = window.matchMedia.bind(window);
        window.matchMedia = (q) => /display-mode:\s*standalone/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : mm(q);
      });
      await setup(page);
      await page.goto('/event.html?id=e1');
      await expect(page.locator('.guest-item')).toHaveCount(2);
      expect((await tab(page)).mode).toBe('multi');
    });
  });
});

test.describe('Firestore mode override and stuck-page probes', () => {
  const settings = (page) => page.evaluate(() => ({ mode: window._fsMode, s: window.__fsSettings }));

  test('default: unchanged settings, mode:default, no buttons, no line on a fast load', async ({ page }) => {
    await setup(page);
    await page.goto('/event.html?id=e1');
    await expect(page.locator('.guest-item')).toHaveCount(2);
    const t = await settings(page);
    expect(t.mode).toBe('default');
    expect(t.s.localCache.kind).toBe('persistent');
    expect(t.s.experimentalForceLongPolling).toBeUndefined();
    await expect(page.locator('#timing-line')).toHaveCount(0);
    await expect(page.locator('#timing-btns')).toHaveCount(0);
  });

  test('an unknown fsmode value behaves like default', async ({ page }) => {
    await page.addInitScript(() => { sessionStorage.setItem('fsmode', 'bogus'); });
    await setup(page);
    await page.goto('/event.html?id=e1&timing=1');
    await expect(page.locator('.guest-item')).toHaveCount(2);
    expect((await settings(page)).mode).toBe('default');
    await expect(page.locator('#timing-btns')).toHaveCount(0);
  });

  for (const url of ['/event.html?id=e1&timing=1']) {
    test(`${url}: fsmode=memory uses memoryLocalCache, shows mode:memory and the two buttons`, async ({ page }) => {
      await page.addInitScript(() => { sessionStorage.setItem('fsmode', 'memory'); });
      await setup(page);
      await page.goto(url);
      await expect(page.locator('#timing-line')).toContainText('mode:memory');
      const t = await settings(page);
      expect(t.s.localCache).toEqual({ kind: 'memory' });
      await expect(page.locator('#timing-btns button')).toHaveCount(2);
    });
  }

  test('fsmode=long keeps the persistent cache and forces long polling', async ({ page }) => {
    await page.addInitScript(() => { sessionStorage.setItem('fsmode', 'long'); });
    await setup(page);
    await page.goto('/event.html?id=e1&timing=1');
    await expect(page.locator('#timing-line')).toContainText('mode:long');
    const t = await settings(page);
    expect(t.s.localCache.kind).toBe('persistent');
    expect(t.s.experimentalForceLongPolling).toBe(true);
  });

  test('fsmode is removed as soon as it is read: memory applies to one load only', async ({ page }) => {
    await page.addInitScript(() => { if (!localStorage.getItem('seen')) { localStorage.setItem('seen', '1'); sessionStorage.setItem('fsmode', 'memory'); } });
    await setup(page);
    await page.goto('/event.html?id=e1');
    await expect(page.locator('.guest-item')).toHaveCount(2);
    expect((await settings(page)).mode).toBe('memory');
    expect(await page.evaluate(() => sessionStorage.getItem('fsmode'))).toBeNull();
    await page.reload();
    await expect(page.locator('.guest-item')).toHaveCount(2);
    expect((await settings(page)).mode).toBe('default');
  });

  for (const [pageUrl, host] of [['/event.html?id=e1', '#loading-msg']]) {
    test(`${pageUrl}: a stuck page shows probes and the two buttons; the first sets fsmode=memory and reloads`, async ({ page }) => {
      await page.clock.install();
      await setup(page);
      await page.addInitScript(() => { window.__hangAuth = true; window.__cacheProbe = 'hang'; });
      await page.goto(pageUrl);
      await page.clock.runFor(9000);
      await expect(page.locator('#timing-btns')).toHaveCount(0);
      await page.clock.runFor(18000);
      await expect(page.locator(host)).toContainText('التحميل تأخر');
      const text = await page.locator('#timing-line').textContent();
      expect(text).toMatch(/standalone no hist \d+/);
      expect(text).toMatch(/idb ok \d+ms/);
      expect(text).toMatch(/net (ok|err) \d+ms/);
      if (pageUrl.startsWith('/event')) expect(text).toContain('cache hang');
      expect(text).toContain('mode:default');
      const btns = page.locator('#timing-btns button');
      await expect(btns).toHaveCount(2);
      await expect(btns.nth(0)).toHaveText('جرّب بدون ذاكرة');
      await expect(btns.nth(1)).toHaveText('جرّب اتصال بديل');
      const reloaded = page.waitForEvent('load');
      await btns.nth(0).click();
      await reloaded;
      expect((await settings(page)).mode).toBe('memory');
    });
  }

  test('app.html: a stuck page shows the probe line but no Firestore mode buttons, and tapping the message retries', async ({ page }) => {
    await page.clock.install();
    await setupApp(page, { hangAuth: true });
    await page.goto('/app.html');
    await page.clock.runFor(9000);
    await expect(page.locator('#auth-loading')).toHaveText('الاتصال بطيء، لحظات…');
    await page.waitForTimeout(500);
    await page.clock.runFor(18000);
    const text = await page.locator('#timing-line').textContent();
    expect(text).toMatch(/idb ok \d+ms/);
    expect(text).toMatch(/net (ok|err) \d+ms/);
    expect(text).not.toMatch(/mode:|tab:/);
    await expect(page.locator('#timing-btns')).toHaveCount(0);
    const reloaded = page.waitForEvent('load');
    await page.locator('#auth-loading').click();
    await reloaded;
  });

  test('app.html: stuck then recovered removes the line', async ({ page }) => {
    await page.clock.install();
    await setupApp(page, { hangAuth: true });
    await page.goto('/app.html');
    await page.clock.runFor(27000);
    await expect(page.locator('#timing-line')).toHaveCount(1);
    await page.evaluate(() => { document.querySelector('#auth-loading').style.display = 'none'; tmark('recovered'); });
    await expect(page.locator('#timing-line')).toHaveCount(0);
  });

  test('the second button sets fsmode=long', async ({ page }) => {
    await page.clock.install();
    await setup(page);
    await page.addInitScript(() => { window.__hangAuth = true; });
    await page.goto('/event.html?id=e1');
    await page.clock.runFor(27000);
    const reloaded = page.waitForEvent('load');
    await page.locator('#timing-btns button').nth(1).click();
    await reloaded;
    expect((await settings(page)).mode).toBe('long');
  });

  test('event.html: a cache probe that misses is labelled miss', async ({ page }) => {
    await page.clock.install();
    await setup(page);
    await page.addInitScript(() => { window.__hangAuth = true; window.__cacheProbe = 'miss'; });
    await page.goto('/event.html?id=e1');
    await page.clock.runFor(9000);
    await expect(page.locator('#timing-line')).toHaveCount(0);
    await page.clock.runFor(18000);
    expect(await page.locator('#timing-line').textContent()).toMatch(/cache miss \d+ms/);
  });

  test('tapping the stuck message still retries', async ({ page }) => {
    await page.clock.install();
    await setup(page);
    await page.addInitScript(() => { window.__hangAuth = true; });
    await page.goto('/event.html?id=e1');
    await page.clock.runFor(27000);
    const reloaded = page.waitForEvent('load');
    await page.locator('#loading-msg').click();
    await reloaded;
  });

  test('the mode set by a button travels in sessionStorage (one load), never localStorage', async ({ page }) => {
    await page.clock.install();
    await setup(page);
    await page.addInitScript(() => { window.__hangAuth = true; });
    await page.goto('/event.html?id=e1');
    await page.clock.runFor(27000);
    const reloaded = page.waitForEvent('load');
    await page.locator('#timing-btns button').nth(0).click();
    await reloaded;
    expect((await settings(page)).mode).toBe('memory');
    expect(await page.evaluate(() => [sessionStorage.getItem('fsmode'), localStorage.getItem('fsmode')])).toEqual([null, null]);
  });

  test('a localStorage fsmode (old key) is ignored', async ({ page }) => {
    await page.addInitScript(() => { localStorage.setItem('fsmode', 'memory'); });
    await setup(page);
    await page.goto('/event.html?id=e1');
    await expect(page.locator('.guest-item')).toHaveCount(2);
    expect((await settings(page)).mode).toBe('default');
  });

  for (const [pageUrl, host] of [['/event.html?id=e1', '#loading-msg']]) {
    test(`${pageUrl}: stuck then recovered removes the line and the buttons`, async ({ page }) => {
      await page.clock.install();
      await setup(page);
      await page.addInitScript(() => { window.__hangAuth = true; });
      await page.goto(pageUrl);
      await page.clock.runFor(27000);
      await expect(page.locator('#timing-btns')).toHaveCount(1);
      await page.evaluate((h) => { document.querySelector(h).style.display = 'none'; tmark('recovered'); }, host);
      await expect(page.locator('#timing-line')).toHaveCount(0);
      await expect(page.locator('#timing-btns')).toHaveCount(0);
    });
  }
});

const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const standalone = (page) => page.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { value: true, configurable: true }); });
const calls = (page) => page.evaluate(() => Number(sessionStorage.getItem('__terminateCalls') || 0));

test.describe('Leaving a Firestore page in the iOS home-screen app', () => {
  test.use({ userAgent: IOS_UA });

  test('a same-origin link tap terminates Firestore, then navigates', async ({ page }) => {
    await standalone(page);
    await setup(page);
    await page.goto('/event.html?id=e1');
    await expect(page.locator('.guest-item')).toHaveCount(2);
    await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<a id="t" href="guide.html" style="display:block;padding:20px">go</a>'); });
    await page.locator('#t').click();
    await page.waitForURL('**/guide.html');
    expect(await calls(page)).toBeGreaterThanOrEqual(1);
  });

  test('the next page shows how long leaving took', async ({ page }) => {
    await standalone(page);
    await setup(page);
    await page.goto('/event.html?id=e1');
    await expect(page.locator('.guest-item')).toHaveCount(2);
    await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<a id="t" href="event.html?id=e1&again=1" style="display:block;padding:20px">go</a>'); });
    await page.locator('#t').click();
    await page.waitForURL('**/event.html?id=e1&again=1');
    await expect(page.locator('.guest-item')).toHaveCount(2);
    await page.evaluate(() => { TM.param = true; TM.show = true; tmark('x'); });
    await expect(page.locator('#timing-line')).toContainText(/leave \d+ms/);
  });

  test('a terminate that never answers does not hold the navigation (about 400 ms)', async ({ page }) => {
    await standalone(page);
    await page.addInitScript(() => { window.__terminateHang = true; });
    await setup(page);
    await page.goto('/event.html?id=e1');
    await expect(page.locator('.guest-item')).toHaveCount(2);
    const t0 = Date.now();
    await page.evaluate(() => { window._leave('guide.html'); });
    await page.waitForURL('**/guide.html', { waitUntil: 'commit' });
    const ms = Date.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(350);
    expect(ms).toBeLessThan(1500);
  });

  test('the event menu buttons go back to app.html through the same path', async ({ page }) => {
    await standalone(page);
    await setup(page);
    await page.goto('/event.html?id=e1');
    await expect(page.locator('.guest-item')).toHaveCount(2);
    await page.getByRole('button', { name: 'كل مناسباتي' }).click();
    await page.waitForURL('**/app.html');
    expect(await calls(page)).toBeGreaterThanOrEqual(1);
  });

  test('an unrelated window.goTo with no _leave still navigates (non-Firestore pages)', async ({ page }) => {
    await standalone(page);
    await setup(page);
    await page.goto('/event.html?id=e1');
    await expect(page.locator('.guest-item')).toHaveCount(2);
    await page.evaluate(() => { delete window._leave; goTo('guide.html'); });
    await page.waitForURL('**/guide.html');
  });

  // page.evaluate waits for a pending navigation, so these tests watch the
  // page's load/navigation events and the held request instead.
  test('a slow navigation is not cancelled by a reload', async ({ page }) => {
    await standalone(page);
    await setup(page);
    await page.goto('/event.html?id=e1');
    await expect(page.locator('.guest-item')).toHaveCount(2);
    const seen = [];
    page.on('load', () => seen.push('load'));
    page.on('framenavigated', (f) => seen.push(f.url()));
    await page.route('**/guide.html', async (r) => { await new Promise((x) => setTimeout(x, 6500)); await r.continue().catch(() => {}); });
    await page.evaluate(() => window._leave('guide.html'));
    await page.waitForTimeout(5000);
    expect(seen).toEqual([]);
    await page.waitForURL('**/guide.html');
  });

  test('coming back (visible again) to a page that was left reloads it; a normal page does not', async ({ page }) => {
    await standalone(page);
    await setup(page);
    await page.goto('/event.html?id=e1');
    await expect(page.locator('.guest-item')).toHaveCount(2);
    const fire = () => {
      window.__mark = 1;
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    await page.evaluate(fire);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__mark)).toBe(1);
    await page.route('**/guide.html', async (r) => { await new Promise((x) => setTimeout(x, 30000)); await r.abort().catch(() => {}); });
    const reloaded = page.waitForEvent('load');
    await page.evaluate((src) => { window._leave('guide.html'); setTimeout(new Function('return ' + src)(), 1000); }, fire.toString());
    await reloaded;
    await expect.poll(() => page.evaluate(() => window.__mark === undefined)).toBe(true);
  });

  test('a later tap works again after 10 s if the first navigation never happened', async ({ page }) => {
    await standalone(page);
    await setup(page);
    await page.goto('/event.html?id=e1');
    await expect(page.locator('.guest-item')).toHaveCount(2);
    let requests = 0;
    await page.route('**/guide.html', async (r) => { requests++; await new Promise((x) => setTimeout(x, 30000)); await r.abort().catch(() => {}); });
    await page.evaluate(() => {
      window._leave('guide.html');
      setTimeout(() => window._leave('guide.html'), 1500);
      setTimeout(() => window._leave('guide.html'), 11000);
    });
    await expect.poll(() => requests, { timeout: 5000 }).toBe(1);
    await page.waitForTimeout(3000);
    expect(requests).toBe(1);
    await expect.poll(() => requests, { timeout: 12000 }).toBe(2);
  });

  test('event.html: after 10 s on a page that stayed, errors are no longer silenced: a terminated one reloads', async ({ page }) => {
    await standalone(page);
    await setup(page);
    await page.goto('/event.html?id=e1');
    await expect(page.locator('.guest-item')).toHaveCount(2);
    await page.route('**/app.html', async (r) => { await new Promise((x) => setTimeout(x, 30000)); await r.abort().catch(() => {}); });
    const reloaded = page.waitForEvent('load', { timeout: 20000 });
    await page.evaluate(() => {
      window._leave('app.html');
      setTimeout(() => { showErr(Object.assign(new Error('The client has already been terminated.'), { code: 'failed-precondition' })); }, 10500);
    });
    await reloaded;
    expect(page.url()).toContain('event.html');
  });

  test('event.html: a terminated error raised while leaving shows no toast, does not reload, and the navigation arrives', async ({ page }) => {
    await standalone(page);
    await page.addInitScript(() => { window.__terminateHang = true; });
    await setup(page);
    await page.goto('/event.html?id=e1');
    await expect(page.locator('.guest-item')).toHaveCount(2);
    const alerts = [];
    page.on('dialog', (d) => { alerts.push(d.message()); d.dismiss(); });
    await page.evaluate(() => {
      window.__mark = 1;
      window._leave('app.html');
      showErr(Object.assign(new Error('The client has already been terminated.'), { code: 'failed-precondition' }));
    });
    await expect(page.locator('#toast')).not.toContainText('انقطع الاتصال');
    await page.waitForURL('**/app.html');
    expect(alerts).toEqual([]);
  });

  for (const [name, attrs, extra] of [
    ['target=_blank', 'href="guide.html" target="_blank"', ''],
    ['download', 'href="guide.html" download', ''],
    ['external host', 'href="https://example.org/x"', ''],
    ['wa.me', 'href="https://wa.me/966500000000"', ''],
    ['mailto', 'href="mailto:a@b.co"', ''],
    ['tel', 'href="tel:+966500000000"', ''],
    ['pure #', 'href="#top"', ''],
    ['the same document', 'href="event.html?id=e1"', ''],
    ['same document with hash', 'href="event.html?id=e1#x"', ''],
  ]) {
    test(`not intercepted: ${name}`, async ({ page }) => {
      await standalone(page);
      await setup(page);
      await page.goto('/event.html?id=e1');
      await expect(page.locator('.guest-item')).toHaveCount(2);
      const prevented = await page.evaluate((a) => {
        const el = document.createElement('div');
        el.innerHTML = '<a id="t" ' + a + ' style="display:block;padding:20px">go</a>';
        document.body.appendChild(el);
        let p = null;
        document.addEventListener('click', (e) => { p = e.defaultPrevented; e.preventDefault(); }, { once: true });
        document.getElementById('t').click();
        return p;
      }, attrs);
      expect(prevented).toBe(false);
      expect(await calls(page)).toBe(0);
    });
  }

  test('modifier-key click is not intercepted', async ({ page }) => {
    await standalone(page);
    await setup(page);
    await page.goto('/event.html?id=e1');
    await expect(page.locator('.guest-item')).toHaveCount(2);
    const prevented = await page.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', '<a id="t" href="guide.html">go</a>');
      const a = document.getElementById('t');
      let p = null;
      document.addEventListener('click', (e) => { p = e.defaultPrevented; e.preventDefault(); }, { once: true });
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));
      return p;
    });
    expect(prevented).toBe(false);
    expect(await calls(page)).toBe(0);
  });

  test('a plain link tap in Safari (not installed) is not intercepted', async ({ page }) => {
    await setup(page);
    await page.goto('/event.html?id=e1');
    await expect(page.locator('.guest-item')).toHaveCount(2);
    await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<a id="t" href="guide.html" style="display:block;padding:20px">go</a>'); });
    await page.locator('#t').click();
    await page.waitForURL('**/guide.html');
    expect(await calls(page)).toBe(0);
  });

});

test.describe('Stalled cache watchdog (iOS home-screen app)', () => {
  test.use({ userAgent: IOS_UA });
  // The probe hangs on every load except a memory-mode one.
  const hangUnlessMemory = (page) => page.addInitScript(() => { window.__cacheProbe = sessionStorage.getItem('fsmode') === 'memory' ? 'miss' : 'hang'; });
  const flags = (page) => page.evaluate(() => [sessionStorage.getItem('fsmode'), sessionStorage.getItem('fsauto')]);

  for (const url of ['/event.html?id=e1']) {
    test(`${url}: a healthy probe (even a miss) never reloads and shows probe ok`, async ({ page }) => {
      await standalone(page);
      await page.addInitScript(() => { window.__cacheProbe = 'miss'; window.__loads = 1; });
      await setup(page);
      let loads = 0;
      page.on('load', () => { loads++; });
      await page.goto(url + (url.includes('?') ? '&' : '?') + 'timing=1');
      await expect(page.locator('#timing-line')).toContainText(/probe ok \d+ms/);
      await page.waitForTimeout(6500);
      expect(loads).toBe(1);
      expect(await flags(page)).toEqual([null, null]);
    });

    test(`${url}: a hanging probe reloads once in memory mode, then the next load is persistent`, async ({ page }) => {
      await standalone(page);
      await hangUnlessMemory(page);
      await setup(page);
      const first = page.waitForEvent('load');
      await page.goto(url + (url.includes('?') ? '&' : '?') + 'timing=1');
      const reloaded = page.waitForEvent('load', { timeout: 12000 });
      await reloaded;
      await expect(page.locator('#timing-line')).toContainText('mode:memory');
      await expect(page.locator('#timing-line')).toContainText(/probe ok \d+ms/);
      expect((await page.evaluate(() => window.__fsSettings.localCache.kind))).toBe('memory');
      await first;
      expect(await flags(page)).toEqual([null, null]);
      await page.reload();
      await page.waitForFunction(() => window._fsMode);
      expect(await page.evaluate(() => [window._fsMode, window.__fsSettings.localCache.kind])).toEqual(['default', 'persistent']);
    });
  }

  test('a watchdog that fires while the page is hidden re-checks when it becomes visible', async ({ page }) => {
    await standalone(page);
    await hangUnlessMemory(page);
    await page.addInitScript(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); });
    await setup(page);
    await page.goto('/event.html?id=e1');
    await page.waitForTimeout(6800);
    expect(await flags(page)).toEqual([null, null]);
    const reloaded = page.waitForEvent('load');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await reloaded;
    expect(await page.evaluate(() => window.__fsSettings.localCache.kind)).toBe('memory');
  });

  test('a second stall with fsauto already set does not reload again', async ({ page }) => {
    await standalone(page);
    await page.addInitScript(() => { window.__cacheProbe = 'hang'; sessionStorage.setItem('fsauto', '1'); });
    await setup(page);
    let loads = 0;
    page.on('load', () => { loads++; });
    await page.goto('/event.html?id=e1');
    await page.waitForTimeout(6800);
    expect(loads).toBe(1);
    expect(await page.evaluate(() => sessionStorage.getItem('fsmode'))).toBeNull();
  });

  test('not active on scan.html', async ({ page }) => {
    await standalone(page);
    await page.addInitScript(() => { window.__cacheProbe = 'hang'; });
    await setup(page);
    let loads = 0;
    page.on('load', () => { loads++; });
    await page.goto('/scan.html');
    await page.waitForTimeout(6800);
    expect(loads).toBe(1);
    expect(await flags(page)).toEqual([null, null]);
  });

  test('not active on invite.html', async ({ page }) => {
    await standalone(page);
    await page.addInitScript(() => { window.__cacheProbe = 'hang'; });
    await setup(page);
    let loads = 0;
    page.on('load', () => { loads++; });
    await page.goto('/invite.html?event=e1&guest=WD-1');
    await page.waitForTimeout(6800);
    expect(loads).toBe(1);
    expect(await flags(page)).toEqual([null, null]);
  });

  test('not active outside the home-screen app', async ({ page }) => {
    await page.addInitScript(() => { window.__cacheProbe = 'hang'; });
    await setup(page);
    let loads = 0;
    page.on('load', () => { loads++; });
    await page.goto('/event.html?id=e1');
    await page.waitForTimeout(6800);
    expect(loads).toBe(1);
    expect(await flags(page)).toEqual([null, null]);
  });
});
