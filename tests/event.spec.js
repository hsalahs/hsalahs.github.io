const { test, expect } = require('@playwright/test');
const { stubSupabase, seedEvent } = require('./helpers');

// event.html on the fake Supabase (tests/mocks/supabase.stub.js). The server state the page works against is
// window.__fakeSupabase: events.e1 (the event row), doors.e1.guests, doors.e1.pin, requests.e1, calls.
const OWNER = { id: 'u1', email: 'customer@example.com' };
const ADMIN = { id: 'admin-uid', email: 'hsallah@outlook.sa' };

// Opens event e1 as `user` (the owner by default). window.open is recorded in window.__opened.
async function go(page, opts = {}, url = '/event.html?id=e1') {
  await stubSupabase(page);
  await seedEvent(page, { user: OWNER, ...opts });
  await page.addInitScript(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
  await page.goto(url);
}
const G = (id, name, extra) => Object.assign({ id, name }, extra);
const fill = (n, prefix) => Array.from({ length: n }, (_, i) => G('WD-FILL' + i, (prefix || 'ضيف ') + (i + 1)));
const server = (page) => page.evaluate(() => {
  const s = window.__fakeSupabase;
  return { event: s.events.e1, guests: s.doors.e1.guests, pin: s.doors.e1.pin, requests: s.requests.e1, slugs: s.slugs, opened: window.__opened };
});
const calls = (page, name) => page.evaluate((n) => window.__fakeSupabase.calls.filter((c) => c.name === n).map((c) => c.args), name);
// Asks the live poll for its answer now instead of waiting for the next 5-second tick.
const syncNow = (page) => page.evaluate(() => liveRefresh());
const menu = (page) => page.getByRole('button', { name: 'القائمة' }).click();

test('adding a guest confirms with a toast, clears and refocuses the field, and blocks a duplicate name', async ({ page }) => {
  await go(page, { guests: [G('WD-1', 'أحمد')] });
  await expect(page.locator('.guest-item')).toHaveCount(1);

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

  // The server gives the new guest its own barcode ("WD-" + 12 hex).
  const saved = (await server(page)).guests.find((g) => g.name === 'سارة');
  expect(saved.id).toMatch(/^WD-[0-9A-F]{12}$/);
  expect(await calls(page, 'add_guests')).toEqual([{ p_event_id: 'e1', p_guests: [{ name: 'سارة' }], p_partial: false }]);

  // Same name again should be rejected as a duplicate within this list.
  await input.fill('سارة');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('#toast')).toContainText('الاسم موجود بالقائمة');
  await expect(page.locator('.guest-item')).toHaveCount(2);
});

test('the add-guest field limits typing to 100 characters, and a longer name is cut to 100 on the server', async ({ page }) => {
  await go(page, { event: { paid: true } });
  await expect(page.locator('#new-guest-name')).toHaveAttribute('maxlength', '100');
  const long = 'س'.repeat(130);
  await page.evaluate((n) => { document.getElementById('new-guest-name').value = n; }, long);
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('.guest-item')).toHaveCount(1);
  const saved = (await server(page)).guests[0];
  expect(Array.from(saved.name)).toHaveLength(100);
});

test('a guest name containing a backslash and a quote does not break the delete button', async ({ page }) => {
  // The onclick handlers embed the guest's name inside a single-quoted JS
  // string literal within an HTML attribute — escapeHtml alone protects the
  // attribute boundary but not that inner string literal. A name ending in
  // a raw backslash used to silently swallow the closing quote, corrupting
  // the whole onclick attribute and leaving the button non-functional.
  const trickyName = "O'Brien\\";
  await go(page, { guests: [G('WD-1', trickyName)] });
  await expect(page.locator('.guest-item')).toHaveCount(1);

  let dialogMessage = '';
  page.on('dialog', (d) => { dialogMessage = d.message(); d.accept(); });
  await page.locator('.guest-item .more-btn').click();
  await page.locator('#guest-sheet .gs-del').click();

  expect(dialogMessage).toContain(trickyName);
  await expect(page.locator('.guest-item')).toHaveCount(0);
});

test('two guests sharing a first name but not a full name are both allowed — the duplicate check compares the whole name', async ({ page }) => {
  await go(page, { guests: [G('WD-1', 'حسن أحمد')] });
  await expect(page.locator('.guest-item')).toHaveCount(1);

  await page.locator('#new-guest-name').fill('حسن محمد');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('#toast')).toContainText('تمت إضافة حسن محمد');
  await expect(page.locator('.guest-item')).toHaveCount(2);
});

test('the guest-card button is always labeled "حفظ", regardless of whether this device can share files', async ({ page }) => {
  await go(page, { guests: [G('WD-1', 'أحمد')] });
  await expect(page.locator('.guest-item .dl-btn')).toHaveText('حفظ');
});

test('marking a guest as attended from the list asks for confirmation first, so a stray tap can\'t check someone in', async ({ page }) => {
  await go(page, { guests: [G('WD-1', 'أحمد')] });
  await expect(page.locator('.attend-btn')).toBeVisible();

  page.on('dialog', d => d.dismiss());
  await page.locator('.attend-btn').click();
  await expect(page.locator('.attend-btn')).toBeVisible();
  expect((await server(page)).guests[0].scanned).toBe(false);

  page.removeAllListeners('dialog');
  page.on('dialog', d => d.accept());
  await page.locator('.attend-btn').click();
  await expect(page.locator('.undo-btn')).toBeVisible();
  await expect(page.locator('#toast')).toContainText('تم تسجيل حضور أحمد');
});

test('marking attended manually is saved on the server, so the door scanner\'s counter sees it too', async ({ page }) => {
  await go(page, { guests: [G('WD-1', 'أحمد')] });
  await expect(page.locator('.attend-btn')).toBeVisible();

  page.on('dialog', d => d.accept());
  await page.locator('.attend-btn').click();
  await expect(page.locator('.undo-btn')).toBeVisible();

  expect((await server(page)).guests[0].scanned).toBe(true);
  expect(await calls(page, 'set_guest_scanned')).toEqual([{ p_event_id: 'e1', p_guest_id: 'WD-1', p_scanned: true }]);
  expect(await doorCounts(page)).toEqual([1, 1]);
});

test('undoing attendance is saved on the server, so re-scanning the same guest later doesn\'t double-count them', async ({ page }) => {
  await go(page, { guests: [G('WD-1', 'أحمد', { scanned: true })] });
  await expect(page.locator('.undo-btn')).toBeVisible();

  page.on('dialog', d => d.accept());
  await page.locator('.undo-btn').click();
  await expect(page.locator('.attend-btn')).toBeVisible();
  await expect(page.locator('#toast')).toContainText('تم التراجع');

  expect((await server(page)).guests[0].scanned).toBe(false);
  expect(await doorCounts(page)).toEqual([1, 0]);
});

test('deleting a guest frees up their slot, so the customer can add a replacement', async ({ page }) => {
  await go(page, { guests: fill(5) });
  await expect(page.locator('#payment-gate')).toBeVisible();

  page.on('dialog', d => d.accept());
  await page.locator('.guest-item', { hasText: 'ضيف 1' }).locator('.more-btn').click();
  await page.locator('#guest-sheet .gs-del').click();
  await expect(page.locator('.guest-item')).toHaveCount(4);
  await expect(page.locator('#payment-gate')).toBeHidden();

  await page.locator('#new-guest-name').fill('بديل');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('.guest-item')).toHaveCount(5);
  expect((await server(page)).guests).toHaveLength(5);
});

const attended = () => [G('WD-1', 'أحمد', { scanned: true, scanned_at: '2026-01-01T10:00:00.000000+00:00' }), G('WD-2', 'سارة')];
// What the door scanner's counter reads: the guests the server holds and how many of them are checked in.
const doorCounts = (page) => page.evaluate(() => { const g = window.__fakeSupabase.doors.e1.guests; return [g.length, g.filter((x) => x.scanned).length]; });

test('deleting a guest who already checked in also takes them off the door counter', async ({ page }) => {
  await go(page, { guests: attended() });
  await expect(page.locator('.guest-item')).toHaveCount(2);
  expect(await doorCounts(page)).toEqual([2, 1]);

  page.on('dialog', d => d.accept());
  const row = page.locator('.guest-item', { hasText: 'أحمد' });
  await row.locator('.more-btn').click();
  await page.locator('#guest-sheet .gs-del').click();
  await expect(page.locator('.guest-item')).toHaveCount(1);
  expect(await doorCounts(page)).toEqual([1, 0]);
});

test('bulk-deleting checked-in and not-checked-in guests leaves both counters right', async ({ page }) => {
  await go(page, { guests: attended() });
  await expect(page.locator('.guest-item')).toHaveCount(2);

  page.on('dialog', d => d.accept());
  await menu(page);
  await page.getByRole('button', { name: /تحديد ضيوف للحذف/ }).click();
  for (const box of await page.locator('.gsel').all()) await box.check();
  await page.getByRole('button', { name: /حذف المحددين/ }).click();
  await expect(page.locator('.guest-item')).toHaveCount(0);
  await expect(page.locator('#toast')).toContainText('تم حذف 2');
  expect(await doorCounts(page)).toEqual([0, 0]);
});

test('bulk delete goes in chunks of 100 and shows progress', async ({ page }) => {
  await go(page, { guests: fill(230) });
  await expect(page.locator('#stat-total')).toHaveText('230');
  const toasts = [];
  await page.exposeFunction('__recordToast', (t) => toasts.push(t));
  await page.evaluate(() => { const real = showToast; window.showToast = (m) => { window.__recordToast(m); real(m); }; });

  page.on('dialog', d => d.accept());
  await menu(page);
  await page.getByRole('button', { name: /تحديد ضيوف للحذف/ }).click();
  await page.evaluate(() => { guests.forEach((g) => selectedGuestIds.add(g.id)); updateBulkCount(); });
  await page.getByRole('button', { name: /حذف المحددين/ }).click();
  await expect(page.locator('#toast')).toContainText('تم حذف 230');
  const sizes = (await calls(page, 'remove_guests')).map((a) => a.p_ids.length);
  expect(sizes).toEqual([100, 100, 30]);
  const progress = toasts.filter((t) => t.includes('جاري الحذف'));
  expect(progress[0]).toBe('⏳ جاري الحذف... 0 / 230');
  expect(progress).toContain('⏳ جاري الحذف... 100 / 230');
  expect(progress[progress.length - 1]).toBe('⏳ جاري الحذف... 230 / 230');
  expect((await server(page)).guests).toHaveLength(0);
});

test('the edit-event date field has a visible label (iOS Safari shows an empty date field as blank)', async ({ page }) => {
  await go(page);
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('label[for="edit-ev-date"]')).toHaveText('تاريخ المناسبة');
});

test('adding sequential numbers creates that many numbered guests without needing a file', async ({ page }) => {
  await go(page);
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

  await menu(page);
  await page.getByRole('button', { name: /إضافة أرقام متسلسلة/ }).click();

  await expect(page.locator('.guest-item')).toHaveCount(5);
  const names = (await page.locator('.guest-item .name').allTextContents()).sort((a, b) => Number(a) - Number(b));
  expect(names).toEqual(['1', '2', '3', '4', '5']);

  // The bulk-import path gets its barcodes from the server too.
  const bad = (await server(page)).guests.filter((g) => !/^WD-[0-9A-F]{12}$/.test(g.id));
  expect(bad).toEqual([]);
});

test('a small add still shows "جاري الإضافة" while it writes — a write has no instant local echo to lean on', async ({ page }) => {
  await go(page);
  await expect(page.locator('#dashboard')).toBeVisible();
  const toasts = [];
  await page.exposeFunction('__recordToast', (t) => toasts.push(t));
  await page.evaluate(() => { const real = showToast; window.showToast = (m) => { window.__recordToast(m); real(m); }; });

  let promptCount = 0;
  page.on('dialog', async (d) => {
    if (d.type() === 'prompt') { promptCount++; await d.accept(promptCount === 1 ? '1' : '5'); }
    else await d.accept();
  });
  await menu(page);
  await page.getByRole('button', { name: /إضافة أرقام متسلسلة/ }).click();
  await expect(page.locator('.guest-item')).toHaveCount(5);

  expect(toasts.some(t => t.includes('⏳ جاري الإضافة'))).toBe(true);
});

test('a large batch of sequential numbers shows progress and is sent in batches of 50', async ({ page }) => {
  await go(page, { event: { paid: true } });
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

  await menu(page);
  await page.getByRole('button', { name: /إضافة أرقام متسلسلة/ }).click();

  await expect(page.locator('.guest-item')).toHaveCount(120, { timeout: 10000 });
  await expect(page.locator('#toast')).toContainText('120 / 120');
  const sizes = (await calls(page, 'add_guests')).map((a) => a.p_guests.length);
  expect(sizes).toEqual([50, 50, 20]);
  expect((await calls(page, 'add_guests')).every((a) => a.p_partial === true)).toBe(true);
});

