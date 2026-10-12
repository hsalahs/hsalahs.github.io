-- 0010: no deadlocks between a guest write and an event delete.
-- Postgres deadlocks when two requests take the same two locks in opposite orders. delete_event, add_guests and
-- approve_requests lock the EVENT row first and then the guest rows (the cascade). A client write on a guest
-- (undo check-in, delete guest) locked the GUEST row first and then the event row (the counter trigger):
-- opposite order, so deleting an event on one phone while the owner removed a guest on another could abort one request.
-- Fix: every guest write now goes through a function that locks the event row FIRST, and check_in does the same;
-- direct UPDATE/DELETE on guests is no longer granted. (Check-ins were already serialised per event by the counter.)

drop policy if exists guests_update on public.guests;
drop policy if exists guests_delete on public.guests;
revoke update, delete on public.guests from authenticated;

create or replace function public.check_in(p_event_id text, p_guest_id text)
returns table (outcome text, guest_name text, vip boolean, scanned_at timestamptz, scanned_count integer)
language plpgsql security definer set search_path = '' as $$
declare g public.guests%rowtype; cnt integer; was_found boolean;
begin
  if not app_private.can_door(p_event_id) then
    return query select 'no_session'::text, null::text, null::boolean, null::timestamptz, null::integer;
    return;
  end if;
  perform 1 from public.events e where e.id = p_event_id for no key update;   -- event row FIRST (lock order)
  update public.guests set scanned = true
    where event_id = p_event_id and id = p_guest_id and not scanned
    returning * into g;
  if found then
    select e.scanned_count into cnt from public.events e where e.id = p_event_id;
    return query select 'allowed'::text, g.name, g.vip, g.scanned_at, cnt;
    return;
  end if;
  select * into g from public.guests where event_id = p_event_id and id = p_guest_id;
  was_found := found;
  select e.scanned_count into cnt from public.events e where e.id = p_event_id;
  if was_found then
    return query select 'duplicate'::text, g.name, g.vip, g.scanned_at, cnt;
  else
    return query select 'not_found'::text, null::text, null::boolean, null::timestamptz, cnt;
  end if;
end $$;

-- Rename a guest and/or set the VIP flag (a null argument leaves that field alone). Returns false when the guest does not exist.
create or replace function public.set_guest(p_event_id text, p_guest_id text, p_name text default null, p_vip boolean default null)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare nm text := btrim(p_name);
begin
  if not (app_private.is_owner(p_event_id) or app_private.is_admin()) then raise exception 'NOT_ALLOWED' using errcode = '42501'; end if;
  if p_name is not null and char_length(nm) not between 1 and 100 then raise exception 'BAD_NAME' using errcode = '22023'; end if;
  perform 1 from public.events e where e.id = p_event_id for no key update;
  update public.guests set name = coalesce(nm, name), vip = coalesce(p_vip, vip) where event_id = p_event_id and id = p_guest_id;
  return found;
end $$;

-- The owner's manual check-in undo (or re-check): same effect on scanned_count as the door.
create or replace function public.set_guest_scanned(p_event_id text, p_guest_id text, p_scanned boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not (app_private.is_owner(p_event_id) or app_private.is_admin()) then raise exception 'NOT_ALLOWED' using errcode = '42501'; end if;
  if p_scanned is null then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  perform 1 from public.events e where e.id = p_event_id for no key update;
  update public.guests set scanned = p_scanned where event_id = p_event_id and id = p_guest_id;
  return found;
end $$;

-- Delete one guest (frees the slot: the trigger lowers guest_count, and scanned_count if they had entered).
create or replace function public.remove_guest(p_event_id text, p_guest_id text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not (app_private.is_owner(p_event_id) or app_private.is_admin()) then raise exception 'NOT_ALLOWED' using errcode = '42501'; end if;
  perform 1 from public.events e where e.id = p_event_id for no key update;
  delete from public.guests where event_id = p_event_id and id = p_guest_id;
  return found;
end $$;
