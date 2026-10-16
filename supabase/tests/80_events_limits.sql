-- Chunk 5: create_event / delete_event / limits / extra-event requests / signup mirror / admin_delete_user.
-- Fixtures: {A} owns t1 (limit row 1/1), {B} owns t2 (limit 1/1), {ADM} admin, {D} anonymous door device.
-- {E} and {F} are created inside the tests as brand-new customers.
insert into auth.users (id, email, is_anonymous) values (pg_temp.uid('E'), 'e@test.local', false), (pg_temp.uid('F'), 'f@test.local', false);
insert into auth.users (id, email, is_anonymous) values ('00000000-0000-0000-0000-00000000a0a0', null, true);
-- the signup mirror
select pg_temp.t_eq('a new account is mirrored into public.users', $$select count(*) from public.users where uid in ('{E}', '{F}')$$, '2');
select pg_temp.t_eq('an anonymous sign-in is not mirrored', $$select count(*) from public.users where uid = '00000000-0000-0000-0000-00000000a0a0'$$, '0');
select pg_temp.t_eq('the mirror keeps the email', $$select email from public.users where uid = '{E}'$$, 'e@test.local');
-- create_event
select pg_temp.t_fail('anon cannot create events', $$select public.create_event('x','wedding','','','','')$$, 'anon');
select pg_temp.t_fail('a door device (anonymous) cannot create events', $$select public.create_event('x','wedding','','','','')$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('first event of a new customer: returns a 10-char id', $$select char_length(public.create_event('عرسي','wedding','2026-12-01','القاعة','','blue'))$$, '10', 'authenticated', pg_temp.uid('E'));
select pg_temp.t_eq('the limit row was created: 1 of 1', $$select event_limit || '/' || event_count from public.account_limits where uid = '{E}'$$, '1/1');
select pg_temp.t_eq('the event is free, empty and owned', $$select (not paid)::text || '/' || guest_count || '/' || (guest_limit is null)::text || '/' || (owner_uid = '{E}')::text from public.events where owner_uid = '{E}'$$, 'true/0/true/true');
select pg_temp.t_eq('the owner email comes from the token', $$select owner_email from public.events where owner_uid = '{E}'$$, '');
select pg_temp.t_eq('the fields were stored', $$select name || '|' || type || '|' || date || '|' || venue || '|' || theme from public.events where owner_uid = '{E}'$$, 'عرسي|wedding|2026-12-01|القاعة|blue');
select pg_temp.t_fail('second event over the limit: LIMIT_REACHED', $$select public.create_event('another','wedding','','','','')$$, 'authenticated', pg_temp.uid('E'));
select pg_temp.t_eq('a refused creation leaves the count alone', $$select event_count from public.account_limits where uid = '{E}'$$, '1');
select pg_temp.t_fail('empty event name', $$select public.create_event('','wedding','','','','')$$, 'authenticated', pg_temp.uid('F'));
select pg_temp.t_eq('and a failed creation gives the slot back (transaction)', $$select coalesce((select event_count from public.account_limits where uid = '{F}'), 0)$$, '0');
select pg_temp.t_fail('81-char name', format($$select public.create_event(%L,'wedding','','','','')$$, repeat('x', 81)), 'authenticated', pg_temp.uid('F'));
select pg_temp.t_fail('401-char welcome message', format($$select public.create_event('ok','wedding','','','','',%L)$$, repeat('x', 401)), 'authenticated', pg_temp.uid('F'));
select pg_temp.t_eq('admin creates without limits (twice)', $$select (public.create_event('a1','wedding','','','','') is not null)::text || (public.create_event('a2','wedding','','','','') is not null)::text$$, 'truetrue', 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('and has no limit row', $$select count(*) from public.account_limits where uid = '{ADM}'$$, '0');
select pg_temp.t_fail('nobody can insert events directly', $$insert into public.events (id, owner_uid, name) values ('zz', '{E}', 'x')$$, 'authenticated', pg_temp.uid('E'));
-- bump_event_limit (self-service up to 3)
select pg_temp.t_eq('bump 1 -> 2', $$select public.bump_event_limit()$$, '2', 'authenticated', pg_temp.uid('E'));
select pg_temp.t_eq('bump 2 -> 3', $$select public.bump_event_limit()$$, '3', 'authenticated', pg_temp.uid('E'));
select pg_temp.t_fail('bump past 3: CEILING_REACHED', $$select public.bump_event_limit()$$, 'authenticated', pg_temp.uid('E'));
select pg_temp.t_eq('the limit stayed 3 and the count 1', $$select event_limit || '/' || event_count from public.account_limits where uid = '{E}'$$, '3/1');
select pg_temp.t_eq('after a bump a new event fits', $$select (public.create_event('second','wedding','','','','') is not null)::text$$, 'true', 'authenticated', pg_temp.uid('E'));
select pg_temp.t_fail('bump without a limit row', $$select public.bump_event_limit()$$, 'authenticated', pg_temp.uid('F'));
select pg_temp.t_fail('anon cannot bump', $$select public.bump_event_limit()$$, 'anon');
select pg_temp.t_fail('anonymous session cannot bump', $$select public.bump_event_limit()$$, 'authenticated', pg_temp.uid('D'), true);
-- delete_event
select pg_temp.t_fail('a stranger cannot delete an event', $$select public.delete_event('t1')$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_fail('a door device cannot delete an event', $$select public.delete_event('t1')$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_fail('anon cannot delete an event', $$select public.delete_event('t1')$$, 'anon');
select pg_temp.t_fail('unknown event', $$select public.delete_event('nope')$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_ok('owner deletes an event', $$select public.delete_event('t1')$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('everything under it is gone', $$select (select count(*) from public.guests where event_id='t1') + (select count(*) from public.requests where event_id='t1') + (select count(*) from public.scan_sessions where event_id='t1') + (select count(*) from public.event_secrets where event_id='t1') + (select count(*) from public.slugs where event_id='t1')$$, '0');
select pg_temp.t_eq('the slot was given back', $$select event_count from public.account_limits where uid = '{A}'$$, '0');
select pg_temp.t_ok('and a new event can be created again', $$select public.create_event('again','wedding','','','','')$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('admin deleting a customer event gives the slot back to the owner', $$select public.delete_event('t2'); select event_count from public.account_limits where uid = '{B}'$$, '0', 'authenticated', pg_temp.uid('ADM'));
update public.account_limits set event_count = 0 where uid = pg_temp.uid('A');
select pg_temp.t_ok('deleting with the count already 0', $$select public.delete_event((select id from public.events where owner_uid = '{A}' limit 1))$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('the count never goes below 0', $$select event_count from public.account_limits where uid = '{A}'$$, '0');
-- admin: limits and extra-event requests
select pg_temp.t_fail('a customer cannot set limits', $$select public.admin_set_event_limit('{B}', 9)$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_fail('anon cannot set limits', $$select public.admin_set_event_limit('{B}', 9)$$, 'anon');
select pg_temp.t_fail('anonymous session cannot set limits', $$select public.admin_set_event_limit('{B}', 9)$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_ok('admin sets a limit', $$select public.admin_set_event_limit('{B}', 7)$$, 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('limit changed, count kept', $$select event_limit || '/' || event_count from public.account_limits where uid = '{B}'$$, '7/0');
select pg_temp.t_ok('admin creates a limit row for a customer with none', $$select public.admin_set_event_limit('{F}', 4)$$, 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('new row: limit 4, count 0', $$select event_limit || '/' || event_count from public.account_limits where uid = '{F}'$$, '4/0');
select pg_temp.t_fail('negative limit', $$select public.admin_set_event_limit('{F}', -1)$$, 'authenticated', pg_temp.uid('ADM'));
insert into public.event_requests (id, uid, email) values ('00000000-0000-0000-0000-00000000f001', pg_temp.uid('B'), 'b@test.local'), ('00000000-0000-0000-0000-00000000f002', pg_temp.uid('E'), 'e@test.local');
select pg_temp.t_fail('a customer cannot approve a request', $$select public.admin_approve_event_request('00000000-0000-0000-0000-00000000f001')$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_ok('admin approves a request', $$select public.admin_approve_event_request('00000000-0000-0000-0000-00000000f001')$$, 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('limit went up by one (7 -> 8)', $$select event_limit from public.account_limits where uid = '{B}'$$, '8');
select pg_temp.t_eq('the request is approved', $$select status from public.event_requests where id = '00000000-0000-0000-0000-00000000f001'$$, 'approved');
select pg_temp.t_fail('approving twice is refused', $$select public.admin_approve_event_request('00000000-0000-0000-0000-00000000f001')$$, 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('and did not add twice', $$select event_limit from public.account_limits where uid = '{B}'$$, '8');
select pg_temp.t_fail('unknown request', $$select public.admin_approve_event_request('00000000-0000-0000-0000-00000000ffff')$$, 'authenticated', pg_temp.uid('ADM'));
delete from public.account_limits where uid = pg_temp.uid('F');
insert into public.event_requests (id, uid, email) values ('00000000-0000-0000-0000-00000000f003', pg_temp.uid('F'), 'f@test.local');
select pg_temp.t_ok('a customer with no limit row: approval creates limit 2 / count 0', $$select public.admin_approve_event_request('00000000-0000-0000-0000-00000000f003')$$, 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('limit 2, count 0', $$select event_limit || '/' || event_count from public.account_limits where uid = '{F}'$$, '2/0');
-- admin_delete_user
select pg_temp.t_fail('a customer cannot delete users', $$select public.admin_delete_user('{B}')$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('anon cannot delete users', $$select public.admin_delete_user('{B}')$$, 'anon');
select pg_temp.t_fail('an admin cannot be deleted', $$select public.admin_delete_user('{ADM}')$$, 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_ok('admin deletes a customer', $$select public.admin_delete_user('{E}')$$, 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('their events, limits, requests, mirror row and sign-in are gone', $$select (select count(*) from public.events where owner_uid='{E}') + (select count(*) from public.account_limits where uid='{E}') + (select count(*) from public.event_requests where uid='{E}') + (select count(*) from public.users where uid='{E}') + (select count(*) from auth.users where id='{E}')$$, '0');
select pg_temp.t_eq('other accounts are untouched (admin events, limits of B and F)', $$select (select count(*) from public.events where owner_uid = '{ADM}')::text || '/' || (select count(*) from public.account_limits where uid in ('{B}','{F}'))$$, '2/2');
-- reviewer follow-ups
insert into auth.users (id, email, is_anonymous) values ('00000000-0000-0000-0000-00000000aa01', 'g@test.local', false);
select pg_temp.t_ok('create with an email claim', $o$do $x$ begin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000aa01', 'role', 'authenticated', 'is_anonymous', false, 'email', 'g@test.local')::text, true);
  perform public.create_event('mail','wedding','','','',''); end $x$$o$);
select pg_temp.t_eq('email claim stored as owner_email', $$select owner_email from public.events where owner_uid = '00000000-0000-0000-0000-00000000aa01'$$, 'g@test.local');
select pg_temp.t_fail('create_event for a deleted user (token still valid)', $$select public.create_event('ghost','wedding','','','','')$$, 'authenticated', '00000000-0000-0000-0000-00000000dead'::uuid);
select pg_temp.t_fail('bump_event_limit for a deleted user', $$select public.bump_event_limit()$$, 'authenticated', '00000000-0000-0000-0000-00000000dead'::uuid);
select pg_temp.t_fail('admin_delete_user: unknown user', $$select public.admin_delete_user('00000000-0000-0000-0000-00000000dead')$$, 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_fail('51-char event type', format($$select public.create_event('ok',%L,'','','','')$$, repeat('x', 51)), 'authenticated', pg_temp.uid('F'));
select pg_temp.t_fail('51-char theme', format($$select public.create_event('ok','wedding','','','',%L)$$, repeat('x', 51)), 'authenticated', pg_temp.uid('F'));
select * from pg_temp.report();
