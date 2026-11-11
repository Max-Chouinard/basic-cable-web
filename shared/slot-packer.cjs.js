// slot-packer.cjs, wrapped for the page by tools/build-web.mjs. Edit the file in shared/, then build again.
import * as dep0 from "./lineup.js";
import dep1 from "./nostalgex-channel-filter.cjs.js";
import dep2 from "./nostalgex-daily-manifest.cjs.js";
const deps = { "./lineup.js": dep0, "./nostalgex-channel-filter.cjs": dep1, "./nostalgex-daily-manifest.cjs": dep2 };
const module = { exports: {} };
(function (module, exports, require) {
// The slot packer: a channel's local day as program blocks and the pads
// between them, for a channel that keeps a station's rhythm. usesSlottedPacker
// (shared/lineup.js) sends a channel here when it aligns to the half hour,
// plays in an order other than shuffle, has dayparts or keeps ratings out of
// some hours. Every other channel keeps upstream's packDay
// (nostalgex-daily-manifest.cjs). docs/lineup-format.md describes the channel
// fields this reads.
//
// Both profiles pack by the same rules, over the pools they are given: the Kids
// profile gets Kids-approved items only, since the Kids rating limit cuts the
// pool before the packer sees it.
//
// This file is the source of truth: the BrightScript port's test vectors are
// made from it.
const { usesSlottedPacker } = require("./lineup.js");
const { usContentRating } = require("./nostalgex-channel-filter.cjs");
const { interleaveByShow, makeSeededRNG, swiftShuffle } = require("./nostalgex-daily-manifest.cjs");

// Slots start on epoch multiples of the guide's half hour.
const SLOT_SEC = 1800;
const DAY_SEC = 86400;
const DEFAULT_BLOCK_SIZE = 2;
// A mid-show break: two minutes, in a program of 20 minutes or more.
const MID_PAD_SEC = 120;
const MID_MIN_SEC = 1200;
// What the Roku plays as stored, by NxPlexDirectFormat's lists
// (roku/source/plex/PlexApi.brs).
const DIRECT_CONTAINERS = ["mp4", "mov", "m4v", "mkv"];
const DIRECT_VIDEO = ["h264", "hevc"];
const DIRECT_AUDIO = ["aac", "ac3", "eac3", "mp3"];

/**
 * @typedef {{ ratingKey: string, title: string, type: string, durationSec: number, contentRating?: string,
 *   seasonNumber?: number, episodeNumber?: number, year?: number, container?: string, videoCodec?: string,
 *   audioCodec?: string }} Item
 * @typedef {{ kind: "program" | "pad", ratingKey: string, startSec: number, endSec: number,
 *   slotEndSec: number, seekBaseSec: number }} Block
 */

/**
 * The channel's day from dayStartSec to dayEndSec, as blocks back to back. A
 * pad's ratingKey is "pad:<channel id>:<startSec>". A program's slotEndSec is
 * where its guide cell ends: the next program's start, or the first half hour
 * at or after its end when a pad follows, or its end under `align: "none"`.
 *
 * With `filler.midShow` true under half-hour, a program that may break
 * (hasMidBreak) airs in two parts with a two-minute pad between them, when
 * its slot ends with that much pad to spare: the first part from its start
 * to half its length, the second from there (seekBaseSec) to its end, with
 * the same ratingKey. Both parts have the second's slotEndSec, so the guide
 * shows one cell for the program.
 *
 * @param {object} args
 * @param {{ id: number, playOrder?: string, blockSize?: number, align?: string, dayparts?: object[],
 *   timeRestrictions?: object, filler?: { midShow?: boolean } }} args.channel
 * @param {Record<string, Item[]>} args.pools the untagged members under "", each daypart tag's under the tag
 * @param {number} args.dayStartSec local midnight
 * @param {number} args.dayEndSec the next local midnight
 * @param {number} args.dayNumber the local day number (localDayNumber)
 * @param {(sec: number) => { weekday: number, hour: number, minute: number }} args.localClockAt the local clock at an epoch second
 * @param {Set<string>} args.yesterdayAired the program ratingKeys the channel aired the local day before
 * @param {"grownups" | "kids"} args.profile no rule reads it: the pools differ by profile, the rules do not
 * @returns {Block[]}
 */
function packDaySlotted({ channel, pools, dayStartSec, dayEndSec, dayNumber, localClockAt, yesterdayAired }) {
  const dayparts = (channel.dayparts || []).map(parseDaypart);
  const day = {
    channel,
    pools,
    dayNumber,
    yesterdayAired,
    localClockAt,
    endSec: dayEndSec,
    halfHour: channel.align === "half-hour",
    midShow: channel.align === "half-hour" && channel.filler?.midShow === true,
    minBreakSec: minBreakSec(channel),
    dayparts,
    mature: matureWindow(channel.timeRestrictions),
    stops: stopTimes(dayparts, dayStartSec, dayEndSec, localClockAt),
    orders: new Map(),
    allMembers: null,
    blocks: [],
  };
  let t = dayStartSec;
  while (t < dayEndSec) t = packFrom(day, t);
  setSlotEnds(day.blocks, day.halfHour);
  return day.blocks;
}

/**
 * Places what starts at `t`, a slot start under half-hour or a program start
 * under none, and returns the time the next one starts.
 */
function packFrom(day, t) {
  const nextHalfHour = Math.min(nextBoundary(t), day.endSec);
  // A half-hour slot starts on a boundary. Only a day that starts between two,
  // in a zone 15 or 45 minutes off the half hour, pads to the first.
  const pick = day.halfHour && t % SLOT_SEC !== 0 ? null : pickAt(day, t);
  if (pick === null) return addPad(day, t, nextHalfHour);

  const limit = firstStopAfter(day, t);
  const first = nextEligible(day, pick);
  // A program that would run past a daypart start or the day's end waits; the cursor stays on it.
  if (t + first.durationSec > limit) return addPad(day, t, limit);
  const firstAt = day.blocks.length;
  const slotItems = [first];
  let end = addProgram(day, pick.order, t);
  if (!day.halfHour) return end;

  // A program longer than a slot takes its slots whole. A shorter one shares
  // its slot with the programs after it that fit before the slot ends.
  const slotEnd = t + Math.ceil(first.durationSec / SLOT_SEC) * SLOT_SEC;
  if (first.durationSec <= SLOT_SEC) {
    const shareUntil = Math.min(slotEnd - day.minBreakSec, limit);
    for (let item = nextEligible(day, pick); end + item.durationSec <= shareUntil; item = nextEligible(day, pick)) {
      slotItems.push(item);
      end = addProgram(day, pick.order, end);
    }
  }
  const padEnd = Math.min(slotEnd, day.endSec);
  // A slot holds at most one program of 20 minutes or more: two would run
  // past a shared half hour. Its break comes out of the pad at the slot's end.
  const breaking = slotItems.findIndex(hasMidBreak);
  if (day.midShow && padEnd - end >= MID_PAD_SEC && breaking >= 0) end = splitProgram(day, firstAt + breaking);
  return addPad(day, end, padEnd);
}

/**
 * The break a half-hour slot keeps when short programs share it: `filler.minBreak` minutes, a
 * whole number from 0 to 20 (validateLineup), and 0 for anything else. The slot's first program
 * airs whatever its length; the ones after it share only while this much is left.
 */
function minBreakSec(channel) {
  if (channel.align !== "half-hour") return 0;
  const minutes = channel.filler?.minBreak;
  return Number.isInteger(minutes) && minutes >= 0 && minutes <= 20 ? minutes * 60 : 0;
}

/**
 * Whether a program may break in the middle: 20 minutes or more, in a file
 * the Roku plays as stored by NxPlexDirectFormat's lists, compared without
 * case. An approximation: MKV plays as stored only over the home network,
 * and the TV may still send a file through Plex, where the second part
 * starts at its offset as any join does.
 */
function hasMidBreak(item) {
  const lower = (text) => (typeof text === "string" ? text.toLowerCase() : "");
  return item.durationSec >= MID_MIN_SEC
    && DIRECT_CONTAINERS.includes(lower(item.container))
    && DIRECT_VIDEO.includes(lower(item.videoCodec))
    && DIRECT_AUDIO.includes(lower(item.audioCodec));
}

/**
 * Splits the program at blocks[at] at half its length, in whole seconds
 * down, with a mid-show pad between its parts, and moves the programs after
 * it in its slot on by the pad. Returns where the slot's programs now end.
 */
function splitProgram(day, at) {
  const one = day.blocks[at];
  const half = Math.floor((one.endSec - one.startSec) / 2);
  const padStart = one.startSec + half;
  const twoStart = padStart + MID_PAD_SEC;
  const two = { kind: "program", ratingKey: one.ratingKey, startSec: twoStart, endSec: one.endSec + MID_PAD_SEC,
    slotEndSec: one.endSec + MID_PAD_SEC, seekBaseSec: half };
  const pad = { kind: "pad", ratingKey: `pad:${day.channel.id}:${padStart}`, startSec: padStart, endSec: twoStart,
    slotEndSec: twoStart, seekBaseSec: 0 };
  one.endSec = padStart;
  one.slotEndSec = padStart;
  const after = day.blocks.splice(at + 1);
  for (const b of after) {
    b.startSec += MID_PAD_SEC;
    b.endSec += MID_PAD_SEC;
    b.slotEndSec += MID_PAD_SEC;
  }
  day.blocks.push(pad, two, ...after);
  return day.blocks[day.blocks.length - 1].endSec;
}

/**
 * The play order the program starting at `t` comes from, with whether the
 * mature window is shut then, or null when the mature window keeps every
 * member out, so nothing may start.
 */
function pickAt(day, t) {
  const clock = day.localClockAt(t);
  const part = daypartAt(day.dayparts, clock);
  const blocked = isBlockedHour(day.mature, clock.hour);
  if (part !== null) {
    const tagged = taggedOrder(day, part.tag);
    if (canStart(tagged, blocked)) return { order: tagged, blocked };
  }
  const all = allMembersOrder(day);
  return canStart(all, blocked) ? { order: all, blocked } : null;
}

/** The next item of the pick's order the mature window lets start. The cursor moves past every item it skips. */
function nextEligible(day, pick) {
  while (pick.blocked && isMature(day.mature, pick.order.peek())) pick.order.advance();
  return pick.order.peek();
}

/** Whether the order holds an item that may start, with the mature window shut when `blocked`. */
function canStart(order, blocked) {
  return order.items.length > 0 && (!blocked || order.hasClean);
}

/** Adds the order's next item as a program starting at `t` and returns its end. */
function addProgram(day, order, t) {
  const item = order.peek();
  order.advance();
  const endSec = t + item.durationSec;
  day.blocks.push({ kind: "program", ratingKey: item.ratingKey, startSec: t, endSec, slotEndSec: endSec, seekBaseSec: 0 });
  return endSec;
}

/** Adds pad time from `from` to `to`, joined to a pad that ends at `from`, and returns `to`. */
function addPad(day, from, to) {
  if (from < to) {
    const last = day.blocks[day.blocks.length - 1];
    if (last !== undefined && last.kind === "pad" && last.endSec === from) {
      last.endSec = to;
      last.slotEndSec = to;
    } else {
      day.blocks.push({ kind: "pad", ratingKey: `pad:${day.channel.id}:${from}`, startSec: from, endSec: to, slotEndSec: to, seekBaseSec: 0 });
    }
  }
  return to;
}

/**
 * A program's slotEndSec under half-hour: the next block's start when that is
 * a program, otherwise the earlier of the following pad's end and the first
 * half hour at or after the program's end. Pad time past that half hour
 * belongs to no program. The first part of a split program takes its second
 * part's, so the day is read from its end. Pads and programs under none keep
 * their endSec.
 */
function setSlotEnds(blocks, halfHour) {
  if (!halfHour) return;
  for (let i = blocks.length - 2; i >= 0; i--) {
    const b = blocks[i];
    const next = blocks[i + 1];
    const two = blocks[i + 2];
    if (b.kind === "pad") continue;
    if (next.kind === "pad" && two !== undefined && two.ratingKey === b.ratingKey && two.seekBaseSec > 0) b.slotEndSec = two.slotEndSec;
    else b.slotEndSec = next.kind === "pad" ? Math.min(next.endSec, Math.ceil(b.endSec / SLOT_SEC) * SLOT_SEC) : next.startSec;
  }
}

// ── Time ──────────────────────────────────────────────────────────────────

/** The first half-hour boundary after `t`. */
function nextBoundary(t) {
  return Math.floor(t / SLOT_SEC) * SLOT_SEC + SLOT_SEC;
}

/** A daypart with its times as minutes past local midnight ("24:00" is 1440). */
function parseDaypart(part) {
  const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  return { days: part.days, from: minutes(part.from), to: minutes(part.to), tag: part.tag };
}

/** The daypart whose days and [from, to) cover the local clock, or null. */
function daypartAt(dayparts, clock) {
  const minute = clock.hour * 60 + clock.minute;
  for (const part of dayparts) {
    if (part.days.includes(clock.weekday) && part.from <= minute && minute < part.to) return part;
  }
  return null;
}

/**
 * The half-hour boundaries inside the day that no program may run past: each
 * where a daypart starts. The clock is read at each boundary, so a daypart
 * keeps its local time on the days the clocks change.
 */
function stopTimes(dayparts, dayStartSec, dayEndSec, localClockAt) {
  const stops = [];
  if (dayparts.length === 0) return stops;
  let before = daypartAt(dayparts, localClockAt(dayStartSec));
  for (let b = nextBoundary(dayStartSec); b < dayEndSec; b += SLOT_SEC) {
    const part = daypartAt(dayparts, localClockAt(b));
    if (part !== null && part !== before) stops.push(b);
    before = part;
  }
  return stops;
}

/** The first stop after `t`, or the day's end. */
function firstStopAfter(day, t) {
  for (const stop of day.stops) {
    if (stop > t) return stop;
  }
  return day.endSec;
}

// ── The mature window ─────────────────────────────────────────────────────

/** The channel's `timeRestrictions.blockRatings`, or a window that never shuts. */
function matureWindow(timeRestrictions) {
  const br = timeRestrictions && timeRestrictions.blockRatings;
  if (!br) return { ratings: [], blockBefore: null, blockAfter: null };
  return { ratings: br.ratings, blockBefore: br.blockBefore ?? null, blockAfter: br.blockAfter ?? null };
}

/** Whether the window keeps its ratings out at this local hour: the test getTimeFilteredPool makes (time-filter.cjs). */
function isBlockedHour(mature, hour) {
  return (mature.blockBefore !== null && hour < mature.blockBefore) || (mature.blockAfter !== null && hour >= mature.blockAfter);
}

/** Whether the window keeps the item out: its rating read as a US label, as time-filter.cjs reads it. */
function isMature(mature, item) {
  return mature.ratings.includes(usContentRating(item.contentRating, item.type));
}

// ── Play orders ───────────────────────────────────────────────────────────
// Each pool has its own order and cursor for the whole day. An order has
// `items` (every item it plays), `hasClean` (whether one of them is outside
// the mature window), `peek()` (the item at the cursor) and `advance()`.

/** The order of a daypart tag's pool, made on first use. */
function taggedOrder(day, tag) {
  if (!day.orders.has(tag)) day.orders.set(tag, makeOrder(day, playable(day.pools[tag] || [])));
  return day.orders.get(tag);
}

/** The order of all members: the untagged pool, then each tag's pool in tag order. */
function allMembersOrder(day) {
  if (day.allMembers === null) {
    const tags = Object.keys(day.pools).filter((key) => key !== "").sort();
    const members = [""].concat(tags).flatMap((key) => day.pools[key] || []);
    day.allMembers = makeOrder(day, playable(members));
  }
  return day.allMembers;
}

/** The items with a length to schedule. */
function playable(items) {
  return items.filter((item) => item.durationSec > 0);
}

/** The pool's play order for the day, by the channel's playOrder (shuffle when it has none). */
function makeOrder(day, pool) {
  const { channel, dayNumber } = day;
  let order;
  if (pool.length === 0) order = listOrder([], 0, []);
  else if (channel.playOrder === "inOrder") order = inOrder(pool, dayNumber);
  else if (channel.playOrder === "blocks") order = blocksOrder(pool, channel, dayNumber);
  else if (channel.playOrder === "marathon") order = marathonOrder(pool, dayNumber);
  else order = shuffleOrder(pool, channel.id, dayNumber, day.yesterdayAired);
  order.hasClean = order.items.some((item) => !isMature(day.mature, item));
  return order;
}

/** Plays `list` through, then from `loopFrom` to its end over and over. */
function listOrder(list, loopFrom, items) {
  let at = 0;
  return {
    items,
    peek: () => list[at],
    advance() {
      at += 1;
      if (at >= list.length) at = loopFrom;
    },
  };
}

/**
 * Shuffle: what packDay plays, without its premieres, sequel grouping or
 * golden-ratio start. The pool less yesterday's airings, interleaved by show,
 * then the whole pool interleaved with the next day's seed, over and over.
 */
function shuffleOrder(pool, channelId, dayNumber, yesterdayAired) {
  const unplayed = interleaveByShow(pool.filter((item) => !yesterdayAired.has(item.ratingKey)), channelId, dayNumber);
  const repeat = interleaveByShow(pool, channelId, dayNumber + 1);
  return listOrder(unplayed.concat(repeat), unplayed.length, pool);
}

/**
 * In order: compareForOrder's order, from the item (dayNumber * 86400) mod
 * the pool's length in seconds into it, round and round. The day picks the
 * start, so no state carries over; an item may be skipped where two days meet.
 */
function inOrder(pool, dayNumber) {
  const sorted = pool.slice().sort(compareForOrder);
  return listOrder(fromDayOffset(sorted, dayNumber), 0, pool);
}

/**
 * Blocks: the shows take turns in the order swiftShuffle gives them, seeded
 * as interleaveByShow seeds it, each airing blockSize episodes a turn (fewer
 * when it has fewer). Each show starts at its episode for the day, found the
 * way inOrder finds its first item, and carries on from there all day.
 */
function blocksOrder(pool, channel, dayNumber) {
  const shows = showsOf(pool).map((episodes) => fromDayOffset(episodes, dayNumber));
  swiftShuffle(shows, makeSeededRNG(BigInt(Math.abs(channel.id) + 1) + BigInt(dayNumber)));
  const blockSize = channel.blockSize ?? DEFAULT_BLOCK_SIZE;
  const next = shows.map(() => 0);
  let show = 0;
  let aired = 0;
  return {
    items: pool,
    peek: () => shows[show][next[show]],
    advance() {
      const episodes = shows[show];
      next[show] = (next[show] + 1) % episodes.length;
      aired += 1;
      if (aired >= Math.min(blockSize, episodes.length)) {
        aired = 0;
        show = (show + 1) % shows.length;
      }
    },
  };
}

/** Marathon: show dayNumber mod the show count, from its episode for the day, round and round. */
function marathonOrder(pool, dayNumber) {
  const shows = showsOf(pool);
  const episodes = shows[dayNumber % shows.length];
  return listOrder(fromDayOffset(episodes, dayNumber), 0, episodes);
}

/**
 * The pool's shows in compareForOrder's order, each a list of its episodes
 * in season and episode order. Each movie is a show of its own, as
 * interleaveByShow counts it.
 */
function showsOf(pool) {
  const shows = new Map();
  for (const item of pool.slice().sort(compareForOrder)) {
    const key = item.type === "episode" ? item.title : `movie_${item.ratingKey}`;
    if (!shows.has(key)) shows.set(key, []);
    shows.get(key).push(item);
  }
  return [...shows.values()];
}

/**
 * `items` turned to start at the one (dayNumber * 86400) mod their total
 * length in seconds into them, so each day starts where a channel playing
 * them nonstop would be.
 */
function fromDayOffset(items, dayNumber) {
  const total = items.reduce((sum, item) => sum + item.durationSec, 0);
  const offset = (dayNumber * DAY_SEC) % total;
  let elapsed = 0;
  let start = 0;
  while (elapsed + items[start].durationSec <= offset) {
    elapsed += items[start].durationSec;
    start += 1;
  }
  return items.slice(start).concat(items.slice(0, start));
}

/**
 * Episodes by show title, season and episode, then movies by year and title.
 * Text compares by character code, a missing number reads as 0, and the
 * ratingKey settles a tie.
 */
function compareForOrder(a, b) {
  const aMovie = a.type !== "episode";
  const bMovie = b.type !== "episode";
  if (aMovie !== bMovie) return aMovie ? 1 : -1;
  if (aMovie) return compareNumber(a.year, b.year) || compareText(a.title, b.title) || compareText(a.ratingKey, b.ratingKey);
  return compareText(a.title, b.title)
    || compareNumber(a.seasonNumber, b.seasonNumber)
    || compareNumber(a.episodeNumber, b.episodeNumber)
    || compareText(a.ratingKey, b.ratingKey);
}

function compareNumber(a, b) {
  return (Number(a) || 0) - (Number(b) || 0);
}

function compareText(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  return x < y ? -1 : x > y ? 1 : 0;
}

module.exports = { packDaySlotted, usesSlottedPacker };

})(module, module.exports, (spec) => deps[spec]);
export default module.exports;
