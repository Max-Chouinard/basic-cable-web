// The lineup file: the one JSON document that describes the channels, the
// shows on them and the Kids rating limit. docs/lineup-format.md documents each
// field. The editor writes the file, the package builder checks it and ships
// its packaged form (packagedLineup) inside the app, and the Roku app reads that.
import { createHash } from "node:crypto";

import { normalizeRating } from "./kids.js";

const MIN_CHANNEL_ID = 1000;
// Guide numbers stay below the lowest id, so a deep link can match ids before numbers.
const MAX_GUIDE_NUMBER = MIN_CHANNEL_ID - 1;
// The lineup ships inside the app, so it holds no token, PIN or password.
const SECRET_KEY = /token|password|pin/i;
// A show's lastYear on a channel. The range catches a typo such as 204.
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

// Upstream's channel rule fields (shared/nostalgex-channel-filter.cjs), plus
// `curated`. Left out on purpose, because enrichment is off in this build and
// they would match nothing: networks, keywords, keywordsExclude,
// keywordsRequireAnyGenre, keywordGatedGenres, productionCompanies,
// matchTmdbGenres, imdbRatingMin, imdbVotesMin, rtScoreMin, metacriticMin and
// wonOscar. A name outside this set is rejected, dropped or mistyped alike.
const RULE_FIELDS = new Set([
  "type",
  "source",
  "genres",
  "titleContains",
  "titleExcludes",
  "episodeTitleContains",
  "episodeSeasonalTitleContains",
  "episodeSummaryContains",
  "episodeTitleExcludes",
  "episodeAirWindow",
  "editorialOverrides",
  "studios",
  "contentRatings",
  "allowUnrated",
  "manifestOnly",
  "curated",
  "yearRange",
  "durationRange",
  "ratingMin",
  "addedWithinDays",
  "releasedWithinMonths",
  "watchedOnly",
  "unwatchedOnly",
  "rewatched",
]);

// The kind of value each rule takes. The JS filter and the Roku's read a value
// of another kind differently: JS turns "1990" into 1990 where the Roku stops
// with a type mismatch, and JS throws on a word list that is not a list where
// the Roku reads it as empty. So validateLineup ships only these kinds.
const RULE_STRINGS = ["type", "source"];
const RULE_FLAGS = ["allowUnrated", "manifestOnly", "curated", "watchedOnly", "unwatchedOnly", "rewatched"];
const RULE_NUMBERS = ["ratingMin", "addedWithinDays", "releasedWithinMonths"];
const RULE_WORD_LISTS = [
  "titleContains",
  "titleExcludes",
  "episodeTitleContains",
  "episodeSummaryContains",
  "episodeSeasonalTitleContains",
  "episodeTitleExcludes",
  "editorialOverrides",
  "studios",
  "contentRatings",
];
// Object rules and the parts each one takes, with the check for a part.
const RULE_OBJECTS = {
  genres: { include: "list", exclude: "list", requireAll: "list" },
  episodeAirWindow: { from: "string", to: "string" },
  yearRange: { min: "number", max: "number" },
  durationRange: { min: "number", max: "number", minMinutes: "number", maxMinutes: "number" },
};

// The kind of each lock field, as exclusiveRuleApplies and exclusiveRuleMatches
// read it. A lock's genres is a list of names, unlike a channel's rules.genres
// object. filterPool throws on a word list that is not a list, where the Roku
// reads it as empty, so the two would keep different items out.
const LOCK_FIELDS = {
  type: "string",
  source: "string",
  titleContains: "list",
  editorialTitles: "list",
  genres: "list",
  manifestExclusive: "flag",
};

// The editor's channel `source` (not `rules.source`): each kind and its parts.
// Only the editor reads it; packagedLineup deletes it.
const SOURCE_PARTS = {
  curated: {},
  picked: { ratingKeys: "list" },
  collection: { sectionKey: "string", collectionKey: "string", title: "string" },
  label: { sectionKey: "string", label: "string" },
  rules: {},
};

// The looks a TV can draw the guide in: the lineup's `theme` is one of them,
// and the Roku app's NxThemeNames (roku/source/guide/Theme.brs) lists the same
// names in the same order, which tools/test/theme-names.test.js holds. The
// first is the default.
export const THEME_NAMES = ["cable-box", "prevue", "clean"];

// A channel's `logo`: the name of a PNG in the lineup folder's logos/ folder, bare, with no path
// in it, so the package builder reads nothing outside that folder and the app shows nothing
// outside images/logos/. editor/lib/logos.js checks the file itself.
const LOGO_FILE = /^[A-Za-z0-9._-]+\.png$/;

// A channel's `kind`: a channel the app draws itself rather than fills from the library. Only the
// weather channel exists. It carries a `location` and may carry `units`; the app reads both
// (roku/source/weather/WeatherData.brs).
const WEATHER_KIND = "weather";
const WEATHER_UNITS = ["metric", "imperial"];

