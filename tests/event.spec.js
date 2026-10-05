const { test, expect } = require('@playwright/test');
const { stubFirebase, seedFakeFirebase } = require('./helpers');

// No door code on the event doc itself — it lives in the owner-only
// events/e1/private/scan sub-document.
const EVENT = {
  name: 'حفل تجريبي', ownerUid: 'u1', date: '2026-01-01', venue: 'الرياض',
  theme: 'gold', createdAt: { seconds: 1 },
};

function baseStore(guests) {
  const g = {};
  guests.forEach((data, i) => { g['g' + i] = data; });
  return {
    events: { e1: EVENT },
    'events/e1/guests': g,
    'events/e1/requests': {},
    'events/e1/private': { scan: { scanPin: '1234' } },
  };
}

test('adding a guest confirms with a toast, clears and refocuses the field, and blocks a duplicate name', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: baseStore([{ id: 'WD-1', name: 'أحمد', scanned: false }]),
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();

  // Empty name gets a validation toast, not a silent no-op.
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('#toast')).toContainText('اكتب اسمًا صحيحًا');

  const input = page.locator('#new-guest-name');
  await input.fill('سارة');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('#toast')).toContainText('تمت إضافة سارة');
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(page.locator('.guest-item')).toHaveCount(2);

  // The new guest's own barcode ("WD-...") is its Firestore document key —
  // not a separate random doc id — so the scanner can look it up with one
  // direct read instead of loading the whole guest list.
  const saved = await page.evaluate(() => {
    const g = window.__fakeFirebase.store['events/e1/guests'];
    const [key, data] = Object.entries(g).find(([, d]) => d.name === 'سارة');
    return { key, id: data.id };
  });
  expect(saved.key).toBe(saved.id);
  expect(saved.key).toMatch(/^WD-/);

  // Same name again should be rejected as a duplicate within this list.
  await input.fill('سارة');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('#toast')).toContainText('الاسم موجود بالقائمة');
  await expect(page.locator('.guest-item')).toHaveCount(2);
});

test('a guest name containing a backslash and a quote does not break the delete button', async ({ page }) => {
  // The onclick handlers embed the guest's name inside a single-quoted JS
  // string literal within an HTML attribute — escapeHtml alone protects the
  // attribute boundary but not that inner string literal. A name ending in
  // a raw backslash used to silently swallow the closing quote, corrupting
  // the whole onclick attribute and leaving the button non-functional.
  await stubFirebase(page);
  const trickyName = "O'Brien\\";
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: baseStore([{ id: 'WD-1', name: trickyName, scanned: false }]),
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();

  let dialogMessage = '';
  page.on('dialog', (d) => { dialogMessage = d.message(); d.accept(); });
  await page.locator('.guest-item .more-btn').click();
  await page.locator('#guest-sheet .gs-del').click();

  expect(dialogMessage).toContain(trickyName);
  await expect(page.locator('.guest-item')).toHaveCount(0);
});

test('two guests sharing a first name but not a full name are both allowed — the duplicate check compares the whole name', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: baseStore([{ id: 'WD-1', name: 'حسن أحمد', scanned: false }]),
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();

  const input = page.locator('#new-guest-name');
  await input.fill('حسن محمد');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('#toast')).toContainText('تمت إضافة حسن محمد');
  await expect(page.locator('.guest-item')).toHaveCount(2);
});

test('the guest-card button is always labeled "حفظ", regardless of whether this device can share files', async ({ page }) => {
  // Kept simple and consistent on purpose rather than switching label text
  // by device capability — "حفظ" reads fine either way: on a device that
  // can share, the system share sheet that opens even includes "Save
  // Image" as one of its own options.
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: baseStore([{ id: 'WD-1', name: 'أحمد', scanned: false }]),
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('.guest-item .dl-btn')).toHaveText('حفظ');
});

test('marking a guest as attended from the list asks for confirmation first, so a stray tap can\'t check someone in', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: baseStore([{ id: 'WD-1', name: 'أحمد', scanned: false }]),
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();

  page.on('dialog', d => d.dismiss());
  await page.locator('.attend-btn').click();
  await expect(page.locator('.attend-btn')).toBeVisible();

  page.removeAllListeners('dialog');
  page.on('dialog', d => d.accept());
  await page.locator('.attend-btn').click();
  await expect(page.locator('.undo-btn')).toBeVisible();
});

test('marking attended manually bumps the event\'s scannedCount, so the door scanner\'s live counter sees it too', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: baseStore([{ id: 'WD-1', name: 'أحمد', scanned: false }]),
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();

  page.on('dialog', d => d.accept());
  await page.locator('.attend-btn').click();
  await expect(page.locator('.undo-btn')).toBeVisible();

  await expect.poll(() => page.evaluate(() => window.__fakeFirebase.store.events.e1.scannedCount)).toBe(1);
});

test('undoing attendance decrements scannedCount, so re-scanning the same guest later doesn\'t double-count them', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: { ...baseStore([{ id: 'WD-1', name: 'أحمد', scanned: true }]), events: { e1: { ...EVENT, scannedCount: 1 } } },
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();

  page.on('dialog', d => d.accept());
  await page.locator('.undo-btn').click();
  await expect(page.locator('.attend-btn')).toBeVisible();

  await expect.poll(() => page.evaluate(() => window.__fakeFirebase.store.events.e1.scannedCount)).toBe(0);
});

test('deleting a guest frees up their slot, so the customer can add a replacement', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: { ...baseStore([{ id: 'WD-1', name: 'أحمد', scanned: false }]), events: { e1: { ...EVENT, guestCount: 1 } } },
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();

  page.on('dialog', d => d.accept());
  await page.locator('.guest-item .more-btn').click();
  await page.locator('#guest-sheet .gs-del').click();
  await expect(page.locator('.guest-item')).toHaveCount(0);

  await expect.poll(() => page.evaluate(() => window.__fakeFirebase.store.events.e1.guestCount)).toBe(0);
});

const attendedStore = () => ({
  ...baseStore([{ id: 'WD-1', name: 'أحمد', scanned: true, scannedAt: '2026-01-01T10:00:00Z' }, { id: 'WD-2', name: 'سارة', scanned: false }]),
  events: { e1: { ...EVENT, guestCount: 2, scannedCount: 1 } },
});
const counts = (page) => page.evaluate(() => {
  const e = window.__fakeFirebase.store.events.e1;
  return [e.guestCount, e.scannedCount];
});

test('deleting a guest who already checked in also takes them off the door counter (scannedCount)', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: attendedStore() });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();

  page.on('dialog', d => d.accept());
  const row = page.locator('.guest-item', { hasText: 'أحمد' });
  await row.locator('.more-btn').click();
  await page.locator('#guest-sheet .gs-del').click();
  await expect(page.locator('.guest-item')).toHaveCount(1);
  await expect.poll(() => counts(page)).toEqual([1, 0]);
});

test('bulk-deleting checked-in and not-checked-in guests leaves both counters right', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: attendedStore() });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();

  page.on('dialog', d => d.accept());
  await page.getByRole('button', { name: 'القائمة' }).click();
  await page.getByRole('button', { name: /تحديد ضيوف للحذف/ }).click();
  for (const box of await page.locator('.gsel').all()) await box.check();
  await page.getByRole('button', { name: /حذف المحددين/ }).click();
  await expect(page.locator('.guest-item')).toHaveCount(0);
  await expect.poll(() => counts(page)).toEqual([0, 0]);
});

