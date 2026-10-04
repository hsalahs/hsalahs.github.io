// Light Firebase bootstrap for invite.html: app + Firestore only, no auth SDK
// (a guest never signs in, and loading firebase-auth cost a full extra module
// plus its startup on every invitation open). Same config, cache and
// page-restore handling as firebase-init.js; keep the two in step.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, onSnapshot, doc, setDoc, getDoc
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
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

window._db = db;
window._fsFns = { collection, onSnapshot, doc, setDoc, getDoc };
let firestorePageHidden = false;
window.addEventListener('pagehide', () => { firestorePageHidden = true; });
window.addEventListener('pageshow', (e) => { if (e.persisted || firestorePageHidden) location.reload(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && firestorePageHidden) location.reload();
});
window._isFirestoreTerminated = (e) => !!(e && /already been terminated/i.test(e.message || ''));

window.dispatchEvent(new Event('appDbReady'));
