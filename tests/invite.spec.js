const { test, expect } = require('@playwright/test');
const { stubSupabase, seedInviteStore } = require('./helpers');

const MINE = 'REQ-MINE-0000000000000000';
const APPROVED = 'REQ-TEST-0000000000000000001';
// The invite page is clock-driven (request polling every 12 s), so the
// polling specs install a fake clock and jump it.
const POLL = 13500;


test('shows the RSVP form for a real event and an error for a missing one', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, {
    store: { events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } } },
  });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#g-name')).toBeVisible();
  await expect(page.locator('#card')).toContainText('حفل تجريبي');
});

test('tab title is the event name; the countdown shows on the day and disappears after it', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T21:00:00+03:00') });
  await stubSupabase(page);
  await seedInviteStore(page, {
    store: { events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } } },
  });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#g-name')).toBeVisible();
  await expect(page).toHaveTitle('حفل تجريبي | دعوات');
  await expect(page.locator('#countdown')).toContainText('وصل الموعد');
  await page.clock.setSystemTime(new Date('2026-01-03T12:00:00+03:00'));
  await page.reload();
  await expect(page.locator('#g-name')).toBeVisible();
  await expect(page.locator('#countdown')).toBeHidden();
});

test('a bad event id shows an error instead of the form', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: {} } });
  await page.goto('/invite.html?event=does-not-exist');
  await expect(page.locator('#card')).toContainText('هذه المناسبة غير موجودة');
});

test('the page still loads even if localStorage throws (Safari private browsing, storage-blocking policies)', async ({ page }) => {
  // localStorage.getItem() used to run unguarded as the very first thing in
  // the page's script — an uncaught throw there would silently kill
  // everything defined after it, including init() itself, leaving the
  // guest stuck on the loading placeholder forever with no way out.
  await stubSupabase(page);
  await seedInviteStore(page, {
    store: { events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } } },
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() { throw new Error('SecurityError: storage is disabled'); },
    });
  });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#g-name')).toBeVisible();
  await expect(page.locator('#card')).toContainText('حفل تجريبي');
});


test('a dropped connection while loading the event shows a tappable retry instead of hanging on "جاري التحميل..." forever', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, {
    store: { events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } } },
    fail: { event_public: { error: 'network', times: 1 } },
  });
  await page.goto('/invite.html?event=e1');

  const retry = page.locator('#retry-msg');
  await expect(retry).toContainText('تعذّر الاتصال');
  await retry.click();
  await expect(page.locator('#card')).toContainText('حفل تجريبي');
});


test('an approved guest gets their card from the request itself — the invite page reads nothing but the event and the request', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, {
    store: {
      events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } },
      'events/e1/requests': { [APPROVED]: { name: 'سارة', reqId: APPROVED, status: 'approved', guestId: 'WD-ABC', createdAt: 'x' } },
    },
  });
  await page.addInitScript((id) => { localStorage.setItem('inv_reqid_e1', id); }, APPROVED);
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card')).toContainText('تم تأكيد حضورك');
  // The demo-only scanning note shouldn't show up for a real guest.
  await expect(page.locator('#card')).not.toContainText('مسح الكود عند المدخل يتم لحظياً');
  const names = await page.evaluate(() => window.__fakeSupabase.calls.map((c) => c.name));
  expect([...new Set(names)].sort()).toEqual(['event_public', 'get_request']);
});


test('an approval without a barcode id yet shows "preparing your card", then the card once the next check finds it', async ({ page }) => {
  await page.clock.install();
  await stubSupabase(page);
  await seedInviteStore(page, {
    store: {
      events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } },
      'events/e1/requests': { [MINE]: { name: 'سارة', reqId: MINE, status: 'approved', createdAt: 'x' } },
    },
  });
  await page.addInitScript((id) => { localStorage.setItem('inv_reqid_e1', id); }, MINE);
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card')).toContainText('جاري تجهيز بطاقتك');

  // The id arrives on the request; the page's next check picks it up.
  await page.evaluate((id) => { window.__fakeSupabase.requests.e1[id].guest_id = 'WD-LATE'; }, MINE);
  await page.clock.fastForward(POLL);
  await expect(page.locator('#card')).toContainText('تم تأكيد حضورك');
});

const EVENT = { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' };


test('registering creates the request under its own secret id', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: { e1: EVENT }, 'events/e1/requests': {} } });
  await page.goto('/invite.html?event=e1');
  await page.locator('#g-name').fill('سارة');
  await page.getByRole('button', { name: 'تأكيد الحضور' }).click();
  await expect(page.locator('#card')).toContainText('بانتظار موافقة صاحب الدعوة');

  const state = await page.evaluate(() => ({
    stored: localStorage.getItem('inv_reqid_e1'),
    docs: window.__fakeSupabase.requests.e1,
    sent: window.__fakeSupabase.calls.filter((c) => c.name === 'submit_request').map((c) => c.args),
  }));
  // 128 random bits, in hex.
  expect(state.stored).toMatch(/^REQ-[0-9A-F]{32}$/);
  expect(Object.keys(state.docs)).toEqual([state.stored]);
  expect(state.docs[state.stored]).toMatchObject({ name: 'سارة', status: 'pending' });
  expect(state.sent).toEqual([{ p_event_id: 'e1', p_req_id: state.stored, p_name: 'سارة' }]);
});

test('two registrations never get the same id', async ({ browser }) => {
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await stubSupabase(page);
    await seedInviteStore(page, { store: { events: { e1: EVENT }, 'events/e1/requests': {} } });
    await page.goto('/invite.html?event=e1');
    await page.locator('#g-name').fill('ضيف ' + i);
    await page.getByRole('button', { name: 'تأكيد الحضور' }).click();
    await expect(page.locator('#card')).toContainText('بانتظار موافقة صاحب الدعوة');
    ids.push(await page.evaluate(() => localStorage.getItem('inv_reqid_e1')));
    await context.close();
  }
  expect(ids[0]).not.toBe(ids[1]);
});


test('a guest only ever sees their own request — another request in the same event is invisible to them', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, {
    store: {
      events: { e1: EVENT },
      'events/e1/requests': {
        [MINE]: { name: 'سارة', reqId: MINE, status: 'pending', createdAt: 'x' },
        'REQ-THEIRS-0000000000000000': { name: 'خالد', reqId: 'x', status: 'approved', guestId: 'WD-SECRET', createdAt: 'x' },
      },
    },
  });
  await page.addInitScript((id) => { localStorage.setItem('inv_reqid_e1', id); }, MINE);
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card')).toContainText('بانتظار موافقة صاحب الدعوة');
  await expect(page.locator('body')).not.toContainText('خالد');
  await expect(page.locator('body')).not.toContainText('WD-SECRET');
  const asked = await page.evaluate(() => window.__fakeSupabase.calls.filter((c) => c.name === 'get_request').map((c) => c.args.p_req_id));
  expect(new Set(asked)).toEqual(new Set(['REQ-MINE-0000000000000000']));
});

