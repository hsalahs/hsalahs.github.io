// Shared helpers used across app.html, event.html, invite.html, scan.html.
function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Takes a RAW (unescaped) string and returns it safe to embed inside a
// single-quoted JS string literal within an onclick="..." attribute, e.g.
// onclick="deleteGuest('${escapeForJsAttr(name)}')". Does both layers:
// escaping & < > " (escapeHtml) so the value can't break out of the
// double-quoted onclick="..." attribute itself, and escaping \ and ' so it
// can't break out of the single-quoted JS string inside that attribute.
// Backslashes must be escaped before quotes, or double-escaping corrupts
// it; escapeHtml doesn't touch either character, so the two escaping
// passes don't interfere and can run in either order.
function escapeForJsAttr(str) {
  return escapeHtml(String(str)).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// Arabic noun-count agreement: 0/1 singular, 2 dual, 3-10 plural, 11+ back
// to singular ("15 ضيف", not "15 ضيوف") — the standard split, same
// categories CLDR uses for Arabic plural rules. Returns the noun only; call
// as n + ' ' + arPlural(n, ...) anywhere a count is shown next to a noun.
function arPlural(n, one, two, many) {
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return many;
  return one;
}
function guestWord(n) { return arPlural(n, 'ضيف', 'ضيفين', 'ضيوف'); }

// Guest name order shared by the dashboard's own list and the scanner's
// offline name search, so a supervisor comparing notes with the organizer
// sees the same order. Numeric names (like "1", "2", "150" — a ticket-style
// list added via "إضافة أرقام متسلسلة") sort by value first, in order; then
// everyone else sorts alphabetically after them. Never by arrival/scanned
// status: door staff searching for a name shouldn't have to first work out
// which half of a jumping list it's currently in.
function sortGuestsByName(list) {
  return [...list].sort((a, b) => {
    const aNum = /^\d+$/.test(a.name.trim());
    const bNum = /^\d+$/.test(b.name.trim());
    if (aNum && bNum) return parseInt(a.name, 10) - parseInt(b.name, 10);
    if (aNum) return -1;
    if (bNum) return 1;
    return a.name.localeCompare(b.name, 'ar', { numeric: true });
  });
}

// Single admin allowlist — was previously copy-pasted separately into
// app.html, event.html, and scan.html, an easy way for admin access to
// quietly break in just one of them if this email ever changes and someone
// forgets to update all three.
const ADMIN_EMAILS = ['hsallah@outlook.sa'];
function isAdmin(user) { return !!user && ADMIN_EMAILS.includes((user.email || '').toLowerCase()); }

// First 5 guests are free so a customer can see a real saved QR card before
// paying. Used by app.html and event.html; also keep in sync with the "5"
// in firestore.rules (a JS const can't reach a security rules file, so that
// one stays a manually-matched magic number).
const FREE_GUEST_LIMIT = 5;

// The admin sets each event's guest limit by hand (events/{id}.guestLimit),
// agreed with the customer off-platform; only the admin can write it. No
// guestLimit means the free tier — except events activated before limits
// existed (paid: true and no number), which stay unlimited until the admin
// gives them one. Keep in sync with guestCap() in firestore.rules.
const MAX_GUEST_LIMIT = 2000;
const CONFIRM_ABOVE_GUESTS = 1000;
function guestCapOf(ev) {
  if (!ev) return FREE_GUEST_LIMIT;
  if (typeof ev.guestLimit === 'number') return ev.guestLimit;
  return ev.paid ? Infinity : FREE_GUEST_LIMIT;
}

// Asks the admin how many guests an event may have. Returns an integer from
// 1 to MAX_GUEST_LIMIT, 0 for "switch it off" (only offered when the event
// is already activated), or null if they cancelled or typed something invalid.
function askGuestLimit({ name, current, activated, guestCount }) {
  const hint = activated ? '\nاكتب 0 لإلغاء التفعيل (يرجع للحد المجاني).' : '';
  const answer = prompt(
    'كم ضيف تسمح لمناسبة "' + name + '"؟ (من 1 إلى ' + MAX_GUEST_LIMIT + ')' + hint,
    current == null ? '' : String(current)
  );
  if (answer === null) return null;
  // Accept Eastern Arabic-Indic digits typed on an Arabic keyboard.
  const typed = answer.trim().replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660));
  if (!/^\d+$/.test(typed)) { alert('اكتب رقمًا صحيحًا فقط.'); return null; }
  const n = parseInt(typed, 10);
  if (n === 0) return activated ? 0 : (alert('اكتب رقمًا من 1 إلى ' + MAX_GUEST_LIMIT + '.'), null);
  if (n > MAX_GUEST_LIMIT) { alert('الحد الأقصى ' + MAX_GUEST_LIMIT + ' ' + guestWord(MAX_GUEST_LIMIT) + '.'); return null; }
  if (n > CONFIRM_ABOVE_GUESTS && !confirm('الرقم كبير (' + n + ' ' + guestWord(n) + '). هل هو صحيح؟')) return null;
  if (guestCount > n && !confirm('العميل عنده الآن ' + guestCount + ' ' + guestWord(guestCount) + '، أكثر من ' + n + '. سيتوقف عن إضافة ضيوف جدد. متأكد؟')) return null;
  return n;
}

