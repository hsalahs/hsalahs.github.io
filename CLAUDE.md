# دعوات — project notes for Claude

Read this first. It replaces the memory of earlier sessions.

## What this is
An Arabic, multi-tenant digital-invitation service (weddings and other occasions). Organizers create an event, add guests (by hand, Excel/CSV import, or self-registration requests), send each guest an invitation card with a QR code, and door supervisors scan the QR at the entrance.

- Static site on **GitHub Pages** (no build step, no backend, no server). Live at `https://da3wt.com/` (custom domain, done — DNS/SSL/GitHub Pages/Firebase Auth authorized domains all set up; the old `https://hsalahs.github.io/` still works too, GitHub doesn't disable it, and that's intentional — any already-sent invite links keep working).
- **Firebase** (Firestore + Auth, v10.12.0 from the CDN), project `wedding-qr-16d01`, **Spark (free) plan**. No Cloud Functions.
- Installable as a PWA (`manifest.webmanifest`, `sw.js`); there is no app-store app.
- Pages: `index.html` (landing), `app.html` (organizer's events list, admin activation), `event.html` (one event's dashboard), `invite.html` (what a guest opens), `scan.html` (door scanner), `guide.html` (user guide).
- Shared scripts: `firebase-init.js`, `utils.js` (guest limit helpers), `format.js`, `guest-names.js` + `xlsx-names.js` (import), `xlsx-export.js` (Excel export), `attendance-report.js` (print / PDF report).
- Security lives in `firestore.rules` (guest cap, scan sessions, door code). The client is never trusted.

## The person you work with
A non-technical founder on a tight budget who **writes Arabic** (answer in Arabic, simple words, short). Standing preferences:
- **Zero bugs.** Verify everything; report failures honestly.
- **Discuss before implementing**, and give an honest recommendation, not a menu.
- **Never merge or deploy without an explicit "ادمج".** Confirm CI first.
- Check changes **on the live site** after merging.
- **Western digits (0-9) everywhere**, never Arabic-Indic digits (٠-٩). The guard in `utils.js` keeps the `٠-٩` escape; don't replace it with literal characters.
- Keep their token budget in mind: short replies, targeted tests, avoid re-reading big files.

## Interaction modes (skills the user defined — keep these across sessions)
These are standing instructions the user gave in chat for how to respond, not project facts. Re-apply them every session; don't let a context-compaction summary drop them.

1. **`how-to/` planning mode** — if a message starts with `how-to/`, or asks "كيف نسوي" / for a work plan: don't give the full solution immediately. Give a short, direct step-by-step plan first, and ask what's missing (data/decisions needed from the user) before executing.
2. **`about-me/` tone** — direct, concise answers, no preamble, unless more detail is asked for. Structure: the core point → the decision → the executable step.
3. **`skill-creator/`** — if asked to turn a task into a reusable Skill, extract a step-by-step reference template for future use.
4. **Refactoring persona** — act as a senior engineer new to a large unfamiliar codebase: first understand the structure and data flow, then identify structural problems, duplicated code, performance weak points, and maintainability issues.
5. **Debugging persona** — act as a senior production-debugging engineer: analyze precisely, think step by step, find the root cause, propose robust and sustainable fixes. Report: what the code does, and exactly what's wrong and its impact.
6. **System design + implementation persona** — act as a senior systems architect: design a scalable system, then build a minimal production-ready version. Cover: system structure, component architecture, data flow, API design, DB schema, caching.
7. **Performance optimization persona** — act as a performance engineer targeting speed, memory usage, scalability: find bottlenecks, inefficient logic, unnecessary rendering. Report: the issues found and the proposed optimization strategies.
8. **Multi-agent workflow persona** — simulate 4 collaborating roles: Architect (designs the system), Engineer (builds the code), Reviewer (watches quality), Optimizer (improves performance), and deliver integrated, high-quality work.

## Workflow (how every change ships)
1. Start from `origin/main`: `git fetch origin main && git checkout -B claude/code-review-rhjmxj origin/main`. Then `git merge -X ours origin/claude/code-review-rhjmxj` so the push fast-forwards (force-push is blocked).
2. Develop on branch `claude/code-review-rhjmxj`. Push with `git push -u origin claude/code-review-rhjmxj`.
3. Open a PR to `main` (GitHub MCP tools, not `gh`). CI runs two checks: "Page tests (Playwright)" and "Firestore security rules (emulator)".
4. Wait for the user's "ادمج". Confirm both checks are green **on the exact head sha**, then squash-merge with `expectedHeadSha`.
5. GitHub Pages caches HTML ~10 minutes: poll `curl "https://da3wt.com/<page>?nc=$RANDOM"` and grep for the new text.
6. **Firestore rules are published by the user by hand** in the Firebase Console (the deploy tool is blocked). After they publish, verify with `firebase_get_security_rules` / REST probes.

