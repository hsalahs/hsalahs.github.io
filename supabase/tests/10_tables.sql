-- Chunk 1: constraints on the core tables (run as the table owner).
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@test.local');
insert into events (id, owner_uid, name) values ('t1', '00000000-0000-0000-0000-0000000000a1', 'عرس');
select pg_temp.t_fail('event id with a slash', $$insert into events (id, owner_uid, name) values ('a/b', '00000000-0000-0000-0000-0000000000a1', 'x')$$);
select pg_temp.t_fail('empty event name', $$insert into events (id, owner_uid, name) values ('t2', '00000000-0000-0000-0000-0000000000a1', '')$$);
select pg_temp.t_fail('81-char event name', format($$insert into events (id, owner_uid, name) values ('t2', '00000000-0000-0000-0000-0000000000a1', %L)$$, repeat('x', 81)));
select pg_temp.t_ok('80-char event name', format($$insert into events (id, owner_uid, name) values ('t2', '00000000-0000-0000-0000-0000000000a1', %L)$$, repeat('x', 80)));
select pg_temp.t_ok('400-char welcome message', format($$update events set welcome_message = %L where id = 't1'$$, repeat('x', 400)));
select pg_temp.t_fail('401-char welcome message', format($$update events set welcome_message = %L where id = 't1'$$, repeat('x', 401)));
select pg_temp.t_fail('101-char venue', format($$update events set venue = %L where id = 't1'$$, repeat('x', 101)));
select pg_temp.t_fail('301-char maps link', format($$update events set maps_link = %L where id = 't1'$$, repeat('x', 301)));
select pg_temp.t_fail('negative guest count', $$update events set guest_count = -1 where id = 't1'$$);
select pg_temp.t_fail('negative guest limit', $$update events set guest_limit = -1 where id = 't1'$$);
select pg_temp.t_ok('guest inserts', $$insert into guests (event_id, id, name) values ('t1', 'WD-AAA', 'أحمد')$$);
select pg_temp.t_fail('empty guest name', $$insert into guests (event_id, id, name) values ('t1', 'WD-B', '')$$);
select pg_temp.t_fail('101-char guest name', format($$insert into guests (event_id, id, name) values ('t1', 'WD-B', %L)$$, repeat('x', 101)));
select pg_temp.t_fail('guest for a missing event', $$insert into guests (event_id, id, name) values ('nope', 'WD-C', 'x')$$);
select pg_temp.t_ok('request inserts (20-char id)', $$insert into requests (event_id, id, name) values ('t1', repeat('r', 20), 'سارة')$$);
select pg_temp.t_fail('request id under 20 chars', $$insert into requests (event_id, id, name) values ('t1', repeat('r', 19), 'سارة')$$);
select pg_temp.t_fail('request status other than pending/approved', $$insert into requests (event_id, id, name, status) values ('t1', repeat('s', 20), 'x', 'done')$$);
select pg_temp.t_fail('101-char request name', format($$insert into requests (event_id, id, name) values ('t1', repeat('s', 20), %L)$$, repeat('x', 101)));
select pg_temp.t_ok('valid slug', $$insert into slugs (slug, event_id, owner_uid) values ('my-wedding', 't1', '00000000-0000-0000-0000-0000000000a1')$$);
select pg_temp.t_fail('slug with capitals', $$insert into slugs (slug, event_id, owner_uid) values ('MyWedding', 't1', '00000000-0000-0000-0000-0000000000a1')$$);
select pg_temp.t_fail('slug too short', $$insert into slugs (slug, event_id, owner_uid) values ('ab', 't1', '00000000-0000-0000-0000-0000000000a1')$$);
select pg_temp.t_fail('slug starting with a dash', $$insert into slugs (slug, event_id, owner_uid) values ('-abc', 't1', '00000000-0000-0000-0000-0000000000a1')$$);
select pg_temp.t_fail('slug 41 chars', $$insert into slugs (slug, event_id, owner_uid) values (repeat('a', 41), 't1', '00000000-0000-0000-0000-0000000000a1')$$);
select pg_temp.t_fail('slug taken twice', $$insert into slugs (slug, event_id, owner_uid) values ('my-wedding', 't1', '00000000-0000-0000-0000-0000000000a1'), ('my-wedding', 't2', '00000000-0000-0000-0000-0000000000a1')$$);
select pg_temp.t_fail('two slugs for one event', $$insert into slugs (slug, event_id, owner_uid) values ('first-one', 't1', '00000000-0000-0000-0000-0000000000a1'), ('second-one', 't1', '00000000-0000-0000-0000-0000000000a1')$$);
select pg_temp.t_fail('reserved slug: ' || w, format($$insert into slugs (slug, event_id, owner_uid) values (%L, 't1', '00000000-0000-0000-0000-0000000000a1')$$, w))
  from unnest(array['index','app','event','invite','scan','guide','icons','tests','sitemap','robots','manifest','sw','utils','format','admin','login','www','api','404','privacy']) as w
  where char_length(w) >= 3;
delete from events where id = 't1';
select pg_temp.t_eq('cascade: deleting the event removes its guests, requests and slug',
  $$select (select count(*) from guests where event_id = 't1') + (select count(*) from requests where event_id = 't1') + (select count(*) from slugs where event_id = 't1')$$, '0');
select pg_temp.t_ok('account_limits row', $$insert into account_limits (uid, event_limit, event_count) values ('00000000-0000-0000-0000-0000000000a1', 1, 1)$$);
select pg_temp.t_fail('negative event_count', $$update account_limits set event_count = -1$$);
select pg_temp.t_fail('event_request bad status', $$insert into event_requests (uid, status) values ('00000000-0000-0000-0000-0000000000a1', 'maybe')$$);
select pg_temp.t_eq('all 11 core tables exist', $$select count(*) from information_schema.tables where (table_schema = 'public' and table_name in ('events','event_secrets','scan_sessions','scan_attempts','guests','requests','account_limits','event_requests','users','slugs')) or (table_schema = 'app_private' and table_name = 'admins')$$, '11');
select * from pg_temp.report();
