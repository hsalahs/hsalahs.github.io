// Display formatting shared by every page that shows an event's date — the
// landing page's sample card, the invitation page and the card image the
// guest saves, the organizer's dashboard and events list — so a date reads
// the same everywhere, and always with Western digits (0-9), never the
// Eastern Arabic-Indic numerals.
const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const AR_WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

// "2026-10-29" -> "الخميس 29 أكتوبر 2026".
//
// Built by hand instead of Intl/toLocaleDateString: which digits that prints
// (and even which calendar — 'ar-SA' defaults to the Islamic one) depends on
// the visitor's device, so the same invitation would read differently on two
// phones. Calendar arithmetic is done in UTC so the day of the week can't
// shift with the visitor's time zone. Anything that isn't a real calendar date
// comes back unchanged, so nothing an organizer typed is ever hidden.
function formatEventDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return iso || '';
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return iso;
  return AR_WEEKDAYS[dt.getUTCDay()] + ' ' + d + ' ' + AR_MONTHS[mo - 1] + ' ' + y;
}
