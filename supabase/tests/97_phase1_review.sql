-- 0012 follow-ups.
-- create_event creates the door code
insert into auth.users (id, email, is_anonymous) values (pg_temp.uid('E'), 'e@test.local', false);
select pg_temp.t_ok('create an event', $$select public.create_event('with code','wedding','','','','')$$, 'authenticated', pg_temp.uid('E'));
select pg_temp.t_eq('a 6-digit door code exists', $$select count(*) from public.event_secrets k join public.events e on e.id = k.event_id where e.owner_uid = '{E}' and k.scan_pin ~ '^[0-9]{6}$'$$, '1');
select pg_temp.t_eq('the owner can read it', $$select count(*) from public.event_secrets$$, '1', 'authenticated', pg_temp.uid('E'));
select pg_temp.t_eq('the owner own code opens a session', $$select public.start_scan_session((select id from public.events where owner_uid='{E}'), (select scan_pin from public.event_secrets k join public.events e on e.id=k.event_id where e.owner_uid='{E}'))$$, 'ok', 'authenticated', pg_temp.uid('E'));
-- pin shape
select pg_temp.t_fail('pin of 1 digit', $$update public.event_secrets set scan_pin = '1' where event_id = 't1'$$);
select pg_temp.t_fail('pin of 7 digits', $$update public.event_secrets set scan_pin = '1234567' where event_id = 't1'$$);
select pg_temp.t_fail('pin with letters', $$update public.event_secrets set scan_pin = 'abc123' where event_id = 't1'$$);
select pg_temp.t_ok('empty pin is allowed', $$update public.event_secrets set scan_pin = '' where event_id = 't1'$$);
select pg_temp.t_fail('owner cannot store a short pin', $$update public.event_secrets set scan_pin = '12' where event_id = 't1'$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('a stranger cannot insert a code row for another event', $$insert into public.event_secrets values ('t2x','123456')$$, 'authenticated', pg_temp.uid('B'));
-- door_guests order and ties
insert into public.guests (event_id, id, name) values ('t2', 'Z-2', 'same'), ('t2', 'A-1', 'same'), ('t2', 'M-3', 'same');
select pg_temp.t_eq('same names are ordered by id', $$select string_agg(id, ',') from public.door_guests('t2')$$, 'A-1,M-3,Z-2', 'authenticated', pg_temp.uid('B'));
-- pending extra-event requests
insert into public.event_requests (uid, email) values (pg_temp.uid('A'), 'a@test.local');
select pg_temp.t_fail('a second pending extra-event request is refused', $$insert into public.event_requests (uid, email) values ('{A}', 'a@test.local')$$, 'authenticated', pg_temp.uid('A'));
update public.event_requests set status = 'approved' where uid = pg_temp.uid('A');
select pg_temp.t_ok('after approval a new one is fine', $$insert into public.event_requests (uid, email) values ('{A}', 'a@test.local')$$, 'authenticated', pg_temp.uid('A'));
-- email mirror
update auth.users set email = 'new-a@test.local' where id = pg_temp.uid('A');
select pg_temp.t_eq('an email change reaches the users list', $$select email from public.users where uid = '{A}'$$, 'new-a@test.local');
-- delete_event for an admin-owned event does not touch limits
insert into public.account_limits values (pg_temp.uid('ADM'), 5, 3) on conflict (uid) do update set event_count = 3;
insert into public.events (id, owner_uid, name) values ('tadm', pg_temp.uid('ADM'), 'admin event');
select pg_temp.t_ok('admin deletes own event', $$select public.delete_event('tadm')$$, 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('the admin limits row is untouched', $$select event_count from public.account_limits where uid = '{ADM}'$$, '3');
-- owner cannot reassign an event (intentionally dropped, locked in here)
select pg_temp.t_fail('admin cannot change owner_uid through the API', $$update public.events set owner_uid = '{B}' where id = 't1'$$, 'authenticated', pg_temp.uid('ADM'));
-- direct request writes
select pg_temp.t_fail('owner cannot set a request status directly', $$update public.requests set status = 'approved' where event_id = 't1'$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('owner cannot set a request guest_id directly', $$update public.requests set guest_id = 'x' where event_id = 't1'$$, 'authenticated', pg_temp.uid('A'));
select * from pg_temp.report();
