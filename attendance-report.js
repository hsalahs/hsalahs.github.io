// The attendance report: a clean, paper-style page of the guest list that the
// organizer prints or saves as a PDF from the browser's own print dialog. No
// PDF library: the browser lays out the text itself, so Arabic, English and
// mixed names keep their correct shaping and direction, on a phone or a
// computer alike.
//
// The page is built as a self-contained HTML document and opened in a new tab
// from a blob: URL, which has the SAME ORIGIN as the site. Guests type their
// own names, so nothing they write may ever run there: every value is
// HTML-escaped, and a Content-Security-Policy with a per-report nonce allows
// only the one script this page ships with (the print button).
function reportEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// "2026-09-30 17:22", local time, Western digits; anything that is not a date is kept as is.
function reportTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// event: { name, date, venue }; allGuests: every guest of the event (the
// summary is always about the whole list); shownGuests: the rows to print
// (what the dashboard is showing); scopeLabel: says which view that is.
function buildAttendanceReportHtml({ event, allGuests, shownGuests, scopeLabel, generatedAt, origin, nonce }) {
  const total = allGuests.length;
  const attended = allGuests.filter(g => g.scanned).length;
  const pending = total - attended;
  const percent = total > 0 ? Math.round((attended / total) * 100) : 0;
  const dateText = typeof formatEventDate === 'function' ? formatEventDate(event.date) : (event.date || '');
  const meta = [dateText, event.venue].filter(Boolean).map(reportEscape).join(' · ');

  const rows = shownGuests.length === 0
    ? '<tr><td colspan="5" class="empty">لا توجد أسماء ضمن هذا العرض</td></tr>'
    : shownGuests.map((g, i) =>
      '<tr>' +
      '<td class="num">' + (i + 1) + '</td>' +
      '<td class="name"><bdi>' + reportEscape(g.name) + '</bdi></td>' +
      '<td class="code"><bdi dir="ltr">' + reportEscape(g.id) + '</bdi></td>' +
      '<td class="' + (g.scanned ? 'st-yes' : 'st-no') + '">' + (g.scanned ? 'حضر' : 'لم يحضر') + '</td>' +
      '<td class="time"><bdi dir="ltr">' + reportEscape(g.scanned ? reportTime(g.scannedAt) : '') + '</bdi></td>' +
      '</tr>').join('');

  const css = `
:root { --gold:#B8862F; --ink:#1b1a17; --muted:#6c675d; --line:#e6dfd0; }
* { box-sizing:border-box; }
html, body { margin:0; }
body { background:#efece6; color:var(--ink); font-family:'IBM Plex Sans Arabic','Segoe UI',Tahoma,'Noto Sans Arabic',Arial,sans-serif; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
.bar { position:sticky; top:0; z-index:5; display:flex; flex-wrap:wrap; gap:8px 14px; align-items:center; background:#1b1a17; color:#e8e2d4; padding:10px 16px; font-size:13px; }
.bar button { background:linear-gradient(135deg,#C99B4A,#E0BC7A); color:#1a1400; border:0; border-radius:10px; padding:9px 16px; font:inherit; font-weight:700; cursor:pointer; }
.sheet { max-width:820px; margin:16px auto; background:#fff; padding:28px 30px; box-shadow:0 6px 30px rgba(0,0,0,0.12); }
.head { display:flex; align-items:center; gap:14px; padding-bottom:14px; border-bottom:3px solid var(--gold); }
.logo { width:54px; height:54px; flex-shrink:0; }
h1 { margin:0; font-size:22px; color:var(--gold); }
.ev { font-size:17px; font-weight:700; margin-top:2px; }
.meta { font-size:13px; color:var(--muted); margin-top:2px; }
.tiles { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin:18px 0 8px; }
.tile { border:1px solid var(--line); border-radius:10px; padding:10px 8px; text-align:center; background:#fbf8f1; }
.tile b { display:block; font-size:22px; line-height:1.3; }
.tile span { font-size:12px; color:var(--muted); }
.scope { font-size:12.5px; color:var(--muted); margin:10px 0 8px; }
table { width:100%; border-collapse:collapse; font-size:13px; }
thead { display:table-header-group; }
tr { break-inside:avoid; page-break-inside:avoid; }
th { background:#F3E0BC; text-align:right; padding:8px 10px; border-bottom:2px solid var(--gold); font-size:12.5px; }
td { padding:7px 10px; border-bottom:1px solid var(--line); vertical-align:top; text-align:right; }
td.num { color:var(--muted); width:1%; white-space:nowrap; }
td.code, td.time { white-space:nowrap; font-size:12px; color:#3a372f; }
td.name { font-weight:700; word-break:break-word; }
td.empty { text-align:center; color:var(--muted); padding:22px; }
.st-yes { font-weight:700; color:#1f7a3a; white-space:nowrap; }
.st-no { color:#8a857a; white-space:nowrap; }
.foot { margin-top:18px; padding-top:10px; border-top:1px solid var(--line); font-size:11.5px; color:var(--muted); display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; }
@page { size:A4; margin:14mm 12mm; }
@media print {
  body { background:#fff; }
  .bar { display:none; }
  .sheet { box-shadow:none; margin:0; max-width:none; padding:0; }
}
@media (max-width:600px) {
  .sheet { margin:0; padding:16px 12px; box-shadow:none; }
  .tiles { grid-template-columns:repeat(2,1fr); }
  table { font-size:12px; }
  th, td { padding:6px 5px; }
  h1 { font-size:19px; }
}`;

  return '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src ' + reportEscape(origin) + '; script-src \'nonce-' + reportEscape(nonce) + '\'">' +
    '<title>كشف الحضور — ' + reportEscape(event.name) + '</title>' +
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;700&display=swap">' +
    '<style>' + css + '</style></head><body>' +
    '<div class="bar"><button id="print-btn" type="button">🖨️ طباعة / حفظ PDF</button>' +
    '<span>في نافذة الطباعة اختر «حفظ كـ PDF» بدل الطابعة.</span></div>' +
    '<main class="sheet">' +
    '<header class="head"><img class="logo" src="' + reportEscape(origin) + '/icons/logo.svg" alt="">' +
    '<div><h1>كشف الحضور</h1><div class="ev">' + reportEscape(event.name) + '</div>' + (meta ? '<div class="meta">' + meta + '</div>' : '') + '</div></header>' +
    '<section class="tiles">' +
    '<div class="tile"><b>' + total + '</b><span>إجمالي الضيوف</span></div>' +
    '<div class="tile"><b>' + attended + '</b><span>حضروا</span></div>' +
    '<div class="tile"><b>' + pending + '</b><span>لم يحضروا</span></div>' +
    '<div class="tile"><b>' + percent + '%</b><span>نسبة الحضور</span></div>' +
    '</section>' +
    '<div class="scope">القائمة: ' + reportEscape(scopeLabel) + ' — ' + shownGuests.length + ' من ' + total + '</div>' +
    '<table><thead><tr><th>م</th><th>الاسم</th><th>الكود</th><th>الحالة</th><th>وقت الدخول</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<div class="foot"><span>أُنشئ بواسطة دعوات</span><span dir="ltr">' + reportEscape(reportTime(generatedAt.toISOString())) + '</span></div>' +
    '</main>' +
    '<script nonce="' + reportEscape(nonce) + '">document.getElementById("print-btn").addEventListener("click", function () { window.print(); });</script>' +
    '</body></html>';
}
