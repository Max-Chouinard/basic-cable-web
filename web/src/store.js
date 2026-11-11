// What this browser keeps: the Plex sign-in and the profile in localStorage, and the library in
// IndexedDB, which holds the 20,000 items localStorage has no room for. Every read and write may
// fail (a private window, blocked site data), and the page works without them: it signs in and
// reads the library again.

const PREFIX = "basic-cable.";
const DB_NAME = "basic-cable";
const STORE = "library";

export const settings = {
  get(key) {
    try {
      return localStorage.getItem(PREFIX + key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, value);
    } catch {
      // Not kept: the page asks again next time.
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      // Nothing was kept.
    }
  },
};

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function run(mode, work) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = work(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(request?.result);
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
}

/** The library saved for a server, as `{ savedAt, items }`, or null. */
export async function loadLibrary(serverId) {
  try {
    return (await run("readonly", (store) => store.get(serverId))) ?? null;
  } catch {
    return null;
  }
}

/** Saves the library for a server. A failed save costs the next visit a fresh read. */
export async function saveLibrary(serverId, items, savedAt) {
  try {
    await run("readwrite", (store) => store.put({ savedAt, items }, serverId));
  } catch {
    // Not kept.
  }
}

/** Forgets every saved library, at sign-out. */
export async function clearLibrary() {
  try {
    await run("readwrite", (store) => store.clear());
  } catch {
    // Nothing was kept.
  }
}
