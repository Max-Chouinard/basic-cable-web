// What a channel airs at a moment, from the day's blocks guideDay makes. No DOM and no network,
// so Node tests it.

/** The block on air at `nowSec`, or null in a gap or outside the day. */
export function blockAt(blocks, nowSec) {
  return blocks.find((b) => b.startSec <= nowSec && nowSec < b.endSec) ?? null;
}

/** The first program that starts at `fromSec` or later, or null when the day has none left. */
export function programFrom(blocks, fromSec) {
  return blocks.find((b) => b.kind === "program" && b.startSec >= fromSec) ?? null;
}

/**
 * Where in the file a program is at `nowSec`. A program split around a mid-show break carries
 * the second part's start in the file as seekBaseSec.
 */
export function seekFor(block, nowSec) {
  return Math.max(0, (block.seekBaseSec ?? 0) + (nowSec - block.startSec));
}

/**
 * What the guide row and the player show for a channel at `nowSec`:
 * - `on`: the program on air, or null in a break, a gap or after the day's last block
 * - `next`: the first program after `on`, or after `nowSec` when nothing is on
 * - `untilSec`: when to look again: the end of the block on air, else the next program's start,
 *   else null when the day has nothing more
 */
export function airing(blocks, nowSec) {
  const current = blockAt(blocks, nowSec);
  const on = current?.kind === "program" ? current : null;
  const next = programFrom(blocks, current ? current.endSec : nowSec);
  const untilSec = current ? current.endSec : (next?.startSec ?? null);
  return { on, next, untilSec };
}

/** "Seinfeld" or "Seinfeld: The Contest". */
export function programName(item) {
  if (!item) return "";
  return item.episodeTitle ? `${item.title}: ${item.episodeTitle}` : item.title;
}

/** An epoch second as the local clock reads it, such as "3:30 PM". */
export function clock(sec, locale) {
  return new Date(sec * 1000).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

/** A count of seconds as "12:05", for the break countdown. */
export function countdown(sec) {
  const left = Math.max(0, Math.ceil(sec));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

/** The channel `step` rows from `id` in guide order, wrapping both ways. null with no channels. */
export function channelStep(channels, id, step) {
  if (channels.length === 0) return null;
  const at = channels.findIndex((c) => c.id === id);
  if (at < 0) return channels[0];
  return channels[(at + step + channels.length) % channels.length];
}