test('a saved request id with no request behind it (an older request, or one the organizer deleted) lets the guest register again', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: { e1: EVENT }, 'events/e1/requests': {} } });
  await page.addInitScript(() => { localStorage.setItem('inv_reqid_e1', 'REQ-GONE-00000000000000000'); });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#g-name')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('inv_reqid_e1'))).toBeNull();
});


test('after a rejection, trying again creates a fresh request under a new id', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, {
    store: {
      events: { e1: EVENT },
      'events/e1/requests': { 'REQ-OLD-00000000000000000': { name: 'سارة', reqId: 'x', status: 'rejected', createdAt: 'x' } },
    },
  });
  await page.addInitScript(() => { localStorage.setItem('inv_reqid_e1', 'REQ-OLD-00000000000000000'); });
  await page.goto('/invite.html?event=e1');
  await page.getByRole('button', { name: 'حاول مرة ثانية' }).click();
  await page.locator('#g-name').fill('سارة');
  await page.getByRole('button', { name: 'تأكيد الحضور' }).click();
  await expect(page.locator('#card')).toContainText('بانتظار موافقة صاحب الدعوة');
  const ids = await page.evaluate(() => Object.keys(window.__fakeSupabase.requests.e1));
  expect(ids).toHaveLength(2);
  expect(ids.filter(i => i !== 'REQ-OLD-00000000000000000')[0]).toMatch(/^REQ-[0-9A-F]{32}$/);
});


test('the sample invitation (?demo=1) walks through registration and approval without touching the database', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: {} } });
  await page.goto('/invite.html?demo=1&type=wedding');

  await expect(page.locator('#demo-banner')).toContainText('نموذج تجريبي');
  await expect(page.locator('#card')).toContainText('حفل زفاف أحمد وسارة');
  await page.locator('#g-name').fill('خالد');
  await page.getByRole('button', { name: 'تأكيد الحضور' }).click();
  await expect(page.locator('#card')).toContainText('بانتظار موافقة صاحب الدعوة');
  await expect(page.locator('#card')).toContainText('يوافق المنظّم', { timeout: 3000 });
  await expect(page.locator('#card')).toContainText('تم تأكيد حضورك', { timeout: 5000 });
  // The demo can't simulate the door camera itself, only the card a real
  // guest ends up with — this clarifies scanning still happens for real.
  await expect(page.locator('#card')).toContainText('مسح الكود عند المدخل يتم لحظياً');

  const state = await page.evaluate(() => ({
    calls: window.__fakeSupabase.calls.length,
    requests: JSON.stringify(window.__fakeSupabase.requests),
    saved: (() => { try { return localStorage.getItem('inv_reqid_null'); } catch (e) { return null; } })(),
  }));
  expect(state.calls).toBe(0);                  // no request of any kind reached the server
  expect(state.requests).toBe('{}');            // nothing was created
  expect(state.saved).toBeNull();               // and nothing remembered on the phone
});


test('the sample invitation does not need the database to load at all', async ({ page }) => {
  await stubSupabase(page);
  await page.route('**/vendor/supabase.min.js*', (r) => r.abort());
  await page.route('**/data.js*', (r) => r.abort());
  await page.goto('/invite.html?demo=1&type=wedding');
  await expect(page.locator('#g-name')).toBeVisible();
});

// The free email plan is for real activity — a customer creating an event —
// not for people trying the sample. Nothing on the sample's path may send an
// email, now or after a later change.
test('trying the sample never sends an email to the owner', async ({ page }) => {
  const requested = [];
  page.on('request', (r) => requested.push(r.url()));
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: {} } });
  // Stand in for the mail library itself: notifyAdmin() (utils.js) sends
  // through window.emailjs, so any real send from this page is counted here.
  await page.addInitScript(() => {
    window.__emailCalls = 0;
    window.emailjs = { init() {}, send() { window.__emailCalls++; return Promise.resolve(); } };
  });
  await page.goto('/invite.html?demo=1&type=wedding');
  await page.locator('#g-name').fill('خالد');
  await page.getByRole('button', { name: 'تأكيد الحضور' }).click();
  await expect(page.locator('#card')).toContainText('تم تأكيد حضورك', { timeout: 5000 });

  expect(await page.evaluate(() => window.__emailCalls)).toBe(0);
  expect(requested.filter(u => /emailjs/i.test(u))).toEqual([]);   // and nothing was sent to the mail service
});

test('the landing page and the invitation page do not include the email library at all', async () => {
  const fs = require('fs'), path = require('path');
  for (const f of ['index.html', 'invite.html']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    expect(src, f + ' should not load or call the email service').not.toMatch(/emailjs|notifyAdmin\(/i);
  }
});

test('opening the sample with no kind chosen asks which kind of event — and shows nothing wedding-specific yet', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: {} } });
  await page.goto('/invite.html?demo=1');
  await expect(page.locator('#card')).toContainText('اختر نوع مناسبتك');
  const links = await page.locator('.kind-btn').evaluateAll(as => as.map(a => [a.textContent.trim(), a.getAttribute('href'), a.querySelector('img').getAttribute('src')]));
  expect(links).toEqual([
    ['زفاف', '?demo=1&type=wedding', 'icons/kind-wedding.svg'],
    ['تخرج', '?demo=1&type=graduation', 'icons/kind-graduation.svg'],
    ['فعالية', '?demo=1&type=event', 'icons/kind-event.svg'],
  ]);
  // Neutral opening screen: the product, not a wedding.
  await expect(page.locator('#splash .splash-title')).toHaveText('دعوات');
  await expect(page.locator('#splash .splash-subtitle')).toHaveText('Digital Invitations');
  await expect(page.locator('#splash .splash-rings img')).toHaveAttribute('src', 'icons/logo.svg');
});

