// Reads guest names out of an Excel workbook (.xlsx) for the dashboard's
// "import list" action. An .xlsx is a zip of XML files, and JSZip (already
// loaded by event.html for the card download) opens it — no separate
// spreadsheet library, which keeps the page light and works from a plain
// file with nothing to fetch.
//
// Only the FIRST sheet is read. Which column holds the names:
//   1. the column whose header says name / الاسم / اسم … (any position — lists
//      often start with a "م" or "#" numbering column);
//   2. otherwise the leftmost column that has at least one non-numeric cell;
//   3. otherwise (a sheet of bare numbers, e.g. tickets 1..200) the leftmost
//      column with anything in it.
// A header row is skipped; blank cells are ignored; nothing else is inferred.
const XLSX_NAME_HEADERS = ['name', 'names', 'guest', 'guests', 'guest name', 'full name',
  'الاسم', 'اسم', 'الأسماء', 'الاسماء', 'اسم الضيف', 'اسم المدعو', 'الاسم الكامل', 'المدعو', 'المدعوين', 'الضيف', 'الضيوف'];
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

  // column index -> [{ row, text, numeric }]
  const columns = new Map();
  for (const c of Array.from(sheet.getElementsByTagName('c'))) {
    const col = xlsxColumnIndex(c.getAttribute('r'));
    if (col < 0) continue;
    const type = c.getAttribute('t');
    let text = '';
    let numeric = false;
    const v = Array.from(c.children).find(x => x.localName === 'v');
    if (type === 's') text = v ? (shared[parseInt(v.textContent, 10)] || '') : '';
    else if (type === 'inlineStr') { const is = Array.from(c.children).find(x => x.localName === 'is'); text = is ? xlsxText(is) : ''; }
    else if (type === 'str') text = v ? v.textContent : '';
    else if (type === 'b' || type === 'e') continue;
    else { text = v ? v.textContent : ''; numeric = true; }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (!columns.has(col)) columns.set(col, []);
    columns.get(col).push({ text, numeric });
  }
  if (columns.size === 0) return [];

  const order = Array.from(columns.keys()).sort((a, b) => a - b);
  const isHeader = (t) => XLSX_NAME_HEADERS.includes(t.toLowerCase());
  let chosen = order.find(k => isHeader(columns.get(k)[0].text));
  if (chosen === undefined) chosen = order.find(k => columns.get(k).some(cell => !cell.numeric));
  if (chosen === undefined) chosen = order[0];

  const cells = columns.get(chosen);
  const start = isHeader(cells[0].text) ? 1 : 0;
  return cells.slice(start).map(cell => cell.text);
}
