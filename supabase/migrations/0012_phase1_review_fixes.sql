-- 0012: fixes from the comprehensive phase-1 review.

-- (1) cleanup: a supervisor phone signs in once and then only refreshes its token. Judge "unused" by the
-- sessions' last refresh, not by last_sign_in_at, so an active device is never deleted mid-event.
create or replace function app_private.cleanup_anonymous_users() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from auth.users u
   where coalesce(u.is_anonymous, false)
     and coalesce(u.last_sign_in_at, u.created_at) < now() - interval '30 days'
     and not exists (select 1 from auth.sessions s where s.user_id = u.id
                      and coalesce(s.refreshed_at, s.updated_at, s.created_at) > now() - interval '30 days');
  get diagnostics n = row_count;
  delete from public.scan_sessions s where not exists (select 1 from auth.users u where u.id = s.uid);
  delete from public.scan_attempts where failed_at < now() - interval '1 day';
  return n;
end $$;

-- (2) door code: six digits, or empty (= no session can start). create_event now creates the code row.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'event_secrets_pin_shape') then
    alter table public.event_secrets add constraint event_secrets_pin_shape check (scan_pin ~ '^[0-9]{6}$' or scan_pin = '');
  end if;
end $$;

create or replace function public.create_event(p_name text, p_type text, p_date text, p_venue text,
  p_maps_link text, p_theme text, p_welcome text default '') returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  eid text;
  lim public.account_limits%rowtype;
begin
  if me is null or app_private.is_anon() or not exists (select 1 from auth.users where id = me) then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  if not app_private.is_admin() then
    insert into public.account_limits (uid, event_limit, event_count) values (me, 1, 0) on conflict (uid) do nothing;
    select * into lim from public.account_limits where uid = me for update;
    if lim.event_count >= lim.event_limit then raise exception 'LIMIT_REACHED' using errcode = 'P0001'; end if;
    update public.account_limits set event_count = event_count + 1 where uid = me;
  end if;
  eid := substr(encode(extensions.gen_random_bytes(8), 'hex'), 1, 10);
  insert into public.events (id, owner_uid, owner_email, name, type, date, venue, maps_link, theme, welcome_message)
    values (eid, me, coalesce((select auth.jwt() ->> 'email'), ''), btrim(p_name), coalesce(p_type, ''), coalesce(p_date, ''),
            coalesce(p_venue, ''), coalesce(p_maps_link, ''), coalesce(p_theme, ''), coalesce(p_welcome, ''));
  insert into public.event_secrets (event_id, scan_pin)
    values (eid, lpad((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000)::text, 6, '0'));
  return eid;
end $$;

-- (3) stable order for paging (PostgREST caps responses at max_rows = 1000)
create or replace function public.door_guests(p_event_id text, p_since timestamptz default null)
returns table (id text, name text, scanned boolean, scanned_at timestamptz, vip boolean, changed_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app_private.can_door(p_event_id) then
    raise exception 'NO_SESSION' using errcode = '42501';
  end if;
  return query select g.id, g.name, g.scanned, g.scanned_at, g.vip, g.changed_at
    from public.guests g
    where g.event_id = p_event_id and (p_since is null or g.changed_at > p_since)
    order by g.name, g.id;
end $$;

-- (4) Postgres gives EXECUTE to PUBLIC on every new function; the per-schema revoke in 0002 cannot remove that.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;

-- (7) one open extra-event request per customer
create unique index if not exists event_requests_one_pending on public.event_requests (uid) where status = 'pending';

-- (8) email changes reach the admin's account list; the admin's own events never touched a limits row
create or replace function app_private.mirror_user_email() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.users set email = coalesce(new.email, '') where uid = new.id;
  if not found and not coalesce(new.is_anonymous, false) then
    insert into public.users (uid, email) values (new.id, coalesce(new.email, '')) on conflict (uid) do nothing;
  end if;
  return new;
end $$;
drop trigger if exists mirror_user_email on auth.users;
create trigger mirror_user_email after update of email, is_anonymous on auth.users for each row execute function app_private.mirror_user_email();

create or replace function public.delete_event(p_event_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare owner uuid;
begin
  select owner_uid into owner from public.events where id = p_event_id for update;
  if not found or not (owner = (select auth.uid()) or app_private.is_admin()) then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  delete from public.events where id = p_event_id;
  if found and not exists (select 1 from app_private.admins where user_id = owner) then   -- admin events never used a slot
    update public.account_limits set event_count = greatest(event_count - 1, 0) where uid = owner;
  end if;
end $$;