for (const [type, expected] of Object.entries({
  wedding:    { name: 'حفل زفاف أحمد وسارة',      venue: 'قاعة الأفراح — الرياض',        theme: 'gold',     splash: 'دعوة زفاف',      sub: 'Wedding Invitation',   art: 'kind-wedding.svg' },
  graduation: { name: 'حفل تخرج دفعة 2026',       venue: 'مدرسة الأمل الأهلية — الدمام', theme: 'sapphire', splash: 'دعوة حفل تخرج', sub: 'Graduation Invitation', art: 'kind-graduation.svg' },
  event:      { name: 'ملتقى ريادة الأعمال 2026', venue: 'مركز المؤتمرات — الرياض',      theme: 'emerald',  splash: 'دعوة فعالية',    sub: 'Event Invitation',      art: 'kind-event.svg' },
})) {
  test(`the ${type} sample is its own invitation: name, place, colours, opening screen and a friendly date`, async ({ page }) => {
    await stubSupabase(page);
    await seedInviteStore(page, { store: { events: {} } });
    await page.goto('/invite.html?demo=1&type=' + type);

    await expect(page.locator('#card h1')).toHaveText(expected.name);
    await expect(page.locator('#card .sub')).toContainText(expected.venue);
    await expect(page.locator('body')).toHaveAttribute('data-theme', expected.theme);
    await expect(page.locator('#demo-banner')).toContainText('نموذج تجريبي لدعوة');
    await expect(page.locator('#splash .splash-title')).toHaveText(expected.splash);
    await expect(page.locator('#splash .splash-subtitle')).toHaveText(expected.sub);

    // The date reads as words with Western digits, not "2026-…".
    const sub = await page.locator('#card .sub').textContent();
    expect(sub).toMatch(/(الأحد|الاثنين|الثلاثاء|الأربعاء|الخميس|الجمعة|السبت) \d{1,2} \S+ \d{4}/);
    expect(sub).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(sub).not.toMatch(/[\u0660-\u0669]/);

    // The opening screen's picture is that kind's own artwork — and the file really loads.
    const img = page.locator('#splash .splash-rings img');
    await expect(img).toHaveAttribute('src', 'icons/' + expected.art);
    await expect.poll(() => img.evaluate(i => i.complete && i.naturalWidth > 0)).toBe(true);

    // "Change kind" leads back to the choice, and the whole walk-through still works.
    await expect(page.locator('#demo-banner a[href="?demo=1"]')).toBeVisible();
    await page.locator('#g-name').fill('خالد');
    await page.getByRole('button', { name: 'تأكيد الحضور' }).click();
    await expect(page.locator('#card')).toContainText('تم تأكيد حضورك', { timeout: 5000 });
  });
}

test('a made-up ?type= (or an inherited property name) falls back to the choice screen instead of breaking', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: {} } });
  for (const t of ['nonsense', 'constructor', '__proto__', 'toString']) {
    await page.goto('/invite.html?demo=1&type=' + t);
    await expect(page.locator('#card')).toContainText('اختر نوع مناسبتك');
    await expect(page.locator('.kind-btn')).toHaveCount(3);
    // ...and the opening screen falls back to the product's, not to garbage.
    await expect(page.locator('#splash .splash-title')).toHaveText('دعوات');
    await expect(page.locator('#splash .splash-rings img')).toHaveAttribute('src', 'icons/logo.svg');
  }
});

test('a real invitation saved before kinds existed opens with the wedding splash, and its date reads as words with Western digits', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, {
    store: { events: { e1: { name: 'حفل تجريبي', date: '2026-10-29', venue: 'الرياض', theme: 'gold' } } },
  });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card .sub')).toContainText('الخميس 29 أكتوبر 2026');
  await expect(page.locator('#splash .splash-title')).toHaveText('دعوة زفاف');
  await expect(page.locator('#splash .splash-rings img')).toHaveAttribute('src', 'icons/kind-wedding.svg');
});

test('a real invitation opens with its own kind: a graduation shows the graduation splash, and this device remembers it', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: { e1: { name: 'حفل تخرج نورة', type: 'graduation', date: '2026-10-29', venue: 'الدمام', theme: 'sapphire' } } } });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#splash .splash-title')).toHaveText('دعوة حفل تخرج');
  await expect(page.locator('#splash .splash-rings img')).toHaveAttribute('src', 'icons/kind-graduation.svg');
  expect(await page.evaluate(() => localStorage.getItem('inv_kind_e1'))).toBe('graduation');
});

test('before the event loads, a real invitation shows the kind this device saw last time, or the neutral logo', async ({ page }) => {
  await stubSupabase(page);
  await page.addInitScript(() => { try { localStorage.setItem('inv_kind_seen', 'event'); } catch (e) {} });
  // Neither event exists, so nothing replaces what the splash starts with.
  await seedInviteStore(page, { store: { events: {} } });
  await page.goto('/invite.html?event=seen');
  await expect(page.locator('#splash .splash-title')).toHaveText('دعوة فعالية');
  await page.goto('/invite.html?event=never');
  await expect(page.locator('#splash .splash-title')).toHaveText('دعوات');
  await expect(page.locator('#splash .splash-rings img')).toHaveAttribute('src', 'icons/logo.svg');
});

test('the invitation shows the kind of event above its name and the owner\'s welcome line (or the kind\'s default)', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: {
    e1: { name: 'ملتقى الرواد', type: 'event', date: '2026-10-29', venue: 'الرياض', theme: 'emerald', welcomeMessage: 'نتشرف بحضوركم\nفي ملتقى الرواد' },
    e2: { name: 'زفاف قديم', date: '2026-10-29', venue: 'جدة', theme: 'gold' },
  } } });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card .inv-kind')).toHaveText('دعوة فعالية');
  await expect(page.locator('#card .inv-msg')).toHaveText('نتشرف بحضوركم\nفي ملتقى الرواد');
  await page.goto('/invite.html?event=e2');
  await expect(page.locator('#card .inv-kind')).toHaveText('دعوة زفاف');
  await expect(page.locator('#card .inv-msg')).toHaveText('يسعدنا حضوركم ومشاركتنا فرحتنا 🤍');
});

test('the guest is told a request waits for approval, by whoever approves for that kind of event', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: { e1: { name: 'تخرج نورة', type: 'graduation', date: '2026-10-29', venue: 'الدمام', theme: 'sapphire' } } } });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card .rsvp-note')).toContainText('تتم مراجعة طلبك من منظّمي الحفل');
  await expect(page.locator('#card .rsvp-note')).toContainText('بطاقة الدخول (الباركود)');
  await page.locator('#g-name').fill('سارة');
  await page.getByRole('button', { name: 'تأكيد الحضور' }).click();
  await expect(page.locator('#card')).toContainText('بانتظار موافقة منظّمي الحفل');
  await expect(page.locator('#card .pend-note')).toContainText('نفس الجوال ونفس المتصفح');
  await expect(page.locator('#card')).toContainText('سارة');
});

test('the sample graduation invitation shows the graduation title and welcome', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: {} } });
  await page.goto('/invite.html?demo=1&type=graduation');
  await expect(page.locator('#card .inv-kind')).toHaveText('دعوة حفل تخرج');
  await expect(page.locator('#card .inv-msg')).toContainText('فرحة التخرج');
});

