// Applies supabase/migrations/*.sql (in order) and then runs supabase/tests/*.sql
// on the staging project through the management SQL endpoint.
// The proxy in the sandbox injects the Bearer token, so no key is needed here.
// Usage: node supabase/run-staging.mjs [migrate|test|all]   (default: all)
// A test file ends with `select * from pg_temp.report();` (the endpoint returns only the
// last statement that gives rows, so the report is always one row: total + failures).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ref = process.env.SUPABASE_REF || 'gunizkapwatixvbfliva';
const url = `https://api.supabase.com/v1/projects/${ref}/database/query`;
const root = dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] || 'all';

async function sql(query) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${body.slice(0, 600)}`);
  return JSON.parse(body);
}

const files = (dir) =>
  readdirSync(join(root, dir)).filter((f) => f.endsWith('.sql')).sort();

let failed = 0;
if (mode === 'migrate' || mode === 'all') {
  for (const f of files('migrations')) {
    try {
      await sql(readFileSync(join(root, 'migrations', f), 'utf8'));
      console.log('migrated', f);
    } catch (e) {
      console.log('MIGRATION FAILED', f, e.message);
      process.exit(1);
    }
  }
}
if (mode === 'test' || mode === 'all') {
  for (const f of files('tests')) {
    if (/^0\d_/.test(f)) continue; // 00_ harness, 01_ fixtures: prepended to each test
    const harness = files('tests').filter((x) => /^0\d_/.test(x))
      .map((x) => readFileSync(join(root, 'tests', x), 'utf8')).join('\n');
    const body = readFileSync(join(root, 'tests', f), 'utf8');
    try {
      const rows = await sql(harness + '\n' + body);
      const { total, failures } = rows[0] || {};
      const bad = failures || [];
      console.log(bad.length ? 'FAIL' : 'ok  ', f, `${total} checks`, bad.length ? JSON.stringify(bad) : '');
      failed += bad.length || (total ? 0 : 1);
    } catch (e) {
      console.log('ERROR', f, e.message);
      failed++;
    }
  }
}
process.exit(failed ? 1 : 0);
