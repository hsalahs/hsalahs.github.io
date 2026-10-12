-- Chunk 3: door RPCs. t1 has door code 123456, guests WD-1 and WD-2, and a session for device {D}.
-- Devices: {D} has a session; {B} is a stranger (owner of t2, no session on t1); {A} owns t1.
select pg_temp.t_fail('anon cannot call check_in', $$select * from public.check_in('t1','WD-1')$$, 'anon');
select pg_temp.t_fail('anon cannot call start_scan_session', $$select public.start_scan_session('t1','123456')$$, 'anon');
select pg_temp.t_fail('anon cannot call door_guests', $$select * from public.door_guests('t1')$$, 'anon');
select pg_temp.t_fail('anon cannot call scan_session_valid', $$select public.scan_session_valid('t1')$$, 'anon');
-- sessions
select pg_temp.t_eq('wrong code', $$select public.start_scan_session('t1','000000')$$, 'wrong', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('wrong code leaves no session', $$select count(*) from public.scan_sessions where event_id='t1' and uid='{B}'$$, '0');
select pg_temp.t_eq('empty code is wrong', $$select public.start_scan_session('t1','')$$, 'wrong', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('null code is wrong', $$select public.start_scan_session('t1', null)$$, 'wrong', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('unknown event looks like a wrong code', $$select public.start_scan_session('nope','123456')$$, 'wrong', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('right code opens a session', $$select public.start_scan_session('t1','123456')$$, 'ok', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('the session row exists', $$select count(*) from public.scan_sessions where event_id='t1' and uid='{B}'$$, '1');
select pg_temp.t_eq('session_valid is true', $$select public.scan_session_valid('t1')$$, 'true', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('session_valid is false for another event', $$select public.scan_session_valid('t2')$$, 'false', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_ok('end session', $$select public.end_scan_session('t1')$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('session_valid false after ending', $$select public.scan_session_valid('t1')$$, 'false', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('ending does not touch another device', $$select public.scan_session_valid('t1')$$, 'true', 'authenticated', pg_temp.uid('D'), true);
update public.event_secrets set scan_pin = '' where event_id = 't2';
select pg_temp.t_eq('a door code that is empty never opens a session', $$select public.start_scan_session('t2','')$$, 'wrong', 'authenticated', pg_temp.uid('B'));
update public.event_secrets set scan_pin = '654321' where event_id = 't2';
-- access
select pg_temp.t_eq('stranger gets no_session', $$select outcome from public.check_in('t1','WD-1')$$, 'no_session', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('stranger did not check anyone in', $$select scanned_count from public.events where id='t1'$$, '0');
select pg_temp.t_fail('stranger cannot list guests', $$select * from public.door_guests('t1')$$, 'authenticated', pg_temp.uid('B'));
select pg_temp.t_fail('stranger cannot read door_event', $$select * from public.door_event('t1')$$, 'authenticated', pg_temp.uid('B'));
-- check_in
select pg_temp.t_eq('device checks a guest in', $$select outcome from public.check_in('t1','WD-1')$$, 'allowed', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('allowed returns the name', $$select guest_name from public.check_in('t1','WD-2')$$, 'g2', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('scanned_count is 2', $$select scanned_count from public.events where id='t1'$$, '2');
select pg_temp.t_eq('second scan is a duplicate', $$select outcome from public.check_in('t1','WD-1')$$, 'duplicate', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('duplicate returns the original time', $$select (scanned_at is not null)::text from public.check_in('t1','WD-1')$$, 'true', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('duplicate does not move the count', $$select scanned_count from public.events where id='t1'$$, '2');
select pg_temp.t_eq('unknown barcode', $$select outcome from public.check_in('t1','WD-NOPE')$$, 'not_found', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('barcode of another event is not found', $$select outcome from public.check_in('t1','X')$$, 'not_found', 'authenticated', pg_temp.uid('D'), true);
update public.guests set scanned = false where event_id = 't1' and id = 'WD-2';
select pg_temp.t_eq('owner can check in too', $$select outcome from public.check_in('t1','WD-2')$$, 'allowed', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('owner path', $$select outcome from public.check_in('t1','WD-1')$$, 'duplicate', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('guest ids are matched exactly (case)', $$select outcome from public.check_in('t1','wd-1')$$, 'not_found', 'authenticated', pg_temp.uid('D'), true);
-- door_guests / door_event
select pg_temp.t_eq('door_guests lists everyone', $$select count(*) from public.door_guests('t1')$$, '2', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('door_guests shows who is in', $$select count(*) from public.door_guests('t1') where scanned$$, '2', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('door_guests since the future is empty', $$select count(*) from public.door_guests('t1', now() + interval '1 hour')$$, '0', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('door_guests since the past is everyone', $$select count(*) from public.door_guests('t1', now() - interval '1 hour')$$, '2', 'authenticated', pg_temp.uid('D'), true);
update public.guests set changed_at = now() - interval '1 hour' where event_id = 't1';
update public.guests set scanned = false where event_id = 't1' and id = 'WD-1';
select pg_temp.t_eq('door_guests delta carries an undo', $$select count(*) from public.door_guests('t1', now() - interval '1 minute') where not scanned$$, '1', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('and leaves the untouched guest out of the delta', $$select count(*) from public.door_guests('t1', now() - interval '1 minute')$$, '1', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('door_event numbers', $$select guest_count || '/' || scanned_count from public.door_event('t1')$$, '2/1', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('admin may use the door functions', $$select count(*) from public.door_guests('t1')$$, '2', 'authenticated', pg_temp.uid('ADM'));
-- the code changes: the device is cut off
update public.event_secrets set scan_pin = '555555' where event_id = 't1';
select pg_temp.t_eq('after a code change check_in says no_session', $$select outcome from public.check_in('t1','WD-1')$$, 'no_session', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_fail('after a code change the list is closed', $$select * from public.door_guests('t1')$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('the device can sign in again with the new code', $$select public.start_scan_session('t1','555555')$$, 'ok', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('and works again', $$select outcome from public.check_in('t1','WD-1')$$, 'allowed', 'authenticated', pg_temp.uid('D'), true);
-- lockout: 10 wrong codes inside 10 minutes lock that device for 10 minutes
select pg_temp.t_eq('9 wrong codes are still just wrong', $$select max(r) from (select public.start_scan_session('t2','000000') r from generate_series(1,9)) s$$, 'wrong', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('the 10th is still answered "wrong"', $$select public.start_scan_session('t2','000000')$$, 'wrong', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('then the device is locked', $$select public.start_scan_session('t2','654321')$$, 'locked', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('even with the right code while locked', $$select public.start_scan_session('t2','654321')$$, 'locked', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('a locked device did not get a session', $$select count(*) from public.scan_sessions where event_id='t2' and uid='{A}'$$, '0');
select pg_temp.t_eq('another device is not locked', $$select public.start_scan_session('t2','654321')$$, 'ok', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('the lock is per event', $$select public.start_scan_session('t1','555555')$$, 'ok', 'authenticated', pg_temp.uid('A'));
update public.scan_attempts set failed_at = failed_at - interval '9 minutes' where uid = pg_temp.uid('A');
select pg_temp.t_eq('still locked after 9 minutes', $$select public.start_scan_session('t2','654321')$$, 'locked', 'authenticated', pg_temp.uid('A'));
update public.scan_attempts set failed_at = failed_at - interval '2 minutes' where uid = pg_temp.uid('A');
select pg_temp.t_eq('unlocked after 11 minutes', $$select public.start_scan_session('t2','654321')$$, 'ok', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('success clears the failed attempts', $$select count(*) from public.scan_attempts where uid='{A}' and event_id='t2'$$, '0');
insert into public.scan_attempts (event_id, uid, failed_at) select 't2', pg_temp.uid('B'), now() - (g * 2 || ' minutes')::interval from generate_series(1,12) g;
select pg_temp.t_eq('spread-out failures do not lock', $$select public.start_scan_session('t2','654321')$$, 'ok', 'authenticated', pg_temp.uid('B'));
select * from pg_temp.report();