test('if the connection was shut down for good ("client has already been terminated"), the page reloads instead of showing the raw error', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: baseStore([]) });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();

  const alerts = [];
  page.on('dialog', d => { alerts.push(d.message()); d.dismiss(); });
  const reloaded = page.waitForEvent('load');
  await page.evaluate(() => showErr(Object.assign(new Error('The client has already been terminated.'), { code: 'failed-precondition' })));
  await expect(page.locator('#toast')).toContainText('انقطع الاتصال');
  await reloaded;
  expect(alerts).toEqual([]);
});

test('a page Safari brings back from its back-forward cache reloads, so it never runs on a dead connection', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: baseStore([]) });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();

  const reloaded = page.waitForEvent('load');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await reloaded;
});

test('the edit-event date field has a visible label (iOS Safari shows an empty date field as blank)', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: baseStore([]) });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('label[for="edit-ev-date"]')).toHaveText('تاريخ المناسبة');
});

test('adding sequential numbers creates that many numbered guests without needing a file', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: { events: { e1: EVENT }, 'events/e1/guests': {}, 'events/e1/requests': {} },
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();

  let promptCount = 0;
  page.on('dialog', async (d) => {
    if (d.type() === 'prompt') {
      promptCount++;
      await d.accept(promptCount === 1 ? '1' : '5');
    } else {
      await d.accept();
    }
  });

  await page.getByRole('button', { name: 'القائمة' }).click();
  await page.getByRole('button', { name: /إضافة أرقام متسلسلة/ }).click();

  await expect(page.locator('.guest-item')).toHaveCount(5);
  const names = (await page.locator('.guest-item .name').allTextContents()).sort((a, b) => Number(a) - Number(b));
  expect(names).toEqual(['1', '2', '3', '4', '5']);

  // The bulk-import path keys every guest by its own barcode id too.
  const mismatched = await page.evaluate(() =>
    Object.entries(window.__fakeFirebase.store['events/e1/guests']).filter(([key, d]) => key !== d.id));
  expect(mismatched).toEqual([]);
});

test('a small add still shows "جاري الإضافة" while it writes — not just large imports, since a transaction write has no instant local echo to lean on', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: { events: { e1: EVENT }, 'events/e1/guests': {}, 'events/e1/requests': {} },
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  const toasts = [];
  await page.exposeFunction('__recordToast', (t) => toasts.push(t));
  await page.evaluate(() => { const real = showToast; window.showToast = (m) => { window.__recordToast(m); real(m); }; });

  let promptCount = 0;
  page.on('dialog', async (d) => {
    if (d.type() === 'prompt') { promptCount++; await d.accept(promptCount === 1 ? '1' : '5'); }
    else await d.accept();
  });
  await page.getByRole('button', { name: 'القائمة' }).click();
  await page.getByRole('button', { name: /إضافة أرقام متسلسلة/ }).click();
  await expect(page.locator('.guest-item')).toHaveCount(5);

  expect(toasts.some(t => t.includes('⏳ جاري الإضافة'))).toBe(true);
});

test('a large batch of sequential numbers shows progress instead of looking frozen', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: { events: { e1: { ...EVENT, paid: true } }, 'events/e1/guests': {}, 'events/e1/requests': {} },
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();

  let promptCount = 0;
  page.on('dialog', async (d) => {
    if (d.type() === 'prompt') {
      promptCount++;
      await d.accept(promptCount === 1 ? '1' : '120');
    } else {
      await d.accept();
    }
  });

  await page.getByRole('button', { name: 'القائمة' }).click();
  await page.getByRole('button', { name: /إضافة أرقام متسلسلة/ }).click();

  await expect(page.locator('.guest-item')).toHaveCount(120, { timeout: 10000 });
  await expect(page.locator('#toast')).toContainText('120 / 120');
});

test('guest list sorts numeric names first (in numeric order), then alphabetical', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: baseStore([
      { id: 'WD-1', name: 'زينب', scanned: false },
      { id: 'WD-2', name: '10', scanned: false },
      { id: 'WD-3', name: '2', scanned: false },
      { id: 'WD-4', name: 'أحمد', scanned: false },
    ]),
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  const names = await page.locator('.guest-item .name').allTextContents();
  expect(names).toEqual(['2', '10', 'أحمد', 'زينب']);
});

test('a burst of near-simultaneous guest updates collapses into one render instead of one per update', async ({ page }) => {
  // Simulates a bulk import or several door scanners checking guests in
  // around the same moment — the guest list used to do a full DOM rebuild
  // for every single update in a row, which is the kind of thing that
  // stutters on a large guest list. renderGuests() calls are now coalesced
  // into a single animation frame per burst.
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: baseStore([{ id: 'WD-1', name: 'أحمد', scanned: false }]),
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();

  const renderCount = await page.evaluate(async () => {
    let count = 0;
    const original = renderGuests;
    renderGuests = function (...args) { count++; return original.apply(this, args); };
    const { doc, updateDoc } = window._fsFns;
    for (let i = 0; i < 5; i++) {
      await updateDoc(doc(window._db, 'events', 'e1', 'guests', 'g0'), { scanned: i % 2 === 0 });
    }
    // Let the coalesced animation-frame render actually fire before restoring.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    renderGuests = original;
    return count;
  });

  expect(renderCount).toBe(1);
});

test('stat tiles reflect attended vs pending counts', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: baseStore([
      { id: 'WD-1', name: 'A', scanned: true },
      { id: 'WD-2', name: 'B', scanned: false },
      { id: 'WD-3', name: 'C', scanned: false },
    ]),
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#stat-total')).toHaveText('3');
  await expect(page.locator('#stat-attended')).toHaveText('1');
  await expect(page.locator('#stat-pending')).toHaveText('2');
});

test('guest search filters the visible list by name', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: baseStore([
      { id: 'WD-1', name: 'Hassan Sallah', scanned: false },
      { id: 'WD-2', name: 'Fatima Ali', scanned: false },
    ]),
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('.guest-item')).toHaveCount(2);
  await page.locator('#guest-search').fill('fatima');
  await expect(page.locator('.guest-item')).toHaveCount(1);
  await expect(page.locator('.guest-item .name')).toHaveText('Fatima Ali');
});

test('someone who is not the event owner is denied access', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'someone-else', email: 'not-the-owner@example.com' },
    store: baseStore([]),
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#denied-msg')).toBeVisible();
  await expect(page.locator('#dashboard')).toBeHidden();
});

test('the admin account can open a customer event it does not own', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'admin-uid', email: 'hsallah@outlook.sa' },
    store: baseStore([{ id: 'WD-1', name: 'Guest', scanned: false }]),
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#denied-msg')).toBeHidden();
});

test('a fresh unpaid event shows no payment-gate banner and lets the owner add a guest, with the remaining count tucked into the menu', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: { events: { e1: { ...EVENT, paid: false, guestCount: 0 } }, 'events/e1/guests': {}, 'events/e1/requests': {} },
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#payment-gate')).toBeHidden();
  await page.getByRole('button', { name: 'القائمة' }).click();
  await expect(page.locator('#payment-menu-item')).toContainText('باقي لك 5 ضيوف مجانًا');
  await page.getByRole('button', { name: 'القائمة' }).click();
  await page.locator('#new-guest-name').fill('ضيف جديد');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('.guest-item')).toHaveCount(1);
});