test('guest list sorts numeric names first (in numeric order), then alphabetical', async ({ page }) => {
  await go(page, { guests: [G('WD-1', 'زينب'), G('WD-2', '10'), G('WD-3', '2'), G('WD-4', 'أحمد')] });
  await expect(page.locator('.guest-item')).toHaveCount(4);
  const names = await page.locator('.guest-item .name').allTextContents();
  expect(names).toEqual(['2', '10', 'أحمد', 'زينب']);
});

test('names that end in a number sort by that number, not letter by letter (2 before 10 before 100)', async ({ page }) => {
  await go(page, { guests: [G('WD-1', 'ضيف 100'), G('WD-2', 'ضيف 10'), G('WD-3', 'ضيف 2'), G('WD-4', 'ضيف 1')] });
  await expect(page.locator('.guest-item')).toHaveCount(4);
  const names = await page.locator('.guest-item .name').allTextContents();
  expect(names).toEqual(['ضيف 1', 'ضيف 2', 'ضيف 10', 'ضيف 100']);
});

test('a burst of near-simultaneous list updates collapses into one render instead of one per update', async ({ page }) => {
  // Simulates a bulk import or several door scanners checking guests in
  // around the same moment — renderGuests() calls are coalesced into a
  // single animation frame per burst.
  await go(page, { guests: [G('WD-1', 'أحمد')] });
  await expect(page.locator('.guest-item')).toHaveCount(1);

  const renderCount = await page.evaluate(async () => {
    let count = 0;
    const original = renderGuests;
    renderGuests = function (...args) { count++; return original.apply(this, args); };
    for (let i = 0; i < 5; i++) scheduleRenderGuests();
    // Let the coalesced animation-frame render actually fire before restoring.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    renderGuests = original;
    return count;
  });

  expect(renderCount).toBe(1);
});

test('stat tiles reflect attended vs pending counts', async ({ page }) => {
  await go(page, { guests: [G('WD-1', 'A', { scanned: true }), G('WD-2', 'B'), G('WD-3', 'C')] });
  await expect(page.locator('#stat-total')).toHaveText('3');
  await expect(page.locator('#stat-attended')).toHaveText('1');
  await expect(page.locator('#stat-pending')).toHaveText('2');
});

test('guest search filters the visible list by name', async ({ page }) => {
  await go(page, { guests: [G('WD-1', 'Hassan Sallah'), G('WD-2', 'Fatima Ali')] });
  await expect(page.locator('.guest-item')).toHaveCount(2);
  await page.locator('#guest-search').fill('fatima');
  await expect(page.locator('.guest-item')).toHaveCount(1);
  await expect(page.locator('.guest-item .name')).toHaveText('Fatima Ali');
});

test('someone who is not the event owner is denied access', async ({ page }) => {
  await go(page, { user: { id: 'someone-else', email: 'not-the-owner@example.com' }, event: { owner_uid: 'u1' } });
  await expect(page.locator('#denied-msg')).toBeVisible();
  await expect(page.locator('#dashboard')).toBeHidden();
});

test('a signed-out visitor is asked to sign in first', async ({ page }) => {
  await go(page, { user: null });
  await expect(page.locator('#denied-msg')).toContainText('لازم تسجّل دخول الأول');
  await expect(page.locator('#dashboard')).toBeHidden();
});

test('the admin account can open a customer event it does not own', async ({ page }) => {
  await go(page, { user: ADMIN, admin: true, event: { owner_uid: 'u1' }, guests: [G('WD-1', 'Guest')] });
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#denied-msg')).toBeHidden();
  await expect(page.locator('.guest-item')).toHaveCount(1);
});

test('a fresh unpaid event shows no payment-gate banner and lets the owner add a guest, with the remaining count tucked into the menu', async ({ page }) => {
  await go(page);
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#payment-gate')).toBeHidden();
  await menu(page);
  await expect(page.locator('#payment-menu-item')).toContainText('باقي لك 5 ضيوف مجانًا');
  await menu(page);
  await page.locator('#new-guest-name').fill('ضيف جديد');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('.guest-item')).toHaveCount(1);
});

test('a toast fires exactly when the owner\'s action hits the free-guest cap, not on every page load', async ({ page }) => {
  await go(page, { guests: fill(4) });
  await expect(page.locator('.guest-item')).toHaveCount(4);
  await expect(page.locator('#toast')).not.toContainText('خلصت الـ5 ضيوف');
  await page.locator('#new-guest-name').fill('الضيف الخامس');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('#toast')).toContainText('خلصت الـ5 ضيوف المجانيين');
  await expect(page.locator('#payment-gate')).toBeVisible();
});

test('an unpaid event at the free-guest cap blocks the owner from adding more, and shows the payment gate', async ({ page }) => {
  await go(page, { guests: fill(5) });
  await expect(page.locator('#payment-gate')).toBeVisible();
  await page.locator('#new-guest-name').fill('ضيف جديد');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('.guest-item')).toHaveCount(5);
  expect(await calls(page, 'add_guests')).toEqual([]);
  expect((await server(page)).opened).toHaveLength(1);
});

test('when the server refuses the add because the limit was reached meanwhile, the payment WhatsApp opens', async ({ page }) => {
  await go(page, { guests: fill(4) });
  await expect(page.locator('.guest-item')).toHaveCount(4);
  // another device added the 5th guest after this page loaded
  await page.evaluate(() => window.__srv.addGuest('e1', { id: 'WD-OTHER', name: 'من جهاز ثاني' }));
  await page.locator('#new-guest-name').fill('ضيف');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect.poll(async () => (await server(page)).opened.length).toBe(1);
  expect((await server(page)).guests).toHaveLength(5);
  await expect(page.locator('#new-guest-name')).toHaveValue('ضيف');
});

test('CSV import fills only up to the remaining free slots, then stops', async ({ page }) => {
  await go(page, { guests: fill(3) });
  await expect(page.locator('.guest-item')).toHaveCount(3);
  page.on('dialog', d => d.accept());
  await page.locator('#csv-import').setInputFiles({
    name: 'guests.csv', mimeType: 'text/csv',
    buffer: Buffer.from('Guest A\nGuest B\nGuest C\nGuest D\nGuest E'),
  });
  await expect(page.locator('.guest-item')).toHaveCount(5);
  await expect(page.locator('#payment-gate')).toBeVisible();
  expect((await server(page)).guests).toHaveLength(5);
});

test('a paid event lets the owner add a guest normally, and hides the payment gate', async ({ page }) => {
  await go(page, { event: { paid: true } });
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#payment-gate')).toBeHidden();
  await page.locator('#new-guest-name').fill('ضيف جديد');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('.guest-item')).toHaveCount(1);
});

test('the owner sees a live toast and the gate lifts when the event is activated while the page is open', async ({ page }) => {
  await go(page, { guests: fill(5) });
  await expect(page.locator('#payment-gate')).toBeVisible();
  await page.evaluate(() => { window.__fakeSupabase.events.e1.paid = true; });
  await syncNow(page);
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
const asAdmin = (extra, guests) => ({ user: ADMIN, admin: true, event: { owner_uid: 'u1', paid: false, ...extra }, guests: guests || [] });
const stored = async (page) => (await server(page)).event;

test('the admin cannot activate an event without a number: cancelling the prompt leaves it unactivated', async ({ page }) => {
  const seen = answerPrompt(page, null);
  await go(page, asAdmin({}));
  await menu(page);
  await expect(page.locator('#payment-menu-item')).toContainText('تفعيل (أدمن)');
  await page.locator('#payment-menu-item').click();
  await menu(page);
  await expect(page.locator('#payment-menu-item')).toContainText('تفعيل (أدمن)');
  expect(seen.prompts).toHaveLength(1);
  const ev = await stored(page);
  expect(ev.paid).toBe(false);
  expect(ev.guest_limit == null).toBe(true);
  expect(await calls(page, 'admin_activate_event')).toEqual([]);
});

test('the admin activates an event by typing the number of guests, and it is saved with it', async ({ page }) => {
  answerPrompt(page, 150);
  await go(page, asAdmin({}));
  await menu(page);
  await page.locator('#payment-menu-item').click();
  await menu(page);
  await expect(page.locator('#payment-menu-item')).toContainText('مفعّلة (150 ضيف) — تعديل الحد');
  const ev = await stored(page);
  expect(ev.paid).toBe(true);
  expect(ev.guest_limit).toBe(150);
  expect(await calls(page, 'admin_activate_event')).toEqual([{ p_event_id: 'e1', p_limit: 150 }]);
});

test('the admin can type the number with Eastern Arabic digits', async ({ page }) => {
  answerPrompt(page, '١٢٠');
  await go(page, asAdmin({}));
  await menu(page);
  await page.locator('#payment-menu-item').click();
  await expect.poll(async () => (await stored(page)).guest_limit).toBe(120);
});

for (const [label, answer] of [['text', 'كثير'], ['a decimal', '12.5'], ['a negative number', '-5'], ['zero on an event that is not activated', '0'], ['a number over the maximum', '2001'], ['an empty answer', '']]) {
  test('an invalid answer (' + label + ') saves nothing', async ({ page }) => {
    const seen = answerPrompt(page, answer);
    await go(page, asAdmin({}));
    await menu(page);
    await page.locator('#payment-menu-item').click();
    await expect.poll(() => seen.prompts.length).toBe(1);
    const ev = await stored(page);
    expect(ev.paid).toBe(false);
    expect(ev.guest_limit == null).toBe(true);
  });
}

test('a very large number asks for confirmation, and declining it saves nothing', async ({ page }) => {
  page.on('dialog', d => d.type() === 'prompt' ? d.accept('1500') : d.dismiss());
  await go(page, asAdmin({}));
  await menu(page);
  await page.locator('#payment-menu-item').click();
  await menu(page);
  await expect(page.locator('#payment-menu-item')).toContainText('تفعيل (أدمن)');
  expect((await stored(page)).guest_limit == null).toBe(true);
});

test('the admin can change the number later, and 0 switches the event back to the free tier', async ({ page }) => {
  let answer = '80';
  page.on('dialog', d => d.type() === 'prompt' ? d.accept(answer) : d.accept());
  await go(page, asAdmin({ paid: true, guest_limit: 50 }));
  await menu(page);
  await expect(page.locator('#payment-menu-item')).toContainText('مفعّلة (50 ضيف) — تعديل الحد');
  await page.locator('#payment-menu-item').click();
  await menu(page);
  await expect(page.locator('#payment-menu-item')).toContainText('مفعّلة (80 ضيف)');
  expect((await stored(page)).guest_limit).toBe(80);

  answer = '0';
  await page.locator('#payment-menu-item').click();
  await menu(page);
  await expect(page.locator('#payment-menu-item')).toContainText('تفعيل (أدمن)');
  const ev = await stored(page);
  expect(ev.paid).toBe(false);
  expect(ev.guest_limit == null).toBe(true);
  expect(await calls(page, 'admin_deactivate_event')).toEqual([{ p_event_id: 'e1' }]);
});

test('setting a limit below the current guest count warns the admin first', async ({ page }) => {
  const seen = answerPrompt(page, 10);
  await go(page, asAdmin({}, fill(30)));
  await expect(page.locator('#stat-total')).toHaveText('30');
  await menu(page);
  await page.locator('#payment-menu-item').click();
  await expect.poll(() => seen.confirms.length).toBe(1);
  expect(seen.confirms[0]).toContain('30');
});

test('an activated event stops at the admin-set number: the owner is blocked, sees "N of M", and the WhatsApp message asks to raise it', async ({ page }) => {
  await go(page, { event: { paid: true, guest_limit: 3 }, guests: fill(2) });
  await expect(page.locator('.guest-item')).toHaveCount(2);
  await expect(page.locator('#payment-gate')).toBeHidden();
  await menu(page);
  await expect(page.locator('#payment-menu-item')).toContainText('2 من 3 ضيوف');
  await menu(page);

  await page.locator('#new-guest-name').fill('الثالث');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('.guest-item')).toHaveCount(3);
  await expect(page.locator('#toast')).toContainText('وصلت لحد الضيوف (3)');
  await expect(page.locator('#payment-gate')).toBeVisible();
  await expect(page.locator('#pg-title')).toContainText('لحد الضيوف (3)');

  await page.locator('#new-guest-name').fill('الرابع');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('.guest-item')).toHaveCount(3);
  expect((await server(page)).guests).toHaveLength(3);

  await page.evaluate(() => { window.__opened = []; });
  await page.getByRole('button', { name: /واتساب/ }).click();
  const opened = (await server(page)).opened;
  expect(opened).toHaveLength(1);
  expect(decodeURIComponent(opened[0])).toContain('أزيد عدد الضيوف');
});

