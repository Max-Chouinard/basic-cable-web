// Reads the owner's Plex library for the editor: the sections, every playable item in the shape
// the Roku app builds, the collections and labels with their members' ids, and a cache of the
// items keyed on the server and the change times Plex lists for its sections.
//
// Items carry the fields roku/source/plex/PlexLibrary.brs sets in NxPlexEpisodeItem and
// NxPlexMovieItem, with the same fallbacks, so the editor's counts come from what the TV filters
// on. Fields only the player reads (partKey, codecs, art) are left out, and the Roku's artist and
// song parse of music-video titles is not ported. Every request goes through plexGet, which keeps
// the token in a header and out of URLs and messages.
import { readFileSync } from "node:fs";

import { replaceFile } from "./files.js";
import { plexGet, plexIds } from "./plex.js";

// The Roku pages by 300 (NxPlexSectionItems); the page size does not change the items.
const PAGE_SIZE = 500;
const SECTION_TIMEOUT_MS = 30_000;
// allLeaves requests in flight at once, as NxPlexServerGetMany runs them.
const SHOWS_IN_FLIGHT = 5;
// NxPlexGetContainer tries a request three times: a section page, and the reads of a collection's
// or label's members. A show's allLeaves is asked once in its batch and then three times on its
// own, so four in all.
const PAGE_TRIES = 3;
const SHOW_TRIES = 4;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
// How long a read that left a section or show out may answer from the cache.
const INCOMPLETE_MAX_AGE_MS = 10 * 60 * 1000;
// The cache file's item format, bumped when a cached item would no longer read the same. A file
// with no format or another one is read again. 2: items carry durationSec.
const CACHE_FORMAT = 2;
const MUSIC_VIDEO_SECTION = /music.?video|^music$|^mv[s]?$/i;
const MUSIC_GENRE = /music/i;

/** What the reader throws when Plex answers 401: the saved sign-in no longer works. */
export class PlexAuthError extends Error {
  constructor(options) {
    super("Plex answered 401: it no longer accepts the saved sign-in. Sign in to Plex again.", options);
    this.name = "PlexAuthError";
    this.status = 401;
  }
}

/**
 * @typedef {{ baseUrl: string, token: string, clientId?: string }} PlexClient
 * @typedef {{ ratingKey: string, type: string, title: string, year: number | null,
 *   tmdb?: number, tvdb?: number, imdb?: string }} PlexMember
 * @typedef {{ items: object[], complete: boolean, leftOut: { sections: string[], shows: string[] } }} Library
 *   a read of the library: the playable items, whether every section and show was read, and the
 *   keys of the sections and shows Plex kept refusing, which the items leave out
 */

/** GET `path` from the client's server. A 401 becomes a PlexAuthError; any other error passes on. */
async function get(client, path, timeoutMs) {
  try {
    return await plexGet(client.baseUrl, path, { token: client.token, clientId: client.clientId, timeoutMs });
  } catch (error) {
    if (error?.status === 401) throw new PlexAuthError({ cause: error });
    throw error;
  }
}

/**
 * get() as NxPlexGetContainer asks: an answer outside 200 to 299, or none at all, is asked again,
 * up to `tries` times in all. A 401 (PlexAuthError) and a 403 are not asked again.
 */
async function getWithTries(client, path, timeoutMs, tries) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await get(client, path, timeoutMs);
    } catch (error) {
      const again = error?.retryable === true || (isRefusal(error) && error.status !== 403);
      if (!again || attempt >= tries) throw error;
    }
  }
}

/** Plex answered outside 200 to 299, and not with the 401 of a sign-in it no longer takes. */
const isRefusal = (error) => Number.isInteger(error?.status) && error.status !== 401 && !(error instanceof PlexAuthError);

const list = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The server's library sections, in the server's order, with the change times Plex lists for
 * each (undefined when it lists none).
 * @returns {Promise<{ key: string, type: string, title: string, updatedAt?: unknown, contentChangedAt?: unknown }[]>}
 */
async function sectionDirectory(client) {
  const json = await get(client, "/library/sections");
  return list(json?.MediaContainer?.Directory).map(({ key, type, title, updatedAt, contentChangedAt }) => ({
    key: String(key),
    type: String(type),
    title: String(title ?? ""),
    updatedAt: updatedAt ?? undefined,
    contentChangedAt: contentChangedAt ?? undefined,
  }));
}

/**
 * The server's library sections, in the server's order.
 * @param {PlexClient} client
 * @returns {Promise<{ key: string, type: string, title: string }[]>}
 */