test('a toast fires exactly when the owner\'s action hits the free-guest cap, not on every page load', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: { events: { e1: { ...EVENT, paid: false, guestCount: 4 } }, 'events/e1/guests': {}, 'events/e1/requests': {} },
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#toast')).not.toContainText('خلصت الـ5 ضيوف');
  await page.locator('#new-guest-name').fill('الضيف الخامس');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('#toast')).toContainText('خلصت الـ5 ضيوف المجانيين');
  await expect(page.locator('#payment-gate')).toBeVisible();
});

test('an unpaid event at the free-guest cap blocks the owner from adding more, and shows the payment gate', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: { events: { e1: { ...EVENT, paid: false, guestCount: 5 } }, 'events/e1/guests': {}, 'events/e1/requests': {} },
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#payment-gate')).toBeVisible();
  await page.locator('#new-guest-name').fill('ضيف جديد');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('.guest-item')).toHaveCount(0);
});

test('CSV import fills only up to the remaining free slots, then stops', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: { events: { e1: { ...EVENT, paid: false, guestCount: 3 } }, 'events/e1/guests': {}, 'events/e1/requests': {} },
  });
  page.on('dialog', d => d.accept());
  await page.goto('/event.html?id=e1');
  await page.locator('#csv-import').setInputFiles({
    name: 'guests.csv', mimeType: 'text/csv',
    buffer: Buffer.from('Guest A\nGuest B\nGuest C\nGuest D\nGuest E'),
  });
  await expect(page.locator('.guest-item')).toHaveCount(2);
  await expect(page.locator('#payment-gate')).toBeVisible();
});

test('a paid event lets the owner add a guest normally, and hides the payment gate', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: { events: { e1: { ...EVENT, paid: true } }, 'events/e1/guests': {}, 'events/e1/requests': {} },
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#payment-gate')).toBeHidden();
  await page.locator('#new-guest-name').fill('ضيف جديد');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('.guest-item')).toHaveCount(1);
});

test('the owner sees a live toast and the gate lifts when the event is activated while the page is open', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: { events: { e1: { ...EVENT, paid: false, guestCount: 5 } }, 'events/e1/guests': {}, 'events/e1/requests': {} },
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#payment-gate')).toBeVisible();
  await page.evaluate(() => {
    const { doc, updateDoc } = window._fsFns;
    return updateDoc(doc(window._db, 'events', 'e1'), { paid: true });
  });
  await expect(page.locator('#toast')).toContainText('تم تفعيل مناسبتك');
  await expect(page.locator('#payment-gate')).toBeHidden();
});

// Admin: activating an event means typing the number of guests it may have.
// Answers the prompt with `answer` (null = cancel) and accepts any confirm.
function answerPrompt(page, answer) {
  const seen = { prompts: [], alerts: [], confirms: [] };
  page.on('dialog', d => {
    if (d.type() === 'prompt') { seen.prompts.push(d.message()); return answer === null ? d.dismiss() : d.accept(String(answer)); }
    if (d.type() === 'alert') seen.alerts.push(d.message());
    if (d.type() === 'confirm') seen.confirms.push(d.message());
    return d.accept();
  });
  return seen;
}
const adminEvent = (extra) => ({
  user: { uid: 'admin-uid', email: 'hsallah@outlook.sa' },
  store: { events: { e1: { ...EVENT, ownerUid: 'u1', paid: false, guestCount: 0, ...extra } }, 'events/e1/guests': {}, 'events/e1/requests': {} },
});
const storedEvent = (page) => page.evaluate(() => window.__fakeFirebase.store.events.e1);

test('the admin cannot activate an event without a number: cancelling the prompt leaves it unactivated', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, adminEvent({}));
  const seen = answerPrompt(page, null);
  await page.goto('/event.html?id=e1');
  await page.getByRole('button', { name: 'القائمة' }).click();
  await expect(page.locator('#payment-menu-item')).toContainText('تفعيل (أدمن)');
  await page.locator('#payment-menu-item').click();
  await page.getByRole('button', { name: 'القائمة' }).click();
  await expect(page.locator('#payment-menu-item')).toContainText('تفعيل (أدمن)');
  expect(seen.prompts).toHaveLength(1);
  const ev = await storedEvent(page);
  expect(ev.paid).toBe(false);
  expect(ev.guestLimit).toBeUndefined();
});

test('the admin activates an event by typing the number of guests, and it is saved with it', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, adminEvent({}));
  answerPrompt(page, 150);
  await page.goto('/event.html?id=e1');
  await page.getByRole('button', { name: 'القائمة' }).click();
  await page.locator('#payment-menu-item').click();
  await page.getByRole('button', { name: 'القائمة' }).click();
  await expect(page.locator('#payment-menu-item')).toContainText('مفعّلة (150 ضيف) — تعديل الحد');
  const ev = await storedEvent(page);
  expect(ev.paid).toBe(true);
  expect(ev.guestLimit).toBe(150);
});

test('the admin can type the number with Eastern Arabic digits', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, adminEvent({}));
  answerPrompt(page, '١٢٠');
  await page.goto('/event.html?id=e1');
  await page.getByRole('button', { name: 'القائمة' }).click();
  await page.locator('#payment-menu-item').click();
  expect((await storedEvent(page)).guestLimit).toBe(120);
});

for (const [label, answer] of [['text', 'كثير'], ['a decimal', '12.5'], ['a negative number', '-5'], ['zero on an event that is not activated', '0'], ['a number over the maximum', '2001'], ['an empty answer', '']]) {
  test('an invalid answer (' + label + ') saves nothing', async ({ page }) => {
    await stubFirebase(page);
    await seedFakeFirebase(page, adminEvent({}));
    const seen = answerPrompt(page, answer);
    await page.goto('/event.html?id=e1');
    await page.getByRole('button', { name: 'القائمة' }).click();
    await page.locator('#payment-menu-item').click();
    await expect.poll(() => seen.prompts.length).toBe(1);
    const ev = await storedEvent(page);
    expect(ev.paid).toBe(false);
    expect(ev.guestLimit).toBeUndefined();
  });
}

test('a very large number asks for confirmation, and declining it saves nothing', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, adminEvent({}));
  page.on('dialog', d => d.type() === 'prompt' ? d.accept('1500') : d.dismiss());
  await page.goto('/event.html?id=e1');
  await page.getByRole('button', { name: 'القائمة' }).click();
  await page.locator('#payment-menu-item').click();
  await page.getByRole('button', { name: 'القائمة' }).click();
  await expect(page.locator('#payment-menu-item')).toContainText('تفعيل (أدمن)');
  expect((await storedEvent(page)).guestLimit).toBeUndefined();
});

test('the admin can change the number later, and 0 switches the event back to the free tier', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, adminEvent({ paid: true, guestLimit: 50 }));
  let answer = '80';
  page.on('dialog', d => d.type() === 'prompt' ? d.accept(answer) : d.accept());
  await page.goto('/event.html?id=e1');
  await page.getByRole('button', { name: 'القائمة' }).click();
  await expect(page.locator('#payment-menu-item')).toContainText('مفعّلة (50 ضيف) — تعديل الحد');
  await page.locator('#payment-menu-item').click();
  await page.getByRole('button', { name: 'القائمة' }).click();
  await expect(page.locator('#payment-menu-item')).toContainText('مفعّلة (80 ضيف)');
  expect((await storedEvent(page)).guestLimit).toBe(80);

  answer = '0';
  await page.locator('#payment-menu-item').click();
  await page.getByRole('button', { name: 'القائمة' }).click();
  await expect(page.locator('#payment-menu-item')).toContainText('تفعيل (أدمن)');
  const ev = await storedEvent(page);
  expect(ev.paid).toBe(false);
  expect(ev.guestLimit).toBeUndefined();
});

