-- 0017: rejected requests are purged 30 days after the event's date, or 90 days after rejection when the date is invalid.
insert into public.events (id, owner_uid, name, paid, date) values
  ('r29', pg_temp.uid('A'), 'r29', true, to_char(current_date - 29, 'YYYY-MM-DD')),
  ('r31', pg_temp.uid('A'), 'r31', true, to_char(current_date - 31, 'YYYY-MM-DD')),
  ('rfu', pg_temp.uid('A'), 'rfu', true, to_char(current_date + 10, 'YYYY-MM-DD')),
  ('rem', pg_temp.uid('A'), 'rem', true, ''),
  ('rso', pg_temp.uid('A'), 'rso', true, 'soon'),
  ('rbd', pg_temp.uid('A'), 'rbd', true, '2026-13-45');
-- all rejected 200 days ago, so only the event date can keep or delete the dated ones
insert into public.requests (event_id, id, name, status, created_at, rejected_at)
  select e, 'rj-' || e || '-' || repeat('a', 16), 'rj', 'rejected', now() - interval '200 days', now() - interval '200 days'
  from unnest(array['r29', 'r31', 'rfu']) e;
-- no valid date: rejected_at decides (89 / 91 days)
insert into public.requests (event_id, id, name, status, created_at, rejected_at) values
  ('rem', 'rj-rem89-' || repeat('a', 16), 'x', 'rejected', now() - interval '200 days', now() - interval '89 days'),
  ('rem', 'rj-rem91-' || repeat('a', 16), 'x', 'rejected', now() - interval '200 days', now() - interval '91 days'),
  ('rso', 'rj-rso89-' || repeat('a', 16), 'x', 'rejected', now() - interval '200 days', now() - interval '89 days'),
  ('rso', 'rj-rso91-' || repeat('a', 16), 'x', 'rejected', now() - interval '200 days', now() - interval '91 days'),
  ('rbd', 'rj-rbd89-' || repeat('a', 16), 'x', 'rejected', now() - interval '200 days', now() - interval '89 days'),
  ('rbd', 'rj-rbd91-' || repeat('a', 16), 'x', 'rejected', now() - interval '200 days', now() - interval '91 days'),
  ('rem', 'rj-nul91-' || repeat('a', 16), 'x', 'rejected', now() - interval '91 days', null),
  ('r31', 'pn-r31-' || repeat('a', 16), 'x', 'pending', now() - interval '300 days', null),
  ('rem', 'pn-rem-' || repeat('a', 16), 'x', 'pending', now() - interval '300 days', null),
  ('rem', 'ap-rem-' || repeat('a', 16), 'x', 'approved', now() - interval '300 days', null),
  ('r31', 'ap-r31-' || repeat('a', 16), 'x', 'approved', now() - interval '300 days', null);
select pg_temp.t_eq('safe_event_date: valid', $$select app_private.safe_event_date('2026-02-28')::text$$, '2026-02-28');
select pg_temp.t_eq('safe_event_date: impossible date is null', $$select coalesce(app_private.safe_event_date('2026-13-45')::text, 'null')$$, 'null');
select pg_temp.t_eq('safe_event_date: text and empty and null are null', $$select coalesce(app_private.safe_event_date('soon')::text, 'n') || coalesce(app_private.safe_event_date('')::text, 'n') || coalesce(app_private.safe_event_date(null)::text, 'n')$$, 'nnn');
select pg_temp.t_ok('weekly cleanup survives malformed dates', $$select app_private.cleanup_anonymous_users()$$);
select pg_temp.t_eq('event date 29 days ago: stays', $$select count(*) from public.requests where id like 'rj-r29-%'$$, '1', 'postgres');
select pg_temp.t_eq('event date 31 days ago: deleted', $$select count(*) from public.requests where id like 'rj-r31-%'$$, '0');
select pg_temp.t_eq('future event date: stays', $$select count(*) from public.requests where id like 'rj-rfu-%'$$, '1');
select pg_temp.t_eq('empty date, rejected 89 days ago: stays', $$select count(*) from public.requests where id like 'rj-rem89-%'$$, '1');
select pg_temp.t_eq('empty date, rejected 91 days ago: deleted', $$select count(*) from public.requests where id like 'rj-rem91-%'$$, '0');
select pg_temp.t_eq('date "soon", 89 days: stays', $$select count(*) from public.requests where id like 'rj-rso89-%'$$, '1');
select pg_temp.t_eq('date "soon", 91 days: deleted', $$select count(*) from public.requests where id like 'rj-rso91-%'$$, '0');
select pg_temp.t_eq('date 2026-13-45, 89 days: stays', $$select count(*) from public.requests where id like 'rj-rbd89-%'$$, '1');
select pg_temp.t_eq('date 2026-13-45, 91 days: deleted', $$select count(*) from public.requests where id like 'rj-rbd91-%'$$, '0');
select pg_temp.t_eq('rejected without rejected_at falls back to created_at', $$select count(*) from public.requests where id like 'rj-nul91-%'$$, '0');
select pg_temp.t_eq('pending and approved are untouched', $$select count(*) from public.requests where id like 'pn-%' or id like 'ap-%'$$, '4');
-- reject_request stamps rejected_at
insert into public.requests (event_id, id, name, status) values ('rem', 'to-reject-' || repeat('a', 16), 'x', 'pending');
select pg_temp.t_eq('a pending request has no rejected_at', $$select (rejected_at is null)::text from public.requests where id like 'to-reject-%'$$, 'true');
select pg_temp.t_eq('reject_request returns true', $$select public.reject_request('rem', 'to-reject-' || repeat('a', 16))::text$$, 'true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('and sets rejected_at to now', $$select (rejected_at > now() - interval '1 minute')::text from public.requests where id like 'to-reject-%'$$, 'true', 'postgres');
select pg_temp.t_eq('a second reject changes nothing (false)', $$select public.reject_request('rem', 'to-reject-' || repeat('a', 16))::text$$, 'false', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('a stranger still cannot reject', $$select public.reject_request('rem', 'x')$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('the audit still sees no public execute on safe_event_date', $$select has_function_privilege('anon', 'app_private.safe_event_date(text)', 'execute')::text$$, 'false');
select * from pg_temp.report();