export async function listSections(client) {
  return (await sectionDirectory(client)).map(({ key, type, title }) => ({ key, type, title }));
}

/** The sections whose key is in `sectionKeys`, in the server's order; every section when it is empty. */
function wantedSections(sections, sectionKeys) {
  const wanted = new Set(sectionKeys.map(String));
  return sections.filter((section) => wanted.size === 0 || wanted.has(section.key));
}

/**
 * NxLibrarySignature: the server id and each section's updatedAt and contentChangedAt, which
 * Plex moves when the section's content changes. scannedAt is left out, since a scheduled scan
 * moves it when nothing changed. null when there is no section, or one carries neither time,
 * so a library whose changes can't be seen is never called unchanged.
 * @param {string} machineIdentifier
 * @param {{ key: string, updatedAt?: unknown, contentChangedAt?: unknown }[]} sections
 * @returns {string | null}
 */
function librarySignature(machineIdentifier, sections) {
  if (sections.length === 0) return null;
  const parts = [];
  for (const { key, updatedAt, contentChangedAt } of sections) {
    if (updatedAt === undefined && contentChangedAt === undefined) return null;
    parts.push(`${key}=u${updatedAt ?? 0}/c${contentChangedAt ?? 0}`);
  }
  return `${machineIdentifier}:${parts.sort().join(",")}`;
}

/**
 * Every item of a section's listing, with each item's Guid list, read a page at a time as
 * NxPlexSectionItems reads them. `filter` is more query text, such as `&label=501`. The listing
 * ends at an empty page, at Plex's totalSize, at a short page when Plex sends no totalSize, and
 * at a page that starts with an item already read, as from a server that ignores the paging.
 * Each page gets `tries` tries.
 */
async function sectionListing(client, sectionKey, filter = "", tries = 1) {
  const all = [];
  const seen = new Set();
  for (let start = 0; ; start += PAGE_SIZE) {
    const path = `/library/sections/${encodeURIComponent(sectionKey)}/all?includeGuids=1${filter}&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${PAGE_SIZE}`;
    const container = (await getWithTries(client, path, SECTION_TIMEOUT_MS, tries))?.MediaContainer;
    const page = list(container?.Metadata);
    if (page.length === 0 || seen.has(page[0]?.ratingKey)) break;
    for (const item of page) seen.add(item?.ratingKey);
    all.push(...page);
    if (typeof container.totalSize === "number" ? all.length >= container.totalSize : page.length < PAGE_SIZE) break;
  }
  return all;
}

/**
 * Runs `task(entry, index)` over each entry with at most `width` running at once, and gives the
 * answers in the entries' order. Once a task throws, no entry starts: the call throws that
 * error, and the tasks already running finish with nothing after them.
 */
async function inFlight(entries, width, task) {
  const answers = new Array(entries.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < entries.length) {
      const i = next++;
      try {
        answers[i] = await task(entries[i], i);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, entries.length) }, worker));
  return answers;
}

/**
 * The playable items in the wanted sections, in the Roku's order: section by section as the
 * server lists them, each show's episodes in show order. An empty `sectionKeys` reads every
 * section, as NxWantedSections does; a key the server lacks reads nothing. A section or a show
 * Plex keeps refusing is left out, as on the TV, with a line in the terminal, and the answer
 * says so: `complete` false and its key in `leftOut`.
 *
 * `filler: true` reads a filler library as the TV's filler scan does (NxFillerClip): each row
 * of the section's listing with a whole second of length and a part to play is an item, under
 * a minute included, and carries `filePath`, the file of its first version's first part
 * (Media[0].Part[0].file), whose folders say what the clip is. The editor picks no version: it
 * only reads the folders. A TV library's rows are shows, with no part, so it gives no items.
 * @param {PlexClient} client
 * @param {string[]} sectionKeys
 * @param {{ filler?: boolean }} [options]
 * @returns {Promise<Library>}
 */
export async function fetchLibrary(client, sectionKeys = [], { filler = false } = {}) {
  return readSections(client, wantedSections(await sectionDirectory(client), sectionKeys), filler);
}

/**
 * fetchLibrary's answer for sections already listed. A page or an allLeaves that Plex refuses
 * (an answer outside 200 to 299 but 401) after its tries leaves that section or show out, as
 * NxPlexScanServer skips it, names it in `leftOut` and prints why. A 401 throws PlexAuthError,
 * and a request that never got an answer throws after its tries, since the server itself is
 * out of reach.
 * @returns {Promise<Library>}
 */