// A channel's scheduling fields: the values each list field takes, and
// blockSize's bounds. docs/lineup-format.md describes them.
const PLAY_ORDERS = ["shuffle", "inOrder", "blocks", "marathon"];
const ALIGNMENTS = ["none", "half-hour"];
const MIN_BLOCK_SIZE = 2;
const MAX_BLOCK_SIZE = 8;
// The lineup's `shorts`: cartoon episodes a break can play in place of cards. maxMinutes bounds the
// length of one episode.
const MIN_SHORT_MINUTES = 1;
const MAX_SHORT_MINUTES = 20;
// A season's `from` and `to`: "MM-DD", two digits each and a real calendar day. February 29
// counts, since a window is read against the calendar of whichever year it is.
const SEASON_DATE = /^(\d{2})-(\d{2})$/;
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
// A season word or phrase starts and ends with an ASCII letter or digit and holds only those,
// spaces, apostrophes and hyphens, so `word` reads the same in JavaScript and on the Roku.
const SEASON_WORD = /^[A-Za-z0-9](?:[A-Za-z0-9 '-]*[A-Za-z0-9])?$/;
// A daypart's days, 0 for Sunday.
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// A daypart time on the hour or half hour, "00:00" to "23:30". The end may also be "24:00".
const HALF_HOUR = /^([01]\d|2[0-3]):(00|30)$/;
const END_OF_DAY = "24:00";
const ON_THE_HALF_HOUR = 'a time on the hour or half hour, such as "07:00" or "07:30"';
// The hour filters the shuffle packer applies by repacking the day. A
// channel on the slot packer can't take them (usesSlottedPacker).
const HOUR_FILTERS = ["tvOnlyBefore", "onlyAfterHour"];

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value !== "";
const isCount = (value) => Number.isInteger(value) && value >= 0;
const isPositiveInt = (value) => Number.isInteger(value) && value > 0;
const isYear = (value) => Number.isInteger(value) && value >= MIN_YEAR && value <= MAX_YEAR;
const isStringList = (value) => Array.isArray(value) && value.every((v) => typeof v === "string");
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
// An hour bound in timeRestrictions: the Roku compares it with the hour, 0 to 23.
const isHour = (value) => Number.isInteger(value) && value >= 0 && value <= 24;
const KIND_CHECKS = {
  string: [(v) => typeof v === "string", "a string"],
  number: [isNumber, "a number"],
  list: [isStringList, "a list of strings"],
  flag: [(v) => typeof v === "boolean", "true or false"],
};

/**
 * Index keys for one title: `<tv|movie>:<tmdb|tvdb|imdb>:<id>`, in that id
 * order. An IMDb id is lowercased, as the lineup writes it (`tt0101188`).
 * membershipIndex, the duplicate-show check in validateLineup and the editor's
 * setShowsForChannel all key shows with it, so they agree on which ids name
 * the same show.
 * @param {string} kind `tv` or `movie`
 * @param {number|string} [tmdb]
 * @param {number|string} [tvdb]
 * @param {string} [imdb]
 * @returns {string[]}
 */
export function keysFor(kind, tmdb, tvdb, imdb) {
  const keys = [];
  if (tmdb) keys.push(`${kind}:tmdb:${tmdb}`);
  if (tvdb) keys.push(`${kind}:tvdb:${tvdb}`);
  if (imdb) keys.push(`${kind}:imdb:${String(imdb).toLowerCase()}`);
  return keys;
}

/**
 * The index keys a library item looks up: one per id it carries, in the order
 * tmdb, tvdb, imdb, with the IMDb id lowercased. An episode looks under `tv`,
 * anything else under `movie`.
 * @param {{ type: string, tmdbID?: number|string, tvdbID?: number|string, imdbID?: string }} item
 * @returns {string[]}
 */
export function itemKeys(item) {
  return keysFor(item.type === "episode" ? "tv" : "movie", item.tmdbID, item.tvdbID, item.imdbID);
}

/**
 * The membership list as the filter reads it. Every id of a show keys the same
 * entry object: `channels` (ascending), `lastYear` (channel id to last year,
 * only for channels that set one), `exclusive` (a channel id, only when the
 * show has one) and `tag` (channel id to the daypart tag the show airs in
 * there, only when one of its channels sets one). Expects a lineup that passed
 * validateLineup.
 * @returns {Record<string, { channels: number[], lastYear: Record<string, number>, exclusive?: number, tag?: Record<string, string> }>}
 */
export function membershipIndex(lineup) {
  const index = {};
  for (const show of lineup.memberships?.shows ?? []) {
    const channels = Object.keys(show.channels ?? {})
      .map(Number)
      .sort((a, b) => a - b);
    const lastYear = {};
    const tag = {};
    for (const id of channels) {
      const stay = show.channels[id];
      if (stay.lastYear != null) lastYear[id] = stay.lastYear;
      if (stay.tag != null) tag[id] = stay.tag;
    }
    const entry = { channels, lastYear };
    if (show.exclusive != null) entry.exclusive = show.exclusive;
    if (Object.keys(tag).length > 0) entry.tag = tag;
    for (const key of keysFor(show.mediaType, show.tmdb, show.tvdb, show.imdb)) index[key] = entry;
  }
  return index;
}

/**
 * The index entry of the first of the item's keys (itemKeys) the index holds,
 * or null: the entry the filter reads (manifestEntry in
 * nostalgex-channel-filter.cjs, NxManifestEntry on the Roku). An item's
 * daypart tag on a channel is `membershipEntry(index, item)?.tag?.[String(id)] ?? ""`.
 * @param {ReturnType<typeof membershipIndex>} index
 * @param {{ type: string, tmdbID?: number|string, tvdbID?: number|string, imdbID?: string }} item
 */
export function membershipEntry(index, item) {
  for (const key of itemKeys(item)) {
    if (index[key]) return index[key];
  }
  return null;
}

/**
 * Whether the channel's schedule comes from the slot packer, not upstream's
 * shuffle packer: it aligns to the half hour, plays in an order other than
 * shuffle, has dayparts, or keeps ratings out of some hours with
 * `timeRestrictions.blockRatings`. A channel that writes out the defaults
 * (`align: "none"`, `playOrder: "shuffle"`) stays on the shuffle packer.
 * validateLineup needs it, so it lives here: the slot packer and
 * shared/time-filter.cjs load lineup.js through nostalgex-channel-filter.cjs,
 * so lineup.js importing either would form a require(esm) cycle, which Node
 * refuses (ERR_REQUIRE_CYCLE_MODULE).
 * @param {object} channel
 * @returns {boolean}
 */
export function usesSlottedPacker(channel) {
  return (
    channel.align === "half-hour" ||
    (typeof channel.playOrder === "string" && channel.playOrder !== "shuffle") ||
    (Array.isArray(channel.dayparts) && channel.dayparts.length > 0) ||
    isObject(channel.timeRestrictions?.blockRatings)
  );
}

/**
 * A season date written "MM-DD" as month * 100 + day (`"10-01"` is 1001, `"02-29"` is 229), or
 * null when it is not two digits, a dash and two digits that name a real calendar day.
 * @param {unknown} text
 * @returns {number | null}
 */
export function parseSeasonDate(text) {
  const match = typeof text === "string" ? SEASON_DATE.exec(text) : null;
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > DAYS_IN_MONTH[month - 1]) return null;
  return month * 100 + day;
}

// Upstream's membership key: `tv:<tmdb>` or `movie:<tmdb>`, with no id kind.
const LEGACY_KEY = /^(tv|movie):(\d+)$/;

/**
 * Upstream Nostalgex's channels-memberships.json keyed the way itemKeys looks
 * items up: `tv:<n>` becomes `tv:tmdb:<n>` and `movie:<n>` becomes
 * `movie:tmdb:<n>`. A key that already names its id kind stays as it is. The
 * Roku tests and the filter parity test read upstream's file through this.
 * Returns a new object; the entries are the input's own.
 * @param {{ items?: Record<string, object> }} json the parsed file
 */
export function upgradeLegacyMemberships(json) {
  const items = {};
  for (const [key, entry] of Object.entries(json.items ?? {})) items[key.replace(LEGACY_KEY, "$1:tmdb:$2")] = entry;
  return { ...json, items };
}

/**
 * The lineup with the channels `ids` taken out of its shows and locks: each
 * show's `channels` loses them, a show's `exclusive` naming one goes, and a
 * show left on no channel goes. Each lock's `channelIDs` loses them, and a lock
 * left with none goes, since a lock with no owner would keep its matches off
 * every channel. A `blockShows` entry naming channels loses them too, and goes
 * when it names none; one for "kids" or "all" stays. The channels list stays as it is. Returns a new lineup with
 * the input's key order; the input is left as it was. Expects a lineup that
 * passed validateLineup.
 * @param {object} lineup
 * @param {number[]} ids
 */
export function withoutChannels(lineup, ids) {
  const gone = new Set(ids);
  const out = structuredClone(lineup);
  out.memberships.shows = out.memberships.shows.filter((show) => {
    for (const key of Object.keys(show.channels)) {
      if (gone.has(Number(key))) delete show.channels[key];
    }
    if (gone.has(show.exclusive)) delete show.exclusive;
    return Object.keys(show.channels).length > 0;
  });
  out.exclusiveRules = out.exclusiveRules.filter((rule) => {
    rule.channelIDs = rule.channelIDs.filter((id) => !gone.has(id));
    return rule.channelIDs.length > 0;
  });
  // A block on named channels loses the ones taken out, and goes when none is left.
  if (Array.isArray(out.blockShows)) {
    out.blockShows = out.blockShows.filter((entry) => {
      if (!Array.isArray(entry?.channels)) return true;
      entry.channels = entry.channels.filter((id) => !gone.has(id));
      return entry.channels.length > 0;
    });
  }
  return out;
}

/**
 * The lineup as the package ships it: no channel marked `hidden: true`, those
 * channels taken out of the shows and locks by withoutChannels, and no channel
 * `source`, which only the editor reads. A channel's `rules.source` stays.
 * This is the only thing that keeps a hidden channel off the TVs. Returns a
 * new lineup with the input's key order; the input is left as it was. Expects
 * a lineup that passed validateLineup.
 * @param {object} lineup
 */
export function packagedLineup(lineup) {
  const hidden = lineup.channels.filter((channel) => channel.hidden === true).map((channel) => channel.id);
  const out = withoutChannels(lineup, hidden);
  out.channels = out.channels.filter((channel) => channel.hidden !== true);
  for (const channel of out.channels) delete channel.source;
  return out;
}

/**
 * The first 12 hex characters of the SHA-1 of the text. The package stamps it
 * into the app, and the app keys its saved guide on it.
 * @param {string|Buffer} text the packaged lineup text that buildPackage ships
 */
export function lineupVersion(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

/**
 * items less the files the lineup's `badFiles` lists: an item leaves while both its rating key and
 * its reported length match, so a replaced file with a new length comes back on its own.
 * NxWithoutBadFiles (roku/source/lineup/LineupFile.brs) does the same on the TV.
 * @param {object[]} items
 * @param {{ badFiles?: { ratingKey: string, durationSec: number }[] }} lineup
 * @returns {object[]}
 */
export function withoutBadFiles(items, lineup) {
  const list = Array.isArray(lineup?.badFiles) ? lineup.badFiles : [];
  if (list.length === 0) return items;
  const lengths = new Map(list.map((entry) => [String(entry.ratingKey), entry.durationSec]));
  return items.filter((item) => {
    const key = String(item.ratingKey);
    return !(lengths.has(key) && lengths.get(key) === item.durationSec);
  });
}

/**
 * A show title as the blocklist compares it: spaces trimmed and run together, a year in brackets
 * at the end dropped, and lower case. So `Super Kitties` also blocks Plex's `Super Kitties (2023)`.
 * NxShowTitleKey (roku/source/lineup/LineupFile.brs) does the same on the TV.
 * @param {unknown} title
 * @returns {string} "" for anything but text
 */
export function showTitleKey(title) {
  if (typeof title !== "string") return "";
  return title.trim().replace(/\s+/g, " ").replace(/\s*\(\d{4}\)$/, "").toLowerCase();
}

/**
 * The shows the lineup's `blockShows` keeps off a channel, as showTitleKey keys. An entry covers
 * the channel when its `channels` is "all", is "kids" and the channel is marked Kids (`kids: true`),
 * or is a list holding the channel's id. The block holds in both profiles. An entry that is not
 * made right covers nothing (validateLineup refuses a file with one). NxBlockedShowKeys
 * (roku/source/lineup/LineupFile.brs) does the same on the TV.
 * @param {{ blockShows?: unknown } | null | undefined} lineup
 * @param {{ id: number, kids?: unknown }} channel
 * @returns {Set<string>}
 */
export function blockedShowKeys(lineup, channel) {
  const out = new Set();
  const list = Array.isArray(lineup?.blockShows) ? lineup.blockShows : [];
  for (const entry of list) {
    const key = showTitleKey(entry?.name);
    if (key === "") continue;
    const scope = entry.channels;
    const covers = scope === "all" || (scope === "kids" && channel.kids === true) || (Array.isArray(scope) && scope.includes(channel.id));
    if (covers) out.add(key);
  }
  return out;
}

/**
 * items less those of a show the lineup blocks on the channel (blockedShowKeys). An episode's
 * `title` is its show's, so every episode of a blocked show leaves; a movie leaves by its own
 * title. The same list back when the channel blocks nothing.
 * @param {object[]} items
 * @param {{ blockShows?: unknown } | null | undefined} lineup
 * @param {{ id: number, kids?: unknown }} channel
 * @returns {object[]}
 */
export function withoutBlockedShows(items, lineup, channel) {
  const blocked = blockedShowKeys(lineup, channel);
  if (blocked.size === 0) return items;
  return items.filter((item) => !blocked.has(showTitleKey(item?.title)));
}

/**
 * Checks a parsed lineup. Returns every problem found, not just the first.
 * Fields this version does not know are left alone, so a newer editor's file
 * still validates here.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateLineup(lineup) {
  if (!isObject(lineup)) return { ok: false, errors: ["lineup must be a JSON object"] };
  const errors = [];
  findSecretKeys(lineup, "", errors);
  checkHeader(lineup, errors);
  const shortNames = checkShorts(lineup.shorts, errors);
  checkBadFiles(lineup.badFiles, errors);
  const { ids, tags } = checkChannels(lineup.channels, shortNames, errors);
  checkBlockShows(lineup.blockShows, ids, errors);
  checkExclusiveRules(lineup.exclusiveRules, ids, errors);
  checkMemberships(lineup.memberships, ids, tags, errors);
  return { ok: errors.length === 0, errors };
}

/**
 * The lineup's `badFiles`: an optional list of `{ ratingKey, durationSec, note }`, one rating key
 * at most once. `note` is for the person reading the file.
 */
function checkBadFiles(badFiles, errors) {
  if (badFiles === undefined) return;
  if (!Array.isArray(badFiles)) {
    errors.push("badFiles must be a list");
    return;
  }
  const seen = new Set();
  badFiles.forEach((entry, i) => {
    const label = `badFiles[${i}]`;
    if (!isObject(entry)) {
      errors.push(`${label} must be an object`);
      return;
    }
    const { ratingKey, durationSec, note } = entry;
    if (typeof ratingKey !== "string" || ratingKey === "") errors.push(`${label}.ratingKey must be a non-empty string`);
    else if (seen.has(ratingKey)) errors.push(`${label} lists rating key ${ratingKey} twice`);
    else seen.add(ratingKey);
    if (!Number.isInteger(durationSec) || durationSec <= 0) errors.push(`${label}.durationSec must be a whole number above 0`);
    if (note !== undefined && typeof note !== "string") errors.push(`${label}.note must be a string`);
  });
}

/**
 * The lineup's `blockShows`: an optional list of `{ name, channels, note }`. `name` is a show title,
 * `channels` is "kids", "all" or a list of the lineup's channel ids, and `note` is for the person
 * reading the file. A show is listed once (by showTitleKey), so two entries never disagree.
 */
function checkBlockShows(blockShows, channelIds, errors) {
  if (blockShows === undefined) return;
  if (!Array.isArray(blockShows)) {
    errors.push("blockShows must be a list");
    return;
  }
  const seen = new Set();
  blockShows.forEach((entry, i) => {
    const label = `blockShows[${i}]`;
    if (!isObject(entry)) {
      errors.push(`${label} must be an object`);
      return;
    }
    const { name, channels, note } = entry;
    const key = showTitleKey(name);
    if (key === "") errors.push(`${label}.name must be a show title`);
    else if (seen.has(key)) errors.push(`${label} lists ${JSON.stringify(name)} a second time`);
    else seen.add(key);
    if (Array.isArray(channels)) {
      if (channels.length === 0) errors.push(`${label}.channels must name at least one channel`);
      for (const id of channels) {
        if (!Number.isInteger(id)) errors.push(`${label}.channels must hold channel ids`);
        else if (!channelIds.has(id)) errors.push(`${label} names unknown channel ${id}`);
      }
    } else if (channels !== "kids" && channels !== "all") {
      errors.push(`${label}.channels must be "kids", "all" or a list of channel ids`);
    }
    if (note !== undefined && typeof note !== "string") errors.push(`${label}.note must be a string`);
  });
}

/** A key shaped like a secret at any depth, objects and lists alike. */
function findSecretKeys(node, path, errors) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => findSecretKeys(item, `${path}[${i}]`, errors));
  } else if (isObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      const here = path ? `${path}.${key}` : key;
      if (SECRET_KEY.test(key)) errors.push(`lineup must not hold "${key}" (at ${here})`);
      findSecretKeys(value, here, errors);
    }
  }
}

