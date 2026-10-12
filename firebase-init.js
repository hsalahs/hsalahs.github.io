// Shared Firebase bootstrap for app.html, event.html, invite.html, scan.html.
// One place to change project config or add an SDK import instead of four.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signInAnonymously,
  onAuthStateChanged, signOut, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, memoryLocalCache, persistentMultipleTabManager, persistentSingleTabManager,
  collection, addDoc, query, where, orderBy, onSnapshot, serverTimestamp,
  doc, setDoc, getDoc, getDocFromCache, updateDoc, deleteField, increment, runTransaction, getDocs, deleteDoc, getCountFromServer, terminate
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDbjJtLLDniHbALfUhzQ-UiN2j5txR8PGM",
  authDomain: "wedding-qr-16d01.firebaseapp.com",
  projectId: "wedding-qr-16d01",
  storageBucket: "wedding-qr-16d01.firebasestorage.app",
  messagingSenderId: "1036657421971",
  appId: "1:1036657421971:web:7ac5618871ec061fba6766"
};

const app = initializeApp(firebaseConfig);
// initializeAuth with getAuth()'s exact persistence list, minus its
// popup/redirect resolver. On iPhones (and any Safari or mobile browser) the
// SDK makes sign-in WAIT for that resolver before answering anything: it
// loads apis.google.com plus a cross-origin iframe from
// wedding-qr-16d01.firebaseapp.com first, every page load. This site only
// signs in with email/password and anonymously — never a popup or redirect
// — so that wait bought nothing, and on a slow or picky connection it was
// the "stuck on جاري التحميل..." an iPhone tester hit. Same persistence, so
// everyone already signed in stays signed in.
const auth = initializeAuth(app, {
  persistence: [indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence],
});
// A persistent local cache (IndexedDB), shared across tabs: an organizer
// dashboard and a scanner open on the same device/browser reuse one copy
// instead of each downloading their own. On reload, every onSnapshot
// listener here resumes from that cache and the server sends only what
// changed since — not the whole guest list again — which is what keeps a
// busy event day from burning through the free plan's daily read quota.
// The installed iPhone/iPad home-screen app keeps the previous page alive
// (frozen) while the next one opens; with the multi-tab manager that old
// page still holds the primary lease, so the new page's first read hangs
// until the app goes to the background. Single-tab with forceOwnership
// takes the lease at once. Safari tabs, Android and desktop are unchanged.
let iosStandalone = false;
try {
  iosStandalone = navigator.standalone === true ||
    (/iPad|iPhone|iPod/.test(navigator.userAgent) && window.matchMedia('(display-mode: standalone)').matches);
} catch (e) {}
// Measurement override (set from the stuck-page buttons or by hand):
// sessionStorage fsmode = 'memory' (no IndexedDB cache) or 'long' (the same
// cache plus forced long-polling). Session-only, so it resets when the app
// is reopened. Only app.html and event.html honour it, never the door
// scanner. Anything else is the normal behaviour. The key is removed as soon
// as it is read, so a mode applies to ONE page load only: the next
// navigation tries the normal persistent cache again.
const fsMarkPage = /\/(app|event)(\.html)?$/.test(location.pathname);
let fsMode = 'default';
try {
  const m = fsMarkPage ? sessionStorage.getItem('fsmode') : null;
  if (m === 'memory' || m === 'long') fsMode = m;
  if (m !== null) sessionStorage.removeItem('fsmode');
} catch (e) {}
window._fsMode = fsMode;
window._fsTab = fsMode === 'memory' ? 'none' : (iosStandalone ? 'single' : 'multi');
const db = initializeFirestore(app, fsMode === 'memory' ? { localCache: memoryLocalCache() } : Object.assign({
  localCache: persistentLocalCache({
    tabManager: iosStandalone ? persistentSingleTabManager({ forceOwnership: true }) : persistentMultipleTabManager(),
  }),
}, fsMode === 'long' ? { experimentalForceLongPolling: true } : {}));

