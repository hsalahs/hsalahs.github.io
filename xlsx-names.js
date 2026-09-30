// Reads guest names out of an Excel workbook (.xlsx) for the dashboard's
// "import list" action. An .xlsx is a zip of XML files, and JSZip (already
// loaded by event.html for the card download) opens it — no separate
// spreadsheet library, which keeps the page light and works from a plain
// file with nothing to fetch.
//
// Only the FIRST sheet is read. Which column holds the names is decided by
// pickGuestNames() in guest-names.js (shared with the CSV / text import): the
// column headed as a name column, in Arabic, English or both, wherever it
// sits; else the leftmost column with text; else, for a sheet of bare numbers
// (tickets 1..200), the leftmost column. Needs guest-names.js loaded first.
const XLSX_MAX_BYTES = 5 * 1024 * 1024;
const XLSX_NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function xlsxColumnIndex(cellRef) {
  const letters = /^([A-Z]+)/.exec(String(cellRef || '').toUpperCase());
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// All text inside an <si>/<is>/<c> string element, ignoring phonetic hints.
function xlsxText(el) {
  let out = '';
  for (const child of Array.from(el.children)) {
    if (child.localName === 't') out += child.textContent;
    else if (child.localName === 'r') {
      for (const t of Array.from(child.children)) if (t.localName === 't') out += t.textContent;
    }
  }
  return out;
}

async function xlsxParse(zip, path) {
  const file = zip.file(path);
  if (!file) return null;
  const doc = new DOMParser().parseFromString(await file.async('string'), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('BAD_XLSX');
  return doc;
}

async function xlsxFirstSheetPath(zip) {
  const fallback = 'xl/worksheets/sheet1.xml';
  const wb = await xlsxParse(zip, 'xl/workbook.xml');
  const rels = await xlsxParse(zip, 'xl/_rels/workbook.xml.rels');
  if (!wb || !rels) return fallback;
  const sheet = wb.getElementsByTagName('sheet')[0];
  if (!sheet) return fallback;
  const rid = sheet.getAttributeNS(XLSX_NS_REL, 'id') || sheet.getAttribute('r:id');
  for (const rel of Array.from(rels.getElementsByTagName('Relationship'))) {
    if (rel.getAttribute('Id') === rid) {
      const target = rel.getAttribute('Target') || '';
      return target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    }
  }
  return fallback;
}

// buffer: ArrayBuffer of the .xlsx. Returns an array of trimmed name strings.
// Throws Error('NO_ZIP') if JSZip isn't available, Error('BAD_XLSX') if the
// file isn't a readable workbook.
async function readXlsxNames(buffer) {
  if (typeof JSZip === 'undefined') throw new Error('NO_ZIP');
  if (buffer.byteLength > XLSX_MAX_BYTES) throw new Error('TOO_BIG');
  let zip;
  try { zip = await JSZip.loadAsync(buffer); } catch (e) { throw new Error('BAD_XLSX'); }

  const shared = [];
  const sst = await xlsxParse(zip, 'xl/sharedStrings.xml');
  if (sst) for (const si of Array.from(sst.getElementsByTagName('si'))) shared.push(xlsxText(si));

  const sheet = await xlsxParse(zip, await xlsxFirstSheetPath(zip));
  if (!sheet) throw new Error('BAD_XLSX');

  // column index -> [text, text, ...] in row order, blanks left out
  const columns = new Map();
  for (const c of Array.from(sheet.getElementsByTagName('c'))) {
    const col = xlsxColumnIndex(c.getAttribute('r'));
    if (col < 0) continue;
    const type = c.getAttribute('t');
    let text = '';
    const v = Array.from(c.children).find(x => x.localName === 'v');
    if (type === 's') text = v ? (shared[parseInt(v.textContent, 10)] || '') : '';
    else if (type === 'inlineStr') { const is = Array.from(c.children).find(x => x.localName === 'is'); text = is ? xlsxText(is) : ''; }
    else if (type === 'b' || type === 'e') continue;
    else text = v ? v.textContent : '';      // 'str' (formula text) and plain numbers
    text = cleanGuestName(text);
    if (!text) continue;
    if (!columns.has(col)) columns.set(col, []);
    columns.get(col).push(text);
  }
  return pickGuestNames(columns);
}