function checkHeader(lineup, errors) {
  if (lineup.format !== 1) errors.push("format must be 1");
  if (!isText(lineup.name)) errors.push("name must be a non-empty string");
  if (lineup.theme !== undefined && !THEME_NAMES.includes(lineup.theme)) errors.push(`theme must be ${orList(THEME_NAMES)}`);

  if (!isObject(lineup.server)) {
    errors.push("server must be an object");
  } else {
    if (!isText(lineup.server.machineIdentifier)) errors.push("server.machineIdentifier must be a non-empty string");
    if (!isStringList(lineup.server.programSections)) errors.push("server.programSections must be a list of strings");
    for (const name of ["fillerSection", "musicSection"]) {
      if (lineup.server[name] !== undefined && !isText(lineup.server[name])) errors.push(`server.${name} must be a non-empty string`);
    }
  }

  if (!isObject(lineup.kids)) {
    errors.push("kids must be an object");
  } else if (!isStringList(lineup.kids.ratings)) {
    errors.push("kids.ratings must be a list of strings");
  } else {
    // kidsAllows compares each entry with the label normalizeRating gives an
    // item, so an entry in any other form never matches.
    for (const entry of lineup.kids.ratings) {
      const label = normalizeRating(entry);
      if (label === null) {
        errors.push(`kids.ratings entry ${JSON.stringify(entry)} means unrated and never matches: set kidsAllowUnrated on a channel instead`);
      } else if (label !== entry) {
        errors.push(`kids.ratings entry ${JSON.stringify(entry)} never matches: write it as ${JSON.stringify(label)}`);
      }
    }
  }
}

