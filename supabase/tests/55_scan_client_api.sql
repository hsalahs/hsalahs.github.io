-- 0013: last_change, keyset paging of door_guests, is_admin_me.
-- one paid event with 2500 guests (names repeat so the (name, id) tie-break is exercised)
insert into public.events (id, owner_uid, name, paid) values ('tp', pg_temp.uid('A'), 'big', true);
insert into public.event_secrets values ('tp', '111111');
insert into public.scan_sessions (event_id, uid, pin) values ('tp', pg_temp.uid('D'), '111111');
insert into public.guests (event_id, id, name)
  select 'tp', 'WD-' || lpad(i::text, 5, '0'), 'name ' || lpad((i % 700)::text, 4, '0') from generate_series(1, 2500) i;

-- walk the full list page by page exactly like the client does
create function pg_temp.walk_full(eid text, lim int) returns text language plpgsql as $$
declare an text := null; ai text := null; n int; total int := 0; pages int := 0; ids text[] := '{}'; r record; ordered boolean := true; pn text := null; pi text := null;
begin
  loop
    n := 0;
    for r in select * from public.door_guests(eid, null, an, ai, lim) loop
      n := n + 1; total := total + 1; ids := ids || r.id;
      if pn is not null and (r.name, r.id) <= (pn, pi) then ordered := false; end if;
      pn := r.name; pi := r.id; an := r.name; ai := r.id;
    end loop;
    pages := pages + 1;
    exit when n < lim;
  end loop;
  return total || '/' || (select count(distinct x) from unnest(ids) x) || '/' || pages || '/' || ordered;
end $$;
-- walk the delta (since set) page by page
create function pg_temp.walk_delta(eid text, since timestamptz, lim int) returns text language plpgsql as $$
declare s timestamptz := since; ai text := null; n int; total int := 0; pages int := 0; ids text[] := '{}'; r record;
begin
  loop
    n := 0;
    for r in select * from public.door_guests(eid, s, null, ai, lim) loop
      n := n + 1; total := total + 1; ids := ids || r.id; s := r.changed_at; ai := r.id;
    end loop;
    pages := pages + 1;
    exit when n < lim;
  end loop;
  return total || '/' || (select count(distinct x) from unnest(ids) x) || '/' || pages;
end $$;

