// filler.cjs, wrapped for the page by tools/build-web.mjs. Edit the file in shared/, then build again.
import dep0 from "./nostalgex-daily-manifest.cjs.js";
const deps = { "./nostalgex-daily-manifest.cjs": dep0 };
const module = { exports: {} };
(function (module, exports, require) {
// Filler: the clips a channel's breaks draw from, and what plays through a
// break. The clips are the files of the lineup's filler library
// (server.fillerSection), laid out as Filler/<network>/<decade>/<type>/. A
// pad (a slot packer block with kind "pad") becomes a break plan when it
// plays: a station ID, then the cartoon shorts the channel lists, then
// commercials, bumpers and other clips, then the app's own cards to the
// pad's end. On a kids channel the cards are an activity break. The plan
// comes from the channel and the pad's start alone, and the shorts from the
// channel and the day, so a viewer who tunes in part way joins the same
// break. docs/lineup-format.md describes the folders, the channel's
// `filler` and the shorts.
//
// This file is the source of truth: the BrightScript port's test vectors
// (roku/tests/gen-filler.mjs) are made from it.
const { makeSeededRNG, swiftShuffle } = require("./nostalgex-daily-manifest.cjs");

// The type folders the layout names.
const TYPES = ["commercial", "bumper", "station-id"];
// The cards, in the order they take turns, and how long each one shows.
const CARDS = ["station-id", "up-next", "be-right-back"];
const CARD_SEC = 15;
// A kids channel's activity break: a station ID card, one activity, then the
// next program. The activities take turns, one per half hour.
const ACTIVITIES = ["tidy", "move", "art", "book"];
const ACTIVITY_ID_SEC = 10;
const ACTIVITY_NEXT_SEC = 20;
const ACTIVITY_MIN_SEC = 60;
const ACTIVITY_TURN_SEC = 1800;

/**
 * @typedef {{ network: string | null, decade: string | null,
 *   fillerType: "commercial" | "bumper" | "station-id" | null, kids: boolean }} FillerFields
 * @typedef {{ ratingKey: string, durationSec: number, filePath: string } & FillerFields} Clip
 * @typedef {{ ratingKey: string, durationSec: number }} Short a cartoon short; the guide's record has more fields
 * @typedef {{ kind: "clip", ratingKey: string, startOffset: number, durationSec: number, short?: true }
 *   | { kind: "card", card: "station-id" | "up-next" | "be-right-back", startOffset: number, durationSec: number }
 *   | { kind: "card", card: "activity", activity: "tidy" | "move" | "art" | "book", startOffset: number, durationSec: number }} Entry
 */

/**
 * What a clip's file path says about it. The folders below the innermost
 * Filler folder are the network, the decade and the type, in that order, and
 * a kids folder anywhere among them marks the clip kids-safe, the only mark
 * there is (Ruling S20). Filler, kids and the type folders match without
 * case; the network and decade keep theirs. A type folder the layout doesn't
 * name, or none, leaves the type null. A path with no Filler folder is
 * generic: all null, not kids. Slashes and backslashes both divide folders.
 *
 * @param {string} path the file's path on the Plex server
 * @returns {FillerFields}
 */
function parseFillerPath(path) {
  const generic = { network: null, decade: null, fillerType: null, kids: false };
  if (typeof path !== "string") return generic;
  // The folders, less the file's own name.
  const folders = path.split(/[\\/]/).filter((part) => part !== "").slice(0, -1);
  let filler = -1;
  folders.forEach((folder, i) => {
    if (folder.toLowerCase() === "filler") filler = i;
  });
  if (filler < 0) return generic;
  const below = folders.slice(filler + 1);
  const layout = below.filter((folder) => folder.toLowerCase() !== "kids");
  const type = layout.length > 2 ? layout[2].toLowerCase() : null;
  return {
    network: layout.length > 0 ? layout[0] : null,
    decade: layout.length > 1 ? layout[1] : null,
    fillerType: TYPES.includes(type) ? type : null,
    kids: layout.length < below.length,
  };
}

/**
 * The clips a channel's breaks may use: none unless its `filler.on` is true.
 * A clip matches the channel's `network` without case, and its decade is in
 * the channel's `decades`; a clip with no network or decade matches any, and
 * so does a channel without one. The Kids profile keeps only kids-safe clips.
 *
 * @param {Clip[]} clips
 * @param {{ filler?: { on: boolean, network?: string, decades?: string[] } }} channel
 * @param {"grownups" | "kids"} profile
 * @returns {Clip[]} in the order of `clips`
 */
function clipsFor(clips, channel, profile) {
  const filler = channel.filler;
  if (!filler || typeof filler !== "object" || filler.on !== true) return [];
  const network = typeof filler.network === "string" ? filler.network.toLowerCase() : null;
  const decades = Array.isArray(filler.decades) ? filler.decades : null;
  return clips.filter((clip) => {
    if (network !== null && typeof clip.network === "string" && clip.network.toLowerCase() !== network) return false;
    if (decades !== null && typeof clip.decade === "string" && !decades.includes(clip.decade)) return false;
    return profile !== "kids" || clip.kids === true;
  });
}

/**
 * Whether a short can air: it has a length of more than zero seconds.
 *
 * @param {Short} short
 * @returns {boolean}
 */
function shortAirs(short) {
  return typeof short.durationSec === "number" && short.durationSec > 0;
}

/**
 * The shorts a pad takes from a channel's list, in play order. The day has
 * one order for the channel: a copy of `shorts` as given, shuffled with
 * upstream's RNG seeded from the channel and the day. The day's earlier pads
 * take their shorts first, in turn: a pad takes the first unaired short
 * that fits what is left of it, again and again until none does. A short
 * too long for a pad waits for a longer one and is not used up. When every
 * short has aired, the next pad starts the list over from the full order, so
 * a short does not repeat in a day while unaired ones remain. The answer is
 * the last pad's picks. A short of no length is left out, and `shorts` is
 * not changed.
 *
 * @param {{ channelId: number, dayNumber: number, shorts: Short[], earlierPadSecs: number[], padSec: number }} args
 *   `earlierPadSecs` holds the length of each of the day's pads before this one, in order
 * @returns {Short[]} records of `shorts`
 */
function shortsForPad({ channelId, dayNumber, shorts, earlierPadSecs, padSec }) {
  const order = shorts.slice();
  swiftShuffle(order, makeSeededRNG(BigInt(Math.abs(channelId)) * 4294967296n + BigInt(dayNumber)));
  const airing = order.filter(shortAirs);
  const aired = new Set();
  let picks = [];
  for (const length of [...earlierPadSecs, padSec]) {
    let pool = airing.filter((short) => !aired.has(short));
    if (pool.length === 0) {
      aired.clear();
      pool = airing.slice();
    }
    picks = [];
    let rest = length;
    for (;;) {
      const i = pool.findIndex((short) => short.durationSec <= rest);
      if (i < 0) break;
      const [short] = pool.splice(i, 1);
      aired.add(short);
      rest -= short.durationSec;
      picks.push(short);
    }
  }
  return picks;
}

/**
 * The activity a kids channel's break shows: tidy, move, art or book, from
 * the channel and the pad's start alone, so every TV agrees. The half hour
 * the pad starts in counts up by one each half hour, so breaks in a row on
 * a channel take turns through the four, and the channel moves where the
 * turns start.
 *
 * @param {{ channelId: number, padStartSec: number }} args
 * @returns {"tidy" | "move" | "art" | "book"}
 */
function activityFor({ channelId, padStartSec }) {
  return ACTIVITIES[(Math.floor(padStartSec / ACTIVITY_TURN_SEC) + Math.abs(channelId)) % ACTIVITIES.length];
}

/**
 * What plays through a pad of `padSec` seconds starting at `padStartSec` on
 * the channel, from its clips (clipsFor) and the shorts the pad takes
 * (shortsForPad). The station IDs and the other clips are each shuffled
 * with upstream's RNG, seeded from the channel and the pad's start, so the
 * same pad always gets the same plan. The first station ID that fits plays
 * first, then the shorts as given, then the other clips (commercials,
 * bumpers and clips with no type) in turn. The shorts take no part in the
 * shuffles, so the clips keep their order. A clip or short that would run
 * past the pad's end is skipped and the next one tried, so they run dry
 * before the cards start. Each plays once, and a short of no length never
 * plays. A short's entry has `short: true`.
 *
 * Cards fill the rest. On a channel that is not kids they take turns from
 * the station ID card, 15 s each but the last, which runs to the end. On a
 * kids channel a rest of 60 s or more is a station ID card of 10 s, one
 * activity card for the rest less 20 s (its `activity` is activityFor's),
 * and an up-next card of 20 s; a rest under 60 s is one up-next card.
 *
 * @param {{ channelId: number, padStartSec: number, padSec: number, clips: Clip[],
 *   shorts?: Short[], kids?: boolean }} args
 * @returns {Entry[]} back to back from startOffset 0 to padSec
 */
function breakPlan({ channelId, padStartSec, padSec, clips, shorts = [], kids = false }) {
  const rng = makeSeededRNG(BigInt(Math.abs(channelId)) * 4294967296n + BigInt(padStartSec));
  const stationIds = clips.filter((clip) => clip.fillerType === "station-id");
  const others = clips.filter((clip) => clip.fillerType !== "station-id");
  swiftShuffle(stationIds, rng);
  swiftShuffle(others, rng);
  const plan = [];
  let t = 0;
  const addClip = (clip, extra) => {
    plan.push({ kind: "clip", ratingKey: clip.ratingKey, startOffset: t, durationSec: clip.durationSec, ...extra });
    t += clip.durationSec;
  };
  const addCard = (card, durationSec, extra) => {
    plan.push({ kind: "card", card, startOffset: t, durationSec, ...extra });
    t += durationSec;
  };
  const stationId = stationIds.find((clip) => clip.durationSec <= padSec);
  if (stationId !== undefined) addClip(stationId);
  for (const short of shorts) {
    if (shortAirs(short) && t + short.durationSec <= padSec) addClip(short, { short: true });
  }
  for (const clip of others) {
    if (t + clip.durationSec <= padSec) addClip(clip);
  }
  if (kids) {
    const rest = padSec - t;
    if (rest >= ACTIVITY_MIN_SEC) {
      addCard("station-id", ACTIVITY_ID_SEC);
      addCard("activity", rest - ACTIVITY_ID_SEC - ACTIVITY_NEXT_SEC, { activity: activityFor({ channelId, padStartSec }) });
      addCard("up-next", ACTIVITY_NEXT_SEC);
    } else if (rest > 0) {
      addCard("up-next", rest);
    }
    return plan;
  }
  for (let k = 0; t < padSec; k++) {
    const rest = padSec - t;
    addCard(CARDS[k % CARDS.length], rest < 2 * CARD_SEC ? rest : CARD_SEC);
  }
  return plan;
}

/**
 * Where a viewer joins a plan `offsetSec` seconds into its pad: the entry
 * that covers that second and the seconds into it. An offset before the pad
 * joins at its start; at or past its end, index is the plan's length.
 *
 * @param {Entry[]} plan
 * @param {number} offsetSec
 * @returns {{ index: number, seekSec: number }}
 */
function breakAt(plan, offsetSec) {
  const t = Math.max(offsetSec, 0);
  for (let i = 0; i < plan.length; i++) {
    const entry = plan[i];
    if (t < entry.startOffset + entry.durationSec) return { index: i, seekSec: t - entry.startOffset };
  }
  return { index: plan.length, seekSec: 0 };
}

module.exports = { parseFillerPath, clipsFor, shortsForPad, activityFor, breakPlan, breakAt };

})(module, module.exports, (spec) => deps[spec]);
export default module.exports;