test('CSV import stops at the admin-set number and says how many names were left out', async ({ page }) => {
  await go(page, { event: { paid: true, guest_limit: 4 }, guests: fill(1) });
  await expect(page.locator('.guest-item')).toHaveCount(1);
  const messages = [];
  page.on('dialog', d => { messages.push(d.message()); d.accept(); });
  await page.locator('#csv-import').setInputFiles({
    name: 'guests.csv', mimeType: 'text/csv',
    buffer: Buffer.from('A\nB\nC\nD\nE'),
  });
  await expect(page.locator('.guest-item')).toHaveCount(4);
  expect(messages.join(' ')).toContain('وصلت لحد الـ4 ضيوف، وما انضاف 2 اسمين');
  expect((await server(page)).guests).toHaveLength(4);
});

test('the owner sees a live toast when the admin raises the number while the page is open, and can add again', async ({ page }) => {
  await go(page, { event: { paid: true, guest_limit: 5 }, guests: fill(5) });
  await expect(page.locator('#payment-gate')).toBeVisible();
  await page.evaluate(() => { window.__fakeSupabase.events.e1.guest_limit = 100; });
  await syncNow(page);
  await expect(page.locator('#toast')).toContainText('تم تحديث حد الضيوف إلى 100');
  await expect(page.locator('#payment-gate')).toBeHidden();
  await page.locator('#new-guest-name').fill('ضيف');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('.guest-item')).toHaveCount(6);
});

test('an event activated before limits existed stays unlimited, and the owner can keep adding', async ({ page }) => {
  await go(page, { event: { paid: true }, guests: fill(40) });
  await expect(page.locator('.guest-item')).toHaveCount(40);
  await expect(page.locator('#payment-gate')).toBeHidden();
  await page.locator('#new-guest-name').fill('ضيف');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('.guest-item')).toHaveCount(41);
});

test('an unlimited older event shows the admin "no limit" and lets them give it a number', async ({ page }) => {
  answerPrompt(page, 200);
  await go(page, asAdmin({ paid: true }));
  await menu(page);
  await expect(page.locator('#payment-menu-item')).toContainText('مفعّلة (بلا حد)');
  await page.locator('#payment-menu-item').click();
  await menu(page);
  await expect(page.locator('#payment-menu-item')).toContainText('مفعّلة (200 ضيف)');
});

test('the admin adds guests past the free cap without being gated', async ({ page }) => {
  await go(page, asAdmin({}, fill(5)));
  await expect(page.locator('.guest-item')).toHaveCount(5);
  await expect(page.locator('#payment-gate')).toBeHidden();
  await page.locator('#new-guest-name').fill('ضيف إضافي');
  await page.getByRole('button', { name: 'إضافة' }).click();
  await expect(page.locator('.guest-item')).toHaveCount(6);
  expect((await server(page)).guests).toHaveLength(6);
});

test('a one-tap toolbar shortcut jumps back to "all my events" without opening the menu first', async ({ page }) => {
  await go(page, asAdmin({}));
  await expect(page.locator('#dashboard')).toBeVisible();
  // Not inside the (initially hidden) dropdown menu — a direct toolbar button.
  await expect(page.locator('#top-menu')).toBeHidden();
  await page.locator('.toolbar > .icon-btn[title="كل مناسباتي"]').click();
  await expect(page).toHaveURL(/app\.html$/);
});

test('regenerating the scanner door code updates the display and the server, so old unlocked devices get locked out', async ({ page }) => {
  await go(page);
  await expect(page.locator('#scan-pin-display')).toHaveText('123456');

  await page.getByRole('button', { name: 'رمز جديد' }).click();
  await expect(page.locator('#pin-modal')).toBeVisible();
  await expect(page.locator('#pin-modal')).toContainText('تخرج جميع أجهزة فريق الاستقبال الحالية وتحتاج إلى الرمز الجديد');
  await page.getByRole('button', { name: 'نعم، غيّر الرمز' }).click();
  await expect(page.locator('#toast')).toContainText('تم توليد رمز جديد');
  await expect(page.locator('#scan-pin-display')).not.toHaveText('123456');

  const storedPin = (await server(page)).pin;
  const displayedPin = await page.locator('#scan-pin-display').textContent();
  expect(storedPin).toBe(displayedPin);
  // The server makes the code: six digits, leading zeros allowed, always a string.
  expect(storedPin).toMatch(/^\d{6}$/);
  expect(await calls(page, 'regenerate_door_code')).toEqual([{ p_event_id: 'e1' }]);
});

test('the door code is read from the owner-only secrets, and leading zeros are kept', async ({ page }) => {
  await go(page, { pin: '007654' });
  await expect(page.locator('#scan-pin-display')).toHaveText('007654');
  expect(await calls(page, 'regenerate_door_code')).toEqual([]);
  expect((await calls(page, 'from:event_secrets')).length).toBeGreaterThan(0);
});

test('an event with no door code at all still gets one when the owner opens it', async ({ page }) => {
  await go(page, { pin: '' });
  await expect(page.locator('#scan-pin-display')).toHaveText(/^\d{6}$/);
  const shown = await page.locator('#scan-pin-display').textContent();
  expect((await server(page)).pin).toBe(shown);
  expect(await calls(page, 'regenerate_door_code')).toHaveLength(1);
});

test('declining the "generate a new code" confirm leaves the old scanner code in place', async ({ page }) => {
  await go(page);
  await expect(page.locator('#scan-pin-display')).toHaveText('123456');

  await page.getByRole('button', { name: 'رمز جديد' }).click();
  await page.getByRole('button', { name: 'إلغاء' }).click();
  await expect(page.locator('#pin-modal')).toBeHidden();
  await expect(page.locator('#scan-pin-display')).toHaveText('123456');
  expect((await server(page)).pin).toBe('123456');
  expect(await calls(page, 'regenerate_door_code')).toEqual([]);
});

test('door alert: nothing below 20 wrong codes an hour, a warning from 20, a red box with the reopen button when the door is locked', async ({ page }) => {
  await go(page, { alert: { failed_last_hour: 19, failed_last_day: 19, door_locked: false } });
  await expect(page.locator('#scan-pin-display')).toHaveText('123456');
  await expect(page.locator('#door-alert')).toBeHidden();
  expect((await calls(page, 'door_alert')).length).toBeGreaterThan(0);
  await page.evaluate(() => { window.__fakeSupabase.doors.e1.alert = { failed_last_hour: 24, failed_last_day: 24, door_locked: false }; return refreshDoorAlert(); });
  await expect(page.locator('#door-alert.warn')).toBeVisible();
  await expect(page.locator('#door-alert')).toContainText('تم رصد 24 محاولة خاطئة خلال الساعة الأخيرة');
  await expect(page.locator('#door-alert')).toContainText('فلا تغيّره أثناء المناسبة');
  await expect(page.getByRole('button', { name: 'إعادة فتح المدخل' })).toHaveCount(0);
  await page.evaluate(() => { window.__fakeSupabase.doors.e1.alert = { failed_last_hour: 60, failed_last_day: 60, door_locked: true }; return refreshDoorAlert(); });
  await expect(page.locator('#door-alert.lock')).toBeVisible();
  await expect(page.locator('#door-alert')).toContainText('المدخل مقفل للأجهزة الجديدة');
  await expect(page.locator('#door-alert')).toContainText('تم رصد 60 محاولة خاطئة خلال الساعة الأخيرة');
  await expect(page.locator('#door-alert')).toContainText('يبقى الرمز كما هو ولا تتأثر أجهزة فريق الاستقبال');
});

test('door alert: locked by the daily budget says "خلال اليوم"', async ({ page }) => {
  await go(page, { alert: { failed_last_hour: 12, failed_last_day: 300, door_locked: true } });
  await expect(page.locator('#door-alert.lock')).toContainText('تم رصد 300 محاولة خاطئة خلال اليوم');
});

test('"إعادة فتح المدخل" clears the count and keeps the same door code; the alert goes away', async ({ page }) => {
  await go(page, { alert: { failed_last_hour: 60, failed_last_day: 61, door_locked: true } });
  await expect(page.locator('#door-alert.lock')).toBeVisible();
  await page.getByRole('button', { name: 'إعادة فتح المدخل' }).click();
  await expect(page.locator('#toast')).toContainText('تم فتح المدخل من جديد');
  await expect(page.locator('#door-alert')).toBeHidden();
  expect(await calls(page, 'reset_door_attempts')).toEqual([{ p_event_id: 'e1' }]);
  expect(await calls(page, 'regenerate_door_code')).toEqual([]);
  expect((await server(page)).pin).toBe('123456');
});

test('door alert: exactly 20 wrong codes an hour show the warning', async ({ page }) => {
  await go(page, { alert: { failed_last_hour: 20, failed_last_day: 20, door_locked: false } });
  await expect(page.locator('#door-alert.warn')).toBeVisible();
  await expect(page.locator('#door-alert')).toContainText('تم رصد 20 محاولة خاطئة');
});

test('door alert: a failed alert read shows no error and the dashboard keeps working', async ({ page }) => {
  await go(page, { alert: { failed_last_hour: 60, failed_last_day: 60, door_locked: true }, fail: { door_alert: { error: 'network' } } });
  await expect(page.locator('#scan-pin-display')).toHaveText('123456');
  await expect(page.locator('#door-alert')).toBeHidden();
  await expect(page.locator('#connection-banner')).toBeHidden();
  expect((await calls(page, 'door_alert')).length).toBeGreaterThan(0);
});

test('door alert: the dialog closes by tapping the backdrop, and a new code re-reads the alert', async ({ page }) => {
  await go(page, { alert: { failed_last_hour: 30, failed_last_day: 30, door_locked: false } });
  await expect(page.locator('#door-alert.warn')).toBeVisible();
  await page.getByRole('button', { name: 'رمز جديد' }).first().click();
  await page.locator('#pin-modal').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('#pin-modal')).toBeHidden();
  expect(await calls(page, 'regenerate_door_code')).toEqual([]);
  const before = (await calls(page, 'door_alert')).length;
  await page.getByRole('button', { name: 'رمز جديد' }).first().click();
  await page.getByRole('button', { name: 'نعم، غيّر الرمز' }).click();
  await expect(page.locator('#toast')).toContainText('تم توليد رمز جديد');
  await expect.poll(async () => (await calls(page, 'door_alert')).length).toBeGreaterThan(before);
});

test('door alert: no more reads after the owner leaves (event deleted elsewhere)', async ({ page }) => {
  await go(page, { alert: { failed_last_hour: 0, failed_last_day: 0, door_locked: false } });
  await expect(page.locator('#scan-pin-display')).toHaveText('123456');
  await page.evaluate(() => { delete window.__fakeSupabase.events.e1; return liveRefresh(); });
  await expect(page.locator('#denied-msg')).toBeVisible();
  const n = (await calls(page, 'door_alert')).length;
  await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
  await page.waitForTimeout(500);
  expect((await calls(page, 'door_alert')).length).toBe(n);
});

test('the "رمز جديد" button inside the door alert opens the same confirmation', async ({ page }) => {
  await go(page, { alert: { failed_last_hour: 30, failed_last_day: 30, door_locked: false } });
  await page.locator('#door-alert').getByRole('button', { name: 'رمز جديد' }).click();
  await expect(page.locator('#pin-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#pin-modal')).toBeHidden();
});

test('a dropped connection while loading the dashboard shows a tappable retry instead of hanging on "جاري التحميل..." forever', async ({ page }) => {
  await go(page, { fail: { 'from:events': { error: 'network', times: 1 } } });

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
  await stubNotificationApi(page, { initialPermission: 'default' });
  await go(page);
  await expect(page.locator('#dashboard')).toBeVisible();

  await menu(page);
  await page.getByRole('button', { name: 'تفعيل إشعارات الطلبات' }).click();
  await expect(page.locator('#toast')).toContainText('تم تفعيل إشعارات الطلبات');

  await menu(page);
  await expect(page.getByRole('button', { name: /إشعارات الطلبات مفعّلة/ })).toBeVisible();
});

const addRequest = (page, id, name, createdAt) => page.evaluate(([id, name, at]) => {
  window.__fakeSupabase.requests.e1[id] = { status: 'pending', guest_id: null, vip: false, name, created_at: at || window.__srv.stamp() };
}, [id, name, createdAt]);

test('a new guest request triggers a real notification once enabled, but not requests already pending on load', async ({ page }) => {
  await stubNotificationApi(page, { initialPermission: 'granted' });
  await go(page, { requests: [{ id: 'r-old', name: 'طلب قديم' }] });
  await expect(page.locator('#requests-badge')).toHaveText('1');

  // A request that was already pending when the page loaded must not fire
  // a notification — only ones that arrive while this device is watching.
  expect(await page.evaluate(() => window.__notifications.length)).toBe(0);

  await addRequest(page, 'r-new', 'ضيف جديد');
  await syncNow(page);

  await expect(page.locator('#requests-badge')).toHaveText('2');
  const notifs = await page.evaluate(() => window.__notifications);
  expect(notifs.length).toBe(1);
  expect(notifs[0].opts.body).toContain('ضيف جديد');
});

