-- 0011: weekly housekeeping. Every door device signs in anonymously, so auth.users fills up with anonymous
-- accounts. Remove the ones not seen for 30 days, plus the door sessions and failed-code rows that belonged to
-- accounts that no longer exist. Not callable through the API (see 9999_grants.sql: nothing is granted).
create or replace function app_private.cleanup_anonymous_users() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from auth.users
   where coalesce(is_anonymous, false)
     and coalesce(last_sign_in_at, created_at) < now() - interval '30 days';
  get diagnostics n = row_count;
  delete from public.scan_sessions s where not exists (select 1 from auth.users u where u.id = s.uid);
  delete from public.scan_attempts where failed_at < now() - interval '1 day';
  return n;
end $$;

do $$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('cleanup-anonymous-users', '30 3 * * 0', 'select app_private.cleanup_anonymous_users()');
  end if;
end $$;