/**
 * Checks each channel. `shortNames` holds the names in the lineup's shorts list
 * (checkShorts), which a channel's filler.shorts must draw from. Returns the
 * set of channel ids the lineup defines, and each channel's daypart tags by id,
 * which a show's tag on that channel must name.
 * @param {unknown} channels
 * @param {Set<string> | null} shortNames
 * @returns {{ ids: Set<number>, tags: Map<number, Set<string>> }}
 */
function checkChannels(channels, shortNames, errors) {
  const ids = new Set();
  const tags = new Map();
  if (!Array.isArray(channels)) {
    errors.push("channels must be a list");
    return { ids, tags };
  }
  const numbers = new Set();
  channels.forEach((channel, i) => {
    if (!isObject(channel)) {
      errors.push(`channels[${i}] must be an object`);
      return;
    }
    const idOk = Number.isInteger(channel.id);
    const label = idOk ? `channel ${channel.id}` : `channels[${i}]`;
    if (!idOk) {
      errors.push(`${label} id must be a whole number`);
    } else {
      if (channel.id < MIN_CHANNEL_ID) errors.push(`channel id ${channel.id} is under ${MIN_CHANNEL_ID}`);
      if (ids.has(channel.id)) errors.push(`duplicate channel id ${channel.id}`);
      ids.add(channel.id);
    }

    const { number } = channel;
    if (!Number.isInteger(number) || number < 1 || number > MAX_GUIDE_NUMBER) {
      errors.push(`${label} number must be a whole number from 1 to ${MAX_GUIDE_NUMBER}`);
    } else {
      if (numbers.has(number)) errors.push(`duplicate channel number ${number}`);
      numbers.add(number);
    }

    if (!isText(channel.name)) errors.push(`${label} needs a name`);
    if (typeof channel.colorHex !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(channel.colorHex)) {
      errors.push(`${label} colorHex must look like #RRGGBB`);
    }
    if (!isCount(channel.minItems)) errors.push(`${label} minItems must be a whole number, 0 or more`);
    for (const flag of ["kids", "kidsAllowUnrated", "hidden"]) {
      if (channel[flag] !== undefined && typeof channel[flag] !== "boolean") {
        errors.push(`${label} ${flag} must be true or false`);
      }
    }
    checkKidsAllowShows(channel, label, errors);
    if (channel.logo !== undefined && !(typeof channel.logo === "string" && LOGO_FILE.test(channel.logo))) {
      errors.push(`${label} logo must be a file name ending in .png, such as 1006.png`);
    }
    checkWeather(channel, label, errors);
    checkSource(channel.source, label, errors);
    checkTimeRestrictions(channel.timeRestrictions, usesSlottedPacker(channel), label, errors);
    checkRules(channel.rules, label, errors);
    checkPlayOrder(channel, label, errors);
    const daypartTags = checkDayparts(channel.dayparts, label, errors);
    if (idOk) tags.set(channel.id, daypartTags);
    checkFiller(channel.filler, shortNames, label, errors);
    checkSeasons(channel.seasons, channel.kind === WEATHER_KIND, label, errors);
  });
  return { ids, tags };
}

