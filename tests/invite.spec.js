const { test, expect } = require('@playwright/test');
const { stubFirebase, seedFakeFirebase } = require('./helpers');

test('shows the RSVP form for a real event and an error for a missing one', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    store: { events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } } },
  });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#g-name')).toBeVisible();
  await expect(page.locator('#card')).toContainText('حفل تجريبي');
});

test('a bad event id shows an error instead of the form', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: {} } });
  await page.goto('/invite.html?event=does-not-exist');
  await expect(page.locator('#card')).toContainText('هذه المناسبة غير موجودة');
});

test('the page still loads even if localStorage throws (Safari private browsing, storage-blocking policies)', async ({ page }) => {
  // localStorage.getItem() used to run unguarded as the very first thing in
  // the page's script — an uncaught throw there would silently kill
  // everything defined after it, including init() itself, leaving the
  // guest stuck on the loading placeholder forever with no way out.
  await stubFirebase(page);
  await seedFakeFirebase(page, {
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
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    store: { events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } } },
  });
  await page.addInitScript(() => { window.__failNextGetDoc = true; });
  await page.goto('/invite.html?event=e1');

  const retry = page.locator('#retry-msg');
  await expect(retry).toContainText('تعذّر الاتصال');
  await retry.click();
  await expect(page.locator('#card')).toContainText('حفل تجريبي');
});

test('an approved guest gets their card from the request itself — the invite page no longer reads the guests collection', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    store: {
      events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } },
      'events/e1/requests': { 'REQ-1': { name: 'سارة', reqId: 'REQ-1', status: 'approved', guestId: 'WD-ABC', createdAt: 'x' } },
    },
  });
  await page.addInitScript(() => {
    localStorage.setItem('inv_reqid_e1', 'REQ-1');
    // The guests collection is no longer world-readable — prove this page
    // doesn't need it.
    window.__fakeFirebase.denyPaths = ['events/e1/guests'];
    window.__fakeFirebase.denyLists = ['events/e1/requests']; // listing requests is not open to guests
  });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card')).toContainText('تم تأكيد حضورك');
  // The demo-only scanning note shouldn't show up for a real guest.
  await expect(page.locator('#card')).not.toContainText('مسح الكود عند الباب يتم لحظياً');
});

test('an approval that predates the barcode-id-on-request change shows "preparing your card", then the card once it is filled in', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    store: {
      events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } },
      'events/e1/requests': { 'REQ-1': { name: 'سارة', reqId: 'REQ-1', status: 'approved', createdAt: 'x' } },
    },
  });
  await page.addInitScript(() => { localStorage.setItem('inv_reqid_e1', 'REQ-1'); });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card')).toContainText('جاري تجهيز بطاقتك');

  // The organizer opening their dashboard backfills the id; the same
  // listener picks it up.
  await page.evaluate(() => {
    const { doc, setDoc } = window._fsFns;
    return setDoc(doc(window._db, 'events', 'e1', 'requests', 'REQ-1'), { name: 'سارة', reqId: 'REQ-1', status: 'approved', guestId: 'WD-LATE', createdAt: 'x' });
  });
  await expect(page.locator('#card')).toContainText('تم تأكيد حضورك');
});

const EVENT = { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' };

test('registering creates the request under its own secret id — and works when listing requests is denied', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EVENT }, 'events/e1/requests': {} } });
  await page.addInitScript(() => { window.__fakeFirebase.denyLists = ['events/e1/requests']; });
  await page.goto('/invite.html?event=e1');
  await page.locator('#g-name').fill('سارة');
  await page.getByRole('button', { name: 'تأكيد الحضور' }).click();
  await expect(page.locator('#card')).toContainText('بانتظار موافقة صاحب الدعوة');

  const state = await page.evaluate(() => ({
    stored: localStorage.getItem('inv_reqid_e1'),
    docs: window.__fakeFirebase.store['events/e1/requests'],
  }));
  // 128 random bits, in hex.
  expect(state.stored).toMatch(/^REQ-[0-9A-F]{32}$/);
  // The document is named after it, and carries the same value.
  expect(Object.keys(state.docs)).toEqual([state.stored]);
  expect(state.docs[state.stored]).toMatchObject({ name: 'سارة', reqId: state.stored, status: 'pending' });
});

