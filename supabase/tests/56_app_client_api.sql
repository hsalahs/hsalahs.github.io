-- 0014: list_events, my_account, request_extra_event, admin requests / activate / users.
-- list_events visibility
select pg_temp.t_eq('owner sees only their own event', $$select string_agg(id, ',') from public.list_events()$$, 't1', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('the other owner sees only theirs', $$select string_agg(id, ',') from public.list_events()$$, 't2', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_eq('admin sees every event', $$select count(*) from public.list_events()$$, '2', 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('rows carry the columns the page renders', $$select name || '/' || paid || '/' || guest_count || '/' || coalesce(slug, '-') from public.list_events()$$, 'event one/false/2/-', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('anon cannot list', $$select * from public.list_events()$$, 'anon');
select pg_temp.t_fail('anonymous door device cannot list', $$select * from public.list_events()$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_fail('negative limit is refused', $$select * from public.list_events(null, null, -1)$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('zero limit is refused', $$select * from public.list_events(null, null, 0)$$, 'authenticated', pg_temp.uid('A'));

-- paging with ties: 2300 events of A, 40 of them with the SAME created_at
insert into public.events (id, owner_uid, name, created_at)
  select 'p' || lpad(i::text, 5, '0'), pg_temp.uid('A'), 'e' || i,
         case when i <= 40 then timestamptz '2026-01-01 00:00:00+00' else timestamptz '2026-01-02 00:00:00+00' + (i || ' seconds')::interval end
  from generate_series(1, 2300) i;
create function pg_temp.walk_events(lim int) returns text language plpgsql as $$
declare ac timestamptz := null; ai text := null; n int; total int := 0; pages int := 0; ids text[] := '{}'; r record; ordered boolean := true; pc timestamptz := null; pi text := null;
begin
  loop
    n := 0;
    for r in select * from public.list_events(ac, ai, lim) loop
      n := n + 1; total := total + 1; ids := ids || r.id;
      if pc is not null and (r.created_at, r.id) >= (pc, pi) then ordered := false; end if;
      pc := r.created_at; pi := r.id; ac := r.created_at; ai := r.id;
    end loop;
    pages := pages + 1;
    exit when n < lim;
  end loop;
  return total || '/' || (select count(distinct x) from unnest(ids) x) || '/' || pages || '/' || ordered;
end $$;
grant execute on function pg_temp.walk_events(int) to public;
select pg_temp.t_eq('2301 events: no gaps, no duplicates, newest first, 3 pages of 1000', $$select pg_temp.walk_events(1000)$$, '2301/2301/3/true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('tiny pages (the 40 tied rows straddle page ends)', $$select pg_temp.walk_events(7)$$, '2301/2301/329/true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('the admin walks all 2302', $$select pg_temp.walk_events(1000)$$, '2302/2302/3/true', 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('the limit is capped at 1000', $$select count(*) from public.list_events(null, null, 5000)$$, '1000', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('default limit is 1000', $$select count(*) from public.list_events()$$, '1000', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('null limit means 1000', $$select count(*) from public.list_events(null, null, null)$$, '1000', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('newest first', $$select id from public.list_events(null, null, 1)$$, 't1', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('a stranger never gets another owner''s rows through paging', $$select count(*) from public.list_events(null, null, 1000) where owner_uid <> '{B}'$$, '0', 'authenticated', pg_temp.uid('B'));
delete from public.events where id like 'p0%';

-- my_account
select pg_temp.t_eq('limit 1, count 1, nothing pending', $$select event_limit || '/' || event_count || '/' || coalesce(pending_request::text, '-') from public.my_account()$$, '1/1/-', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('a customer with no limit row gets the defaults', $$select event_limit || '/' || event_count || '/' || coalesce(pending_request::text, '-') from public.my_account()$$, '1/0/-', 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_fail('anon cannot read an account', $$select * from public.my_account()$$, 'anon');
select pg_temp.t_fail('anonymous door device cannot read an account', $$select * from public.my_account()$$, 'authenticated', pg_temp.uid('D'), true);

-- request_extra_event: idempotent
select pg_temp.t_eq('first request is created', $$select created from public.request_extra_event()$$, 'true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('second request returns the SAME row, not created', $$select (r.id = (select id from public.event_requests where uid = '{A}')) || '/' || r.created from public.request_extra_event() r$$, 'true/false', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('still exactly one pending row', $$select count(*) from public.event_requests where uid = '{A}' and status = 'pending'$$, '1');
select pg_temp.t_eq('my_account shows the pending id', $$select (pending_request = (select id from public.event_requests where uid = '{A}'))::text from public.my_account()$$, 'true', 'authenticated', pg_temp.uid('A'));
select pg_temp.t_eq('the email claim is stored', $$select email from public.event_requests where uid = '{A}'$$, '');
select pg_temp.t_fail('anon cannot ask', $$select * from public.request_extra_event()$$, 'anon');
select pg_temp.t_fail('anonymous door device cannot ask', $$select * from public.request_extra_event()$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_fail('a deleted user (token still valid) cannot ask', $$select * from public.request_extra_event()$$, 'authenticated', '00000000-0000-0000-0000-00000000dead'::uuid);

-- admin_pending_requests
select pg_temp.t_eq('admin sees the pending request', $$select count(*) || '/' || min(uid::text) from public.admin_pending_requests()$$, '1/' || pg_temp.uid('A'), 'authenticated', pg_temp.uid('ADM'));
insert into public.event_requests (uid, email, requested_at) values (pg_temp.uid('B'), 'b@test.local', now() - interval '1 day');
select pg_temp.t_eq('oldest first', $$select string_agg(email, ',') from public.admin_pending_requests()$$, 'b@test.local,', 'authenticated', pg_temp.uid('ADM'));

-- reject
select pg_temp.t_fail('a customer cannot reject', $$select public.admin_reject_event_request((select id from public.event_requests where uid = '{B}'))$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('anon cannot reject', $$select public.admin_reject_event_request((select id from public.event_requests where uid = '{B}'))$$, 'anon');
select pg_temp.t_fail('door device cannot reject', $$select public.admin_reject_event_request((select id from public.event_requests where uid = '{B}'))$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_ok('admin rejects', $$select public.admin_reject_event_request((select id from public.event_requests where uid = '{B}'))$$, 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('status is rejected', $$select status from public.event_requests where uid = '{B}'$$, 'rejected');
select pg_temp.t_fail('rejecting twice is NOT_PENDING', $$select public.admin_reject_event_request((select id from public.event_requests where uid = '{B}'))$$, 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_fail('unknown request', $$select public.admin_reject_event_request('00000000-0000-0000-0000-000000000000')$$, 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('a rejected customer can ask again', $$select created from public.request_extra_event()$$, 'true', 'authenticated', pg_temp.uid('B'));
select pg_temp.t_ok('admin approves A', $$select public.admin_approve_event_request((select id from public.event_requests where uid = '{A}'))$$, 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_fail('approving twice is NOT_PENDING', $$select public.admin_approve_event_request((select id from public.event_requests where uid = '{A}'))$$, 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_fail('rejecting an approved request is NOT_PENDING', $$select public.admin_reject_event_request((select id from public.event_requests where uid = '{A}'))$$, 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('limit went to 2', $$select event_limit from public.my_account()$$, '2', 'authenticated', pg_temp.uid('A'));

-- admin_activate_event
select pg_temp.t_fail('a customer cannot activate', $$select public.admin_activate_event('t1', 50)$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('anon cannot activate', $$select public.admin_activate_event('t1', 50)$$, 'anon');
select pg_temp.t_fail('door device cannot activate', $$select public.admin_activate_event('t1', 50)$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_fail('negative limit is BAD_INPUT', $$select public.admin_activate_event('t1', -5)$$, 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_fail('zero limit is BAD_INPUT', $$select public.admin_activate_event('t1', 0)$$, 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_fail('limit above 2000 is BAD_INPUT', $$select public.admin_activate_event('t1', 2001)$$, 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_fail('null limit is BAD_INPUT', $$select public.admin_activate_event('t1', null)$$, 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_fail('unknown event', $$select public.admin_activate_event('nope', 50)$$, 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_ok('admin activates', $$select public.admin_activate_event('t1', 300)$$, 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('paid with the limit', $$select paid || '/' || guest_limit from public.events where id = 't1'$$, 'true/300');
select pg_temp.t_eq('the owner sees it in the list', $$select paid || '/' || guest_limit from public.list_events()$$, 'true/300', 'authenticated', pg_temp.uid('A'));

-- admin users list
select pg_temp.t_eq('admin counts the accounts (equals the mirror rows)', $$select public.admin_user_count() = (select count(*) from public.users)$$, 'true', 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_fail('a customer cannot count', $$select public.admin_user_count()$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('anon cannot count', $$select public.admin_user_count()$$, 'anon');
select pg_temp.t_fail('door device cannot count', $$select public.admin_user_count()$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_fail('a customer cannot list users', $$select * from public.admin_list_users()$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('anon cannot list users', $$select * from public.admin_list_users()$$, 'anon');
select pg_temp.t_fail('door device cannot list users', $$select * from public.admin_list_users()$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_fail('negative limit is BAD_INPUT', $$select * from public.admin_list_users(null, null, -1)$$, 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('admin lists every account', $$select count(*) = (select count(*) from public.users) from public.admin_list_users()$$, 'true', 'authenticated', pg_temp.uid('ADM'));
-- keyset paging with ties (all three fixtures share one created_at inside this transaction)
create function pg_temp.walk_users(lim int) returns text language plpgsql as $$
declare ac timestamptz := null; au uuid := null; n int; total int := 0; ids uuid[] := '{}'; r record;
begin
  loop
    n := 0;
    for r in select * from public.admin_list_users(ac, au, lim) loop
      n := n + 1; total := total + 1; ids := ids || r.uid; ac := r.created_at; au := r.uid;
    end loop;
    exit when n < lim;
  end loop;
  return (total = (select count(*) from public.users))::text || '/' || (total = (select count(distinct x) from unnest(ids) x))::text;
end $$;
grant execute on function pg_temp.walk_users(int) to public;
select pg_temp.t_eq('page size 1 over tied created_at: every account once', $$select pg_temp.walk_users(1)$$, 'true/true', 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('page size 2', $$select pg_temp.walk_users(2)$$, 'true/true', 'authenticated', pg_temp.uid('ADM'));

-- admin_remove_user_record
select pg_temp.t_fail('a customer cannot remove a record', $$select public.admin_remove_user_record('{B}')$$, 'authenticated', pg_temp.uid('A'));
select pg_temp.t_fail('anon cannot remove a record', $$select public.admin_remove_user_record('{B}')$$, 'anon');
select pg_temp.t_fail('door device cannot remove a record', $$select public.admin_remove_user_record('{B}')$$, 'authenticated', pg_temp.uid('D'), true);
select pg_temp.t_eq('admin removes B from the list', $$select public.admin_remove_user_record('{B}')$$, 'true', 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('only the list row went: the sign-in, events and limits stay', $$select (select count(*) from auth.users where id = '{B}') || '/' || (select count(*) from public.events where owner_uid = '{B}') || '/' || (select count(*) from public.account_limits where uid = '{B}')$$, '1/1/1');
select pg_temp.t_eq('removing it again says false', $$select public.admin_remove_user_record('{B}')$$, 'false', 'authenticated', pg_temp.uid('ADM'));
select pg_temp.t_eq('count dropped', $$select public.admin_user_count() = (select count(*) from public.users)$$, 'true', 'authenticated', pg_temp.uid('ADM'));
select * from pg_temp.report();