test('approving a guest request makes the guest and links it to the request, for the invite page to read', async ({ page }) => {
  await go(page, { event: { paid: true }, requests: [{ id: 'REQ-1', name: 'ضيف طالب' }] });
  await expect(page.locator('#dashboard')).toBeVisible();
  await menu(page);
  await page.getByRole('button', { name: /^الطلبات/ }).click();
  await page.locator('.approve-btn').click();
  await expect(page.locator('#toast')).toContainText('تمت الموافقة');
  const s = await server(page);
  expect(s.guests).toHaveLength(1);
  expect(s.guests[0].name).toBe('ضيف طالب');
  expect(s.guests[0].id).toMatch(/^WD-[0-9A-F]{12}$/);
  expect(s.requests['REQ-1'].status).toBe('approved');
  expect(s.requests['REQ-1'].guest_id).toBe(s.guests[0].id);
  await expect(page.locator('.pending-item')).toHaveCount(0);
  await expect(page.locator('.guest-item')).toHaveCount(1);
});

test('approving as VIP marks the guest and the request VIP; a plain approve does not', async ({ page }) => {
  await go(page, { event: { paid: true }, requests: [{ id: 'REQ-1', name: 'عادي' }, { id: 'REQ-2', name: 'مهم' }] });
  await expect(page.locator('#dashboard')).toBeVisible();
  await menu(page);
  await page.getByRole('button', { name: /^الطلبات/ }).click();
  await page.locator('.pending-item', { hasText: 'مهم' }).locator('.vip-approve-btn').click();
  await expect(page.locator('#toast')).toContainText('تمت الموافقة — مهم (VIP)');
  await page.locator('.pending-item', { hasText: 'عادي' }).locator('.approve-btn').click();
  await expect(page.locator('.pending-item')).toHaveCount(0);
  const s = await server(page);
  expect(s.guests.find((g) => g.name === 'مهم').vip).toBe(true);
  expect(s.guests.find((g) => g.name === 'عادي').vip).toBe(false);
  expect(s.requests['REQ-2'].vip).toBe(true);
});

test('approving a request that another device already handled says so, and does not make a second guest', async ({ page }) => {
  await go(page, { event: { paid: true }, requests: [{ id: 'REQ-1', name: 'ضيف طالب' }] });
  await expect(page.locator('#dashboard')).toBeVisible();
  await menu(page);
  await page.getByRole('button', { name: /^الطلبات/ }).click();
  await expect(page.locator('.approve-btn')).toHaveCount(1);
  await page.evaluate(() => { window.__fakeSupabase.requests.e1['REQ-1'].status = 'approved'; });
  await page.locator('.approve-btn').click();
  await expect(page.locator('#toast')).toContainText('هذا الطلب تمت الموافقة عليه مسبقًا');
  expect((await server(page)).guests).toHaveLength(0);
});

test('approving one request at the free cap opens the payment WhatsApp and adds nothing', async ({ page }) => {
  await go(page, { guests: fill(4), requests: [{ id: 'REQ-1', name: 'أ' }] });
  await expect(page.locator('.guest-item')).toHaveCount(4);
  await page.evaluate(() => window.__srv.addGuest('e1', { id: 'WD-OTHER', name: 'من جهاز ثاني' }));
  await menu(page);
  await page.getByRole('button', { name: /^الطلبات/ }).click();
  await page.locator('.approve-btn').click();
  await expect.poll(async () => (await server(page)).opened.length).toBe(1);
  expect((await server(page)).guests).toHaveLength(5);
  expect((await server(page)).requests['REQ-1'].status).toBe('pending');
});

test('rejecting a request removes it from the list, and the guest\'s own link then shows «rejected»', async ({ page }) => {
  const rid = 'REQ-0123456789ABCDEFGH';
  await go(page, { event: { paid: true }, requests: [{ id: rid, name: 'ضيف طالب' }, { id: 'REQ-OTHER-0123456789', name: 'آخر' }] });
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#requests-badge')).toHaveText('2');
  await menu(page);
  await page.getByRole('button', { name: /^الطلبات/ }).click();
  await page.locator('.pending-item', { hasText: 'ضيف طالب' }).locator('.reject-btn').click();
  await expect(page.locator('#toast')).toContainText('تم رفض الطلب — ضيف طالب');
  await expect(page.locator('.pending-item')).toHaveCount(1);
  await expect(page.locator('#top-menu-badge')).toHaveText('1');
  expect(await calls(page, 'reject_request')).toEqual([{ p_event_id: 'e1', p_req_id: rid }]);
  const guestView = await page.evaluate((id) => window.Data.invite.getRequest('e1', id), rid);
  expect(guestView.status).toBe('rejected');
  expect((await server(page)).guests).toHaveLength(0);
});

function pendingReqs(reqs) {
  return reqs.map((x, i) => ({ id: 'r' + String(i).padStart(2, '0'), created_at: '2026-01-01T00:00:00.000000+00:00', ...x }));
}
async function openRequests(page, reqs, opts = {}) {
  await go(page, { event: { paid: true }, requests: pendingReqs(reqs), ...opts });
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#requests-badge')).toHaveText(String(Math.min(reqs.length, 99)) + (reqs.length > 99 ? '+' : ''));
  await menu(page);
  await page.getByRole('button', { name: /^الطلبات/ }).click();
}
const fbState = async (page) => {
  const s = await server(page);
  return { guests: s.guests, requests: s.requests, count: s.guests.length, opened: s.opened.length };
};
const acceptAll = (page) => page.locator('#approve-all-modal').getByRole('button', { name: 'اقبل الكل' });

test('accept-all button is hidden with one request', async ({ page }) => {
  await openRequests(page, [{ name: 'أحمد' }]);
  await expect(page.locator('.pending-item')).toHaveCount(1);
  await expect(page.locator('.accept-all')).toHaveCount(0);
});

test('accept-all shows with 2 requests, the modal lists the names, and cancel changes nothing', async ({ page }) => {
  await openRequests(page, [{ name: 'أحمد' }, { name: 'سارة <b>x</b>' }]);
  const btn = page.locator('.accept-all');
  await expect(btn).toBeVisible();
  await expect(btn).toContainText('اقبل الكل');
  await expect(btn.locator('.cnt')).toHaveText('2');
  await btn.click();
  const modal = page.locator('#approve-all-modal');
  await expect(modal).toHaveClass(/active/);
  await expect(modal).toContainText('تقبل كل الطلبات؟');
  await expect(modal.locator('.aa-names span')).toHaveText(['أحمد', 'سارة <b>x</b>']);
  await expect(modal.locator('.aa-names b')).toHaveCount(0);
  await modal.getByRole('button', { name: 'إلغاء' }).click();
  await expect(modal).not.toHaveClass(/active/);
  let st = await fbState(page);
  expect(st.guests).toHaveLength(0);
  await btn.click();
  await page.keyboard.press('Escape');
  await expect(modal).not.toHaveClass(/active/);
  await btn.click();
  await modal.click({ position: { x: 3, y: 3 } });
  await expect(modal).not.toHaveClass(/active/);
  st = await fbState(page);
  expect(st.guests).toHaveLength(0);
  expect(await calls(page, 'approve_requests')).toEqual([]);
});

test('accept-all creates guests oldest first, marks requests approved with the guest id, and the count follows', async ({ page }) => {
  await openRequests(page, [
    { name: 'ثالث', created_at: '2026-03-01T00:00:00.000000+00:00' },
    { name: 'أول', created_at: '2026-01-01T00:00:00.000000+00:00' },
    { name: 'ثاني', created_at: '2026-02-01T00:00:00.000000+00:00' },
  ], { guests: [G('WD-OLD', 'قديم')] });
  await expect(page.locator('.pending-item .pname')).toHaveText(['أول', 'ثاني', 'ثالث']);
  await page.locator('.accept-all').click();
  await expect(page.locator('#approve-all-modal .aa-names span')).toHaveText(['أول', 'ثاني', 'ثالث']);
  await acceptAll(page).click();
  await expect(page.locator('#toast')).toContainText('تم قبول 3');
  const st = await fbState(page);
  const made = st.guests.filter((g) => g.id !== 'WD-OLD');
  expect(made.map((g) => g.name)).toEqual(['أول', 'ثاني', 'ثالث']);
  made.forEach((g) => { expect(g.id).toMatch(/^WD-[0-9A-F]{12}$/); expect(g.scanned).toBe(false); });
  Object.values(st.requests).forEach(r => {
    expect(r.status).toBe('approved');
    expect(st.guests.find((g) => g.id === r.guest_id)).toBeTruthy();
  });
  expect(st.count).toBe(4);
  await expect(page.locator('.pending-item')).toHaveCount(0);
  await expect(page.locator('.guest-item')).toHaveCount(4);
});

test('accept-all on the free plan stops at the guest cap and leaves the oldest-first remainder pending', async ({ page }) => {
  await openRequests(page, [
    { name: 'د', created_at: '2026-01-04T00:00:00.000000+00:00' },
    { name: 'ب', created_at: '2026-01-02T00:00:00.000000+00:00' },
    { name: 'أ', created_at: '2026-01-01T00:00:00.000000+00:00' },
    { name: 'ج', created_at: '2026-01-03T00:00:00.000000+00:00' },
  ], { event: { paid: false }, guests: fill(3) });
  await page.locator('.accept-all').click();
  await expect(page.locator('#approve-all-modal')).toContainText('بيتقبل أول 2 (الأقدم)، والباقي 2 يظل معلّق');
  await acceptAll(page).click();
  await expect(page.locator('#toast')).toContainText('تم قبول 2 — وتبقى 2');
  const st = await fbState(page);
  expect(st.guests.filter((g) => !g.id.startsWith('WD-FILL')).map(g => g.name)).toEqual(['أ', 'ب']);
  expect(st.count).toBe(5);
  expect(Object.values(st.requests).filter(r => r.status === 'pending').map(r => r.name).sort()).toEqual(['ج', 'د']);
  await expect(page.locator('#payment-gate')).toBeVisible();
  expect(st.opened).toBe(0);
});

test('accept-all with the cap already reached writes nothing and opens the payment gate', async ({ page }) => {
  await openRequests(page, [{ name: 'أ' }, { name: 'ب' }], { event: { paid: false }, guests: fill(5) });
  await page.locator('.accept-all').click();
  await expect(page.locator('#approve-all-modal')).not.toHaveClass(/active/);
  const st = await fbState(page);
  expect(st.count).toBe(5);
  expect(Object.values(st.requests).every(r => r.status === 'pending')).toBe(true);
  expect(st.opened).toBeGreaterThan(0);
  expect(await calls(page, 'approve_requests')).toEqual([]);
});

test('accept-all handles 30 pending requests (two chunks)', async ({ page }) => {
  const reqs = Array.from({ length: 30 }, (_, i) => ({ name: 'ضيف ' + i, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 30 - i)).toISOString().replace('Z', '000+00:00') }));
  await openRequests(page, reqs, { event: { paid: true, guest_limit: 100 } });
  await page.locator('.accept-all').click();
  await acceptAll(page).click();
  await expect(page.locator('#toast')).toContainText('تم قبول 30');
  const st = await fbState(page);
  expect(st.guests).toHaveLength(30);
  expect(Object.values(st.requests).every(r => r.status === 'approved' && r.guest_id)).toBe(true);
  expect(st.guests[0].name).toBe('ضيف 29');
  expect((await calls(page, 'approve_requests')).map((a) => a.p_items.length)).toEqual([25, 5]);
});

test('accept-all skips a request that is no longer pending', async ({ page }) => {
  await openRequests(page, [{ name: 'أ' }, { name: 'ب' }, { name: 'ج' }]);
  await page.locator('.accept-all').click();
  await page.evaluate(() => { window.__fakeSupabase.requests.e1.r01.status = 'rejected'; });
  await acceptAll(page).click();
  await expect(page.locator('#toast')).toContainText('تم قبول 2');
  const st = await fbState(page);
  expect(st.guests.map(g => g.name).sort()).toEqual(['أ', 'ج']);
  expect(st.requests.r01.status).toBe('rejected');
  expect(st.requests.r01.guest_id).toBeNull();
});

test('accept-all: a double tap starts one run only (one call, two guests)', async ({ page }) => {
  await openRequests(page, [{ name: 'أ' }, { name: 'ب' }]);
  await page.evaluate(() => { window.__fakeSupabase.rpcDelay = { approve_requests: 400 }; });
  await page.locator('.accept-all').click();
  await acceptAll(page).evaluate((b) => { b.click(); b.click(); });
  await expect(page.locator('#toast')).toContainText('تم قبول 2');
  expect(await calls(page, 'approve_requests')).toHaveLength(1);
  const st = await fbState(page);
  expect(st.guests).toHaveLength(2);
});

