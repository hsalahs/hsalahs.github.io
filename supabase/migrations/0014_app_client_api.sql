-- 0014: what app.html (the organizer's events list and the admin screens) needs (phase 2, chunk C).
-- Every function is security definer with search_path '' and checks its caller inside; EXECUTE is granted
-- only in 9999_grants.sql. Paging is keyset because PostgREST caps a response at 1000 rows.

-- The caller's own events (owner) or every event (admin), newest first. Keyset (created_at desc, id desc):
-- pass the last row's created_at and id back as p_after_created / p_after_id. Cap 1000 rows.
create or replace function public.list_events(p_after_created timestamptz default null,
  p_after_id text default null, p_limit integer default 1000)
returns table (id text, owner_uid uuid, owner_email text, name text, type text, date text, venue text,
  maps_link text, theme text, welcome_message text, paid boolean, guest_limit integer, guest_count integer,
  scanned_count integer, slug text, slug_decided boolean, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := (select auth.uid()); lim integer := coalesce(p_limit, 1000);
begin
  if me is null or app_private.is_anon() then raise exception 'NOT_ALLOWED' using errcode = '42501'; end if;
  if lim < 1 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  lim := least(lim, 1000);
  return query
    select e.id, e.owner_uid, e.owner_email, e.name, e.type, e.date, e.venue, e.maps_link, e.theme,
           e.welcome_message, e.paid, e.guest_limit, e.guest_count, e.scanned_count, e.slug, e.slug_decided, e.created_at
      from public.events e
     where (e.owner_uid = me or app_private.is_admin())
       and (p_after_created is null or (e.created_at, e.id) < (p_after_created, coalesce(p_after_id, chr(1114111))))
     order by e.created_at desc, e.id desc
     limit lim;
end $$;

-- The caller's event limit, how many events they hold and the id of their pending extra-event request (or null).
-- No row yet = the default customer (limit 1, count 0).
create or replace function public.my_account()
returns table (event_limit integer, event_count integer, pending_request uuid)
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := (select auth.uid());
begin
  if me is null or app_private.is_anon() then raise exception 'NOT_ALLOWED' using errcode = '42501'; end if;
  return query
    select coalesce(l.event_limit, 1), coalesce(l.event_count, 0),
           (select r.id from public.event_requests r where r.uid = me and r.status = 'pending' limit 1)
      from (select 1) one left join public.account_limits l on l.uid = me;
end $$;

-- Ask for one more event. Idempotent: a second call while a request is pending returns the same id with
-- created = false (the client only notifies the admin when created is true).
create or replace function public.request_extra_event()
returns table (id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare me uuid := (select auth.uid()); rid uuid;
begin
  if me is null or app_private.is_anon() or not exists (select 1 from auth.users u where u.id = me) then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  insert into public.event_requests as r (uid, email)
    values (me, coalesce((select auth.jwt() ->> 'email'), ''))
    on conflict (uid) where status = 'pending' do nothing
    returning r.id into rid;
  if rid is not null then
    return query select rid, true;
  else
    return query select r.id, false from public.event_requests r where r.uid = me and r.status = 'pending' limit 1;
  end if;
end $$;

-- Admin: pending extra-event requests, oldest first, at most 500.
create or replace function public.admin_pending_requests()
returns table (id uuid, uid uuid, email text, requested_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app_private.is_admin() then raise exception 'NOT_ALLOWED' using errcode = '42501'; end if;
  return query select r.id, r.uid, r.email, r.requested_at from public.event_requests r
    where r.status = 'pending' order by r.requested_at, r.id limit 500;
end $$;

-- Admin: refuse a pending request (a request that is not pending any more is refused with NOT_PENDING).
create or replace function public.admin_reject_event_request(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare st text;
begin
  if not app_private.is_admin() then raise exception 'NOT_ALLOWED' using errcode = '42501'; end if;
  select status into st from public.event_requests where id = p_id for update;
  if not found then raise exception 'REQUEST_NOT_FOUND' using errcode = 'P0002'; end if;
  if st <> 'pending' then raise exception 'NOT_PENDING' using errcode = 'P0001'; end if;
  update public.event_requests set status = 'rejected' where id = p_id;
end $$;

-- Admin: activate an event with a guest limit (1 to 2000, like askGuestLimit in utils.js).
create or replace function public.admin_activate_event(p_event_id text, p_limit integer) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not app_private.is_admin() then raise exception 'NOT_ALLOWED' using errcode = '42501'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 2000 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  update public.events set paid = true, guest_limit = p_limit where id = p_event_id;
  if not found then raise exception 'EVENT_NOT_FOUND' using errcode = 'P0002'; end if;
end $$;

-- Admin: registered accounts, newest first. Keyset (created_at desc, uid desc), cap 1000.
create or replace function public.admin_list_users(p_after_created timestamptz default null,
  p_after_uid uuid default null, p_limit integer default 500)
returns table (uid uuid, email text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare lim integer := coalesce(p_limit, 500);
begin
  if not app_private.is_admin() then raise exception 'NOT_ALLOWED' using errcode = '42501'; end if;
  if lim < 1 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  lim := least(lim, 1000);
  return query select u.uid, u.email, u.created_at from public.users u
    where p_after_created is null
       or (u.created_at, u.uid) < (p_after_created, coalesce(p_after_uid, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
    order by u.created_at desc, u.uid desc limit lim;
end $$;

create or replace function public.admin_user_count() returns integer
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app_private.is_admin() then raise exception 'NOT_ALLOWED' using errcode = '42501'; end if;
  return (select count(*)::integer from public.users);
end $$;

-- Admin: take an account off the admin's list ONLY (same meaning as before: the sign-in, the events and the
-- limits are untouched). true = a row was removed.
create or replace function public.admin_remove_user_record(p_uid uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not app_private.is_admin() then raise exception 'NOT_ALLOWED' using errcode = '42501'; end if;
  delete from public.users where uid = p_uid;
  return found;
end $$;
