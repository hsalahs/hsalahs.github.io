-- Shared fixtures (rolled back with everything else). {A} owns t1, {B} owns t2, {D} is a door device, {ADM} is an admin.
insert into auth.users (id, email, is_anonymous) values
  (pg_temp.uid('A'), 'a@test.local', false), (pg_temp.uid('B'), 'b@test.local', false),
  (pg_temp.uid('ADM'), 'adm@test.local', false), (pg_temp.uid('D'), null, true);
insert into app_private.admins values (pg_temp.uid('ADM'));
insert into public.events (id, owner_uid, name, paid) values
  ('t1', pg_temp.uid('A'), 'event one', false), ('t2', pg_temp.uid('B'), 'event two', false);
insert into public.event_secrets values ('t1', '123456'), ('t2', '654321');
insert into public.scan_sessions (event_id, uid, pin) values ('t1', pg_temp.uid('D'), '123456');
insert into public.guests (event_id, id, name) values ('t1', 'WD-1', 'g1'), ('t1', 'WD-2', 'g2');
insert into public.requests (event_id, id, name) values ('t1', repeat('q', 20), 'req1');
insert into public.account_limits values (pg_temp.uid('A'), 1, 1), (pg_temp.uid('B'), 1, 1);
insert into public.slugs (slug, event_id, owner_uid) values ('slug-one', 't1', pg_temp.uid('A'));
-- public.users rows for non-anonymous accounts are created by a trigger on auth.users (0008)
