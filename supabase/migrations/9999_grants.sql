-- 9999: the single place that decides who may EXECUTE what. Runs LAST on every migration run (files sort by name: keep every other migration below 9999).
-- Functions get EXECUTE for PUBLIC/anon by default in Postgres/Supabase, so everything is
-- revoked here and only the whitelist below is granted back. Every later chunk that adds a
-- callable function must add it to this list AND to tests/50_review.sql (the audit test).
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema app_private from public, anon, authenticated;

-- used by RLS policies and by the RPCs
grant execute on function app_private.is_anon(), app_private.is_admin(), app_private.is_owner(text),
  app_private.has_scan_session(text), app_private.can_door(text) to authenticated;

-- door RPCs (anonymous door devices are role authenticated)
grant execute on function public.start_scan_session(text, text), public.end_scan_session(text),
  public.scan_session_valid(text), public.check_in(text, text), public.door_guests(text, timestamptz),
  public.door_event(text), public.reset_door_attempts(text), public.door_alert(text) to authenticated;

-- guests and requests (chunk 4). add_guests / approve_requests check ownership inside.
grant execute on function public.add_guests(text, jsonb, boolean), public.approve_requests(text, jsonb) to authenticated;
-- public: the invite page (guest may be signed in or not)
grant execute on function public.submit_request(text, text, text), public.get_request(text, text) to anon, authenticated;

-- events, limits, admin (chunk 5): every function checks its caller inside
grant execute on function public.create_event(text, text, text, text, text, text, text), public.delete_event(text),
  public.bump_event_limit(), public.admin_set_event_limit(uuid, integer), public.admin_approve_event_request(uuid),
  public.admin_delete_user(uuid) to authenticated;

-- slugs and the public event read (chunk 6)
grant execute on function public.claim_slug(text, text), public.auto_claim_slug(text, text) to authenticated;
grant execute on function public.resolve_slug(text), public.event_public(text) to anon, authenticated;

-- guest writes with a fixed lock order (0010)
grant execute on function public.set_guest(text, text, text, boolean), public.set_guest_scanned(text, text, boolean),
  public.remove_guest(text, text) to authenticated;
