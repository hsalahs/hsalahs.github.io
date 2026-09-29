// Shared helpers used across app.html, event.html, invite.html, scan.html.
function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
