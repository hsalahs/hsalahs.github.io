-- 0003: RLS + explicit grants. anon gets NO table access at all: the public invite page
-- reads through RPCs that return only the needed columns (0004+). The door devices
-- (anonymous sign-ins, role authenticated) have no table access either: RPCs only.

grant usage on schema app_private to authenticated;
grant execute on function app_private.is_anon(), app_private.is_admin(), app_private.is_owner(text),
  app_private.has_scan_session(text) to authenticated;

revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

alter table public.events enable row level security;
alter table public.event_secrets enable row level security;
alter table public.scan_sessions enable row level security;
alter table public.scan_attempts enable row level security;
alter table public.guests enable row level security;
alter table public.requests enable row level security;
alter table public.account_limits enable row level security;
alter table public.event_requests enable row level security;
alter table public.users enable row level security;
alter table public.slugs enable row level security;

-- events: owner or admin read; owner edits details only (trigger guards the rest); admin may also set paid/guest_limit
grant select on public.events to authenticated;
grant update (name, type, date, venue, maps_link, theme, welcome_message, paid, guest_limit) on public.events to authenticated;
drop policy if exists events_select on public.events;
create policy events_select on public.events for select to authenticated
  using (owner_uid = (select auth.uid()) or app_private.is_admin());
drop policy if exists events_update on public.events;
create policy events_update on public.events for update to authenticated
  using (owner_uid = (select auth.uid()) or app_private.is_admin())
  with check (owner_uid = (select auth.uid()) or app_private.is_admin());

-- event_secrets (the door code): owner or admin
grant select, insert, update, delete on public.event_secrets to authenticated;
drop policy if exists secrets_all on public.event_secrets;
create policy secrets_all on public.event_secrets for all to authenticated
  using (app_private.is_owner(event_id) or app_private.is_admin())
  with check (app_private.is_owner(event_id) or app_private.is_admin());

-- scan_sessions: created only by an RPC; owner/admin list; a device sees and removes only its own row
grant select, delete on public.scan_sessions to authenticated;
drop policy if exists sessions_select on public.scan_sessions;
create policy sessions_select on public.scan_sessions for select to authenticated
  using (uid = (select auth.uid()) or app_private.is_owner(event_id) or app_private.is_admin());
drop policy if exists sessions_delete on public.scan_sessions;
create policy sessions_delete on public.scan_sessions for delete to authenticated
  using (uid = (select auth.uid()) or app_private.is_owner(event_id) or app_private.is_admin());

-- guests: owner/admin read, edit (name, vip, scanned), delete. Inserts only through RPCs (the cap trigger is the backstop).
grant select, delete on public.guests to authenticated;
grant update (name, vip, scanned) on public.guests to authenticated;
drop policy if exists guests_select on public.guests;
create policy guests_select on public.guests for select to authenticated
  using (app_private.is_owner(event_id) or app_private.is_admin());
drop policy if exists guests_update on public.guests;
create policy guests_update on public.guests for update to authenticated
  using (app_private.is_owner(event_id) or app_private.is_admin())
  with check (app_private.is_owner(event_id) or app_private.is_admin());
drop policy if exists guests_delete on public.guests;
create policy guests_delete on public.guests for delete to authenticated
  using (app_private.is_owner(event_id) or app_private.is_admin());

-- requests: created/approved only through RPCs
grant select, delete on public.requests to authenticated;
grant update (vip) on public.requests to authenticated;
drop policy if exists requests_select on public.requests;
create policy requests_select on public.requests for select to authenticated
  using (app_private.is_owner(event_id) or app_private.is_admin());
drop policy if exists requests_update on public.requests;
create policy requests_update on public.requests for update to authenticated
  using (app_private.is_owner(event_id) or app_private.is_admin())
  with check (app_private.is_owner(event_id) or app_private.is_admin());
drop policy if exists requests_delete on public.requests;
create policy requests_delete on public.requests for delete to authenticated
  using (app_private.is_owner(event_id) or app_private.is_admin());

-- account_limits: read own (or admin); every write through RPCs
grant select on public.account_limits to authenticated;
drop policy if exists limits_select on public.account_limits;
create policy limits_select on public.account_limits for select to authenticated
  using (uid = (select auth.uid()) or app_private.is_admin());

-- event_requests: a signed-in (non-anonymous) customer asks for another event; admin decides
grant select, insert (uid, email) on public.event_requests to authenticated;
grant update (status) on public.event_requests to authenticated;
drop policy if exists evreq_select on public.event_requests;
create policy evreq_select on public.event_requests for select to authenticated
  using (uid = (select auth.uid()) or app_private.is_admin());
drop policy if exists evreq_insert on public.event_requests;
create policy evreq_insert on public.event_requests for insert to authenticated
  with check (uid = (select auth.uid()) and status = 'pending' and not app_private.is_anon());
drop policy if exists evreq_update on public.event_requests;
create policy evreq_update on public.event_requests for update to authenticated
  using (app_private.is_admin()) with check (app_private.is_admin());

-- users: filled by a trigger (chunk 5); admin reads and deletes
grant select, delete on public.users to authenticated;
drop policy if exists users_select on public.users;
create policy users_select on public.users for select to authenticated using (app_private.is_admin());
drop policy if exists users_delete on public.users;
create policy users_delete on public.users for delete to authenticated using (app_private.is_admin());

-- slugs: claimed through an RPC; owner/admin read and release
grant select, delete on public.slugs to authenticated;
drop policy if exists slugs_select on public.slugs;
create policy slugs_select on public.slugs for select to authenticated
  using (owner_uid = (select auth.uid()) or app_private.is_admin());
drop policy if exists slugs_delete on public.slugs;
create policy slugs_delete on public.slugs for delete to authenticated
  using (owner_uid = (select auth.uid()) or app_private.is_admin());

-- scan_attempts: internal (RPC only), no policy and no grant