test('two registrations never get the same id', async ({ browser }) => {
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await stubFirebase(page);
    await seedFakeFirebase(page, { store: { events: { e1: EVENT }, 'events/e1/requests': {} } });
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
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    store: {
      events: { e1: EVENT },
      'events/e1/requests': {
        'REQ-MINE': { name: 'سارة', reqId: 'REQ-MINE', status: 'pending', createdAt: 'x' },
        'REQ-THEIRS': { name: 'خالد', reqId: 'REQ-THEIRS', status: 'approved', guestId: 'WD-SECRET', createdAt: 'x' },
      },
    },
  });
  await page.addInitScript(() => {
    localStorage.setItem('inv_reqid_e1', 'REQ-MINE');
    window.__fakeFirebase.denyLists = ['events/e1/requests'];
  });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card')).toContainText('بانتظار موافقة صاحب الدعوة');
  await expect(page.locator('body')).not.toContainText('خالد');
  await expect(page.locator('body')).not.toContainText('WD-SECRET');
});

test('a saved request id with no request behind it (an older request, or one the organizer deleted) lets the guest register again', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EVENT }, 'events/e1/requests': {} } });
  await page.addInitScript(() => { localStorage.setItem('inv_reqid_e1', 'REQ-GONE'); });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#g-name')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('inv_reqid_e1'))).toBeNull();
});

test('after a rejection, trying again creates a fresh request under a new id', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    store: {
      events: { e1: EVENT },
      'events/e1/requests': { 'REQ-OLD': { name: 'سارة', reqId: 'REQ-OLD', status: 'rejected', createdAt: 'x' } },
    },
  });
  await page.addInitScript(() => { localStorage.setItem('inv_reqid_e1', 'REQ-OLD'); });
  await page.goto('/invite.html?event=e1');
  await page.getByRole('button', { name: 'حاول مرة ثانية' }).click();
  await page.locator('#g-name').fill('سارة');
  await page.getByRole('button', { name: 'تأكيد الحضور' }).click();
  await expect(page.locator('#card')).toContainText('بانتظار موافقة صاحب الدعوة');
  const ids = await page.evaluate(() => Object.keys(window.__fakeFirebase.store['events/e1/requests']));
  expect(ids).toHaveLength(2);
  expect(ids.filter(i => i !== 'REQ-OLD')[0]).toMatch(/^REQ-[0-9A-F]{32}$/);
});

test('the sample invitation (?demo=1) walks through registration and approval without touching the database', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: {} } });
  // Any read or write against these would fail loudly — the demo must not need them.
  await page.addInitScript(() => { window.__fakeFirebase.denyPaths = ['events', 'accountLimits']; });
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
  await expect(page.locator('#card')).toContainText('مسح الكود عند الباب يتم لحظياً');

  const state = await page.evaluate(() => ({
    store: JSON.stringify(window.__fakeFirebase.store),
    saved: (() => { try { return localStorage.getItem('inv_reqid_null'); } catch (e) { return null; } })(),
  }));
  expect(state.store).toBe('{"events":{}}');   // nothing was created
  expect(state.saved).toBeNull();               // and nothing remembered on the phone
});

test('the sample invitation does not need the database to load at all', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: {} });
  await page.addInitScript(() => { window.__failNextGetDoc = true; window.__fakeFirebase.denyPaths = ['events']; });
  await page.goto('/invite.html?demo=1&type=wedding');
  await expect(page.locator('#g-name')).toBeVisible();
});

