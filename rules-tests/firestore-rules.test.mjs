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

console.log('\nthe scanner\'s live door counter (events/{id}.scannedCount):');
await check('unauthenticated: cannot bump the counter', () => assertFails(unauth().doc('events/e1').update({ scannedCount: 1 })));
await check('anonymous device without a session: cannot bump the counter', () => assertFails(anon('nosession').doc('events/e1').update({ scannedCount: 1 })));
await check('with a session: can bump the counter from unset to 1', () => assertSucceeds(anon('dev1').doc('events/e1').update({ scannedCount: 1 })));
await check('with a session: can bump it again, by exactly 1', () => assertSucceeds(anon('dev1').doc('events/e1').update({ scannedCount: 2 })));
await check('with a session: cannot jump by more than 1', () => assertFails(anon('dev1').doc('events/e1').update({ scannedCount: 10 })));
await check('with a session: cannot leave it unchanged', () => assertFails(anon('dev1').doc('events/e1').update({ scannedCount: 2 })));
await check('with a session: cannot decrease it', () => assertFails(anon('dev1').doc('events/e1').update({ scannedCount: 1 })));
await check('with a session: cannot bump the counter together with any other field', () => assertFails(anon('dev1').doc('events/e1').update({ scannedCount: 3, name: 'hacked' })));
await check('with a session: cannot use this path to touch guestCount instead', () => assertFails(anon('dev1').doc('events/e1').update({ guestCount: 99 })));

console.log('\nfreeing up a guest slot after a delete (events/{id}.guestCount, owner-only, -1 only):');
// e1 is still ownerUid 'owner1', guestCount: 2 at this point — untouched by
// the scannedCount checks above.
await check('unauthenticated: cannot decrement it', () => assertFails(unauth().doc('events/e1').update({ guestCount: 1 })));
await check('a different signed-in customer cannot decrement it', () => assertFails(user('u9', 'other@example.com').doc('events/e1').update({ guestCount: 1 })));
await check('a scan-session device cannot decrement it (not the owner)', () => assertFails(anon('dev1').doc('events/e1').update({ guestCount: 1 })));
await check('the owner cannot jump it down by more than 1', () => assertFails(owner().doc('events/e1').update({ guestCount: 0 })));
await check('the owner cannot bundle the decrement with another field', () => assertFails(owner().doc('events/e1').update({ guestCount: 1, name: 'hacked' })));
await check('the owner CAN decrement it by exactly 1, alone, after deleting a guest', () => assertSucceeds(owner().doc('events/e1').update({ guestCount: 1 })));
await check('...and again, down to 0', () => assertSucceeds(owner().doc('events/e1').update({ guestCount: 0 })));
await check('...but not past 0', () => assertFails(owner().doc('events/e1').update({ guestCount: -1 })));
await check('writing 0 again at the floor is a harmless no-op, still allowed', () => assertSucceeds(owner().doc('events/e1').update({ guestCount: 0 })));
await check('the general "edit event details" rule still refuses to smuggle a guestCount decrease alongside another field', () => assertFails(owner().doc('events/e1').update({ name: 'New name', guestCount: -5 })));

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

