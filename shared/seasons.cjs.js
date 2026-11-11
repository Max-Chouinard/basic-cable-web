// seasons.cjs, wrapped for the page by tools/build-web.mjs. Edit the file in shared/, then build again.
import dep0 from "./nostalgex-channel-filter.cjs.js";
import * as dep1 from "./lineup.js";
const deps = { "./nostalgex-channel-filter.cjs": dep0, "./lineup.js": dep1 };
const module = { exports: {} };
(function (module, exports, require) {
// Seasons: a channel's windows of the year and the items that belong to each. A channel that lists
// `seasons` airs, on a day inside one or more of them, only the items that match an active season,
// and leaves the guide on a day inside none (docs/lineup-format.md, "Seasons"). The season is cut
// after the channel's filter, so the filter's result does not change with the date and a launch
// can reuse it.
//
// This file is the source of truth: the BrightScript port (roku/source/schedule/Seasons.brs) is
// checked against vectors that roku/tests/gen-seasons.mjs makes from it.
const { titleContainsWord } = require("./nostalgex-channel-filter.cjs");
const { parseSeasonDate } = require("./lineup.js");

/** A channel's seasons, or [] when it has none. */
function seasonsOf(channel) {
  return Array.isArray(channel?.seasons) ? channel.seasons : [];
}

/**
 * Whether the season's window holds on `md`, a day written month * 100 + day. Both ends are
 * inclusive. A `from` after the `to` wraps the new year, and equal dates make a one-day window.
 * False when either date is unreadable.
 * @param {{ from?: unknown, to?: unknown }} season
 * @param {number} md
 */
function seasonHolds(season, md) {
  const from = parseSeasonDate(season?.from);
  const to = parseSeasonDate(season?.to);
  if (from === null || to === null) return false;
  return from <= to ? md >= from && md <= to : md >= from || md <= to;
}

/**
 * The channel's seasons that hold on `md`, in the order the channel lists them.
 * @param {{ seasons?: object[] }} channel
 * @param {number} md
 */
function activeSeasons(channel, md) {
  return seasonsOf(channel).filter((season) => seasonHolds(season, md));
}

/**
 * The text a season word is matched against: an episode's own title, else the title with a
 * trailing " (YYYY)" taken off, all in lower case. This is the own title episodeRulesMatch reads,
 * so an episode of Santa Clarita Diet called "Pilot" does not match "santa".
 */
function ownTitle(item) {
  if (item?.type === "episode") return String(item.episodeTitle || "").toLowerCase();
  return String(item?.title || "").toLowerCase().replace(/ \(\d{4}\)$/, "");
}

/**
 * Whether the item belongs to the season: a word of the season is a whole-word match in the
 * item's own title (a phrase matches as written), or the item is not an episode and one of its
 * genres equals one of the season's genres, ignoring case.
 * @param {object} item
 * @param {{ words?: string[], genres?: string[] }} season
 */
function seasonMatches(item, season) {
  const own = ownTitle(item);
  if (own !== "" && Array.isArray(season?.words) && season.words.some((word) => titleContainsWord(own, String(word)))) return true;
  if (item?.type === "episode" || !Array.isArray(season?.genres) || !Array.isArray(item?.genres)) return false;
  const wanted = season.genres.map((genre) => String(genre).toLowerCase());
  return item.genres.some((genre) => wanted.includes(String(genre).toLowerCase()));
}

/**
 * Whether some season of the channel matches the item, whatever the season's dates. The library
 * load cuts a channel's filter result to these once, so the pools file stays small and the
 * result serves every day of the year.
 * @param {object} item
 * @param {{ seasons?: object[] }} channel
 */
function seasonEligible(item, channel) {
  return seasonsOf(channel).some((season) => seasonMatches(item, season));
}

/**
 * What the channel airs on `md`: a channel without seasons gets its items as they are (the same
 * array), and otherwise the items, in order, that match at least one season active on `md`.
 * That is [] when no season is active.
 * @template {object} Item
 * @param {Item[]} items
 * @param {{ seasons?: object[] }} channel
 * @param {number} md
 * @returns {Item[]}
 */
function seasonalPool(items, channel, md) {
  if (seasonsOf(channel).length === 0) return items;
  const active = activeSeasons(channel, md);
  if (active.length === 0) return [];
  return items.filter((item) => active.some((season) => seasonMatches(item, season)));
}

/**
 * The channels' active seasons on `md`, for the saved pools' key: for each channel with seasons,
 * `<id>:<positions of its active seasons, comma separated>`, joined with `|`, as `1015:0,1|1046:`.
 * "" when no channel has seasons.
 * @param {{ id: number, seasons?: object[] }[]} channels
 * @param {number} md
 */
function activeSeasonsKey(channels, md) {
  return channels
    .filter((channel) => seasonsOf(channel).length > 0)
    .map((channel) => {
      const positions = [];
      seasonsOf(channel).forEach((season, i) => {
        if (seasonHolds(season, md)) positions.push(i);
      });
      return `${channel.id}:${positions.join(",")}`;
    })
    .join("|");
}

/**
 * Month * 100 + day of an instant in the process's time zone: the day a season's window is read
 * against.
 * @param {number} ms
 */
function localMonthDay(ms) {
  const date = new Date(ms);
  return (date.getMonth() + 1) * 100 + date.getDate();
}

module.exports = { seasonHolds, activeSeasons, seasonMatches, seasonEligible, seasonalPool, activeSeasonsKey, localMonthDay };

})(module, module.exports, (spec) => deps[spec]);
export default module.exports;