// The free email plan is for real activity — a customer creating an event —
// not for people trying the sample. Nothing on the sample's path may send an
// email, now or after a later change.
test('trying the sample never sends an email to the owner', async ({ page }) => {
  const requested = [];
  page.on('request', (r) => requested.push(r.url()));
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: {} } });
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
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: {} } });
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
    await stubFirebase(page);
    await seedFakeFirebase(page, { store: { events: {} } });
    await page.addInitScript(() => { window.__fakeFirebase.denyPaths = ['events', 'accountLimits']; });
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
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: {} } });
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
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    store: { events: { e1: { name: 'حفل تجريبي', date: '2026-10-29', venue: 'الرياض', theme: 'gold' } } },
  });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card .sub')).toContainText('الخميس 29 أكتوبر 2026');
  await expect(page.locator('#splash .splash-title')).toHaveText('دعوة زفاف');
  await expect(page.locator('#splash .splash-rings img')).toHaveAttribute('src', 'icons/kind-wedding.svg');
});

test('a real invitation opens with its own kind: a graduation shows the graduation splash, and this device remembers it', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: { name: 'حفل تخرج نورة', type: 'graduation', date: '2026-10-29', venue: 'الدمام', theme: 'sapphire' } } } });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#splash .splash-title')).toHaveText('دعوة حفل تخرج');
  await expect(page.locator('#splash .splash-rings img')).toHaveAttribute('src', 'icons/kind-graduation.svg');
  expect(await page.evaluate(() => localStorage.getItem('inv_kind_e1'))).toBe('graduation');
});

test('before the event loads, a real invitation shows the kind this device saw last time, or the neutral logo', async ({ page }) => {
  await stubFirebase(page);
  await page.addInitScript(() => { try { localStorage.setItem('inv_kind_seen', 'event'); } catch (e) {} });
  // Neither event exists, so nothing replaces what the splash starts with.
  await seedFakeFirebase(page, { store: { events: {} } });
  await page.goto('/invite.html?event=seen');
  await expect(page.locator('#splash .splash-title')).toHaveText('دعوة فعالية');
  await page.goto('/invite.html?event=never');
  await expect(page.locator('#splash .splash-title')).toHaveText('دعوات');
  await expect(page.locator('#splash .splash-rings img')).toHaveAttribute('src', 'icons/logo.svg');
});

test('the invitation shows the kind of event above its name and the owner\'s welcome line (or the kind\'s default)', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: {
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
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: { name: 'تخرج نورة', type: 'graduation', date: '2026-10-29', venue: 'الدمام', theme: 'sapphire' } } } });
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
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: {} } });
  await page.goto('/invite.html?demo=1&type=graduation');
  await expect(page.locator('#card .inv-kind')).toHaveText('دعوة حفل تخرج');
  await expect(page.locator('#card .inv-msg')).toContainText('فرحة التخرج');
});

test('a date an organizer typed as free text is shown as typed, never dropped', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: { name: 'حفل', date: 'قريبًا', venue: 'الرياض', theme: 'gold' } } } });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card .sub')).toContainText('قريبًا');
});

test('a readable link (?s=name) finds its event through slugs/ and keeps the short address', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: {
    events: { e1: { name: 'زواج حلا وتركي', ownerUid: 'u1', date: '2026-12-01', venue: 'الرياض', theme: 'gold' } },
    slugs: { 'hala-turki': { eventId: 'e1', ownerUid: 'u1', createdAt: 'x' } },
  } });
  await page.goto('/invite.html?s=hala-turki');
  await expect(page.locator('body')).toContainText('زواج حلا وتركي');
  await expect(page).toHaveURL(/\/hala-turki$/);
});

test('an unknown readable link says so', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: {}, slugs: {} } });
  await page.goto('/invite.html?s=no-such-name');
  await expect(page.locator('body')).toContainText('هذا الرابط غير موجود');
});

// GitHub Pages serves 404.html for any path without a file; the local test
// server doesn't, so the route hands the page 404.html for the short path.
test('404.html forwards a readable link like /hala-turki to the invitation page, and shows "not found" for anything else', async ({ page }) => {
  const fs = require('fs'); const path = require('path');
  const body = fs.readFileSync(path.join(__dirname, '..', '404.html'), 'utf8');
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: {}, slugs: {} } });
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
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: {
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
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: { name: '<img id="xn" src=x onerror="window.__x=1">', date: '2026-10-29', venue: 'الدمام', theme: 'gold', welcomeMessage: '<img id="xw" src=x onerror="window.__x=1">' } } } });
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
  await seedFakeFirebase(page, {
    store: {
      events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } },
      'events/e1/requests': { 'REQ-1': { name: 'سارة', reqId: 'REQ-1', status: 'approved', guestId: 'WD-ABC', createdAt: 'x' } },
    },
  });
  await page.addInitScript(() => { localStorage.setItem('inv_reqid_e1', 'REQ-1'); });
}

