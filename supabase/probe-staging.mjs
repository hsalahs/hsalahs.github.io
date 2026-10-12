// Environment probes the SQL tests cannot cover (reviewer's list). Read-only.
// Usage: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node --no-warnings supabase/probe-staging.mjs
const ref = process.env.SUPABASE_REF || 'gunizkapwatixvbfliva';
const api = `https://api.supabase.com/v1/projects/${ref}`;
const get = async (path) => (await fetch(api + path)).json();
const sql = async (query) => (await fetch(api + '/database/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) })).json();
let bad = 0;
const check = (name, ok, detail = '') => { console.log(ok ? 'ok  ' : 'FAIL', name, detail); if (!ok) bad++; };

const pg = await get('/postgrest');
check('Data API exposes only public (+graphql_public), never app_private', !/app_private/.test(pg.db_schema), pg.db_schema);
check('max_rows is known (paging must respect it)', Number.isFinite(pg.max_rows), String(pg.max_rows));
const pub = await sql(`select count(*)::int n from pg_publication_tables where pubname = 'supabase_realtime'`);
check('realtime publication is empty', pub[0].n === 0, `${pub[0].n} tables`);
const cron = await sql(`select count(*)::int n from cron.job where jobname = 'cleanup-anonymous-users' and active`);
check('weekly cleanup job is scheduled and active', cron[0].n === 1);
const rls = await sql(`select coalesce(string_agg(c.relname, ','), '') t from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
check('RLS is on for every public table', rls[0].t === '', rls[0].t);
const anon = await sql(`select coalesce(string_agg(p.proname, ','), '') t from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','app_private') and has_function_privilege('anon', p.oid, 'execute')`);
check('anon can execute only the four public functions', anon[0].t.split(',').sort().join() === 'event_public,get_request,resolve_slug,submit_request', anon[0].t);
const auth = await get('/config/auth');
console.log('info  mailer_autoconfirm =', auth.mailer_autoconfirm, '(must be false before cutover); anonymous users =', auth.external_anonymous_users_enabled, '; captcha =', auth.security_captcha_enabled);
process.exit(bad ? 1 : 0);
