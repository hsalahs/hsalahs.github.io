const { test, expect } = require('@playwright/test');
const { stubSupabase, seedInviteStore, seedEvent } = require('./helpers');

const fill = (n) => Array.from({ length: n }, (_, i) => ({ id: 'WD-F' + i, name: 'ضيف ' + (i + 1) }));

// What event e1 holds: pending requests (r0, r1, ...), guests, and event columns (the event is paid).
function store(reqs, guests, eventExtra) {
  return {
    event: { paid: true, ...eventExtra },
    guests: guests || [],
    requests: reqs.map((x, i) => ({ id: 'r' + i, created_at: '2026-01-01T00:00:00.000000+00:00', ...x })),
  };
}
async function openEvent(page, st) {
  await stubSupabase(page);
  await seedEvent(page, { user: { id: 'u1', email: 'customer@example.com' }, ...st });
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
  const s = window.__fakeSupabase;
  return { guests: s.doors.e1.guests, requests: s.requests.e1, opened: window.__opened };
});

test('a request row shows قبول, قبول كـ VIP and رفض', async ({ page }) => {
  await openRequests(page, store([{ name: 'سارة' }]));
  await expect(page.locator('.pending-item .approve-btn')).toContainText('قبول');
  await expect(page.locator('.pending-item .vip-approve-btn')).toContainText('قبول كـ VIP');
  await expect(page.locator('.pending-item .vip-approve-btn svg.ic')).toHaveCount(1);
  await expect(page.locator('.pending-item .reject-btn')).toContainText('رفض');
});

test('قبول كـ VIP makes the guest and the request VIP, and says so in the toast', async ({ page }) => {
  await openRequests(page, store([{ name: 'سارة' }]));
  await page.locator('.vip-approve-btn').click();
  await expect(page.locator('#toast')).toContainText('تمت الموافقة — سارة (VIP)');
  const st = await read(page);
  const guest = st.guests[0];
  expect(guest.vip).toBe(true);
  expect(st.requests.r0.status).toBe('approved');
  expect(st.requests.r0.vip).toBe(true);
  expect(st.requests.r0.guest_id).toBe(guest.id);
  expect((await page.evaluate(() => window.__fakeSupabase.calls.filter((c) => c.name === 'approve_requests').map((c) => c.args.p_items)))).toEqual([[{ req_id: 'r0', vip: true }]]);
});

test('plain قبول makes no VIP anywhere', async ({ page }) => {
  await openRequests(page, store([{ name: 'سارة' }]));
  await page.locator('.approve-btn').click();
  await expect(page.locator('#toast')).toContainText('تمت الموافقة — سارة');
  await expect(page.locator('#toast')).not.toContainText('VIP');
  const st = await read(page);
  expect(st.guests[0].vip).toBe(false);
  expect(st.requests.r0.vip).toBe(false);
});

test('at the free-guest limit both approve buttons open the payment prompt and approve nobody', async ({ page }) => {
  await openRequests(page, store([{ name: 'سارة' }, { name: 'خالد' }], fill(5), { paid: false }));
  await expect(page.locator('.vip-approve-btn')).toHaveCount(2);
  await page.locator('.approve-btn').first().click();
  await expect.poll(async () => (await read(page)).opened).toBe(1);
  await page.locator('.vip-approve-btn').first().click();
  await expect.poll(async () => (await read(page)).opened).toBe(2);
  const st = await read(page);
  expect(st.guests).toHaveLength(5);
  expect(st.requests.r0.status).toBe('pending');
});