test('the invitation page never requests or imports the auth SDK, and still loads through the light bootstrap', async ({ page }) => {
  const seen = [];
  page.on('request', (r) => seen.push(r.url()));
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } } } });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#g-name')).toBeVisible();
  expect(seen.some((u) => /firebase-auth/.test(u))).toBe(false);
  expect(seen.some((u) => /firebase-init-lite\.js/.test(u))).toBe(true);
  expect(seen.some((u) => /\/firebase-init\.js/.test(u))).toBe(false);
  expect(await page.evaluate(() => typeof window._auth)).toBe('undefined');
});

test('the QR library is not requested until a card has to be drawn', async ({ page }) => {
  const seen = [];
  page.on('request', (r) => seen.push(r.url()));
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' } } } });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#g-name')).toBeVisible();
  expect(seen.some((u) => /qrcode/.test(u))).toBe(false);
});

test('a slow QR library: the card still appears once it arrives', async ({ page }) => {
  await stubFirebase(page);
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
  await stubFirebase(page);
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

test('every page that talks to Firestore preconnects to it; the service worker gives the network 1500 ms before the cache', async () => {
  const fs = require('fs');
  for (const f of ['invite.html', 'scan.html', 'app.html', 'event.html']) {
    expect(fs.readFileSync(f, 'utf8')).toContain('<link rel="preconnect" href="https://firestore.googleapis.com">');
  }
  expect(fs.readFileSync('sw.js', 'utf8')).toContain("reject(new Error('timeout')), 1500)");
});

test('every Firestore function invite.html pulls from _fsFns is exported by the lite bootstrap', async () => {
  const fs = require('fs');
  const page = fs.readFileSync('invite.html', 'utf8');
  const lite = fs.readFileSync('firebase-init-lite.js', 'utf8');
  const exported = lite.match(/window\._fsFns\s*=\s*\{([^}]*)\}/)[1].split(',').map((s) => s.trim()).filter(Boolean);
  const used = [...page.matchAll(/const\s*\{([^}]*)\}\s*=\s*window\._fsFns/g)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
  expect(used.length).toBeGreaterThan(0);
  for (const name of used) expect(exported).toContain(name);
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
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: { name: 'حفل تجريبي', date: '2026-10-29', venue: 'الرياض', theme: 'gold' } } } });
  await watchInviteSplash(page);
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#splash')).toHaveClass(/hide/, { timeout: 4000 });
  const t = await page.evaluate(() => window.__hideAt);
  expect(t).toBeGreaterThanOrEqual(1550);
  expect(t).toBeLessThan(3000);
  expect(await page.locator('#splash').evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0.4s, 0.4s');
});

test('the invitation splash still hides within 3.5 s when the event data never arrives', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: { name: 'حفل تجريبي', date: '2026-10-29', venue: 'الرياض', theme: 'gold' } } } });
  await page.addInitScript(() => { window.__hangGetDoc = true; });
  await watchInviteSplash(page);
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#splash')).toHaveClass(/hide/, { timeout: 5000 });
  const t = await page.evaluate(() => window.__hideAt);
  expect(t).toBeGreaterThanOrEqual(3400);
  expect(t).toBeLessThan(4200);
});

test('the invitation card is the page main landmark', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: { name: 'حفل تجريبي', date: '2030-01-01', venue: 'الرياض', theme: 'gold' } } } });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('main#card')).toHaveCount(1);
  await expect(page.locator('#g-name')).toBeVisible();
  await expect(page.locator('main#card')).not.toHaveClass(/card-wait/);
});

const EV1 = { name: 'حفل تجريبي', date: '2026-01-01', venue: 'الرياض', theme: 'gold' };

