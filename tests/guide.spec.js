const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { stubSupabase, seedAppStore, seedEvent } = require('./helpers');

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
    'app.html': ['إنشاء مناسبة جديدة', 'نسيت كلمة المرور؟'],
    'event.html': [
      'تعديل المناسبة', 'استيراد قائمة (Excel / CSV / أسماء)', 'إضافة أرقام متسلسلة (مثال: 1–200)',
      'تحميل كل الدعوات (ZIP)', 'تحميل نطاق معيّن (مثال: 1–100)', 'تصدير قائمة الضيوف (Excel)', 'تصدير قائمة الضيوف (CSV)', 'كشف الحضور (طباعة / PDF)',
      'تفعيل إشعارات الطلبات', 'الطلبات', 'اقبل الكل', 'رمز جديد', 'رمز دخول فريق الاستقبال', 'اسم ضيف جديد',
      'تحديد ضيوف للحذف', 'حذف المحددين', 'حذف الضيف', 'حذف المناسبة نهائيًا', 'تمييز كـ VIP', 'إلغاء تمييز VIP', 'قبول كـ VIP',
      'الدعوات والتقارير', 'معاينة رسالة الواتساب', 'مشاركة عبر الواتساب', 'مشاركة بطريقة ثانية', 'الحد المجاني لعدد الضيوف',
      'للتواصل عبر واتساب', 'تراجع', 'حضر',
    ],
    'scan.html': [
      'تشغيل الكاميرا', 'تحقق', 'عرض الأسماء', 'أو أدخل الكود يدويًا', 'مسموح بالدخول',
      'تم استخدام هذه الدعوة مسبقًا', 'باركود غير مسجّل', 'تسجيل خروج من هذا الجهاز',
      'تحديث القائمة', 'تأكيد الدخول',
    ],
    'invite.html': ['تأكيد الحضور', 'حفظ الدعوة', 'بنفس الطريقة (من نفس الجوال ونفس المتصفح)'],
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
  await stubSupabase(page);
  await seedAppStore(page, { user: { id: 'u1', email: 'customer@example.com' }, events: [] });
  await page.goto('/app.html');
  await expect(page.locator('#app-view')).toBeVisible();
  await expect(page.locator('#app-view a[href="guide.html"]')).toBeVisible();
});

test('the event menu links to the guide', async ({ page }) => {
  await stubSupabase(page);
  await seedEvent(page, { user: { id: 'u1', email: 'customer@example.com' }, event: { name: 'حفل', venue: 'x' } });
  await page.goto('/event.html?id=e1');
  await expect(page.locator('#dashboard')).toBeVisible();
  await page.getByRole('button', { name: 'القائمة' }).click();
  await expect(page.getByRole('button', { name: 'دليل الاستخدام' })).toBeVisible();
});

// The service is self-service: the person at the door is whoever the organizer
// picks (a relative, a friend, someone from their team) — not "staff" on a shift.
test('the door-day section talks about a door supervisor the organizer chooses, not employees or shifts', () => {
  const src = read('guide.html');
  for (const word of ['الموظف', 'الموظفين', 'موظف', 'دوام', 'فريق الأمن']) {
    expect(src, 'the guide should not say "' + word + '"').not.toContain(word);
  }
  expect(src).toContain('عضو فريق الاستقبال يفتح الرابط ويكتب الرمز اللي أعطيته له');
  expect(src).toContain('قريب أو صديق أو أي أحد من فريقك');
  // The safety note covers handing the phone to someone else, not only a shift ending.
  expect(src).toContain('أو سلّمت جهازك لشخص ثاني');
});

// The people at the door are "فريق الاستقبال" (the organizer picks them; one person: "عضو فريق الاستقبال"), never
// "المشرفين" (founder, Oct 17 2026: too colloquial), "الباب" (it is "المدخل") or a "security team"; and the panel is the organizer's own ("المنظّم"), not "the organizers'".
test('no page, script or manifest says "فريق الأمن" or "لوحة تحكم المنظّمين", and the door is called «المدخل» and the people at it «فريق الاستقبال»', () => {
  const offenders = [];
  for (const f of fs.readdirSync(path.join(__dirname, '..')).filter(n => /\.(html|js|webmanifest)$/.test(n))) {
    const src = read(f);
    for (const phrase of ['فريق الأمن', 'فريق الامن', 'لفريق الأمن', 'لوحة تحكم المنظّمين', 'رقم الدخول للفريق', 'المشرف', 'مشرف', 'الباب', 'رقم الدخول', 'رقم دخول', 'كود الدخول']) {
      if (src.includes(phrase)) offenders.push(f + ': ' + phrase);
    }
  }
  expect(offenders).toEqual([]);
  expect(read('event.html')).toContain('رابط السكانر</div><div class="sc-sub">شاركه مع فريق الاستقبال');
  expect(read('event.html')).toContain('رمز دخول فريق الاستقبال');
  expect(read('scan.html')).toContain('<div class="sub">سكانر الدخول</div>');
  expect(read('app.html')).toContain('لوحة تحكم المنظّم — أنشئ دعوة رقمية لمناسبتك');
});

