-- Chunk 4: add_guests / approve_requests / submit_request / get_request.
-- t1: free (cap 5) with 2 guests (WD-1, WD-2) and one pending request (20 x 'q'); {A} owns t1, {B} owns t2, {D} door device.
-- add_guests: access
select pg_temp.t_fail('anon cannot add guests', $$select * from public.add_guests('t1', '[{"name":"x"}]')$$, 'anon');
select pg_temp.t_fail('a stranger cannot add guests', $$select * from public.add_guests('t1', '[{"name":"x"}]')$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_fail('a door device cannot add guests', $$select * from public.add_guests('t1', '[{"name":"x"}]')$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_fail('unknown event', $$select * from public.add_guests('nope', '[{"name":"x"}]')$$, 'authenticated', pg_temp.uid('A'));
-- add_guests: the cap
select pg_temp.t_eq('owner adds 3 (room for 3)', $$select added || '/' || blocked || '/' || cardinality(ids) from public.add_guests('t1', '[{"name":"a"},{"name":"b"},{"name":"c"}]')$$, '3/false/3', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('guest_count is now 5', $$select guest_count from public.events where id='t1'$$, '5');
select pg_temp.t_eq('ids look like WD-XXXXXXXXXXXX', $$select count(*) from public.guests where event_id='t1' and id ~ '^WD-[0-9A-F]{12}$'$$, '3');
select pg_temp.t_eq('one more (all-or-nothing) is blocked, nothing added', $$select added || '/' || blocked from public.add_guests('t1', '[{"name":"d"}]')$$, '0/true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('partial with no room adds nothing', $$select added || '/' || blocked from public.add_guests('t1', '[{"name":"d"},{"name":"e"}]', true)$$, '0/true', 'authenticated', pg_temp.uid('A'));
delete from public.guests where event_id = 't1' and id in ('WD-1', 'WD-2');
select pg_temp.t_eq('all-or-nothing refuses a batch that does not fit', $$select added || '/' || blocked from public.add_guests('t1', '[{"name":"1"},{"name":"2"},{"name":"3"}]')$$, '0/true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('partial adds what fits, in order', $$select added || '/' || blocked from public.add_guests('t1', '[{"name":"p1"},{"name":"p2"},{"name":"p3"}]', true)$$, '2/true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('the first two were taken, not the last', $$select string_agg(name, ',' order by name) from public.guests where event_id='t1' and name like 'p%'$$, 'p1,p2', 'postgres');
select pg_temp.t_eq('the count is back at 5', $$select guest_count from public.events where id='t1'$$, '5');
-- add_guests: input checks
delete from public.guests where event_id = 't1' and name like 'p%';
select pg_temp.t_ok('names are trimmed (call)', $$select * from public.add_guests('t1', '[{"name":"  سارة  "}]')$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('names are trimmed', $$select count(*) from public.guests where event_id='t1' and name = 'سارة'$$, '1');
select pg_temp.t_ok('vip flag (call)', $$select * from public.add_guests('t1', '[{"name":"vipguest","vip":true}]')$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('vip flag is stored', $$select vip::text from public.guests where event_id='t1' and name = 'vipguest'$$, 'true');
select pg_temp.t_fail('empty name rejects the batch', $$select * from public.add_guests('t1', '[{"name":""}]')$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('blank name rejects the batch', $$select * from public.add_guests('t1', '[{"name":"   "}]')$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('missing name rejects the batch', $$select * from public.add_guests('t1', '[{}]')$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('101-char name rejects the batch', format($$select * from public.add_guests('t1', '[{"name":"%s"}]')$$, repeat('x', 101)), 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('not an array', $$select * from public.add_guests('t1', '{"name":"x"}')$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('null input', $$select * from public.add_guests('t1', null)$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('empty array adds nothing', $$select added || '/' || blocked from public.add_guests('t1', '[]')$$, '0/false', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('batch over 2000 is refused', $$select * from public.add_guests('t2', (select jsonb_agg(jsonb_build_object('name','x')) from generate_series(1,2001)))$$, 'authenticated', pg_temp.uid('B'));
-- paid / limit / admin
select pg_temp.t_eq('paid event without a limit: 500 at once', $$update public.events set paid = true where id='t2'; select 1$$, '1', 'postgres');
select pg_temp.t_eq('500 guests at once on a paid event', $$select added || '/' || blocked from public.add_guests('t2', (select jsonb_agg(jsonb_build_object('name','g'||g)) from generate_series(1,500) g))$$, '500/false', 'authenticated', pg_temp.uid('B'));
update public.events set guest_limit = 502 where id = 't2';
select pg_temp.t_eq('the limit wins: 2 more fit, the 3rd does not (partial)', $$select added || '/' || blocked from public.add_guests('t2', '[{"name":"x"},{"name":"y"},{"name":"z"}]', true)$$, '2/true', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('admin may add past the cap', $$select added || '/' || blocked from public.add_guests('t1', '[{"name":"a1"},{"name":"a2"}]')$$, '2/false', 'authenticated', pg_temp.uid('ADM'));
-- two parallel-ish adds are serialised by the row lock (single transaction here: the second sees the first's count)
-- approve_requests (t1 is over its cap now because of the admin: use a fresh free event t3 with 3 guests and 4 requests)
insert into public.events (id, owner_uid, name) values ('t3', pg_temp.uid('A'), 'event three');
insert into public.guests (event_id, id, name) values ('t3', 'T3-1', 'a'), ('t3', 'T3-2', 'b'), ('t3', 'T3-3', 'c');
insert into public.requests (event_id, id, name, created_at) values
  ('t3', repeat('1', 20), 'r1', now() - interval '4 minutes'), ('t3', repeat('2', 20), 'r2', now() - interval '3 minutes'),
  ('t3', repeat('3', 20), 'r3', now() - interval '2 minutes'), ('t3', repeat('4', 20), 'r4', now() - interval '1 minute');
select pg_temp.t_fail('anon cannot approve', $$select * from public.approve_requests('t3', '[{"req_id":"11111111111111111111"}]')$$, 'anon');
select pg_temp.t_fail('a stranger cannot approve', $$select * from public.approve_requests('t3', '[{"req_id":"11111111111111111111"}]')$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_fail('a door device cannot approve', $$select * from public.approve_requests('t3', '[{"req_id":"11111111111111111111"}]')$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('approve 3 of 4: room for 2 (cap 5, 3 used), oldest first, then blocked',
  $$select cardinality(approved) || '/' || blocked from public.approve_requests('t3', '[{"req_id":"44444444444444444444"},{"req_id":"11111111111111111111"},{"req_id":"22222222222222222222"},{"req_id":"33333333333333333333"}]')$$, '2/true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('the two oldest were approved', $$select string_agg(id, ',' order by created_at) from public.requests where event_id='t3' and status='approved'$$, '11111111111111111111,22222222222222222222');
select pg_temp.t_eq('they became guests with the request id', $$select count(*) from public.guests where event_id='t3' and req_id in ('11111111111111111111','22222222222222222222')$$, '2');
select pg_temp.t_eq('the request points at its guest', $$select count(*) from public.requests q join public.guests g on g.event_id=q.event_id and g.id=q.guest_id where q.event_id='t3' and q.status='approved'$$, '2');
select pg_temp.t_eq('the newer requests stay pending', $$select count(*) from public.requests where event_id='t3' and status='pending'$$, '2');
select pg_temp.t_eq('guest_count is 5', $$select guest_count from public.events where id='t3'$$, '5');
select pg_temp.t_eq('approving again skips the already approved', $$select cardinality(approved) || '/' || blocked from public.approve_requests('t3', '[{"req_id":"11111111111111111111"}]')$$, '0/false', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('unknown request ids are ignored', $$select cardinality(approved) || '/' || blocked from public.approve_requests('t3', '[{"req_id":"99999999999999999999"}]')$$, '0/false', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('a request of another event cannot be approved through this one', $$select cardinality(approved) from public.approve_requests('t2', '[{"req_id":"33333333333333333333"}]')$$, '0', 'authenticated', pg_temp.uid('B'));
update public.events set guest_limit = 8 where id = 't3';
select pg_temp.t_eq('vip from the item wins over the request flag', $$select cardinality(approved) from public.approve_requests('t3', '[{"req_id":"33333333333333333333","vip":true}]')$$, '1', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('the guest is a VIP', $$select vip::text from public.guests where event_id='t3' and req_id='33333333333333333333'$$, 'true');
select pg_temp.t_eq('and so is the request', $$select vip::text from public.requests where event_id='t3' and id='33333333333333333333'$$, 'true');
update public.requests set vip = true where event_id = 't3' and id = repeat('4', 20);
select pg_temp.t_eq('without an item flag the request flag is used', $$select cardinality(approved) from public.approve_requests('t3', '[{"req_id":"44444444444444444444"}]')$$, '1', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('guest got the request VIP flag', $$select vip::text from public.guests where event_id='t3' and req_id='44444444444444444444'$$, 'true');
select pg_temp.t_fail('approve: not an array', $$select * from public.approve_requests('t3', '{}')$$, 'authenticated', pg_temp.uid('A'));
-- submit_request
select pg_temp.t_ok('anon submits a request', $$select public.submit_request('t2', repeat('a', 20), 'ضيف')$$, 'anon');
select pg_temp.t_eq('it is pending', $$select status from public.requests where event_id='t2' and id=repeat('a', 20)$$, 'pending');
select pg_temp.t_ok('resubmitting the same id is harmless', $$select public.submit_request('t2', repeat('a', 20), 'ضيف')$$, 'anon');
select pg_temp.t_eq('and creates no duplicate', $$select count(*) from public.requests where event_id='t2' and id=repeat('a', 20)$$, '1');
select pg_temp.t_ok('a signed-in guest may submit too', $$select public.submit_request('t2', repeat('b', 20), 'x')$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_fail('id too short', $$select public.submit_request('t2', repeat('c', 19), 'x')$$, 'anon');
select pg_temp.t_fail('id with bad characters', $$select public.submit_request('t2', repeat('c', 19) || '!', 'x')$$, 'anon');
select pg_temp.t_fail('id too long', $$select public.submit_request('t2', repeat('c', 129), 'x')$$, 'anon');
select pg_temp.t_fail('empty name', $$select public.submit_request('t2', repeat('c', 20), '')$$, 'anon');
select pg_temp.t_fail('blank name', $$select public.submit_request('t2', repeat('c', 20), '   ')$$, 'anon');
select pg_temp.t_fail('null name', $$select public.submit_request('t2', repeat('c', 20), null)$$, 'anon');
select pg_temp.t_fail('101-char name', format($$select public.submit_request('t2', repeat('c', 20), '%s')$$, repeat('x', 101)), 'anon');
select pg_temp.t_fail('unknown event', $$select public.submit_request('nope', repeat('c', 20), 'x')$$, 'anon');
select pg_temp.t_eq('the name is trimmed', $$select public.submit_request('t2', repeat('d', 20), '  علي  '); select name from public.requests where event_id='t2' and id=repeat('d', 20)$$, 'علي', 'postgres');
-- pending cap = event guest limit, but never below 50 (t1: free, cap 5 -> 50), ceiling 5000
insert into public.requests (event_id, id, name) select 't1', 'fill-' || lpad(g::text, 15, '0'), 'f' from generate_series(1, 48) g;
select pg_temp.t_eq('t1 has 49 pending (1 fixture + 48 fill)', $$select count(*) from public.requests where event_id='t1' and status='pending'$$, '49');
select pg_temp.t_ok('the 50th pending request fits (free event, limit 5, floor 50)', $$select public.submit_request('t1', repeat('e', 20), 'x')$$, 'anon');
select pg_temp.t_fail('the 51st is refused (REQUESTS_FULL)', $$select public.submit_request('t1', repeat('f', 20), 'x')$$, 'anon');
select pg_temp.t_eq('approved requests do not count as pending', $$update public.requests set status='approved' where event_id='t1' and id=repeat('e', 20); select 1$$, '1', 'postgres');
select pg_temp.t_ok('so a new one fits again', $$select public.submit_request('t1', repeat('f', 20), 'x')$$, 'anon');
select pg_temp.t_eq('paid event with a huge limit is still capped at 5000 pending', $$update public.events set paid = true, guest_limit = null where id = 't3'; insert into public.requests (event_id, id, name) select 't3', 'bulk-' || lpad(g::text, 15, '0'), 'b' from generate_series(1, 4999) g; select 1$$, '1', 'postgres');
select pg_temp.t_eq('5000th pending still fits (4999 bulk + 1 pending r)', $$select count(*) from public.requests where event_id='t3' and status='pending'$$, '4999');
select pg_temp.t_ok('5000th', $$select public.submit_request('t3', repeat('j', 20), 'x')$$, 'anon');
select pg_temp.t_fail('5001st is refused', $$select public.submit_request('t3', repeat('k', 20), 'x')$$, 'anon');
-- get_request
select pg_temp.t_eq('guest reads own request by exact id', $$select status from public.get_request('t1', repeat('q', 20))$$, 'pending', 'anon');
select pg_temp.t_eq('returns the name', $$select name from public.get_request('t1', repeat('q', 20))$$, 'req1', 'anon');
select pg_temp.t_eq('wrong id: nothing', $$select count(*) from public.get_request('t1', repeat('z', 20))$$, '0', 'anon');
select pg_temp.t_eq('right id on another event: nothing', $$select count(*) from public.get_request('t2', repeat('q', 20))$$, '0', 'anon');
select pg_temp.t_eq('short id: nothing', $$select count(*) from public.get_request('t1', 'q')$$, '0', 'anon');
select pg_temp.t_eq('approved shows the guest id', $$select guest_id is not null from public.get_request('t3', repeat('1', 20))$$, 'true', 'anon');
select pg_temp.t_eq('approved shows vip', $$select vip::text from public.get_request('t3', repeat('3', 20))$$, 'true', 'anon');
select pg_temp.t_eq('the answer has only 4 columns (no event or owner data)', $$select count(*) from (select * from public.get_request('t1', repeat('q', 20))) s, jsonb_object_keys(to_jsonb(s))$$, '4', 'anon');
-- reviewer follow-ups
insert into public.events (id, owner_uid, name, paid) values ('t4', pg_temp.uid('A'), 'event four', true);
insert into public.requests (event_id, id, name) values ('t4', repeat('x', 20), 'dup');
select pg_temp.t_eq('the same req_id twice in one call approves it once', $$select cardinality(approved) from public.approve_requests('t4', '[{"req_id":"xxxxxxxxxxxxxxxxxxxx"},{"req_id":"xxxxxxxxxxxxxxxxxxxx","vip":true}]')$$, '1', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('and creates exactly one guest', $$select count(*) from public.guests where event_id='t4' and req_id=repeat('x', 20)$$, '1');
select pg_temp.t_fail('a second guest for the same request is refused by the database', $$insert into public.guests (event_id, id, name, req_id) values ('t4', 'WD-DUP', 'x', repeat('x', 20))$$);
select pg_temp.t_fail('vip must be a boolean (add_guests)', $$select * from public.add_guests('t4', '[{"name":"x","vip":"abc"}]')$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('vip must be a boolean (approve)', $$select * from public.approve_requests('t4', '[{"req_id":"xxxxxxxxxxxxxxxxxxxx","vip":"abc"}]')$$, 'authenticated', pg_temp.uid('A'));
insert into public.requests (event_id, id, name) select 't1', 'adm-' || lpad(g::text, 16, '0'), 'a' from generate_series(1, 3) g;
select pg_temp.t_eq('admin approves past the cap', $$select cardinality(approved) || '/' || blocked from public.approve_requests('t1', '[{"req_id":"adm-0000000000000001"},{"req_id":"adm-0000000000000002"}]')$$, '2/false', 'authenticated', pg_temp.uid('ADM'));
select * from pg_temp.report();
