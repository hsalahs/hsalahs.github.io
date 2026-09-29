// Runs firestore.rules against the real Firestore emulator and checks the
// door-scanner security model end to end. Run with `npm run test:rules`
// (needs Java for the emulator). RULES_PATH overrides which rules file is
// tested — handy for proving this suite fails against older, weaker rules.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';

// A denied write is the expected outcome of most checks here; the SDK logs
// each one as an error, which buries the actual results.
firebase.setLogLevel('silent');

const here = path.dirname(fileURLToPath(import.meta.url));
const RULES = fs.readFileSync(process.env.RULES_PATH || path.join(here, '..', 'firestore.rules'), 'utf8');
const ADMIN_EMAIL = 'hsallah@outlook.sa';

const testEnv = await initializeTestEnvironment({
  projectId: 'demo-rules-test',
  firestore: { rules: RULES, host: '127.0.0.1', port: 8080 },
});

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.log('  ✗', name, '\n      ', String(e && e.message || e).split('\n')[0]); }
}

await testEnv.clearFirestore();
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await db.doc('events/e1').set({ name: 'E1', ownerUid: 'owner1', paid: true, guestCount: 2 });
  await db.doc('events/e1/private/scan').set({ scanPin: '1234' });
  await db.doc('events/e1/guests/g1').set({ id: 'WD-1', name: 'A', scanned: false });
  await db.doc('events/e1/guests/g2').set({ id: 'WD-2', name: 'B', scanned: false });
  await db.doc('events/e1/requests/r1').set({ name: 'R', reqId: 'REQ-1', status: 'pending', createdAt: 'x' });
  // Legacy event: code still on the event doc, no private doc yet.
  await db.doc('events/e2').set({ name: 'E2', ownerUid: 'owner1', paid: true, guestCount: 1, scanPin: '9999' });
  await db.doc('events/e2/guests/g1').set({ id: 'WD-L1', name: 'L', scanned: false });
});

const unauth = () => testEnv.unauthenticatedContext().firestore();
// Anonymous sign-in: a uid with no email claim at all.
const anon = (uid) => testEnv.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous' } }).firestore();
const user = (uid, email) => testEnv.authenticatedContext(uid, { email }).firestore();
const owner = () => user('owner1', 'owner@example.com');
const admin = () => user('admin1', ADMIN_EMAIL);

console.log('\nno session:');
await check('anyone can read the event doc (name/date for the invite and scan pages)', () => assertSucceeds(unauth().doc('events/e1').get()));
await check('unauthenticated: cannot read the private door code', () => assertFails(unauth().doc('events/e1/private/scan').get()));
await check('unauthenticated: cannot list the guests', () => assertFails(unauth().collection('events/e1/guests').get()));
await check('unauthenticated: cannot flip a guest to checked-in (the old public hole)', () => assertFails(unauth().doc('events/e1/guests/g1').update({ scanned: true, scannedAt: 'now' })));
await check('anonymous device without a session: cannot list guests', () => assertFails(anon('dev1').collection('events/e1/guests').get()));
await check('anonymous device without a session: cannot check anyone in', () => assertFails(anon('dev1').doc('events/e1/guests/g1').update({ scanned: true, scannedAt: 'now' })));
await check('anonymous device: cannot read the private door code', () => assertFails(anon('dev1').doc('events/e1/private/scan').get()));
await check('anonymous device: cannot read a single guest doc either', () => assertFails(anon('dev1').doc('events/e1/guests/g1').get()));

console.log('\nproving the code:');
await check('a wrong code is rejected', () => assertFails(anon('dev1').doc('events/e1/scanSessions/dev1').set({ pin: '0000', createdAt: 'x' })));
await check('a session doc under someone else\'s uid is rejected even with the right code', () => assertFails(anon('dev1').doc('events/e1/scanSessions/dev2').set({ pin: '1234', createdAt: 'x' })));
await check('extra fields on the session doc are rejected', () => assertFails(anon('dev1').doc('events/e1/scanSessions/dev1').set({ pin: '1234', createdAt: 'x', admin: true })));
await check('a non-string code is rejected', () => assertFails(anon('dev1').doc('events/e1/scanSessions/dev1').set({ pin: 1234, createdAt: 'x' })));
await check('the right code creates the session', () => assertSucceeds(anon('dev1').doc('events/e1/scanSessions/dev1').set({ pin: '1234', createdAt: 'x' })));
await check('the device can read its own session back', () => assertSucceeds(anon('dev1').doc('events/e1/scanSessions/dev1').get()));
await check('another device cannot read that session', () => assertFails(anon('dev2').doc('events/e1/scanSessions/dev1').get()));
await check('with a session: can list guests', () => assertSucceeds(anon('dev1').collection('events/e1/guests').get()));
await check('with a session: can check a guest in (false -> true)', () => assertSucceeds(anon('dev1').doc('events/e1/guests/g1').update({ scanned: true, scannedAt: 'now' })));
await check('with a session: the same through a transaction, as scan.html does', () => {
  const db = anon('dev1');
  return assertSucceeds(db.runTransaction(async (tx) => {
    const ref = db.doc('events/e1/guests/g2');
    const snap = await tx.get(ref);
    if (!snap.data().scanned) tx.update(ref, { scanned: true, scannedAt: 'now' });
  }));
});
await check('with a session: cannot undo a check-in (true -> false)', () => assertFails(anon('dev1').doc('events/e1/guests/g1').update({ scanned: false })));
await check('with a session: cannot edit anything else on a guest', () => assertFails(anon('dev1').doc('events/e1/guests/g1').update({ name: 'X' })));
await check('with a session: cannot delete a guest', () => assertFails(anon('dev1').doc('events/e1/guests/g1').delete()));
await check('with a session: cannot add a guest', () => assertFails(anon('dev1').doc('events/e1/guests/g9').set({ id: 'WD-9', name: 'Z', scanned: false })));
await check('with a session: still cannot read the private door code', () => assertFails(anon('dev1').doc('events/e1/private/scan').get()));

