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
      '📦 تحميل كل الدعوات (ZIP)', '📥 تحميل نطاق معيّن (مثال: 1–100)', '📊 تصدير قائمة الضيوف (Excel)', '📄 تصدير قائمة الضيوف (CSV)', '🖨️ كشف الحضور (طباعة / PDF)',
      '🔔 تفعيل إشعارات الطلبات', '📥 الطلبات', '🔄 كود جديد', 'رقم دخول المشرفين', 'اسم ضيف جديد',
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

// The service is self-service: the person at the door is whoever the organizer
// picks (a relative, a friend, someone from their team) — not "staff" on a shift.
test('the door-day section talks about a door supervisor the organizer chooses, not employees or shifts', () => {
  const src = read('guide.html');
  for (const word of ['الموظف', 'الموظفين', 'موظف', 'دوام', 'فريق الأمن']) {
    expect(src, 'the guide should not say "' + word + '"').not.toContain(word);
  }
  expect(src).toContain('مشرف الباب يفتح الرابط ويكتب الرقم اللي أعطيته له');
  expect(src).toContain('قريب أو صديق أو أي أحد من فريقك');
  // The safety note covers handing the phone to someone else, not only a shift ending.
  expect(src).toContain('أو سلّمت جهازك لشخص ثاني');
});

// The people at the door are "المشرفين" (supervisors the organizer picks), never
// a "security team"; and the panel is the organizer's own ("المنظّم"), not "the organizers'".
test('no page, script or manifest says "فريق الأمن" or "لوحة تحكم المنظّمين", and the scanner link is described as being for supervisors', () => {
  const offenders = [];
  for (const f of fs.readdirSync(path.join(__dirname, '..')).filter(n => /\.(html|js|webmanifest)$/.test(n))) {
    const src = read(f);
    for (const phrase of ['فريق الأمن', 'فريق الامن', 'لفريق الأمن', 'لوحة تحكم المنظّمين', 'رقم الدخول للفريق']) {
      if (src.includes(phrase)) offenders.push(f + ': ' + phrase);
    }
  }
  expect(offenders).toEqual([]);
  expect(read('event.html')).toContain('رابط السكانر — شاركه مع المشرفين');
  expect(read('event.html')).toContain('رقم دخول المشرفين');
  expect(read('scan.html')).toContain('<div class="sub">سكانر الدخول</div>');
  expect(read('app.html')).toContain('لوحة تحكم المنظّم — أنشئ دعوة رقمية لمناسبتك');
});

// The guide says what a colour change touches. Tie each claim to the code: the
// card's accents follow the event's colour, the barcode itself never does.
test('the guide explains what changing the colour changes, and the code really behaves that way', () => {
  const guide = read('guide.html');
  expect(guide).toContain('ماذا يتغيّر مع اللون؟');
  expect(guide).toContain('ألوان صفحة سكانر الدخول');
  expect(guide).toContain('الباركود نفسه</b> فيبقى دايمًا أسود على خلفية فاتحة');
  expect(guide).toContain('البطاقات اللي حفظتها أو أرسلتها قبل تغيير اللون تبقى بلونها القديم');
  for (const f of ['event.html', 'invite.html']) {
    const src = read(f);
    // The card's accents come from the event's theme…
    expect(src, f).toMatch(/THEME_COLORS\[eventData\.theme \|\| 'gold'\]/);
    // …but the barcode is always dark ink on a light ground, whatever the theme.
    expect(src, f).toContain("colorDark: '#0A0A0A'");
    expect(src, f).toContain("colorLight: '#FAFAF8'");
  }
});
