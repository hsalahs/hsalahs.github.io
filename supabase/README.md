# Supabase backend (staging first)

Schema, security and tests for the Supabase move (see «Backend migration» in docs/status-and-lessons.md).
Nothing here touches the live Firebase site.

- `migrations/*.sql` — applied in order; each is safe to re-run on staging.
- `tests/*.sql` — `00_harness.sql` is prepended to each file; every file runs in a transaction that is never committed.
- Run: `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node --no-warnings supabase/run-staging.mjs [migrate|test|all]`
  (the sandbox proxy adds the management token; the endpoint returns only the last row-returning statement, so tests end with `select * from pg_temp.report();`).

## Before cutover (must not be forgotten)
- **Staging has «Confirm email» turned OFF** (the Free plan's built-in mail only reaches team members). It MUST be turned back ON, with custom SMTP configured, before the cutover.
- Anonymous sign-ins are enabled on staging. **CAPTCHA (e.g. Cloudflare Turnstile, free) on anonymous sign-in MUST be enabled before cutover** (founder's requirement): it limits abuse of the door sessions. It needs a client change too.
- The admin row on staging is done (hsallah@outlook.sa). Production needs the same one-time insert: `insert into app_private.admins select id from auth.users where email = 'hsallah@outlook.sa'`.