async function readSections(client, sections, filler) {
  const items = [];
  const leftOut = { sections: [], shows: [] };
  const warn = (what, error) => console.warn(`Left out ${what}: Plex answered ${error.status} each time the editor asked.`);
  for (const section of sections) {
    let listing;
    try {
      listing = await sectionListing(client, section.key, "", PAGE_TRIES);
    } catch (error) {
      if (!isRefusal(error)) throw error;
      leftOut.sections.push(section.key);
      warn(`the library "${section.title}"`, error);
      continue;
    }
    const musicVideoSection = MUSIC_VIDEO_SECTION.test(section.title.trim());
    if (filler) {
      for (const raw of listing) pushItem(items, fillerItem(raw, section.type, musicVideoSection));
      continue;
    }
    if (section.type !== "show") {
      for (const raw of listing) pushItem(items, movieItem(raw, section.type, musicVideoSection));
      continue;
    }
    // Episodes come from allLeaves, at most five shows at a time as on the Roku. allLeaves is
    // read without includeGuids: an episode's own Guid list names the episode, not its show.
    const refused = new Set();
    const answers = await inFlight(listing, SHOWS_IN_FLIGHT, async (show, i) => {
      try {
        return await getWithTries(client, `/library/metadata/${encodeURIComponent(show.ratingKey)}/allLeaves`, undefined, SHOW_TRIES);
      } catch (error) {
        if (!isRefusal(error)) throw error;
        refused.add(i);
        warn(`the episodes of "${show.title}"`, error);
        return null;
      }
    });
    listing.forEach((show, i) => {
      if (refused.has(i)) {
        leftOut.shows.push(String(show.ratingKey));
        return;
      }
      const genres = tags(show.Genre);
      const showIds = plexIds([...list(show.Guid), show.guid]);
      for (const ep of list(answers[i]?.MediaContainer?.Metadata)) {
        pushItem(items, episodeItem(ep, show, genres, showIds, musicVideoSection));
      }
    });
  }
  return { items, complete: leftOut.sections.length === 0 && leftOut.shows.length === 0, leftOut };
}

function pushItem(items, item) {
  if (item) items.push(item);
}

/** Plex milliseconds to whole minutes, truncated as NxPlexMinutes does; 0 when missing. */
function minutes(ms) {
  return typeof ms === "number" && ms > 0 ? Math.floor(ms / 60_000) : 0;
}

/** A Plex tag list's tag strings, as NxTags reads them. */
function tags(value) {
  return list(value).map((tag) => (isObject(tag) ? (tag.tag ?? null) : null));
}

/**
 * NxPlexEpisodeItem: an episode with its show's title, ratings, genres and ids. An id the show
 * lacks comes from the episode's own guids, its show's and its season's, in the Roku's order
 * (NxPlexGuidId). null when the episode has no length.
 */
function episodeItem(ep, show, genres, showIds, musicVideoSection) {
  const duration = minutes(ep.duration);
  if (duration <= 0) return null;
  const own = plexIds([...list(ep.Guid), ep.guid, ep.grandparentGuid, ep.parentGuid]);
  return {
    ratingKey: ep.ratingKey,
    type: "episode",
    title: show.title || "Unknown",
    episodeTitle: ep.title || "",
    summary: ep.summary || show.summary || "",
    year: show.year || "",
    originallyAvailableAt: ep.originallyAvailableAt || show.originallyAvailableAt || null,
    episodeAiredAt: ep.originallyAvailableAt || "",
    contentRating: show.contentRating || ep.contentRating || "",
    episodeRating: ep.contentRating || "",
    duration,
    durationSec: Math.floor(ep.duration / 1000),
    genres: [...genres],
    rating: show.rating || 0,
    userRating: show.userRating || 0,
    viewCount: ep.viewCount || 0,
    addedAt: ep.addedAt || 0,
    studio: show.studio || "",
    librarySource: musicVideoSection ? "musicVideo" : "tv",
    tmdbID: showIds.tmdb ?? own.tmdb ?? null,
    tvdbID: showIds.tvdb ?? own.tvdb ?? null,
    imdbID: showIds.imdb ?? own.imdb ?? null,
    artist: null,
    showKey: String(show.ratingKey ?? ""),
    seasonNumber: ep.parentIndex ?? null,
    episodeNumber: ep.index ?? null,
  };
}

/**
 * A filler library's row as an item: movieItem's fields and `filePath`, the file of the row's
 * first version's first part. null when the row has no whole second of length or no part to
 * play, as NxFillerClip drops it; a row under a minute stays.
 */
