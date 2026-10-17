// The Supabase management helper must never be able to read logs, analytics, advisors or usage
// (the founder's rule after the «Log Query» quota was hit), and no script may call the API any other way.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

test('only the four whitelisted management calls are allowed; everything log-like is refused', async () => {
  const { allowed } = await import('../supabase/mgmt.mjs');
  expect(allowed('POST', '/database/query')).toBe(true);
  expect(allowed('GET', '/config/auth')).toBe(true);
  expect(allowed('GET', '/postgrest')).toBe(true);
  expect(allowed('GET', '/api-keys')).toBe(true);
  for (const [m, p] of [
    ['GET', '/analytics/endpoints/logs.all'], ['POST', '/analytics/endpoints/logs.all'], ['GET', '/logs'], ['GET', '/advisors/security'],
    ['GET', '/analytics/endpoints/usage.api-counts'], ['GET', '/health'], ['GET', '/billing/addons'], ['PATCH', '/config/auth'],
    ['GET', '/database/query'], ['POST', '/config/auth'], ['DELETE', '/database/query'], ['GET', '/'],
  ]) expect(allowed(m, p), `${m} ${p}`).toBe(false);
});

test('no script under supabase/ talks to the management API or the project except through mgmt.mjs', async () => {
  const dir = path.join(__dirname, '..', 'supabase');
  const offenders = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(mjs|cjs|js|sh)$/.test(f) || f === 'mgmt.mjs') continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const code = src.replace(/^\s*(\/\/|#).*$/gm, '');
    if (/api\.supabase\.com/.test(code)) offenders.push(f);
    // the load-test runner runs on a GitHub runner with the public key only, over the project's own REST/Auth URL
    else if (f !== 'load-run.mjs' && /\bfetch\(|curl\b/.test(code)) offenders.push(f);
  }
  expect(offenders).toEqual([]);
});
