# Supabase backend (staging first)

Schema, security and tests for the Supabase move (see «Backend migration» in docs/status-and-lessons.md).
Nothing here touches the live Firebase site.

## Layout
- `migrations/*.sql` — applied in name order; each is safe to re-run on staging. `9999_grants.sql` is the single place that decides who may EXECUTE what and always runs last: keep every other migration below it.
- `tests/*.sql` — `00_harness.sql` and `01_fixtures.sql` are prepended to each file; every file runs in a transaction that is never committed.
- `concurrency-test.mjs` — real parallel connections (races the in-transaction tests cannot show). Run it alone, `N=8`: the management API throttles (429) at roughly 100 calls a minute.
- Run: `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node --no-warnings supabase/run-staging.mjs [migrate|test|all]`
  (the sandbox proxy adds the management token; the endpoint returns only the last row-returning statement, so tests end with `select * from pg_temp.report();`).
- Adding a callable function: put it in `9999_grants.sql` AND in the audit lists of `tests/50_review.sql`.

## Functions (all `security definer`, `search_path = ''`; anon may call only those marked public)
| Function | Who | Result / errors the client must map |
|---|---|---|
| `start_scan_session(event, pin)` | any signed-in (door device) | `ok` / `wrong` / `locked` (per-device 10 wrong in 10 min; per-event 60/hour or 300/day) |
| `end_scan_session(event)`, `scan_session_valid(event)` | door device | void / boolean |
| `check_in(event, guest)` | session, owner, admin | `allowed` / `duplicate` / `not_found` / `no_session` |
| `door_guests(event, since, after_name, after_id, limit)`, `door_event(event)` | session, owner, admin | rows (max 1000 per call; keyset paging, see 0013; delta mode also returns deleted guests as rows with `deleted = true`, see 0016) / error `NO_SESSION` (42501); `door_event` = name, guest_count, scanned_count, `last_change` |
| `is_admin_me()` | signed-in | boolean |
| `door_alert(event)`, `reset_door_attempts(event)` | owner, admin | error `NOT_ALLOWED` |
| `add_guests(event, json, partial)` | owner, admin | `(added, blocked, ids)`; errors `NOT_ALLOWED`, `BAD_NAME`, `BAD_INPUT`, `BATCH_TOO_LARGE`, `EVENT_NOT_FOUND`; the cap trigger raises `GUEST_LIMIT_REACHED` |
| `approve_requests(event, json)` | owner, admin | `(approved[], blocked)` |
| `set_guest`, `set_guest_scanned`, `remove_guest` | owner, admin | boolean (false = no such guest) |
| `submit_request(event, req_id, name)` **public** | anyone | void; errors `BAD_REQUEST_ID`, `BAD_NAME`, `EVENT_NOT_FOUND`, `REQUESTS_FULL` |
| `get_request(event, req_id)`, `resolve_slug(slug)`, `event_public(event)` **public** | anyone | rows (empty = not found) |
| `create_event(...)`, `delete_event(event)`, `bump_event_limit()` | signed-in customer (not anonymous) | `LIMIT_REACHED`, `CEILING_REACHED`, `NO_LIMIT_ROW`, `NOT_ALLOWED` |
| `claim_slug(event, slug)`, `auto_claim_slug(event, base)` | owner (claim: admin too) | `SLUG_TAKEN`, `BAD_SLUG`, `NOT_ALLOWED` |
| `admin_set_event_limit`, `admin_approve_event_request`, `admin_delete_user` | admin | `NOT_PENDING`, `REQUEST_NOT_FOUND`, `USER_NOT_FOUND`, `CANNOT_DELETE_ADMIN`, `BAD_INPUT` |
| `list_events(after_created, after_id, limit)`, `my_account()`, `request_extra_event()` | signed-in customer (not anonymous); admin sees every event | keyset rows (created_at desc, id desc, max 1000); `(event_limit, event_count, pending_request)`; `(id, created)` idempotent while a request is pending; errors `NOT_ALLOWED`, `BAD_INPUT` |
| `admin_pending_requests()`, `admin_reject_event_request(id)`, `admin_activate_event(event, limit 1-2000)`, `admin_list_users(after_created, after_uid, limit)`, `admin_user_count()`, `admin_remove_user_record(uid)` | admin | `NOT_PENDING`, `REQUEST_NOT_FOUND`, `EVENT_NOT_FOUND`, `BAD_INPUT`; remove = list row only (true/false) |
| `event_live(event)`, `owner_guests(event, since, after_name, after_id, limit)`, `owner_requests(event, after_created, after_id, limit)` | owner, admin | `event_live` = one row (guest_count, scanned_count, last_change, pending_count, newest_pending, paid, guest_limit), zero rows when the event is gone; `owner_guests` = `door_guests` plus `registered_at` (same `deleted` tombstone rows in delta mode); `owner_requests` = pending only, oldest first (keyset created_at, id; max 1000); error `NOT_ALLOWED` |
| `reject_request(event, req_id)`, `regenerate_door_code(event)`, `remove_guests(event, ids[])`, `admin_deactivate_event(event)` | owner, admin (deactivate: admin) | boolean (false = not pending); the new 6-digit code (every door session stops); count removed (max 200 ids, else `BATCH_TOO_LARGE`); void. A rejected request stays readable through `get_request` (status `rejected`), is skipped by `approve_requests` and does not count toward the `REQUESTS_FULL` cap |

