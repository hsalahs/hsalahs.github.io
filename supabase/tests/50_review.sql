-- Chunk 3 review follow-ups: gaps vs rules-tests, function grants audit, changed_at, parallel-safe lock.
-- door device and strangers vs requests / event_requests
update public.requests set vip = false where event_id = 't1';
select pg_temp.t_eq('door device cannot read requests', $$select count(*) from public.requests$$, '0', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('door device cannot set vip on a request', $$with u as (update public.requests set vip=true returning 1) select count(*) from u$$, '0', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('a stranger cannot set vip on a request', $$with u as (update public.requests set vip=true where event_id='t1' returning 1) select count(*) from u$$, '0', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('door device cannot read event_requests', $$select count(*) from public.event_requests$$, '0', 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_fail('door device cannot ask for an event', $$insert into public.event_requests (uid,email) values ('{D}','')$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_fail('door device cannot read the admin list', $$select * from app_private.admins$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_fail('anon cannot read the admin list', $$select * from app_private.admins$$, 'anon');
-- function grants audit: anon may execute nothing; authenticated only the intended list
select pg_temp.t_eq('anon can execute only the four invite-page functions',
  $$select coalesce(string_agg(n.nspname || '.' || p.proname, ', ' order by p.proname), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','app_private') and has_function_privilege('anon', p.oid, 'execute')$$, 'public.event_public, public.get_request, public.resolve_slug, public.submit_request');
select pg_temp.t_eq('PUBLIC (everyone) can execute no function either',
  $$select coalesce(string_agg(p.proname, ', '), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','app_private') and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')$$, '');
select pg_temp.t_eq('authenticated can execute exactly the intended functions',
  $$select string_agg(n.nspname || '.' || p.proname, ', ' order by n.nspname, p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','app_private') and has_function_privilege('authenticated', p.oid, 'execute')$$,
  'app_private.can_door, app_private.has_scan_session, app_private.is_admin, app_private.is_anon, app_private.is_owner, public.add_guests, public.admin_activate_event, public.admin_approve_event_request, public.admin_delete_user, public.admin_list_users, public.admin_pending_requests, public.admin_reject_event_request, public.admin_remove_user_record, public.admin_set_event_limit, public.admin_user_count, public.approve_requests, public.auto_claim_slug, public.bump_event_limit, public.check_in, public.claim_slug, public.create_event, public.delete_event, public.door_alert, public.door_event, public.door_guests, public.end_scan_session, public.event_public, public.get_request, public.is_admin_me, public.list_events, public.my_account, public.remove_guest, public.request_extra_event, public.reset_door_attempts, public.resolve_slug, public.scan_session_valid, public.set_guest, public.set_guest_scanned, public.start_scan_session, public.submit_request');
select pg_temp.t_eq('trigger functions are not callable by the API roles',
  $$select coalesce(string_agg(p.proname, ', '), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app_private' and p.proname like '%guests_%' and has_function_privilege('authenticated', p.oid, 'execute')$$, '');
select pg_temp.t_eq('every public table has RLS on',
  $$select coalesce(string_agg(c.relname, ', '), '') from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity$$, '');
-- changed_at follows name / vip / scanned edits
update public.guests set changed_at = now() - interval '1 hour' where event_id = 't1';
update public.guests set name = 'renamed' where event_id = 't1' and id = 'WD-1';
select pg_temp.t_eq('renaming a guest moves changed_at', $$select count(*) from public.guests where event_id='t1' and changed_at > now() - interval '1 minute'$$, '1');
update public.guests set vip = true where event_id = 't1' and id = 'WD-2';
select pg_temp.t_eq('vip change moves changed_at', $$select count(*) from public.guests where event_id='t1' and changed_at > now() - interval '1 minute'$$, '2');
update public.guests set changed_at = now() - interval '1 hour' where event_id = 't1';
select pg_temp.t_eq('door_guests delta carries a rename', $$select count(*) from public.door_guests('t1', now() - interval '1 minute')$$, '0', 'authenticated', pg_temp.uid('D'), true);
update public.guests set name = 'renamed again' where event_id = 't1' and id = 'WD-1';
select pg_temp.t_eq('and then shows the renamed guest', $$select name from public.door_guests('t1', now() - interval '1 minute')$$, 'renamed again', 'authenticated', pg_temp.uid('D'), true);
update public.guests set changed_at = now() - interval '1 hour' where event_id = 't1';
update public.guests set name = name where event_id = 't1';
select pg_temp.t_eq('a no-op update does not move changed_at', $$select count(*) from public.guests where event_id='t1' and changed_at > now() - interval '1 minute'$$, '0');
-- an event created with the owner's changes does not leak into others
select * from pg_temp.report();