function fillerItem(row, sectionType, musicVideoSection) {
  const part = list(list(row?.Media)[0]?.Part)[0];
  if (!isObject(part)) return null;
  const item = movieItem(row, sectionType, musicVideoSection, { keepShort: true });
  return item && { ...item, filePath: String(part.file ?? "") };
}

/**
 * NxPlexMovieItem: an item of any section other than a show section, typed by its section. A
 * music-video section's items, and a short item with a Music genre, are music videos; only a
 * music-video section's item without a Music genre gains the genre 'Music Video'. null when the
 * item has no length: no whole minute, or with `keepShort` no whole second.
 */
function movieItem(item, sectionType, musicVideoSection, { keepShort = false } = {}) {
  const genres = tags(item.Genre);
  const hasMusicGenre = genres.some((genre) => typeof genre === "string" && MUSIC_GENRE.test(genre));
  if (musicVideoSection && !hasMusicGenre) genres.push("Music Video");
  const duration = minutes(item.duration);
  const durationSec = typeof item.duration === "number" ? Math.floor(item.duration / 1000) : 0;
  if ((keepShort ? durationSec : duration) <= 0) return null;
  // The 10-minute cap keeps musicals and biopics out.
  const musicVideo = musicVideoSection || (duration <= 10 && hasMusicGenre);
  const ids = plexIds([...list(item.Guid), item.guid]);
  return {
    ratingKey: item.ratingKey,
    type: sectionType,
    title: item.title || "Unknown",
    artist: null,
    summary: item.summary || "",
    year: item.year || "",
    contentRating: item.contentRating || "",
    duration,
    durationSec,
    genres,
    rating: item.rating || 0,
    userRating: item.userRating || 0,
    viewCount: item.viewCount || 0,
    addedAt: item.addedAt || 0,
    studio: item.studio || "",
    librarySource: musicVideo ? "musicVideo" : sectionType,
    tmdbID: ids.tmdb ?? null,
    tvdbID: ids.tvdb ?? null,
    imdbID: ids.imdb ?? null,
  };
}

/** A collection's or label's member: Plex's type ('show' or 'movie') and the ids Plex has. */
function member(item) {
  return {
    ratingKey: String(item.ratingKey),
    type: item.type,
    title: item.title,
    year: item.year ?? null,
    ...plexIds([...list(item.Guid), item.guid]),
  };
}

/**
 * A section's Plex collections.
 * @param {PlexClient} client
 * @param {string} sectionKey
 * @returns {Promise<{ key: string, title: string, childCount: number }[]>}
 */
export async function listCollections(client, sectionKey) {
  const json = await get(client, `/library/sections/${encodeURIComponent(sectionKey)}/collections`);
  return list(json?.MediaContainer?.Metadata).map((collection) => ({
    key: String(collection.ratingKey),
    title: String(collection.title ?? ""),
    childCount: Number(collection.childCount) || 0,
  }));
}

/**
 * The shows or movies in a collection, asked up to three times as a section page is. A
 * collection Plex no longer has throws plexGet's error with `status` 404, and another refusal
 * throws it with Plex's status.
 * @param {PlexClient} client
 * @param {string} collectionKey
 * @returns {Promise<PlexMember[]>}
 */
export async function collectionMembers(client, collectionKey) {
  const json = await getWithTries(client, `/library/collections/${encodeURIComponent(collectionKey)}/children?includeGuids=1`, undefined, PAGE_TRIES);
  return list(json?.MediaContainer?.Metadata).map(member);
}

/**
 * The section's labels as Plex lists them: `{ key, title }`, where `key` is the label's id.
 * Asked up to three times.
 */
async function labelDirectory(client, sectionKey) {
  const json = await getWithTries(client, `/library/sections/${encodeURIComponent(sectionKey)}/label`, undefined, PAGE_TRIES);
  return list(json?.MediaContainer?.Directory).filter(isObject);
}

/**
 * The names of the labels used in a section.
 * @param {PlexClient} client
 * @param {string} sectionKey
 * @returns {Promise<string[]>}
 */
export async function listLabels(client, sectionKey) {
  return (await labelDirectory(client, sectionKey)).map((label) => String(label.title));
}

/**
 * The shows or movies in a section that carry the label named `label`. Plex filters a listing
 * by the label's id, so the label list is read first. Each request gets three tries, as a
 * section page does. A label the section no longer has throws an Error with `status` 404, as a
 * missing collection does.
 * @param {PlexClient} client
 * @param {string} sectionKey
 * @param {string} label
 * @returns {Promise<PlexMember[]>}
 */
