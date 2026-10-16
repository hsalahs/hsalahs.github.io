// The ONLY way our scripts talk to the Supabase Management API. A whitelist, so that no tool, script or agent can
// ever read logs, analytics, advisors or usage (founder's rule; the project hit its «Log Query» quota in Oct 2026).
// Anything else throws before a request leaves the machine. Every run prints how many calls it made and how many
// response bytes it received, so a surprise would be visible.
const ALLOWED = [
  ['POST', /^\/database\/query$/],
  ['GET', /^\/config\/auth$/],
  ['GET', /^\/postgrest$/],
  ['GET', /^\/api-keys$/],
];
const FORBIDDEN = /log|analytic|advisor|usage|metric|report|health|billing/i;
let calls = 0, bytes = 0;

export const ref = process.env.SUPABASE_REF || 'gunizkapwatixvbfliva';
export const base = `https://api.supabase.com/v1/projects/${ref}`;

export function allowed(method, path) {
  const p = path.split('?')[0];
  return !FORBIDDEN.test(p) && ALLOWED.some(([m, re]) => m === method && re.test(p));
}

// path is relative to the project, e.g. '/database/query'. Returns the Response (body already buffered for counting).
export async function mgmt(method, path, body) {
  if (!allowed(method, path)) throw new Error(`mgmt: ${method} ${path} is not allowed (logs/analytics/advisors are forbidden)`);
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  calls++; bytes += text.length;
  return { status: res.status, ok: res.ok, text, json: () => JSON.parse(text) };
}

process.on('exit', () => { if (calls) console.error(`[mgmt] ${calls} management-API calls, ${(bytes / 1024).toFixed(1)} KB received (no logs endpoints can be called)`); });
