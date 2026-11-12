import { signInAnonymously, onAuthStateChanged } from "firebase/auth";
import {
  doc,
  setDoc,
  getDoc,
  updateDoc,
  onSnapshot,
  collection,
  query,
  where,
  arrayUnion,
  arrayRemove,
  serverTimestamp
} from "firebase/firestore";
import { app, auth, db } from "./firebase-config.js";

const COLLECTION_NAME = "randomLists";
const ACTIVE_CODE_STORAGE_KEY = "essensroulette_active_code";
const SAVED_LISTS_STORAGE_KEY = "essensroulette_saved_lists";
const LOCAL_DEMO_DB_KEY = "essensroulette_demo_db";

// Lokaler State für den aktuell aktiven Teilen-Code
let activeShareCode = localStorage.getItem(ACTIVE_CODE_STORAGE_KEY) || null;
let authReadyPromise = null;

// Lokale Listener für den Demo-Modus (falls DEIN_API_KEY noch nicht eingetragen ist)
const localListeners = new Map();

/**
 * Prüft, ob in firebase-config.js noch der Platzhalter "DEIN_API_KEY" steht.
 * Sobald echte Firebase-Keys eingetragen sind, gibt diese Funktion false zurück
 * und alle Aufrufe laufen zu 100% über Firebase Auth & Firestore.
 * @returns {boolean}
 */
export function isPlaceholderConfig() {
  const apiKey = app?.options?.apiKey || "";
  return !apiKey || apiKey === "DEIN_API_KEY" || apiKey.includes("DEIN_");
}

/**
 * 1. Authentifizierung
 * Meldet den Nutzer still im Hintergrund anonym via signInAnonymously() an.
 * @returns {Promise<{ uid: string }>}
 */
export function initAuth() {
  if (isPlaceholderConfig()) {
    let demoUid = localStorage.getItem("essensroulette_demo_uid");
    if (!demoUid) {
      demoUid = "demo-user-" + Math.random().toString(36).substring(2, 10);
      localStorage.setItem("essensroulette_demo_uid", demoUid);
    }
    return Promise.resolve({ uid: demoUid, isAnonymous: true });
  }

  if (authReadyPromise) {
    return authReadyPromise;
  }

  authReadyPromise = new Promise((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(
      auth,
      async (user) => {
        unsubscribe();
        if (user) {
          resolve(user);
        } else {
          try {
            const credential = await signInAnonymously(auth);
            resolve(credential.user);
          } catch (error) {
            authReadyPromise = null;
            if (
              error?.code === "auth/configuration-not-found" ||
              error?.code === "auth/operation-not-allowed" ||
              error?.code === "auth/admin-restricted-operation"
            ) {
              reject(
                new Error(
                  "Bitte in der Firebase Console unter 'Authentication -> Sign-in method' die Methode 'Anonym' aktivieren!"
                )
              );
            } else {
              reject(error);
            }
          }
        }
      },
      (error) => {
        authReadyPromise = null;
        reject(error);
      }
    );
  });

  return authReadyPromise;
}

/**
 * Hilfsfunktion: Generiert einen zufälligen 5-stelligen alphanumerischen Code (A-Z, 0-9).
 * @param {number} length
 * @returns {string}
 */
function generateShareCode(length = 5) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  const randomValues = new Uint32Array(length);
  crypto.getRandomValues(randomValues);
  for (let i = 0; i < length; i++) {
    result += chars[randomValues[i] % chars.length];
  }
  return result;
}

/**
 * Hilfsfunktion: Erzeugt eine eindeutige ID für einen Listeneintrag.
 * @returns {string}
 */
function generateEntryId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Speichert den aktiven Code im lokalen State + in der Liste bekannter Codes (für das Seitenmenü).
 * @param {string} shareCode
 * @param {string} [title]
 */
export function setActiveListCode(shareCode, title) {
  const normalized = shareCode.trim().toUpperCase();
  activeShareCode = normalized;
  localStorage.setItem(ACTIVE_CODE_STORAGE_KEY, normalized);

  const savedLists = getSavedLists();
  const existingIndex = savedLists.findIndex((item) => item.code === normalized);
  if (existingIndex >= 0) {
    if (title) {
      savedLists[existingIndex].title = title;
    }
    const [item] = savedLists.splice(existingIndex, 1);
    savedLists.unshift(item);
  } else {
    savedLists.unshift({
      code: normalized,
      title: title || `Liste #${normalized}`
    });
  }
  localStorage.setItem(SAVED_LISTS_STORAGE_KEY, JSON.stringify(savedLists));
}

