-- 0005: fixes from the reviewer's pass over chunks 1-3.

-- (blocker) start_scan_session: serialise attempts per event, otherwise 200 parallel requests from
-- one device all read "fewer than 10 failures" before any failure is recorded.
create or replace function public.start_scan_session(p_event_id text, p_pin text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  real_pin text;
  last_fail timestamptz;
  recent integer;
begin
  if me is null then raise exception 'NOT_SIGNED_IN' using errcode = '28000'; end if;
  perform pg_advisory_xact_lock(hashtext('door:' || p_event_id));
  select scan_pin into real_pin from public.event_secrets where event_id = p_event_id;
  if not found then return 'wrong'; end if;   -- unknown event looks like a wrong code

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
create index if not exists scan_attempts_failed_at_idx on public.scan_attempts (failed_at);

-- (should-fix) changed_at must also move when the name or VIP changes, so the door's delta sync
-- carries edits. clock_timestamp(), not now(): a long transaction must not stamp an old time
-- that a device which synced meanwhile would then skip. This does NOT cover commit order (a row
-- stamped at t1 but committed after a device synced at t2>t1 is missed by since=t2): the client must
-- subtract a safety margin (e.g. 1 minute) from its cursor.
alter table public.guests alter column changed_at set default clock_timestamp();

create or replace function app_private.guests_before_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.event_id <> old.event_id or new.id <> old.id then
    raise exception 'GUEST_KEY_IMMUTABLE' using errcode = 'P0001';
  end if;
  if new.scanned is distinct from old.scanned then
    new.scanned_at := case when new.scanned then clock_timestamp() else null end;
    update public.events
      set scanned_count = greatest(scanned_count + (case when new.scanned then 1 else -1 end), 0)
    where id = new.event_id;
  end if;
  if new.scanned is distinct from old.scanned or new.name is distinct from old.name
     or new.vip is distinct from old.vip then
    new.changed_at := clock_timestamp();
  end if;
  return new;
end $$;

-- (nit) defence in depth on the admin list
alter table app_private.admins enable row level security;
