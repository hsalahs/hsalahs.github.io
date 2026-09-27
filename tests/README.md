# Tests

Playwright UI tests that run fully offline against fake, in-memory Firebase
stubs (`tests/mocks/`) — no real Firestore project, no network access
needed. They cover the logic that has actually broken before: guest sort
order, search filtering, event-limit gating, and who can open which event.

## Running

```
npm install
npx playwright install chromium   # first time only
npm test
```

## How the stubs work

`tests/helpers.js` intercepts the three Firebase SDK URLs the app imports
(`firebase-app.js`, `firebase-auth.js`, `firebase-firestore.js`) and serves
the files in `tests/mocks/` instead — small in-memory re-implementations of
just the Firestore/Auth calls this project actually uses. Every other
external host (fonts, qrcodejs, jszip, qr-scanner) is blocked outright,
since none of these specs exercise QR-card rendering, ZIP export, or camera
scanning.

Each test calls `seedFakeFirebase(page, { user, store })` before
`page.goto()` to set the starting auth user and Firestore contents. `store`
keys are collection paths exactly as the app builds them, e.g.
`store.events = { e1: {...} }` or `store['events/e1/guests'] = { g1: {...} }`.

## What's not covered

QR/invitation card rendering (canvas drawing, the Firefox drawImage
workaround), ZIP/CSV export, and the camera scanner — these need either a
real browser canvas comparison or a real camera feed and are better checked
by hand on a device, which is how they were built and fixed originally.
