-- 0002: helper functions (schema app_private, not exposed by the API) and triggers.
-- Triggers replace the Firestore rules that tied counters to writes:
-- guest cap, guest_count, scanned_count, and the owner's protected event fields.

-- Functions created from now on are NOT callable by anon/authenticated/public by default
-- (Supabase's default grants EXECUTE to them; every grant here is explicit, see 9999).
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema app_private revoke execute on functions from public, anon, authenticated;

create or replace function app_private.is_anon() returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select auth.jwt() ->> 'is_anonymous')::boolean, false);
$$;

create or replace function app_private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select not app_private.is_anon()
     and exists (select 1 from app_private.admins a where a.user_id = (select auth.uid()));
$$;

create or replace function app_private.is_owner(eid text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.events e where e.id = eid and e.owner_uid = (select auth.uid()));
$$;

-- A door device holds a session row whose pin still equals the event's current pin
-- (changing the pin therefore revokes every device at once, like the Firestore rules).
create or replace function app_private.has_scan_session(eid text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.scan_sessions s
    join public.event_secrets k on k.event_id = s.event_id
    where s.event_id = eid and s.uid = (select auth.uid()) and s.pin = k.scan_pin and k.scan_pin <> ''
  );
$$;

-- keep in sync with guestCap() in firestore.rules / FREE_GUEST_LIMIT in utils.js
create or replace function app_private.guest_cap(p_paid boolean, p_limit integer) returns integer
language sql immutable set search_path = '' as $$
  select coalesce(p_limit, case when p_paid then 1000000 else 5 end);
$$;

-- ---- guests: cap + counters -------------------------------------------------
create or replace function app_private.guests_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare ev public.events%rowtype;
begin
  -- the row lock serialises concurrent adds to the same event
  select * into ev from public.events where id = new.event_id for update;
  if not found then raise exception 'EVENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if not app_private.is_admin()
     and ev.guest_count + 1 > app_private.guest_cap(ev.paid, ev.guest_limit) then
    raise exception 'GUEST_LIMIT_REACHED' using errcode = 'P0001';
  end if;
  if new.scanned then new.scanned_at := coalesce(new.scanned_at, now()); end if;
  return new;
end $$;
drop trigger if exists guests_before_insert on public.guests;
create trigger guests_before_insert before insert on public.guests
  for each row execute function app_private.guests_before_insert();

create or replace function app_private.guests_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.events set guest_count = guest_count + 1,
    scanned_count = scanned_count + (case when new.scanned then 1 else 0 end)
  where id = new.event_id;
  return new;
end $$;
drop trigger if exists guests_after_insert on public.guests;
create trigger guests_after_insert after insert on public.guests
  for each row execute function app_private.guests_after_insert();

create or replace function app_private.guests_after_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- no-op while the whole event is being deleted (its row is already gone)
  update public.events set guest_count = greatest(guest_count - 1, 0),
    scanned_count = greatest(scanned_count - (case when old.scanned then 1 else 0 end), 0)
  where id = old.event_id;
  return old;
end $$;
drop trigger if exists guests_after_delete on public.guests;
create trigger guests_after_delete after delete on public.guests
  for each row execute function app_private.guests_after_delete();

create or replace function app_private.guests_before_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.scanned is distinct from old.scanned then
    new.changed_at := now();
    new.scanned_at := case when new.scanned then now() else null end;
    update public.events
      set scanned_count = greatest(scanned_count + (case when new.scanned then 1 else -1 end), 0)
    where id = new.event_id;
  end if;
  if new.event_id <> old.event_id or new.id <> old.id then
    raise exception 'GUEST_KEY_IMMUTABLE' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists guests_before_update on public.guests;
create trigger guests_before_update before update on public.guests
  for each row execute function app_private.guests_before_update();

-- ---- events: protected columns ---------------------------------------------
-- Security INVOKER on purpose: current_user is the API role for client writes, and the
-- table owner for security-definer functions (the counters above, the RPCs), which pass.
create or replace function app_private.events_before_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') and not app_private.is_admin() then
    if new.id is distinct from old.id or new.owner_uid is distinct from old.owner_uid
       or new.owner_email is distinct from old.owner_email
       or new.paid is distinct from old.paid or new.guest_limit is distinct from old.guest_limit
       or new.guest_count is distinct from old.guest_count
       or new.scanned_count is distinct from old.scanned_count
       or new.slug is distinct from old.slug or new.created_at is distinct from old.created_at then
      raise exception 'PROTECTED_FIELD' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists events_before_update on public.events;
create trigger events_before_update before update on public.events
  for each row execute function app_private.events_before_update();
