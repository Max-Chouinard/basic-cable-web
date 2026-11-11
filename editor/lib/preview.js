// What each channel matches and what it airs now, for the editor's Channels screen. The counts
// and schedules come from the shared engines the Roku's code is checked against: the channel
// filter, the channel's seasons, the Kids rating limit, the time filter, the daily manifest and the slot packer. They
// read the lineup the TVs get (packagedLineup), so a hidden channel's shows count where the TVs
// air them.
import { createRequire } from "node:module";

import { kidsAllowedShows, kidsPool } from "../../shared/kids.js";
import { membershipEntry, membershipIndex, packagedLineup, withoutBadFiles, withoutBlockedShows } from "../../shared/lineup.js";
import { createMemoryStorage } from "../../shared/memory-storage.js";

const require = createRequire(import.meta.url);
const { filterPool } = require("../../shared/nostalgex-channel-filter.cjs");
const { getTimeFilteredPool } = require("../../shared/time-filter.cjs");
const { getManifestBlocks, localDayNumber, startOfLocalDayMs, startOfNextLocalDayMs } = require("../../shared/nostalgex-daily-manifest.cjs");
const { packDaySlotted, usesSlottedPacker } = require("../../shared/slot-packer.cjs");
const { activeSeasons, localMonthDay, seasonalPool } = require("../../shared/seasons.cjs");

/**
 * @typedef {{ title: string, episodeTitle: string, startMs: number, endMs: number, break: boolean,
 *   slotEndMs: number }} Airing `break` is true once the program has ended and its slot's break
 *   plays; `slotEndMs` is where its slot ends, `endMs` on a channel off the slot packer
 * @typedef {{ id: number, number: number, name: string, hidden: boolean, count: number,
 *   kidsCount: number, shown: boolean, offSeason?: true, now: Airing | null, next: Airing | null }} ChannelPreview
 */

/**
 * The lineup's channels in guide order (number, then id), each with its match counts, whether
 * the profile's guide shows it and what it airs at `nowMs` and next.
 * - `count` is what the channel filter matches less the shows the lineup's blockShows keeps off the
 *   channel (withoutBlockedShows), cut to the items of the seasons active on `nowMs`
 *   when the channel has seasons (none at all when no season is active), and `kidsCount` what the
 *   Kids rating limit leaves of that, so the Kids limit applies after the season. Both are taken
 *   before the time filter, so a channel off the air keeps its counts.
 * - Grown-ups lists every channel; Kids lists only the `kids: true` channels. `shown` is true
 *   when the channel is not hidden and the profile's count reaches minItems, as on the Roku. A
 *   channel with seasons also needs at least one item, so it is not shown on a day inside none of
 *   its seasons. That row carries `offSeason: true`, which the Channels screen reads.
 * - A hidden channel stays listed with `shown: false`. The TVs never get it, so its counts and
 *   schedule come from the full lineup.
 * - A weather channel (`kind: "weather"`) airs no library item, so no filter runs for it and the
 *   library is not read for it: its counts are 0, it is shown unless hidden, and `now` and `next`
 *   are the half-hour "Local Forecast" blocks of the TV's own schedule, counted from midnight in
 *   the PC's local time zone. The day's last block is followed by the next day's first.
 * - `now` and `next` come from the day's schedule of the profile's pool, and are null when
 *   nothing airs. The day is scheduled with no day before it, as on a TV that opened the app
 *   today: the Roku keeps its day schedules in memory only and clears them when it loads the
 *   library. Times are in the PC's local time zone.
 * - A channel off the slot packer (usesSlottedPacker) is scheduled after the time filter for
 *   the hour. `now` is the block on air, and `next` the block after it, so the day's last block
 *   has none.
 * - A channel on the slot packer is scheduled from its whole pool, split by its shows' daypart
 *   tags, as NxScheduleGuide does. `now` is the program whose slot covers `nowMs`, a break
 *   included, and `next` the first program that starts once it ends, null when none starts
 *   today. A pad is never either. Editor items carry no codecs, so no program splits for a
 *   mid-show break.
 *
 * Installs a fresh in-memory localStorage for the schedules while it runs and puts the old one
 * back before it returns.
 * @param {object} lineup a lineup that passed validateLineup
 * @param {object[]} items the library's items, as fetchLibrary reads them
 * @param {{ nowMs: number, profile?: "grownups" | "kids" }} options
 * @returns {ChannelPreview[]}
 */