// Admin heads-up notifications (new customer / extra-event request /
// approaching the free-guest cap) — same EmailJS account used by both
// app.html and event.html.
const EMAILJS_PUBLIC_KEY = 'GAr6CcOiDqo-Mc3m5';
const EMAILJS_SERVICE_ID = 'service_j15srgf';
const EMAILJS_TEMPLATE_ID = 'template_fm1b49y';
const ADMIN_NOTIFY_EMAIL = 'hsallah@outlook.sa';

// Never blocks the calling flow — a failed notification just gets logged.
// The EmailJS script now loads async (it used to hold up the whole page on a
// slow connection), so it's initialised here, on first use, not at load.
let emailjsReady = false;
function notifyAdmin(name, message) {
  if (!window.emailjs) return;
  if (!emailjsReady) { emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY }); emailjsReady = true; }
  emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
    name, message, to_email: ADMIN_NOTIFY_EMAIL,
    time: new Date().toLocaleString('ar-SA-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' })
  }).catch(e => console.error('Admin notify failed:', e));
}

// Puts a button into a "working…" state (disabled, with a ⏳ label) and
// returns a function that restores it. Without it a slow network looked
// like a dead button, and a second tap fired the same action twice.
function setButtonBusy(btn, label) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ ' + label;
  return () => { btn.disabled = false; btn.textContent = original; };
}

// Readable event links (da3wt.com/hala-turki). Same pattern and reserved
// words in firestore.rules (slugs/{slug}) and 404.html — keep the three in step.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const RESERVED_SLUGS = ['index', 'app', 'event', 'invite', 'scan', 'guide', 'icons', 'tests', 'sitemap', 'robots',
  'manifest', 'sw', 'utils', 'format', 'admin', 'login', 'www', 'api', '404'];
function normalizeSlug(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, '-'); }
// '' when fine, otherwise the reason in Arabic.
function slugProblem(s) {
  if (!SLUG_RE.test(s)) return 'الرابط بالإنجليزي والأرقام والشرطة (-) فقط، من 3 إلى 40 حرف';
  if (RESERVED_SLUGS.includes(s)) return 'هذا الاسم محجوز، جرّب غيره';
  return '';
}

