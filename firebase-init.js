// Shared Firebase bootstrap for app.html, event.html, invite.html, scan.html.
// One place to change project config or add an SDK import instead of four.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signInAnonymously,
  onAuthStateChanged, signOut, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, addDoc, query, where, orderBy, onSnapshot, serverTimestamp,
  doc, setDoc, getDoc, updateDoc, deleteField, increment, runTransaction, getDocs, deleteDoc
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
const auth = getAuth(app);
// A persistent local cache (IndexedDB), shared across tabs: an organizer
// dashboard and a scanner open on the same device/browser reuse one copy
// instead of each downloading their own. On reload, every onSnapshot
// listener here resumes from that cache and the server sends only what
// changed since — not the whole guest list again — which is what keeps a
// busy event day from burning through the free plan's daily read quota.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

window._auth = auth;
window._db = db;
window._eventsCol = collection(db, 'events');
window._authFns = { createUserWithEmailAndPassword, signInWithEmailAndPassword, signInAnonymously, onAuthStateChanged, signOut, sendPasswordResetEmail };
window._fsFns = { collection, addDoc, query, where, orderBy, onSnapshot, serverTimestamp, doc, setDoc, getDoc, updateDoc, deleteField, increment, runTransaction, getDocs, deleteDoc };
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