console.log('\nrequests (RSVP flow) — a guest opens their own request by its secret id; nobody lists them:');
const REQ_A = 'REQ-' + 'A1B2C3D4E5F60718293A4B5C6D7E8F90'; // what invite.html generates: REQ- + 32 hex
const REQ_B = 'REQ-' + '0F9E8D7C6B5A49382716051423324150';
await check('anyone can register, when the document is named after the request id', () => assertSucceeds(unauth().doc('events/e1/requests/' + REQ_A).set({ name: 'A', reqId: REQ_A, status: 'pending', createdAt: 'x' })));
await check('a second guest registers too', () => assertSucceeds(unauth().doc('events/e1/requests/' + REQ_B).set({ name: 'B', reqId: REQ_B, status: 'pending', createdAt: 'x' })));
await check('registering under an auto-generated id (not the request id) is rejected', () => assertFails(unauth().collection('events/e1/requests').add({ name: 'N', reqId: 'REQ-2', status: 'pending', createdAt: 'x' })));
await check('a document name that differs from the reqId inside it is rejected', () => assertFails(unauth().doc('events/e1/requests/' + REQ_A + 'X').set({ name: 'A', reqId: REQ_A, status: 'pending', createdAt: 'x' })));
await check('a short, guessable id is rejected even when it matches', () => assertFails(unauth().doc('events/e1/requests/REQ-1234').set({ name: 'A', reqId: 'REQ-1234', status: 'pending', createdAt: 'x' })));
await check('extra fields on a request are rejected', () => assertFails(unauth().doc('events/e1/requests/REQ-' + 'C'.repeat(32)).set({ name: 'A', reqId: 'REQ-' + 'C'.repeat(32), status: 'pending', createdAt: 'x', guestId: 'WD-FAKE' })));
await check('a request that arrives already approved is rejected', () => assertFails(unauth().doc('events/e1/requests/REQ-' + 'D'.repeat(32)).set({ name: 'A', reqId: 'REQ-' + 'D'.repeat(32), status: 'approved', createdAt: 'x' })));
await check('a guest can open their own request by its exact id (status, and the card once approved)', () => assertSucceeds(unauth().doc('events/e1/requests/' + REQ_A).get()));
await check('a signed-in door device can open one by id as well (same rule for everyone)', () => assertSucceeds(anon('dev1').doc('events/e1/requests/' + REQ_A).get()));
await check('unauthenticated: cannot list the requests (names of everyone who registered)', () => assertFails(unauth().collection('events/e1/requests').get()));
await check('unauthenticated: cannot list them with a filter either', () => assertFails(unauth().collection('events/e1/requests').where('status', '==', 'approved').get()));
await check('unauthenticated: cannot list them by asking for a reqId', () => assertFails(unauth().collection('events/e1/requests').where('reqId', '==', REQ_A).get()));
await check('an anonymous device (with a valid door session) cannot list them', () => assertFails(anon('dev1').collection('events/e1/requests').get()));
await check('a different signed-in customer cannot list them', () => assertFails(user('u9', 'other@example.com').collection('events/e1/requests').get()));
await check('the owner can list them', () => assertSucceeds(owner().collection('events/e1/requests').get()));
await check('the owner can list the approved ones (the guestId backfill query)', () => assertSucceeds(owner().collection('events/e1/requests').where('status', '==', 'approved').get()));
await check('the admin can list them', () => assertSucceeds(admin().collection('events/e1/requests').get()));
await check('the owner can approve one and copy the guestId onto it', () => assertSucceeds(owner().doc('events/e1/requests/' + REQ_A).update({ status: 'approved', guestId: 'WD-1' })));
await check('an approved request shows its guestId to whoever holds the id', async () => {
  const snap = await assertSucceeds(unauth().doc('events/e1/requests/' + REQ_A).get());
  if (snap.data().guestId !== 'WD-1') throw new Error('guestId not visible to the id holder');
});
await check('the owner can still approve an older request that has an auto-generated id', () => assertSucceeds(owner().doc('events/e1/requests/r1').update({ status: 'approved', guestId: 'WD-OLD' })));
await check('a stranger cannot approve one', () => assertFails(unauth().doc('events/e1/requests/' + REQ_B).update({ status: 'approved' })));
await check('a stranger cannot delete one', () => assertFails(unauth().doc('events/e1/requests/' + REQ_B).delete()));
await check('another registered guest cannot approve their own request', () => assertFails(unauth().doc('events/e1/requests/' + REQ_B).update({ status: 'approved', guestId: 'WD-FAKE' })));

console.log('\naccount limits (one-event-per-customer bookkeeping):');
await check('a customer can bootstrap their own doc on their first event', () => assertSucceeds(user('cust1', 'c1@example.com').doc('accountLimits/cust1').set({ eventLimit: 1, eventCount: 1 })));
await check('a customer cannot bootstrap their own doc with a higher limit', () => assertFails(user('cust2', 'c2@example.com').doc('accountLimits/cust2').set({ eventLimit: 5, eventCount: 1 })));
await check('a customer cannot create a doc for someone else', () => assertFails(user('cust3', 'c3@example.com').doc('accountLimits/cust4').set({ eventLimit: 1, eventCount: 1 })));
await check('an unauthenticated visitor cannot create one', () => assertFails(unauth().doc('accountLimits/cust5').set({ eventLimit: 1, eventCount: 1 })));
await check('the admin can create one for a customer with no doc yet (approving an extra-event request)', () => assertSucceeds(admin().doc('accountLimits/cust6').set({ eventLimit: 2, eventCount: 0 })));

