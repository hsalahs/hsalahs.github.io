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
  if (n > MAX_GUEST_LIMIT) { alert('الحد الأقصى ' + MAX_GUEST_LIMIT + ' ضيف.'); return null; }
  if (n > CONFIRM_ABOVE_GUESTS && !confirm('الرقم كبير (' + n + ' ضيف). هل هو صحيح؟')) return null;
  if (guestCount > n && !confirm('العميل عنده الآن ' + guestCount + ' ضيف، أكثر من ' + n + '. سيتوقف عن إضافة ضيوف جدد. متأكد؟')) return null;
  return n;
}

// Admin heads-up notifications (new customer / extra-event request /
// approaching the free-guest cap) — same EmailJS account used by both
// app.html and event.html.
const EMAILJS_PUBLIC_KEY = 'GAr6CcOiDqo-Mc3m5';
const EMAILJS_SERVICE_ID = 'service_j15srgf';
const EMAILJS_TEMPLATE_ID = 'template_fm1b49y';
const ADMIN_NOTIFY_EMAIL = 'hsallah@outlook.sa';
if (window.emailjs) emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY });

// Never blocks the calling flow — a failed notification just gets logged.
function notifyAdmin(name, message) {
  if (!window.emailjs) return;
  emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
    name, message, to_email: ADMIN_NOTIFY_EMAIL,
    time: new Date().toLocaleString('ar-SA-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' })
  }).catch(e => console.error('Admin notify failed:', e));
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
