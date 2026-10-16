-- Event-wide budget of wrong door codes: 60 per hour / 300 per day across ALL devices.
-- {B} is a stranger (no session on t1), {D} holds a session on t1, {A} owns t1.
insert into public.scan_attempts (event_id, uid, failed_at)
  select 't1', gen_random_uuid(), now() - (g || ' seconds')::interval from generate_series(1, 59) g;
select pg_temp.t_eq('59 failures in the hour: a stranger can still get in', $$select public.start_scan_session('t1','123456')$$, 'ok', 'authenticated', pg_temp.uid('B'));
delete from public.scan_sessions where uid = pg_temp.uid('B');
insert into public.scan_attempts (event_id, uid) values ('t1', gen_random_uuid());
select pg_temp.t_eq('60th failure: door_alert says locked', $$select door_locked::text from public.door_alert('t1')$$, 'true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('budget spent: a stranger is locked even with the right code', $$select public.start_scan_session('t1','123456')$$, 'locked', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('a brand-new anonymous account is locked too', $$select public.start_scan_session('t1','123456')$$, 'locked', 'authenticated', gen_random_uuid(), true);
select pg_temp.t_eq('locked answers are not recorded as attempts', $$select count(*) from public.scan_attempts where event_id='t1'$$, '60');
select pg_temp.t_eq('a device that already has a session is not affected', $$select public.start_scan_session('t1','123456')$$, 'ok', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('and its check-in still works', $$select outcome from public.check_in('t1','WD-1')$$, 'allowed', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('the owner is never locked out', $$select public.start_scan_session('t1','123456')$$, 'ok', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('the admin is never locked out', $$select public.start_scan_session('t1','123456')$$, 'ok', 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('other events are unaffected', $$select public.start_scan_session('t2','654321')$$, 'ok', 'authenticated', pg_temp.uid('B'));
-- reopen
select pg_temp.t_fail('a stranger cannot reset', $$select public.reset_door_attempts('t1')$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_fail('a door device cannot reset', $$select public.reset_door_attempts('t1')$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_fail('anon cannot reset', $$select public.reset_door_attempts('t1')$$, 'anon');
select pg_temp.t_fail('a stranger cannot read the alert', $$select * from public.door_alert('t1')$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_fail('a door device cannot read the alert', $$select * from public.door_alert('t1')$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('owner reopens the door', $$select public.reset_door_attempts('t1')$$, '60', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('the door code did not change', $$select scan_pin from public.event_secrets where event_id='t1'$$, '123456');
select pg_temp.t_eq('the existing session survived the reopening', $$select public.scan_session_valid('t1')$$, 'true', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('a stranger can now sign in', $$select public.start_scan_session('t1','123456')$$, 'ok', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('alert is clear after the reset', $$select failed_last_hour || '/' || failed_last_day || '/' || door_locked from public.door_alert('t1')$$, '0/0/false', 'authenticated', pg_temp.uid('A'));
-- the daily cap: 300 failures spread over the day, none in the last hour
delete from public.scan_sessions where uid = pg_temp.uid('B');
insert into public.scan_attempts (event_id, uid, failed_at)
  select 't1', gen_random_uuid(), now() - interval '2 hours' - (g || ' seconds')::interval from generate_series(1, 299) g;
select pg_temp.t_eq('299 in the day: still open', $$select public.start_scan_session('t1','123456')$$, 'ok', 'authenticated', pg_temp.uid('B'));
delete from public.scan_sessions where uid = pg_temp.uid('B');
insert into public.scan_attempts (event_id, uid, failed_at) values ('t1', gen_random_uuid(), now() - interval '3 hours');
select pg_temp.t_eq('300 in the day: locked', $$select public.start_scan_session('t1','123456')$$, 'locked', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('door_alert shows the daily count', $$select failed_last_day || '/' || door_locked from public.door_alert('t1')$$, '300/true', 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('failures older than a day do not count', $$update public.scan_attempts set failed_at = now() - interval '25 hours' where event_id='t1'; select 1$$, '1');
select pg_temp.t_eq('so the door opens again by itself', $$select public.start_scan_session('t1','123456')$$, 'ok', 'authenticated', pg_temp.uid('B'));
select * from pg_temp.report();