console.log('\nusers (mirrors every signup so the admin can see accounts that never created an event):');
await check('a customer can create their own signup record', () => assertSucceeds(user('signee1', 's1@example.com').doc('users/signee1').set({ email: 's1@example.com', createdAt: 'x' })));
await check('a customer cannot create a signup record for someone else', () => assertFails(user('signee2', 's2@example.com').doc('users/signee3').set({ email: 's2@example.com', createdAt: 'x' })));
await check('an unauthenticated visitor cannot create one', () => assertFails(unauth().doc('users/signee4').set({ email: 'x@example.com', createdAt: 'x' })));
await check('extra fields are rejected', () => assertFails(user('signee5', 's5@example.com').doc('users/signee5').set({ email: 's5@example.com', createdAt: 'x', admin: true })));
await check('a customer cannot read their own signup record', () => assertFails(user('signee1', 's1@example.com').doc('users/signee1').get()));
await check('a stranger cannot read someone else\'s signup record', () => assertFails(user('signee6', 's6@example.com').doc('users/signee1').get()));
await check('the admin can read any signup record', () => assertSucceeds(admin().doc('users/signee1').get()));
await check('a customer cannot delete their own signup record', () => assertFails(user('signee1', 's1@example.com').doc('users/signee1').delete()));
await check('a stranger cannot delete someone else\'s signup record', () => assertFails(user('signee6', 's6@example.com').doc('users/signee1').delete()));
await check('the admin can delete a signup record (tidying the list)', () => assertSucceeds(admin().doc('users/signee1').delete()));
await check('the admin can list every signup record', () => assertSucceeds(admin().collection('users').get()));

console.log('\nguest limits (5 free; beyond that the number the admin sets; nothing else):');
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await db.doc('events/lim_free').set({ name: 'F', ownerUid: 'owner1', paid: false, guestCount: 4 });
  await db.doc('events/lim_full').set({ name: 'F', ownerUid: 'owner1', paid: false, guestCount: 5 });
  await db.doc('events/lim_two').set({ name: 'F', ownerUid: 'owner1', paid: false, guestCount: 2 });
  await db.doc('events/lim_50').set({ name: 'L', ownerUid: 'owner1', paid: true, guestLimit: 50, guestCount: 49 });
  await db.doc('events/lim_50full').set({ name: 'L', ownerUid: 'owner1', paid: true, guestLimit: 50, guestCount: 50 });
  await db.doc('events/lim_legacy').set({ name: 'O', ownerUid: 'owner1', paid: true, guestCount: 900 });
  await db.doc('events/lim_nocount').set({ name: 'N', ownerUid: 'owner1', paid: false });
  await db.doc('events/lim_door').set({ name: 'D', ownerUid: 'owner1', paid: true, guestLimit: 50, guestCount: 1 });
  await db.doc('events/lim_door/private/scan').set({ scanPin: '555555' });
});
// What event.html does: the guest write and the counter bump in ONE transaction.
const addGuests = (db, eventId, n, newCount) => db.runTransaction(async (tx) => {
  for (let i = 0; i < n; i++) tx.set(db.collection('events/' + eventId + '/guests').doc('x' + i + Math.random().toString(36).slice(2)), { id: 'WD-' + i, name: 'G' + i, scanned: false });
  tx.update(db.doc('events/' + eventId), { guestCount: newCount });
});
await check('free tier: the 5th guest is allowed', () => assertSucceeds(addGuests(owner(), 'lim_free', 1, 5)));
await check('free tier: the 6th guest is refused', () => assertFails(addGuests(owner(), 'lim_full', 1, 6)));
await check('free tier: writing a guest without bumping the counter is refused (the old bypass)', () => assertFails(owner().collection('events/lim_full/guests').doc('sneak').set({ id: 'WD-S', name: 'S', scanned: false })));
await check('free tier: the same sneak on an event under the cap is refused too', () => assertFails(owner().collection('events/lim_two/guests').doc('sneak').set({ id: 'WD-S', name: 'S', scanned: false })));
await check('free tier: an import of 3 that lands exactly on 5 is allowed', () => assertSucceeds(addGuests(owner(), 'lim_two', 3, 5)));
await check('free tier: an import that would land on 6 is refused', async () => {
  await testEnv.withSecurityRulesDisabled(ctx => ctx.firestore().doc('events/lim_two').update({ guestCount: 2 }));
  await assertFails(addGuests(owner(), 'lim_two', 4, 6));
});
await check('admin-set limit 50: guest number 50 is allowed', () => assertSucceeds(addGuests(owner(), 'lim_50', 1, 50)));
await check('admin-set limit 50: guest number 51 is refused', () => assertFails(addGuests(owner(), 'lim_50full', 1, 51)));
await check('older activated event with no number: still unlimited', () => assertSucceeds(addGuests(owner(), 'lim_legacy', 1, 901)));
await check('an event with no counter yet: the first guest still goes in', () => assertSucceeds(addGuests(owner(), 'lim_nocount', 1, 1)));
await check('a stranger cannot add guests', () => assertFails(addGuests(user('u9', 'other@example.com'), 'lim_50', 1, 50)));
await check('a door device with a valid session cannot add guests', async () => {
  await assertSucceeds(anon('devL').doc('events/lim_door/scanSessions/devL').set({ pin: '555555', createdAt: 'x' }));
  await assertFails(addGuests(anon('devL'), 'lim_door', 1, 2));
});
await check('the owner cannot give their own event a guest limit', () => assertFails(owner().doc('events/lim_full').update({ guestLimit: 500 })));
await check('the owner cannot raise the limit they were given', () => assertFails(owner().doc('events/lim_50full').update({ guestLimit: 5000 })));
await check('the owner cannot remove the limit they were given', async () => {
  await assertFails(owner().doc('events/lim_50full').update({ guestLimit: firebase.firestore.FieldValue.delete() }));
});
await check('the owner cannot activate their own event', () => assertFails(owner().doc('events/lim_full').update({ paid: true })));
await check('the owner can still edit the event\'s details', () => assertSucceeds(owner().doc('events/lim_50full').update({ name: 'New name' })));
await check('the admin can activate an event with a number', () => assertSucceeds(admin().doc('events/lim_full').update({ paid: true, guestLimit: 80 })));
await check('...and then the owner can add up to that number', () => assertSucceeds(addGuests(owner(), 'lim_full', 1, 6)));
await check('the admin can raise it later', () => assertSucceeds(admin().doc('events/lim_50full').update({ guestLimit: 80 })));
await check('...and the owner can then go past the old number', () => assertSucceeds(addGuests(owner(), 'lim_50full', 1, 51)));
await check('the admin can switch it back to the free tier', () => assertSucceeds(admin().doc('events/lim_50full').update({ paid: false, guestLimit: firebase.firestore.FieldValue.delete() })));
const newEvent = (db, uid, id, extra) => {
  const b = db.batch();
  b.set(db.doc('events/' + id), { name: 'New', ownerUid: uid, paid: false, guestCount: 0, ...extra });
  b.set(db.doc('accountLimits/' + uid), { eventLimit: 1, eventCount: 1 });
  return b.commit();
};
await check('a customer\'s new event starts free: creating it that way works', () => assertSucceeds(newEvent(user('nc1', 'n1@example.com'), 'nc1', 'ne1', {})));
await check('a customer cannot create an event that is already activated', () => assertFails(newEvent(user('nc2', 'n2@example.com'), 'nc2', 'ne2', { paid: true })));
await check('a customer cannot create an event that already has a guest limit', () => assertFails(newEvent(user('nc3', 'n3@example.com'), 'nc3', 'ne3', { guestLimit: 500 })));
await check('a customer cannot create an event with the counter already set back', () => assertFails(newEvent(user('nc4', 'n4@example.com'), 'nc4', 'ne4', { guestCount: 3 })));
await check('the admin can create an event with a limit', () => assertSucceeds(admin().doc('events/ne5').set({ name: 'A', ownerUid: 'admin1', paid: true, guestLimit: 100, guestCount: 0 })));