// The kinds of event an organizer picks when creating one: drives the
// invitation's opening picture/title, the example in the name field, and the
// colour a new event starts with (the same ones as the sample invitation —
// the owner can change it). `approver` is who approves a guest's request, as
// the invitation page names them ("بانتظار موافقة …").
// invite.html's inline splash script keeps its own copy of the titles (it
// runs before this file loads). Events saved before this existed have no
// `type` and are treated as weddings, as they always were.
const EVENT_TYPES = {
  wedding:    { label: 'زفاف',   example: 'زفاف حسن وفاطمة',          theme: 'gold',
                title: 'دعوة زفاف', icon: '💌', nameLabel: 'الحفل', welcome: 'يسعدنا حضوركم ومشاركتنا فرحتنا 🤍', approver: 'صاحب الدعوة' },
  graduation: { label: 'تخرج',   example: 'حفل تخرج دفعة 2026',        theme: 'sapphire',
                title: 'دعوة حفل تخرج', icon: '🎓', nameLabel: 'الحفل', welcome: 'يسعدنا حضوركم ومشاركتنا فرحة التخرج 🎓', approver: 'منظّمي الحفل' },
  event:      { label: 'فعالية', example: 'ملتقى ريادة الأعمال 2026', theme: 'emerald',
                title: 'دعوة فعالية', icon: '🎟️', nameLabel: 'الفعالية', welcome: 'يسعدنا حضوركم ومشاركتنا في هذه الفعالية 🌟', approver: 'منظّمي الفعالية' },
};
function eventTypeOf(ev) {
  return ev && Object.prototype.hasOwnProperty.call(EVENT_TYPES, ev.type) ? ev.type : 'wedding';
}

// The invitation message the owner shares on WhatsApp (event.html's share
// window) — the same welcome line shows on the guest's invitation page.
// The owner's own welcome (`welcomeMessage` on the event) or the kind's
// default. Capped so the whole message still fits in a wa.me link on every
// phone. *…* is WhatsApp's bold.
const WELCOME_MAX = 400;
function welcomeOf(ev) {
  const own = ev && typeof ev.welcomeMessage === 'string' ? ev.welcomeMessage.trim() : '';
  return own || EVENT_TYPES[eventTypeOf(ev)].welcome;
}
function buildShareMessage(ev, link) {
  const k = EVENT_TYPES[eventTypeOf(ev)];
  const lines = ['*' + k.icon + ' ' + k.title + ' ✨*', ''];
  if (ev.name) lines.push((k.nameLabel === 'الفعالية' ? '📌' : '🎉') + ' *' + k.nameLabel + ':* ' + ev.name);
  if (ev.date) lines.push('📅 *التاريخ:* ' + formatEventDate(ev.date));
  if (ev.venue) lines.push('📍 *المكان:* ' + ev.venue);
  if (ev.mapsLink) lines.push('🗺️ *الموقع:* ' + ev.mapsLink);
  lines.push('', welcomeOf(ev), '', '🔗 أكّد حضورك واستلم بطاقة دخولك (QR):', link);
  return lines.join('\n');
}

// A link name from the event's own name, so every event gets a readable link
// without the owner typing one: Arabic letters spelled in English (Arabic has
// no written short vowels, so "حلا" becomes "hla" — the owner can change it),
// English letters and digits kept, everything else a dash. Always passes
// slugProblem().
const SLUG_LETTERS = {
  'ا': 'a', 'أ': 'a', 'إ': 'e', 'آ': 'a', 'ب': 'b', 'ت': 't', 'ث': 'th', 'ج': 'j', 'ح': 'h', 'خ': 'kh',
  'د': 'd', 'ذ': 'th', 'ر': 'r', 'ز': 'z', 'س': 's', 'ش': 'sh', 'ص': 's', 'ض': 'd', 'ط': 't', 'ظ': 'z',
  'ع': 'a', 'غ': 'gh', 'ف': 'f', 'ق': 'q', 'ك': 'k', 'ل': 'l', 'م': 'm', 'ن': 'n', 'ه': 'h', 'ة': 'a',
  'و': 'w', 'ي': 'y', 'ى': 'a', 'ء': '', 'ئ': 'e', 'ؤ': 'o',
};
function slugFromName(name) {
  const words = String(name || '').toLowerCase().split(/\s+/).map(w => {
    const chars = [...w];
    return chars.map((c, i) => {
      const code = c.charCodeAt(0);
      if (code >= 0x660 && code <= 0x669) return String(code - 0x660);   // Arabic-Indic digits
      if (/[a-z0-9]/.test(c)) return c;
      // Inside a word, waw and yaa are usually the long vowels.
      if (c === 'و' && i > 0) return 'o';
      if (c === 'ي' && i > 0) return i === chars.length - 1 ? 'i' : 'ee';
      return c in SLUG_LETTERS ? SLUG_LETTERS[c] : '-';
    }).join('');
  });
  let s = words.join('-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 34).replace(/-$/, '');
  if (s.length < 3) s = s ? s + '-event' : 'my-event';
  if (RESERVED_SLUGS.includes(s)) s += '-event';
  return s;
}

// Shared bottom toast — the calling page needs its own #toast element and
// matching CSS (each page's dark theme sets slightly different colors).
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('show'), 5000);
}

