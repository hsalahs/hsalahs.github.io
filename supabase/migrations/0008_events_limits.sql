-- 0008: creating / deleting events under the per-customer limit, extra-event requests, the signup mirror.
-- Replaces the accountLimits / eventRequests / users Firestore rules and the client transactions in app.html.

-- every non-anonymous signup is mirrored into public.users (the admin lists accounts from it)
create or replace function app_private.mirror_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(new.is_anonymous, false) then
    insert into public.users (uid, email) values (new.id, coalesce(new.email, '')) on conflict (uid) do nothing;
  end if;
  return new;
end $$;
drop trigger if exists mirror_new_user on auth.users;
create trigger mirror_new_user after insert on auth.users for each row execute function app_private.mirror_new_user();
-- accounts created before the trigger existed
insert into public.users (uid, email)
  select id, coalesce(email, '') from auth.users where not coalesce(is_anonymous, false) on conflict (uid) do nothing;

-- Create an event. The server picks the id. A customer (not admin) is limited by account_limits:
-- the first event creates the row (limit 1), later ones need event_count < event_limit, else LIMIT_REACHED.
-- The admin is not limited. Anonymous sessions (door devices) cannot create events.
create or replace function public.create_event(p_name text, p_type text, p_date text, p_venue text,
  p_maps_link text, p_theme text, p_welcome text default '') returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  eid text;
  lim public.account_limits%rowtype;
begin
  if me is null or app_private.is_anon() or not exists (select 1 from auth.users where id = me) then
    raise exception 'NOT_ALLOWED' using errcode = '42501';   -- also a deleted user whose token is still valid
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
  return eid;
end $$;

-- Delete an event with everything under it (guests, requests, sessions, code, slug cascade) and give the
-- slot back to the OWNER (also when the admin deletes it: a change from Firebase, where the count stayed).
create or replace function public.delete_event(p_event_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare owner uuid;
begin
  -- lock the event row first: two parallel deletes of the same event must give the slot back ONCE
  select owner_uid into owner from public.events where id = p_event_id for update;
  if not found or not (owner = (select auth.uid()) or app_private.is_admin()) then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  delete from public.events where id = p_event_id;
  if found then
    update public.account_limits set event_count = greatest(event_count - 1, 0) where uid = owner;
  end if;
end $$;

-- A customer's own +1 on the event limit, up to AUTO_APPROVE_CEILING = 3 (keep in sync with app.html).
create or replace function public.bump_event_limit() returns integer
language plpgsql security definer set search_path = '' as $$
declare me uuid := (select auth.uid()); cur integer;
begin
  if me is null or app_private.is_anon() or not exists (select 1 from auth.users where id = me) then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  select event_limit into cur from public.account_limits where uid = me for update;
  if not found then raise exception 'NO_LIMIT_ROW' using errcode = 'P0002'; end if;
  if cur >= 3 then raise exception 'CEILING_REACHED' using errcode = 'P0001'; end if;
  update public.account_limits set event_limit = cur + 1 where uid = me;
  return cur + 1;
end $$;

-- Admin: set a customer's event limit (creates the row with count 0 when there is none).
create or replace function public.admin_set_event_limit(p_uid uuid, p_limit integer) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not app_private.is_admin() then raise exception 'NOT_ALLOWED' using errcode = '42501'; end if;
  if p_limit is null or p_limit < 0 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  insert into public.account_limits (uid, event_limit, event_count) values (p_uid, p_limit, 0)
    on conflict (uid) do update set event_limit = excluded.event_limit;
end $$;

-- Admin: approve a pending extra-event request (+1 on the limit; a customer with no row gets limit 2 / count 0,
-- like app.html did). Approving twice is refused instead of adding twice.
create or replace function public.admin_approve_event_request(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.event_requests%rowtype;
begin
  if not app_private.is_admin() then raise exception 'NOT_ALLOWED' using errcode = '42501'; end if;
  select * into r from public.event_requests where id = p_id for update;
  if not found then raise exception 'REQUEST_NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'pending' then raise exception 'NOT_PENDING' using errcode = 'P0001'; end if;
  insert into public.account_limits (uid, event_limit, event_count) values (r.uid, 2, 0)
    on conflict (uid) do update set event_limit = public.account_limits.event_limit + 1;
  update public.event_requests set status = 'approved' where id = p_id;
end $$;

-- Admin: delete a customer completely (events with all their data, limits, requests, the mirror row and the
-- sign-in). Refuses to delete an admin. (The Firebase flow deleted only the mirror row; the sign-in was removed by
-- hand in the console. Without a foreign key on owner_uid, a plain auth delete would leave orphan events.)
create or replace function public.admin_delete_user(p_uid uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not app_private.is_admin() then raise exception 'NOT_ALLOWED' using errcode = '42501'; end if;
  if not exists (select 1 from auth.users where id = p_uid) then raise exception 'USER_NOT_FOUND' using errcode = 'P0002'; end if;
  if exists (select 1 from app_private.admins where user_id = p_uid) then raise exception 'CANNOT_DELETE_ADMIN' using errcode = 'P0001'; end if;
  delete from public.events where owner_uid = p_uid;
  delete from public.account_limits where uid = p_uid;
  delete from public.event_requests where uid = p_uid;
  delete from public.users where uid = p_uid;
  delete from auth.users where id = p_uid;
end $$;

-- length caps on the remaining free-text event columns (reviewer: megabytes in `type` / `theme` would be
-- loaded by the invite page for every guest). No data is migrated, so adding them is safe.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'events_type_len') then
    alter table public.events add constraint events_type_len check (char_length(type) <= 50);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'events_theme_len') then
    alter table public.events add constraint events_theme_len check (char_length(theme) <= 50);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'events_date_len') then
    alter table public.events add constraint events_date_len check (char_length(date) <= 50);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'events_owner_email_len') then
    alter table public.events add constraint events_owner_email_len check (char_length(owner_email) <= 320);
  end if;
end $$;
