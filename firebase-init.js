// Shared Firebase bootstrap for app.html, event.html, invite.html, scan.html.
// One place to change project config or add an SDK import instead of four.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signInAnonymously,
  onAuthStateChanged, signOut, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, collection, addDoc, query, where, onSnapshot, serverTimestamp,
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
const db = getFirestore(app);

window._auth = auth;
window._db = db;
window._eventsCol = collection(db, 'events');
window._authFns = { createUserWithEmailAndPassword, signInWithEmailAndPassword, signInAnonymously, onAuthStateChanged, signOut, sendPasswordResetEmail };
window._fsFns = { collection, addDoc, query, where, onSnapshot, serverTimestamp, doc, setDoc, getDoc, updateDoc, deleteField, increment, runTransaction, getDocs, deleteDoc };
window.dispatchEvent(new Event('appDbReady'));
