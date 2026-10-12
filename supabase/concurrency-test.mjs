// Real-concurrency check (the in-transaction SQL tests cannot show races): N separate
// connections scan the SAME barcode at the same moment; exactly one must be 'allowed'.
// Creates committed rows with the prefix zzconc and always deletes them at the end.
// Usage: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node --no-warnings supabase/concurrency-test.mjs [N=12]
const ref = process.env.SUPABASE_REF || 'gunizkapwatixvbfliva';
const url = `https://api.supabase.com/v1/projects/${ref}/database/query`;
const N = Number(process.argv[2] || 12);
const OWNER = '00000000-0000-0000-0000-00000000c0c0';
const sql = async (query) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 400)}`);
  return JSON.parse(t);
};
// an open transaction is rolled back when the request ends, so commit explicitly
const asOwner = (q) => `begin; select set_config('request.jwt.claims', '{"sub":"${OWNER}","role":"authenticated","is_anonymous":false}', true); set local role authenticated; ${q}; commit;`;
const cleanup = () => sql(`delete from public.events where id like 'zzconc%'; delete from auth.users where id = '${OWNER}'`);
let bad = 0;
try {
  await cleanup();
  await sql(`insert into auth.users (id, email) values ('${OWNER}', 'zzconc@test.local');
    insert into public.events (id, owner_uid, name, paid) values ('zzconc1', '${OWNER}', 'concurrency', true);
    insert into public.guests (event_id, id, name) select 'zzconc1', 'WD-' || g, 'g' || g from generate_series(1, 3) g`);
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
} finally {
  await cleanup();
}
console.log(bad ? 'CONCURRENCY TEST FAILED' : 'concurrency test passed');
process.exit(bad ? 1 : 0);
