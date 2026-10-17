// Load test, run part (GitHub Actions runner, see load-test.mjs for the whole picture): the REAL HTTP path with the public
// key only. Reads the owner account, event and door code from supabase/load-test.run. Prints the checks and latency numbers.
import { readFileSync } from 'node:fs';

const URL_ = 'https://gunizkapwatixvbfliva.supabase.co';
const KEY = (readFileSync(new URL('../supabase-config.js', import.meta.url), 'utf8').match(/anonKey:\s*'([^']+)'/) || [])[1];
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
let bad = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) bad++; };
const first = (d) => (Array.isArray(d) ? d[0] : d);

const cfg = JSON.parse(readFileSync(process.argv[2] || 'supabase/load-test.run', 'utf8'));
const EVENT = cfg.event, GUESTS = cfg.guests, PHONES = cfg.phones;
const stat = { requests: 0, bytes: 0, errors: 0, byName: {} };
const lat = (name, ms) => { (stat.byName[name] ||= []).push(ms); };
async function http(path, { token, body, name }) {
  const t0 = performance.now();
  let res, text;
  try {
    res = await fetch(URL_ + path, {
      method: 'POST', headers: { apikey: KEY, authorization: 'Bearer ' + (token || KEY), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    text = await res.text();
  } catch (e) { stat.errors++; stat.requests++; lat(name, performance.now() - t0); return { ok: false, status: 0, data: null }; }
  stat.requests++; stat.bytes += text.length; lat(name, performance.now() - t0);
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) { stat.errors++; console.log('HTTP', res.status, name, text.slice(0, 160)); }
  return { ok: res.ok, status: res.status, data };
}
const rpc = (fn, args, token) => http('/rest/v1/rpc/' + fn, { token, body: args, name: fn });
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]) : 0; };

const login = await http('/auth/v1/token?grant_type=password', { body: { email: cfg.email, password: cfg.pass }, name: 'login' });
if (!login.ok) { console.log('owner sign-in failed', login.status); process.exit(2); }
const owner = login.data.access_token;

// A. owner adds the guests in one call (like an Excel import), the cap holds
const have = (await rpc('event_live', { p_event_id: EVENT }, owner)).data;
if ((first(have) || {}).guest_count === 0) {
  const t0 = performance.now();
  const r = await rpc('add_guests', { p_event_id: EVENT, p_guests: Array.from({ length: GUESTS }, (_, i) => ({ name: 'ضيف رقم ' + (i + 1) })), p_partial: false }, owner);
  console.log(`add_guests x${GUESTS}: ${Math.round(performance.now() - t0)} ms`);
  check(r.ok && (first(r.data) || {}).added === GUESTS, `${GUESTS} guests added`);
}
check((first((await rpc('add_guests', { p_event_id: EVENT, p_guests: [{ name: 'فوق الحد' }], p_partial: false }, owner)).data) || {}).blocked === true, 'one guest over the limit is refused');

// B. dashboard full read (paged like data.js)
let t0 = performance.now();
const all = [];
for (let after = null, afterId = null; ;) {
  const r = await rpc('owner_guests', { p_event_id: EVENT, p_since: null, p_after_name: after, p_after_id: afterId, p_limit: 1000 }, owner);
  all.push(...(r.data || [])); if (!r.data || r.data.length < 1000) break;
  after = r.data[r.data.length - 1].name; afterId = r.data[r.data.length - 1].id;
}
console.log(`owner_guests full read: ${all.length} rows in ${Math.round(performance.now() - t0)} ms`);
check(all.length === GUESTS, 'owner reads every guest');
const ids = all.map((g) => g.id);

// C. door phones: anonymous sign-in + door code
const phones = [];
for (let i = 0; i < PHONES; i++) {
  const s = await http('/auth/v1/signup', { body: {}, name: 'anon_signin' });
  if (!s.ok) { console.log('anonymous sign-in failed', s.status); process.exit(2); }
  const st = await rpc('start_scan_session', { p_event_id: EVENT, p_pin: cfg.pin }, s.data.access_token);
  check(st.ok && (first(st.data) === 'ok'), `phone ${i + 1} entered the door code`);
  phones.push({ tk: s.data.access_token, n: i });
}

// D. everybody scans at once; the pages poll meanwhile
const outcomes = { allowed: 0, duplicate: 0, not_found: 0, other: 0 };
let running = true; const polls = { owner: 0, door: 0, delta: 0 };
const loops = [(async () => { while (running) { await rpc('event_live', { p_event_id: EVENT }, owner); polls.owner++; await sleep(5000); } })(),
  ...phones.map((p) => (async () => { while (running) { await rpc('door_event', { p_event_id: EVENT }, p.tk); polls.door++; await sleep(4000); } })()),
  ...phones.slice(0, 3).map((p) => (async () => { await sleep(3000); while (running) { await rpc('door_guests', { p_event_id: EVENT, p_since: new Date(Date.now() - 60000).toISOString(), p_after_name: null, p_after_id: null, p_limit: 1000 }, p.tk); polls.delta++; await sleep(10000); } })())];
t0 = performance.now();
await Promise.all(phones.map(async (p) => {
  const mine = ids.filter((_, i) => i % PHONES === p.n);
  const dups = ids.filter((_, i) => i % 50 === p.n).slice(0, 5);          // codes another phone may already have used
  for (const gid of [...mine, ...dups, 'WD-DOESNOTEXIST']) {
    const r = await rpc('check_in', { p_event_id: EVENT, p_guest_id: gid }, p.tk);
    const o = (first(r.data) || {}).outcome;
    if (o in outcomes) outcomes[o]++; else outcomes.other++;
  }
}));
const scanMs = performance.now() - t0;
running = false; await Promise.race([Promise.all(loops), sleep(12000)]);
console.log(`${PHONES} phones, ${Object.values(outcomes).reduce((a, b) => a + b, 0)} scans in ${(scanMs / 1000).toFixed(1)} s ${JSON.stringify(outcomes)}`);
check(outcomes.allowed === GUESTS, `exactly ${GUESTS} allowed (got ${outcomes.allowed})`);
check(outcomes.not_found === PHONES && outcomes.other === 0, `unknown codes refused (${outcomes.not_found}), no unexpected outcome`);

// E. the dashboard sees the result
const live = first((await rpc('event_live', { p_event_id: EVENT }, owner)).data) || {};
check(live.scanned_count === GUESTS && live.guest_count === GUESTS, `dashboard counter ${live.scanned_count} of ${live.guest_count}`);
const delta = await rpc('owner_guests', { p_event_id: EVENT, p_since: new Date(Date.now() - 600000).toISOString(), p_after_name: null, p_after_id: null, p_limit: 1000 }, owner);
check((delta.data || []).filter((g) => g.scanned).length === GUESTS, 'delta sync carries every check-in');

console.log('\nlatency (ms)        n    p50   p95   max');
for (const [k, a] of Object.entries(stat.byName)) console.log(k.padEnd(18), String(a.length).padStart(5), String(pct(a, .5)).padStart(6), String(pct(a, .95)).padStart(6), String(Math.round(Math.max(...a))).padStart(6));
console.log(`\nHTTP requests ${stat.requests}, failed ${stat.errors}, response bytes ${(stat.bytes / 1024).toFixed(0)} KB, polls: ${JSON.stringify(polls)}`);
check(stat.errors === 0, 'no failed HTTP request');
console.log(bad ? `\n${bad} CHECK(S) FAILED` : '\nALL RUN CHECKS PASSED');
process.exit(bad ? 1 : 0);
