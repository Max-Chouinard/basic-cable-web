// The Plex calls only a web page makes: finding the server from a page, and the stream address.
// The link code, the server list and the library read come from editor/lib, unchanged.

const PROBE_TIMEOUT_MS = 4_000;

/**
 * The first of the server's connections that answers GET /identity with the server's own machine
 * identifier, trying home addresses, then remote ones, then relays.
 *
 * A page differs from the tools in two ways. Plex names a page's origin in its answer only when
 * the request carries the sign-in, so the probe sends the token. And a page served over https may
 * only ask https addresses, so `secureOnly` skips the others. The addresses come from plex.tv's
 * list for this account, and an https one is a plex.direct name whose certificate is the
 * server's own.
 * @param {{ machineIdentifier: string, connections: { uri: string, local: boolean, relay: boolean }[] }} server
 * @param {string} token
 * @param {{ secureOnly?: boolean, timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ uri: string, local: boolean, relay: boolean } | null>}
 */
export async function pickConnectionWeb(server, token, { secureOnly = true, timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const rank = (c) => (c.relay ? 2 : c.local ? 0 : 1);
  const ordered = server.connections
    .filter((c) => !secureOnly || c.uri.startsWith("https://"))
    .sort((a, b) => rank(a) - rank(b));
  for (const candidate of ordered) {
    try {
      const response = await fetchImpl(new URL("/identity", candidate.uri), {
        headers: { Accept: "application/json", "X-Plex-Token": token },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) continue;
      const identity = await response.json();
      if (identity?.MediaContainer?.machineIdentifier === server.machineIdentifier) return candidate;
    } catch {
      // Closed, slow or not Plex: try the next address.
    }
  }
  return null;
}

/**
 * Plex's HLS stream of an item, joined `offsetSec` into the file, as upstream's web tuner asks
 * for it. The token is not in the address: the player sends it in a header.
 *
 * `session` names this one stream and is new each time. The session identifier is the browser's
 * own and never changes, as the TV's is (NxPlexPlaybackSessionId): Plex ties an item to the
 * identifier that last played it, and for minutes after a stop it answers 400 to a start of the
 * same item under another one (measured on the owner's server, 2026-11-11). With one identifier
 * a stream stops and starts again at once, which leaving a channel and coming back needs.
 * @param {{ base: string, ratingKey: string, offsetSec: number, session: string, clientId: string }} options
 */
export function streamUrl({ base, ratingKey, offsetSec, session, clientId }) {
  const query = new URLSearchParams({
    path: `/library/metadata/${ratingKey}`,
    mediaIndex: "0",
    partIndex: "0",
    protocol: "hls",
    offset: String(Math.max(0, Math.floor(offsetSec))),
    copyts: "1",
    session,
    "X-Plex-Session-Identifier": clientId,
    "X-Plex-Client-Identifier": clientId,
    "X-Plex-Product": "Basic Cable",
    "X-Plex-Platform": "Web",
    "X-Plex-Platform-Version": "1.0",
    "X-Plex-Device": "Browser",
    "X-Plex-Device-Name": "Basic Cable in a browser",
  });
  return `${new URL("/video/:/transcode/universal/start.m3u8", base)}?${query}`;
}

/** The address that ends a stream's work on the server. */
export function stopUrl({ base, session }) {
  return `${new URL("/video/:/transcode/universal/stop", base)}?${new URLSearchParams({ session })}`;
}
