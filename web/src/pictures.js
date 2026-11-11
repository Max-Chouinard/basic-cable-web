// The pictures the guide shows: a show's backdrop, logo and poster, from Plex's picture
// transcoder. A picture is fetched with the sign-in in a header and shown from memory, so no
// address in the page carries the sign-in.

/**
 * The transcoder's address for a picture of an item, fitted to a box. `kind` is "art" (the
 * backdrop), "clearLogo" or "thumb" (the poster). A logo comes as a PNG, which keeps its
 * transparent ground, as the TV asks for it (NxPlexPictureUrl).
 */
export function pictureUrl(base, key, kind, width, height) {
  const query = new URLSearchParams({ url: `/library/metadata/${key}/${kind}`, width: String(width), height: String(height), minSize: "1", upscale: "1" });
  if (kind === "clearLogo") query.set("format", "png");
  return `${new URL("/photo/:/transcode", base)}?${query}`;
}

/**
 * A store of pictures. `get` answers at once: the picture's object URL when it is here, else
 * null, and the first ask starts the fetch. `onArrive` runs when a picture comes, so the page
 * draws again. A picture Plex does not have (a show with no logo) is remembered as missing, and
 * `missing` says so. The oldest pictures are dropped past `max`.
 * @param {{ fetchImpl?: typeof fetch, max?: number, onArrive?: () => void, makeUrl?: (blob: Blob) => string,
 *   dropUrl?: (url: string) => void }} [options]
 */
export function createPictures({ fetchImpl = fetch, max = 160, onArrive = () => {}, makeUrl = (blob) => URL.createObjectURL(blob), dropUrl = (url) => URL.revokeObjectURL(url) } = {}) {
  /** @type {Map<string, { url?: string, missing?: true }>} */
  const store = new Map();
  const drop = () => {
    while (store.size > max) {
      const [oldest, entry] = store.entries().next().value;
      if (entry.url) dropUrl(entry.url);
      store.delete(oldest);
    }
  };
  async function load(address, token) {
    try {
      const response = await fetchImpl(address, { headers: { "X-Plex-Token": token } });
      if (!response.ok) throw new Error(String(response.status));
      store.set(address, { url: makeUrl(await response.blob()) });
    } catch {
      store.set(address, { missing: true });
    }
    drop();
    onArrive();
  }
  return {
    get({ base, token, key, kind, width, height }) {
      if (!base || !key) return null;
      const address = pictureUrl(base, key, kind, width, height);
      const entry = store.get(address);
      if (!entry) {
        store.set(address, {});
        load(address, token);
        return null;
      }
      return entry.url ?? null;
    },
    /** The picture when it is already here, and never a fetch: for a selection that may move on. */
    peek({ base, key, kind, width, height }) {
      if (!base || !key) return null;
      return store.get(pictureUrl(base, key, kind, width, height))?.url ?? null;
    },
    missing({ base, key, kind, width, height }) {
      return !base || !key || store.get(pictureUrl(base, key, kind, width, height))?.missing === true;
    },
    clear() {
      for (const entry of store.values()) if (entry.url) dropUrl(entry.url);
      store.clear();
    },
  };
}

/** The key a program's pictures hang on: its show for an episode, itself for a movie. */
export function artKey(item) {
  if (!item) return "";
  return String(item.type === "episode" ? item.showKey || item.ratingKey : item.ratingKey);
}
