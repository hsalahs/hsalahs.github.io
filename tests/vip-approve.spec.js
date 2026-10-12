const { test, expect } = require('@playwright/test');
const { stubFirebase, seedFakeFirebase, stubSupabase, seedInviteStore } = require('./helpers');

const EVENT = {
  name: 'حفل تجريبي', ownerUid: 'u1', date: '2026-01-01', venue: 'الرياض',
  theme: 'gold', createdAt: { seconds: 1 },
};

function store(reqs, guests, eventExtra) {
  const r = {};
  reqs.forEach((x, i) => { r['r' + i] = { reqId: 'r' + i, status: 'pending', createdAt: '2026-01-01T00:00:00.000Z', ...x }; });
  const g = {};
  (guests || []).forEach((x, i) => { g['g' + i] = x; });
  return {
    events: { e1: { ...EVENT, paid: true, ...eventExtra } },
    'events/e1/guests': g,
    'events/e1/private': { scan: { scanPin: '1234' } },
    'events/e1/requests': r,
  };
}
async function openEvent(page, st) {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: st });
  await page.addInitScript(() => { window.__opened = 0; window.open = () => { window.__opened++; return null; }; });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
}
async function openRequests(page, st) {
  await openEvent(page, st);
  await page.getByRole('button', { name: 'القائمة' }).click();
  await page.getByRole('button', { name: /^الطلبات/ }).click();
}
const read = (page) => page.evaluate(() => {
  const s = window.__fakeFirebase.store;
  return { guests: s['events/e1/guests'] || {}, requests: s['events/e1/requests'], opened: window.__opened };
});

test('a request row shows قبول, قبول كـ VIP and رفض', async ({ page }) => {
  await openRequests(page, store([{ name: 'سارة' }]));
  await expect(page.locator('.pending-item .approve-btn')).toContainText('قبول');
  await expect(page.locator('.pending-item .vip-approve-btn')).toContainText('قبول كـ VIP');
  await expect(page.locator('.pending-item .vip-approve-btn svg.ic')).toHaveCount(1);
  await expect(page.locator('.pending-item .reject-btn')).toContainText('رفض');
});

test('قبول كـ VIP writes vip:true on the guest and the request, and says so in the toast', async ({ page }) => {
  await openRequests(page, store([{ name: 'سارة' }]));
  await page.locator('.vip-approve-btn').click();
  await expect(page.locator('#toast')).toContainText('تمت الموافقة — سارة (VIP)');
  const st = await read(page);
  const guest = Object.values(st.guests)[0];
  expect(guest.vip).toBe(true);
  expect(guest.reqId).toBe('r0');
  expect(st.requests.r0.status).toBe('approved');
  expect(st.requests.r0.vip).toBe(true);
  expect(st.requests.r0.guestId).toBe(guest.id);
});

test('plain قبول writes no vip anywhere', async ({ page }) => {
  await openRequests(page, store([{ name: 'سارة' }]));
  await page.locator('.approve-btn').click();
  await expect(page.locator('#toast')).toContainText('تمت الموافقة — سارة');
  await expect(page.locator('#toast')).not.toContainText('VIP');
  const st = await read(page);
  expect('vip' in Object.values(st.guests)[0]).toBe(false);
  expect('vip' in st.requests.r0).toBe(false);
});

test('at the free-guest limit both approve buttons open the payment prompt and approve nobody', async ({ page }) => {
  await openRequests(page, store([{ name: 'سارة' }, { name: 'خالد' }], [], { paid: false, guestCount: 5 }));
  await expect(page.locator('.vip-approve-btn')).toHaveCount(2);
  await page.locator('.approve-btn').first().click();
  await expect.poll(async () => (await read(page)).opened).toBe(1);
  await page.locator('.vip-approve-btn').first().click();
  await expect.poll(async () => (await read(page)).opened).toBe(2);
  const st = await read(page);
  expect(Object.keys(st.guests)).toHaveLength(0);
  expect(st.requests.r0.status).toBe('pending');
});

test('while accepting all, the VIP buttons are disabled too; the bulk path adds no vip', async ({ page }) => {
  await openRequests(page, store([{ name: 'أ' }, { name: 'ب' }]));
  await expect(page.locator('.accept-all-hint')).toHaveText('أو اقبل وارفض كل طلب لحاله تحت — وتقدر تختار قبول كـ VIP');
  await page.evaluate(() => { window.__fakeFirebase.txDelay = 1200; });
  await page.locator('.accept-all').click();
  await page.locator('#approve-all-modal').getByRole('button', { name: 'اقبل الكل' }).click();
  await expect(page.locator('.vip-approve-btn').first()).toBeDisabled();
  await expect(page.locator('#toast')).toContainText('تم قبول 2');
  const st = await read(page);
  expect(Object.values(st.guests).some(g => g.vip)).toBe(false);
});

