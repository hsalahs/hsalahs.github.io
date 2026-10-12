-- 0013: what the scanner client needs (phase 2, chunk B).
-- (a) events.guests_changed_at: moves on every guest insert / delete / check-in / undo / rename / VIP edit.
--     door_event returns it as last_change, so the scanner polls ONE cheap row and only downloads the
--     names list when it moved.
-- (b) door_guests: ONE callable function with keyset paging (PostgREST caps a response at 1000 rows).
-- (c) is_admin_me(): lets the client ask "am I the admin?" without reading the admin list.

alter table public.events add column if not exists guests_changed_at timestamptz;

create or replace function app_private.guests_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.events set guest_count = guest_count + 1,
    scanned_count = scanned_count + (case when new.scanned then 1 else 0 end),
    guests_changed_at = clock_timestamp()
  where id = new.event_id;
  return new;
end $$;

create or replace function app_private.guests_after_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- no-op while the whole event is being deleted (its row is already gone)
  update public.events set guest_count = greatest(guest_count - 1, 0),
    scanned_count = greatest(scanned_count - (case when old.scanned then 1 else 0 end), 0),
    guests_changed_at = clock_timestamp()
  where id = old.event_id;
  return old;
end $$;

create or replace function app_private.guests_before_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.event_id <> old.event_id or new.id <> old.id then
    raise exception 'GUEST_KEY_IMMUTABLE' using errcode = 'P0001';
  end if;
  if new.scanned is distinct from old.scanned then
    new.scanned_at := case when new.scanned then clock_timestamp() else null end;
  end if;
  if new.scanned is distinct from old.scanned or new.name is distinct from old.name
     or new.vip is distinct from old.vip then
    new.changed_at := clock_timestamp();
    update public.events
      set scanned_count = case when new.scanned is distinct from old.scanned
                               then greatest(scanned_count + (case when new.scanned then 1 else -1 end), 0)
                               else scanned_count end,
          guests_changed_at = new.changed_at
    where id = new.event_id;
  end if;
  return new;
end $$;

-- the owner can never write the marker by hand (same list as 0009 plus the new column)
create or replace function app_private.events_before_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') and not app_private.is_admin() then
    if new.id is distinct from old.id or new.owner_uid is distinct from old.owner_uid
       or new.owner_email is distinct from old.owner_email
       or new.paid is distinct from old.paid or new.guest_limit is distinct from old.guest_limit
       or new.guest_count is distinct from old.guest_count
       or new.scanned_count is distinct from old.scanned_count
       or new.guests_changed_at is distinct from old.guests_changed_at
       or new.slug is distinct from old.slug or new.slug_decided is distinct from old.slug_decided
       or new.created_at is distinct from old.created_at then
      raise exception 'PROTECTED_FIELD' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

-- door_event gains last_change (the return type changes, so drop first)
drop function if exists public.door_event(text);
create function public.door_event(p_event_id text)
returns table (name text, guest_count integer, scanned_count integer, last_change timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app_private.can_door(p_event_id) then
    raise exception 'NO_SESSION' using errcode = '42501';
  end if;
  return query select e.name, e.guest_count, e.scanned_count, e.guests_changed_at
    from public.events e where e.id = p_event_id;
end $$;

-- door_guests: one function, two modes, both paged by a keyset (stable across inserts and edits).
--   p_since null  : the full list, ordered by (name, id). Next page: pass the LAST row's name and id
--                   as p_after_name / p_after_id.
--   p_since set   : only guests changed after that moment (check-ins, undos, renames, VIP), ordered by
--                   (changed_at, id). Next page: pass the LAST row's changed_at as p_since and its id as
--                   p_after_id (rows with the same changed_at and a bigger id still follow).
-- p_limit is capped at 1000 (PostgREST max_rows). A page shorter than the limit is the last one.
drop function if exists public.door_guests(text, timestamptz);
drop function if exists public.door_guests(text, timestamptz, text, text, integer);
create function public.door_guests(p_event_id text, p_since timestamptz default null,
  p_after_name text default null, p_after_id text default null, p_limit integer default 1000)
returns table (id text, name text, scanned boolean, scanned_at timestamptz, vip boolean, changed_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare lim integer := least(greatest(coalesce(p_limit, 1000), 1), 1000);
begin
  if not app_private.can_door(p_event_id) then
    raise exception 'NO_SESSION' using errcode = '42501';
  end if;
  if p_since is null then
    return query select g.id, g.name, g.scanned, g.scanned_at, g.vip, g.changed_at
      from public.guests g
      where g.event_id = p_event_id
        and (p_after_id is null or (g.name, g.id) > (coalesce(p_after_name, ''), p_after_id))
      order by g.name, g.id
      limit lim;
  else
    return query select g.id, g.name, g.scanned, g.scanned_at, g.vip, g.changed_at
      from public.guests g
      where g.event_id = p_event_id
        and (case when p_after_id is null then g.changed_at > p_since
                  else (g.changed_at, g.id) > (p_since, p_after_id) end)
      order by g.changed_at, g.id
      limit lim;
  end if;
end $$;

create or replace function public.is_admin_me() returns boolean
language sql stable security definer set search_path = '' as $$
  select app_private.is_admin();
$$;