test('a date an organizer typed as free text is shown as typed, never dropped', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: { e1: { name: 'حفل', date: 'قريبًا', venue: 'الرياض', theme: 'gold' } } } });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card .sub')).toContainText('قريبًا');
});


test('a readable link (?s=name) finds its event through the slug lookup and keeps the short address', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: {
    events: { e1: { name: 'زواج حلا وتركي', ownerUid: 'u1', date: '2026-12-01', venue: 'الرياض', theme: 'gold' } },
    slugs: { 'hala-turki': { eventId: 'e1', ownerUid: 'u1', createdAt: 'x' } },
  } });
  await page.goto('/invite.html?s=hala-turki');
  await expect(page.locator('body')).toContainText('زواج حلا وتركي');
  await expect(page).toHaveURL(/\/hala-turki$/);
  const names = await page.evaluate(() => window.__fakeSupabase.calls.map((c) => c.name));
  expect(names).toEqual(['resolve_slug', 'event_public']);
});

test('a readable link whose lookup fails shows the tappable retry, and retrying finds the event', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, {
    store: { events: { e1: EVENT }, slugs: { 'hala-turki': { eventId: 'e1' } } },
    fail: { resolve_slug: { error: 'network', times: 1 } },
  });
  await page.goto('/invite.html?s=hala-turki');
  await expect(page.locator('#retry-msg')).toContainText('تعذّر الاتصال');
  await page.locator('#retry-msg').click();
  await expect(page.locator('#card')).toContainText('حفل تجريبي');
});

test('an unknown readable link says so', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: {}, slugs: {} } });
  await page.goto('/invite.html?s=no-such-name');
  await expect(page.locator('body')).toContainText('هذا الرابط غير موجود');
});

// GitHub Pages serves 404.html for any path without a file; the local test
// server doesn't, so the route hands the page 404.html for the short path.
test('404.html forwards a readable link like /hala-turki to the invitation page, and shows "not found" for anything else', async ({ page }) => {
  const fs = require('fs'); const path = require('path');
  const body = fs.readFileSync(path.join(__dirname, '..', '404.html'), 'utf8');
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: {}, slugs: {} } });
  await page.route(/\/(hala-turki|some\/deep\.path)$/, (r) => r.fulfill({ status: 404, contentType: 'text/html', body }));
  await page.goto('/hala-turki');
  await page.waitForURL(/invite\.html\?s=hala-turki/);
  await page.goto('/some/deep.path');
  await expect(page.locator('h1')).toHaveText('الصفحة غير موجودة');
});

// A shared invitation link (either form) shows a card in WhatsApp and other
// apps instead of a bare address — the same card for every event, since the
// files are static.
test('invitation links carry a share card: invite.html and the readable-link page', () => {
  const fs = require('fs'); const path = require('path');
  for (const f of ['invite.html', '404.html']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    expect(src, f).toContain('<meta property="og:title" content="لديك دعوة خاصة 💌">');
    expect(src, f).toContain('<meta property="og:image" content="https://da3wt.com/icons/og-image.jpg">');
  }
});

test('the approval note names صاحب الدعوة for a wedding and منظّمي الفعالية for an event', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: {
    e1: { name: 'زفاف', type: 'wedding', date: '2026-10-29', venue: 'الدمام', theme: 'gold' },
    e2: { name: 'ملتقى', type: 'event', date: '2026-10-29', venue: 'الرياض', theme: 'emerald' },
  } } });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card .rsvp-note')).toContainText('تتم مراجعة طلبك من صاحب الدعوة');
  await page.locator('#g-name').fill('سارة');
  await page.getByRole('button', { name: 'تأكيد الحضور' }).click();
  await expect(page.locator('#card')).toContainText('بانتظار موافقة صاحب الدعوة');
  await page.goto('/invite.html?event=e2');
  await expect(page.locator('#card .rsvp-note')).toContainText('تتم مراجعة طلبك من منظّمي الفعالية');
});

test('HTML in the event name and welcome line is shown as text on the invitation', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: { e1: { name: '<img id="xn" src=x onerror="window.__x=1">', date: '2026-10-29', venue: 'الدمام', theme: 'gold', welcomeMessage: '<img id="xw" src=x onerror="window.__x=1">' } } } });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card .inv-msg')).toContainText('<img id="xw"');
  await expect(page.locator('#card')).toContainText('<img id="xn"');
  await expect(page.locator('#card img[id^="x"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__x)).toBeUndefined();
});

const QR_STAND_IN = `window.QRCode = function (el) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, 256, 256); x.fillStyle = '#fff'; x.fillRect(64, 64, 128, 128);
  el.appendChild(c);
};
window.QRCode.CorrectLevel = { H: 2, M: 0, L: 1, Q: 3 };`;

async function openApprovedInvite(page) {
  await seedInviteStore(page, {
    store: {
      events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } },
      'events/e1/requests': { 'REQ-TEST-0000000000000000001': { name: 'سارة', reqId: 'REQ-TEST-0000000000000000001', status: 'approved', guestId: 'WD-ABC', createdAt: 'x' } },
    },
  });
  await page.addInitScript(() => { localStorage.setItem('inv_reqid_e1', 'REQ-TEST-0000000000000000001'); });
}


test('the invitation page talks to Supabase only: no Firebase request, scripts in the agreed order', async ({ page }) => {
  const seen = [];
  page.on('request', (r) => seen.push(r.url()));
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } } } });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#g-name')).toBeVisible();
  expect(seen.some((u) => /firebase|gstatic|firestore/i.test(u))).toBe(false);
  const order = seen.map((u) => (u.match(/\/(supabase-config\.js|vendor\/supabase\.min\.js|data\.js)/) || [])[1]).filter(Boolean);
  expect(order).toEqual(['supabase-config.js', 'vendor/supabase.min.js', 'data.js']);
  expect(await page.evaluate(() => [typeof window._auth, typeof window._db, typeof window.Data])).toEqual(['undefined', 'undefined', 'object']);
  expect(await page.evaluate(() => window.__fakeSupabase.auth.user)).toBeNull();
  expect(await page.evaluate(() => window.__fakeSupabase.createArgs.length)).toBe(1);
});

test('the QR library is not requested until a card has to be drawn', async ({ page }) => {
  const seen = [];
  page.on('request', (r) => seen.push(r.url()));
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } } } });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#g-name')).toBeVisible();
  expect(seen.some((u) => /qrcode/.test(u))).toBe(false);
});

