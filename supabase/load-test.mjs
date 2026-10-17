// Load test over the REAL HTTP path (PostgREST + Auth), the same calls data.js makes.
// The sandbox proxy replaces the apikey AND the Authorization header, so signed-in calls cannot be made from the
// sandbox; the "run" part therefore runs on a GitHub Actions runner (.github/workflows/load-test.yml, started by
// pushing supabase/load-test.run). This file has two modes; the third (run) is supabase/load-run.mjs:
//   setup  (sandbox, Management API through mgmt.mjs): creates the owner account (confirmed, random password) and a
//          paid test event with N guest slots, writes supabase/load-test.run for the runner.
//   run    (runner, no secrets needed; supabase/load-run.mjs): the owner adds N guests; PHONES anonymous "door phones" enter the door
//          code and check everybody in at the same moment while the dashboard and the phones poll like the pages do.
//   verify (sandbox): checks counters and rows in the database, then rotates the owner's password (the old one sat in git).
// Test data is kept for the later 2000-guest run: setup reuses it (resets scanned flags) when the owner already has the event.
// Usage: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node --no-warnings supabase/load-test.mjs setup|verify [guests=500] [phones=10]
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const mode = process.argv[2];
const OWNER = '00000000-0000-0000-0000-0000000a5000';
const EMAIL = 'lt-owner@test.invalid';
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
let bad = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) bad++; };

if (mode === 'setup' || mode === 'verify') {
  const { mgmt } = await import('./mgmt.mjs');
  const GUESTS = Number(process.argv[3] || 500);
  const PHONES = Number(process.argv[4] || 10);
  const sql = async (query) => {
    for (let i = 0; i < 8; i++) {
      const r = await mgmt('POST', '/database/query', { query });
      if (r.status === 429) { await sleep(5000); continue; }
      if (!r.ok) throw new Error(`${r.status} ${r.text.slice(0, 300)}`);
      return r.json();
    }
    throw new Error('management API throttled');
  };
  if (mode === 'setup') {
    const pass = 'Lt-' + randomBytes(12).toString('hex');
    await sql(`insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,confirmation_token,recovery_token,email_change_token_new,email_change)
      values ('00000000-0000-0000-0000-000000000000','${OWNER}','authenticated','authenticated','${EMAIL}',extensions.crypt('${pass}',extensions.gen_salt('bf')),now(),'{"provider":"email","providers":["email"]}','{}',now(),now(),'','','','')
      on conflict (id) do update set encrypted_password = extensions.crypt('${pass}',extensions.gen_salt('bf')), email_confirmed_at = now()`);
    await sql(`insert into public.users (uid, email) values ('${OWNER}', '${EMAIL}') on conflict (uid) do nothing`);
    let ev = await sql(`select id from public.events where owner_uid = '${OWNER}' and name = 'اختبار حمل ${GUESTS}' order by created_at limit 1`);
    if (ev.length) {
      await sql(`update public.guests set scanned = false, scanned_at = null, changed_at = now() where event_id = '${ev[0].id}'; update public.events set scanned_count = 0 where id = '${ev[0].id}'`);
      console.log('reusing event', ev[0].id, '(scanned flags reset)');
    } else {
      const id = 'lt' + GUESTS + randomBytes(3).toString('hex');
      await sql(`insert into public.account_limits (uid, event_limit, event_count) values ('${OWNER}', 1, 0) on conflict (uid) do nothing;
        insert into public.events (id, owner_uid, owner_email, name, type) values ('${id}', '${OWNER}', '${EMAIL}', 'اختبار حمل ${GUESTS}', 'wedding');
        insert into public.event_secrets (event_id, scan_pin) values ('${id}', '${String(100000 + Math.floor(Math.random() * 899999))}') on conflict (event_id) do update set scan_pin = excluded.scan_pin`);
      ev = [{ id }];
    }
    await sql(`update public.events set paid = true, guest_limit = ${GUESTS} where id = '${ev[0].id}'`);
    const [{ scan_pin: pin }] = await sql(`select scan_pin from public.event_secrets where event_id = '${ev[0].id}'`);
    writeFileSync(new URL('./load-test.run', import.meta.url), JSON.stringify({ email: EMAIL, pass, event: ev[0].id, pin, guests: GUESTS, phones: PHONES }, null, 1) + '\n');
    console.log('setup done: event', ev[0].id, '; wrote supabase/load-test.run');
  } else {
    const run = JSON.parse(readFileSync(new URL('./load-test.run', import.meta.url), 'utf8'));
    const E = run.event, G = run.guests;
    const [v] = await sql(`select (select scanned_count from public.events where id='${E}') sc,
      (select count(*)::int from public.guests where event_id='${E}' and scanned) sg,
      (select count(*)::int from public.guests where event_id='${E}' and scanned and scanned_at is null) nulls,
      (select guest_count from public.events where id='${E}') gc,
      (select count(*)::int from public.guests where event_id='${E}') g,
      (select count(*)::int from public.scan_sessions where event_id='${E}') sessions`);
    console.log(JSON.stringify(v));
    check(v.g === G && v.gc === G, `guest rows ${v.g} and counter ${v.gc} = ${G}`);
    check(v.sc === G && v.sg === G, `scanned counter ${v.sc} = scanned guests ${v.sg} = ${G} (no double entry, no lost scan)`);
    check(v.nulls === 0, 'every entered guest has a time');
    // the password in git is dead from now on
    await sql(`update auth.users set encrypted_password = extensions.crypt('${randomBytes(18).toString('hex')}', extensions.gen_salt('bf')) where id = '${OWNER}'`);
    console.log('owner password rotated');
    console.log(bad ? `${bad} CHECK(S) FAILED` : 'DATABASE CHECKS PASSED');
    process.exit(bad ? 1 : 0);
  }
  process.exit(0);
}