test('setting a limit below the current guest count warns the admin first', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, adminEvent({ guestCount: 30 }));
  const seen = answerPrompt(page, 10);
  await page.goto('/event.html?id=e1');
  await page.getByRole('button', { name: 'القائمة' }).click();
  await page.locator('#payment-menu-item').click();
  await expect.poll(() => seen.confirms.length).toBe(1);
  expect(seen.confirms[0]).toContain('30');
});

test('an activated event stops at the admin-set number: the owner is blocked, sees "N of M", and the WhatsApp message asks to raise it', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: { events: { e1: { ...EVENT, paid: true, guestLimit: 3, guestCount: 2 } }, 'events/e1/guests': {}, 'events/e1/requests': {} },
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#payment-gate')).toBeHidden();
  await page.getByRole('button', { name: 'القائمة' }).click();
  await expect(page.locator('#payment-menu-item')).toContainText('2 من 3 ضيوف');
  await page.getByRole('button', { name: 'القائمة' }).click();

  await page.locator('#new-guest-name').fill('الثالث');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('.guest-item')).toHaveCount(1);
  await expect(page.locator('#toast')).toContainText('وصلت لحد الضيوف (3)');
  await expect(page.locator('#payment-gate')).toBeVisible();
  await expect(page.locator('#pg-title')).toContainText('لحد الضيوف (3)');

  await page.locator('#new-guest-name').fill('الرابع');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('.guest-item')).toHaveCount(1);
  expect((await storedEvent(page)).guestCount).toBe(3);

  await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); }; });
  await page.getByRole('button', { name: /واتساب/ }).click();
  const opened = await page.evaluate(() => window.__opened);
  expect(opened).toHaveLength(1);
  expect(decodeURIComponent(opened[0])).toContain('أزيد عدد الضيوف');
});

test('CSV import stops at the admin-set number and says how many names were left out', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: { events: { e1: { ...EVENT, paid: true, guestLimit: 4, guestCount: 1 } }, 'events/e1/guests': {}, 'events/e1/requests': {} },
  });
  const messages = [];
  page.on('dialog', d => { messages.push(d.message()); d.accept(); });
  await page.goto('/event.html?id=e1');
  await page.locator('#csv-import').setInputFiles({
    name: 'guests.csv', mimeType: 'text/csv',
    buffer: Buffer.from('A\nB\nC\nD\nE'),
  });
  await expect(page.locator('.guest-item')).toHaveCount(3);
  expect(messages.join(' ')).toContain('وصلت لحد الـ4 ضيوف، وما انضاف 2 اسمين');
  expect((await storedEvent(page)).guestCount).toBe(4);
});

test('the owner sees a live toast when the admin raises the number while the page is open, and can add again', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: { events: { e1: { ...EVENT, paid: true, guestLimit: 5, guestCount: 5 } }, 'events/e1/guests': {}, 'events/e1/requests': {} },
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#payment-gate')).toBeVisible();
  await page.evaluate(() => {
    const { doc, updateDoc } = window._fsFns;
    return updateDoc(doc(window._db, 'events', 'e1'), { guestLimit: 100 });
  });
  await expect(page.locator('#toast')).toContainText('تم تحديث حد الضيوف إلى 100');
  await expect(page.locator('#payment-gate')).toBeHidden();
  await page.locator('#new-guest-name').fill('ضيف');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('.guest-item')).toHaveCount(1);
});

test('an event activated before limits existed stays unlimited, and the admin sees that it has no number', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: { events: { e1: { ...EVENT, paid: true, guestCount: 400 } }, 'events/e1/guests': {}, 'events/e1/requests': {} },
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#payment-gate')).toBeHidden();
  await page.locator('#new-guest-name').fill('ضيف');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('.guest-item')).toHaveCount(1);
});

test('an unlimited older event shows the admin "no limit" and lets them give it a number', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, adminEvent({ paid: true }));
  answerPrompt(page, 200);
  await page.goto('/event.html?id=e1');
  await page.getByRole('button', { name: 'القائمة' }).click();
  await expect(page.locator('#payment-menu-item')).toContainText('مفعّلة (بلا حد)');
  await page.locator('#payment-menu-item').click();
  await page.getByRole('button', { name: 'القائمة' }).click();
  await expect(page.locator('#payment-menu-item')).toContainText('مفعّلة (200 ضيف)');
});

test('a one-tap toolbar shortcut jumps back to "all my events" without opening the menu first', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'admin-uid', email: 'hsallah@outlook.sa' },
    store: { events: { e1: { ...EVENT, ownerUid: 'u1' } }, 'events/e1/guests': {}, 'events/e1/requests': {} },
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  // Not inside the (initially hidden) dropdown menu — a direct toolbar button.
  await expect(page.locator('#top-menu')).toBeHidden();
  await page.locator('.toolbar > .icon-btn[title="كل مناسباتي"]').click();
  await expect(page).toHaveURL(/app\.html$/);
});

test('regenerating the scanner door code updates the display and the stored event, so old unlocked devices get locked out', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: baseStore([]),
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#scan-pin-display')).toHaveText('1234');

  page.on('dialog', d => d.accept());
  await page.getByRole('button', { name: 'كود جديد' }).click();
  await expect(page.locator('#toast')).toContainText('تم توليد كود جديد');
  await expect(page.locator('#scan-pin-display')).not.toHaveText('1234');

  const storedPin = await page.evaluate(() => window.__fakeFirebase.store['events/e1/private'].scan.scanPin);
  const displayedPin = await page.locator('#scan-pin-display').textContent();
  expect(storedPin).toBe(displayedPin);
  // New codes are six digits (a million possibilities) — four was too easy
  // to try in full when there's no way to count wrong attempts.
  expect(storedPin).toMatch(/^[1-9]\d{5}$/);
});

test('generated door codes are always six digits and do not repeat', async ({ page }) => {
  await page.goto('/index.html'); // any page will do; the function is pure — load event.html's script directly
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'event.html'), 'utf8');
  const fn = src.match(/function generatePin\(\) \{[\s\S]*?\n\}/)[0];
  const codes = await page.evaluate((code) => {
    const generate = new Function(code + '; return generatePin;')();
    return Array.from({ length: 2000 }, () => generate());
  }, fn);
  for (const c of codes) expect(c).toMatch(/^[1-9]\d{5}$/);
  // 2000 draws from 900,000 possibilities: a handful of repeats is normal,
  // but a constant or tiny-range generator would collapse far below this.
  expect(new Set(codes).size).toBeGreaterThan(1900);
});

test('declining the "generate a new code" confirm leaves the old scanner code in place', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: baseStore([]),
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();

  page.on('dialog', d => d.dismiss());
  await page.getByRole('button', { name: 'كود جديد' }).click();
  await expect(page.locator('#scan-pin-display')).toHaveText('1234');
});

test('a dropped connection while loading the dashboard shows a tappable retry instead of hanging on "جاري التحميل..." forever', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: baseStore([]),
  });
  await page.addInitScript(() => { window.__failNextGetDoc = true; });
  await page.goto('/event.html?id=e1');

  const msg = page.locator('#loading-msg');
  await expect(msg).toContainText('تعذّر الاتصال');
  await msg.click();
  await expect(page.locator('#dashboard')).toBeVisible();
});

