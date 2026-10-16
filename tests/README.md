# Tests

Playwright UI tests that run fully offline against a fake, in-memory
Supabase stub (`tests/mocks/supabase.stub.js`) — no real Supabase project,
no network access needed. They cover the logic that has actually broken
before: guest sort order, search filtering, event-limit gating, door
check-in, and who can open which event. The real database rules are tested
separately by the SQL suite in `supabase/tests` (see `supabase/README.md`).

## Running

```
npm install
npx playwright install chromium   # first time only
npm test
```

## How the stubs work

`tests/helpers.js` serves `tests/mocks/supabase.stub.js` in place of the
vendored Supabase client: a small in-memory re-implementation of the RPC,
table and Auth calls `data.js` actually makes. Every other external host
(fonts, qrcodejs, jszip, qr-scanner) is blocked outright unless a spec
routes it.

Each test calls `seedFakeSupabase(page, { user, events, ... })` (or one of
the wrappers `seedInviteStore`, `seedScan`, `seedAppStore`, `seedEvent`)
before `page.goto()` to set the starting auth user and table contents.
The `stubFirebase` / `seedFakeFirebase` helpers and `tests/mocks/firebase-*.stub.js`
are kept only for the rollback files; no spec uses them.

## What's not covered

QR/invitation card rendering (canvas drawing, the Firefox drawImage
workaround), ZIP/CSV export, and the camera scanner — these need either a
real browser canvas comparison or a real camera feed and are better checked
by hand on a device, which is how they were built and fixed originally.
