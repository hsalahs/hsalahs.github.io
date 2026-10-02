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
  await page.locator('.guest-item .del-btn').click();

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
  await expect(page.locator('.guest-item .dl-btn')).toHaveText('💾 حفظ');
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
  await page.locator('.guest-item .del-btn').click();
  await expect(page.locator('.guest-item')).toHaveCount(0);

  await expect.poll(() => page.evaluate(() => window.__fakeFirebase.store.events.e1.guestCount)).toBe(0);
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

  await page.getByRole('button', { name: '☰' }).click();
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
  await page.getByRole('button', { name: '☰' }).click();
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

  await page.getByRole('button', { name: '☰' }).click();
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
  await page.getByRole('button', { name: '☰' }).click();
  await expect(page.locator('#payment-menu-item')).toContainText('5 ضيوف مجانيين متبقين');
  await page.getByRole('button', { name: '☰' }).click();
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
  await page.getByRole('button', { name: '☰' }).click();
  await expect(page.locator('#payment-menu-item')).toContainText('تفعيل (أدمن)');
  await page.locator('#payment-menu-item').click();
  await page.getByRole('button', { name: '☰' }).click();
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
  await page.getByRole('button', { name: '☰' }).click();
  await page.locator('#payment-menu-item').click();
  await page.getByRole('button', { name: '☰' }).click();
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
  await page.getByRole('button', { name: '☰' }).click();
  await page.locator('#payment-menu-item').click();
  expect((await storedEvent(page)).guestLimit).toBe(120);
});

for (const [label, answer] of [['text', 'كثير'], ['a decimal', '12.5'], ['a negative number', '-5'], ['zero on an event that is not activated', '0'], ['a number over the maximum', '2001'], ['an empty answer', '']]) {
  test('an invalid answer (' + label + ') saves nothing', async ({ page }) => {
    await stubFirebase(page);
    await seedFakeFirebase(page, adminEvent({}));
    const seen = answerPrompt(page, answer);
    await page.goto('/event.html?id=e1');
    await page.getByRole('button', { name: '☰' }).click();
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
  await page.getByRole('button', { name: '☰' }).click();
  await page.locator('#payment-menu-item').click();
  await page.getByRole('button', { name: '☰' }).click();
  await expect(page.locator('#payment-menu-item')).toContainText('تفعيل (أدمن)');
  expect((await storedEvent(page)).guestLimit).toBeUndefined();
});

test('the admin can change the number later, and 0 switches the event back to the free tier', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, adminEvent({ paid: true, guestLimit: 50 }));
  let answer = '80';
  page.on('dialog', d => d.type() === 'prompt' ? d.accept(answer) : d.accept());
  await page.goto('/event.html?id=e1');
  await page.getByRole('button', { name: '☰' }).click();
  await expect(page.locator('#payment-menu-item')).toContainText('مفعّلة (50 ضيف) — تعديل الحد');
  await page.locator('#payment-menu-item').click();
  await page.getByRole('button', { name: '☰' }).click();
  await expect(page.locator('#payment-menu-item')).toContainText('مفعّلة (80 ضيف)');
  expect((await storedEvent(page)).guestLimit).toBe(80);

  answer = '0';
  await page.locator('#payment-menu-item').click();
  await page.getByRole('button', { name: '☰' }).click();
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
  await page.getByRole('button', { name: '☰' }).click();
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
  await page.getByRole('button', { name: '☰' }).click();
  await expect(page.locator('#payment-menu-item')).toContainText('2 من 3 ضيوف');
  await page.getByRole('button', { name: '☰' }).click();

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
  expect(messages.join(' ')).toContain('وصلت لحد الـ4 ضيوف، 2 اسم ما انضاف');
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
  await page.getByRole('button', { name: '☰' }).click();
  await expect(page.locator('#payment-menu-item')).toContainText('مفعّلة (بلا حد)');
  await page.locator('#payment-menu-item').click();
  await page.getByRole('button', { name: '☰' }).click();
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
  await page.getByRole('button', { name: '🔄 كود جديد' }).click();
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
  await page.getByRole('button', { name: '🔄 كود جديد' }).click();
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

  await page.getByRole('button', { name: '☰' }).click();
  await page.getByRole('button', { name: '🔔 تفعيل إشعارات الطلبات' }).click();
  await expect(page.locator('#toast')).toContainText('تم تفعيل إشعارات الطلبات');

  await page.getByRole('button', { name: '☰' }).click();
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
  await page.getByRole('button', { name: '☰' }).click();
  await page.getByRole('button', { name: /📥 الطلبات/ }).click();
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

test('guests approved before the invite page stopped reading the guests collection get their barcode id backfilled onto their request', async ({ page }) => {
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
  await expect.poll(() => page.evaluate(() => window.__fakeFirebase.store['events/e1/requests'].r1.guestId)).toBe('WD-OLD1');
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
  await page.getByRole('button', { name: '☰' }).click();
  await page.evaluate(() => { window.__beforeReload = true; });
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: '🔄 تحديث الصفحة' }).click()]);
  expect(await page.evaluate(() => window.__beforeReload)).toBeUndefined();
});