console.log('\nscanner roster (one document instead of reading every guest):');
const roster = { guests: ['WD-1|0|A', 'WD-2|1|B'], updatedAt: 'x' };
await check('the owner can write the roster', () => assertSucceeds(owner().doc('events/e1/roster/list').set(roster)));
await check('the admin can write the roster', () => assertSucceeds(admin().doc('events/e1/roster/list').set(roster)));
await check('only the "list" document', () => assertFails(owner().doc('events/e1/roster/other').set(roster)));
await check('no extra fields on the roster', () => assertFails(owner().doc('events/e1/roster/list').set({ ...roster, paid: true })));
await check('guests must be a list', () => assertFails(owner().doc('events/e1/roster/list').set({ guests: 'x', updatedAt: 'x' })));
await check('another customer cannot write it', () => assertFails(user('other1', 'o@example.com').doc('events/e1/roster/list').set(roster)));
await check('another customer cannot read it', () => assertFails(user('other1', 'o@example.com').doc('events/e1/roster/list').get()));
await check('unauthenticated: cannot read it', () => assertFails(unauth().doc('events/e1/roster/list').get()));
await check('anonymous device without a session: cannot read it', () => assertFails(anon('devR').doc('events/e1/roster/list').get()));
await check('a door device with a session can read it (the code is 5678 by now, see above)', async () => {
  await assertSucceeds(anon('devR').doc('events/e1/scanSessions/devR').set({ pin: '5678', createdAt: 'x' }));
  await assertSucceeds(anon('devR').doc('events/e1/roster/list').get());
});
await check('a door device cannot write it', () => assertFails(anon('devR').doc('events/e1/roster/list').set(roster)));
await check('the owner can delete it (event deletion)', () => assertSucceeds(owner().doc('events/e1/roster/list').delete()));

await testEnv.cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
