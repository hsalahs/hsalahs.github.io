-- 0004: door RPCs. A door device is an anonymous sign-in (role authenticated). It has no table
-- access; everything goes through these functions, each of which checks the caller itself.
-- Allowed callers for the data functions: a valid door session, the event owner, or the admin.

create or replace function app_private.can_door(eid text) returns boolean
language sql stable security definer set search_path = '' as $$
  select app_private.has_scan_session(eid) or app_private.is_owner(eid) or app_private.is_admin();
$$;
grant execute on function app_private.can_door(text) to authenticated;

-- Start a door session with the door code.
-- Returns 'ok' | 'wrong' | 'locked'. 10 wrong codes inside 10 minutes lock THAT DEVICE
-- (its anonymous uid) for 10 minutes after the 10th; other devices are unaffected.
create or replace function public.start_scan_session(p_event_id text, p_pin text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  real_pin text;
  last_fail timestamptz;
  recent integer;
begin
  if me is null then raise exception 'NOT_SIGNED_IN' using errcode = '28000'; end if;
  select scan_pin into real_pin from public.event_secrets where event_id = p_event_id;
  if not found then return 'wrong'; end if;   -- unknown event looks like a wrong code

  select max(failed_at) into last_fail from public.scan_attempts where event_id = p_event_id and uid = me;
  if last_fail is not null and now() < last_fail + interval '10 minutes' then
    select count(*) into recent from public.scan_attempts
      where event_id = p_event_id and uid = me and failed_at > last_fail - interval '10 minutes';
    if recent >= 10 then return 'locked'; end if;
  end if;

  if real_pin <> '' and p_pin is not null and p_pin = real_pin then
    delete from public.scan_attempts where event_id = p_event_id and uid = me;
    insert into public.scan_sessions (event_id, uid, pin) values (p_event_id, me, real_pin)
      on conflict (event_id, uid) do update set pin = excluded.pin, created_at = now();
    return 'ok';
  end if;

  insert into public.scan_attempts (event_id, uid) values (p_event_id, me);
  delete from public.scan_attempts where failed_at < now() - interval '1 day';
  return 'wrong';
end $$;

create or replace function public.end_scan_session(p_event_id text) returns void
language sql security definer set search_path = '' as $$
  delete from public.scan_sessions where event_id = p_event_id and uid = (select auth.uid());
$$;

-- The device asks "is my session still good?" (false after the code changed or the event was deleted).
create or replace function public.scan_session_valid(p_event_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select app_private.has_scan_session(p_event_id);
$$;

-- Atomic check-in. Outcomes: allowed | duplicate | not_found | no_session.
-- One UPDATE ... WHERE NOT scanned: a concurrent second scan waits for the row lock, re-checks
-- the condition, matches nothing and gets 'duplicate'. No retries, no double entry.
-- The trigger sets scanned_at/changed_at and bumps scanned_count in the same statement.
create or replace function public.check_in(p_event_id text, p_guest_id text)
returns table (outcome text, guest_name text, vip boolean, scanned_at timestamptz, scanned_count integer)
language plpgsql security definer set search_path = '' as $$
declare g public.guests%rowtype; cnt integer; declare_found boolean;
begin
  if not app_private.can_door(p_event_id) then
    return query select 'no_session'::text, null::text, null::boolean, null::timestamptz, null::integer;
    return;
  end if;
  update public.guests set scanned = true
    where event_id = p_event_id and id = p_guest_id and not scanned
    returning * into g;
  if found then
    select e.scanned_count into cnt from public.events e where e.id = p_event_id;
    return query select 'allowed'::text, g.name, g.vip, g.scanned_at, cnt;
    return;
  end if;
  select * into g from public.guests where event_id = p_event_id and id = p_guest_id;
  declare_found := found;
  select e.scanned_count into cnt from public.events e where e.id = p_event_id;
  if declare_found then
    return query select 'duplicate'::text, g.name, g.vip, g.scanned_at, cnt;
  else
    return query select 'not_found'::text, null::text, null::boolean, null::timestamptz, cnt;
  end if;
end $$;

-- The names list. p_since = null: everyone. Otherwise only guests whose check-in state changed
-- after that moment (check-ins AND undos, via changed_at).
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
    order by g.name;
end $$;

-- Live numbers for the scanner header. (0013 adds a column: dropped first so a re-run of the whole set works.)
drop function if exists public.door_event(text);
create function public.door_event(p_event_id text)
returns table (name text, guest_count integer, scanned_count integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app_private.can_door(p_event_id) then
    raise exception 'NO_SESSION' using errcode = '42501';
  end if;
  return query select e.name, e.guest_count, e.scanned_count from public.events e where e.id = p_event_id;
end $$;

revoke execute on function public.start_scan_session(text, text), public.end_scan_session(text),
  public.scan_session_valid(text), public.check_in(text, text), public.door_guests(text, timestamptz),
  public.door_event(text) from public, anon;
grant execute on function public.start_scan_session(text, text), public.end_scan_session(text),
  public.scan_session_valid(text), public.check_in(text, text), public.door_guests(text, timestamptz),
  public.door_event(text) to authenticated;
