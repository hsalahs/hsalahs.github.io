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
  doc, setDoc, getDoc, getDocFromCache, updateDoc, deleteField, increment, runTransaction, getDocs, deleteDoc, getCountFromServer
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
// localStorage fsmode = 'memory' (no IndexedDB cache) or 'long' (the same
// cache plus forced long-polling). Anything else is the normal behaviour.
let fsMode = 'default';
try {
  const m = localStorage.getItem('fsmode');
  if (m === 'memory' || m === 'long') fsMode = m;
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
window.addEventListener('pagehide', () => { firestorePageHidden = true; });
window.addEventListener('pageshow', (e) => { if (e.persisted || firestorePageHidden) location.reload(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && firestorePageHidden) location.reload();
});
window._isFirestoreTerminated = (e) => !!(e && /already been terminated/i.test(e.message || ''));

window.dispatchEvent(new Event('appDbReady'));
