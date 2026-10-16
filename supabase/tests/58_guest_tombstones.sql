-- 0016: tombstones, delta `deleted` rows, cleanup of tombstones and old rejected requests.
-- fixture event t1 ({A} owner, {D} door session): WD-1, WD-2. Add old and new format ids.
insert into public.events (id, owner_uid, name, paid) values ('tt', pg_temp.uid('A'), 'tomb', true);
insert into public.event_secrets values ('tt', '777777');
insert into public.scan_sessions (event_id, uid, pin) values ('tt', pg_temp.uid('D'), '777777');
insert into public.guests (event_id, id, name, changed_at) values
  ('tt', 'WD-K3J9ZQ0X8M2PA', 'old format', timestamptz '2026-01-01 00:00:00+00'),
  ('tt', 'WD-9F3A0C7D1E5B', 'new format', timestamptz '2026-01-01 00:00:00+00'),
  ('tt', 'T-3', 'three', timestamptz '2026-01-01 00:00:00+00'), ('tt', 'T-4', 'four', timestamptz '2026-01-01 00:00:00+00'),
  ('tt', 'T-5', 'five', timestamptz '2026-01-01 00:00:00+00');
select pg_temp.t_eq('no tombstones yet', $$select count(*) from public.guest_tombstones$$, '0');
update public.events set guests_changed_at = timestamptz '2026-01-01 00:00:00+00' where id = 'tt';
select pg_temp.t_eq('remove_guest writes a tombstone (old-format id)', $$select public.remove_guest('tt', 'WD-K3J9ZQ0X8M2PA')::text$$, 'true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('remove_guests writes tombstones (new-format id)', $$select public.remove_guests('tt', array['WD-9F3A0C7D1E5B', 'T-3'])$$, '2', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('a plain delete writes one too', $$select count(*) from public.guest_tombstones where event_id = 'tt'$$, '3');
select pg_temp.t_eq('last_change moved with the delete', $$select (last_change > now() - interval '1 minute')::text from public.event_live('tt')$$, 'true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('a guest that does not exist leaves no tombstone', $$select public.remove_guest('tt', 'NOPE')::text$$, 'false', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('and no row for it', $$select count(*) from public.guest_tombstones where id = 'NOPE'$$, '0');
-- delta returns them
select pg_temp.t_eq('owner delta returns the 3 deleted rows (and no live row)', $$select count(*) || '/' || bool_and(deleted)::text from public.owner_guests('tt', timestamptz '2026-01-02 00:00:00+00')$$, '3/true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('a tombstone row carries id and changed_at, the rest is null', $$select (name is null and scanned is null and vip is null and registered_at is null and changed_at > now() - interval '1 minute')::text from public.owner_guests('tt', timestamptz '2026-01-02 00:00:00+00', null, null, 1)$$, 'true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('door delta returns them too', $$select count(*) from public.door_guests('tt', timestamptz '2026-01-02 00:00:00+00') where deleted$$, '3', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('full mode returns live guests only, deleted = false', $$select count(*) || '/' || bool_or(deleted)::text from public.owner_guests('tt')$$, '2/false', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('door full mode too', $$select count(*) || '/' || bool_or(deleted)::text from public.door_guests('tt')$$, '2/false', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('one overload each', $$select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('door_guests', 'owner_guests')$$, '2');
select pg_temp.t_fail('a stranger cannot read tombstones through the delta', $$select * from public.owner_guests('tt', timestamptz '2026-01-02 00:00:00+00')$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_fail('nobody reads the table directly (owner)', $$select * from public.guest_tombstones$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('nobody reads the table directly (anon)', $$select * from public.guest_tombstones$$, 'anon');
-- not on an event cascade, and delete_event clears them
insert into public.events (id, owner_uid, name, paid) values ('tc', pg_temp.uid('B'), 'cascade', true);
insert into public.guests (event_id, id, name) values ('tc', 'C-1', 'c1'), ('tc', 'C-2', 'c2');
insert into public.account_limits values (pg_temp.uid('E'), 1, 1) on conflict do nothing;
select pg_temp.t_ok('delete the whole event', $$select public.delete_event('tc')$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('no tombstones for the cascade', $$select count(*) from public.guest_tombstones where event_id = 'tc'$$, '0');
insert into public.guest_tombstones (event_id, id) values ('tt2', 'x');
-- paging with tombstones and ties: 2300 live + 1500 tombstones, all with the same changed_at for 40 of them
insert into public.events (id, owner_uid, name, paid) values ('tq', pg_temp.uid('A'), 'paging', true);
insert into public.event_secrets values ('tq', '888888');
insert into public.scan_sessions (event_id, uid, pin) values ('tq', pg_temp.uid('D'), '888888');
insert into public.guests (event_id, id, name, changed_at)
  select 'tq', 'WD-' || lpad(i::text, 5, '0'), 'n' || (i % 50), (now() - interval '1 day') + ((i % 700) || ' seconds')::interval from generate_series(1, 2300) i;
insert into public.guest_tombstones (event_id, id, deleted_at)
  select 'tq', 'WD-X' || lpad(i::text, 5, '0'), (now() - interval '1 day') + ((i % 700) || ' seconds')::interval from generate_series(1, 1500) i;
create function pg_temp.walk_mix(eid text, lim int) returns text language plpgsql as $$
declare s timestamptz := now() - interval '2 days'; ai text := null; n int; total int := 0; dels int := 0; pages int := 0; ids text[] := '{}'; r record;
  pc timestamptz := null; pi text := null; ordered boolean := true;
begin
  loop
    n := 0;
    for r in select * from public.owner_guests(eid, s, null, ai, lim) loop
      n := n + 1; total := total + 1; ids := ids || r.id; if r.deleted then dels := dels + 1; end if;
      if pc is not null and (r.changed_at, r.id) <= (pc, pi) then ordered := false; end if;
      pc := r.changed_at; pi := r.id; s := r.changed_at; ai := r.id;
    end loop;
    pages := pages + 1;
    exit when n < lim;
  end loop;
  return total || '/' || (select count(distinct x) from unnest(ids) x) || '/' || dels || '/' || pages || '/' || ordered;
end $$;
grant execute on function pg_temp.walk_mix(text, int) to public;
select pg_temp.t_eq('3800 delta rows (2300 live + 1500 deleted): none lost or doubled, ordered, 4 pages', $$select pg_temp.walk_mix('tq', 1000)$$, '3800/3800/1500/4/true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('tiny pages with ties', $$select pg_temp.walk_mix('tq', 13)$$, '3800/3800/1500/293/true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('the delta limit is capped at 1000', $$select count(*) from public.owner_guests('tq', now() - interval '2 days', null, null, 5000)$$, '1000', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('the full list stays live-only (2300)', $$select count(*) from public.owner_guests('tq', null, null, null, 1000) where not deleted$$, '1000', 'authenticated', pg_temp.uid('A'));
-- cleanup: tombstones older than 7 days and of gone events; rejected requests (retention rule in 59)
update public.guest_tombstones set deleted_at = now() - interval '8 days' where event_id = 'tq' and substr(id, 5)::int <= 500;
insert into public.requests (event_id, id, name, status, created_at) values
  ('t1', 'old-rejected-' || repeat('a', 10), 'old rej', 'rejected', now() - interval '100 days'),
  ('t1', 'new-rejected-' || repeat('b', 10), 'new rej', 'rejected', now() - interval '80 days'),
  ('t1', 'old-pending-' || repeat('c', 10), 'old pen', 'pending', now() - interval '60 days'),
  ('t1', 'old-approved-' || repeat('d', 10), 'old app', 'approved', now() - interval '60 days');
select pg_temp.t_eq('before the cleanup', $$select count(*) from public.guest_tombstones where event_id = 'tq'$$, '1500');
select pg_temp.t_eq('old ones marked', $$select count(*) from public.guest_tombstones where event_id = 'tq' and deleted_at < now() - interval '7 days'$$, '500');
select pg_temp.t_ok('run the weekly cleanup', $$select app_private.cleanup_anonymous_users()$$);
select pg_temp.t_eq('tombstones older than 7 days are gone', $$select count(*) from public.guest_tombstones where event_id = 'tq'$$, '1000', 'postgres');
select pg_temp.t_eq('tombstones of a gone event are gone', $$select count(*) from public.guest_tombstones where event_id = 'tt2'$$, '0');
select pg_temp.t_eq('recent tombstones stay', $$select count(*) from public.guest_tombstones where event_id = 'tt'$$, '3');
select pg_temp.t_eq('the old rejected request is purged', $$select count(*) from public.requests where id like 'old-rejected-%'$$, '0');
select pg_temp.t_eq('the recent rejected request stays', $$select count(*) from public.requests where id like 'new-rejected-%'$$, '1');
select pg_temp.t_eq('old pending and approved requests stay', $$select count(*) from public.requests where id like 'old-pending-%' or id like 'old-approved-%'$$, '2');
select pg_temp.t_eq('the guest page of a purged rejected request finds nothing', $$select count(*) from public.get_request('t1', 'old-rejected-' || repeat('a', 10))$$, '0', 'anon');
select pg_temp.t_eq('the guest page of a recent rejected request still says rejected', $$select status from public.get_request('t1', 'new-rejected-' || repeat('b', 10))$$, 'rejected', 'anon');
select * from pg_temp.report();
