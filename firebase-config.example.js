import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// Vorlage für GitHub: Kopiere diese Datei zu `firebase-config.js`
// und trage deine echten Firebase-Projektdaten ein.
const firebaseConfig = {
  apiKey: "DEIN_API_KEY",
  authDomain: "DEINE_AUTH_DOMAIN",
  projectId: "DEINE_PROJECT_ID",
  storageBucket: "DEIN_STORAGE_BUCKET",
  messagingSenderId: "DEINE_MESSAGING_SENDER_ID",
  appId: "DEINE_APP_ID"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { app, auth, db };