export function previewLineup(lineup, items, { nowMs, profile = "grownups" }) {
  const tv = packagedLineup(lineup);
  const kidsProfile = profile === "kids";
  const shipped = { manifest: { items: membershipIndex(tv) }, exclusiveRules: tv.exclusiveRules };
  const onChannels = withoutBadFiles(items, lineup);
  const full = { manifest: { items: membershipIndex(lineup) }, exclusiveRules: lineup.exclusiveRules };
  const nowSec = Math.floor(nowMs / 1000);
  const serverKey = lineup.server.machineIdentifier;
  const hour = new Date(nowMs).getHours();
  const monthDay = localMonthDay(nowMs);
  const day = {
    dayStartSec: startOfLocalDayMs(nowMs) / 1000,
    dayEndSec: startOfNextLocalDayMs(nowMs) / 1000,
    dayNumber: localDayNumber(nowMs),
  };

  const listed = lineup.channels
    .filter((def) => !kidsProfile || def.kids === true)
    .sort((a, b) => a.number - b.number || a.id - b.id);

  return withScheduleStorage(() =>
    listed.map((def) => {
      const hidden = def.hidden === true;
      if (def.kind === "weather") return weatherRow(def, hidden, nowMs);
      const channel = engineChannel(def);
      const { manifest, exclusiveRules } = hidden ? full : shipped;
      // The lineup's blocklist takes its shows off the channel, as the Roku's day pools do.
      const matched = withoutBlockedShows(filterPool(onChannels, channel, { manifest, exclusiveRules, nowSec, backend: "plex" }).items, lineup, def);
      // The season comes after the filter and before the Kids limit, as the Roku's day pools do.
      const rows = seasonalPool(matched, def, monthDay);
      const kidsRows = kidsPool(rows, lineup.kids, channel);
      const pool = kidsProfile ? kidsRows : rows;
      const seasonal = Array.isArray(def.seasons) && def.seasons.length > 0;
      const offSeason = seasonal && activeSeasons(def, monthDay).length === 0;
      const { now, next } = usesSlottedPacker(channel)
        ? slottedAiring(channel, pool, manifest.items, { ...day, nowSec, profile })
        : packedAiring(getManifestBlocks(channel, getTimeFilteredPool(channel, pool, hour), nowMs, serverKey), nowSec);
      return {
        id: def.id,
        number: def.number,
        name: def.name,
        hidden,
        count: rows.length,
        kidsCount: kidsRows.length,
        shown: !hidden && pool.length >= def.minItems && !(seasonal && pool.length === 0),
        ...(offSeason ? { offSeason: true } : {}),
        now,
        next,
      };
    }),
  );
}

/**
 * Runs `work` with a fresh in-memory localStorage, where upstream's engine keeps its day
 * schedules, and puts the old one back before it returns.
 */
function withScheduleStorage(work) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    value: createMemoryStorage(),
    configurable: true,
    enumerable: true,
    writable: true,
  });
  try {
    return work();
  } finally {
    if (saved) Object.defineProperty(globalThis, "localStorage", saved);
    else delete globalThis.localStorage;
  }
}

/**
 * @typedef {{ kind: "program" | "pad", ratingKey: string, startSec: number, endSec: number,
 *   slotEndSec: number, seekBaseSec: number, item: object | null }} GuideBlock a pad has no item
 * @typedef {{ id: number, number: number, name: string, colorHex: string, blocks: GuideBlock[] }} GuideChannel
 */