/**
 * Gibt den aktuell aktiven Teilen-Code zurück.
 * @returns {string | null}
 */
export function getActiveListCode() {
  return activeShareCode;
}

/**
 * Gibt alle lokal gespeicherten Listen ({ code, title }) für das Seitenmenü zurück.
 * @returns {Array<{ code: string, title: string }>}
 */
export function getSavedLists() {
  try {
    const raw = localStorage.getItem(SAVED_LISTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return parsed.map((item) =>
      typeof item === "string" ? { code: item, title: `Liste #${item}` } : item
    );
  } catch {
    return [];
  }
}

/**
 * Hört in Echtzeit auf ALLE Listen des aktuellen Nutzers (owner == user.uid).
 * Findet automatisch auch in der Firebase-Konsole manuell erstellte Listen!
 * @param {(lists: Array<{ code: string, title: string }>) => void} callback
 * @returns {Promise<() => void>}
 */
export async function listenToMyLists(callback) {
  const user = await initAuth();

  if (isPlaceholderConfig()) {
    const checkDemo = () => {
      const demoDb = getDemoDb();
      const myLists = Object.entries(demoDb)
        .filter(([_, data]) => data.owner === user.uid)
        .map(([code, data]) => ({ code, title: data.title || `Liste #${code}` }));
      callback(myLists);
    };
    checkDemo();
    return () => {};
  }

  // Firestore Abfrage: Alle Listen mit owner == aktuelle UID
  const q = query(collection(db, COLLECTION_NAME), where("owner", "==", user.uid));

  const unsubscribe = onSnapshot(
    q,
    (snapshot) => {
      const dbLists = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        dbLists.push({
          code: docSnap.id,
          title: data.title || `Liste #${docSnap.id}`
        });
      });

      // Bestehende lokale Listen (z. B. beigetretene Listen anderer) mit den eigenen DB-Listen verschmelzen
      const currentSaved = getSavedLists();
      const mergedMap = new Map();

      // Zuerst die aktuellen eigenen Listen aus der DB eintragen
      dbLists.forEach((l) => mergedMap.set(l.code, l));

      // Danach eventuell beigetretene fremde Listen beibehalten
      currentSaved.forEach((l) => {
        if (!mergedMap.has(l.code)) {
          mergedMap.set(l.code, l);
        }
      });

      const mergedList = Array.from(mergedMap.values());
      localStorage.setItem(SAVED_LISTS_STORAGE_KEY, JSON.stringify(mergedList));

      callback(mergedList);
    },
    (err) => {
      console.warn("Fehler beim Abrufen der eigenen Listen:", err);
      callback(getSavedLists());
    }
  );

  return unsubscribe;
}

/* ============================================================================
 * LOKALER DEMO-SPEICHER (nur aktiv solange "DEIN_API_KEY" in firebase-config.js steht)
 * ============================================================================ */
function getDemoDb() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_DEMO_DB_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveDemoDb(data, changedCode) {
  localStorage.setItem(LOCAL_DEMO_DB_KEY, JSON.stringify(data));
  if (changedCode && localListeners.has(changedCode)) {
    const docData = data[changedCode] ? { id: changedCode, ...data[changedCode] } : null;
    localListeners.get(changedCode).forEach((cb) => cb(docData));
  }
}

/* ============================================================================
 * 3. BENÖTIGTE JAVASCRIPT-FUNKTIONEN (FIREBASE V9+ MODULAR SDK)
 * ============================================================================ */

/**
 * 3.1 createNewList(title)
 * Generiert den 5-stelligen Code, erstellt das Dokument in Firestore (`randomLists/{code}`)
 * und gibt den Code zurück.
 * @param {string} [title="Meine Liste"] - Optionaler Name der Liste für die Überschrift
 * @returns {Promise<string>} Der generierte 5-stellige Teilen-Code (z. B. "A9X2B")
 */