function stubNotificationApi(page, { initialPermission = 'default' } = {}) {
  return page.addInitScript((initialPermission) => {
    window.__notifications = [];
    class FakeNotification {
      constructor(title, opts) { window.__notifications.push({ title, opts }); }
    }
    FakeNotification.permission = initialPermission;
    FakeNotification.requestPermission = () => { FakeNotification.permission = 'granted'; return Promise.resolve('granted'); };
    window.Notification = FakeNotification;
  }, initialPermission);
}

test('the owner can enable request notifications from the menu', async ({ page }) => {
  await stubFirebase(page);
  await stubNotificationApi(page, { initialPermission: 'default' });
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: baseStore([]),
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();

  await page.getByRole('button', { name: 'القائمة' }).click();
  await page.getByRole('button', { name: 'تفعيل إشعارات الطلبات' }).click();
  await expect(page.locator('#toast')).toContainText('تم تفعيل إشعارات الطلبات');

  await page.getByRole('button', { name: 'القائمة' }).click();
  await expect(page.getByRole('button', { name: /إشعارات الطلبات مفعّلة/ })).toBeVisible();
});

test('a new guest request triggers a real notification once enabled, but not requests already pending on load', async ({ page }) => {
  await stubFirebase(page);
  await stubNotificationApi(page, { initialPermission: 'granted' });
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: {
      events: { e1: EVENT },
      'events/e1/guests': {},
      'events/e1/requests': { r1: { name: 'طلب قديم', status: 'pending', reqId: 'WD-OLD', createdAt: { seconds: 1 } } },
    },
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#requests-badge')).toHaveText('1');

  // A request that was already pending when the page loaded must not fire
  // a notification — only ones that arrive while this device is watching.
  expect(await page.evaluate(() => window.__notifications.length)).toBe(0);

  await page.evaluate(() => {
    const { collection, addDoc } = window._fsFns;
    return addDoc(collection(window._db, 'events', 'e1', 'requests'), {
      name: 'ضيف جديد', status: 'pending', reqId: 'WD-NEW', createdAt: { seconds: 2 },
    });
  });

  await expect(page.locator('#requests-badge')).toHaveText('2');
  const notifs = await page.evaluate(() => window.__notifications);
  expect(notifs.length).toBe(1);
  expect(notifs[0].opts.body).toContain('ضيف جديد');
});

test('an older event still carrying its door code on the (public) event doc gets it moved into the private doc on open', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: { events: { e1: { ...EVENT, scanPin: '4321' } }, 'events/e1/guests': {}, 'events/e1/requests': {} },
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#scan-pin-display')).toHaveText('4321');
  const after = await page.evaluate(() => ({
    privatePin: window.__fakeFirebase.store['events/e1/private'].scan.scanPin,
    publicPin: window.__fakeFirebase.store.events.e1.scanPin,
  }));
  expect(after.privatePin).toBe('4321');
  expect(after.publicPin).toBeUndefined();
  await expect(page.locator('#rules-warning')).toBeHidden();
});

test('until the new security rules are deployed, the dashboard keeps the old behavior and warns only the admin', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'admin-uid', email: 'hsallah@outlook.sa' },
    store: { events: { e1: { ...EVENT, scanPin: '4321' } }, 'events/e1/guests': {}, 'events/e1/requests': {} },
  });
  // Old rules have no /private path at all — reading it is denied.
  await page.addInitScript(() => { window.__fakeFirebase.denyPaths = ['events/e1/private']; });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#scan-pin-display')).toHaveText('4321');
  await expect(page.locator('#rules-warning')).toBeVisible();
  const store = await page.evaluate(() => window.__fakeFirebase.store);
  expect(store['events/e1/private']).toBeUndefined();
  expect(store.events.e1.scanPin).toBe('4321');
});

test('a customer never sees the rules-not-deployed warning, and an event with no code at all still gets one', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: { events: { e1: EVENT }, 'events/e1/guests': {}, 'events/e1/requests': {} },
  });
  await page.addInitScript(() => { window.__fakeFirebase.denyPaths = ['events/e1/private']; });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#scan-pin-display')).toHaveText(/^\d{6}$/);
  await expect(page.locator('#rules-warning')).toBeHidden();
  const publicPin = await page.evaluate(() => window.__fakeFirebase.store.events.e1.scanPin);
  expect(publicPin).toMatch(/^\d{6}$/);
});

test('approving a guest request copies the new barcode id onto the request, for the invite page to read', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: {
      events: { e1: { ...EVENT, paid: true } },
      'events/e1/guests': {},
      'events/e1/private': { scan: { scanPin: '1234' } },
      'events/e1/requests': { r1: { name: 'ضيف طالب', reqId: 'REQ-1', status: 'pending', createdAt: 'x' } },
    },
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.getByRole('button', { name: 'القائمة' }).click();
  await page.getByRole('button', { name: /^الطلبات/ }).click();
  await page.locator('.approve-btn').click();
  await expect(page.locator('#toast')).toContainText('تمت الموافقة');
  const state = await page.evaluate(() => {
    const s = window.__fakeFirebase.store;
    const g = s['events/e1/guests'];
    const [key, guest] = Object.entries(g)[0];
    return { request: s['events/e1/requests'].r1, guestId: guest.id, docKey: key };
  });
  expect(state.request.status).toBe('approved');
  expect(state.guestId).toMatch(/^WD-/);
  expect(state.request.guestId).toBe(state.guestId);
  // Same rule as a manually-added guest: doc key === the barcode id.
  expect(state.docKey).toBe(state.guestId);
});

test('opening the dashboard does not read the approved requests (no backfill query)', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: {
      events: { e1: EVENT },
      'events/e1/guests': { g1: { id: 'WD-OLD1', name: 'ضيف قديم', reqId: 'REQ-OLD', scanned: false } },
      'events/e1/private': { scan: { scanPin: '1234' } },
      'events/e1/requests': { r1: { name: 'ضيف قديم', reqId: 'REQ-OLD', status: 'approved', createdAt: 'x' } },
    },
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window.__fakeFirebase.getDocsPaths || []).filter(p => p === 'events/e1/requests').length)).toBe(0);
});

test('the dashboard shows the event date as words with Western digits', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: baseStore([]),
  });
  await page.addInitScript(() => { window.__fakeFirebase.store.events.e1 = { ...window.__fakeFirebase.store.events.e1, date: '2026-10-29' }; });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#ev-sub')).toContainText('الخميس 29 أكتوبر 2026');
});

test('the menu has a refresh button that forces a real reload — no address bar to pull down on, installed as a PWA', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: baseStore([]) });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.getByRole('button', { name: 'القائمة' }).click();
  await page.evaluate(() => { window.__beforeReload = true; });
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'تحديث الصفحة' }).click()]);
  expect(await page.evaluate(() => window.__beforeReload)).toBeUndefined();
});

test('the dashboard keeps the door scanner\'s names list as one roster document, so a scanner open is 1 read instead of one per guest', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: baseStore([{ id: 'WD-1', name: 'أحمد', scanned: true }, { id: 'WD-2', name: 'سارة | الثانية', scanned: false }]),
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  const roster = () => page.evaluate(() => {
    const r = (window.__fakeFirebase.store['events/e1/roster'] || {}).list;
    return r ? r.guests.slice().sort() : null;
  });
  await expect.poll(roster, { timeout: 10000 }).toEqual(['WD-1|1|أحمد', 'WD-2|0|سارة | الثانية']);
});