/**
 * A channel's kidsAllowShows: show titles whose items pass the Kids rating limit on that channel
 * (kidsAllows). Each is a non-empty string, listed once, and only a channel with `kids: true`
 * takes the list, since the Kids profile never reads it anywhere else.
 */
function checkKidsAllowShows(channel, label, errors) {
  const list = channel.kidsAllowShows;
  if (list === undefined) return;
  if (!Array.isArray(list) || !list.every(isText)) {
    errors.push(`${label} kidsAllowShows must be a list of show titles, each a non-empty string`);
    return;
  }
  if (channel.kids !== true) errors.push(`${label} kidsAllowShows needs kids: true`);
  const seen = new Set();
  for (const title of list) {
    if (seen.has(title)) errors.push(`${label} kidsAllowShows lists ${JSON.stringify(title)} twice`);
    seen.add(title);
  }
}

/** `"a", "b" or "c"`: the values a field takes, for a message. */
function orList(values) {
  const names = values.map((value) => JSON.stringify(value));
  return `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

/**
 * kind, location and units. A channel with the kind needs a location (a name, and a latitude
 * and longitude on the map); a location and units are checked wherever they appear, so a
 * value the app would send to the weather service is always one it can use.
 */
function checkWeather(channel, label, errors) {
  const { kind, location, units } = channel;
  const kindOk = kind === undefined || kind === WEATHER_KIND;
  if (!kindOk) errors.push(`${label} kind must be ${JSON.stringify(WEATHER_KIND)}`);
  if (location !== undefined || kind === WEATHER_KIND) {
    if (!isObject(location)) {
      errors.push(`${label} needs a location with a name, lat and lon`);
    } else {
      if (!isText(location.name)) errors.push(`${label} location.name must be a non-empty string`);
      if (!isNumber(location.lat) || Math.abs(location.lat) > 90) errors.push(`${label} location.lat must be a number from -90 to 90`);
      if (!isNumber(location.lon) || Math.abs(location.lon) > 180) errors.push(`${label} location.lon must be a number from -180 to 180`);
    }
  }
  if (units !== undefined && !WEATHER_UNITS.includes(units)) errors.push(`${label} units must be ${orList(WEATHER_UNITS)}`);
}

/** playOrder, blockSize (only with "blocks") and align. */
function checkPlayOrder(channel, label, errors) {
  const { playOrder, blockSize, align } = channel;
  if (playOrder !== undefined && !PLAY_ORDERS.includes(playOrder)) errors.push(`${label} playOrder must be ${orList(PLAY_ORDERS)}`);
  if (blockSize !== undefined) {
    if (!Number.isInteger(blockSize) || blockSize < MIN_BLOCK_SIZE || blockSize > MAX_BLOCK_SIZE) {
      errors.push(`${label} blockSize must be a whole number from ${MIN_BLOCK_SIZE} to ${MAX_BLOCK_SIZE}`);
    }
    if (playOrder !== "blocks") errors.push(`${label} blockSize needs playOrder "blocks"`);
  }
  if (align !== undefined && !ALIGNMENTS.includes(align)) errors.push(`${label} align must be ${orList(ALIGNMENTS)}`);
}

/** Minutes past midnight of a daypart time, or null when it is not one. */
function daypartMinutes(time, isEnd) {
  if (isEnd && time === END_OF_DAY) return 24 * 60;
  const match = typeof time === "string" ? HALF_HOUR.exec(time) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Each daypart: days, a start before its end, both on the hour or half hour,
 * and a tag. Two dayparts that share a day may not overlap; one may end where
 * the next starts. Returns the tags the dayparts name, a malformed daypart's
 * included, so a show tagged for that daypart gets no second error.
 * @returns {Set<string>}
 */
function checkDayparts(dayparts, label, errors) {
  const tags = new Set();
  if (dayparts === undefined) return tags;
  if (!Array.isArray(dayparts)) {
    errors.push(`${label} dayparts must be a list`);
    return tags;
  }
  const parts = []; // the well-formed dayparts, times in minutes
  dayparts.forEach((part, i) => {
    const here = `${label} dayparts[${i}]`;
    if (!isObject(part)) {
      errors.push(`${here} must be an object`);
      return;
    }
    let ok = true;
    const fail = (message) => {
      errors.push(`${here}${message}`);
      ok = false;
    };
    const { days, tag } = part;
    if (!Array.isArray(days) || days.length === 0 || !days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) {
      fail(".days must be a non-empty list of whole numbers from 0 (Sunday) to 6 (Saturday)");
    }
    if (isText(tag)) tags.add(tag);
    else fail(".tag must be a non-empty string");
    const from = daypartMinutes(part.from, false);
    const to = daypartMinutes(part.to, true);
    if (from === null) fail(`.from must be ${ON_THE_HALF_HOUR}`);
    if (to === null) fail(`.to must be ${ON_THE_HALF_HOUR}`);
    if (from !== null && to !== null && from >= to) {
      fail(` must end after it starts (from ${JSON.stringify(part.from)}, to ${JSON.stringify(part.to)})`);
    }
    if (ok) parts.push({ days, from, to, tag, i });
  });
  for (const [n, a] of parts.entries()) {
    for (const b of parts.slice(n + 1)) {
      const day = a.days.find((d) => b.days.includes(d));
      if (day !== undefined && a.from < b.to && b.from < a.to) {
        errors.push(`${label} dayparts[${a.i}] and dayparts[${b.i}] overlap on ${DAY_NAMES[day]}`);
      }
    }
  }
  return tags;
}

/**
 * filler: `on` and `midShow` true or false, `minBreak` minutes, a network folder, a list of decades and the shorts
 * the channel plays.
 */
function checkFiller(filler, shortNames, label, errors) {
  if (filler === undefined) return;
  if (!isObject(filler)) {
    errors.push(`${label} filler must be an object`);
    return;
  }
  if (typeof filler.on !== "boolean") errors.push(`${label} filler.on must be true or false`);
  if (filler.midShow !== undefined && typeof filler.midShow !== "boolean") errors.push(`${label} filler.midShow must be true or false`);
  if (filler.minBreak !== undefined && !(Number.isInteger(filler.minBreak) && filler.minBreak >= 0 && filler.minBreak <= 20)) {
    errors.push(`${label} filler.minBreak must be a whole number of minutes from 0 to 20`);
  }
  if (filler.network !== undefined && !isText(filler.network)) errors.push(`${label} filler.network must be a non-empty string`);
  if (filler.decades !== undefined && !isStringList(filler.decades)) errors.push(`${label} filler.decades must be a list of strings`);
  if (filler.shorts !== undefined) checkFillerShorts(filler.shorts, shortNames, label, errors);
}

/**
 * A channel's filler.shorts: names from the lineup's shorts list, each once. An empty list means
 * no shorts. It is independent of `on`: shorts play with commercials off.
 * @param {Set<string> | null} shortNames null when the lineup has no shorts list
 */
function checkFillerShorts(list, shortNames, label, errors) {
  if (!isStringList(list)) {
    errors.push(`${label} filler.shorts must be a list of show names`);
    return;
  }
  if (list.length > 0 && shortNames === null) {
    errors.push(`${label} filler.shorts needs the lineup's shorts list`);
    return;
  }
  const seen = new Set();
  for (const name of list) {
    if (seen.has(name)) errors.push(`${label} filler.shorts lists ${JSON.stringify(name)} twice`);
    else if (!shortNames.has(name)) errors.push(`${label} filler.shorts names ${JSON.stringify(name)}, which is not in the lineup's shorts list`);
    seen.add(name);
  }
}

