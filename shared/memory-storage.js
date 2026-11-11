// A stand-in for the browser's localStorage, held in a Map. The daily-manifest engine
// (nostalgex-daily-manifest.cjs) keeps each channel's day schedule in localStorage, so Node code
// that runs it installs one of these on globalThis first: the editor's preview
// (editor/lib/preview.js), the Roku's lineup vectors (roku/tests/gen-lineup.mjs) and the live
// parity check (roku/tests/live/compare.mjs).

/**
 * An empty store with the parts of the Storage interface the engine uses: getItem, setItem,
 * removeItem, key and length.
 */
export function createMemoryStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
}
