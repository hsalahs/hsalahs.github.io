-- 0099: the single place that decides who may EXECUTE what. Runs LAST on every migration run.
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