// Asks the owner to type «حذف» before an event is deleted. The old single
// confirm() was one tap away from wiping every guest; this window can't be
// passed by a stray double tap. Resolves true only when the word is typed
// and the red button is pressed; Escape, «إلغاء» or tapping outside give false.
// Styles are inline (with fallbacks) because app.html and event.html don't
// share CSS variables. To go back to the old dialog, make this return
// Promise.resolve(confirm(...)).
const DELETE_WORD = 'حذف';
function confirmEventDelete({ name, guestCount }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.id = 'delete-event-modal';
    overlay.setAttribute('dir', 'rtl');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.65); z-index:1000; display:flex; align-items:center; justify-content:center; padding:20px;';
    const count = typeof guestCount === 'number' && guestCount > 0
      ? ' (' + guestCount + ' ' + guestWord(guestCount) + ')' : '';
    overlay.innerHTML = `
      <div role="dialog" aria-modal="true" aria-labelledby="del-ev-title" style="background:var(--bg-1,#0C0C0C); color:var(--text-main,#FAF8F4); border:1px solid rgba(255,120,120,0.45); border-radius:18px; padding:18px; max-width:420px; width:100%; box-shadow:0 20px 60px rgba(0,0,0,0.5); font-family:inherit; text-align:right;">
        <h3 id="del-ev-title" style="margin:0 0 10px; color:#ff9d9d; font-size:17px;">حذف المناسبة نهائيًا</h3>
        <p style="margin:0 0 8px; font-size:14px; line-height:1.7;">«<b class="del-ev-name"></b>»</p>
        <p style="margin:0 0 14px; font-size:13px; line-height:1.7; opacity:0.85;">راح ينحذف كل الضيوف${count} والطلبات المرتبطة فيها، وما تقدر ترجعها بعدين.</p>
        <label for="del-ev-input" style="display:block; font-size:13px; margin-bottom:6px;">للتأكيد اكتب كلمة <b style="color:#ff9d9d;">${DELETE_WORD}</b></label>
        <input id="del-ev-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" style="width:100%; box-sizing:border-box; padding:11px 12px; border-radius:10px; border:1px solid rgba(255,120,120,0.45); background:rgba(255,255,255,0.06); color:inherit; font-size:16px; font-family:inherit; margin-bottom:14px;">
        <div style="display:flex; gap:8px;">
          <button type="button" class="del-ev-confirm" disabled style="flex:1; padding:12px; border-radius:10px; border:none; background:#E5484D; color:#fff; font-weight:700; font-size:14px; font-family:inherit; cursor:pointer;">${typeof ic === 'function' ? ic('trash-2', 15) : ''} حذف نهائي</button>
          <button type="button" class="del-ev-cancel" style="flex:1; padding:12px; border-radius:10px; border:1px solid rgba(255,255,255,0.25); background:transparent; color:inherit; font-weight:700; font-size:14px; font-family:inherit; cursor:pointer;">إلغاء</button>
        </div>
      </div>`;
    // textContent, not the template: the event name is user text.
    overlay.querySelector('.del-ev-name').textContent = name || '';
    const input = overlay.querySelector('#del-ev-input');
    const okBtn = overlay.querySelector('.del-ev-confirm');
    const matches = () => input.value.trim() === DELETE_WORD;
    const sync = () => { okBtn.disabled = !matches(); okBtn.style.opacity = okBtn.disabled ? '0.4' : '1'; };
    sync();
    const close = (result) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (e) {} }
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      else if (e.key === 'Enter' && matches()) { e.preventDefault(); close(true); }
    };
    input.addEventListener('input', sync);
    okBtn.addEventListener('click', () => { if (matches()) close(true); });
    overlay.querySelector('.del-ev-cancel').addEventListener('click', () => close(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    input.focus();
  });
}