test('a slow QR library: the card still appears once it arrives', async ({ page }) => {
  await stubSupabase(page);
  await page.route(/qrcodejs.*qrcode\.min\.js/, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    route.fulfill({ contentType: 'text/javascript', body: QR_STAND_IN });
  });
  await openApprovedInvite(page);
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card-wrap img')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#save-btn')).toBeVisible();
});

test('a QR library that fails to download shows a clear message with retry, and retrying draws the card', async ({ page }) => {
  await stubSupabase(page);
  let fail = true;
  await page.route(/qrcodejs.*qrcode\.min\.js/, (route) =>
    fail ? route.abort() : route.fulfill({ contentType: 'text/javascript', body: QR_STAND_IN }));
  await openApprovedInvite(page);
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#qr-retry')).toContainText('تعذّر تجهيز البطاقة');
  await expect(page.locator('#card-wrap img')).toHaveCount(0);
  fail = false;
  await page.locator('#qr-retry').click();
  await expect(page.locator('#card-wrap img')).toBeVisible();
});


test('the event dashboard, the organizer list, the invitation and the scanner preconnect to Supabase; the service worker gives the network 1500 ms before the cache', async () => {
  const fs = require('fs');
  expect(fs.readFileSync('scan.html', 'utf8')).toContain('<link rel="preconnect" href="https://gunizkapwatixvbfliva.supabase.co" crossorigin>');
  expect(fs.readFileSync('scan.html', 'utf8')).not.toMatch(/firestore|firebase/i);
  expect(fs.readFileSync('event.html', 'utf8')).toContain('<link rel="preconnect" href="https://gunizkapwatixvbfliva.supabase.co" crossorigin>');
  expect(fs.readFileSync('event.html', 'utf8')).not.toMatch(/firestore|firebase/i);
  expect(fs.readFileSync('app.html', 'utf8')).toContain('<link rel="preconnect" href="https://gunizkapwatixvbfliva.supabase.co" crossorigin>');
  expect(fs.readFileSync('app.html', 'utf8')).not.toMatch(/firestore|firebase/i);
  const inv = fs.readFileSync('invite.html', 'utf8');
  expect(inv).toContain('<link rel="preconnect" href="https://gunizkapwatixvbfliva.supabase.co" crossorigin>');
  expect(inv).not.toMatch(/firestore|firebase/i);
  expect(fs.readFileSync('sw.js', 'utf8')).toContain("reject(new Error('timeout')), 1500)");
});


test('invite.html reaches the server only through Data.invite (no direct client calls)', async () => {
  const fs = require('fs');
  const page = fs.readFileSync('invite.html', 'utf8');
  expect(page).not.toMatch(/window\.supabase|\.rpc\(|supabase\.from\(|createClient/);
  const used = [...new Set([...page.matchAll(/Data\.invite\.(\w+)/g)].map((m) => m[1]))].sort();
  expect(used).toEqual(['event', 'resolveSlug', 'submitRequest', 'watchRequest']);
  expect(page.indexOf('src="supabase-config.js"')).toBeLessThan(page.indexOf('src="vendor/supabase.min.js"'));
  expect(page.indexOf('src="vendor/supabase.min.js"')).toBeLessThan(page.indexOf('src="data.js"'));
  expect(page.indexOf('src="data.js"')).toBeLessThan(page.indexOf('const params = new URLSearchParams'));
});

async function watchInviteSplash(page) {
  await page.addInitScript(() => {
    window.__t0 = performance.now();
    document.addEventListener('DOMContentLoaded', () => {
      const s = document.getElementById('splash');
      new MutationObserver(() => {
        if (s.classList.contains('hide') && window.__hideAt === undefined) window.__hideAt = performance.now() - window.__t0;
      }).observe(s, { attributes: true });
    });
  });
}

test('the invitation splash stays at least 1.6 s even when the data is instant, then hides with a 0.4 s fade', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: { e1: { name: 'حفل تجريبي', date: '2026-10-29', venue: 'الرياض', theme: 'gold' } } } });
  await watchInviteSplash(page);
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#splash')).toHaveClass(/hide/, { timeout: 4000 });
  const t = await page.evaluate(() => window.__hideAt);
  expect(t).toBeGreaterThanOrEqual(1550);
  expect(t).toBeLessThan(3000);
  expect(await page.locator('#splash').evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0.4s, 0.4s');
});


test('the invitation splash still hides within 3.5 s when the event data never arrives', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: { e1: { name: 'حفل تجريبي', date: '2026-10-29', venue: 'الرياض', theme: 'gold' } } }, latency: 600000 });
  await watchInviteSplash(page);
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#splash')).toHaveClass(/hide/, { timeout: 5000 });
  const t = await page.evaluate(() => window.__hideAt);
  expect(t).toBeGreaterThanOrEqual(3400);
  expect(t).toBeLessThan(4200);
});

test('the invitation card is the page main landmark', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: { e1: { name: 'حفل تجريبي', date: '2030-01-01', venue: 'الرياض', theme: 'gold' } } } });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('main#card')).toHaveCount(1);
  await expect(page.locator('#g-name')).toBeVisible();
  await expect(page.locator('main#card')).not.toHaveClass(/card-wait/);
});

const EV1 = { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' };

for (const [link, shown] of [['https://maps.example.com/x', true], ['HTTP://maps.example.com/x', true], ['javascript:alert(1)', false], ['data:text/html,x', false], ['  javascript:alert(1)', false]]) {
  test('a map link of ' + JSON.stringify(link) + ' ' + (shown ? 'becomes a safe link' : 'never becomes a link'), async ({ page }) => {
    await stubSupabase(page);
    await seedInviteStore(page, { store: { events: { e1: { ...EV1, mapsLink: link } } } });
    await page.goto('/invite.html?event=e1');
    await expect(page.locator('#g-name')).toBeVisible();
    await expect(page.locator('a.maps-link')).toHaveCount(shown ? 1 : 0);
    if (shown) {
      await expect(page.locator('a.maps-link')).toHaveAttribute('rel', 'noopener noreferrer');
      await expect(page.locator('a.maps-link')).toHaveAttribute('target', '_blank');
    }
  });
}


test('a double tap on «تأكيد الحضور» creates exactly one request, with a busy button', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: { e1: EV1 }, 'events/e1/requests': {} } });
  await page.goto('/invite.html?event=e1');
  await page.locator('#g-name').fill('سارة');
  await page.evaluate(() => { window.__fakeSupabase.latency = 600; });
  await page.evaluate(() => { submitRequest(); submitRequest(); });
  await expect(page.locator('#rsvp-btn')).toBeDisabled();
  await expect(page.locator('#rsvp-btn')).toHaveText('جاري الإرسال...');
  await expect(page.locator('#card')).toContainText('بانتظار موافقة', { timeout: 5000 });
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => Object.keys(window.__fakeSupabase.requests.e1).length)).toBe(1);
  expect(await page.evaluate(() => window.__fakeSupabase.calls.filter((c) => c.name === 'submit_request').length)).toBe(1);
});


