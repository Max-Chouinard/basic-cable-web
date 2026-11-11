// Writes a file so that a reader sees the old text or the new, never part of one: the text goes
// to a temp file in the same folder, which a rename then puts in place. The editor writes
// lineup/lineup.json and its library cache this way.
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Another program on Windows, such as a virus scan or a sync client, can hold a fresh file for a
// moment, and a rename over it then fails with one of these codes.
const HELD = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_TRIES = 10;
const RENAME_WAIT_MS = 100;

/**
 * Writes `text` (or a Buffer, as for a logo's PNG) to `path` through a temp file and a rename,
 * making the folder when it is missing. A rename refused with EPERM, EACCES or EBUSY is tried
 * again for about a second before the error passes on, and a failed write leaves no temp file
 * behind.
 * @param {string} path
 * @param {string | Buffer} text
 * @param {{ rename?: (from: string, to: string) => void }} [options] `rename` stands in for
 *   renameSync in tests
 */
export function replaceFile(path, text, { rename = renameSync } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, text);
    for (let attempt = 1; ; attempt++) {
      try {
        rename(temp, path);
        return;
      } catch (error) {
        if (!HELD.has(error?.code) || attempt >= RENAME_TRIES) throw error;
        pause(RENAME_WAIT_MS);
      }
    }
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Blocks for `ms` milliseconds. The writes are synchronous, so the wait between tries is too. */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