grant execute on function pg_temp.walk_full(text, int), pg_temp.walk_delta(text, timestamptz, int) to public;
select pg_temp.t_eq('2500 guests: no gaps, no duplicates, ordered, 3 pages of 1000', $$select pg_temp.walk_full('tp', 1000)$$, '2500/2500/3/true', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('a page size that divides the total needs one extra empty page', $$select pg_temp.walk_full('tp', 500)$$, '2500/2500/6/true', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('tiny pages work too', $$select pg_temp.walk_full('tp', 7)$$, '2500/2500/358/true', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('the limit is capped at 1000', $$select count(*) from public.door_guests('tp', null, null, null, 5000)$$, '1000', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('default limit is 1000', $$select count(*) from public.door_guests('tp')$$, '1000', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('null limit means 1000', $$select count(*) from public.door_guests('tp', null, null, null, null)$$, '1000', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('limit 0 or negative still returns one row (never an endless empty loop)', $$select count(*) from public.door_guests('tp', null, null, null, 0)$$, '1', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('keyset continues after a given (name, id)', $$select id from public.door_guests('tp', null, 'name 0000', 'WD-00700', 1)$$, 'WD-01400', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('only one door_guests function is callable (no overload ambiguity)', $$select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'door_guests'$$, '1');
select pg_temp.t_fail('stranger cannot page', $$select * from public.door_guests('tp', null, null, null, 10)$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_fail('anon cannot page', $$select * from public.door_guests('tp', null, null, null, 10)$$, 'anon');

-- delta paging: all 2500 rows were created within this transaction, so a 1-hour-old since returns everyone
select pg_temp.t_eq('delta walk: 2500 changed guests, no gaps or duplicates', $$select pg_temp.walk_delta('tp', now() - interval '1 hour', 1000)$$, '2500/2500/3', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('delta walk with tiny pages', $$select pg_temp.walk_delta('tp', now() - interval '1 hour', 13)$$, '2500/2500/193', 'authenticated', pg_temp.uid('D'), true);
-- rows sharing one changed_at are not lost between pages
update public.guests set changed_at = timestamptz '2026-01-01 00:00:00+00' where event_id = 'tp' and id <= 'WD-00040';
select pg_temp.t_eq('40 rows with the SAME changed_at, page size 10: all arrive once', $$select pg_temp.walk_delta('tp', timestamptz '2025-12-31 00:00:00+00', 10)$$, '2500/2500/251', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('delta ordered by changed_at: the old rows come first', $$select id from public.door_guests('tp', timestamptz '2025-12-31', null, null, 1)$$, 'WD-00001', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('delta keyset (same changed_at) continues with the next id', $$select id from public.door_guests('tp', timestamptz '2026-01-01 00:00:00+00', null, 'WD-00002', 1)$$, 'WD-00003', 'authenticated', pg_temp.uid('D'), true);

-- last_change (guests_changed_at) moves on every kind of guest change
insert into public.events (id, owner_uid, name, paid) values ('tl', pg_temp.uid('A'), 'last change', true), ('tm', pg_temp.uid('B'), 'other event', true);
insert into public.event_secrets values ('tl', '222222'), ('tm', '333333');
insert into public.scan_sessions (event_id, uid, pin) values ('tl', pg_temp.uid('D'), '222222');
create temp table lcs (v timestamptz);
grant all on lcs to public;
create function pg_temp.stash() returns void language sql security definer as $$ delete from lcs; insert into lcs select guests_changed_at from public.events where id = 'tl' $$;
create function pg_temp.moved() returns text language sql security definer as $$
  select case when (select guests_changed_at from public.events where id = 'tl') is not distinct from (select v from lcs) then 'same' else 'moved' end $$;
grant execute on function pg_temp.stash(), pg_temp.moved() to public;
select pg_temp.t_eq('a new event already has a last_change (never empty)', $$select (last_change is not null)::text from public.door_event('tl')$$, 'true', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.stash();
insert into public.guests (event_id, id, name) values ('tl', 'L-1', 'one'), ('tl', 'L-2', 'two'), ('tl', 'L-3', 'three');
select pg_temp.t_eq('adding guests moves last_change', $$select pg_temp.moved()$$, 'moved');
select pg_temp.t_eq('door_event returns it', $$select (last_change is not null)::text from public.door_event('tl')$$, 'true', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.stash();
select pg_temp.t_eq('a check-in', $$select outcome from public.check_in('tl','L-1')$$, 'allowed', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('moves last_change', $$select pg_temp.moved()$$, 'moved');
select pg_temp.stash();
select pg_temp.t_eq('a duplicate scan', $$select outcome from public.check_in('tl','L-1')$$, 'duplicate', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('does NOT move last_change', $$select pg_temp.moved()$$, 'same');
select pg_temp.t_eq('a not_found scan', $$select outcome from public.check_in('tl','L-NOPE')$$, 'not_found', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('does NOT move last_change either', $$select pg_temp.moved()$$, 'same');
select pg_temp.t_ok('owner renames a guest', $$select public.set_guest('tl','L-2','two renamed',false)$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('a rename moves last_change', $$select pg_temp.moved()$$, 'moved');
select pg_temp.stash();
select pg_temp.t_ok('owner makes a guest VIP', $$select public.set_guest('tl','L-2','two renamed',true)$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('a VIP change moves last_change', $$select pg_temp.moved()$$, 'moved');
select pg_temp.stash();
select pg_temp.t_ok('owner saves the same values again', $$select public.set_guest('tl','L-2','two renamed',true)$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('a no-op edit does not move last_change', $$select pg_temp.moved()$$, 'same');
select pg_temp.t_ok('owner undoes the check-in', $$select public.set_guest_scanned('tl','L-1',false)$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('an undo moves last_change', $$select pg_temp.moved()$$, 'moved');
select pg_temp.t_eq('and the counter went down with it', $$select scanned_count from public.door_event('tl')$$, '0', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.stash();
select pg_temp.t_ok('owner deletes a guest', $$select public.remove_guest('tl','L-3')$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('a delete moves last_change', $$select pg_temp.moved()$$, 'moved');
select pg_temp.t_eq('and the deleted guest scans as not_found', $$select outcome from public.check_in('tl','L-3')$$, 'not_found', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('and is gone from the full list', $$select count(*) from public.door_guests('tl') where id = 'L-3'$$, '0', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.stash();
insert into public.guests (event_id, id, name) values ('tm', 'M-1', 'other');
update public.guests set scanned = true where event_id = 'tm';
select pg_temp.t_eq('changes in another event do not move this one', $$select pg_temp.moved()$$, 'same');
select pg_temp.t_fail('the owner cannot write the marker by hand', $$update public.events set guests_changed_at = now() where id = 'tl'$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('the old behaviour stays: no double entry', $$select count(*) from (select outcome from public.check_in('tl','L-1') union all select outcome from public.check_in('tl','L-1')) s where outcome = 'allowed'$$, '1', 'authenticated', pg_temp.uid('D'), true);

-- is_admin_me
select pg_temp.t_eq('admin: true', $$select public.is_admin_me()$$, 'true', 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('owner: false', $$select public.is_admin_me()$$, 'false', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('door device: false', $$select public.is_admin_me()$$, 'false', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_fail('anon cannot call it', $$select public.is_admin_me()$$, 'anon');
select * from pg_temp.report();
