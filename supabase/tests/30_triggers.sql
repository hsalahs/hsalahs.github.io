-- Chunk 2: guest cap, counters, cascade, protected fields (as the table owner, i.e. no RLS in the way).
create function pg_temp.add_guests(eid text, n int, pfx text) returns void language sql as $$
  insert into public.guests (event_id, id, name) select eid, pfx || g, 'g' || g from generate_series(1, n) g;
$$;
-- t1 starts with 2 guests (fixtures); free cap is 5
select pg_temp.t_eq('guest_count follows inserts (fixtures)', $$select guest_count from events where id='t1'$$, '2');
select pg_temp.t_ok('free event: up to 5 guests', $$select pg_temp.add_guests('t1', 3, 'F-')$$);
select pg_temp.t_eq('guest_count is 5', $$select guest_count from events where id='t1'$$, '5');
select pg_temp.t_fail('free event: 6th guest refused', $$insert into guests (event_id, id, name) values ('t1', 'F-6', 'x')$$);
select pg_temp.t_fail('free event: batch over the cap refused whole', $$select pg_temp.add_guests('t1', 2, 'G-')$$);
select pg_temp.t_eq('refused batch left the count alone', $$select guest_count from events where id='t1'$$, '5');
select pg_temp.t_ok('delete a guest', $$delete from guests where event_id='t1' and id='F-1'$$);
select pg_temp.t_eq('guest_count after delete', $$select guest_count from events where id='t1'$$, '4');
select pg_temp.t_ok('a freed slot can be reused', $$insert into guests (event_id, id, name) values ('t1', 'F-9', 'x')$$);
-- paid
update events set paid = true where id = 't2';
select pg_temp.t_ok('paid without a limit: 100 guests', $$select pg_temp.add_guests('t2', 100, 'P-')$$);
update events set guest_limit = 101 where id = 't2';
select pg_temp.t_ok('guest_limit wins: 101st guest ok', $$insert into guests (event_id, id, name) values ('t2', 'P-101', 'x')$$);
select pg_temp.t_fail('guest_limit wins: 102nd refused', $$insert into guests (event_id, id, name) values ('t2', 'P-102', 'x')$$);
update events set guest_limit = 1 where id = 't2';
select pg_temp.t_fail('limit below the current count blocks new guests', $$insert into guests (event_id, id, name) values ('t2', 'P-103', 'x')$$);
select pg_temp.t_ok('removing guests still works over the limit', $$delete from guests where event_id='t2' and id='P-101'$$);
-- admin bypass
select pg_temp.t_ok('admin may exceed the cap', $o$do $x$ begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid('ADM'), 'is_anonymous', false)::text, true);
  insert into guests (event_id, id, name) values ('t2', 'ADM-1', 'x'); end $x$$o$);
select pg_temp.t_fail('an anonymous token with the admin uid is not admin', $o$do $x$ begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid('ADM'), 'is_anonymous', true)::text, true);
  insert into guests (event_id, id, name) values ('t2', 'ADM-2', 'x'); end $x$$o$);
select pg_temp.t_fail('guest for a missing event', $$insert into guests (event_id, id, name) values ('nope', 'X', 'x')$$);
-- scanned_count
select pg_temp.t_eq('scanned_count starts at 0', $$select scanned_count from events where id='t1'$$, '0');
select pg_temp.t_ok('check a guest in', $$update guests set scanned = true where event_id='t1' and id='WD-1'$$);
select pg_temp.t_eq('scanned_count is 1', $$select scanned_count from events where id='t1'$$, '1');
select pg_temp.t_eq('scanned_at is set by the server', $$select (scanned_at is not null)::text from guests where event_id='t1' and id='WD-1'$$, 'true');
select pg_temp.t_eq('changed_at moved forward', $$select (changed_at >= registered_at)::text from guests where event_id='t1' and id='WD-1'$$, 'true');
select pg_temp.t_ok('a second check-in update does not double count', $$update guests set scanned = true where event_id='t1' and id='WD-1'$$);
select pg_temp.t_eq('scanned_count still 1', $$select scanned_count from events where id='t1'$$, '1');
delete from guests where event_id='t1' and id='F-9';
select pg_temp.t_ok('check a guest in at insert time counts too', $$insert into guests (event_id, id, name, scanned) values ('t1', 'S-1', 'x', true)$$);
select pg_temp.t_eq('scanned_count is 2', $$select scanned_count from events where id='t1'$$, '2');
select pg_temp.t_ok('owner undoes a check-in', $$update guests set scanned = false where event_id='t1' and id='WD-1'$$);
select pg_temp.t_eq('scanned_count is 1 again', $$select scanned_count from events where id='t1'$$, '1');
select pg_temp.t_eq('scanned_at cleared by the undo', $$select (scanned_at is null)::text from guests where event_id='t1' and id='WD-1'$$, 'true');
select pg_temp.t_ok('deleting a scanned guest', $$delete from guests where event_id='t1' and id='S-1'$$);
select pg_temp.t_eq('scanned_count dropped with the guest', $$select scanned_count from events where id='t1'$$, '0');
select pg_temp.t_fail('guest key cannot change', $$update guests set id = 'WD-NEW' where event_id='t1' and id='WD-2'$$);
-- cascade with scanned guests must not trip the counter triggers
update guests set scanned = true where event_id = 't1';
select pg_temp.t_ok('deleting an event with scanned guests', $$delete from events where id='t1'$$);
select pg_temp.t_eq('cascade removed the guests', $$select count(*) from guests where event_id='t1'$$, '0');
select pg_temp.t_eq('cascade removed sessions, secrets and slug', $$select (select count(*) from scan_sessions where event_id='t1') + (select count(*) from event_secrets where event_id='t1') + (select count(*) from slugs where event_id='t1')$$, '0');
select * from pg_temp.report();