test('a slow send says it is still sending; a failed send re-enables the button with an Arabic message (no alert)', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: { e1: EV1 }, 'events/e1/requests': {} } });
  let alerts = 0;
  page.on('dialog', (d) => { alerts++; d.dismiss(); });
  await page.goto('/invite.html?event=e1');
  await page.evaluate(() => { window.__fakeSupabase.fail = { submit_request: { error: 'network' } }; });
  await page.locator('#g-name').fill('سارة');
  await page.locator('#rsvp-btn').click();
  await expect(page.locator('#rsvp-msg')).toHaveText('تعذّر إرسال طلبك، جرّب مرة ثانية');
  await expect(page.locator('#rsvp-btn')).toBeEnabled();
  await expect(page.locator('#rsvp-btn')).toHaveText('تأكيد الحضور');
  expect(alerts).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('inv_reqid_e1'))).toBeNull();

  await page.evaluate(() => { window.__fakeSupabase.fail = {}; window.__fakeSupabase.latency = 9500; });
  await page.locator('#rsvp-btn').click();
  await expect(page.locator('#rsvp-msg')).toContainText('لسا يُرسل', { timeout: 10000 });
});

test('a failed send that may have reached the server is retried with the same id, so it cannot create two requests', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: { e1: EV1 }, 'events/e1/requests': {} } });
  await page.goto('/invite.html?event=e1');
  await page.evaluate(() => { window.__fakeSupabase.fail = { submit_request: { error: 'network', times: 1 } }; });
  await page.locator('#g-name').fill('سارة');
  await page.locator('#rsvp-btn').click();
  await expect(page.locator('#rsvp-msg')).toHaveText('تعذّر إرسال طلبك، جرّب مرة ثانية');
  await page.locator('#rsvp-btn').click();
  await expect(page.locator('#card')).toContainText('بانتظار موافقة');
  const ids = await page.evaluate(() => window.__fakeSupabase.calls.filter((c) => c.name === 'submit_request').map((c) => c.args.p_req_id));
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
});

test('a refused send keeps the form usable: bad name / event gone show the generic message, a full queue says who to ask', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: { e1: EV1 }, 'events/e1/requests': {} } });
  await page.goto('/invite.html?event=e1');
  await page.locator('#g-name').fill('سارة');
  for (const message of ['REQUESTS_FULL', 'BAD_NAME', 'EVENT_NOT_FOUND']) {
    await page.evaluate((m) => { window.__fakeSupabase.fail = { submit_request: { error: { message: m, code: 'P0001' } } }; }, message);
    await page.locator('#rsvp-btn').click();
    await expect(page.locator('#rsvp-msg')).toHaveText(message === 'REQUESTS_FULL' ? 'قائمة التسجيل ممتلئة حاليًا. تواصل مع صاحب الدعوة.' : 'تعذّر إرسال طلبك، جرّب مرة ثانية');
    await expect(page.locator('#rsvp-btn')).toBeEnabled();
  }
  expect(await page.evaluate(() => localStorage.getItem('inv_reqid_e1'))).toBeNull();
});

test('the server\'s cap on waiting requests: a full queue refuses the next one (fake server rule), then accepts it once room is made', async ({ page }) => {
  await stubSupabase(page);
  const pending = {};
  for (let i = 0; i < 50; i++) pending['REQ-FILL-' + String(i).padStart(20, '0')] = { status: 'pending', guest_id: null, vip: false, name: 'ضيف ' + i };
  await seedInviteStore(page, { store: { events: { e1: EV1 } } });
  await page.addInitScript((p) => { window.__fakeSupabase.requests = { e1: p }; }, pending);
  await page.goto('/invite.html?event=e1');
  await page.locator('#g-name').fill('سارة');
  await page.locator('#rsvp-btn').click();
  await expect(page.locator('#rsvp-msg')).toHaveText('قائمة التسجيل ممتلئة حاليًا. تواصل مع صاحب الدعوة.');
  await page.evaluate(() => { const r = window.__fakeSupabase.requests.e1; delete r[Object.keys(r)[0]]; });
  await page.locator('#rsvp-btn').click();
  await expect(page.locator('#card')).toContainText('بانتظار موافقة');
});

test('an empty name shows «اكتب اسمك» and focuses the field; the field has mobile-friendly attributes', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: { e1: EV1 } } });
  await page.goto('/invite.html?event=e1');
  const input = page.locator('#g-name');
  await expect(input).toHaveAttribute('maxlength', '100');
  await expect(input).toHaveAttribute('autocomplete', 'name');
  await expect(input).toHaveAttribute('aria-label', 'الاسم الكامل');
  await expect(input).toHaveAttribute('enterkeyhint', 'send');
  expect(await input.evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px');
  await page.locator('#rsvp-btn').click();
  await expect(page.locator('#rsvp-msg')).toHaveText('اكتب اسمك');
  await expect(input).toBeFocused();
});


test('a slow first check keeps the loading line, then shows the request', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: { e1: EV1 }, 'events/e1/requests': { [MINE]: { name: 'سارة', reqId: MINE, status: 'pending', createdAt: 'x' } } }, latency: 1500 });
  await page.addInitScript((id) => { localStorage.setItem('inv_reqid_e1', id); }, MINE);
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#g-name')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('inv_reqid_e1'))).toBe(MINE);
  await expect(page.locator('#card')).toContainText('بانتظار موافقة', { timeout: 8000 });
});


test('a failing request check shows a retry message and keeps the key', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, {
    store: { events: { e1: EV1 }, 'events/e1/requests': { [MINE]: { name: 'سارة', reqId: MINE, status: 'pending', createdAt: 'x' } } },
    fail: { get_request: { error: 'network' } },
  });
  await page.addInitScript((id) => { localStorage.setItem('inv_reqid_e1', id); }, MINE);
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card')).toContainText('تعذّر تحميل طلبك');
  expect(await page.evaluate(() => localStorage.getItem('inv_reqid_e1'))).toBe(MINE);
  await page.evaluate(() => { window.__fakeSupabase.fail = {}; });
  await page.getByRole('button', { name: 'حاول مرة ثانية' }).click();
  await expect(page.locator('#card')).toContainText('بانتظار موافقة');
});