console.log('\nrevocation:');
await check('the owner can change the code', () => assertSucceeds(owner().doc('events/e1/private/scan').set({ scanPin: '5678' })));
await check('after the change: the old session can no longer be read back', () => assertFails(anon('dev1').doc('events/e1/scanSessions/dev1').get()));
await check('after the change: cannot list guests', () => assertFails(anon('dev1').collection('events/e1/guests').get()));
await check('after the change: cannot check anyone in', async () => {
  await testEnv.withSecurityRulesDisabled(ctx => ctx.firestore().doc('events/e1/guests/g3').set({ id: 'WD-3', name: 'C', scanned: false }));
  await assertFails(anon('dev1').doc('events/e1/guests/g3').update({ scanned: true, scannedAt: 'now' }));
});
await check('re-proving with the new code (overwriting the session) works', () => assertSucceeds(anon('dev1').doc('events/e1/scanSessions/dev1').set({ pin: '5678', createdAt: 'y' })));
await check('the device can delete its own session (logout)', () => assertSucceeds(anon('dev1').doc('events/e1/scanSessions/dev1').delete()));
await check('a device cannot delete another device\'s session', async () => {
  await assertSucceeds(anon('dev5').doc('events/e1/scanSessions/dev5').set({ pin: '5678', createdAt: 'y' }));
  await assertFails(anon('dev1').doc('events/e1/scanSessions/dev5').delete());
});

console.log('\nowner / admin / other users:');
await check('the owner can read the door code', () => assertSucceeds(owner().doc('events/e1/private/scan').get()));
await check('the owner can list guests without a session', () => assertSucceeds(owner().collection('events/e1/guests').get()));
await check('the owner can list scan sessions', () => assertSucceeds(owner().collection('events/e1/scanSessions').get()));
await check('the owner can remove a device\'s session', () => assertSucceeds(owner().doc('events/e1/scanSessions/dev5').delete()));
await check('the owner can remove the legacy code field from the event doc (migration)', () => assertSucceeds(owner().doc('events/e2').update({ scanPin: firebase.firestore.FieldValue.delete() })));
await check('the admin can read the door code', () => assertSucceeds(admin().doc('events/e1/private/scan').get()));
await check('the admin can list guests', () => assertSucceeds(admin().collection('events/e1/guests').get()));
await check('a different signed-in customer cannot read the door code', () => assertFails(user('u9', 'other@example.com').doc('events/e1/private/scan').get()));
await check('a different signed-in customer cannot list the guests', () => assertFails(user('u9', 'other@example.com').collection('events/e1/guests').get()));
await check('a different signed-in customer cannot write the door code', () => assertFails(user('u9', 'other@example.com').doc('events/e1/private/scan').set({ scanPin: '1111' })));

console.log('\nlegacy event (code still on the event doc, not yet migrated):');
await testEnv.withSecurityRulesDisabled(ctx => ctx.firestore().doc('events/e2').set({ name: 'E2', ownerUid: 'owner1', paid: true, guestCount: 1, scanPin: '9999' }));
await check('a device can still prove the legacy code', () => assertSucceeds(anon('dev3').doc('events/e2/scanSessions/dev3').set({ pin: '9999', createdAt: 'x' })));
await check('and then list guests and check in', async () => {
  await assertSucceeds(anon('dev3').collection('events/e2/guests').get());
  await assertSucceeds(anon('dev3').doc('events/e2/guests/g1').update({ scanned: true, scannedAt: 'now' }));
});
await check('a wrong legacy code is rejected', () => assertFails(anon('dev4').doc('events/e2/scanSessions/dev4').set({ pin: '0000', createdAt: 'x' })));

console.log('\nrequests (RSVP flow):');
await check('anyone can submit an RSVP', () => assertSucceeds(unauth().collection('events/e1/requests').add({ name: 'N', reqId: 'REQ-2', status: 'pending', createdAt: 'x' })));
await check('the owner can approve it and copy the guestId onto it', () => assertSucceeds(owner().doc('events/e1/requests/r1').update({ status: 'approved', guestId: 'WD-1' })));
await check('a stranger cannot approve it', () => assertFails(unauth().doc('events/e1/requests/r1').update({ status: 'approved' })));

await testEnv.cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