`GUEST_LIMIT_REACHED` and `REQUESTS_FULL`/`LIMIT_REACHED` are all `P0001`: the client matches on the exception message.
Timestamps come back as `timestamptz` with an offset: `data.js` must normalise with `new Date(x).toISOString()` and the door's delta-sync cursor must subtract a safety margin (~1 minute).

## Before cutover (must not be forgotten)
- **Staging has «Confirm email» turned OFF** (the Free plan's built-in mail only reaches team members). It MUST be turned back ON, with custom SMTP configured, before the cutover.
- Anonymous sign-ins are enabled on staging; the anonymous sign-in rate limit stays at Supabase's default (a venue's Wi-Fi shares one IP). **CAPTCHA (Cloudflare Turnstile) is DEFERRED until AFTER the cutover** (founder, Oct 16): the account exists, the public Site Key is `0x4AAAAAAFVTNC81WzVqutUz`; the Secret Key stays with the founder and he adds it in Supabase (Authentication -> Attack Protection) when the time comes. It will need a client change on scan.html (token passed to signInAnonymously, script loaded only while the code is entered, a clear message on failure, registered devices unaffected).
- The admin row on staging is done (hsallah@outlook.sa). Production needs the same one-time insert: `insert into app_private.admins select id from auth.users where email = 'hsallah@outlook.sa'`.
- **Plan: start on the Free plan.** Upgrading (Pro, ~USD 25/month) is NOT planned: it happens only with the founder's explicit approval, after real usage (egress, database size) has been measured. Budget limit USD 30/month total.
- The weekly cleanup of old anonymous accounts is scheduled with pg_cron (`cleanup-anonymous-users`, Sundays 03:30 UTC); check it is active on the production project.
- **Check that the weekly cleanup job `cleanup-anonymous-users` is scheduled and active on the PRODUCTION project** (pg_cron, Sundays 03:30 UTC). It also purges guest tombstones older than 7 days and rejected registration requests (30 days after the event's date, or 90 days after the rejection when the event has no valid date); without it those tables only grow.

## Management API rule
All scripts use `supabase/mgmt.mjs`, a whitelist (database/query, config/auth GET, postgrest GET, api-keys GET). Logs, analytics, advisors, usage, metrics and billing endpoints are refused in code and by tests/mgmt-guard.spec.js. Every run prints its call count and bytes. Never read Supabase logs (the «Log Query» quota was exhausted in Oct 2026).

## Free plan: automatic pause
A Free project is paused after about 7 days without activity; the whole site then cannot reach its database. Restore: dashboard -> project -> «Restore project» (a few minutes; check the banner for the deadline). See docs/status-and-lessons.md («FREE PLAN PAUSE WARNING»).
