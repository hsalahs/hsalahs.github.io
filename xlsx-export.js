// Builds an Excel workbook (.xlsx) of the guest list for the dashboard's
// "export" action. An .xlsx is a zip of XML files; JSZip (already loaded by
// event.html for the card download) writes it, so no separate spreadsheet
// library is added.
//
// What the workbook guarantees, whatever the names look like (Arabic only,
// English only, both in one name, digits, symbols, emoji):
//   - every value is written as TEXT, never as a formula or number — a guest
//     who registered as  =HYPERLINK("http://...")  is shown as those very
//     characters, not run;
//   - characters XML cannot carry (control characters) are dropped, and the
//     rest are escaped, so no name can corrupt the file;
//   - leading/trailing spaces are kept;
//   - the sheet reads right-to-left with the header row frozen. Each cell's
//     text still lays out by its own script, so English names read left to
//     right inside an Arabic sheet and mixed names display correctly.
const XLSX_EXPORT_HEADERS = ['الاسم', 'الكود', 'الحضور', 'وقت التسجيل'];
const XLSX_EXPORT_SHEET = 'الضيوف';
const XLSX_EXPORT_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// XML 1.0 allows tab, LF, CR and everything from U+0020 except the surrogate
// range and U+FFFE/U+FFFF; anything else would make Excel report a corrupt file.
function xlsxCleanText(value) {
  let out = '';
  for (const ch of String(value == null ? '' : value)) {
    const c = ch.codePointAt(0);
    if (c === 0x9 || c === 0xA || c === 0xD || (c >= 0x20 && c <= 0xD7FF) || (c >= 0xE000 && c <= 0xFFFD) || (c >= 0x10000 && c <= 0x10FFFF)) out += ch;
  }
  return out;
}
function xlsxEscape(value) {
  return xlsxCleanText(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function xlsxColumnLetter(index) {
  let n = index + 1, s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// "2026-09-30T14:22:05.123Z" -> "2026-09-30 17:22" in the viewer's own time
// zone, always with Western digits; anything that is not a date is kept as is.
function xlsxFriendlyTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function xlsxSheetXml(rows) {
  const widths = [34, 20, 12, 20];
  const cols = widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('');
  const body = rows.map((row, r) => {
    const cells = row.map((value, c) => {
      const text = xlsxCleanText(value);
      if (text === '') return '';
      const ref = xlsxColumnLetter(c) + (r + 1);
      return '<c r="' + ref + '"' + (r === 0 ? ' s="1"' : '') + ' t="inlineStr"><is><t xml:space="preserve">' + xlsxEscape(text) + '</t></is></c>';
    }).join('');
    return '<row r="' + (r + 1) + '">' + cells + '</row>';
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<dimension ref="A1:' + xlsxColumnLetter(widths.length - 1) + rows.length + '"/>' +
    '<sheetViews><sheetView rightToLeft="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    '<cols>' + cols + '</cols>' +
    '<sheetData>' + body + '</sheetData>' +
    '</worksheet>';
}

const XLSX_STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFF3E0BC"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center"/></xf></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

// guests: [{ name, id, scanned, registeredAt }]. Resolves to a Blob.
async function buildGuestsXlsx(guests) {
  if (typeof JSZip === 'undefined') throw new Error('NO_ZIP');
  const rows = [XLSX_EXPORT_HEADERS.slice()];
  guests.forEach(g => rows.push([g.name, g.id, g.scanned ? 'حضر' : 'لسه', xlsxFriendlyTime(g.registeredAt)]));

  const zip = new JSZip();
  // No folder entries: a package holds only its parts, which is what Office expects.
  const add = (name, data) => zip.file(name, data, { createFolders: false });
  add('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>');
  add('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>');
  add('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="20000" windowHeight="10000"/></bookViews>' +
    '<sheets><sheet name="' + xlsxEscape(XLSX_EXPORT_SHEET) + '" sheetId="1" r:id="rId1"/></sheets>' +
    '</workbook>');
  add('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>');
  add('xl/styles.xml', XLSX_STYLES);
  add('xl/worksheets/sheet1.xml', xlsxSheetXml(rows));
  return zip.generateAsync({ type: 'blob', mimeType: XLSX_EXPORT_MIME, compression: 'DEFLATE' });
}