for (const [link, shown] of [['https://maps.example.com/x', true], ['HTTP://maps.example.com/x', true], ['javascript:alert(1)', false], ['data:text/html,x', false], ['  javascript:alert(1)', false]]) {
  test('a map link of ' + JSON.stringify(link) + ' ' + (shown ? 'becomes a safe link' : 'never becomes a link'), async ({ page }) => {
    await stubFirebase(page);
    await seedFakeFirebase(page, { store: { events: { e1: { ...EV1, mapsLink: link } } } });
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
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EV1 }, 'events/e1/requests': {} } });
  await page.addInitScript(() => { window.__setDocDelay = 600; });
  await page.goto('/invite.html?event=e1');
  await page.locator('#g-name').fill('سارة');
  await page.evaluate(() => { submitRequest(); submitRequest(); });
  await expect(page.locator('#rsvp-btn')).toBeDisabled();
  await expect(page.locator('#rsvp-btn')).toHaveText('جاري الإرسال...');
  await expect(page.locator('#card')).toContainText('بانتظار موافقة', { timeout: 5000 });
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => Object.keys(window.__fakeFirebase.store['events/e1/requests']).length)).toBe(1);
});

test('a slow send says it is still sending; a failed send re-enables the button with an Arabic message (no alert)', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EV1 }, 'events/e1/requests': {} } });
  let alerts = 0;
  page.on('dialog', (d) => { alerts++; d.dismiss(); });
  await page.goto('/invite.html?event=e1');
  await page.evaluate(() => { window.__fakeFirebase.denyPaths = ['events/e1/requests']; });
  await page.locator('#g-name').fill('سارة');
  await page.locator('#rsvp-btn').click();
  await expect(page.locator('#rsvp-msg')).toHaveText('تعذّر إرسال طلبك، جرّب مرة ثانية');
  await expect(page.locator('#rsvp-btn')).toBeEnabled();
  await expect(page.locator('#rsvp-btn')).toHaveText('تأكيد الحضور');
  expect(alerts).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('inv_reqid_e1'))).toBeNull();

  await page.evaluate(() => { window.__fakeFirebase.denyPaths = []; window.__setDocDelay = 9500; });
  await page.locator('#rsvp-btn').click();
  await expect(page.locator('#rsvp-msg')).toContainText('لسا يُرسل', { timeout: 10000 });
});

test('an empty name shows «اكتب اسمك» and focuses the field; the field has mobile-friendly attributes', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EV1 } } });
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

test('offline, a request the SDK has not cached is not treated as deleted: the key stays', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EV1 }, 'events/e1/requests': {} } });
  await page.addInitScript(() => { localStorage.setItem('inv_reqid_e1', 'REQ-MINE'); window.__snapshotFromCache = true; });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card')).toContainText('جاري التحقق من طلبك');
  await expect(page.locator('#g-name')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('inv_reqid_e1'))).toBe('REQ-MINE');
});

test('a failing request listener shows a retry message and keeps the key', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EV1 }, 'events/e1/requests': { 'REQ-MINE': { name: 'سارة', reqId: 'REQ-MINE', status: 'pending', createdAt: 'x' } } } });
  await page.addInitScript(() => {
    localStorage.setItem('inv_reqid_e1', 'REQ-MINE');
    window.__fakeFirebase.denyPaths = ['events/e1/requests'];
  });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card')).toContainText('تعذّر تحميل طلبك');
  expect(await page.evaluate(() => localStorage.getItem('inv_reqid_e1'))).toBe('REQ-MINE');
  await page.evaluate(() => { window.__fakeFirebase.denyPaths = []; });
  await page.getByRole('button', { name: 'حاول مرة ثانية' }).click();
  await expect(page.locator('#card')).toContainText('بانتظار موافقة');
});

