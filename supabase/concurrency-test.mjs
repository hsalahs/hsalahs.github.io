// Real-concurrency check (the in-transaction SQL tests cannot show races): N separate
// connections scan the SAME barcode at the same moment; exactly one must be 'allowed'.
// Creates committed rows with the prefix zzconc and always deletes them at the end.
// Usage: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node --no-warnings supabase/concurrency-test.mjs [N=12]
const ref = process.env.SUPABASE_REF || 'gunizkapwatixvbfliva';
const url = `https://api.supabase.com/v1/projects/${ref}/database/query`;
const N = Number(process.argv[2] || 8);
const OWNER = '00000000-0000-0000-0000-00000000c0c0';
const sql = async (query) => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
    const t = await r.text();
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 4000)); continue; }   // management API throttle
    if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 400)}`);
    return JSON.parse(t);
  }
  throw new Error('429 too many requests, gave up');
};
// an open transaction is rolled back when the request ends, so commit explicitly
const asOwner = (q) => `begin; select set_config('request.jwt.claims', '{"sub":"${OWNER}","role":"authenticated","is_anonymous":false}', true); set local role authenticated; ${q}; commit;`;
const cleanup = () => sql(`delete from public.events where id like 'zzconc%' or owner_uid = '${OWNER}'; delete from public.account_limits where uid = '${OWNER}'; delete from public.users where uid = '${OWNER}'; delete from auth.users where id = '${OWNER}'`);
const ONLY = process.env.ONLY || '';   // ONLY=12 runs just the last section
let bad = 0;
try {
  await cleanup();
  await sql(`insert into auth.users (id, email) values ('${OWNER}', 'zzconc@test.local');
    insert into public.events (id, owner_uid, name, paid) values ('zzconc1', '${OWNER}', 'concurrency', true);
    insert into public.guests (event_id, id, name) select 'zzconc1', 'WD-' || g, 'g' || g from generate_series(1, 3) g`);
  if (!ONLY) {
  // 1) same barcode, N parallel connections
  const res = await Promise.all(Array.from({ length: N }, () => sql(asOwner(`select outcome from public.check_in('zzconc1', 'WD-1')`))));
  const outcomes = res.map((r) => r[0].outcome);
  const allowed = outcomes.filter((o) => o === 'allowed').length;
  const dup = outcomes.filter((o) => o === 'duplicate').length;
  console.log(`same barcode x${N}: allowed=${allowed} duplicate=${dup} other=${N - allowed - dup}`);
  if (allowed !== 1 || dup !== N - 1) bad++;
  // 2) different barcodes at the same moment: all allowed, counter exact
  const res2 = await Promise.all(['WD-2', 'WD-3'].flatMap((id) => Array.from({ length: 4 }, () => sql(asOwner(`select outcome from public.check_in('zzconc1', '${id}')`)))));
  const a2 = res2.filter((r) => r[0].outcome === 'allowed').length;
  console.log(`two barcodes x4 each: allowed=${a2} (expect 2)`);
  if (a2 !== 2) bad++;
  const [row] = await sql(`select scanned_count, guest_count from public.events where id = 'zzconc1'`);
  console.log(`scanned_count=${row.scanned_count} (expect 3) guest_count=${row.guest_count}`);
  if (row.scanned_count !== 3) bad++;
  // 3) concurrent adds at the cap: a free event (cap 5) with 4 guests, 6 parallel inserts -> exactly 1 succeeds
  await sql(`update public.events set paid = false where id = 'zzconc1'; delete from public.guests where event_id = 'zzconc1' and id = 'WD-3'; delete from public.guests where event_id = 'zzconc1' and id = 'WD-2';
    insert into public.guests (event_id, id, name) select 'zzconc1', 'B-' || g, 'b' || g from generate_series(1, 3) g`);
  const adds = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => sql(`insert into public.guests (event_id, id, name) values ('zzconc1', 'C-${i}', 'c')`)));
  const okAdds = adds.filter((x) => x.status === 'fulfilled').length;
  const [c] = await sql(`select guest_count from public.events where id = 'zzconc1'`);
  console.log(`concurrent adds at the cap (4 of 5 used): succeeded=${okAdds} (expect 1), guest_count=${c.guest_count} (expect 5)`);
  if (okAdds !== 1 || c.guest_count !== 5) bad++;
  // 4) lockout under parallel guessing: 30 parallel wrong codes from ONE device -> exactly 10 answered 'wrong', the rest 'locked'
  const DEV = '00000000-0000-0000-0000-00000000c0c1';
  await sql(`insert into public.event_secrets (event_id, scan_pin) values ('zzconc1', '424242') on conflict (event_id) do update set scan_pin = '424242'`);
  const asDev = (q) => `begin; select set_config('request.jwt.claims', '{"sub":"${DEV}","role":"authenticated","is_anonymous":true}', true); set local role authenticated; ${q}; commit;`;
  const tries = await Promise.all(Array.from({ length: 30 }, () => sql(asDev(`select public.start_scan_session('zzconc1', '000000') as r`))));
  const wrong = tries.filter((r) => r[0].r === 'wrong').length;
  const locked = tries.filter((r) => r[0].r === 'locked').length;
  console.log(`30 parallel wrong codes, one device: wrong=${wrong} (expect 10) locked=${locked} (expect 20)`);
  if (wrong !== 10 || locked !== 20) bad++;
  // 5) add_guests RPC under parallel load: free event (cap 5), 3 used, 8 parallel calls of 1 guest -> exactly 2 succeed
  await sql(`delete from public.guests where event_id = 'zzconc1'; insert into public.guests (event_id, id, name) select 'zzconc1', 'D-' || g, 'd' from generate_series(1, 3) g`);
  const rpc = await Promise.all(Array.from({ length: 8 }, (_, i) => sql(asOwner(`select added from public.add_guests('zzconc1', '[{"name":"n${i}"}]')`))));
  const addedTotal = rpc.reduce((n, r) => n + r[0].added, 0);
  const [c2] = await sql(`select guest_count from public.events where id = 'zzconc1'`);
  console.log(`8 parallel add_guests at 3 of 5: added=${addedTotal} (expect 2), guest_count=${c2.guest_count} (expect 5)`);
  if (addedTotal !== 2 || c2.guest_count !== 5) bad++;
  // 6) double click: 6 parallel approve_requests of the SAME 3 requests on a free event (room for 5) with 3 requests -> exactly 3 guests, no duplicates
  await sql(`delete from public.guests where event_id = 'zzconc1'; delete from public.requests where event_id = 'zzconc1';
    insert into public.requests (event_id, id, name) select 'zzconc1', 'zzconc-req-' || lpad(g::text, 10, '0'), 'r' || g from generate_series(1, 3) g`);
  const items = JSON.stringify([1, 2, 3].map((g) => ({ req_id: 'zzconc-req-' + String(g).padStart(10, '0') })));
  await Promise.all(Array.from({ length: 6 }, () => sql(asOwner(`select cardinality(approved) from public.approve_requests('zzconc1', '${items}')`))));
  const [c3] = await sql(`select (select count(*) from public.guests where event_id='zzconc1')::int g, (select count(distinct req_id) from public.guests where event_id='zzconc1')::int d, (select count(*) from public.requests where event_id='zzconc1' and status='approved')::int a`);
  console.log(`6 parallel approvals of the same 3 requests: guests=${c3.g} distinct=${c3.d} approved=${c3.a} (expect 3/3/3)`);
  if (c3.g !== 3 || c3.d !== 3 || c3.a !== 3) bad++;
  // 7) submit_request at the pending cap (free event: floor of 50): 45 pending already, 10 parallel submits -> exactly 5 accepted
  await sql(`delete from public.requests where event_id = 'zzconc1'; delete from public.guests where event_id = 'zzconc1';
    insert into public.requests (event_id, id, name) select 'zzconc1', 'zzconc-pre-' || lpad(g::text, 10, '0'), 'p' from generate_series(1, 45) g`);
  const subs = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => sql(`select public.submit_request('zzconc1', 'zzconc-sub-${String(i).padStart(10, '0')}', 'n${i}')`)));
  const [c4] = await sql(`select count(*)::int n from public.requests where event_id='zzconc1' and status='pending'`);
  console.log(`10 parallel submit_request with 45 of 50 used: pending=${c4.n} (expect 50), accepted=${subs.filter((x) => x.status === 'fulfilled').length} (expect 5)`);
  if (c4.n !== 50) bad++;
  // 8) create_event under the limit: a customer with limit 1 fires 6 parallel creations -> exactly 1 event, count 1
  await sql(`delete from public.events where owner_uid = '${OWNER}'; delete from public.account_limits where uid = '${OWNER}'`);
  const cr = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => sql(asOwner(`select public.create_event('conc ${i}', 'wedding', '', '', '', '')`))));
  const [c5] = await sql(`select (select count(*) from public.events where owner_uid = '${OWNER}')::int n, (select event_count from public.account_limits where uid = '${OWNER}') cnt`);
  console.log(`6 parallel create_event with limit 1: events=${c5.n} (expect 1), event_count=${c5.cnt} (expect 1), succeeded=${cr.filter((x) => x.status === 'fulfilled').length}`);
  if (c5.n !== 1 || c5.cnt !== 1) bad++;
  // 9) double delete: limit 3 with 2 events (count 2): 6 parallel delete_event of ONE event -> count must be 1, not 0
  await sql(`delete from public.events where owner_uid = '${OWNER}'; update public.account_limits set event_limit = 3, event_count = 2 where uid = '${OWNER}';
    insert into public.events (id, owner_uid, name) values ('zzconc-x', '${OWNER}', 'x'), ('zzconc-y', '${OWNER}', 'y')`);
  await Promise.allSettled(Array.from({ length: 6 }, () => sql(asOwner(`select public.delete_event('zzconc-x')`))));
  const [c6] = await sql(`select event_count, (select count(*) from public.events where owner_uid = '${OWNER}')::int n from public.account_limits where uid = '${OWNER}'`);
  console.log(`6 parallel delete_event of one event: event_count=${c6.event_count} (expect 1), events left=${c6.n} (expect 1)`);
  if (c6.event_count !== 1 || c6.n !== 1) bad++;
  // 10) lock order (deadlock check). B holds the EVENT lock for 1.5 s and then deletes the event; A starts 0.5 s later
  // with a write on one guest. The OLD client path (direct guest UPDATE, guest row locked first, then the event row
  // through the counter trigger) must deadlock: that proves the check is sensitive. The NEW path (set_guest_scanned,
  // event row locked first) must not.
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const mkEvent = (id) => sql(`delete from public.events where id = '${id}'; insert into public.events (id, owner_uid, name, paid) values ('${id}', '${OWNER}', 'x', true);
    insert into public.guests (event_id, id, name) select '${id}', 'G-' || g, 'g' from generate_series(1, 5) g`);
  const race = async (id, writerSql) => {
    await mkEvent(id);
    const b = sql(asOwner(`select 1 from public.events where id = '${id}' for update; select pg_sleep(1.5); select public.delete_event('${id}')`).replace('set local role authenticated;', ''));
    await wait(500);
    const a = sql(writerSql);
    const res = await Promise.allSettled([a, b]);
    return res.filter((x) => x.status === 'rejected' && /deadlock/i.test(String(x.reason))).length;
  };
  const oldPath = await race('zzconc-lo1', `begin; update public.guests set scanned = true where event_id = 'zzconc-lo1' and id = 'G-1'; commit; select 1`);
  const newPath = await race('zzconc-lo2', asOwner(`select public.set_guest_scanned('zzconc-lo2', 'G-1', true)`));
  const newPath2 = await race('zzconc-lo3', asOwner(`select public.remove_guest('zzconc-lo3', 'G-1')`));
  const newPath3 = await race('zzconc-lo4', asOwner(`select outcome from public.check_in('zzconc-lo4', 'G-1')`));
  console.log(`lock order: old path deadlocks=${oldPath} (expect >=1 = the check can see it), set_guest_scanned=${newPath}, remove_guest=${newPath2}, check_in=${newPath3} (expect 0 each)`);
  if (oldPath < 1 || newPath || newPath2 || newPath3) bad++;
  // 11) the same readable name claimed by two events at once: exactly one wins, the other gets SLUG_TAKEN (not a raw 23505)
  await sql(`delete from public.events where id in ('zzconc-s1','zzconc-s2'); insert into public.events (id, owner_uid, name, paid) values ('zzconc-s1', '${OWNER}', 'a', true), ('zzconc-s2', '${OWNER}', 'b', true)`);
  const cl = await Promise.allSettled(['zzconc-s1', 'zzconc-s2', 'zzconc-s1', 'zzconc-s2'].map((id) => sql(asOwner(`select public.claim_slug('${id}', 'zzconc-race-name')`))));
  const won = cl.filter((x) => x.status === 'fulfilled').length;
  const bad23505 = cl.filter((x) => x.status === 'rejected' && /23505|duplicate key/i.test(String(x.reason))).length;
  const [sl] = await sql(`select count(*)::int n from public.slugs where slug = 'zzconc-race-name'`);
  console.log(`4 parallel claims of one name by 2 events: succeeded=${won}, raw 23505 errors=${bad23505} (expect 0), rows=${sl.n} (expect 1)`);
  if (bad23505 || sl.n !== 1) bad++;
  }
  // 12) reject racing approve on the SAME request: exactly one wins, and a rejected request never gets a guest
  let rejWins = 0, appWins = 0, ghosts = 0;
  for (let round = 0; round < 3; round++) {
    await sql(`delete from public.guests where event_id = 'zzconc1'; delete from public.requests where event_id = 'zzconc1';
      insert into public.requests (event_id, id, name) select 'zzconc1', 'zzconc-rr-${round}-' || lpad(g::text, 10, '0'), 'r' || g from generate_series(1, ${N}) g`);
    const jobs = [];
    for (let g = 1; g <= N; g++) {
      const rid = `zzconc-rr-${round}-${String(g).padStart(10, '0')}`;
      jobs.push(sql(asOwner(`select public.reject_request('zzconc1', '${rid}')::text as r`)).then((r) => ['rej', rid, r[0].r]));
      jobs.push(sql(asOwner(`select cardinality(approved)::text as r from public.approve_requests('zzconc1', '[{"req_id":"${rid}"}]')`)).then((r) => ['app', rid, r[0].r]));
    }
    const out = await Promise.all(jobs);
    for (let g = 1; g <= N; g++) {
      const rid = `zzconc-rr-${round}-${String(g).padStart(10, '0')}`;
      const rej = out.find((o) => o[0] === 'rej' && o[1] === rid)[2] === 'true';
      const app = out.find((o) => o[0] === 'app' && o[1] === rid)[2] === '1';
      if (rej === app) bad++;
      if (rej) rejWins++; else appWins++;
    }
    const [c] = await sql(`select (select count(*) from public.guests where event_id='zzconc1' and req_id like 'zzconc-rr-${round}-%' and req_id in (select id from public.requests where event_id='zzconc1' and status='rejected'))::int ghost,
      (select count(*) from public.requests where event_id='zzconc1' and status='approved')::int a, (select count(*) from public.guests where event_id='zzconc1')::int g`);
    ghosts += c.ghost;
    if (c.ghost || c.a !== c.g) bad++;
  }
  console.log(`reject vs approve on the same request (3 rounds x ${N}): rejected=${rejWins} approved=${appWins}, guests for rejected requests=${ghosts} (expect 0), every request has exactly one winner`);
} finally {
  await cleanup();
}
console.log(bad ? 'CONCURRENCY TEST FAILED' : 'concurrency test passed');
process.exit(bad ? 1 : 0);