test('an empty guest list says why: no match for the search, nobody attended yet, or everyone attended', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: baseStore([{ id: 'WD-1', name: 'أحمد', scanned: false }]),
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('.guest-item')).toHaveCount(1);
  const empty = page.locator('#guests-list .empty');

  await page.locator('#guest-search').fill('حسن');
  await expect(empty).toHaveText('لا يوجد ضيف بهذا الاسم');
  await page.locator('#guest-search').fill('');
  await expect(page.locator('.guest-item')).toHaveCount(1);

  await page.locator('#box-attended').click();
  await expect(empty).toHaveText('ما حضر أحد للآن');
  await page.locator('#box-pending').click();
  await expect(page.locator('.guest-item')).toHaveCount(1);
});

test('a brand-new event with no guests still says "لا يوجد ضيف للآن"', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: baseStore([]) });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#guests-list .empty')).toHaveText('لا يوجد ضيف للآن');
});

test('a dashboard whose first read never answers turns "جاري التحميل..." into a tap-to-retry after 12 seconds', async ({ page }) => {
  await page.clock.install();
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: baseStore([]) });
  await page.addInitScript(() => { window.__hangGetDoc = true; });
  await page.goto('/event.html?id=e1');
  const msg = page.locator('#loading-msg');
  await expect(msg).toHaveText('جاري التحميل...');
  await page.clock.runFor(13000);
  await expect(msg).toContainText('التحميل تأخر — اضغط هنا للمحاولة مرة ثانية');
  await page.evaluate(() => { window.__hangGetDoc = false; });
  const reloaded = page.waitForEvent('load');
  await msg.click();
  await reloaded;
});

test('an invalid link message is left alone by the stuck-loading timer', async ({ page }) => {
  await page.clock.install();
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: baseStore([]) });
  await page.goto('/event.html');
  await expect(page.locator('#loading-msg')).toContainText('رابط غير صحيح');
  await page.clock.runFor(13000);
  await expect(page.locator('#loading-msg')).toContainText('رابط غير صحيح');
});

test('marking a guest VIP from the ⋮ menu saves it, shows the badge, and can be undone', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: baseStore([{ id: 'WD-1', name: 'أحمد', scanned: false }]) });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('.guest-item')).toHaveCount(1);
  const vip = () => page.evaluate(() => window.__fakeFirebase.store['events/e1/guests'].g0.vip);

  await page.locator('.guest-item .more-btn').click();
  await page.getByRole('button', { name: /تمييز كـ VIP/ }).click();
  await expect.poll(vip).toBe(true);
  await expect(page.locator('.guest-item .vip-badge')).toHaveText('★ VIP');
  await expect(page.locator('.guest-item')).toHaveClass(/vip/);

  await page.locator('.guest-item .more-btn').click();
  await page.getByRole('button', { name: /إلغاء تمييز VIP/ }).click();
  await expect.poll(vip).toBe(false);
  await expect(page.locator('.guest-item .vip-badge')).toHaveCount(0);
});

test('the guest ⋮ opens a sheet with the guest\'s name, code and status; cancel, the backdrop and Escape close it', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: baseStore([
    { id: 'WD-1', name: 'أحمد', scanned: true, vip: true }, { id: 'WD-2', name: 'سارة', scanned: false },
  ]) });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('.guest-item')).toHaveCount(2);
  const sheet = page.locator('#guest-sheet');
  await expect(sheet).toBeHidden();

  await page.locator('.guest-item', { hasText: 'أحمد' }).locator('.more-btn').click();
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('#gs-name')).toHaveText('أحمد ★ VIP');
  await expect(sheet.locator('#gs-sub')).toHaveText('الكود WD-1 · حضر');
  await expect(sheet.locator('.gs-vip')).toContainText('إلغاء تمييز VIP');
  await sheet.getByRole('button', { name: 'إلغاء', exact: true }).click();
  await expect(sheet).toBeHidden();

  await page.locator('.guest-item', { hasText: 'سارة' }).locator('.more-btn').click();
  await expect(sheet.locator('#gs-sub')).toHaveText('الكود WD-2 · لم يحضر بعد');
  await expect(sheet.locator('.gs-vip')).toContainText('تمييز كـ VIP');
  await page.mouse.click(10, 10);
  await expect(sheet).toBeHidden();

  await page.locator('.guest-item', { hasText: 'سارة' }).locator('.more-btn').click();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // Declining the delete confirm keeps the guest.
  page.once('dialog', d => d.dismiss());
  await page.locator('.guest-item', { hasText: 'سارة' }).locator('.more-btn').click();
  await sheet.locator('.gs-del').click();
  await expect(sheet).toBeHidden();
  await expect(page.locator('.guest-item')).toHaveCount(2);
});

test('a VIP guest\'s card is drawn in the dark VIP design with a gold badge; a normal guest\'s stays light', async ({ page }) => {
  // qrcodejs is a CDN script the test harness blocks; a stand-in draws a
  // non-blank canvas so the card builder gets past its "QR has ink" check.
  await page.addInitScript(() => {
    window.QRCode = function (el) {
      const c = document.createElement('canvas'); c.width = c.height = 256;
      const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, 256, 256); x.fillStyle = '#fff'; x.fillRect(64, 64, 128, 128);
      el.appendChild(c);
    };
    window.QRCode.CorrectLevel = { H: 2, M: 0, L: 1, Q: 3 };
  });
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: baseStore([
    { id: 'WD-1', name: 'ضيف عادي', scanned: false }, { id: 'WD-2', name: 'ضيف مهم', scanned: false, vip: true },
  ]) });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('.guest-item')).toHaveCount(2);
  const sample = (id) => page.evaluate(async (id) => {
    const c = await buildGuestCard(guests.find(g => g.id === id));
    const px = (x, y) => Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data.slice(0, 3));
    return { bg: px(60, 700), badge: px(440, 206) };
  }, id);
  const normal = await sample('WD-1');
  const vip = await sample('WD-2');
  expect(Math.max(...normal.bg)).toBeGreaterThan(200);   // light background
  expect(Math.max(...vip.bg)).toBeLessThan(40);          // dark background
  expect(vip.badge[0]).toBeGreaterThan(150);             // gold badge (reddish-yellow)
  expect(vip.badge[2]).toBeLessThan(vip.badge[0]);
});