test('when the organizer deletes the request, the guest sees a message above a fresh form', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EV1 }, 'events/e1/requests': { 'REQ-MINE': { name: 'سارة', reqId: 'REQ-MINE', status: 'pending', createdAt: 'x' } } } });
  await page.addInitScript(() => { localStorage.setItem('inv_reqid_e1', 'REQ-MINE'); });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#card')).toContainText('بانتظار موافقة');
  await page.evaluate(async () => {
    const m = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    await m.deleteDoc(m.doc(window._db, 'events', 'e1', 'requests', 'REQ-MINE'));
  });
  await expect(page.locator('#g-name')).toBeVisible();
  await expect(page.locator('#rsvp-msg')).toContainText('تم حذف طلبك من صاحب الدعوة');
  expect(await page.evaluate(() => localStorage.getItem('inv_reqid_e1'))).toBeNull();
});

test('a malformed event id shows «رابط غير صحيح» with a hint and never asks Firestore', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: {} } });
  await page.goto('/invite.html?event=' + encodeURIComponent('a/b'));
  await expect(page.locator('#card')).toContainText('رابط غير صحيح');
  await expect(page.locator('#card')).toContainText('تأكد من الرابط أو تواصل مع صاحب الدعوة');
  await expect(page.locator('#retry-msg')).toHaveCount(0);
  await page.goto('/invite.html');
  await expect(page.locator('#card')).toContainText('رابط غير صحيح');
});

test('a missing event and a missing readable link both carry the check-the-link hint', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: {}, slugs: {} } });
  await page.goto('/invite.html?event=nothere1');
  await expect(page.locator('#card')).toContainText('تأكد من الرابط أو تواصل مع صاحب الدعوة');
  await page.goto('/invite.html?s=nothing');
  await expect(page.locator('#card')).toContainText('هذا الرابط غير موجود');
  await expect(page.locator('#card')).toContainText('تأكد من الرابط أو تواصل مع صاحب الدعوة');
});

test('a long event name wraps instead of overflowing, and the heading font has an Arabic fallback', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: { ...EV1, name: 'ا'.repeat(80), venue: 'ب'.repeat(100) } } } });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('h1')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.locator('h1').evaluate((el) => getComputedStyle(el).fontFamily)).toContain('IBM Plex Sans Arabic');
  expect(await page.locator('h1').evaluate((el) => getComputedStyle(el).overflowWrap)).toBe('anywhere');
});

test('the approved screen tells the guest to save or screenshot the card', async ({ page }) => {
  await stubFirebase(page);
  await page.route(/qrcodejs.*qrcode\.min\.js/, (route) => route.fulfill({ contentType: 'text/javascript', body: QR_STAND_IN }));
  await seedFakeFirebase(page, { store: { events: { e1: EV1 }, 'events/e1/requests': { 'REQ-1': { name: 'سارة', reqId: 'REQ-1', status: 'approved', guestId: 'WD-ABC', createdAt: 'x' } } } });
  await page.addInitScript(() => { localStorage.setItem('inv_reqid_e1', 'REQ-1'); });
  await page.goto('/invite.html?event=e1');
  await expect(page.locator('#save-hint')).toHaveText('احفظ الدعوة أو صوّر الشاشة');
});

test('the saved card loads the Arabic fonts before drawing, fits long texts, and tells in-app browsers to long-press', async ({ page }) => {
  await stubFirebase(page);
  await page.route(/qrcodejs.*qrcode\.min\.js/, (route) => route.fulfill({ contentType: 'text/javascript', body: QR_STAND_IN }));
  const longName = 'عبدالرحمن بن محمد بن عبدالعزيز بن فهد '.repeat(3).trim();
  await seedFakeFirebase(page, { store: { events: { e1: { ...EV1, name: 'حفل زفاف '.repeat(8).trim() } }, 'events/e1/requests': { 'REQ-1': { name: longName, reqId: 'REQ-1', status: 'approved', guestId: 'WD-ABC', createdAt: 'x' } } } });
  await page.addInitScript(() => {
    localStorage.setItem('inv_reqid_e1', 'REQ-1');
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
  await expect(page.locator('#press-hint')).toHaveText('اضغط مطولًا على الصورة واختر حفظ');
});

test('fitFillText shrinks until the text fits the width and never goes below the minimum', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { store: { events: { e1: EV1 } } });
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
