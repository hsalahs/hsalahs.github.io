-- 0007: guest creation under the cap, self-registration requests and their approval.
-- Replaces the Firestore transactions in event.html / invite.html. The cap itself is also enforced by the
-- guests trigger (0002), so these functions can never exceed it even if buggy.

-- one guest per approved request (reviewer: duplicate req_ids in one call must not create two guests)
create unique index if not exists guests_req_unique on public.guests (event_id, req_id) where req_id is not null;

-- barcode text of a guest: 'WD-' + 12 hex chars (the Firestore ids were 'WD-' + 13 base36 chars)
create or replace function app_private.new_guest_id() returns text
language sql volatile set search_path = 'extensions' as $$
  select 'WD-' || upper(encode(gen_random_bytes(6), 'hex'));
$$;

-- Add guests in one call. p_guests = [{"name": "...", "vip": true?}, ...].
-- p_partial = false: all or nothing (blocked = true when they do not all fit).
-- p_partial = true:  add as many as fit, in order, blocked = true if some were left out (import, "accept all").
create or replace function public.add_guests(p_event_id text, p_guests jsonb, p_partial boolean default false)
returns table (added integer, blocked boolean, ids text[])
language plpgsql security definer set search_path = '' as $$
declare
  ev public.events%rowtype;
  n integer; room integer; take integer; new_ids text[] := '{}';
  r record; gid text;
begin
  if not (app_private.is_owner(p_event_id) or app_private.is_admin()) then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  if p_guests is null or jsonb_typeof(p_guests) <> 'array' then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  n := jsonb_array_length(p_guests);
  if n > 2000 then raise exception 'BATCH_TOO_LARGE' using errcode = '22023'; end if;
  select * into ev from public.events where id = p_event_id for update;
  if not found then raise exception 'EVENT_NOT_FOUND' using errcode = 'P0002'; end if;

  for r in select btrim(e.value ->> 'name') as nm, jsonb_typeof(e.value -> 'vip') as vt from jsonb_array_elements(p_guests) e loop
    if r.nm is null or char_length(r.nm) not between 1 and 100 then
      raise exception 'BAD_NAME' using errcode = '22023';
    end if;
    if r.vt is not null and r.vt not in ('boolean', 'null') then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  end loop;

  room := case when app_private.is_admin() then n
               else greatest(app_private.guest_cap(ev.paid, ev.guest_limit) - ev.guest_count, 0) end;
  if n > room and not p_partial then
    return query select 0, true, '{}'::text[]; return;
  end if;
  take := least(n, room);
  for r in select btrim(e.value ->> 'name') as nm, coalesce((e.value ->> 'vip')::boolean, false) as vip
             from jsonb_array_elements(p_guests) with ordinality as e(value, ord) order by e.ord limit take loop
    gid := app_private.new_guest_id();
    insert into public.guests (event_id, id, name, vip) values (p_event_id, gid, r.nm, r.vip);
    new_ids := new_ids || gid;
  end loop;
  return query select take, (take < n), new_ids;
end $$;

-- Approve pending requests, oldest first. p_items = [{"req_id": "...", "vip": true?}, ...] (vip optional:
-- falls back to the vip flag already on the request). Stops at the cap (blocked = true); requests that
-- are no longer pending are skipped. The client sends chunks of 25.
create or replace function public.approve_requests(p_event_id text, p_items jsonb)
returns table (approved text[], blocked boolean)
language plpgsql security definer set search_path = '' as $$
declare
  ev public.events%rowtype;
  r record; gid text; done text[] := '{}'; stop boolean := false; vipv boolean;
begin
  if not (app_private.is_owner(p_event_id) or app_private.is_admin()) then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  if jsonb_array_length(p_items) > 200 then raise exception 'BATCH_TOO_LARGE' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_array_elements(p_items) i where jsonb_typeof(i.value -> 'vip') not in ('boolean', 'null')) then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  select * into ev from public.events where id = p_event_id for update;
  if not found then raise exception 'EVENT_NOT_FOUND' using errcode = 'P0002'; end if;

  -- distinct on: the same req_id twice in p_items must approve it once (one guest, one cap slot)
  for r in
    select q.id, q.name, q.vip as req_vip, i.item_vip, q.created_at
      from public.requests q
      join (select distinct on (i.value ->> 'req_id') i.value ->> 'req_id' as rid, (i.value ->> 'vip')::boolean as item_vip
              from jsonb_array_elements(p_items) i order by i.value ->> 'req_id') i on i.rid = q.id
     where q.event_id = p_event_id and q.status = 'pending'
     order by q.created_at, q.id
  loop
    if not app_private.is_admin()
       and (select e.guest_count from public.events e where e.id = p_event_id) + 1
           > app_private.guest_cap(ev.paid, ev.guest_limit) then
      stop := true; exit;
    end if;
    gid := app_private.new_guest_id();
    vipv := coalesce(r.item_vip, r.req_vip);
    insert into public.guests (event_id, id, name, req_id, vip) values (p_event_id, gid, r.name, r.id, vipv);
    update public.requests set status = 'approved', guest_id = gid, vip = vipv
      where event_id = p_event_id and id = r.id;
    done := done || r.id;
  end loop;
  return query select done, stop;
end $$;

-- A guest asks to register (public: the invite page calls this, signed in or not).
-- Pending requests per event are capped at the event's guest limit (founder's decision), with an absolute
-- ceiling of 5000 so a paid event with a huge limit cannot be flooded.
create or replace function public.submit_request(p_event_id text, p_req_id text, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare ev public.events%rowtype; nm text := btrim(p_name); pending integer;
begin
  if p_req_id is null or p_req_id !~ '^[A-Za-z0-9_-]{20,128}$' then raise exception 'BAD_REQUEST_ID' using errcode = '22023'; end if;
  if nm is null or char_length(nm) not between 1 and 100 then raise exception 'BAD_NAME' using errcode = '22023'; end if;
  select * into ev from public.events where id = p_event_id;
  if not found then raise exception 'EVENT_NOT_FOUND' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtext('req:' || p_event_id));
  if exists (select 1 from public.requests where event_id = p_event_id and id = p_req_id) then return; end if;  -- retry-safe
  select count(*) into pending from public.requests where event_id = p_event_id and status = 'pending';
  if pending >= least(app_private.guest_cap(ev.paid, ev.guest_limit), 5000) then
    raise exception 'REQUESTS_FULL' using errcode = 'P0001';
  end if;
  insert into public.requests (event_id, id, name) values (p_event_id, p_req_id, nm);
end $$;

-- The guest's own page asks about ONE request by its exact (unguessable) id.
create or replace function public.get_request(p_event_id text, p_req_id text)
returns table (status text, guest_id text, vip boolean, name text)
language sql stable security definer set search_path = '' as $$
  select q.status, q.guest_id, q.vip, q.name from public.requests q
   where q.event_id = p_event_id and q.id = p_req_id and char_length(p_req_id) >= 20;
$$;