export async function createNewList(title = "Meine Liste") {
  const user = await initAuth();
  const cleanTitle = (title || "Meine Liste").trim() || "Meine Liste";

  if (isPlaceholderConfig()) {
    const demoDb = getDemoDb();
    let shareCode = generateShareCode(5);
    while (demoDb[shareCode]) {
      shareCode = generateShareCode(5);
    }
    demoDb[shareCode] = {
      title: cleanTitle,
      createdAt: new Date().toISOString(),
      owner: user.uid,
      entries: []
    };
    saveDemoDb(demoDb, shareCode);
    setActiveListCode(shareCode, cleanTitle);
    return shareCode;
  }

  let shareCode = "";
  let docRef = null;
  let exists = true;

  // Kollisionsprüfung: Sicherstellen, dass der 5-stellige Code noch nicht existiert
  while (exists) {
    shareCode = generateShareCode(5);
    docRef = doc(db, COLLECTION_NAME, shareCode);
    const snap = await getDoc(docRef);
    exists = snap.exists();
  }

  await setDoc(docRef, {
    title: cleanTitle,
    createdAt: serverTimestamp(),
    owner: user.uid,
    entries: []
  });

  setActiveListCode(shareCode, cleanTitle);
  return shareCode;
}

/**
 * 3.2 joinList(shareCode)
 * Prüft, ob das Dokument mit der ID in `randomLists` existiert und speichert den aktiven Code im lokalen State.
 * @param {string} shareCode - Der 5- bis 6-stellige Teilen-Code
 * @returns {Promise<{ id: string, title: string, owner: string, createdAt: any, entries: Array<{id: string, text: string}> }>}
 */
export async function joinList(shareCode) {
  await initAuth();

  const normalizedCode = (shareCode || "").trim().toUpperCase();
  if (!normalizedCode) {
    throw new Error("Bitte gib einen gültigen Teilen-Code ein.");
  }

  if (isPlaceholderConfig()) {
    const demoDb = getDemoDb();
    const listDoc = demoDb[normalizedCode];
    if (!listDoc) {
      throw new Error(`Keine Liste mit dem Code "${normalizedCode}" gefunden.`);
    }
    setActiveListCode(normalizedCode, listDoc.title);
    return { id: normalizedCode, ...listDoc };
  }

  const docRef = doc(db, COLLECTION_NAME, normalizedCode);
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) {
    throw new Error(`Keine Liste mit dem Code "${normalizedCode}" gefunden.`);
  }

  const data = snapshot.data();
  setActiveListCode(normalizedCode, data.title || `Liste #${normalizedCode}`);

  return {
    id: snapshot.id,
    ...data
  };
}

/**
 * 3.3 addEntry(shareCode, text)
 * Fügt dem `entries`-Array im entsprechenden Dokument ein neues Objekt
 * (mit einer generierten ID und dem Text) hinzu (nutzt `arrayUnion`).
 * @param {string} shareCode
 * @param {string} text
 * @returns {Promise<{ id: string, text: string }>}
 */
export async function addEntry(shareCode, text) {
  await initAuth();

  const normalizedCode = (shareCode || "").trim().toUpperCase();
  const trimmedText = (text || "").trim();

  if (!normalizedCode) {
    throw new Error("Kein Listen-Code angegeben.");
  }
  if (!trimmedText) {
    throw new Error("Der Eintrag darf nicht leer sein.");
  }

  const newEntry = {
    id: generateEntryId(),
    text: trimmedText
  };

  if (isPlaceholderConfig()) {
    const demoDb = getDemoDb();
    if (!demoDb[normalizedCode]) {
      throw new Error(`Liste "${normalizedCode}" existiert nicht.`);
    }
    demoDb[normalizedCode].entries.push(newEntry);
    saveDemoDb(demoDb, normalizedCode);
    return newEntry;
  }

  const docRef = doc(db, COLLECTION_NAME, normalizedCode);
  await updateDoc(docRef, {
    entries: arrayUnion(newEntry)
  });

  return newEntry;
}

/**
 * 3.4 removeEntry(shareCode, entryId)
 * Entfernt ein spezifisches Objekt anhand seiner `entryId` aus dem `entries`-Array.
 * @param {string} shareCode
 * @param {string} entryId
 * @returns {Promise<void>}
 */
export async function removeEntry(shareCode, entryId) {
  await initAuth();

  const normalizedCode = (shareCode || "").trim().toUpperCase();

  if (isPlaceholderConfig()) {
    const demoDb = getDemoDb();
    if (!demoDb[normalizedCode]) return;
    demoDb[normalizedCode].entries = (demoDb[normalizedCode].entries || []).filter(
      (item) => item.id !== entryId
    );
    saveDemoDb(demoDb, normalizedCode);
    return;
  }

  const docRef = doc(db, COLLECTION_NAME, normalizedCode);
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) {
    throw new Error(`Liste "${normalizedCode}" existiert nicht.`);
  }

  const entries = snapshot.data().entries || [];
  const entryToRemove = entries.find((item) => item.id === entryId);

  if (!entryToRemove) {
    return;
  }

  await updateDoc(docRef, {
    entries: arrayRemove(entryToRemove)
  });
}