/**
 * A channel's `seasons`: a non-empty list of { name, from, to, words, genres }. The names are
 * unique on the channel, `from` and `to` are dates (parseSeasonDate), `words` is a list of
 * words and phrases the Roku's `` reads as JavaScript's does, and `genres` is a list of
 * non-empty strings. A season needs words or genres. A weather channel airs no library item, so
 * it takes none.
 * @param {boolean} weather whether the channel is the weather channel
 */
function checkSeasons(seasons, weather, label, errors) {
  if (seasons === undefined) return;
  if (weather) errors.push(`${label} seasons can't be used on a weather channel`);
  if (!Array.isArray(seasons) || seasons.length === 0) {
    errors.push(`${label} seasons must be a non-empty list`);
    return;
  }
  const names = new Set();
  seasons.forEach((season, i) => {
    const here = `${label} seasons[${i}]`;
    if (!isObject(season)) {
      errors.push(`${here} must be an object`);
      return;
    }
    if (!isText(season.name)) errors.push(`${here}.name must be a non-empty string`);
    else if (names.has(season.name)) errors.push(`${label} seasons has two entries named ${JSON.stringify(season.name)}`);
    else names.add(season.name);
    for (const field of ["from", "to"]) {
      if (parseSeasonDate(season[field]) === null) errors.push(`${here}.${field} must be a date written "MM-DD", such as "10-01"`);
    }
    // Words and genres: a list that is wrong is reported on its own, so it is not also "missing".
    let listed = false;
    let wrong = false;
    const { words, genres } = season;
    if (words !== undefined) {
      if (!Array.isArray(words)) {
        errors.push(`${here}.words must be a list`);
        wrong = true;
      } else {
        words.forEach((word, j) => {
          if (typeof word !== "string" || !SEASON_WORD.test(word)) {
            errors.push(`${here}.words[${j}] must start and end with a letter or digit and hold only letters, digits, spaces, apostrophes and hyphens`);
          }
        });
        listed ||= words.length > 0;
      }
    }
    if (genres !== undefined) {
      if (!Array.isArray(genres) || !genres.every(isText)) {
        errors.push(`${here}.genres must be a list of non-empty strings`);
        wrong = true;
      } else {
        listed ||= genres.length > 0;
      }
    }
    if (!listed && !wrong) errors.push(`${here} needs words or genres`);
  });
}

