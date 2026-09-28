const { test, expect } = require('@playwright/test');
const { stubFirebase, seedFakeFirebase } = require('./helpers');

const EVENT = {
  name: 'حفل تجريبي', ownerUid: 'u1', date: '2026-01-01', venue: 'الرياض',
  scanPin: '1234', theme: 'gold', createdAt: { seconds: 1 },
};

function baseStore(guests) {
  const g = {};
  guests.forEach((data, i) => { g['g' + i] = data; });
  return {
    events: { e1: EVENT },
    'events/e1/guests': g,
    'events/e1/requests': {},
  };
}

test('the guest-card button is labeled "حفظ" on a browser that can\'t actually share files, not a misleading "واتساب"', async ({ page }) => {
  // A desktop browser (and this headless test browser) has no
  // navigator.canShare support for files, so downloadGuestCard silently
  // falls back to a plain download — calling that button "واتساب" would
  // promise a share sheet that never appears.
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: baseStore([{ id: 'WD-1', name: 'أحمد', scanned: false }]),
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('.guest-item .dl-btn')).toHaveText('💾 حفظ');
});

test('the guest-card button is labeled "واتساب" on a device that can actually share the image file', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.canShare = () => true;
  });
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: baseStore([{ id: 'WD-1', name: 'أحمد', scanned: false }]),
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  await expect(page.locator('.guest-item .dl-btn')).toHaveText('📤 واتساب');
});

test('marking a guest as attended from the list asks for confirmation first, so a stray tap can\'t check someone in', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: baseStore([{ id: 'WD-1', name: 'أحمد', scanned: false }]),
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.getByRole('button', { name: '👥 الضيوف' }).click();

  page.on('dialog', d => d.dismiss());
  await page.locator('.attend-btn').click();
  await expect(page.locator('.badge')).toHaveText('لسه');

  page.removeAllListeners('dialog');
  page.on('dialog', d => d.accept());
  await page.locator('.attend-btn').click();
  await expect(page.locator('.badge')).toHaveText('✓ حضر');
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
  await page.getByRole('button', { name: '👥 الضيوف' }).click();
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
  await page.getByRole('button', { name: '👥 الضيوف' }).click();
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
  await page.getByRole('button', { name: '👥 الضيوف' }).click();
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
  await page.getByRole('button', { name: '👥 الضيوف' }).click();
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
  await page.getByRole('button', { name: '👥 الضيوف' }).click();
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
  await page.getByRole('button', { name: '👥 الضيوف' }).click();
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
  await expect(page.locator('#toast')).toContainText('تم تفعيل الدفع');
  await expect(page.locator('#payment-gate')).toBeHidden();
});

test('declining the confirm dialog leaves the event unpaid', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'admin-uid', email: 'hsallah@outlook.sa' },
    store: { events: { e1: { ...EVENT, ownerUid: 'u1', paid: false } }, 'events/e1/guests': {}, 'events/e1/requests': {} },
  });
  page.on('dialog', d => d.dismiss());
  await page.goto('/event.html?id=e1');
  await page.getByRole('button', { name: '☰' }).click();
  await page.locator('#payment-menu-item').click();
  await page.getByRole('button', { name: '☰' }).click();
  await expect(page.locator('#payment-menu-item')).toContainText('تفعيل الدفع');
});

test('the admin can revoke a mistaken activation from the menu', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'admin-uid', email: 'hsallah@outlook.sa' },
    store: { events: { e1: { ...EVENT, ownerUid: 'u1', paid: true } }, 'events/e1/guests': {}, 'events/e1/requests': {} },
  });
  page.on('dialog', d => d.accept());
  await page.goto('/event.html?id=e1');
  await page.getByRole('button', { name: '☰' }).click();
  await expect(page.locator('#payment-menu-item')).toContainText('إلغاء التفعيل');
  await page.locator('#payment-menu-item').click();
  await page.getByRole('button', { name: '☰' }).click();
  await expect(page.locator('#payment-menu-item')).toContainText('تفعيل الدفع (أدمن)');
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