/**
 * Zusatzfunktion: Bearbeitet einen bestehenden Eintrag im `entries`-Array (Text, Gewichtung, Farbe etc.).
 * @param {string} shareCode
 * @param {string} entryId
 * @param {Partial<{ text: string, weight: number, color: string }>} updates
 * @returns {Promise<void>}
 */
export async function updateEntry(shareCode, entryId, updates) {
  await initAuth();

  const normalizedCode = (shareCode || "").trim().toUpperCase();

  if (isPlaceholderConfig()) {
    const demoDb = getDemoDb();
    if (!demoDb[normalizedCode]) return;
    demoDb[normalizedCode].entries = (demoDb[normalizedCode].entries || []).map((item) =>
      item.id === entryId
        ? { ...item, ...updates, text: updates.text !== undefined ? updates.text.trim() : item.text }
        : item
    );
    saveDemoDb(demoDb, normalizedCode);
    return;
  }

  const docRef = doc(db, COLLECTION_NAME, normalizedCode);
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) {
    throw new Error(`Liste "${normalizedCode}" existiert nicht.`);
  }

  const entries = snapshot.data().entries || [];
  const updatedEntries = entries.map((item) => {
    if (item.id === entryId) {
      return {
        ...item,
        ...updates,
        text: updates.text !== undefined ? updates.text.trim() : item.text
      };
    }
    return item;
  });

  await updateDoc(docRef, {
    entries: updatedEntries
  });
}

/**
 * Zusatzfunktion: Ändert den Titel einer Liste.
 * @param {string} shareCode
 * @param {string} newTitle
 * @returns {Promise<void>}
 */
export async function updateListTitle(shareCode, newTitle) {
  await initAuth();

  const normalizedCode = (shareCode || "").trim().toUpperCase();
  const cleanTitle = (newTitle || "").trim() || `Liste #${normalizedCode}`;

  if (isPlaceholderConfig()) {
    const demoDb = getDemoDb();
    if (!demoDb[normalizedCode]) return;
    demoDb[normalizedCode].title = cleanTitle;
    setActiveListCode(normalizedCode, cleanTitle);
    saveDemoDb(demoDb, normalizedCode);
    return;
  }

  const docRef = doc(db, COLLECTION_NAME, normalizedCode);
  await updateDoc(docRef, {
    title: cleanTitle
  });
  setActiveListCode(normalizedCode, cleanTitle);
}

/**
 * 3.5 listenToList(shareCode, callback)
 * Ein `onSnapshot`-Listener auf das Dokument, der bei jeder Änderung in Echtzeit feuert
 * und die aktuelle Liste an die UI übergibt.
 * @param {string} shareCode
 * @param {(listData: { id: string, title?: string, owner: string, createdAt: any, entries: Array<{id: string, text: string}> } | null, error?: Error) => void} callback
 * @returns {Promise<() => void>} Unsubscribe-Funktion zum Beenden des Listeners
 */
export async function listenToList(shareCode, callback) {
  await initAuth();

  const normalizedCode = (shareCode || "").trim().toUpperCase();

  if (isPlaceholderConfig()) {
    if (!localListeners.has(normalizedCode)) {
      localListeners.set(normalizedCode, new Set());
    }
    const listenersSet = localListeners.get(normalizedCode);
    listenersSet.add(callback);

    // Sofort aktuellen Stand liefern
    const demoDb = getDemoDb();
    const currentDoc = demoDb[normalizedCode]
      ? { id: normalizedCode, ...demoDb[normalizedCode] }
      : null;
    if (currentDoc?.title) {
      setActiveListCode(normalizedCode, currentDoc.title);
    }
    setTimeout(() => callback(currentDoc), 0);

    return () => {
      listenersSet.delete(callback);
    };
  }

  const docRef = doc(db, COLLECTION_NAME, normalizedCode);

  const unsubscribe = onSnapshot(
    docRef,
    (snapshot) => {
      if (!snapshot.exists()) {
        callback(null);
        return;
      }
      const data = snapshot.data();
      if (data.title) {
        setActiveListCode(normalizedCode, data.title);
      }
      callback({
        id: snapshot.id,
        ...data
      });
    },
    (error) => {
      console.error("Fehler beim Echtzeit-Listener:", error);
      callback(null, error);
    }
  );

  return unsubscribe;
}