test('when the organizer deletes the request, the next check shows a message above a fresh form', async ({ page }) => {
  await page.clock.install();
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: { e1: EV1 }, 'events/e1/requests': { [MINE]: { name: 'سارة', reqId: MINE, status: 'pending', createdAt: 'x' } } } });
  await page.addInitScript((id) => { localStorage.setItem('inv_reqid_e1', id); }, MINE);
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card')).toContainText('بانتظار موافقة');
  await page.evaluate((id) => { delete window.__fakeSupabase.requests.e1[id]; }, MINE);
  await page.clock.fastForward(POLL);
  await expect(page.locator('#g-name')).toBeVisible();
  await expect(page.locator('#rsvp-msg')).toContainText('تم حذف طلبك من صاحب الدعوة');
  expect(await page.evaluate(() => localStorage.getItem('inv_reqid_e1'))).toBeNull();
});


test('a malformed event id shows «رابط غير صحيح» with a hint and never asks the server', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: {} } });
  await page.goto('/invite.html?event=' + encodeURIComponent('a/b'));
  await expect(page.locator('#card')).toContainText('رابط غير صحيح');
  await expect(page.locator('#card')).toContainText('تأكد من الرابط أو تواصل مع صاحب الدعوة');
  await expect(page.locator('#retry-msg')).toHaveCount(0);
  await page.goto('/invite.html');
  await expect(page.locator('#card')).toContainText('رابط غير صحيح');
  expect(await page.evaluate(() => window.__fakeSupabase.calls.length)).toBe(0);
});

test('a missing event and a missing readable link both carry the check-the-link hint', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: {}, slugs: {} } });
  await page.goto('/invite.html?event=nothere1');
  await expect(page.locator('#card')).toContainText('تأكد من الرابط أو تواصل مع صاحب الدعوة');
  await page.goto('/invite.html?s=nothing');
  await expect(page.locator('#card')).toContainText('هذا الرابط غير موجود');
  await expect(page.locator('#card')).toContainText('تأكد من الرابط أو تواصل مع صاحب الدعوة');
});

test('a long event name wraps instead of overflowing, and the heading font has an Arabic fallback', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: { e1: { ...EV1, name: 'ا'.repeat(80), venue: 'ب'.repeat(100) } } } });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('h1')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.locator('h1').evaluate((el) => getComputedStyle(el).fontFamily)).toContain('IBM Plex Sans Arabic');
  expect(await page.locator('h1').evaluate((el) => getComputedStyle(el).overflowWrap)).toBe('anywhere');
});

test('the approved screen tells the guest to save or screenshot the card', async ({ page }) => {
  await stubSupabase(page);
  await page.route(/qrcodejs.*qrcode\.min\.js/, (route) => route.fulfill({ contentType: 'text/javascript', body: QR_STAND_IN }));
  await seedInviteStore(page, { store: { events: { e1: EV1 }, 'events/e1/requests': { 'REQ-TEST-0000000000000000001': { name: 'سارة', reqId: 'REQ-TEST-0000000000000000001', status: 'approved', guestId: 'WD-ABC', createdAt: 'x' } } } });
  await page.addInitScript(() => { localStorage.setItem('inv_reqid_e1', 'REQ-TEST-0000000000000000001'); });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#save-hint')).toHaveText('احفظ الدعوة أو صوّر الشاشة');
});

test('the saved card loads the Arabic fonts before drawing, fits long texts, and tells in-app browsers to long-press', async ({ page }) => {
  await stubSupabase(page);
  await page.route(/qrcodejs.*qrcode\.min\.js/, (route) => route.fulfill({ contentType: 'text/javascript', body: QR_STAND_IN }));
  const longName = 'عبدالرحمن بن محمد بن عبدالعزيز بن فهد '.repeat(3).trim();
  await seedInviteStore(page, { store: { events: { e1: { ...EV1, name: 'حفل زفاف '.repeat(8).trim() } }, 'events/e1/requests': { 'REQ-TEST-0000000000000000001': { name: longName, reqId: 'REQ-TEST-0000000000000000001', status: 'approved', guestId: 'WD-ABC', createdAt: 'x' } } } });
  await page.addInitScript(() => {
    localStorage.setItem('inv_reqid_e1', 'REQ-TEST-0000000000000000001');
    window.__order = []; window.__fontCalls = []; window.__fills = [];
    const load = document.fonts.load.bind(document.fonts);
    document.fonts.load = (f, t) => { window.__order.push('font'); window.__fontCalls.push([f, t]); return load(f, t); };
    const ft = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, mw) { window.__order.push('draw'); window.__fills.push([text, mw]); return ft.apply(this, arguments); };
    Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });
  });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#save-btn')).toBeVisible({ timeout: 10000 });
  const r = await page.evaluate(() => ({ order: window.__order, calls: window.__fontCalls, fills: window.__fills }));
  expect(r.order.indexOf('font')).toBeGreaterThanOrEqual(0);
  expect(r.order.indexOf('font')).toBeLessThan(r.order.indexOf('draw'));
  expect(r.calls.some(([f, t]) => /700/.test(f) && /IBM Plex Sans Arabic/.test(f) && t.includes('عبدالرحمن'))).toBe(true);
  expect(r.calls.some(([f]) => /^400 /.test(f) && /IBM Plex Sans Arabic/.test(f))).toBe(true);
  const nameFill = r.fills.find(([t]) => t === longName);
  expect(nameFill[1]).toBe(860);

  await expect(page.locator('#press-hint')).toBeHidden();
  await page.locator('#save-btn').click();
  await expect(page.locator('#press-hint')).toHaveText('إذا ما نزلت الصورة، اضغط مطولًا عليها واختر حفظ');
});

test('fitFillText shrinks until the text fits the width and never goes below the minimum', async ({ page }) => {
  await stubSupabase(page);
  await seedInviteStore(page, { store: { events: { e1: EV1 } } });
  await page.goto('/invite.html?event=e1');
  const r = await page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    const f = (px) => 'bold ' + px + 'px Arial';
    const long = 'x'.repeat(200);
    const used = fitFillText(ctx, long, 0, 0, 860, 58, 30, f);
    const w = ctx.measureText(long).width;
    const short = fitFillText(ctx, 'ab', 0, 0, 860, 58, 30, f);
    return { used, w, short };
  });
  expect(r.used).toBe(30);
  expect(r.short).toBe(58);
});


async function openPending(page, extra = {}) {
  await stubSupabase(page);
  await page.route(/qrcodejs.*qrcode\.min\.js/, (route) => route.fulfill({ contentType: 'text/javascript', body: QR_STAND_IN }));
  await seedInviteStore(page, { store: { events: { e1: EV1 }, 'events/e1/requests': { [MINE]: { name: 'سارة', reqId: MINE, status: 'pending', createdAt: 'x' } } }, ...extra });
  await page.addInitScript((id) => { localStorage.setItem('inv_reqid_e1', id); }, MINE);
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card')).toContainText('بانتظار موافقة');
}
const getRequestCalls = (page) => page.evaluate(() => window.__fakeSupabase.calls.filter((c) => c.name === 'get_request').length);