test('while accepting all, the VIP buttons are disabled too; the bulk path adds no vip', async ({ page }) => {
  await openRequests(page, store([{ name: 'أ' }, { name: 'ب' }]));
  await expect(page.locator('.accept-all-hint')).toHaveText('أو اقبل وارفض كل طلب لحاله تحت — وتقدر تختار قبول كـ VIP');
  await page.evaluate(() => { window.__fakeSupabase.rpcDelay = { approve_requests: 1200 }; });
  await page.locator('.accept-all').click();
  await page.locator('#approve-all-modal').getByRole('button', { name: 'اقبل الكل' }).click();
  await expect(page.locator('.vip-approve-btn').first()).toBeDisabled();
  await expect(page.locator('#toast')).toContainText('تم قبول 2');
  const st = await read(page);
  expect(st.guests.some(g => g.vip)).toBe(false);
  expect(st.guests).toHaveLength(2);
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
  await openEvent(page, guestStore({ id: 'WD-1', name: 'سارة' }, [{ name: 'سارة', status: 'approved', guest_id: 'WD-1' }]));
  await toggleFirst(page, /تمييز كـ VIP/);
  await expect.poll(async () => (await read(page)).requests.r0.vip).toBe(true);
  expect((await read(page)).guests[0].vip).toBe(true);
  await toggleFirst(page, /إلغاء تمييز VIP/);
  await expect.poll(async () => (await read(page)).requests.r0.vip).toBe(false);
  expect((await read(page)).guests[0].vip).toBe(false);
});

test('marking VIP on a guest with no request link raises no error toast', async ({ page }) => {
  await openEvent(page, guestStore({ id: 'WD-1', name: 'أحمد' }));
  await toggleFirst(page, /تمييز كـ VIP/);
  await expect.poll(async () => (await read(page)).guests[0].vip).toBe(true);
  await expect(page.locator('#toast')).toContainText('صار VIP');
  await expect(page.locator('#toast')).not.toContainText('تعذّر');
  expect(Object.keys((await read(page)).requests)).toHaveLength(0);
});

test('VIP is one server call: the guest and the request change together, there is no second write to fail', async ({ page }) => {
  await openEvent(page, guestStore({ id: 'WD-1', name: 'سارة' }, [{ name: 'سارة', status: 'approved', guest_id: 'WD-1' }]));
  await toggleFirst(page, /تمييز كـ VIP/);
  await expect(page.locator('#toast')).toContainText('صار VIP');
  const names = await page.evaluate(() => window.__fakeSupabase.calls.filter((c) => !c.name.startsWith('from:')).map((c) => c.name));
  expect(names.filter((n) => n === 'set_guest')).toHaveLength(1);
  await expect(page.locator('#toast')).not.toContainText('تعذّر');
});

test('a failed VIP save shows the error and leaves the guest as it was', async ({ page }) => {
  await openEvent(page, { ...guestStore({ id: 'WD-1', name: 'سارة' }), fail: { set_guest: { error: 'network' } } });
  const alerts = [];
  page.on('dialog', (d) => { alerts.push(d.message()); d.accept(); });
  await toggleFirst(page, /تمييز كـ VIP/);
  await expect.poll(() => alerts.length).toBe(1);
  expect(alerts[0]).toContain('صار خطأ');
  expect((await read(page)).guests[0].vip).toBe(false);
  await expect(page.locator('.guest-item .vip-badge')).toHaveCount(0);
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

test('a fast double tap (قبول then قبول كـ VIP) on one request creates exactly one guest', async ({ page }) => {
  await openRequests(page, store([{ name: 'سارة' }]));
  await page.evaluate(() => { window.__fakeSupabase.rpcDelay = { approve_requests: 800 }; });
  await page.evaluate(() => {
    document.querySelector('.approve-btn').click();
    document.querySelector('.vip-approve-btn').click();
    document.querySelector('.approve-btn').click();
  });
  await expect(page.locator('#toast')).toContainText('تمت الموافقة');
  await page.waitForTimeout(1500);
  const st = await read(page);
  expect(st.guests).toHaveLength(1);
  expect(await page.evaluate(() => window.__fakeSupabase.calls.filter((c) => c.name === 'approve_requests').length)).toBe(1);
});

test('a request already approved elsewhere (another tab) is not approved twice: no second guest', async ({ page }) => {
  await openRequests(page, store([{ name: 'سارة' }]));
  await page.evaluate(() => { window.__fakeSupabase.requests.e1.r0.status = 'approved'; });
  await page.locator('.approve-btn').first().click();
  await expect(page.locator('#toast')).toContainText('تمت الموافقة عليه مسبقًا');
  const st = await read(page);
  expect(st.guests).toHaveLength(0);
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
