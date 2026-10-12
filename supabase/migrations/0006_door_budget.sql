-- 0006: per-event budget of wrong door codes (founder approved: 60 per hour, 300 per day, all devices
-- together), on top of the per-device lock. Once spent, a device WITHOUT a session (not the owner,
-- not the admin, no valid session) gets 'locked' even with the right code, so rotating anonymous
-- accounts does not help: 300/day means years to cover 10^6 codes. Devices that already hold a
-- valid session, the owner and the admin are never affected. The owner/admin can reopen the door
-- with reset_door_attempts() without changing the code (changing it would cut every supervisor).
create or replace function public.start_scan_session(p_event_id text, p_pin text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  real_pin text;
  last_fail timestamptz;
  recent integer;
  per_hour integer;
  per_day integer;
begin
  if me is null then raise exception 'NOT_SIGNED_IN' using errcode = '28000'; end if;
  perform pg_advisory_xact_lock(hashtext('door:' || p_event_id));
  select scan_pin into real_pin from public.event_secrets where event_id = p_event_id;
  if not found then return 'wrong'; end if;   -- unknown event looks like a wrong code

  -- event-wide budget (not for the owner, the admin or a device that already holds a valid session)
  if not app_private.can_door(p_event_id) then
    select count(*) filter (where failed_at > clock_timestamp() - interval '1 hour'),
           count(*) filter (where failed_at > clock_timestamp() - interval '1 day')
      into per_hour, per_day from public.scan_attempts where event_id = p_event_id;
    if per_hour >= 60 or per_day >= 300 then return 'locked'; end if;
  end if;

  -- per-device lock: 10 wrong inside 10 minutes -> locked for 10 minutes after the 10th
  select max(failed_at) into last_fail from public.scan_attempts where event_id = p_event_id and uid = me;
  if last_fail is not null and clock_timestamp() < last_fail + interval '10 minutes' then
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

  insert into public.scan_attempts (event_id, uid, failed_at) values (p_event_id, me, clock_timestamp());
  delete from public.scan_attempts where failed_at < now() - interval '1 day';
  return 'wrong';
end $$;

-- Owner/admin: clear the attempts and reopen the door, the door code stays the same.
create or replace function public.reset_door_attempts(p_event_id text) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if not (app_private.is_owner(p_event_id) or app_private.is_admin()) then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  delete from public.scan_attempts where event_id = p_event_id;
  get diagnostics n = row_count;
  return n;
end $$;

-- Owner/admin: the numbers behind the dashboard alert.
create or replace function public.door_alert(p_event_id text)
returns table (failed_last_hour integer, failed_last_day integer, door_locked boolean)
language plpgsql stable security definer set search_path = '' as $$
declare h integer; d integer;
begin
  if not (app_private.is_owner(p_event_id) or app_private.is_admin()) then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  select count(*) filter (where failed_at > clock_timestamp() - interval '1 hour'),
         count(*) filter (where failed_at > clock_timestamp() - interval '1 day')
    into h, d from public.scan_attempts where event_id = p_event_id;
  return query select h, d, (h >= 60 or d >= 300);
end $$;