## Tests
- Page tests: `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test --workers=1 --reporter=dot` (about 6-7 minutes, 257 tests). Run a single file while developing, the full suite once before pushing.
- Rules tests (real emulator): `npm run test:rules` (117 checks; `RULES_PATH` overrides the rules file).
- Playwright uses in-memory Firebase stubs (`tests/mocks/*.stub.js`, `tests/helpers.js`: `stubFirebase`, `seedFakeFirebase`). The store resets on navigation. JSZip is served from `node_modules` via `page.route`. See `tests/README.md`.
- Tool quirks: heredocs expand `\uXXXX` (use the Write tool for escapes); avoid `pkill -f`; foreground `sleep` is blocked (use until-loops).

## Decisions and facts to keep
- **Guest limit:** free events hold 5 guests. The admin activates an event and sets its guest limit (`paid:true`, `guestLimit:n`); customers cannot set these (rules enforce it, including the "bump guestCount" requirement). Prices are agreed on WhatsApp, not in the app.
- **Door supervisors** ("مشرف الباب"): open the scan link and type a 6-digit door code; the anonymous session lives in `events/{id}/scanSessions`. Wording: "مشرفين", never "فريق الأمن".
- **Theme:** five palettes (gold, rose, emerald, sapphire, ivory). The dashboard and invitation follow the theme; the scanner follows the accents only and stays dark. The QR itself is always black on light.
- **Not building:** a "plan label", and the human services (event-day support, field supervisors).
- **Deferred:** event-type field, time / organizer / notes fields, party-size cards and open registration, App Check (no budget), landing "install hint".
- **`main` is now branch-protected** (classic rule, user set it up): requires a PR + both the "Page tests (Playwright)" and "Firestore security rules (emulator)" status checks to pass before merging. No required-approvals rule (the user is the only account, so self-approval would be impossible).
- **Domain:** `da3wt.com`, registered via Sahara Net — done (see above). Registrar portal: Registrar Lock is on, auto-renew is on, ICANN verification done.
- **guestCount can now decrease:** deleting a guest frees up their slot (business decision — the cap means "current guest count", not "total ever added"). `event.html`'s `deleteGuest()` does this in a transaction (delete + decrement together); `firestore.rules` has a matching owner-only, -1-only rule next to the scannedCount one.
- **⚠️ Needs revisiting — the user flagged this specifically:** the guestCount-decrement rule is NOT tied to an actual guest being deleted. A technically savvy customer could manually call the decrement (dev tools / raw API) without deleting a real guest, then add a replacement — repeating this to gradually add more guests than agreed, bypassing the cap over time even though no single moment exceeds it. Accepted for now as a low-stakes trade-off (small, non-adversarial customer base, informal WhatsApp-agreed pricing), but the user wants to come back to this — options to properly close it: tie the decrement to a real guest deletion via a cross-document rule check (more rules complexity), or accept and monitor.
- **Not yet done: a full logged-in customer walkthrough on the live site** (sign up → create event → add guest → view invite → scan a QR) — only the public pages (landing, login screen, guide) have been visually checked on `da3wt.com` so far. Needs either a disposable test account the user creates and shares, or the user doing it themselves and sending screenshots.

## Open problem: Firebase read quota
- **Blaze (paid) is not available to the user**: billing addresses in Saudi Arabia must go through the reseller CNTXT and need a commercial registration. Stay on Spark (about 50k reads/day for the whole project; when it runs out everything stops until the daily reset).
- The user already hit the limit once with ~700 guests and many refreshes.
- **Done:** (1) persistent local cache in `firebase-init.js`. (2) the guest's barcode code is now its own Firestore document id (event.html's three guest-creation paths), so scan.html checks a guest in with one direct `doc()`/transaction, no collection read, no live listener on `guests` at all. (3) the scanner's "تم الدخول: X / Y" counter reads `events/{id}.guestCount` / `.scannedCount` via one cheap document listener (`startEventCounterWatch` in scan.html); `scannedCount` is bumped in the same transaction as the guest's `scanned` flip, and `firestore.rules` has a matching `hasScanSession`-only, +1-only rule for it.
- **Remaining:** measure real read counts at 1000 and 5000 guests before promising anything to a customer.
- Known residual risks already told to the user: rules cannot count documents, so a crafted batch could exceed the cap; the 6-digit door code has no rate limit; saved or sent cards keep their old colours after a theme change; real invitations have no stored event type.

## Conventions
- Match the surrounding code: comment density, naming, Arabic UI text.
- Don't delete files or user data. Files ignored by git (`node_modules/`, `test-results/`, `*-debug.log`) stay local.
- Don't put model names in commits, PRs or code comments.
