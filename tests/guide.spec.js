const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { stubFirebase, seedFakeFirebase } = require('./helpers');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('the guide opens without any sign-in and covers the whole journey', async ({ page }) => {
  await page.goto('/guide.html');
  await expect(page.locator('h1')).toContainText('دليل');
  for (const id of ['start', 'guests', 'invite', 'door', 'faq']) {
    await expect(page.locator('#' + id)).toBeVisible();
  }
  // Every table-of-contents chip points at a section that exists.
  const hrefs = await page.locator('.toc a').evaluateAll(as => as.map(a => a.getAttribute('href')));
  for (const h of hrefs) await expect(page.locator(h)).toHaveCount(1);
});

test('a question opens its answer', async ({ page }) => {
  await page.goto('/guide.html');
  const first = page.locator('details').first();
  await expect(first).not.toHaveAttribute('open', '');
  await first.locator('summary').click();
  await expect(first).toHaveAttribute('open', '');
});

// The guide quotes button and message names word for word. If a label is
// renamed in a page and the guide isn't updated, the guide silently sends
// people looking for something that no longer exists — so this ties each
// quoted label to the page that actually owns it.
test('every button and message the guide quotes still exists in the page it belongs to', async () => {
  const guide = read('guide.html');
  const quoted = {
    'app.html': ['إنشاء مناسبة جديدة'],
    'event.html': [
      '✏️ تعديل المناسبة', '📂 استيراد قائمة (Excel / CSV / أسماء)', '🔢 إضافة أرقام متسلسلة (مثال: 1–200)',
      '📦 تحميل كل الدعوات (ZIP)', '📥 تحميل نطاق معيّن (مثال: 1–100)', '📄 تصدير قائمة الضيوف (CSV)',
      '🔔 تفعيل إشعارات الطلبات', '📥 الطلبات', '🔄 كود جديد', 'رقم الدخول للفريق', 'اسم ضيف جديد',
    ],
    'scan.html': [
      'تشغيل الكاميرا', 'تحقق', 'عرض الأسماء', 'أو أدخل الكود يدويًا', 'مسموح بالدخول',
      'تم استخدام هذه الدعوة مسبقًا', 'باركود غير مسجّل', 'تسجيل خروج من هذا الجهاز',
    ],
  };
  for (const [file, labels] of Object.entries(quoted)) {
    const source = read(file);
    for (const label of labels) {
      expect(guide, `the guide should mention "${label}"`).toContain(label);
      expect(source, `${file} should still contain "${label}"`).toContain(label);
    }
  }
});

test('the landing page links to the guide', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('footer a[href="guide.html"]')).toBeVisible();
});

test('the events list links to the guide', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: { events: {} },
  });
  await page.goto('/app.html');
  await expect(page.locator('#app-view')).toBeVisible();
  await expect(page.locator('#app-view a[href="guide.html"]')).toBeVisible();
});

test('the event menu links to the guide', async ({ page }) => {
  await stubFirebase(page);
  await seedFakeFirebase(page, {
    user: { uid: 'u1', email: 'customer@example.com' },
    store: {
      events: { e1: { name: 'حفل', ownerUid: 'u1', date: '2026-01-01', venue: 'x', theme: 'gold', createdAt: { seconds: 1 } } },
      'events/e1/guests': {}, 'events/e1/requests': {},
      'events/e1/private': { scan: { scanPin: '1234' } },
    },
  });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.locator('.toolbar .icon-btn', { hasText: '☰' }).click();
  await expect(page.getByRole('button', { name: '📖 دليل الاستخدام' })).toBeVisible();
});
