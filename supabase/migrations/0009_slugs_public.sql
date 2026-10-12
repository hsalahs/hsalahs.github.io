-- 0009: readable invite links (slugs) and the public read of an event for the invite page.
-- slug null + slug_decided = false: never set (the dashboard may auto-claim one);
-- slug null + slug_decided = true: the owner deliberately cleared it (stays cleared).
-- Slug rows are only changed through these functions, so events.slug and slugs can never disagree:
-- the direct DELETE on slugs from 0003 is removed here.

alter table public.events add column if not exists slug_decided boolean not null default false;

drop policy if exists slugs_delete on public.slugs;
revoke delete on public.slugs from authenticated;

create or replace function app_private.events_before_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') and not app_private.is_admin() then
    if new.id is distinct from old.id or new.owner_uid is distinct from old.owner_uid
       or new.owner_email is distinct from old.owner_email
       or new.paid is distinct from old.paid or new.guest_limit is distinct from old.guest_limit
       or new.guest_count is distinct from old.guest_count
       or new.scanned_count is distinct from old.scanned_count
       or new.slug is distinct from old.slug or new.slug_decided is distinct from old.slug_decided
       or new.created_at is distinct from old.created_at then
      raise exception 'PROTECTED_FIELD' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

-- Set / change / clear the readable link of an event. p_slug = '' clears it. First come, first served:
-- a name held by ANOTHER event raises SLUG_TAKEN; a name the rules do not allow raises BAD_SLUG.
create or replace function public.claim_slug(p_event_id text, p_slug text) returns text
language plpgsql security definer set search_path = '' as $$
declare ev public.events%rowtype; s text := coalesce(p_slug, '');
begin
  select * into ev from public.events where id = p_event_id for no key update;
  if not found or coalesce(not (ev.owner_uid = (select auth.uid()) or app_private.is_admin()), true) then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  if s <> '' then
    if s !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' or s in ('index','app','event','invite','scan','guide','icons','tests',
       'sitemap','robots','manifest','sw','utils','format','admin','login','www','api','404','privacy') then
      raise exception 'BAD_SLUG' using errcode = '22023';
    end if;
    if ev.slug = s then return s; end if;
    if exists (select 1 from public.slugs where slug = s) then raise exception 'SLUG_TAKEN' using errcode = 'P0001'; end if;
  end if;
  delete from public.slugs where event_id = p_event_id;
  if s <> '' then
    begin
      insert into public.slugs (slug, event_id, owner_uid) values (s, p_event_id, ev.owner_uid);
    exception when unique_violation then   -- another event claimed the same name at the same moment
      raise exception 'SLUG_TAKEN' using errcode = 'P0001';
    end;
  end if;
  update public.events set slug = nullif(s, ''), slug_decided = true where id = p_event_id;
  return nullif(s, '');
end $$;

-- The dashboard's silent first-open claim: only the owner, only while nothing was decided. Tries
-- base, base-2, base-3, base-4, base-<4 random chars>. Returns the slug now held (null when none could be claimed;
-- the event then keeps its id link and may be tried again next time).
create or replace function public.auto_claim_slug(p_event_id text, p_base text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  ev public.events%rowtype; cand text; tries text[];
begin
  select * into ev from public.events where id = p_event_id for no key update;
  if not found or coalesce(ev.owner_uid <> (select auth.uid()), true) then raise exception 'NOT_ALLOWED' using errcode = '42501'; end if;
  if ev.slug_decided or ev.slug is not null then return ev.slug; end if;
  if p_base is null or p_base !~ '^[a-z0-9][a-z0-9-]{0,33}[a-z0-9]$' then return null; end if;
  tries := array[p_base, p_base || '-2', p_base || '-3', p_base || '-4', p_base || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 4)];
  foreach cand in array tries loop
    if cand ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' and cand not in ('index','app','event','invite','scan','guide','icons','tests',
         'sitemap','robots','manifest','sw','utils','format','admin','login','www','api','404','privacy')
       and not exists (select 1 from public.slugs where slug = cand) then
      begin
        insert into public.slugs (slug, event_id, owner_uid) values (cand, p_event_id, ev.owner_uid);
        update public.events set slug = cand, slug_decided = true where id = p_event_id;
        return cand;
      exception when unique_violation then
        null;   -- another event took this name a moment ago: try the next candidate
      end;
    end if;
  end loop;
  return null;
end $$;

-- Public (the invite page): which event does this readable name point to?
create or replace function public.resolve_slug(p_slug text) returns text
language sql stable security definer set search_path = '' as $$
  select s.event_id from public.slugs s where s.slug = p_slug;
$$;

-- Public (the invite page): only what the page shows, no owner email, no counts, no payment state.
create or replace function public.event_public(p_event_id text)
returns table (name text, type text, date text, venue text, maps_link text, theme text, welcome_message text)
language sql stable security definer set search_path = '' as $$
  select e.name, e.type, e.date, e.venue, e.maps_link, e.theme, e.welcome_message
    from public.events e where e.id = p_event_id;
$$;