test('accept-all while running: progress button and per-row buttons are disabled', async ({ page }) => {
  await openRequests(page, [{ name: 'أ' }, { name: 'ب' }, { name: 'ج' }]);
  await page.evaluate(() => { window.__fakeSupabase.rpcDelay = { approve_requests: 1200 }; });
  await page.locator('.accept-all').click();
  await acceptAll(page).click();
  await expect(page.locator('.accept-all')).toBeDisabled();
  await expect(page.locator('.accept-all')).toContainText('جاري القبول... 0 / 3');
  await expect(page.locator('.approve-btn').first()).toBeDisabled();
  await expect(page.locator('.reject-btn').first()).toBeDisabled();
  expect(await page.locator('.approve-btn:disabled').count()).toBe(3);
  await expect(page.locator('#toast')).toContainText('تم قبول 3');
});

test('accept-all: a failing second chunk reports what was accepted and what is left', async ({ page }) => {
  const reqs = Array.from({ length: 30 }, (_, i) => ({ name: 'ضيف ' + i, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString().replace('Z', '000+00:00') }));
  await openRequests(page, reqs, { event: { paid: true, guest_limit: 100 }, fail: { approve_requests: { error: 'network', skip: 1 } } });
  const alerts = [];
  page.on('dialog', d => { alerts.push(d.message()); d.dismiss(); });
  await page.locator('.accept-all').click();
  await acceptAll(page).click();
  await expect(page.locator('#toast')).toContainText('تم قبول 25 وتبقى 5');
  await expect(page.locator('#toast')).toContainText('حدّث الصفحة وتأكد');
  await expect.poll(() => alerts.length).toBe(1);
  const st = await fbState(page);
  expect(st.guests).toHaveLength(25);
  expect(Object.values(st.requests).filter(r => r.status === 'pending')).toHaveLength(5);
  await expect(page.locator('.accept-all')).toBeEnabled();
});

test('accept-all: the admin accepts beyond the guest cap', async ({ page }) => {
  await go(page, { user: ADMIN, admin: true, event: { owner_uid: 'u1', paid: false }, guests: fill(5), requests: pendingReqs([{ name: 'أ' }, { name: 'ب' }, { name: 'ج' }]) });
  await expect(page.locator('#requests-badge')).toHaveText('3');
  await menu(page);
  await page.getByRole('button', { name: /^الطلبات/ }).click();
  await page.locator('.accept-all').click();
  await expect(page.locator('#approve-all-modal')).not.toContainText('يظل معلّق');
  await acceptAll(page).click();
  await expect(page.locator('#toast')).toContainText('تم قبول 3');
  const st = await fbState(page);
  expect(st.guests).toHaveLength(8);
});

test('accept-all: the cap is reached inside the second chunk and the in-page limit banner shows', async ({ page }) => {
  const reqs = Array.from({ length: 30 }, (_, i) => ({ name: 'ضيف ' + i, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString().replace('Z', '000+00:00') }));
  await openRequests(page, reqs, { event: { paid: true, guest_limit: 27 } });
  await page.locator('.accept-all').click();
  await expect(page.locator('#approve-all-modal')).toContainText('بيتقبل أول 27 (الأقدم)، والباقي 3 يظل معلّق');
  await expect(page.locator('#aa-title')).toHaveText('قبول الطلبات؟');
  await acceptAll(page).click();
  await expect(page.locator('#payment-gate')).toBeVisible();
  const st = await fbState(page);
  expect(st.guests).toHaveLength(27);
  expect(Object.values(st.requests).filter(r => r.status === 'pending')).toHaveLength(3);
  expect(st.opened).toBe(0);
});

test('accept-all wording: a single fitting request says oldest only; all fitting keeps the full heading', async ({ page }) => {
  await openRequests(page, [{ name: 'أ' }, { name: 'ب' }, { name: 'ج' }], { event: { paid: false }, guests: fill(4) });
  await page.locator('.accept-all').click();
  await expect(page.locator('#approve-all-modal')).toContainText('بيتقبل الأقدم فقط، والباقي 2 يظل معلّق');
  await expect(page.locator('#approve-all-modal')).not.toContainText('أول 1');
  await page.locator('#approve-all-modal').getByRole('button', { name: 'إلغاء' }).click();
});

test('requests are ordered oldest first, and requests with the same time keep a steady order', async ({ page }) => {
  await openRequests(page, [
    { name: 'newest', created_at: '2026-05-01T00:00:00.000000+00:00' },
    { name: 'oldest', created_at: '2025-01-01T00:00:00.000000+00:00' },
    { name: 'same-b', created_at: '2026-01-01T00:00:00.000000+00:00' },
    { name: 'same-a', created_at: '2026-01-01T00:00:00.000000+00:00' },
  ]);
  // r00 newest, r01 oldest, r02 same-b, r03 same-a: same time -> by request id
  await expect(page.locator('.pending-item .pname')).toHaveText(['oldest', 'same-b', 'same-a', 'newest']);
});

test('the dashboard shows the event date as words with Western digits', async ({ page }) => {
  await go(page, { event: { date: '2026-10-29' } });
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('#ev-sub')).toContainText('الخميس 29 أكتوبر 2026');
});

test('the menu has a refresh button that forces a real reload — no address bar to pull down on, installed as a PWA', async ({ page }) => {
  await go(page);
  await expect(page.locator('#dashboard')).toBeVisible();
  await menu(page);
  await page.evaluate(() => { window.__beforeReload = true; });
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'تحديث الصفحة' }).click()]);
  expect(await page.evaluate(() => window.__beforeReload)).toBeUndefined();
});

test('an empty guest list says why: no match for the search, nobody attended yet, or everyone attended', async ({ page }) => {
  await go(page, { guests: [G('WD-1', 'أحمد')] });
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
  await go(page);
  await expect(page.locator('#guests-list .empty')).toHaveText('لا يوجد ضيف للآن');
});

test('a dashboard whose first read never answers says the connection is slow at 8 seconds and turns into a tap-to-retry only at 25', async ({ page }) => {
  await page.clock.install();
  await go(page, { latency: 100000000 });
  const msg = page.locator('#loading-msg');
  await expect(msg).toHaveText('جاري التحميل...');
  await page.clock.runFor(9000);
  await expect(msg).toHaveText('الاتصال بطيء، لحظات…');
  expect(await msg.evaluate((el) => el.style.cursor)).toBe('');
  await page.clock.runFor(17000);
  await expect(msg).toContainText('التحميل تأخر — اضغط هنا للمحاولة مرة ثانية');
  const reloaded = page.waitForEvent('load');
  await msg.click();
  await reloaded;
});

test('an invalid link message is left alone by the stuck-loading timer', async ({ page }) => {
  await page.clock.install();
  await go(page, {}, '/event.html');
  await expect(page.locator('#loading-msg')).toContainText('رابط غير صحيح');
  await page.clock.runFor(26000);
  await expect(page.locator('#loading-msg')).toContainText('رابط غير صحيح');
});

test('marking a guest VIP from the ⋮ menu saves it, shows the badge, and can be undone', async ({ page }) => {
  await go(page, { guests: [G('WD-1', 'أحمد')] });
  await expect(page.locator('.guest-item')).toHaveCount(1);
  const vip = async () => (await server(page)).guests[0].vip;

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

test('VIP on a guest who registered from the link also updates the request in the same step (one call, no warning toast)', async ({ page }) => {
  await go(page, { event: { paid: true }, guests: [G('WD-1', 'أحمد')], requests: [{ id: 'REQ-1', name: 'أحمد', status: 'approved', guest_id: 'WD-1' }] });
  await expect(page.locator('.guest-item')).toHaveCount(1);
  await page.locator('.guest-item .more-btn').click();
  await page.getByRole('button', { name: /تمييز كـ VIP/ }).click();
  await expect(page.locator('#toast')).toContainText('أحمد صار VIP — حمّل بطاقته من جديد');
  const s = await server(page);
  expect(s.guests[0].vip).toBe(true);
  expect(s.requests['REQ-1'].vip).toBe(true);
  expect(await calls(page, 'set_guest')).toHaveLength(1);
  await expect(page.locator('#toast')).not.toContainText('تعذّر تحديث بطاقة الضيف');
});

test('the guest ⋮ opens a sheet with the guest\'s name, code and status; cancel, the backdrop and Escape close it', async ({ page }) => {
  await go(page, { guests: [G('WD-1', 'أحمد', { scanned: true, vip: true }), G('WD-2', 'سارة')] });
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
  await go(page, { guests: [G('WD-1', 'ضيف عادي'), G('WD-2', 'ضيف مهم', { vip: true })] });
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
  await go(page, { event: { name: 'حفل تخرج نورة', type: 'graduation', date: '2026-12-20', venue: 'الدمام', maps_link: 'https://maps.example/x', slug: 'noura-grad', slug_decided: true }, slugs: { 'noura-grad': 'e1' } });
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
  const opened = (await server(page)).opened;
  expect(opened).toHaveLength(1);
  expect(opened[0].startsWith('https://wa.me/?text=')).toBe(true);
  const text = decodeURIComponent(opened[0].split('text=')[1]);
  expect(text.split('\n')[0]).toBe('*🎓 دعوة حفل تخرج ✨*');
  expect(text).toContain('حياكم الله في حفل تخرج نورة');
  expect(text.trim().endsWith('/noura-grad')).toBe(true);
  await expect.poll(async () => (await stored(page)).welcome_message).toBe('حياكم الله في حفل تخرج نورة');

  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
});

test('the owner can change the event\'s kind in the edit card; an event saved before kinds existed shows as a wedding', async ({ page }) => {
  await go(page, { event: { type: '', slug_decided: true } });
  await expect(page.locator('#dashboard')).toBeVisible();
  await menu(page);
  await page.getByRole('button', { name: /تعديل المناسبة/ }).click();
  await expect(page.locator('#edit-ev-type').getByRole('radio', { name: 'زفاف' })).toHaveAttribute('aria-checked', 'true');
  await page.locator('#edit-ev-type').getByRole('radio', { name: 'تخرج' }).click();
  await page.getByRole('button', { name: 'حفظ التعديل' }).click();
  await expect.poll(async () => (await stored(page)).type).toBe('graduation');
  // The colour is the owner's own choice and stays as it was.
  expect((await stored(page)).theme).toBe('gold');
});

test('the theme dots save the colour on the event', async ({ page }) => {
  await go(page, { event: { slug_decided: true } });
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.locator('.theme-dot.t-rose').click();
  await expect.poll(async () => (await stored(page)).theme).toBe('rose');
  await expect(page.locator('body')).toHaveAttribute('data-theme', 'rose');
});

test('an event with no link yet gets one from its name when the owner opens it, skipping a taken name', async ({ page }) => {
  await go(page, { slugs: { 'hfl-tjreebi': 'other' } });
  await expect.poll(async () => (await stored(page)).slug).toBe('hfl-tjreebi-2');
  const s = await server(page);
  expect(s.slugs['hfl-tjreebi-2']).toBe('e1');
  expect(s.slugs['hfl-tjreebi']).toBe('other');
  await expect(page.locator('#invite-link')).toHaveValue(/\/hfl-tjreebi-2$/);
  await menu(page);
  await page.getByRole('button', { name: /تعديل المناسبة/ }).click();
  await expect(page.locator('#edit-ev-slug')).toHaveValue('hfl-tjreebi-2');
});

test('a link is picked automatically once: not when the owner already cleared it, not when one is held', async ({ page }) => {
  await go(page, { event: { slug_decided: true } });
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.waitForTimeout(300);
  expect(await calls(page, 'auto_claim_slug')).toEqual([]);
  await expect(page.locator('#invite-link')).toHaveValue(/invite\.html\?event=e1$/);
});

test('an event that holds a link already does not ask for another', async ({ page }) => {
  await go(page, { event: { slug: 'mine-now', slug_decided: true }, slugs: { 'mine-now': 'e1' } });
  await expect(page.locator('#invite-link')).toHaveValue(/\/mine-now$/);
  expect(await calls(page, 'auto_claim_slug')).toEqual([]);
});

test('the admin opening a customer\'s event does not pick a link for it', async ({ page }) => {
  await go(page, { user: ADMIN, admin: true, event: { owner_uid: 'u1' }, guests: [G('WD-1', 'أحمد')] });
  await expect(page.locator('.guest-item')).toHaveCount(1);
  await page.waitForTimeout(500);
  expect((await stored(page)).slug == null).toBe(true);
  expect(await calls(page, 'auto_claim_slug')).toEqual([]);
  await expect(page.locator('#invite-link')).toHaveValue(/invite\.html\?event=e1$/);
});

test('a readable link: the owner picks a name, it is claimed, and the invite link shows it', async ({ page }) => {
  // slug_decided with no slug = the owner cleared the link, so no name is picked automatically.
  await go(page, { event: { slug_decided: true }, slugs: { 'taken-name': 'other' } });
  await expect(page.locator('#dashboard')).toBeVisible();
  const alerts = [];
  page.on('dialog', d => { alerts.push(d.message()); d.accept(); });
  const openEdit = async () => { await menu(page); await page.getByRole('button', { name: /تعديل المناسبة/ }).click(); };

  // Arabic / bad characters are refused before anything is written.
  await openEdit();
  await page.locator('#edit-ev-slug').fill('حلا تركي');
  await page.getByRole('button', { name: 'حفظ التعديل' }).click();
  await expect.poll(() => alerts.length).toBe(1);
  expect(alerts[0]).toContain('بالإنجليزي');
  expect((await stored(page)).slug == null).toBe(true);
  expect(await calls(page, 'claim_slug')).toEqual([]);

  // A name someone else holds is refused.
  await page.locator('#edit-ev-slug').fill('taken-name');
  await page.getByRole('button', { name: 'حفظ التعديل' }).click();
  await expect.poll(() => alerts.length).toBe(2);
  expect(alerts[1]).toContain('مستخدم');

  // A free name: claimed, saved on the event, and the invite link uses it.
  await page.locator('#edit-ev-slug').fill('Hala Turki');
  await page.getByRole('button', { name: 'حفظ التعديل' }).click();
  await expect.poll(async () => (await stored(page)).slug).toBe('hala-turki');
  expect((await server(page)).slugs['hala-turki']).toBe('e1');
  await expect(page.locator('#invite-link')).toHaveValue(/\/hala-turki$/);

  // Changing it releases the old name.
  await openEdit();
  await expect(page.locator('#edit-ev-slug')).toHaveValue('hala-turki');
  await page.locator('#edit-ev-slug').fill('hala-2026');
  await page.getByRole('button', { name: 'حفظ التعديل' }).click();
  await expect.poll(async () => (await stored(page)).slug).toBe('hala-2026');
  const s = (await server(page)).slugs;
  expect(s['hala-turki']).toBeUndefined();
  expect(s['hala-2026']).toBe('e1');
});

test('the name, venue and map link inputs limit typing to 80, 100 and 300 characters', async ({ page }) => {
  await go(page);
  await expect(page.locator('#edit-ev-name')).toHaveAttribute('maxlength', '80');
  await expect(page.locator('#edit-ev-venue')).toHaveAttribute('maxlength', '100');
  await expect(page.locator('#edit-ev-maps')).toHaveAttribute('maxlength', '300');
});

const SHARE_BTN = (page) => page.locator('#invite-link').locator('xpath=..').getByRole('button', { name: 'مشاركة' });

test('a welcome line equal to the kind\'s default is stored as an empty string', async ({ page }) => {
  await go(page, { event: { slug: 'x-ev', slug_decided: true, welcome_message: 'نص خاص' } });
  await SHARE_BTN(page).click();
  await page.locator('#share-welcome').fill('يسعدنا حضوركم ومشاركتنا فرحتنا 🤍');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await stored(page)).welcome_message).toBe('');
});