export async function labelMembers(client, sectionKey, label) {
  const entry = (await labelDirectory(client, sectionKey)).find((candidate) => candidate.title === label);
  if (!entry) {
    throw Object.assign(new Error(`Plex has no label "${label}" in library section ${sectionKey}.`), { status: 404 });
  }
  return (await sectionListing(client, sectionKey, `&label=${encodeURIComponent(entry.key)}`, PAGE_TRIES)).map(member);
}

/**
 * The reads loadLibraryCached has running, by cache file, server, section keys and signature.
 * @type {Map<string, Promise<Library>>}
 */
const reading = new Map();

/**
 * fetchLibrary through a cache file. Each call asks Plex for its section list, as the Roku does
 * before it rescans, and the cache answers when it holds items in this item format
 * (CACHE_FORMAT), the same server (`machineIdentifier`, never `client.baseUrl`, which can switch
 * between a local and a remote address), the same section keys in any order, the same library
 * signature (NxLibrarySignature over the sections read), and is younger than `maxAgeMs`. So a
 * cache written before items carried durationSec is read again, a show the owner adds in Plex
 * reaches the editor on the next call, and a library whose sections list no change times is read
 * every time. A read that left a section or show out answers by the same rule for at most ten
 * minutes, so one show Plex keeps refusing does not make every call read the whole library, and
 * Plex is asked for it again after that. Otherwise Plex is read and the cache rewritten through a temp file and a
 * rename. The file holds the item format, the server id, the sorted section keys, the signature,
 * the time read, whether the read was complete, what it left out and the items, never the token.
 * A call made while another reads the same library from Plex waits for that read instead of
 * starting a second one. The answer is a Library, as fetchLibrary's, from Plex or from the cache.
 * `filler: true` reads filler items, as fetchLibrary's option does, so it needs a cache file of
 * its own.
 * @param {{ client: PlexClient, machineIdentifier: string, sectionKeys?: string[], cachePath?: string,
 *   maxAgeMs?: number, now?: () => number, filler?: boolean }} options `now` gives the time in
 *   milliseconds (Date.now)
 * @returns {Promise<Library>}
 */
export async function loadLibraryCached({
  client,
  machineIdentifier,
  sectionKeys = [],
  cachePath = "out/library-cache.json",
  maxAgeMs = SIX_HOURS_MS,
  now = Date.now,
  filler = false,
}) {
  if (typeof machineIdentifier !== "string" || machineIdentifier === "") {
    throw new Error("loadLibraryCached needs the server's machineIdentifier.");
  }
  const keys = sectionKeys.map(String).sort();
  // Read before the items, so a change made while they are read shows on the next call.
  const sections = wantedSections(await sectionDirectory(client), keys);
  const signature = librarySignature(machineIdentifier, sections);
  const cache = readCache(cachePath);
  // A file from before `complete` was kept holds only complete reads.
  const complete = cache?.complete !== false;
  const age = now() - cache?.fetchedAt;
  if (
    signature !== null &&
    cache?.format === CACHE_FORMAT &&
    cache.signature === signature &&
    cache.machineIdentifier === machineIdentifier &&
    sameList(cache.sectionKeys, keys) &&
    age >= 0 &&
    age < (complete ? maxAgeMs : Math.min(maxAgeMs, INCOMPLETE_MAX_AGE_MS)) &&
    Array.isArray(cache.items)
  ) {
    return { items: cache.items, complete, leftOut: complete ? { sections: [], shows: [] } : cache.leftOut };
  }
  // A call made while another reads the same library waits for that read, and gets its answer
  // or its error.
  const key = JSON.stringify([cachePath, machineIdentifier, keys, signature]);
  const running = reading.get(key);
  if (running) return running;
  const read = (async () => {
    const fetchedAt = now();
    const library = await readSections(client, sections, filler);
    replaceFile(cachePath, JSON.stringify({ format: CACHE_FORMAT, machineIdentifier, sectionKeys: keys, signature, fetchedAt, complete: library.complete, leftOut: library.leftOut, items: library.items }));
    return library;
  })();
  reading.set(key, read);
  try {
    return await read;
  } finally {
    reading.delete(key);
  }
}

/** The cache file's contents, or null when it is missing or unreadable. */
function readCache(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function sameList(a, b) {
  return Array.isArray(a) && a.length === b.length && a.every((value, i) => value === b[i]);
}
