// time-filter.cjs, wrapped for the page by tools/build-web.mjs. Edit the file in shared/, then build again.
import dep0 from "./nostalgex-channel-filter.cjs.js";
const deps = { "./nostalgex-channel-filter.cjs": dep0 };
const module = { exports: {} };
(function (module, exports, require) {
// Portions copyright (c) 2024 Chad Mueller / Muell Haus Inc. (Nostalgex), MIT License.
// Ported from upstream plex-tuner.html getTimeFilteredPool at ee2f5d9; see LICENSE-UPSTREAM.
//
// What a channel may air at a given hour. Upstream reads the channel's
// itemPool and the browser clock; here the caller passes the pool and the
// local hour (0-23), so the same answer can be generated for any hour.
//
// Upstream mirrors Channel.filteredPool() in the Apple TV app. Keep the three
// branches in their order, and the episodes-only "keep at least two items"
// guard: the Roku port (NxTimeFilteredPool in source/guide/Lineup.brs) is
// checked against vectors made from this file. The rating block has no such
// guard here. Upstream's put the whole pool back when fewer than two items
// got past it, blocked ratings included (design section 9, filter gap 1).
const { usContentRating } = require("./nostalgex-channel-filter.cjs");

/**
 * @param {{ timeRestrictions?: { blockRatings?: { ratings: string[], blockBefore?: number, blockAfter?: number },
 *   tvOnlyBefore?: number, onlyAfterHour?: number } }} channel
 * @param {Array<{ type?: string, contentRating?: string }>} pool
 * @param {number} hour local hour of day, 0-23
 */
function getTimeFilteredPool(channel, pool, hour) {
  // A missing or fractional hour compares false against every bound, which
  // would lift every restriction.
  if (!Number.isInteger(hour)) throw new TypeError(`hour must be a whole number, not ${hour}`);
  const tr = channel.timeRestrictions;
  if (!tr) return pool;
  let items = pool;

  // Block ratings (for example R-rated content before 9 PM).
  if (tr.blockRatings) {
    const { ratings, blockBefore, blockAfter } = tr.blockRatings;
    const isBlocked = (blockBefore != null && hour < blockBefore)
                   || (blockAfter != null && hour >= blockAfter);
    if (isBlocked) {
      // A rating from another country counts as its US label: GB-18 waits for 9 PM like R.
      items = items.filter((item) => !ratings.includes(usContentRating(item.contentRating, item.type)));
    }
  }

  // TV only before an hour (for example only episodes before 11 AM).
  if (tr.tvOnlyBefore != null && hour < tr.tvOnlyBefore) {
    const episodesOnly = items.filter((item) => item.type === "episode");
    if (episodesOnly.length >= 2) items = episodesOnly;
  }

  // Prime time gate: the channel is off the air before this hour.
  if (tr.onlyAfterHour != null && hour < tr.onlyAfterHour) return [];

  return items;
}

module.exports = { getTimeFilteredPool };

})(module, module.exports, (spec) => deps[spec]);
export default module.exports;
