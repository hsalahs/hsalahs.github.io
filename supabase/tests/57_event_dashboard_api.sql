-- 0015: event_live, owner_guests, owner_requests, reject_request, regenerate_door_code, remove_guests, admin_deactivate_event.
-- event_live: access
select pg_temp.t_eq('owner reads the live row', $$select guest_count || '/' || scanned_count || '/' || pending_count || '/' || paid || '/' || coalesce(guest_limit::text, '-') from public.event_live('t1')$$, '2/0/1/false/-', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('admin reads it too', $$select count(*) from public.event_live('t1')$$, '1', 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_fail('another owner is refused', $$select * from public.event_live('t1')$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_fail('a door device (session) is refused', $$select * from public.event_live('t1')$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_fail('anon is refused', $$select * from public.event_live('t1')$$, 'anon');
select pg_temp.t_eq('a gone event gives zero rows (owner)', $$select count(*) from public.event_live('gone-event')$$, '0', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('a gone event gives zero rows (admin)', $$select count(*) from public.event_live('gone-event')$$, '0', 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('last_change is never empty', $$select (last_change is not null)::text from public.event_live('t1')$$, 'true', 'authenticated', pg_temp.uid('A'));

-- event_live: last_change moves with a guest change
update public.events set guests_changed_at = now() - interval '1 hour' where id = 't1';
select pg_temp.t_eq('old marker before the change', $$select (last_change > now() - interval '1 minute')::text from public.event_live('t1')$$, 'false', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('a check-in', $$select outcome from public.check_in('t1', 'WD-1')$$, 'allowed', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('moves last_change and the counter', $$select (last_change > now() - interval '1 minute')::text || '/' || scanned_count from public.event_live('t1')$$, 'true/1', 'authenticated', pg_temp.uid('A'));

-- event_live: pending_count / newest_pending
update public.requests set created_at = now() - interval '1 day' where event_id = 't1' and id = repeat('q', 20);
select pg_temp.t_eq('newest_pending is the only pending request', $$select (newest_pending < now() - interval '1 hour')::text from public.event_live('t1')$$, 'true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_ok('a guest registers', $$select public.submit_request('t1', repeat('r', 20), 'second guest')$$, 'anon');
select pg_temp.t_eq('pending 2 and newest_pending moved', $$select pending_count || '/' || (newest_pending >= now())::text from public.event_live('t1')$$, '2/true', 'authenticated', pg_temp.uid('A'));

-- owner_requests
select pg_temp.t_eq('owner lists pending, oldest first', $$select string_agg(name, ',' order by created_at, id) from public.owner_requests('t1')$$, 'req1,second guest', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('keyset continues after the first', $$select name from public.owner_requests('t1', (select created_at from public.requests where id = repeat('q', 20)), repeat('q', 20), 10)$$, 'second guest', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('admin lists too', $$select count(*) from public.owner_requests('t1')$$, '2', 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_fail('another owner is refused', $$select * from public.owner_requests('t1')$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_fail('door device is refused', $$select * from public.owner_requests('t1')$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_fail('anon is refused', $$select * from public.owner_requests('t1')$$, 'anon');

-- reject_request
select pg_temp.t_fail('another owner cannot reject', $$select public.reject_request('t1', repeat('q', 20))$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_fail('door device cannot reject', $$select public.reject_request('t1', repeat('q', 20))$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_fail('anon cannot reject', $$select public.reject_request('t1', repeat('q', 20))$$, 'anon');
select pg_temp.t_eq('owner rejects', $$select public.reject_request('t1', repeat('q', 20))::text$$, 'true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('rejecting again is false', $$select public.reject_request('t1', repeat('q', 20))::text$$, 'false', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('unknown request is false', $$select public.reject_request('t1', 'no-such-request-id-xxxx')::text$$, 'false', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('the guest page still reads it as rejected', $$select status from public.get_request('t1', repeat('q', 20))$$, 'rejected', 'anon');
select pg_temp.t_eq('pending_count dropped', $$select pending_count from public.event_live('t1')$$, '1', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('the list shows only the pending one', $$select string_agg(name, ',') from public.owner_requests('t1')$$, 'second guest', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('approve_requests skips a rejected request', $$select cardinality(approved) from public.approve_requests('t1', jsonb_build_array(jsonb_build_object('req_id', repeat('q', 20))))$$, '0', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('and creates no guest for it', $$select count(*) from public.guests where event_id = 't1' and req_id = repeat('q', 20)$$, '0');
select pg_temp.t_eq('and the request stays rejected', $$select status from public.requests where event_id = 't1' and id = repeat('q', 20)$$, 'rejected');
select pg_temp.t_eq('approving the pending one still works', $$select cardinality(approved) from public.approve_requests('t1', jsonb_build_array(jsonb_build_object('req_id', repeat('r', 20))))$$, '1', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('now nothing waits', $$select pending_count || '/' || coalesce(newest_pending::text, '-') from public.event_live('t1')$$, '0/-', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('an approved request cannot be rejected', $$select public.reject_request('t1', repeat('r', 20))::text$$, 'false', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('admin can reject', $$select public.reject_request('t2', 'x')::text$$, 'false', 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_fail('the status check still refuses other values', $$update public.requests set status = 'bogus' where event_id = 't1'$$);
-- a rejected request does not count toward the pending cap (free event: cap 50)
insert into public.requests (event_id, id, name) select 't1', 'cap-pending-' || lpad(g::text, 10, '0'), 'p' from generate_series(1, 49) g;
select pg_temp.t_ok('49 pending + 1 rejected: another registration is accepted', $$select public.submit_request('t1', repeat('s', 20), 'fiftieth')$$, 'anon');
select pg_temp.t_fail('50 pending: the next one is REQUESTS_FULL', $$select public.submit_request('t1', repeat('u', 20), 'fifty first')$$, 'anon');
delete from public.requests where event_id = 't1' and id like 'cap-pending-%';

-- remove_guests
insert into public.guests (event_id, id, name, scanned) select 't2', 'R-' || g, 'r' || g, g <= 2 from generate_series(1, 5) g;
update public.events set paid = true where id = 't2';
select pg_temp.t_eq('counters before', $$select guest_count || '/' || scanned_count from public.event_live('t2')$$, '5/2', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_fail('another owner cannot remove', $$select public.remove_guests('t2', array['R-1'])$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('door device cannot remove', $$select public.remove_guests('t1', array['WD-1'])$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_fail('anon cannot remove', $$select public.remove_guests('t2', array['R-1'])$$, 'anon');
select pg_temp.t_fail('more than 200 ids is BATCH_TOO_LARGE', $$select public.remove_guests('t2', (select array_agg('x' || g) from generate_series(1, 201) g))$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('exactly 200 ids is fine (none match)', $$select public.remove_guests('t2', (select array_agg('x' || g) from generate_series(1, 200) g))$$, '0', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('removes the matching ones only', $$select public.remove_guests('t2', array['R-1', 'R-3', 'R-NOPE'])$$, '2', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('counters follow (one scanned, one not removed)', $$select guest_count || '/' || scanned_count from public.event_live('t2')$$, '3/1', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('an empty list removes nothing', $$select public.remove_guests('t2', '{}')$$, '0', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_fail('a null list is refused', $$select public.remove_guests('t2', null)$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('admin can remove', $$select public.remove_guests('t2', array['R-4'])$$, '1', 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('ids of another event are never touched', $$select public.remove_guests('t2', array['WD-1', 'WD-2'])$$, '0', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('t1 guests intact', $$select count(*) from public.guests where event_id = 't1'$$, '3');

-- regenerate_door_code
select pg_temp.t_fail('another owner cannot regenerate', $$select public.regenerate_door_code('t1')$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_fail('door device cannot regenerate', $$select public.regenerate_door_code('t1')$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_fail('anon cannot regenerate', $$select public.regenerate_door_code('t1')$$, 'anon');
select pg_temp.t_eq('the door session works before', $$select public.scan_session_valid('t1')::text$$, 'true', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('owner gets a 6-digit code', $$select (public.regenerate_door_code('t1') ~ '^[0-9]{6}$')::text$$, 'true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('it is the stored code', $$select (scan_pin ~ '^[0-9]{6}$' and scan_pin <> '123456')::text from public.event_secrets where event_id = 't1'$$, 'true');
select pg_temp.t_eq('every door session is revoked', $$select public.scan_session_valid('t1')::text$$, 'false', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('and cannot read the names', $$select (select count(*) from public.door_guests('t1')) $$, 'ERROR: NO_SESSION', 'authenticated', pg_temp.uid('D'), true);
-- leading zeros: a code below 100000 keeps its zeros (draw until one appears: 10% each, so 60 draws are plenty)
create function pg_temp.zero_led() returns boolean language plpgsql as $$
declare c text;
begin
  for i in 1..200 loop
    c := public.regenerate_door_code('t1');
    if left(c, 1) = '0' then return length(c) = 6; end if;
  end loop;
  return false;
end $$;
grant execute on function pg_temp.zero_led() to public;
select pg_temp.t_eq('codes with leading zeros keep 6 characters', $$select pg_temp.zero_led()::text$$, 'true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('admin can regenerate', $$select (public.regenerate_door_code('t2') ~ '^[0-9]{6}$')::text$$, 'true', 'authenticated', pg_temp.uid('ADM'));
delete from public.event_secrets where event_id = 't2';
select pg_temp.t_eq('a missing secret row is created', $$select (public.regenerate_door_code('t2') ~ '^[0-9]{6}$')::text$$, 'true', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('and stored', $$select count(*) from public.event_secrets where event_id = 't2'$$, '1');
select pg_temp.t_fail('unknown event', $$select public.regenerate_door_code('gone-event')$$, 'authenticated', pg_temp.uid('ADM'));

-- admin_deactivate_event
select pg_temp.t_ok('admin activates', $$select public.admin_activate_event('t1', 300)$$, 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('active', $$select paid || '/' || guest_limit from public.event_live('t1')$$, 'true/300', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('owner cannot deactivate', $$select public.admin_deactivate_event('t1')$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('door device cannot deactivate', $$select public.admin_deactivate_event('t1')$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_fail('anon cannot deactivate', $$select public.admin_deactivate_event('t1')$$, 'anon');
select pg_temp.t_ok('admin deactivates', $$select public.admin_deactivate_event('t1')$$, 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('back to free', $$select paid || '/' || coalesce(guest_limit::text, '-') from public.event_live('t1')$$, 'false/-', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('unknown event', $$select public.admin_deactivate_event('gone-event')$$, 'authenticated', pg_temp.uid('ADM'));

-- paging above 1000 (owner_guests, owner_requests) with ties
insert into public.events (id, owner_uid, name, paid) values ('tp', pg_temp.uid('A'), 'big', true);
insert into public.guests (event_id, id, name, registered_at)
  select 'tp', 'WD-' || lpad(i::text, 5, '0'), 'name ' || lpad((i % 700)::text, 4, '0'), timestamptz '2026-01-01 00:00:00+00' from generate_series(1, 2500) i;
insert into public.requests (event_id, id, name, created_at)
  select 'tp', 'rq-' || lpad(i::text, 20, '0'), 'req ' || i,
         case when i <= 40 then timestamptz '2026-01-01 00:00:00+00' else timestamptz '2026-01-02 00:00:00+00' + (i || ' seconds')::interval end
  from generate_series(1, 2300) i;
create function pg_temp.walk_full(eid text, lim int) returns text language plpgsql as $$
declare an text := null; ai text := null; n int; total int := 0; pages int := 0; ids text[] := '{}'; r record; ordered boolean := true; pn text := null; pi text := null;
begin
  loop
    n := 0;
    for r in select * from public.owner_guests(eid, null, an, ai, lim) loop
      n := n + 1; total := total + 1; ids := ids || r.id;
      if pn is not null and (r.name, r.id) <= (pn, pi) then ordered := false; end if;
      pn := r.name; pi := r.id; an := r.name; ai := r.id;
    end loop;
    pages := pages + 1;
    exit when n < lim;
  end loop;
  return total || '/' || (select count(distinct x) from unnest(ids) x) || '/' || pages || '/' || ordered;
end $$;
create function pg_temp.walk_delta(eid text, since timestamptz, lim int) returns text language plpgsql as $$
declare s timestamptz := since; ai text := null; n int; total int := 0; pages int := 0; ids text[] := '{}'; r record;
begin
  loop
    n := 0;
    for r in select * from public.owner_guests(eid, s, null, ai, lim) loop
      n := n + 1; total := total + 1; ids := ids || r.id; s := r.changed_at; ai := r.id;
    end loop;
    pages := pages + 1;
    exit when n < lim;
  end loop;
  return total || '/' || (select count(distinct x) from unnest(ids) x) || '/' || pages;
end $$;
create function pg_temp.walk_reqs(eid text, lim int) returns text language plpgsql as $$
declare ac timestamptz := null; ai text := null; n int; total int := 0; pages int := 0; ids text[] := '{}'; r record; ordered boolean := true; pc timestamptz := null; pi text := null;
begin
  loop
    n := 0;
    for r in select * from public.owner_requests(eid, ac, ai, lim) loop
      n := n + 1; total := total + 1; ids := ids || r.id;
      if pc is not null and (r.created_at, r.id) <= (pc, pi) then ordered := false; end if;
      pc := r.created_at; pi := r.id; ac := r.created_at; ai := r.id;
    end loop;
    pages := pages + 1;
    exit when n < lim;
  end loop;
  return total || '/' || (select count(distinct x) from unnest(ids) x) || '/' || pages || '/' || ordered;
end $$;
grant execute on function pg_temp.walk_full(text, int), pg_temp.walk_delta(text, timestamptz, int), pg_temp.walk_reqs(text, int) to public;
select pg_temp.t_eq('2500 guests: no gaps, no duplicates, ordered, 3 pages', $$select pg_temp.walk_full('tp', 1000)$$, '2500/2500/3/true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('tiny pages work too', $$select pg_temp.walk_full('tp', 7)$$, '2500/2500/358/true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('admin walks them as well', $$select pg_temp.walk_full('tp', 1000)$$, '2500/2500/3/true', 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('limit capped at 1000', $$select count(*) from public.owner_guests('tp', null, null, null, 5000)$$, '1000', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('default limit 1000', $$select count(*) from public.owner_guests('tp')$$, '1000', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('limit 0 still returns one row', $$select count(*) from public.owner_guests('tp', null, null, null, 0)$$, '1', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('registered_at is returned', $$select (registered_at = timestamptz '2026-01-01 00:00:00+00')::text from public.owner_guests('tp', null, null, null, 1)$$, 'true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('delta walk: all 2500', $$select pg_temp.walk_delta('tp', now() - interval '1 hour', 1000)$$, '2500/2500/3', 'authenticated', pg_temp.uid('A'));
update public.guests set changed_at = timestamptz '2026-01-01 00:00:00+00' where event_id = 'tp' and id <= 'WD-00040';
select pg_temp.t_eq('40 rows with the SAME changed_at, page size 10: all arrive once', $$select pg_temp.walk_delta('tp', timestamptz '2025-12-31 00:00:00+00', 10)$$, '2500/2500/251', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('delta keyset (same changed_at) continues with the next id', $$select id from public.owner_guests('tp', timestamptz '2026-01-01 00:00:00+00', null, 'WD-00002', 1)$$, 'WD-00003', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('another owner cannot page', $$select * from public.owner_guests('tp', null, null, null, 10)$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_fail('door device cannot page', $$select * from public.owner_guests('t1', null, null, null, 10)$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_fail('anon cannot page', $$select * from public.owner_guests('tp', null, null, null, 10)$$, 'anon');
select pg_temp.t_eq('2300 pending requests: no gaps, no duplicates, oldest first, 3 pages', $$select pg_temp.walk_reqs('tp', 1000)$$, '2300/2300/3/true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('tiny pages (the 40 tied rows straddle page ends)', $$select pg_temp.walk_reqs('tp', 7)$$, '2300/2300/329/true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('requests limit capped at 1000', $$select count(*) from public.owner_requests('tp', null, null, 5000)$$, '1000', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('event_live counts them', $$select pending_count from public.event_live('tp')$$, '2300', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('no overloads (one function each)', $$select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('owner_guests', 'owner_requests', 'event_live', 'reject_request', 'regenerate_door_code', 'remove_guests', 'admin_deactivate_event')$$, '7');
-- guest ids are free text keys: the old Firebase-era format (WD- + 13 base36) and the new one (WD- + 12 hex) both check in
insert into public.events (id, owner_uid, name, paid) values ('tf', pg_temp.uid('A'), 'formats', true);
insert into public.event_secrets values ('tf', '555555');
insert into public.scan_sessions (event_id, uid, pin) values ('tf', pg_temp.uid('D'), '555555');
insert into public.guests (event_id, id, name) values ('tf', 'WD-K3J9ZQ0X8M2PA', 'old format'), ('tf', 'WD-9F3A0C7D1E5B', 'new format');
select pg_temp.t_eq('old format (13 base36) checks in', $$select outcome from public.check_in('tf', 'WD-K3J9ZQ0X8M2PA')$$, 'allowed', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('old format again is a duplicate', $$select outcome from public.check_in('tf', 'WD-K3J9ZQ0X8M2PA')$$, 'duplicate', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('new format (12 hex) checks in', $$select outcome from public.check_in('tf', 'WD-9F3A0C7D1E5B')$$, 'allowed', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('the counter counted both', $$select scanned_count from public.event_live('tf')$$, '2', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('add_guests makes the new format', $$select (ids[1] ~ '^WD-[0-9A-F]{12}$')::text from public.add_guests('tf', '[{"name":"x"}]')$$, 'true', 'authenticated', pg_temp.uid('A'));
select * from pg_temp.report();
