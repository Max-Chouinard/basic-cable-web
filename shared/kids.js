// The Kids profile's rating filter (design section 9). A Kids channel airs its
// full pool, in order, less every item whose rating is not on the lineup's
// Kids list (kids.ratings). It runs on the pool the channel filter built, so
// it applies after every way an item reaches a channel, curated lists and
// editorial picks included. A channel may list show titles in kidsAllowShows;
// an item of a listed show passes the rating limit on that channel only. The
// Roku port is source/kids/KidsFilter.brs, checked against vectors that
// roku/tests/gen-kids.mjs makes from this file.

// The labels that mean Plex has no rating, after normalizing.
const UNRATED = new Set(["", "NR", "NOT RATED", "UNRATED"]);

/**
 * Design section 9's default Kids limit, each label in the form normalizeRating
 * gives, so validateLineup takes the list as it is. Copy it before changing it.
 */
export const DEFAULT_KIDS_RATINGS = Object.freeze(["TV-Y", "TV-Y7", "TV-G", "G", "C", "C8"]);

/**
 * A Plex rating as the Kids list writes it: trimmed, upper case, without the
 * country prefix Plex gives Canadian and some US labels (`ca/C8`, `CA-C`,
 * `us/TV-G`), and TV-Y7-FV read as TV-Y7. null when there is no rating.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeRating(raw) {
  if (typeof raw !== "string") return null;
  let label = raw.trim().toUpperCase();
  if (/^(CA|US)[/-]/.test(label)) label = label.slice(3);
  if (label === "TV-Y7-FV") label = "TV-Y7";
  return UNRATED.has(label) ? null : label;
}

/**
 * The show titles a channel lets past the Kids rating limit (its
 * kidsAllowShows): the list as it is when it is a list of non-empty strings,
 * else [], so a list written any other way lets nothing in.
 * @param {{ kidsAllowShows?: unknown } | null | undefined} channel
 * @returns {string[]}
 */
export function kidsAllowedShows(channel) {
  const list = channel?.kidsAllowShows;
  return Array.isArray(list) && list.every((title) => typeof title === "string" && title !== "") ? list : [];
}

/**
 * Whether a Kids channel may air the item. An item whose show title (an
 * episode's show, a movie's own title) is exactly one of `allowShows` passes
 * whatever its rating: the channel's kidsAllowShows lets those shows past the
 * rating limit and the unrated check, and nothing else. Any other item goes
 * by its rating. An episode's own rating (episodeRating) decides when Plex has
 * one, else the item's contentRating, which for an episode is its show's. An
 * episode rated NR or Not Rated has no rating of its own, so a TV-MA show's NR
 * episode goes by TV-MA. A rated item passes only when its label is in
 * `ratings`; an unrated one only when the channel allows unrated items.
 * @param {{ title?: string, contentRating?: string, episodeRating?: string }} item
 * @param {string[]} ratings the lineup's kids.ratings
 * @param {boolean} allowUnrated the channel's kidsAllowUnrated
 * @param {string[]} [allowShows] the channel's kidsAllowShows (kidsAllowedShows)
 */
export function kidsAllows(item, ratings, allowUnrated, allowShows = []) {
  if (typeof item.title === "string" && item.title !== "" && allowShows.includes(item.title)) return true;
  const label = normalizeRating(item.episodeRating) ?? normalizeRating(item.contentRating);
  if (label === null) return allowUnrated === true;
  return ratings.includes(label);
}

/**
 * A channel's Kids pool: [] unless the lineup marks it `kids: true`, else its
 * pool in order, less the items kidsAllows turns away. The guide shows the
 * channel in Kids only while this holds minItems or more.
 * @template {{ title?: string, contentRating?: string, episodeRating?: string }} Item
 * @param {Item[]} pool
 * @param {{ ratings: string[] }} kids the lineup's kids
 * @param {{ kids?: boolean, kidsAllowUnrated?: boolean, kidsAllowShows?: string[] }} channel
 * @returns {Item[]}
 */
export function kidsPool(pool, kids, channel) {
  if (channel.kids !== true) return [];
  const ratings = Array.isArray(kids?.ratings) ? kids.ratings : [];
  const allowUnrated = channel.kidsAllowUnrated === true;
  const allowShows = kidsAllowedShows(channel);
  return pool.filter((item) => kidsAllows(item, ratings, allowUnrated, allowShows));
}
