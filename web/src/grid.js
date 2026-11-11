// The guide grid's rules, as the TV's guide has them (docs/2026-11-04-guide-redesign-design.md):
// which program is selected, where the selection goes on a key, which two hours the grid shows
// and where each block sits. No DOM and no network, so Node tests it.

export const HALF_HOUR_SEC = 1800;

/** The half hour an epoch second falls in, on the local clock. */
export function halfHourFloor(sec) {
  const date = new Date(sec * 1000);
  date.setMinutes(date.getMinutes() < 30 ? 0 : 30, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

const programsOf = (blocks) => blocks.filter((b) => b.kind === "program" && b.item);

/** Whether a program is on air at `nowSec`: its slot covers the moment, its break included. */
export function onAir(block, nowSec) {
  return block.startSec <= nowSec && nowSec < block.slotEndSec;
}

/**
 * The program a row shows as selected. The selection is the program on air (`{ live: true }`) or
 * the one at a chosen time (`{ live: false, timeSec }`). A row with nothing at that time gives
 * its next program, then its last one, so a row with any program always has a selection.
 */
export function selectedProgram(blocks, sel, nowSec) {
  const programs = programsOf(blocks);
  const at = sel.live ? nowSec : sel.timeSec;
  return programs.find((b) => onAir(b, at)) ?? programs.find((b) => b.startSec > at) ?? programs.at(-1) ?? null;
}

/**
 * Right selects the next program on the row, Left the previous one. Left stops at the program on
 * air, and a program on air is selected as live, so it follows the clock. Returns the new
 * selection, or null when the key moves nothing.
 */
export function moveSelection(blocks, sel, nowSec, key) {
  const programs = programsOf(blocks);
  const current = selectedProgram(blocks, sel, nowSec);
  const at = programs.indexOf(current);
  if (at < 0) return null;
  if (key === "right") {
    const next = programs[at + 1];
    return next ? { live: false, timeSec: next.startSec } : null;
  }
  if (key === "left") {
    if (sel.live || onAir(current, nowSec)) return null;
    const previous = programs[at - 1];
    if (!previous || previous.slotEndSec <= nowSec) return { live: true };
    return onAir(previous, nowSec) ? { live: true } : { live: false, timeSec: previous.startSec };
  }
  return null;
}

/** A chosen program that has ended, or is now on air, goes back to following the clock. */
export function settleSelection(sel, nowSec) {
  return !sel.live && sel.timeSec <= nowSec ? { live: true } : sel;
}

/**
 * Where the grid's window starts: the current half hour, moved on in half-hour steps until the
 * selected program's start is in view, and never past the day's last window.
 */
export function windowStart(nowSec, selected, windowSec, dayEndSec) {
  const first = halfHourFloor(nowSec);
  if (!selected) return first;
  let start = first;
  while (selected.startSec >= start + windowSec && start + windowSec < dayEndSec) start += HALF_HOUR_SEC;
  return start;
}

/**
 * The row's programs inside the window, each with its place: `x` and `w` in px from the window's
 * left edge at `pxPerMin`, `gap` px between neighbours, and whether it runs past either edge.
 */
export function layoutRow(blocks, startSec, windowSec, pxPerMin, gap = 4) {
  const endSec = startSec + windowSec;
  const out = [];
  for (const block of programsOf(blocks)) {
    if (block.endSec <= startSec || block.startSec >= endSec) continue;
    const from = Math.max(block.startSec, startSec);
    const to = Math.min(block.endSec, endSec);
    const w = ((to - from) / 60) * pxPerMin - gap;
    if (w < 8) continue;
    out.push({ block, x: ((from - startSec) / 60) * pxPerMin, w, clipL: block.startSec < startSec, clipR: block.endSec > endSec });
  }
  return out;
}

/** The first row in view: the focused row sits third when the list allows, and no row is cut. */
export function firstRow(focus, count, rows) {
  return Math.max(0, Math.min(focus - 2, count - rows));
}

/** Down wraps from the last row to the first; Up stops at the first (-1: the key leaves the grid). */
export function rowStep(focus, count, key) {
  if (key === "down") return focus < count - 1 ? focus + 1 : count > 1 ? 0 : -1;
  if (key === "up") return focus > 0 ? focus - 1 : -1;
  return -1;
}

/** Rewind and Fast Forward move a screen of rows and stop at either end (-1: nothing moves). */
export function rowPage(focus, count, rows, key) {
  const to = key === "rewind" ? Math.max(0, focus - rows) : key === "fastforward" ? Math.min(count - 1, focus + rows) : focus;
  return to === focus ? -1 : to;
}

/** "S3 E5 · The Library", or a movie's year. */
export function episodeLine(item) {
  if (!item) return "";
  if (item.type !== "episode") return item.year ? String(item.year) : "";
  const tag = [item.seasonNumber != null ? `S${item.seasonNumber}` : "", item.episodeNumber != null ? `E${item.episodeNumber}` : ""].filter(Boolean).join(" ");
  return [tag, item.episodeTitle].filter(Boolean).join(" · ");
}

/**
 * The show panel's time line. The range is the block's slot, so a half-hour slot reads 7:30 to
 * 8:00 though its episode runs 22 minutes. On air it adds the minutes left, later the minutes
 * until it starts, and earlier nothing.
 */
export function whenLine(block, nowSec, clock) {
  const range = `${clock(block.startSec)} - ${clock(block.slotEndSec)}`;
  if (onAir(block, nowSec)) return `${range} · ${Math.max(1, Math.ceil((block.slotEndSec - nowSec) / 60))} min left`;
  if (block.startSec > nowSec) return `${range} · starts in ${Math.max(1, Math.ceil((block.startSec - nowSec) / 60))} min`;
  return range;
}

/** Seconds as the OSD's clock reads them: "7:05", or "1:07:05" past an hour. */
export function hms(sec) {
  const s = Math.max(0, Math.floor(sec));
  const pad = (n) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/**
 * Back in the guide, as the TV's (NxGuideBack): off the tuned row or off the program on air it
 * returns to live; on live with a channel playing it goes to the picture; else it does nothing.
 */
export function guideBack({ focusId, tunedId, live, playing }) {
  if (tunedId !== null && (focusId !== tunedId || !live)) return "live";
  return playing ? "full" : "none";
}