/**
 * The day's schedule of each channel the profile's guide shows, for the browser page. It takes
 * previewLineup's steps (the filter, the season, the Kids limit, then the day's schedule with no
 * day before it) and keeps every block of the day, each program with its library item.
 * - It lists the channels previewLineup marks `shown`, in guide order. A hidden channel and a
 *   weather channel are left out: the page has no forecast to draw.
 * - A channel on the slot packer gives the packer's blocks, pads included. A channel off it gives
 *   upstream's blocks for the pool the time filter leaves at the hour of `nowMs`, so the page asks
 *   again when the hour changes.
 * - Times are epoch seconds, read in the local time zone of the machine it runs on.
 * @param {object} lineup a lineup that passed validateLineup, packaged or not
 * @param {object[]} items the library's items, as fetchLibrary reads them
 * @param {{ nowMs: number, profile?: "grownups" | "kids" }} options
 * @returns {GuideChannel[]}
 */
export function guideDay(lineup, items, { nowMs, profile = "grownups" }) {
  const tv = packagedLineup(lineup);
  const kidsProfile = profile === "kids";
  const index = membershipIndex(tv);
  const onChannels = withoutBadFiles(items, tv);
  const nowSec = Math.floor(nowMs / 1000);
  const hour = new Date(nowMs).getHours();
  const monthDay = localMonthDay(nowMs);
  const day = {
    dayStartSec: startOfLocalDayMs(nowMs) / 1000,
    dayEndSec: startOfNextLocalDayMs(nowMs) / 1000,
    dayNumber: localDayNumber(nowMs),
  };
  const listed = tv.channels
    .filter((def) => def.kind !== "weather" && (!kidsProfile || def.kids === true))
    .sort((a, b) => a.number - b.number || a.id - b.id);
  return withScheduleStorage(() =>
    listed.flatMap((def) => {
      const channel = engineChannel(def);
      const matched = withoutBlockedShows(filterPool(onChannels, channel, { manifest: { items: index }, exclusiveRules: tv.exclusiveRules, nowSec, backend: "plex" }).items, tv, def);
      const rows = seasonalPool(matched, def, monthDay);
      const pool = kidsProfile ? kidsPool(rows, tv.kids, channel) : rows;
      const seasonal = Array.isArray(def.seasons) && def.seasons.length > 0;
      if (pool.length < def.minItems || (seasonal && pool.length === 0)) return [];
      let blocks;
      if (usesSlottedPacker(channel)) {
        const byKey = new Map(pool.map((item) => [item.ratingKey, item]));
        blocks = slottedBlocks(channel, pool, index, { ...day, profile }).map((b) => ({
          kind: b.kind,
          ratingKey: b.ratingKey,
          startSec: b.startSec,
          endSec: b.endSec,
          slotEndSec: b.slotEndSec ?? b.endSec,
          seekBaseSec: b.seekBaseSec ?? 0,
          item: b.kind === "pad" ? null : (byKey.get(b.ratingKey) ?? null),
        }));
      } else {
        blocks = getManifestBlocks(channel, getTimeFilteredPool(channel, pool, hour), nowMs, tv.server.machineIdentifier).map((b) => ({
          kind: "program",
          ratingKey: b.item.ratingKey,
          startSec: b.startSec,
          endSec: b.endSec,
          slotEndSec: b.endSec,
          seekBaseSec: 0,
          item: b.item,
        }));
      }
      return [{ id: def.id, number: def.number, name: def.name, colorHex: def.colorHex, blocks }];
    }),
  );
}

const HALF_HOUR_MS = 30 * 60_000;

/**
 * A weather channel's row. Its blocks are NxSyntheticBlocks': half an hour each, from the start
 * of the local day, the last one ending where the day does.
 */
function weatherRow(def, hidden, nowMs) {
  const dayStartMs = startOfLocalDayMs(nowMs);
  const startMs = dayStartMs + Math.floor((nowMs - dayStartMs) / HALF_HOUR_MS) * HALF_HOUR_MS;
  const now = forecastBlock(startMs);
  return { id: def.id, number: def.number, name: def.name, hidden, count: 0, kidsCount: 0, shown: !hidden, now, next: forecastBlock(now.endMs) };
}