window._auth = auth;
window._db = db;
window._eventsCol = collection(db, 'events');
window._authFns = { createUserWithEmailAndPassword, signInWithEmailAndPassword, signInAnonymously, onAuthStateChanged, signOut, sendPasswordResetEmail };
window._fsFns = { collection, addDoc, query, where, orderBy, onSnapshot, serverTimestamp, doc, setDoc, getDoc, getDocFromCache, updateDoc, deleteField, increment, runTransaction, getDocs, deleteDoc, getCountFromServer };
// Firestore shuts its local cache down on every `pagehide`, and on iOS
// Safari it also stops the whole client for good. If Safari then brings the
// same page back (back button / back-forward cache, or the tab coming back
// to the front), it looks normal but every read and write fails with
// "The client has already been terminated". Reloading gives it a fresh,
// working client — a second's wait instead of a dead page.
let firestorePageHidden = false;
window.addEventListener('pagehide', () => {
  firestorePageHidden = true;
  // Backup for the iOS home-screen app: Firestore's own shutdown is async and
  // iOS freezes the page before it finishes, leaving the IndexedDB cache busy
  // for the next page. Terminating here, fire-and-forget, helps when _leave
  // below was not the way out.
  if (iosStandalone) { try { terminate(db).catch(() => {}); } catch (e) {} }
});
window.addEventListener('pageshow', (e) => { if (e.persisted || firestorePageHidden) location.reload(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && firestorePageHidden) location.reload();
});
window._isFirestoreTerminated = (e) => !!(e && /already been terminated/i.test(e.message || ''));

function fsMark(k) { try { if (typeof tmark === 'function') tmark(k); } catch (e) {} }
if (fsMarkPage && fsMode !== 'default') fsMark('mode:' + fsMode);

// Leaving a Firestore page for another one. In the iOS home-screen app the
// old page stays frozen behind the new one and keeps the IndexedDB cache
// busy, so the new page's reads hang (measured: raw IndexedDB and the network
// are fine, the cache probe hangs, memory cache works). Terminating the
// client from a live page, BEFORE navigating, frees it. Capped at 400 ms so
// a terminate that never answers cannot hold the user. Elsewhere this is a
// plain navigation. The duration is kept for the next page's timing line.
let leaveStarted = false;
window._leave = async (url) => {
  if (!iosStandalone) { location.assign(url); return; }
  if (leaveStarted) return;
  leaveStarted = true;
  window._leaving = true;
  const t0 = performance.now();
  let timer;
  try {
    await Promise.race([terminate(db), new Promise((r) => { timer = setTimeout(r, 400); })]);
  } catch (e) {}
  clearTimeout(timer);
  try { sessionStorage.setItem('fsleave', String(Math.round(performance.now() - t0))); } catch (e) {}
  location.assign(url);
  // The client is gone: if the navigation was cancelled and this page is
  // still showing, reload it for a working one.
  setTimeout(() => { if (document.visibilityState === 'visible') location.reload(); }, 3000);
};
try {
  const lv = sessionStorage.getItem('fsleave');
  if (lv !== null) { sessionStorage.removeItem('fsleave'); fsMark('leave ' + lv + 'ms'); }
} catch (e) {}
if (iosStandalone) {
  document.addEventListener('click', (e) => {
    try {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a || a.hasAttribute('download')) return;
      const tg = (a.getAttribute('target') || '').toLowerCase();
      if (tg && tg !== '_self') return;
      const raw = a.getAttribute('href');
      if (!raw || raw.charAt(0) === '#') return;
      const u = new URL(a.href, location.href);
      if (!/^https?:$/.test(u.protocol) || u.origin !== location.origin) return;
      if (u.pathname === location.pathname && u.search === location.search) return;
      e.preventDefault();
      window._leave(u.href);
    } catch (err) {}
  }, true);
}

// Safety net for the same stall when it still happens (app.html / event.html
// in the home-screen app only; never the door scanner or an invitation): a
// cache-only read of a document that does not exist answers at once on a
// healthy cache (a miss is fine). If it gets no answer in 6 s the cache is
// stuck, so reload this page once in memory mode (no IndexedDB). fsauto
// allows that only once until a probe answers again, so it can never loop.
if (fsMarkPage && iosStandalone) {
  const probeT0 = performance.now();
  let probeAnswered = false, probeTimer;
  const probeDone = () => {
    if (probeAnswered) return;
    probeAnswered = true;
    clearTimeout(probeTimer);
    fsMark('probe ok ' + Math.round(performance.now() - probeT0) + 'ms');
    try { sessionStorage.removeItem('fsauto'); } catch (e) {}
  };
  try { getDocFromCache(doc(db, '__probe', 'x')).then(probeDone, probeDone); } catch (e) { probeDone(); }
  probeTimer = setTimeout(() => {
    if (probeAnswered || firestorePageHidden || document.visibilityState !== 'visible') return;
    try {
      if (sessionStorage.getItem('fsauto')) return;
      sessionStorage.setItem('fsmode', 'memory');
      sessionStorage.setItem('fsauto', '1');
    } catch (e) { return; }
    fsMark('auto-memory');
    location.reload();
  }, 6000);
}

window.dispatchEvent(new Event('appDbReady'));
