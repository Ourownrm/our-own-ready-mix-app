// Round 96 (item 9): the service worker needs the auth token to call the API
// directly when a driver/site-supervisor taps a notification action button
// (e.g. "Plant Out") without opening the app first — localStorage isn't
// reachable from a service worker's execution context, so the token is
// mirrored into IndexedDB on login/logout alongside the existing
// localStorage copy that the rest of the app (apiRequest) already uses.
const DB_NAME = "oorm-auth";
const STORE = "kv";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveTokenToIndexedDb(token) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(token, "token");
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // IndexedDB unavailable (private browsing, very old browser) — the
    // notification action-button shortcut just won't work; tapping the
    // notification body still opens the app normally either way.
  }
}

export async function clearTokenFromIndexedDb() {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete("token");
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // as above
  }
}