// The guide says what a colour change touches. Tie each claim to the code: the
// card's accents follow the event's colour, the barcode itself never does.
test('the guide explains what changing the colour changes, and the code really behaves that way', () => {
  const guide = read('guide.html');
  expect(guide).toContain('ماذا يتغيّر مع اللون؟');
  expect(guide).toContain('ألوان صفحة سكانر الدخول');
  expect(guide).toContain('الباركود نفسه</b> فيبقى دائمًا أسود على خلفية فاتحة');
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

// The guide is the only page besides the landing page that search engines
// index: it needs its own description, canonical address and share card.
test('the guide has a description, a canonical address and a share card', async ({ page }) => {
  await page.goto('/guide.html');
  expect(await page.locator('meta[name="description"]').getAttribute('content')).toContain('خطوة بخطوة');
  expect(await page.locator('link[rel="canonical"]').getAttribute('href')).toBe('https://da3wt.com/guide.html');
  expect(await page.locator('meta[property="og:title"]').getAttribute('content')).toBe('دليل الاستخدام — دعوات');
  expect(await page.locator('meta[property="og:image"]').getAttribute('content')).toBe('https://da3wt.com/icons/og-image.jpg');
});

// Batch 2 of the pre-launch review: the guide's FAQ, structure and accessibility.
test('the FAQ no longer claims a «حضر» / «لسه» status on each row and explains the real buttons', () => {
  const g = read('guide.html');
  expect(g).not.toContain('حالته «حضر» أو «لسه»');
  expect(g).toContain('زر أخضر «حضر»');
  expect(g).toContain('يصير الزر «تراجع»');
  expect(g).toContain('ولو سُجّل بالخطأ اضغط «تراجع» جنب اسمه');
  expect(g).toContain('رقم «الحضور» فوق القائمة');
  const ev = read('event.html');
  expect(ev).toContain("} حضر</button>");
  expect(ev).toContain('} تراجع</button>');
});

test('the new FAQ entries exist and promise no price or time', async ({ page }) => {
  await page.goto('/guide.html');
  const qs = await page.locator('#faq summary').allTextContents();
  for (const q of ['وصلت حد الضيوف ولا أقدر أضيف', 'نسيت كلمة المرور', 'هل يقدر أكثر من عضو في فريق الاستقبال يمسح في نفس الوقت؟',
    'هل أقدر أضيف الموقع على شاشة الجوال الرئيسية؟', 'كيف يحفظ الضيف بطاقته في جواله؟', 'من يفعّل مناسبتي لعدد أكبر من الضيوف؟']) {
    expect(qs, q).toContain(q);
  }
  const limit = await page.locator('details', { hasText: 'وصلت حد الضيوف' }).textContent();
  expect(limit).toContain('الحد المجاني لعدد الضيوف');
  expect(limit).toContain('للتواصل عبر واتساب');
  expect(limit).toContain('اقبل الكل');
  expect(limit).not.toMatch(/ريال|SAR|\d+\s*(دقيقة|ساعة|يوم)/);
  const faqText = await page.locator('#faq').textContent();
  expect(faqText).not.toMatch(/ريال|SAR/);
});

test('the guide has main, labelled nav, theme-color, a focus outline and no nowrap on button names', async ({ page }) => {
  await page.goto('/guide.html');
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.locator('nav.toc')).toHaveAttribute('aria-label', 'محتويات الدليل');
  expect(await page.locator('meta[name="theme-color"]').getAttribute('content')).toBe('#0A0A0A');
  const src = read('guide.html');
  expect(src).toContain('summary:focus-visible');
  expect(src).not.toMatch(/b\.k\s*\{[^}]*nowrap/);
  expect(src).toContain('padding-right:18px');
  expect(src).not.toContain('<div class="lead">&nbsp;</div>');
  expect(src).not.toContain('🎁');
  expect(src).toContain('→ مناسباتي');
  expect(src).not.toContain('← مناسباتي');
  for (const w of ['أي شي ', 'دعهم يسجلون', 'ثلاث طرق للإضافة']) expect(src).not.toContain(w);
  expect(src).not.toMatch(/\?\?|replaceAll|\.at\(|inset:|aspect-ratio/);
});

test('the FAQPage JSON-LD parses and matches the visible questions', async ({ page }) => {
  await page.goto('/guide.html');
  const json = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent());
  expect(json['@type']).toBe('FAQPage');
  const visible = await page.locator('#faq summary').allTextContents();
  expect(json.mainEntity.length).toBe(visible.length);
  expect(json.mainEntity.map(q => q.name)).toEqual(visible.map(t => t.replace(/\s+/g, ' ').trim()));
  for (const q of json.mainEntity) expect(q.acceptedAnswer.text.length).toBeGreaterThan(10);
});

test('the guide uses Western digits only', () => {
  expect(read('guide.html')).not.toMatch(/[\u0660-\u0669\u06F0-\u06F9]/);
});

test('the long feature paragraph is split into short lists, one feature per item', async ({ page }) => {
  await page.goto('/guide.html');
  for (const label of ['تحميل كل الدعوات (ZIP)', 'تحميل نطاق معيّن (مثال: 1–100)', 'تصدير قائمة الضيوف (Excel)', 'تصدير قائمة الضيوف (CSV)',
    'كشف الحضور (طباعة / PDF)', 'حذف المحددين', 'تمييز كـ VIP', 'حذف المناسبة نهائيًا']) {
    const li = page.locator('#guests li', { hasText: label });
    await expect(li, label).toHaveCount(1);
    expect((await li.textContent()).length).toBeLessThan(420);
  }
  await expect(page.locator('#guests li', { hasText: 'اكتب رقم البداية والنهاية' })).toHaveCount(1);
  await expect(page.locator('#guests li', { hasText: 'كلمة «حذف»' })).toHaveCount(1);
  await expect(page.locator('#invite')).toContainText('معاينة رسالة الواتساب');
  await expect(page.locator('#invite')).toContainText('تأكيد الحضور');
  await expect(page.locator('#door ul li')).not.toHaveCount(0);
  const p = await page.locator('#door .step').nth(3).locator('p').allTextContents();
  for (const t of p) expect(t.length).toBeLessThan(400);
});

test('the scanner search rule in the guide matches scan.html', () => {
  const scan = read('scan.html');
  expect(scan).toContain("query.length >= 3 || ql.indexOf('wd') === 0");
  const g = read('guide.html');
  expect(g).toContain('3 أحرف على الأقل أو يبدأ بـ');
  expect(g).toContain('من دخل يختفي من القائمة، والبحث يظهر الجميع');
});

test('numbers and wording the guide states match the code', () => {
  const guide = read('guide.html');
  expect(read('utils.js')).toMatch(/const FREE_GUEST_LIMIT = 5;/);
  expect(guide).toContain('الحد المجاني 5 ضيوف');
  expect(read('utils.js')).toMatch(/const DELETE_WORD = 'حذف';/);
  expect(guide).toContain('كلمة «حذف»');
  const scan = read('scan.html');
  expect(scan).toMatch(/allowed:\s*\{ autoMs: 5000,/);
  expect(scan).toMatch(/duplicate: \{ autoMs: 6000,/);
  expect(scan).toMatch(/denied:\s*\{ autoMs: 6000,/);
  expect(guide).toContain('بعد 5 ثواني تقريبًا');
  expect(guide).toContain('بعد 6 ثواني تقريبًا');
  expect(guide).toContain('يتحدثون تلقائيًا كل ثواني قليلة');
  expect(guide).toContain('والضيف المحذوف يختفي خلال دقيقة تقريبًا');
  expect(guide).toContain('سجّلوا أجهزة فريق الاستقبال بالرمز قبل المناسبة');
  expect(guide).not.toContain('أكثر من دقيقتين');
});

test('the downloads follow the current list and the old custom link stops after a rename', () => {
  const ev = read('event.html');
  expect(ev).toMatch(/function askRangeDownload\(\) \{\s*const total = visibleGuests\(\)/);
  expect(ev).toMatch(/function downloadAllCards\(from, to\)[\s\S]{0,300}visibleGuests\(\)/);
  // the server frees the old name in the same step that claims the new one
  expect(ev).toContain('Data.event.claimSlug(eventId, slug)');
  expect(ev).not.toContain('الروابط القديمة تبقى شغالة');
  const g = read('guide.html');
  expect(g).not.toContain('الروابط اللي أرسلتها قبل تبقى شغالة');
  expect(g).toContain('رابط الاسم القديم يتوقف');
  expect(g).toContain('يتبعان الفلتر والبحث الحاليين');
  expect(g).toContain('إضافة ضيف واحد');
});
