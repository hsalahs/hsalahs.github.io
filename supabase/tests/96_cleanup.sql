-- 0011: the anonymous-user cleanup (the cron job itself is not testable inside a transaction).
insert into auth.users (id, email, is_anonymous, created_at, last_sign_in_at) values
  ('00000000-0000-0000-0000-0000000000c1', null, true, now() - interval '40 days', now() - interval '35 days'),
  ('00000000-0000-0000-0000-0000000000c2', null, true, now() - interval '40 days', now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000000c3', 'old@test.local', false, now() - interval '400 days', now() - interval '300 days');
insert into public.scan_sessions (event_id, uid, pin) values ('t1', '00000000-0000-0000-0000-0000000000c1', '123456');
select pg_temp.t_eq('cleanup removes only the stale anonymous account', $$select app_private.cleanup_anonymous_users()$$, '1');
select pg_temp.t_eq('the recently seen anonymous account stays', $$select count(*) from auth.users where id = '00000000-0000-0000-0000-0000000000c2'$$, '1');
select pg_temp.t_eq('a real (non-anonymous) account is never removed', $$select count(*) from auth.users where id = '00000000-0000-0000-0000-0000000000c3'$$, '1');
select pg_temp.t_eq('the removed device session is gone', $$select count(*) from public.scan_sessions where uid = '00000000-0000-0000-0000-0000000000c1'$$, '0');
select pg_temp.t_eq('the fixture door device session is untouched', $$select count(*) from public.scan_sessions where uid = '{D}'$$, '1');
select pg_temp.t_fail('anon cannot run the cleanup', $$select app_private.cleanup_anonymous_users()$$, 'anon');
select pg_temp.t_fail('authenticated cannot run the cleanup', $$select app_private.cleanup_anonymous_users()$$, 'authenticated', pg_temp.uid('A'));
select * from pg_temp.report();