/**
 * The lineup's `shorts`: an optional object with `maxMinutes` (a whole number from 1 to 20) and
 * `shows`, a non-empty list of series. Each entry has a name, mediaType "tv" and an id, checked as
 * a membership entry is, and no two entries share an index key or a name. Returns the names of
 * the entries that have one, or null when the lineup has no shorts list.
 * @returns {Set<string> | null}
 */
function checkShorts(shorts, errors) {
  if (shorts === undefined) return null;
  const names = new Set();
  if (!isObject(shorts)) {
    errors.push("shorts must be an object");
    return names;
  }
  const { maxMinutes } = shorts;
  if (maxMinutes !== undefined && !(Number.isInteger(maxMinutes) && maxMinutes >= MIN_SHORT_MINUTES && maxMinutes <= MAX_SHORT_MINUTES)) {
    errors.push(`shorts.maxMinutes must be a whole number from ${MIN_SHORT_MINUTES} to ${MAX_SHORT_MINUTES}`);
  }
  if (!Array.isArray(shorts.shows) || shorts.shows.length === 0) {
    errors.push("shorts.shows must be a non-empty list");
    return names;
  }
  const owners = new Map(); // index key -> name of the entry that holds it
  shorts.shows.forEach((show, i) => {
    const here = `shorts.shows[${i}]`;
    if (!isObject(show)) {
      errors.push(`${here} must be an object`);
      return;
    }
    const name = isText(show.name) ? show.name : here;
    if (!isText(show.name)) errors.push(`${name} needs a name`);
    else if (names.has(name)) errors.push(`shorts.shows has two entries named ${JSON.stringify(name)}`);
    else names.add(name);
    if (show.mediaType !== "tv") errors.push(`${name} mediaType must be "tv"`);
    checkShowIds(show, name, errors);
    claimIndexKeys(show, name, owners, errors);
  });
  return names;
}

/** The editor's `source`: a known kind, with every part of that kind, each of its kind. */
function checkSource(source, label, errors) {
  if (source === undefined) return;
  if (!isObject(source)) {
    errors.push(`${label} source must be an object`);
    return;
  }
  if (source.kind === undefined) {
    errors.push(`${label} source needs a kind`);
    return;
  }
  if (!Object.hasOwn(SOURCE_PARTS, source.kind)) {
    errors.push(`${label} has unknown source kind ${JSON.stringify(source.kind)}`);
    return;
  }
  for (const [part, kind] of Object.entries(SOURCE_PARTS[source.kind])) {
    const [ok, what] = KIND_CHECKS[kind];
    if (!ok(source[part])) errors.push(`${label} source.${part} must be ${what}`);
  }
}

/**
 * Each part NxTimeFilteredPool and getTimeFilteredPool read, by its kind. A
 * channel on the slot packer (`slotted`) takes no hour filter: the slot
 * packer never reads one.
 */
function checkTimeRestrictions(tr, slotted, label, errors) {
  if (tr === undefined) return;
  if (!isObject(tr)) {
    errors.push(`${label} timeRestrictions must be an object`);
    return;
  }
  const hours = (owner, path, names) => {
    for (const name of names) {
      if (owner[name] !== undefined && !isHour(owner[name])) {
        errors.push(`${label} timeRestrictions.${path}${name} must be a whole number from 0 to 24`);
      }
    }
  };
  hours(tr, "", HOUR_FILTERS);
  if (slotted) {
    for (const name of HOUR_FILTERS.filter((name) => tr[name] !== undefined)) {
      errors.push(`${label} timeRestrictions.${name} can't be used with align, playOrder, dayparts or blockRatings`);
    }
  }
  const br = tr.blockRatings;
  if (br === undefined) return;
  if (!isObject(br)) {
    errors.push(`${label} timeRestrictions.blockRatings must be an object`);
    return;
  }
  // JS throws on a block with no ratings list; the Roku blocks nothing.
  if (!isStringList(br.ratings)) errors.push(`${label} timeRestrictions.blockRatings.ratings must be a list of strings`);
  hours(br, "blockRatings.", ["blockBefore", "blockAfter"]);
}