test('HTML in the welcome line and the event name is shown as text in the share preview', async ({ page }) => {
  await go(page, { event: { slug: 'x-ev', slug_decided: true, name: '<img id="xn" src=x onerror="window.__x=1">' } });
  await SHARE_BTN(page).click();
  await page.locator('#share-welcome').fill('<img id="xw" src=x onerror="window.__x=1">');
  const preview = page.locator('#share-preview');
  await expect(preview).toContainText('<img id="xw"');
  await expect(preview).toContainText('<img id="xn"');
  await expect(preview.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__x)).toBeUndefined();
});

test('the share button opens the payment WhatsApp, not the preview, when the free limit is reached', async ({ page }) => {
  await go(page, { event: { slug: 'x-ev', slug_decided: true, paid: false }, guests: fill(5) });
  await expect(page.locator('#payment-gate')).toBeVisible();
  await SHARE_BTN(page).click();
  await expect(page.locator('#share-modal')).toBeHidden();
  const opened = (await server(page)).opened;
  expect(opened).toHaveLength(1);
  expect(decodeURIComponent(opened[0])).toContain('أبي أفعّل مناسبة');
});

test('a failed welcome save tells the owner and still closes the modal', async ({ page }) => {
  await go(page, { event: { slug: 'x-ev', slug_decided: true } });
  await SHARE_BTN(page).click();
  await page.evaluate(() => { window.__fakeSupabase.fail = { 'from:events': { error: 'network' } }; });
  await page.locator('#share-welcome').fill('رسالة جديدة');
  await page.keyboard.press('Escape');
  await expect(page.locator('#share-modal')).toBeHidden();
  await expect(page.locator('#toast')).toContainText('ما انحفظت رسالة الترحيب');
});

for (const [kind, title, file] of [['wedding', 'دعوة زفاف', 'kind-wedding.svg'], ['graduation', 'دعوة حفل تخرج', 'kind-graduation.svg'], ['event', 'دعوة فعالية', 'kind-event.svg']]) {
  test(`the organizer splash shows the remembered ${kind} kind at once`, async ({ page }) => {
    await page.addInitScript((k) => { try { localStorage.setItem('ev_kind_nope', k); } catch (e) {} }, kind);
    await go(page, {}, '/event.html?id=nope');
    await expect(page.locator('#splash .splash-title')).toHaveText(title);
    await expect(page.locator('#splash .splash-rings img')).toHaveAttribute('src', 'icons/' + file);
  });
}

test('the organizer splash starts neutral with nothing remembered, then switches to the event kind and remembers it', async ({ page }) => {
  await page.addInitScript(() => { window.__firstKind = null; document.addEventListener('DOMContentLoaded', () => { const i = document.querySelector('#splash .splash-rings img'); window.__firstKind = i && i.getAttribute('src'); }); });
  await go(page, { event: { type: 'graduation' } });
  await expect(page.locator('#dashboard')).toBeVisible();
  expect(await page.evaluate(() => window.__firstKind)).toBe('icons/logo.svg');
  await expect(page.locator('#splash .splash-title')).toHaveText('دعوة حفل تخرج');
  await expect(page.locator('#splash .splash-rings img')).toHaveAttribute('src', 'icons/kind-graduation.svg');
  expect(await page.evaluate(() => localStorage.getItem('ev_kind_e1'))).toBe('graduation');
});

test('an event with no type remembers as a wedding', async ({ page }) => {
  await go(page, { event: { type: '' } });
  await expect(page.locator('#dashboard')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('ev_kind_e1'))).toBe('wedding');
});

for (const [label, next] of [['anonymous', { id: 'anon-9', is_anonymous: true, email: null }], ['signed out', null]]) {
  test('cross-tab auth: when another tab leaves the user ' + label + ', the dashboard shows the session-ended message and no connection banner, and returning reloads', async ({ page }) => {
    await go(page, { guests: [G('WD-1', 'أحمد')] });
    await expect(page.locator('.guest-item')).toHaveCount(1);
    await page.evaluate(() => { window.__marker = 1; });

    await page.evaluate((u) => { if (u) window.__srv.signInElsewhere(u); else window.__srv.signOutElsewhere(); }, next);
    await expect(page.locator('#denied-msg')).toContainText('انتهت جلسة الدخول على هذا المتصفح');
    await expect(page.locator('#denied-msg a')).toHaveAttribute('href', 'app.html');
    await expect(page.locator('#dashboard')).toBeHidden();
    const before = (await calls(page, 'event_live')).length;
    await page.waitForTimeout(300);
    await expect(page.locator('#connection-banner')).toBeHidden();
    expect(await page.evaluate(() => window.__marker)).toBe(1);
    // the live poll stops: no more failing reads against a dead sign-in
    expect((await calls(page, 'event_live')).length).toBe(before);

    const reloaded = page.waitForEvent('load');
    await page.evaluate(() => window.__srv.signInElsewhere({ id: 'u1', email: 'customer@example.com', is_anonymous: false }));
    await reloaded;
    expect(await page.evaluate(() => window.__marker)).toBeUndefined();
    await expect(page.locator('#dashboard')).toBeVisible();
  });
}

// Deleting an event asks the owner to type «حذف» (confirmEventDelete in utils.js).
async function openEventDeleteModal(page, opts) {
  await go(page, opts);
  await expect(page.locator('#dashboard')).toBeVisible();
  await menu(page);
  await page.getByRole('button', { name: /تعديل المناسبة/ }).click();
  await page.getByRole('button', { name: 'حذف المناسبة نهائيًا' }).click();
}

const twoGuests = () => ({ guests: [G('WD-1', 'أحمد'), G('WD-2', 'سارة')] });

const serverCounts = (page) => page.evaluate(() => ({
  event: !!window.__fakeSupabase.events.e1,
  guests: window.__fakeSupabase.doors.e1.guests.length,
}));

test('deleting an event opens a modal with its name and guest count; the red button stays disabled until «حذف» is typed', async ({ page }) => {
  await openEventDeleteModal(page, twoGuests());
  const modal = page.locator('#delete-event-modal');
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('حفل تجريبي');
  await expect(modal).toContainText('2 ضيفين');
  const ok = modal.locator('.del-ev-confirm');
  await expect(ok).toBeDisabled();
  await page.locator('#del-ev-input').fill('حذف المناسبة');
  await expect(ok).toBeDisabled();
  await page.locator('#del-ev-input').fill('حفل تجريبي');
  await expect(ok).toBeDisabled();
  await page.locator('#del-ev-input').fill('حذف');
  await expect(ok).toBeEnabled();
  expect(await serverCounts(page)).toEqual({ event: true, guests: 2 });
});

test('cancel, Escape and tapping outside the delete modal all close it and keep the event and its guests', async ({ page }) => {
  await openEventDeleteModal(page, twoGuests());
  const modal = page.locator('#delete-event-modal');

  await page.locator('#del-ev-input').fill('حذف');
  await modal.locator('.del-ev-cancel').click();
  await expect(modal).toHaveCount(0);

  await page.getByRole('button', { name: 'حذف المناسبة نهائيًا' }).click();
  await expect(modal).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);

  await page.getByRole('button', { name: 'حذف المناسبة نهائيًا' }).click();
  await expect(modal).toBeVisible();
  await modal.click({ position: { x: 3, y: 3 } });
  await expect(modal).toHaveCount(0);

  // Word typed, then Enter on a focused «إلغاء»: cancels, never deletes.
  await page.getByRole('button', { name: 'حذف المناسبة نهائيًا' }).click();
  await page.locator('#del-ev-input').fill('حذف');
  await modal.locator('.del-ev-cancel').focus();
  await page.keyboard.press('Enter');
  await expect(modal).toHaveCount(0);

  expect(await serverCounts(page)).toEqual({ event: true, guests: 2 });
  expect(await calls(page, 'delete_event')).toEqual([]);
  await expect(page.locator('#dashboard')).toBeVisible();
});

