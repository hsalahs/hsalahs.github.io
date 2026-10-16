-- 0015: what event.html (the organizer's dashboard for one event) needs (phase 2, chunk D1).
-- Every function is security definer with search_path '' and checks its caller inside; EXECUTE is granted
-- only in 9999_grants.sql. Paging is keyset because PostgREST caps a response at 1000 rows.

-- A rejected registration request stays in the table (the guest's own page still reads it through get_request and
-- shows «rejected»). It never counts toward the pending cap of submit_request (that counts status = 'pending').
alter table public.requests drop constraint if exists requests_status_check;
alter table public.requests add constraint requests_status_check check (status in ('pending', 'approved', 'rejected'));

-- the dashboard poll counts / orders the pending requests of one event
create index if not exists requests_pending_idx on public.requests (event_id, created_at) where status = 'pending';

-- ONE cheap row the dashboard polls: the counters, the change marker, how many requests wait, and the
-- activation state. Zero rows = the event is gone. A stranger gets NOT_ALLOWED.
create or replace function public.event_live(p_event_id text)
returns table (guest_count integer, scanned_count integer, last_change timestamptz, pending_count integer,
  newest_pending timestamptz, paid boolean, guest_limit integer)
language plpgsql stable security definer set search_path = '' as $$
declare ev public.events%rowtype;
begin
  select * into ev from public.events e where e.id = p_event_id;
  if not found then return; end if;
  if not coalesce(ev.owner_uid = (select auth.uid()), false) and not app_private.is_admin() then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  return query select ev.guest_count, ev.scanned_count, ev.guests_changed_at,
    (select count(*)::integer from public.requests r where r.event_id = p_event_id and r.status = 'pending'),
    (select max(r.created_at) from public.requests r where r.event_id = p_event_id and r.status = 'pending'),
    ev.paid, ev.guest_limit;
end $$;

-- The owner's guest list: same keyset rules as door_guests (full read by (name, id); delta by (changed_at, id);
-- cap 1000) plus registered_at.
drop function if exists public.owner_guests(text, timestamptz, text, text, integer);
create function public.owner_guests(p_event_id text, p_since timestamptz default null,
  p_after_name text default null, p_after_id text default null, p_limit integer default 1000)
returns table (id text, name text, scanned boolean, scanned_at timestamptz, vip boolean, changed_at timestamptz,
  registered_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare lim integer := least(greatest(coalesce(p_limit, 1000), 1), 1000);
begin
  if not (app_private.is_owner(p_event_id) or app_private.is_admin()) then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  if p_since is null then
    return query select g.id, g.name, g.scanned, g.scanned_at, g.vip, g.changed_at, g.registered_at
      from public.guests g
      where g.event_id = p_event_id
        and (p_after_id is null or (g.name, g.id) > (coalesce(p_after_name, ''), p_after_id))
      order by g.name, g.id
      limit lim;
  else
    return query select g.id, g.name, g.scanned, g.scanned_at, g.vip, g.changed_at, g.registered_at
      from public.guests g
      where g.event_id = p_event_id
        and (case when p_after_id is null then g.changed_at > p_since
                  else (g.changed_at, g.id) > (p_since, p_after_id) end)
      order by g.changed_at, g.id
      limit lim;
  end if;
end $$;

-- The pending registration requests, oldest first. Keyset (created_at, id): pass the last row's created_at and id.
create or replace function public.owner_requests(p_event_id text, p_after_created timestamptz default null,
  p_after_id text default null, p_limit integer default 1000)
returns table (id text, name text, vip boolean, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare lim integer := least(greatest(coalesce(p_limit, 1000), 1), 1000);
begin
  if not (app_private.is_owner(p_event_id) or app_private.is_admin()) then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  return query select q.id, q.name, q.vip, q.created_at
    from public.requests q
    where q.event_id = p_event_id and q.status = 'pending'
      and (p_after_created is null or (q.created_at, q.id) > (p_after_created, coalesce(p_after_id, '')))
    order by q.created_at, q.id
    limit lim;
end $$;

-- Refuse a pending request: true = it was pending and is now rejected, false = it was not pending (already
-- approved / rejected, or unknown). The event row is locked FIRST (lock order), so a reject racing an approve of
-- the same request has exactly one winner.
create or replace function public.reject_request(p_event_id text, p_req_id text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not (app_private.is_owner(p_event_id) or app_private.is_admin()) then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  perform 1 from public.events e where e.id = p_event_id for no key update;
  if not found then raise exception 'EVENT_NOT_FOUND' using errcode = 'P0002'; end if;
  update public.requests set status = 'rejected' where event_id = p_event_id and id = p_req_id and status = 'pending';
  return found;
end $$;

-- A new 6-digit door code (leading zeros kept). Every door session holds the old pin, so all of them stop at once.
create or replace function public.regenerate_door_code(p_event_id text) returns text
language plpgsql security definer set search_path = '' as $$
declare code text;
begin
  if not (app_private.is_owner(p_event_id) or app_private.is_admin()) then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  perform 1 from public.events e where e.id = p_event_id for no key update;
  if not found then raise exception 'EVENT_NOT_FOUND' using errcode = 'P0002'; end if;
  code := lpad((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000)::text, 6, '0');
  insert into public.event_secrets (event_id, scan_pin) values (p_event_id, code)
    on conflict (event_id) do update set scan_pin = excluded.scan_pin;
  return code;
end $$;

-- Delete several guests (at most 200 per call). Returns how many were removed; the triggers fix the counters.
create or replace function public.remove_guests(p_event_id text, p_ids text[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if not (app_private.is_owner(p_event_id) or app_private.is_admin()) then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  if p_ids is null then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  if cardinality(p_ids) > 200 then raise exception 'BATCH_TOO_LARGE' using errcode = '22023'; end if;
  perform 1 from public.events e where e.id = p_event_id for no key update;   -- event row FIRST (lock order)
  if not found then raise exception 'EVENT_NOT_FOUND' using errcode = 'P0002'; end if;
  delete from public.guests where event_id = p_event_id and id = any(p_ids);
  get diagnostics n = row_count;
  return n;
end $$;

-- Admin: take an event back to the free plan (not paid, default guest limit).
create or replace function public.admin_deactivate_event(p_event_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not app_private.is_admin() then raise exception 'NOT_ALLOWED' using errcode = '42501'; end if;
  update public.events set paid = false, guest_limit = null where id = p_event_id;
  if not found then raise exception 'EVENT_NOT_FOUND' using errcode = 'P0002'; end if;
end $$;
