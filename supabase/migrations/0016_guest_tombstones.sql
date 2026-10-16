-- 0016: deleted guests travel in the delta (phase 2, chunk D). Without this a device could only learn about a
-- deleted guest by downloading the whole list again (about 470 KB for 2000 guests). A tombstone row is written when a
-- guest is deleted; owner_guests / door_guests in delta mode return it as a row with deleted = true. Tombstones are
-- purged after 7 days by the weekly cleanup; a page that was asleep for longer does a full read (the client does it
-- when its cursor is older than 6 days).

-- no foreign key on purpose: the delete trigger must never fail while a whole event is being deleted
create table if not exists public.guest_tombstones (
  event_id text not null,
  id text not null,
  deleted_at timestamptz not null default clock_timestamp(),
  primary key (event_id, id)
);
create index if not exists guest_tombstones_changed_idx on public.guest_tombstones (event_id, deleted_at);
alter table public.guest_tombstones enable row level security;
revoke all on public.guest_tombstones from anon, authenticated;

-- skipped silently while the event itself is being deleted (its row is already gone)
create or replace function app_private.guests_after_delete_tomb() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.guest_tombstones (event_id, id)
    select old.event_id, old.id where exists (select 1 from public.events e where e.id = old.event_id)
    on conflict (event_id, id) do update set deleted_at = clock_timestamp();
  return old;
end $$;
drop trigger if exists guests_after_delete_tomb on public.guests;
create trigger guests_after_delete_tomb after delete on public.guests
  for each row execute function app_private.guests_after_delete_tomb();

-- delete_event also removes the event's tombstones (no foreign key to cascade through)
create or replace function public.delete_event(p_event_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare owner uuid; gone boolean;
begin
  select owner_uid into owner from public.events where id = p_event_id for update;
  if not found or not (owner = (select auth.uid()) or app_private.is_admin()) then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  delete from public.events where id = p_event_id;
  gone := found;
  delete from public.guest_tombstones where event_id = p_event_id;
  if gone and not exists (select 1 from app_private.admins where user_id = owner) then   -- admin events never used a slot
    update public.account_limits set event_count = greatest(event_count - 1, 0) where uid = owner;
  end if;
end $$;

-- door_guests / owner_guests gain `deleted` (the return type changes, so drop first; still ONE function each).
--   full mode (p_since null): live guests only, deleted = false.
--   delta mode: live guests changed after p_since PLUS tombstones (id, changed_at = deleted_at, other fields null,
--   deleted = true), one (changed_at, id) ordering and keyset, cap 1000.
drop function if exists public.door_guests(text, timestamptz, text, text, integer);
create function public.door_guests(p_event_id text, p_since timestamptz default null,
  p_after_name text default null, p_after_id text default null, p_limit integer default 1000)
returns table (id text, name text, scanned boolean, scanned_at timestamptz, vip boolean, changed_at timestamptz, deleted boolean)
language plpgsql stable security definer set search_path = '' as $$
declare lim integer := least(greatest(coalesce(p_limit, 1000), 1), 1000);
begin
  if not app_private.can_door(p_event_id) then
    raise exception 'NO_SESSION' using errcode = '42501';
  end if;
  if p_since is null then
    return query select g.id, g.name, g.scanned, g.scanned_at, g.vip, g.changed_at, false
      from public.guests g
      where g.event_id = p_event_id
        and (p_after_id is null or (g.name, g.id) > (coalesce(p_after_name, ''), p_after_id))
      order by g.name, g.id
      limit lim;
  else
    return query select u.id, u.name, u.scanned, u.scanned_at, u.vip, u.changed_at, u.deleted from (
        select g.id, g.name, g.scanned, g.scanned_at, g.vip, g.changed_at, false as deleted
          from public.guests g where g.event_id = p_event_id
        union all
        select t.id, null::text, null::boolean, null::timestamptz, null::boolean, t.deleted_at, true
          from public.guest_tombstones t where t.event_id = p_event_id
      ) u
      where (case when p_after_id is null then u.changed_at > p_since
                  else (u.changed_at, u.id) > (p_since, p_after_id) end)
      order by u.changed_at, u.id
      limit lim;
  end if;
end $$;

drop function if exists public.owner_guests(text, timestamptz, text, text, integer);
create function public.owner_guests(p_event_id text, p_since timestamptz default null,
  p_after_name text default null, p_after_id text default null, p_limit integer default 1000)
returns table (id text, name text, scanned boolean, scanned_at timestamptz, vip boolean, changed_at timestamptz,
  registered_at timestamptz, deleted boolean)
language plpgsql stable security definer set search_path = '' as $$
declare lim integer := least(greatest(coalesce(p_limit, 1000), 1), 1000);
begin
  if not (app_private.is_owner(p_event_id) or app_private.is_admin()) then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  if p_since is null then
    return query select g.id, g.name, g.scanned, g.scanned_at, g.vip, g.changed_at, g.registered_at, false
      from public.guests g
      where g.event_id = p_event_id
        and (p_after_id is null or (g.name, g.id) > (coalesce(p_after_name, ''), p_after_id))
      order by g.name, g.id
      limit lim;
  else
    return query select u.id, u.name, u.scanned, u.scanned_at, u.vip, u.changed_at, u.registered_at, u.deleted from (
        select g.id, g.name, g.scanned, g.scanned_at, g.vip, g.changed_at, g.registered_at, false as deleted
          from public.guests g where g.event_id = p_event_id
        union all
        select t.id, null::text, null::boolean, null::timestamptz, null::boolean, t.deleted_at, null::timestamptz, true
          from public.guest_tombstones t where t.event_id = p_event_id
      ) u
      where (case when p_after_id is null then u.changed_at > p_since
                  else (u.changed_at, u.id) > (p_since, p_after_id) end)
      order by u.changed_at, u.id
      limit lim;
  end if;
end $$;

-- Weekly housekeeping (the existing job): also purge tombstones older than 7 days (and those of events that are
-- gone) and REJECTED registration requests older than 30 days (the guest's page then shows «not found»).
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
  delete from public.guest_tombstones t
   where t.deleted_at < now() - interval '7 days' or not exists (select 1 from public.events e where e.id = t.event_id);
  delete from public.requests where status = 'rejected' and created_at < now() - interval '30 days';
  return n;
end $$;