test('the invite link\'s share button opens a WhatsApp preview built from the event; the welcome line is editable, saved and sent via wa.me', async ({ page }) => {
  await page.addInitScript(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: { ...baseStore([]),
    events: { e1: { ...EVENT, name: 'حفل تخرج نورة', type: 'graduation', date: '2026-12-20', venue: 'الدمام', mapsLink: 'https://maps.example/x', slug: 'noura-grad' } } } });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#invite-link')).toHaveValue(/\/noura-grad$/);
  await page.locator('#invite-link').locator('xpath=..').getByRole('button', { name: 'مشاركة' }).click();
  const modal = page.locator('#share-modal');
  await expect(modal).toBeVisible();
  const preview = modal.locator('#share-preview');
  await expect(preview).toContainText('🎓 دعوة حفل تخرج ✨');
  await expect(preview.locator('b').first()).toHaveText('🎓 دعوة حفل تخرج ✨');   // *…* drawn bold
  await expect(preview).toContainText('الحفل: حفل تخرج نورة');
  await expect(preview).toContainText('التاريخ: الأحد 20 ديسمبر 2026');
  await expect(preview).toContainText('المكان: الدمام');
  await expect(preview).toContainText('الموقع: https://maps.example/x');
  await expect(preview).toContainText('يسعدنا حضوركم ومشاركتنا فرحة التخرج');
  await expect(preview).toContainText('/noura-grad');
  await expect(modal.locator('#share-welcome')).toHaveAttribute('maxlength', '400');

  await modal.locator('#share-welcome').fill('حياكم الله في حفل تخرج نورة');
  await expect(preview).toContainText('حياكم الله في حفل تخرج نورة');
  await expect(modal.locator('#share-count')).toHaveText('27 / 400');
  await modal.getByRole('button', { name: /مشاركة عبر الواتساب/ }).click();
  const opened = await page.evaluate(() => window.__opened);
  expect(opened).toHaveLength(1);
  expect(opened[0].startsWith('https://wa.me/?text=')).toBe(true);
  const text = decodeURIComponent(opened[0].split('text=')[1]);
  expect(text.split('\n')[0]).toBe('*🎓 دعوة حفل تخرج ✨*');
  expect(text).toContain('حياكم الله في حفل تخرج نورة');
  expect(text.trim().endsWith('/noura-grad')).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__fakeFirebase.store.events.e1.welcomeMessage)).toBe('حياكم الله في حفل تخرج نورة');

  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
});

test('the owner can change the event\'s kind in the edit card; an event saved before kinds existed shows as a wedding', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: { ...baseStore([]), events: { e1: { ...EVENT, slug: '' } } } });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.getByRole('button', { name: 'القائمة' }).click();
  await page.getByRole('button', { name: /تعديل المناسبة/ }).click();
  await expect(page.locator('#edit-ev-type').getByRole('radio', { name: 'زفاف' })).toHaveAttribute('aria-checked', 'true');
  await page.locator('#edit-ev-type').getByRole('radio', { name: 'تخرج' }).click();
  await page.getByRole('button', { name: 'حفظ التعديل' }).click();
  await expect.poll(() => page.evaluate(() => window.__fakeFirebase.store.events.e1.type)).toBe('graduation');
  // The colour is the owner's own choice and stays as it was.
  expect(await page.evaluate(() => window.__fakeFirebase.store.events.e1.theme)).toBe('gold');
});

test('an event with no link yet gets one from its name when the owner opens it, skipping a taken name', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: { ...baseStore([]), slugs: { 'hfl-tjreebi': { eventId: 'other', ownerUid: 'u9', createdAt: 'x' } } } });
  await page.goto('/event.html?id=e1');
  const store = () => page.evaluate(() => ({ slugs: window.__fakeFirebase.store.slugs, slug: window.__fakeFirebase.store.events.e1.slug }));
  await expect.poll(async () => (await store()).slug).toBe('hfl-tjreebi-2');
  expect((await store()).slugs['hfl-tjreebi-2']).toMatchObject({ eventId: 'e1', ownerUid: 'u1' });
  expect((await store()).slugs['hfl-tjreebi']).toMatchObject({ eventId: 'other' });
  await expect(page.locator('#invite-link')).toHaveValue(/\/hfl-tjreebi-2$/);
  await page.getByRole('button', { name: 'القائمة' }).click();
  await page.getByRole('button', { name: /تعديل المناسبة/ }).click();
  await expect(page.locator('#edit-ev-slug')).toHaveValue('hfl-tjreebi-2');
});

test('the admin opening a customer\'s event does not pick a link for it', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'admin1', email: 'hsallah@outlook.sa' }, store: baseStore([{ id: 'WD-1', name: 'أحمد', scanned: false }]) });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('.guest-item')).toHaveCount(1);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__fakeFirebase.store.events.e1.slug)).toBeUndefined();
  await expect(page.locator('#invite-link')).toHaveValue(/invite\.html\?event=e1$/);
});

test('a readable link: the owner picks a name, it is claimed in slugs/, and the invite link shows it', async ({ page }) => {
  await stubFirebase(page);
  // slug '' = the owner cleared the link, so no name is picked automatically.
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: { ...baseStore([]), events: { e1: { ...EVENT, slug: '' } }, slugs: { 'taken-name': { eventId: 'other', ownerUid: 'u9', createdAt: 'x' } } } });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  const alerts = [];
  page.on('dialog', d => { alerts.push(d.message()); d.accept(); });
  const store = () => page.evaluate(() => ({ slugs: window.__fakeFirebase.store.slugs || {}, slug: window.__fakeFirebase.store.events.e1.slug }));
  const openEdit = async () => { await page.getByRole('button', { name: 'القائمة' }).click(); await page.getByRole('button', { name: /تعديل المناسبة/ }).click(); };

  // Arabic / bad characters are refused before anything is written.
  await openEdit();
  await page.locator('#edit-ev-slug').fill('حلا تركي');
  await page.getByRole('button', { name: 'حفظ التعديل' }).click();
  await expect.poll(() => alerts.length).toBe(1);
  expect(alerts[0]).toContain('بالإنجليزي');
  expect((await store()).slug).toBe('');

  // A name someone else holds is refused.
  await page.locator('#edit-ev-slug').fill('taken-name');
  await page.getByRole('button', { name: 'حفظ التعديل' }).click();
  await expect.poll(() => alerts.length).toBe(2);
  expect(alerts[1]).toContain('مستخدم');

  // A free name: claimed, saved on the event, and the invite link uses it.
  await page.locator('#edit-ev-slug').fill('Hala Turki');
  await page.getByRole('button', { name: 'حفظ التعديل' }).click();
  await expect.poll(async () => (await store()).slug).toBe('hala-turki');
  expect((await store()).slugs['hala-turki']).toMatchObject({ eventId: 'e1', ownerUid: 'u1' });
  await expect(page.locator('#invite-link')).toHaveValue(/\/hala-turki$/);

  // Changing it releases the old name.
  await openEdit();
  await expect(page.locator('#edit-ev-slug')).toHaveValue('hala-turki');
  await page.locator('#edit-ev-slug').fill('hala-2026');
  await page.getByRole('button', { name: 'حفظ التعديل' }).click();
  await expect.poll(async () => (await store()).slug).toBe('hala-2026');
  const s = (await store()).slugs;
  expect(s['hala-turki']).toBeUndefined();
  expect(s['hala-2026']).toMatchObject({ eventId: 'e1' });
});

test('the name, venue and map link inputs limit typing to 80, 100 and 300 characters', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: baseStore([]) });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#edit-ev-name')).toHaveAttribute('maxlength', '80');
  await expect(page.locator('#edit-ev-venue')).toHaveAttribute('maxlength', '100');
  await expect(page.locator('#edit-ev-maps')).toHaveAttribute('maxlength', '300');
});

const SHARE_BTN = (page) => page.locator('#invite-link').locator('xpath=..').getByRole('button', { name: 'مشاركة' });

test('a welcome line equal to the kind\'s default is stored as an empty string', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: { ...baseStore([]),
    events: { e1: { ...EVENT, slug: 'x-ev', welcomeMessage: 'نص خاص' } } } });
  await page.goto('/event.html?id=e1');
  await SHARE_BTN(page).click();
  await page.locator('#share-welcome').fill('يسعدنا حضوركم ومشاركتنا فرحتنا 🤍');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__fakeFirebase.store.events.e1.welcomeMessage)).toBe('');
});