function checkRules(rules, label, errors) {
  if (!isObject(rules)) {
    errors.push(`${label} rules must be an object`);
    return;
  }
  for (const name of Object.keys(rules)) {
    if (!RULE_FIELDS.has(name)) errors.push(`${label} rule "${name}" is not supported`);
  }
  const present = (name) => rules[name] !== undefined;
  for (const name of RULE_STRINGS.filter(present)) {
    if (typeof rules[name] !== "string") errors.push(`${label} rule ${name} must be a string`);
  }
  for (const name of RULE_FLAGS.filter(present)) {
    if (typeof rules[name] !== "boolean") errors.push(`${label} rule ${name} must be true or false`);
  }
  for (const name of RULE_NUMBERS.filter(present)) {
    if (!isNumber(rules[name])) errors.push(`${label} rule ${name} must be a number`);
  }
  for (const name of RULE_WORD_LISTS.filter(present)) {
    if (!isStringList(rules[name])) errors.push(`${label} rule ${name} must be a list of strings`);
  }
  for (const [name, parts] of Object.entries(RULE_OBJECTS)) {
    if (!present(name)) continue;
    const value = rules[name];
    if (!isObject(value)) {
      errors.push(`${label} rule ${name} must be an object`);
      continue;
    }
    for (const [part, kind] of Object.entries(parts)) {
      const [ok, what] = KIND_CHECKS[kind];
      if (value[part] !== undefined && !ok(value[part])) errors.push(`${label} rule ${name}.${part} must be ${what}`);
    }
  }
}

function checkExclusiveRules(rules, channelIds, errors) {
  if (!Array.isArray(rules)) {
    errors.push("exclusiveRules must be a list");
    return;
  }
  rules.forEach((rule, i) => {
    const label = `exclusiveRules[${i}]`;
    if (!isObject(rule)) {
      errors.push(`${label} must be an object`);
      return;
    }
    if (!Array.isArray(rule.channelIDs) || !rule.channelIDs.every(Number.isInteger)) {
      errors.push(`${label}.channelIDs must be a list of channel ids`);
    } else if (rule.channelIDs.length === 0) {
      // A lock with no owner keeps its matches off every channel.
      errors.push(`${label}.channelIDs must name at least one channel`);
    } else {
      for (const id of rule.channelIDs) {
        if (!channelIds.has(id)) errors.push(`${label} names unknown channel ${id}`);
      }
    }
    for (const [field, kind] of Object.entries(LOCK_FIELDS)) {
      const [ok, what] = KIND_CHECKS[kind];
      if (rule[field] !== undefined && !ok(rule[field])) errors.push(`${label}.${field} must be ${what}`);
    }
  });
}

/** `tags` maps each channel id to the tags its dayparts name. */
function checkMemberships(memberships, channelIds, tags, errors) {
  if (!isObject(memberships) || !Array.isArray(memberships.shows)) {
    errors.push("memberships.shows must be a list");
    return;
  }
  const owners = new Map(); // index key -> name of the show that holds it
  memberships.shows.forEach((show, i) => {
    if (!isObject(show)) {
      errors.push(`memberships.shows[${i}] must be an object`);
      return;
    }
    const name = isText(show.name) ? show.name : `memberships.shows[${i}]`;
    if (!isText(show.name)) errors.push(`${name} needs a name`);
    if (show.mediaType !== "tv" && show.mediaType !== "movie") errors.push(`${name} mediaType must be "tv" or "movie"`);
    checkShowIds(show, name, errors);
    claimIndexKeys(show, name, owners, errors);

    const onChannels = checkShowChannels(show, name, channelIds, tags, errors);
    if (show.exclusive !== undefined && !onChannels.has(show.exclusive)) {
      errors.push(`${name} is exclusive to channel ${show.exclusive} but is not on it`);
    }
  });
}

/** A show's tmdb, tvdb and imdb ids: each well formed when given, and at least one given. */
function checkShowIds(show, name, errors) {
  for (const field of ["tmdb", "tvdb"]) {
    if (show[field] !== undefined && !isPositiveInt(show[field])) {
      errors.push(`${name} ${field} must be a positive whole number`);
    }
  }
  if (show.imdb !== undefined && !(typeof show.imdb === "string" && /^tt\d+$/.test(show.imdb))) {
    errors.push(`${name} imdb must look like "tt0101188"`);
  }
  if (show.tmdb === undefined && show.tvdb === undefined && show.imdb === undefined) {
    errors.push(`${name} needs a tmdb, tvdb or imdb id`);
  }
}

/**
 * Records the show's index keys in `owners` (key to the name that holds it), and reports a key an
 * earlier show holds.
 * @param {Map<string, string>} owners
 */
function claimIndexKeys(show, name, owners, errors) {
  for (const key of keysFor(show.mediaType, show.tmdb, show.tvdb, show.imdb)) {
    if (owners.has(key)) errors.push(`${name} and ${owners.get(key)} both use ${key}`);
    else owners.set(key, name);
  }
}

/**
 * The channel id a `channels` key stands for, or NaN when the key is not the
 * canonical spelling of a whole number. membershipIndex turns a key into a
 * number and reads the show's entry back by that number's string, so "01006"
 * would pass as 1006 and then find nothing, or sit beside "1006" as a second
 * entry for the same channel.
 */
function channelIdOfKey(key) {
  if (!/^\d+$/.test(key)) return NaN;
  const id = Number(key);
  return String(id) === key ? id : NaN;
}

/**
 * Checks a show's `channels` object and returns the ids it names. A `tag` on
 * a channel must be one of that channel's daypart tags.
 */
function checkShowChannels(show, name, channelIds, tags, errors) {
  const onChannels = new Set();
  if (!isObject(show.channels)) {
    errors.push(`${name} channels must be an object keyed by channel id`);
    return onChannels;
  }
  for (const [key, entry] of Object.entries(show.channels)) {
    const id = channelIdOfKey(key);
    if (!channelIds.has(id)) {
      errors.push(`${name} names unknown channel ${key}`);
      continue;
    }
    onChannels.add(id);
    if (!isObject(entry)) {
      errors.push(`${name} channel ${key} must be an object`);
      continue;
    }
    if (entry.lastYear !== undefined && !isYear(entry.lastYear)) {
      errors.push(`${name} channel ${key} lastYear must be a whole number from ${MIN_YEAR} to ${MAX_YEAR}`);
    }
    if (entry.tag !== undefined && !tags.get(id)?.has(entry.tag)) {
      errors.push(`${name} channel ${key} tag ${JSON.stringify(entry.tag)} matches no daypart on that channel`);
    }
  }
  return onChannels;
}
