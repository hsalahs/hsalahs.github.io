-- 0017: new retention rule for REJECTED registration requests (founder, Oct 16). A rejected request is deleted
-- 30 days after the EVENT'S DATE; if the event has no valid date, 90 days after the rejection. Pending and
-- approved requests are never touched. The guest's own page then shows «not found» instead of «rejected».

alter table public.requests add column if not exists rejected_at timestamptz;
-- rows rejected before this migration: the best known time is their creation
update public.requests set rejected_at = created_at where status = 'rejected' and rejected_at is null;

-- same signature, access rules and lock order as 0015; only rejected_at is new
create or replace function public.reject_request(p_event_id text, p_req_id text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not (app_private.is_owner(p_event_id) or app_private.is_admin()) then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  perform 1 from public.events e where e.id = p_event_id for no key update;
  if not found then raise exception 'EVENT_NOT_FOUND' using errcode = 'P0002'; end if;
  update public.requests set status = 'rejected', rejected_at = clock_timestamp()
   where event_id = p_event_id and id = p_req_id and status = 'pending';
  return found;
end $$;

-- events.date is free text: a valid 'YYYY-MM-DD' gives the date, anything else (empty, 'soon', '2026-13-45') gives null
create or replace function app_private.safe_event_date(p text) returns date
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or p !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  return p::date;
exception when others then
  return null;
end $$;

-- Weekly housekeeping: only the rejected-requests rule changes (the rest is exactly as in 0016).
-- coalesce(rejected_at, created_at) covers a rejected row inserted without rejected_at.
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
  delete from public.requests r
   where r.status = 'rejected'
     and (case
            when app_private.safe_event_date((select e.date from public.events e where e.id = r.event_id)) is not null
              then now() > app_private.safe_event_date((select e.date from public.events e where e.id = r.event_id)) + 30
            else coalesce(r.rejected_at, r.created_at) < now() - interval '90 days'
          end);
  return n;
end $$;
