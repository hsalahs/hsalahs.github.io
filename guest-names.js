// Reading guest names out of the files customers bring — a text list, a CSV
// or an Excel sheet — whatever language they are in: Arabic only, English
// only, or both in the same file (even in the same name). Shared by the
// CSV/text import here and by xlsx-names.js (Excel).
//
// What this handles that a "split on commas" reader does not:
//   - the file's encoding. Excel on an Arabic Windows saves "CSV" as
//     Windows-1256, and "Unicode Text" as UTF-16; read as UTF-8 both turn
//     every Arabic name into question marks;
//   - the byte-order mark Excel puts in front of UTF-8 files (it would stick
//     to the first name);
//   - the separator: comma, semicolon (Excel in many regions) or tab;
//   - quoted cells: "Smith, John", doubled quotes, a name spanning lines;
//   - which column holds the names: found by its header, in Arabic, English
//     or both ("الاسم / Name"), wherever it sits — a numbering column ("م")
//     or a phone column is not imported as names;
//   - invisible direction marks that Excel and Word add around Arabic text,
//     which would make the same person look like two different names.

// Header words that mean "the name column".
const GUEST_NAME_HEADERS = ['name', 'names', 'guest name', 'guest names', 'full name', 'invitee', 'invitees',
  'الاسم', 'اسم', 'الاسماء', 'اسم الضيف', 'اسماء الضيوف', 'اسم المدعو', 'المدعو', 'المدعوين', 'الاسم الكامل', 'الاسم الثلاثي', 'الضيف', 'الضيوف'];

// Zero-width and direction-control characters (ZWSP, ZWNJ, ZWJ, LRM, RLM,
// LRE..RLO, word joiner, isolates, byte-order mark). Invisible, never part of a name.
const GUEST_NAME_MARKS = /[​-‏‪-‮⁠-⁩﻿]/g;

// Spaces tidied, invisible marks dropped.
function cleanGuestName(value) {
  return String(value == null ? '' : value).replace(GUEST_NAME_MARKS, '').replace(/\s+/g, ' ').trim();
}

// Arabic spelling variants that should not stop a header from matching:
// diacritics and tatweel removed, alef forms and alef-maqsura unified.
function normalizeHeaderText(value) {
  return cleanGuestName(value).toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[آأإ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/[*:؟?]+$/g, '')
    .trim();
}
const GUEST_NAME_HEADER_SET = new Set(GUEST_NAME_HEADERS.map(normalizeHeaderText));

// "الاسم", "Name", "الاسم / Name", "Name - الاسم", "الاسم (Name)", "اسم الضيف *".
// Every part of a bilingual header must be a header word, so a guest called
// "Ali - Guest" is not mistaken for one.
function isNameHeaderText(value) {
  const text = normalizeHeaderText(value);
  if (!text) return false;
  if (GUEST_NAME_HEADER_SET.has(text)) return true;
  const parts = text.split(/[\/\\|,،;:()\[\]\-–—]+/).map(p => p.trim()).filter(Boolean);
  return parts.length > 1 && parts.every(p => GUEST_NAME_HEADER_SET.has(p));
}

// columns: Map(columnIndex -> [text, text, ...]) in row order, blanks left out.
// Returns the guest names: the column headed as a name column; else the
// leftmost column with any text that has a letter in it; else (a sheet of
// bare numbers, e.g. tickets 1..200) the leftmost column with anything.
function pickGuestNames(columns) {
  if (!columns || columns.size === 0) return [];
  const order = Array.from(columns.keys()).sort((a, b) => a - b);
  const hasLetter = (t) => /\p{L}/u.test(t);
  let chosen = order.find(k => isNameHeaderText(columns.get(k)[0]));
  if (chosen === undefined) chosen = order.find(k => columns.get(k).some(hasLetter));
  if (chosen === undefined) chosen = order[0];
  const cells = columns.get(chosen);
  const start = isNameHeaderText(cells[0]) ? 1 : 0;
  return cells.slice(start).map(cleanGuestName).filter(Boolean);
}

// The bytes of a text file -> a string, whatever Excel saved it as.
function decodeTextFile(buffer) {
  const b = new Uint8Array(buffer);
  const decode = (label, bytes, fatal) => new TextDecoder(label, { fatal: !!fatal }).decode(bytes);
  if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return decode('utf-8', b.subarray(3));
  if (b[0] === 0xFF && b[1] === 0xFE) return decode('utf-16le', b.subarray(2));
  if (b[0] === 0xFE && b[1] === 0xFF) return decode('utf-16be', b.subarray(2));
  try { return decode('utf-8', b, true); } catch (e) { /* not UTF-8: an older Excel "CSV" */ }
  try { return decode('windows-1256', b); } catch (e) { return decode('utf-8', b); }
}

// The separator Excel used: whichever of , ; tab is most common on the first
// line that has content (outside quotes).
function detectDelimiter(text) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false, seen = false;
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === '\n' || ch === '\r')) { if (seen) break; }
    else if (!inQuotes) {
      if (ch in counts) counts[ch]++;
      if (ch.trim() !== '') seen = true;
    }
  }
  const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  return counts[best] > 0 ? best : ',';
}

// CSV / text -> rows of cells. Handles quotes ("" is a quote), separators
// and line breaks inside quotes, and LF / CRLF / CR line endings. Blank rows are dropped.
function parseDelimited(text) {
  text = String(text).replace(/^﻿/, '');
  const delim = detectDelimiter(text);
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"' && field === '') {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(cell => cell.trim() !== ''));
}

// File bytes -> guest names (text list, CSV, tab-separated, any of the encodings above).
function readTextNames(buffer) {
  const text = decodeTextFile(buffer);
  // A PDF, image or other binary file renamed .csv: not a list of names.
  if (text.includes('\u0000')) throw new Error('NOT_TEXT');
  const columns = new Map();
  parseDelimited(text).forEach(row => {
    row.forEach((cell, c) => {
      const text = cleanGuestName(cell);
      if (!text) return;
      if (!columns.has(c)) columns.set(c, []);
      columns.get(c).push(text);
    });
  });
  return pickGuestNames(columns);
}