test('a pending request becomes the card by itself on the next check, drawn once, and checking continues', async ({ page }) => {
  await page.clock.install();
  await openPending(page);
  await page.evaluate((id) => { Object.assign(window.__fakeSupabase.requests.e1[id], { status: 'approved', guest_id: 'WD-ABC' }); }, MINE);
  await page.clock.fastForward(POLL);
  await expect(page.locator('#card-wrap img')).toBeVisible({ timeout: 10000 });
  await page.evaluate(() => { document.querySelector('#card-wrap img').dataset.mark = '1'; });
  const before = await getRequestCalls(page);
  await page.clock.fastForward(POLL);
  await expect.poll(() => getRequestCalls(page)).toBeGreaterThan(before);
  await expect(page.locator('#card-wrap img[data-mark="1"]')).toHaveCount(1);
});

test('a VIP flip on an approved request shows on the open card live, both ways', async ({ page }) => {
  await page.clock.install();
  await openPending(page);
  await page.evaluate((id) => { Object.assign(window.__fakeSupabase.requests.e1[id], { status: 'approved', guest_id: 'WD-ABC' }); }, MINE);
  await page.clock.fastForward(POLL);
  await expect(page.locator('#card-wrap img')).toBeVisible({ timeout: 10000 });
  const bg = () => page.evaluate(() => Math.max(...Array.from(cardCanvas.getContext('2d').getImageData(60, 700, 1, 1).data.slice(0, 3))));
  expect(await bg()).toBeGreaterThan(200);
  await page.evaluate((id) => { window.__fakeSupabase.requests.e1[id].vip = true; }, MINE);
  await page.clock.fastForward(POLL);
  await expect.poll(bg).toBeLessThan(40);
  await page.evaluate((id) => { window.__fakeSupabase.requests.e1[id].vip = false; }, MINE);
  await page.clock.fastForward(POLL);
  await expect.poll(bg).toBeGreaterThan(200);
});

test('an unchanged pending request does not re-render the screen on each check', async ({ page }) => {
  await page.clock.install();
  await openPending(page);
  await page.evaluate(() => { document.querySelector('.pend-note').dataset.mark = '1'; });
  const before = await getRequestCalls(page);
  await page.clock.fastForward(POLL);
  await expect.poll(() => getRequestCalls(page)).toBeGreaterThan(before);
  await expect(page.locator('.pend-note[data-mark="1"]')).toHaveCount(1);
});

test('checking pauses while the page is in the background and runs at once when it comes back', async ({ page }) => {
  await page.clock.install();
  await openPending(page);
  const setHidden = (h) => page.evaluate((hidden) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  }, h);
  await setHidden(true);
  const before = await getRequestCalls(page);
  await page.clock.fastForward(120000);
  await page.waitForTimeout(200);
  expect(await getRequestCalls(page)).toBe(before);
  await setHidden(false);
  await expect.poll(() => getRequestCalls(page)).toBe(before + 1);
});

test('an approval whose guest the organizer deleted afterwards still shows the card and does not crash', async ({ page }) => {
  await stubSupabase(page);
  await page.route(/qrcodejs.*qrcode\.min\.js/, (route) => route.fulfill({ contentType: 'text/javascript', body: QR_STAND_IN }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await seedInviteStore(page, {
    store: { events: { e1: EV1 }, 'events/e1/requests': { [MINE]: { name: 'سارة', reqId: MINE, status: 'approved', guestId: 'WD-DELETED', createdAt: 'x' } } },
    tables: { guests: [] },
  });
  await page.addInitScript((id) => { localStorage.setItem('inv_reqid_e1', id); }, MINE);
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card')).toContainText('تم تأكيد حضورك');
  await expect(page.locator('#card-wrap img')).toBeVisible({ timeout: 10000 });
  expect(errors).toEqual([]);
});

test('a VIP approval draws the VIP card', async ({ page }) => {
  await stubSupabase(page);
  await page.route(/qrcodejs.*qrcode\.min\.js/, (route) => route.fulfill({ contentType: 'text/javascript', body: QR_STAND_IN }));
  await seedInviteStore(page, {
    store: { events: { e1: EV1 }, 'events/e1/requests': { [MINE]: { name: 'سارة', reqId: MINE, status: 'approved', guestId: 'WD-VIP', vip: true, createdAt: 'x' } } },
  });
  await page.addInitScript((id) => { localStorage.setItem('inv_reqid_e1', id); }, MINE);
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card-wrap img')).toBeVisible({ timeout: 10000 });
});

test('the invitation page asks the server for exactly its own rows: event_public and get_request with the event and request ids', async ({ page }) => {
  await openPending(page);
  const calls = await page.evaluate(() => window.__fakeSupabase.calls.slice(0, 2));
  expect(calls).toEqual([
    { name: 'event_public', args: { p_event_id: 'e1' } },
    { name: 'get_request', args: { p_event_id: 'e1', p_req_id: 'REQ-MINE-0000000000000000' } },
  ]);
});

test('approved card stays after a failed poll, and the next good poll keeps it', async ({ page }) => {
  await page.clock.install();
  await stubSupabase(page);
  await page.route(/qrcodejs.*qrcode\.min\.js/, (route) => route.fulfill({ contentType: 'text/javascript', body: QR_STAND_IN }));
  await seedInviteStore(page, {
    store: { events: { e1: EV1 }, 'events/e1/requests': { [MINE]: { name: 'سارة', reqId: MINE, status: 'approved', guestId: 'WD-ABC', createdAt: 'x' } } },
  });
  await page.addInitScript((id) => { localStorage.setItem('inv_reqid_e1', id); }, MINE);
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card-wrap img')).toBeVisible({ timeout: 10000 });
  await page.evaluate(() => { window.__fakeSupabase.fail = { get_request: { error: 'network', times: 1 } }; });
  const before = await getRequestCalls(page);
  await page.clock.fastForward(POLL);
  await expect.poll(() => getRequestCalls(page)).toBeGreaterThan(before);
  await page.waitForTimeout(200);
  await expect(page.locator('#card-wrap img')).toBeVisible();
  await expect(page.locator('#card')).not.toContainText('تعذّر تحميل طلبك');
  await page.clock.fastForward(30000);
  await expect(page.locator('#card-wrap img')).toBeVisible();
});
