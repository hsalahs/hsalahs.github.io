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
| `door_guests(event, since)`, `door_event(event)` | session, owner, admin | rows / error `NO_SESSION` (42501) |
| `door_alert(event)`, `reset_door_attempts(event)` | owner, admin | error `NOT_ALLOWED` |
| `add_guests(event, json, partial)` | owner, admin | `(added, blocked, ids)`; errors `NOT_ALLOWED`, `BAD_NAME`, `BAD_INPUT`, `BATCH_TOO_LARGE`, `EVENT_NOT_FOUND`; the cap trigger raises `GUEST_LIMIT_REACHED` |
| `approve_requests(event, json)` | owner, admin | `(approved[], blocked)` |
| `set_guest`, `set_guest_scanned`, `remove_guest` | owner, admin | boolean (false = no such guest) |
| `submit_request(event, req_id, name)` **public** | anyone | void; errors `BAD_REQUEST_ID`, `BAD_NAME`, `EVENT_NOT_FOUND`, `REQUESTS_FULL` |
| `get_request(event, req_id)`, `resolve_slug(slug)`, `event_public(event)` **public** | anyone | rows (empty = not found) |
| `create_event(...)`, `delete_event(event)`, `bump_event_limit()` | signed-in customer (not anonymous) | `LIMIT_REACHED`, `CEILING_REACHED`, `NO_LIMIT_ROW`, `NOT_ALLOWED` |
| `claim_slug(event, slug)`, `auto_claim_slug(event, base)` | owner (claim: admin too) | `SLUG_TAKEN`, `BAD_SLUG`, `NOT_ALLOWED` |
| `admin_set_event_limit`, `admin_approve_event_request`, `admin_delete_user` | admin | `NOT_PENDING`, `REQUEST_NOT_FOUND`, `USER_NOT_FOUND`, `CANNOT_DELETE_ADMIN`, `BAD_INPUT` |

`GUEST_LIMIT_REACHED` and `REQUESTS_FULL`/`LIMIT_REACHED` are all `P0001`: the client matches on the exception message.
Timestamps come back as `timestamptz` with an offset: `data.js` must normalise with `new Date(x).toISOString()` and the door's delta-sync cursor must subtract a safety margin (~1 minute).

## Before cutover (must not be forgotten)
- **Staging has «Confirm email» turned OFF** (the Free plan's built-in mail only reaches team members). It MUST be turned back ON, with custom SMTP configured, before the cutover.
- Anonymous sign-ins are enabled on staging; the anonymous sign-in rate limit stays at Supabase's default (a venue's Wi-Fi shares one IP). **CAPTCHA (e.g. Cloudflare Turnstile, free) on anonymous sign-in MUST be enabled before cutover** (founder's requirement); it needs a client change too.
- The admin row on staging is done (hsallah@outlook.sa). Production needs the same one-time insert: `insert into app_private.admins select id from auth.users where email = 'hsallah@outlook.sa'`.
- Pro plan (~USD 25/month, inside the USD 30 limit) only at cutover, and only with the founder's approval.
- The weekly cleanup of old anonymous accounts is scheduled with pg_cron (`cleanup-anonymous-users`, Sundays 03:30 UTC); check it is active on the production project.