/** One "Local Forecast" block, as the Channels screen shows an airing: no episode and no break. */
function forecastBlock(startMs) {
  const endMs = Math.min(startMs + HALF_HOUR_MS, startOfNextLocalDayMs(startMs));
  return { title: "Local Forecast", episodeTitle: "", startMs, endMs, break: false, slotEndMs: endMs };
}

/**
 * The channel as NxParseLineup hands it to the Roku's engines: the fields it keeps, the
 * scheduling fields among them, the Kids flags true only for the boolean true, kidsAllowShows
 * as a list of show titles (empty when the file has none or a malformed one), and no category or
 * premiere promotion.
 */
function engineChannel(def) {
  return {
    id: def.id,
    number: def.number,
    name: def.name,
    colorHex: def.colorHex,
    minItems: def.minItems,
    rules: def.rules,
    timeRestrictions: def.timeRestrictions,
    kids: def.kids === true,
    kidsAllowUnrated: def.kidsAllowUnrated === true,
    kidsAllowShows: kidsAllowedShows(def),
    playOrder: def.playOrder,
    blockSize: def.blockSize,
    align: def.align,
    dayparts: def.dayparts,
    filler: def.filler,
    category: "",
    isPremiereChannel: false,
  };
}

/** Now and next from upstream's packDay blocks, which each carry their item. */
function packedAiring(blocks, nowSec) {
  const at = blocks.findIndex((b) => b.startSec <= nowSec && nowSec < b.endSec);
  const shown = (block) => (block ? airing(block, block.item, nowSec) : null);
  return { now: shown(blocks[at]), next: at < 0 ? null : shown(blocks[at + 1]) };
}

/**
 * Now and next from the slot packer's day. Its blocks carry a ratingKey and no item, so each
 * program's item is looked up in the pool. The pool goes to the packer split by each item's
 * daypart tag on the channel, "" for none.
 */
function slottedAiring(channel, pool, index, { dayStartSec, dayEndSec, dayNumber, nowSec, profile }) {
  const blocks = slottedBlocks(channel, pool, index, { dayStartSec, dayEndSec, dayNumber, profile });
  const programs = blocks.filter((b) => b.kind !== "pad");
  const now = programs.find((b) => b.startSec <= nowSec && nowSec < b.slotEndSec);
  // A split program's second part (seekBaseSec above 0) is the same airing, as NxNextProgram skips it.
  const next = now && programs.find((b) => b.startSec >= now.endSec && !(b.seekBaseSec > 0));
  const byKey = new Map(pool.map((item) => [item.ratingKey, item]));
  const shown = (block) => (block ? airing(block, byKey.get(block.ratingKey), nowSec) : null);
  return { now: shown(now), next: shown(next) };
}

/** The slot packer's blocks for the day, from the pool split by each item's daypart tag on the channel. */
function slottedBlocks(channel, pool, index, { dayStartSec, dayEndSec, dayNumber, profile }) {
  const pools = {};
  for (const item of pool) {
    const tag = membershipEntry(index, item)?.tag?.[String(channel.id)] ?? "";
    (pools[tag] ??= []).push(item);
  }
  return packDaySlotted({
    channel,
    pools,
    dayStartSec,
    dayEndSec,
    dayNumber,
    localClockAt,
    // The preview schedules today alone, so nothing aired the day before.
    yesterdayAired: new Set(),
    profile,
  });
}

/** The local clock at an epoch second, in the PC's time zone, as the slot packer reads it. */
function localClockAt(sec) {
  const date = new Date(sec * 1000);
  return { weekday: date.getDay(), hour: date.getHours(), minute: date.getMinutes() };
}

/**
 * A program as the preview shows it. Its break is on once it has ended, which only a slot
 * packer program does while it is now. A block from packDay has no slotEndSec: its slot ends
 * with it.
 */
function airing(block, item, nowSec) {
  return {
    title: item.title,
    episodeTitle: item.episodeTitle ?? "",
    startMs: block.startSec * 1000,
    endMs: block.endSec * 1000,
    break: nowSec >= block.endSec,
    slotEndMs: (block.slotEndSec ?? block.endSec) * 1000,
  };
}