test('typing «حذف» and confirming deletes the event in one server call, gives the slot back, and goes back to app.html', async ({ page }) => {
  await openEventDeleteModal(page, { ...twoGuests(), limits: { u1: { event_limit: 1, event_count: 1 } } });
  // app.html's fresh load would re-seed the fake server, so the leaving page
  // saves what its server holds in sessionStorage (written synchronously, so
  // it survives the navigation) and app.html is replaced by a blank page.
  await page.route(/\/app\.html/, (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>app</title>' }));
  await page.evaluate(() => window.addEventListener('pagehide', () => sessionStorage.setItem('afterDelete', JSON.stringify({
    event: !!window.__fakeSupabase.events.e1,
    count: window.__fakeSupabase.limits.u1.event_count,
    calls: window.__fakeSupabase.calls.filter((c) => c.name === 'delete_event').length,
  }))));
  await page.locator('#del-ev-input').fill('حذف');
  await page.locator('#delete-event-modal .del-ev-confirm').click();
  await page.waitForURL(/app\.html/);
  expect(JSON.parse(await page.evaluate(() => sessionStorage.getItem('afterDelete')))).toEqual({ event: false, count: 0, calls: 1 });
});

test('a failed delete keeps the owner on the page with an error', async ({ page }) => {
  await openEventDeleteModal(page, { ...twoGuests(), fail: { delete_event: { error: 'network' } } });
  const alerts = [];
  page.on('dialog', d => { alerts.push(d.message()); d.accept(); });
  await page.locator('#del-ev-input').fill('حذف');
  await page.locator('#delete-event-modal .del-ev-confirm').click();
  await expect.poll(() => alerts.length).toBe(1);
  expect(alerts[0]).toBe('تعذّر الاتصال — تأكد من الإنترنت وجرّب مرة ثانية');
  await expect(page.locator('#dashboard')).toBeVisible();
  expect((await serverCounts(page)).event).toBe(true);
});

test('an event name with quotes and tags is shown as plain text in the delete modal', async ({ page }) => {
  await openEventDeleteModal(page, { ...twoGuests(), event: { name: 'زفاف "سارة" <b>x</b>' } });
  const name = page.locator('#delete-event-modal .del-ev-name');
  await expect(name).toHaveText('زفاف "سارة" <b>x</b>');
  await expect(name.locator('b')).toHaveCount(0);
});

test('the edit card refuses a map link that is not http(s) and keeps the saved values', async ({ page }) => {
  await go(page, { event: { maps_link: 'https://maps.example.com/ok', slug_decided: true } });
  const alerts = [];
  page.on('dialog', (d) => { alerts.push(d.message()); d.accept(); });
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.evaluate(() => { document.getElementById('edit-ev-maps').value = 'javascript:alert(1)'; document.getElementById('edit-ev-name').value = 'اسم جديد'; saveEventEdit(); });
  await expect.poll(() => alerts.length).toBe(1);
  expect(alerts[0]).toContain('http');
  const ev = await stored(page);
  expect(ev.maps_link).toBe('https://maps.example.com/ok');
  expect(ev.name).toBe('حفل تجريبي');
  await page.evaluate(() => { document.getElementById('edit-ev-maps').value = 'https://maps.example.com/new'; saveEventEdit(); });
  await expect.poll(async () => (await stored(page)).maps_link).toBe('https://maps.example.com/new');
});

// ---- live view: the 5-second poll (Data.event.watch) ----

// Moves the fake clock in small steps so each poll's promises settle in between.
const advance = async (page, ms) => { for (let i = 0; i < ms / 500; i++) { await page.clock.runFor(500); await page.evaluate(async () => { for (let k = 0; k < 20; k++) await Promise.resolve(); }); } };

test('the counters follow the server within about 5 seconds: a check-in at the door shows on the dashboard', async ({ page }) => {
  await page.clock.install();
  await go(page, { guests: [G('WD-1', 'أحمد'), G('WD-2', 'سارة')] });
  await advance(page, 1000);
  await expect(page.locator('#stat-total')).toHaveText('2');
  await expect(page.locator('#stat-attended')).toHaveText('0');
  await page.evaluate(() => window.__srv.checkIn('e1', 'WD-1'));
  await advance(page, 6500);
  await expect(page.locator('#stat-attended')).toHaveText('1');
  await expect(page.locator('#att-pct')).toHaveText('50%');
  await expect(page.locator('.guest-item', { hasText: 'أحمد' }).locator('.undo-btn')).toBeVisible();
});

test('the live poll pauses while the page is hidden and runs at once when it is shown again', async ({ page }) => {
  await page.clock.install();
  await go(page, { guests: [G('WD-1', 'أحمد')] });
  await advance(page, 1000);
  await expect(page.locator('.guest-item')).toHaveCount(1);
  const hide = (hidden) => page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await hide(true);
  const before = (await calls(page, 'event_live')).length;
  await advance(page, 30000);
  expect((await calls(page, 'event_live')).length).toBe(before);
  await page.evaluate(() => window.__srv.checkIn('e1', 'WD-1'));
  await hide(false);
  await advance(page, 1000);
  expect((await calls(page, 'event_live')).length).toBeGreaterThan(before);
  await expect(page.locator('#stat-attended')).toHaveText('1');
});

test('an owner who turned on request notifications keeps a slower check running while the page is hidden', async ({ page }) => {
  await stubNotificationApi(page, { initialPermission: 'granted' });
  await page.clock.install();
  await go(page);
  await advance(page, 1000);
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const before = (await calls(page, 'event_live')).length;
  await advance(page, 65000);
  const n = (await calls(page, 'event_live')).length - before;
  expect(n).toBeGreaterThanOrEqual(1);
  expect(n).toBeLessThanOrEqual(3);
});

test('an idle dashboard asks only for the small live row: no guest list read after the first one', async ({ page }) => {
  await page.clock.install();
  await go(page, { guests: [G('WD-1', 'أحمد')], requests: [{ id: 'r1', name: 'طلب' }] });
  await advance(page, 1000);
  await expect(page.locator('.guest-item')).toHaveCount(1);
  expect((await calls(page, 'owner_guests')).length).toBe(1);
  expect((await calls(page, 'owner_requests')).length).toBe(1);
  const live = (await calls(page, 'event_live')).length;
  await advance(page, 30000);
  expect((await calls(page, 'event_live')).length).toBeGreaterThanOrEqual(live + 5);
  expect((await calls(page, 'owner_guests')).length).toBe(1);
  expect((await calls(page, 'owner_requests')).length).toBe(1);
});

test('the guest list is read as a delta only when last_change moves', async ({ page }) => {
  await page.clock.install();
  await go(page, { guests: [G('WD-1', 'أحمد'), G('WD-2', 'سارة')] });
  await advance(page, 1000);
  await expect(page.locator('.guest-item')).toHaveCount(2);
  await page.evaluate(() => window.__srv.rename('e1', 'WD-2', 'سارة الجديدة'));
  await advance(page, 6000);
  await expect(page.locator('.guest-item .name').filter({ hasText: 'سارة الجديدة' })).toHaveCount(1);
  const reads = await calls(page, 'owner_guests');
  expect(reads).toHaveLength(2);
  expect(reads[0].p_since).toBeNull();
  expect(reads[1].p_since).not.toBeNull();
});

test('a guest deleted on another device vanishes through the tombstone, without a full list read', async ({ page }) => {
  await page.clock.install();
  await go(page, { guests: [G('WD-1', 'أحمد'), G('WD-2', 'سارة')] });
  await advance(page, 1000);
  await expect(page.locator('.guest-item')).toHaveCount(2);
  await page.evaluate(() => window.__srv.removeGuest('e1', 'WD-2'));
  await advance(page, 6000);
  await expect(page.locator('.guest-item')).toHaveCount(1);
  await expect(page.locator('#stat-total')).toHaveText('1');
  expect((await calls(page, 'owner_guests')).filter((a) => a.p_since === null)).toHaveLength(1);
});

test('your own change is not undone by a poll that was already on its way', async ({ page }) => {
  await go(page, { guests: [G('WD-1', 'أحمد')] });
  await expect(page.locator('.guest-item')).toHaveCount(1);
  await page.evaluate(() => { window.__fakeSupabase.rpcDelay = { event_live: 600 }; });
  await syncNow(page);   // a poll is now in flight
  page.on('dialog', d => d.accept());
  await page.locator('.attend-btn').click();
  await expect(page.locator('.undo-btn')).toBeVisible();
  await page.waitForTimeout(2500);
  await expect(page.locator('.undo-btn')).toBeVisible();
  await expect(page.locator('#stat-attended')).toHaveText('1');
  expect((await server(page)).guests[0].scanned).toBe(true);
});

test('a request that arrives while the page is open shows up through the poll, with the badge', async ({ page }) => {
  await go(page, { requests: [{ id: 'r1', name: 'الأول' }] });
  await expect(page.locator('#requests-badge')).toHaveText('1');
  await addRequest(page, 'r2', 'الثاني');
  await syncNow(page);
  await expect(page.locator('#requests-badge')).toHaveText('2');
  await expect(page.locator('#top-menu-badge')).toHaveText('2');
  await menu(page);
  await page.getByRole('button', { name: /^الطلبات/ }).click();
  await expect(page.locator('.pending-item .pname')).toHaveText(['الأول', 'الثاني']);
});

test('the connection banner shows while the poll fails and goes away when it works again', async ({ page }) => {
  await go(page, { guests: [G('WD-1', 'أحمد')] });
  await expect(page.locator('.guest-item')).toHaveCount(1);
  await expect(page.locator('#connection-banner')).toBeHidden();
  await page.evaluate(() => { window.__fakeSupabase.fail = { event_live: { error: 'network', times: 1 } }; });
  await syncNow(page);
  await expect(page.locator('#connection-banner')).toBeVisible();
  // the poller backs off after a failure; a manual refresh asks again at once
  await expect(async () => { await syncNow(page); await expect(page.locator('#connection-banner')).toBeHidden({ timeout: 500 }); }).toPass({ timeout: 8000 });
});

test('a list of 2000 guests is read in pages of 1000 (two full pages, then the closing empty one) and shown whole', async ({ page }) => {
  await go(page, { guests: fill(2000), event: { paid: true, guest_limit: 2000 }, maxRows: 1000 });
  await expect(page.locator('#stat-total')).toHaveText('2000');
  await expect(page.locator('.guest-item')).toHaveCount(2000);
  expect((await calls(page, 'owner_guests')).map((a) => a.p_limit)).toEqual([1000, 1000, 1000]);
});

test('1500 guests take two reads: 1000 and 500', async ({ page }) => {
  await go(page, { guests: fill(1500), event: { paid: true, guest_limit: 2000 }, maxRows: 1000 });
  await expect(page.locator('.guest-item')).toHaveCount(1500);
  expect((await calls(page, 'owner_guests')).length).toBe(2);
});

test('an import whose reply is lost half way: the error is shown and the list is read again to show what landed', async ({ page }) => {
  await go(page, { event: { paid: true } });
  await expect(page.locator('#dashboard')).toBeVisible();
  // the first 50 names reach the server but the answer never comes back (a timeout)
  await page.evaluate(() => { window.__fakeSupabase.dropReply = { add_guests: 1 }; });
  const alerts = [];
  page.on('dialog', d => { alerts.push(d.message()); d.accept(); });
  const names = Array.from({ length: 100 }, (_, i) => 'اسم ' + (i + 1)).join('\n');
  await page.locator('#csv-import').setInputFiles({ name: 'guests.csv', mimeType: 'text/csv', buffer: Buffer.from(names) });
  await expect.poll(() => alerts.length).toBe(1);
  expect(alerts[0]).toBe('تعذّر الاتصال — تأكد من الإنترنت وجرّب مرة ثانية');
  await expect(page.locator('.guest-item')).toHaveCount(50);
  expect((await server(page)).guests).toHaveLength(50);
  expect((await calls(page, 'add_guests'))).toHaveLength(1);
});

// ---- review round: imports after a lost reply, notifications, event gone ----

const namesOnServer = async (page) => (await server(page)).guests.map((g) => g.name);
const hideTab = (page) => page.evaluate(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  document.dispatchEvent(new Event('visibilitychange'));
});

test('an import whose reply was lost, uploaded again at once, creates no duplicates', async ({ page }) => {
  await go(page, { event: { paid: true } });
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.evaluate(() => { window.__fakeSupabase.dropReply = { add_guests: 1 }; });
  const alerts = [];
  page.on('dialog', d => { alerts.push(d.message()); d.accept(); });
  const file = { name: 'guests.csv', mimeType: 'text/csv', buffer: Buffer.from(Array.from({ length: 100 }, (_, i) => 'اسم ' + (i + 1)).join('\n')) };
  await page.locator('#csv-import').setInputFiles(file);
  await expect.poll(() => alerts.length).toBe(1);
  expect(alerts[0]).toBe('تعذّر الاتصال — تأكد من الإنترنت وجرّب مرة ثانية');
  // the list already shows what landed (the refresh was awaited before the alert)
  await expect(page.locator('.guest-item')).toHaveCount(50);
  await page.locator('#csv-import').setInputFiles(file);
  await expect.poll(() => alerts.length).toBe(2);
  await expect(page.locator('.guest-item')).toHaveCount(100);
  const names = await namesOnServer(page);
  expect(names).toHaveLength(100);
  expect(new Set(names).size).toBe(100);
  expect(alerts[1]).toContain('تجاهلنا 50');
});

test('a failed import batch shows the error, keeps the earlier batches and reads the list again from the server', async ({ page }) => {
  await go(page, { event: { paid: true }, fail: { add_guests: { error: 'network', skip: 1 } } });
  await expect(page.locator('#dashboard')).toBeVisible();
  const alerts = [];
  page.on('dialog', d => { alerts.push(d.message()); d.accept(); });
  await page.locator('#csv-import').setInputFiles({ name: 'g.csv', mimeType: 'text/csv', buffer: Buffer.from(Array.from({ length: 80 }, (_, i) => 'ض' + (i + 1)).join('\n')) });
  await expect.poll(() => alerts.length).toBe(1);
  expect(alerts[0]).toBe('تعذّر الاتصال — تأكد من الإنترنت وجرّب مرة ثانية');
  await expect(page.locator('.guest-item')).toHaveCount(50);
  expect((await calls(page, 'owner_guests')).length).toBeGreaterThanOrEqual(2);
});

test('only one import runs at a time', async ({ page }) => {
  await go(page, { event: { paid: true } });
  await expect(page.locator('#dashboard')).toBeVisible();
  page.on('dialog', d => d.accept());
  await page.evaluate(() => { window.__fakeSupabase.rpcDelay = { add_guests: 300 }; });
  await page.evaluate(() => { importGuestNames(['أ', 'ب']); importGuestNames(['أ', 'ب']); });
  await expect(page.locator('.guest-item')).toHaveCount(2);
  expect(await calls(page, 'add_guests')).toHaveLength(1);
});

test('turning notifications on later starts the background check without restarting the watch', async ({ page }) => {
  await stubNotificationApi(page, { initialPermission: 'default' });
  await page.clock.install();
  await go(page, { guests: [G('WD-1', 'أحمد')], requests: [{ id: 'r1', name: 'طلب' }] });
  await advance(page, 1000);
  await expect(page.locator('.guest-item')).toHaveCount(1);
  await hideTab(page);
  let n = (await calls(page, 'event_live')).length;
  await advance(page, 65000);
  expect((await calls(page, 'event_live')).length).toBe(n);   // permission not granted: paused
  await menu(page);
  await page.getByRole('button', { name: 'تفعيل إشعارات الطلبات' }).click();
  await advance(page, 65000);
  expect((await calls(page, 'event_live')).length).toBeGreaterThan(n);
  expect((await calls(page, 'owner_guests')).length).toBe(1);
  expect((await calls(page, 'owner_requests')).length).toBe(1);
});

test('the 30 s background check stops when the user signs out elsewhere', async ({ page }) => {
  await stubNotificationApi(page, { initialPermission: 'granted' });
  await page.clock.install();
  await go(page);
  await advance(page, 1000);
  await hideTab(page);
  await page.evaluate(() => window.__srv.signOutElsewhere());
  await advance(page, 500);
  const n = (await calls(page, 'event_live')).length;
  await advance(page, 65000);
  expect((await calls(page, 'event_live')).length).toBe(n);
});

test('an event deleted on another device shows the same screen as an event that is gone, and the watch stops', async ({ page }) => {
  await stubNotificationApi(page, { initialPermission: 'granted' });
  await page.clock.install();
  await go(page, { guests: [G('WD-1', 'أحمد')] });
  await advance(page, 1000);
  await expect(page.locator('.guest-item')).toHaveCount(1);
  await page.evaluate(() => { delete window.__fakeSupabase.events.e1; });
  await advance(page, 6000);
  await expect(page.locator('#denied-msg')).toBeVisible();
  await expect(page.locator('#denied-msg')).toContainText('غير مصرح لك بالوصول لهذه المناسبة');
  await expect(page.locator('#dashboard')).toBeHidden();
  const n = (await calls(page, 'event_live')).length;
  await hideTab(page);
  await advance(page, 65000);
  expect((await calls(page, 'event_live')).length).toBe(n);
});

test('leaving the page ends the background check', async ({ page }) => {
  await stubNotificationApi(page, { initialPermission: 'granted' });
  await go(page);
  await expect(page.locator('#dashboard')).toBeVisible();
  expect(await page.evaluate(() => { liveWatch.stop(); const before = window.__fakeSupabase.calls.length; return before; })).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  const after = (await calls(page, 'event_live')).length;
  await page.waitForTimeout(700);
  expect((await calls(page, 'event_live')).length).toBe(after);
});

// ---- error alerts: one approved sentence per code, the old format for the rest ----

const ERR_SENTENCES = {
  offline: 'تعذّر الاتصال — تأكد من الإنترنت وجرّب مرة ثانية',
  timeout: 'الاتصال بطيء وما انتهت العملية — حدّث الصفحة وتأكد قبل ما تعيد',
  permission: 'ما عندك صلاحية لهذا الإجراء — سجّل الدخول من جديد',
};
const FAILS = { offline: { message: 'Failed to fetch', code: '' }, timeout: { message: 'DATA_TIMEOUT', code: '' }, permission: { message: 'NOT_ALLOWED', code: '42501' } };
for (const code of Object.keys(ERR_SENTENCES)) {
  test('a failed write shows exactly the approved «' + code + '» sentence (guest action, edit card and delete)', async ({ page }) => {
    await go(page, { event: { paid: true, slug_decided: true }, guests: [G('WD-1', 'أحمد')], fail: { set_guest_scanned: { error: FAILS[code] }, 'from:events': { error: FAILS[code], skip: 1 }, delete_event: { error: FAILS[code] } } });
    await expect(page.locator('.guest-item')).toHaveCount(1);
    const alerts = [];
    page.on('dialog', d => { if (d.type() === 'alert') alerts.push(d.message()); d.accept(); });
    await page.locator('.attend-btn').click();
    await expect.poll(() => alerts.length).toBe(1);
    await page.evaluate(() => { document.getElementById('edit-ev-name').value = 'جديد'; saveEventEdit(); });
    await expect.poll(() => alerts.length).toBe(2);
    await page.evaluate(() => { eventData.guestCount = 0; });
    await menu(page);
    await page.getByRole('button', { name: /تعديل المناسبة/ }).click();
    await page.getByRole('button', { name: 'حذف المناسبة نهائيًا' }).click();
    await page.locator('#del-ev-input').fill('حذف');
    await page.locator('#delete-event-modal .del-ev-confirm').click();
    await expect.poll(() => alerts.length).toBe(3);
    expect(alerts).toEqual([ERR_SENTENCES[code], ERR_SENTENCES[code], ERR_SENTENCES[code]]);
  });
}

test('an error with no approved sentence keeps today\'s «صار خطأ: code — message» format', async ({ page }) => {
  await go(page, { guests: [G('WD-1', 'أحمد')], fail: { set_guest_scanned: { error: { message: 'BAD_INPUT', code: '22023' } } } });
  await expect(page.locator('.guest-item')).toHaveCount(1);
  const alerts = [];
  page.on('dialog', d => { alerts.push(d.message()); d.accept(); });
  await page.locator('.attend-btn').click();
  await expect.poll(() => alerts.length).toBe(2);   // the confirm, then the alert
  expect(alerts[1]).toBe('صار خطأ: bad-input — BAD_INPUT');
});

// ---- VIP, end to end ----

test('VIP from the guest sheet: the row shows ★ VIP, the guest\'s own request reads vip=true in the same step, and un-VIP reverses both', async ({ page }) => {
  const rid = 'REQ-VIP-0123456789ABCDEF';
  await go(page, { event: { paid: true }, guests: [G('WD-1', 'سارة')], requests: [{ id: rid, name: 'سارة', status: 'approved', guest_id: 'WD-1' }] });
  await expect(page.locator('.guest-item')).toHaveCount(1);
  const seen = () => page.evaluate((id) => window.Data.invite.getRequest('e1', id), rid);
  await page.locator('.guest-item .more-btn').click();
  await page.getByRole('button', { name: /تمييز كـ VIP/ }).click();
  await expect(page.locator('.guest-item .vip-badge')).toHaveText('★ VIP');
  expect((await seen()).vip).toBe(true);
  expect(await calls(page, 'set_guest')).toHaveLength(1);
  await page.locator('.guest-item .more-btn').click();
  await page.getByRole('button', { name: /إلغاء تمييز VIP/ }).click();
  await expect(page.locator('.guest-item .vip-badge')).toHaveCount(0);
  expect((await seen()).vip).toBe(false);
  expect((await server(page)).guests[0].vip).toBe(false);
});

test('approve as VIP creates a VIP guest and a VIP request; the VIP card uses the dark style', async ({ page }) => {
  await page.addInitScript(() => {
    window.QRCode = function (el) { const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d'); x.fillRect(0, 0, 256, 256); x.fillStyle = '#fff'; x.fillRect(64, 64, 128, 128); el.appendChild(c); };
    window.QRCode.CorrectLevel = { H: 2, M: 0, L: 1, Q: 3 };
  });
  await go(page, { event: { paid: true }, requests: [{ id: 'REQ-0123456789ABCDEFGH', name: 'ضيف مهم' }] });
  await expect(page.locator('#requests-badge')).toHaveText('1');
  await menu(page);
  await page.getByRole('button', { name: /^الطلبات/ }).click();
  await page.locator('.vip-approve-btn').click();
  await expect(page.locator('.guest-item .vip-badge')).toHaveText('★ VIP');
  const s = await server(page);
  expect(s.guests[0].vip).toBe(true);
  expect(s.requests['REQ-0123456789ABCDEFGH'].vip).toBe(true);
  const bg = await page.evaluate(async () => { const c = await buildGuestCard(guests[0]); return Array.from(c.getContext('2d').getImageData(60, 700, 1, 1).data.slice(0, 3)); });
  expect(Math.max(...bg)).toBeLessThan(40);
});


test('both share buttons of the scanner card open one preview with the scanner link and the door code together', async ({ page }) => {
  await go(page, { pin: '828583', event: { name: 'حفل ليلى' } });
  await expect(page.locator('#scan-pin-display')).toHaveText('828583');
  for (const btn of [page.locator('.pin-row button[title="مشاركة الرابط والرمز"]'), page.locator('#scan-link').locator('xpath=..').locator('button[title="مشاركة"]')]) {
    await btn.click();
    const preview = page.locator('#scan-share-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('سكانر الدخول');
    await expect(preview).toContainText('حفل ليلى');
    await expect(preview).toContainText('افتح الرابط وأدخل رمز الدخول:');
    await expect(preview).toContainText('scan.html?event=e1');
    await expect(preview).toContainText('رمز الدخول: 828583');
    await expect(preview).toContainText('للمسح والبحث بالأسماء فقط. لا تشارك الرمز مع أحد.');
    await page.keyboard.press('Escape');
    await expect(page.locator('#scan-share-modal')).toBeHidden();
  }
});

test('the scanner message goes to WhatsApp with the link and the code, and the preview shows HTML in the event name as text', async ({ page }) => {
  await go(page, { pin: '007654', event: { name: '<img id="xs" src=x onerror="window.__x=1">' } });
  await expect(page.locator('#scan-pin-display')).toHaveText('007654');
  await page.locator('.pin-row button[title="مشاركة الرابط والرمز"]').click();
  await expect(page.locator('#scan-share-preview img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__x)).toBeUndefined();
  await page.getByRole('button', { name: 'مشاركة عبر الواتساب' }).last().click();
  const opened = (await server(page)).opened;
  expect(opened).toHaveLength(1);
  const text = decodeURIComponent(opened[0]);
  expect(text).toContain('https://wa.me/?text=');
  expect(text).toContain('scan.html?event=e1');
  expect(text).toContain('*رمز الدخول:* 007654');
});

test('the scanner share tells the owner when the door code could not be read', async ({ page }) => {
  await go(page, { pin: '123456' });
  await expect(page.locator('#scan-pin-display')).toHaveText('123456');
  await page.evaluate(() => { currentScanPin = null; });
  await page.locator('.pin-row button[title="مشاركة الرابط والرمز"]').click();
  await expect(page.locator('#toast')).toContainText('الرمز ما انقرأ');
  await expect(page.locator('#scan-share-modal')).toBeHidden();
});

test('after «رمز جديد» the scanner message carries the NEW code', async ({ page }) => {
  await go(page, { pin: '123456' });
  await expect(page.locator('#scan-pin-display')).toHaveText('123456');
  await page.getByRole('button', { name: 'رمز جديد' }).click();
  await page.getByRole('button', { name: 'نعم، غيّر الرمز' }).click();
  await expect(page.locator('#scan-pin-display')).not.toHaveText('123456');
  const fresh = await page.locator('#scan-pin-display').textContent();
  await page.locator('.pin-row button[title="مشاركة الرابط والرمز"]').click();
  await expect(page.locator('#scan-share-preview')).toContainText('رمز الدخول: ' + fresh);
  await expect(page.locator('#scan-share-preview')).not.toContainText('123456');
});

test('«مشاركة بطريقة ثانية» of the scanner message uses the phone share sheet, else copies and says so', async ({ page }) => {
  await go(page, { pin: '828583' });
  await expect(page.locator('#scan-pin-display')).toHaveText('828583');
  await page.evaluate(() => { window.__shared = null; navigator.share = (d) => { window.__shared = d; return Promise.resolve(); }; });
  await page.locator('.pin-row button[title="مشاركة الرابط والرمز"]').click();
  await page.getByRole('button', { name: 'مشاركة بطريقة ثانية' }).last().click();
  const shared = await page.evaluate(() => window.__shared);
  expect(shared.text).toContain('*رمز الدخول:* 828583');
  expect(shared.text).toContain('scan.html?event=e1');
  // no share sheet: copy, and say so only when the copy worked
  await page.evaluate(() => { navigator.share = undefined; window.__copied = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } } }); });
  await page.locator('.pin-row button[title="مشاركة الرابط والرمز"]').click();
  await page.getByRole('button', { name: 'مشاركة بطريقة ثانية' }).last().click();
  await expect(page.locator('#toast')).toContainText('تم نسخ الرسالة');
  expect(await page.evaluate(() => window.__copied)).toContain('*رمز الدخول:* 828583');
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } }); });
  await page.locator('.pin-row button[title="مشاركة الرابط والرمز"]').click();
  await page.getByRole('button', { name: 'مشاركة بطريقة ثانية' }).last().click();
  await expect(page.locator('#toast')).toContainText('تعذّر النسخ');
});