for (const width of [320, 375]) {
  test(`${width}px: request rows keep the name on its own line, three buttons below, no sideways scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 });
    await openRequests(page, store([{ name: 'اسم طويل جدا للضيف الذي يطلب الدعوة' }]));
    const m = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const a = r('.pending-item .approve-btn'), v = r('.pending-item .vip-approve-btn'), x = r('.pending-item .reject-btn'), n = r('.pending-info');
      return { a, v, x, n, sw: document.documentElement.scrollWidth, boxL: r('.pending-item').left, boxR: r('.pending-item').right };
    });
    expect(m.sw).toBeLessThanOrEqual(width);
    expect(m.n.bottom).toBeLessThanOrEqual(Math.min(m.a.top, m.v.top, m.x.top) + 1);
    expect(Math.abs(m.a.top - m.v.top)).toBeLessThan(2);
    expect(Math.abs(m.v.top - m.x.top)).toBeLessThan(2);
    expect(m.a.left).toBeGreaterThan(m.v.left);
    expect(m.v.left).toBeGreaterThan(m.x.left);
    expect(m.x.left).toBeGreaterThanOrEqual(m.boxL - 1);
    expect(m.a.right).toBeLessThanOrEqual(m.boxR + 1);
  });
}

test('on a desktop width the row stays on one line', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 760 });
  await openRequests(page, store([{ name: 'سارة' }]));
  const m = await page.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    return { n: r('.pending-info'), a: r('.approve-btn'), x: r('.reject-btn') };
  });
  expect(Math.abs(m.n.top - m.a.top)).toBeLessThan(25);
  expect(m.n.bottom).toBeGreaterThan(m.a.top);
  expect(m.x.top).toBeLessThan(m.n.bottom + 2);
});

const guestStore = (guest, reqs) => store(reqs || [], [guest]);
const toggleFirst = async (page, name) => {
  await page.locator('.guest-item .more-btn').click();
  await page.getByRole('button', { name }).click();
};

test('marking VIP from the menu also updates the guest\'s request, and un-VIP writes false', async ({ page }) => {
  await openEvent(page, guestStore({ id: 'WD-1', name: 'سارة', reqId: 'r0', scanned: false }, [{ name: 'سارة', status: 'approved', guestId: 'WD-1' }]));
  await toggleFirst(page, /تمييز كـ VIP/);
  await expect.poll(async () => (await read(page)).requests.r0.vip).toBe(true);
  expect((await read(page)).guests.g0.vip).toBe(true);
  await toggleFirst(page, /إلغاء تمييز VIP/);
  await expect.poll(async () => (await read(page)).requests.r0.vip).toBe(false);
  expect((await read(page)).guests.g0.vip).toBe(false);
});

test('marking VIP on a guest with no request link raises no error toast', async ({ page }) => {
  await openEvent(page, guestStore({ id: 'WD-1', name: 'أحمد', scanned: false }));
  await toggleFirst(page, /تمييز كـ VIP/);
  await expect.poll(async () => (await read(page)).guests.g0.vip).toBe(true);
  await expect(page.locator('#toast')).toContainText('صار VIP');
  await expect(page.locator('#toast')).not.toContainText('تعذّر');
  expect(Object.keys((await read(page)).requests)).toHaveLength(0);
});

test('a deleted or differently-named request is ignored quietly (not-found)', async ({ page }) => {
  await openEvent(page, guestStore({ id: 'WD-1', name: 'سارة', reqId: 'gone', scanned: false }));
  await toggleFirst(page, /تمييز كـ VIP/);
  await expect.poll(async () => (await read(page)).guests.g0.vip).toBe(true);
  await page.waitForTimeout(300);
  await expect(page.locator('#toast')).not.toContainText('تعذّر');
  expect(Object.keys((await read(page)).requests)).toHaveLength(0);
});

test('any other failure updating the request shows the soft toast', async ({ page }) => {
  await openEvent(page, guestStore({ id: 'WD-1', name: 'سارة', reqId: 'r0', scanned: false }, [{ name: 'سارة', status: 'approved', guestId: 'WD-1' }]));
  await page.evaluate(() => { window.__fakeFirebase.denyPaths = ['events/e1/requests/r0']; });
  await toggleFirst(page, /تمييز كـ VIP/);
  await expect(page.locator('#toast')).toContainText('تعذّر تحديث بطاقة الضيف عند الضيف');
  expect((await read(page)).guests.g0.vip).toBe(true);
});

const QR_STAND_IN = `window.QRCode = function (el) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, 256, 256); x.fillStyle = '#fff'; x.fillRect(64, 64, 128, 128);
  el.appendChild(c);
};
window.QRCode.CorrectLevel = { H: 2, M: 0, L: 1, Q: 3 };`;

async function openInvite(page, reqExtra) {
  await stubSupabase(page);
  await page.route(/qrcodejs.*qrcode\.min\.js/, (route) => route.fulfill({ contentType: 'text/javascript', body: QR_STAND_IN }));
  await seedInviteStore(page, {
    store: {
      events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } },
      'events/e1/requests': { 'REQ-TEST-0000000000000000001': { name: 'سارة', reqId: 'REQ-TEST-0000000000000000001', status: 'approved', guestId: 'WD-ABC', createdAt: 'x', ...reqExtra } },
    },
  });
  await page.addInitScript(() => { localStorage.setItem('inv_reqid_e1', 'REQ-TEST-0000000000000000001'); });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card-wrap img')).toBeVisible();
}
// Pixels of the card image the guest sees (the same canvas that gets saved).
const cardPixels = (page) => page.evaluate(() => {
  const c = cardCanvas;
  const px = (x, y) => Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data.slice(0, 3));
  return { bg: px(60, 700), badge: px(440, 206), qrBox: px(200, 600), h: c.height };
});

test('invite: an approved request with vip:true draws the dark VIP card, QR box still white', async ({ page }) => {
  await openInvite(page, { vip: true });
  const p = await cardPixels(page);
  expect(Math.max(...p.bg)).toBeLessThan(40);
  expect(p.badge[0]).toBeGreaterThan(150);
  expect(p.badge[2]).toBeLessThan(p.badge[0]);
  expect(Math.min(...p.qrBox)).toBeGreaterThan(240);
});

test('invite: an approved request without vip draws the normal light card', async ({ page }) => {
  await openInvite(page, {});
  const p = await cardPixels(page);
  expect(Math.max(...p.bg)).toBeGreaterThan(200);
  expect(Math.max(...p.badge)).toBeGreaterThan(200);
});

test('invite: when the request turns VIP (or stops being VIP) the next check re-renders the open card, both ways', async ({ page }) => {
  await openInvite(page, {});
  const set = (vip) => page.evaluate((vip) => {
    window.__fakeSupabase.requests.e1['REQ-TEST-0000000000000000001'].vip = vip;
    watchStatus();
  }, vip);
  await set(true);
  await expect.poll(async () => Math.max(...(await cardPixels(page)).bg)).toBeLessThan(40);
  await set(false);
  await expect.poll(async () => Math.max(...(await cardPixels(page)).bg)).toBeGreaterThan(200);
});

test('a fast double tap (قبول then قبول كـ VIP) on one request creates exactly one guest and one counter bump', async ({ page }) => {
  await openRequests(page, store([{ name: 'سارة' }]));
  await page.evaluate(() => { window.__fakeFirebase.txDelay = 800; });
  await page.evaluate(() => {
    document.querySelector('.approve-btn').click();
    document.querySelector('.vip-approve-btn').click();
    document.querySelector('.approve-btn').click();
  });
  await expect(page.locator('#toast')).toContainText('تمت الموافقة');
  await page.waitForTimeout(1500);
  const st = await page.evaluate(() => ({ g: Object.keys(window.__fakeFirebase.store['events/e1/guests']).length, c: window.__fakeFirebase.store.events.e1.guestCount }));
  expect(st.g).toBe(1);
  expect(st.c).toBe(1);
});

test('a request already approved elsewhere (another tab) is not approved twice: no second guest, no counter bump', async ({ page }) => {
  await openRequests(page, store([{ name: 'سارة' }]));
  await page.evaluate(() => { window.__fakeFirebase.store['events/e1/requests'].r0.status = 'approved'; });
  await page.locator('.approve-btn').first().click();
  await expect(page.locator('#toast')).toContainText('تمت الموافقة عليه مسبقًا');
  const st = await page.evaluate(() => ({ g: Object.keys(window.__fakeFirebase.store['events/e1/guests']).length, c: window.__fakeFirebase.store.events.e1.guestCount || 0 }));
  expect(st.g).toBe(0);
  expect(st.c).toBe(0);
});

test('invite: an older card build that finishes last cannot overwrite the card after vip flipped', async ({ page }) => {
  await openInvite(page, { vip: true });
  await page.evaluate(() => {
    const orig = window.buildInviteCard;
    window.buildInviteCard = (ev, g) => orig(ev, g).then((c) => new Promise((r) => setTimeout(() => r(c), g.vip ? 0 : 1500)));
  });
  const set = (vip) => page.evaluate((vip) => {
    window.__fakeSupabase.requests.e1['REQ-TEST-0000000000000000001'].vip = vip;
    watchStatus();
  }, vip);
  await set(false);
  await page.waitForTimeout(300);
  await set(true);
  await page.waitForTimeout(2500);
  const r = await page.evaluate(() => ({
    saved: cardCanvas.getContext('2d').getImageData(60, 700, 1, 1).data[0],
    shown: document.querySelector('#card-wrap img').src === cardCanvas.toDataURL('image/png'),
  }));
  expect(r.saved).toBeLessThan(40);
  expect(r.shown).toBe(true);
});