test('HTML in the welcome line and the event name is shown as text in the share preview', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: { ...baseStore([]),
    events: { e1: { ...EVENT, slug: 'x-ev', name: '<img id="xn" src=x onerror="window.__x=1">' } } } });
  await page.goto('/event.html?id=e1');
  await SHARE_BTN(page).click();
  await page.locator('#share-welcome').fill('<img id="xw" src=x onerror="window.__x=1">');
  const preview = page.locator('#share-preview');
  await expect(preview).toContainText('<img id="xw"');
  await expect(preview).toContainText('<img id="xn"');
  await expect(preview.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__x)).toBeUndefined();
});

test('the share button opens the payment WhatsApp, not the preview, when the free limit is reached', async ({ page }) => {
  await page.addInitScript(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: { ...baseStore([]),
    events: { e1: { ...EVENT, slug: 'x-ev', paid: false, guestCount: 5 } } } });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#payment-gate')).toBeVisible();
  await SHARE_BTN(page).click();
  await expect(page.locator('#share-modal')).toBeHidden();
  const opened = await page.evaluate(() => window.__opened);
  expect(opened).toHaveLength(1);
  expect(decodeURIComponent(opened[0])).toContain('أبي أفعّل مناسبة');
});

test('a failed welcome save tells the owner and still closes the modal', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: { ...baseStore([]), events: { e1: { ...EVENT, slug: 'x-ev' } } } });
  await page.goto('/event.html?id=e1');
  await SHARE_BTN(page).click();
  await page.evaluate(() => { window._fsFns.updateDoc = () => Promise.reject(new Error('offline')); });
  await page.locator('#share-welcome').fill('رسالة جديدة');
  await page.keyboard.press('Escape');
  await expect(page.locator('#share-modal')).toBeHidden();
  await expect(page.locator('#toast')).toContainText('ما انحفظت رسالة الترحيب');
});

for (const [kind, title, file] of [['wedding', 'دعوة زفاف', 'kind-wedding.svg'], ['graduation', 'دعوة حفل تخرج', 'kind-graduation.svg'], ['event', 'دعوة فعالية', 'kind-event.svg']]) {
  test(`the organizer splash shows the remembered ${kind} kind at once`, async ({ page }) => {
    await stubFirebase(page);
    await page.addInitScript((k) => { try { localStorage.setItem('ev_kind_nope', k); } catch (e) {} }, kind);
    await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: { events: {} } });
    await page.goto('/event.html?id=nope');
    await expect(page.locator('#splash .splash-title')).toHaveText(title);
    await expect(page.locator('#splash .splash-rings img')).toHaveAttribute('src', 'icons/' + file);
  });
}

test('the organizer splash starts neutral with nothing remembered, then switches to the event kind and remembers it', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: { ...baseStore([]), events: { e1: { ...EVENT, type: 'graduation' } } },
  });
  await page.addInitScript(() => { window.__firstKind = null; document.addEventListener('DOMContentLoaded', () => { const i = document.querySelector('#splash .splash-rings img'); window.__firstKind = i && i.getAttribute('src'); }); });
  await page.goto('/event.html?id=e1');
  expect(await page.evaluate(() => window.__firstKind)).toBe('icons/logo.svg');
  await expect(page.locator('#splash .splash-title')).toHaveText('دعوة حفل تخرج');
  await expect(page.locator('#splash .splash-rings img')).toHaveAttribute('src', 'icons/kind-graduation.svg');
  expect(await page.evaluate(() => localStorage.getItem('ev_kind_e1'))).toBe('graduation');
});

test('an event with no type remembers as a wedding', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, { user: { uid: 'u1', email: 'customer@example.com' }, store: baseStore([]) });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('ev_kind_e1'))).toBe('wedding');
});

for (const [label, next] of [['anonymous', { uid: 'anon-9', isAnonymous: true, email: null }], ['signed out', null]]) {
  test('cross-tab auth: when another tab leaves the user ' + label + ', the dashboard shows the session-ended message and no connection banner, and returning reloads', async ({ page }) => {
    await stubFirebase(page);
    await seedFakeFirebase(page, {
      user: { uid: 'u1', email: 'customer@example.com' },
      store: baseStore([{ id: 'WD-1', name: 'أحمد', scanned: false }]),
    });
    await page.goto('/event.html?id=e1');
    await expect(page.locator('#dashboard')).toBeVisible();
    await page.evaluate(() => { window.__marker = 1; });

    await page.evaluate((u) => {
      const a = window.__fakeFirebase.auth;
      a.user = u;
      a.listeners.slice().forEach(cb => cb(a.user));
    }, next);
    await expect(page.locator('#denied-msg')).toContainText('انتهت جلسة الدخول على هذا المتصفح');
    await expect(page.locator('#denied-msg a')).toHaveAttribute('href', 'app.html');
    await expect(page.locator('#dashboard')).toBeHidden();
    await page.waitForTimeout(300);
    await expect(page.locator('#connection-banner')).toBeHidden();
    expect(await page.evaluate(() => window.__marker)).toBe(1);

    const reloaded = page.waitForEvent('load');
    await page.evaluate(() => {
      const a = window.__fakeFirebase.auth;
      a.user = { uid: 'u1', email: 'customer@example.com' };
      a.listeners.slice().forEach(cb => cb(a.user));
    });
    await reloaded;
    expect(await page.evaluate(() => window.__marker)).toBeUndefined();
    await expect(page.locator('#dashboard')).toBeVisible();
  });
}

test('importing names and approving a request schedule a roster write for the door scanner', async ({ page }) => {
  test.setTimeout(90000);
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: {
      events: { e1: { ...EVENT, paid: true } },
      'events/e1/guests': {},
      'events/e1/private': { scan: { scanPin: '1234' } },
      'events/e1/requests': { r1: { name: 'ضيف طالب', reqId: 'REQ-1', status: 'pending', createdAt: 'x' } },
    },
  });
  page.on('dialog', d => d.accept());
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.evaluate(() => {
    window.__rosterCalls = 0;
    const orig = window.scheduleRosterWrite;
    window.scheduleRosterWrite = function () { window.__rosterCalls++; return orig(); };
  });
  const roster = () => page.evaluate(() => {
    const r = (window.__fakeFirebase.store['events/e1/roster'] || {}).list;
    return r ? r.guests.map(x => x.split('|')[2]).sort() : null;
  });
  await page.locator('#csv-import').setInputFiles({ name: 'guests.csv', mimeType: 'text/csv', buffer: Buffer.from('Guest A\nGuest B') });
  await expect(page.locator('.guest-item')).toHaveCount(2);
  expect(await page.evaluate(() => window.__rosterCalls)).toBeGreaterThanOrEqual(1);
  await expect.poll(roster, { timeout: 10000 }).toEqual(['Guest A', 'Guest B']);

  const before = await page.evaluate(() => window.__rosterCalls);
  await page.getByRole('button', { name: 'القائمة' }).click();
  await page.getByRole('button', { name: /^الطلبات/ }).click();
  await page.locator('.approve-btn').click();
  await expect(page.locator('#toast')).toContainText('تمت الموافقة');
  expect(await page.evaluate(() => window.__rosterCalls)).toBeGreaterThan(before);
  await expect.poll(roster, { timeout: 45000 }).toEqual(['Guest A', 'Guest B', 'ضيف طالب']);
});
