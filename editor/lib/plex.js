// The Plex client the tools use: link a PC to the owner's account with plex.tv's legacy PIN
// flow, list the account's servers, and read a server's library.
//
// The token travels only in the X-Plex-Token header. It is never put in a URL, and no error
// message here holds it. Sign-in never registers a JWK (design section 8.2 and the research
// brief): that would expire the legacy token the Rokus use.
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const PLEX_TV = "https://plex.tv";
const PRODUCT = "basic-cable-tools";
const REQUEST_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 3_000;

// The Roku app's patterns (ChannelFilter.brs): unanchored, so an agent URL such as
// `com.plexapp.agents.thetvdb://76346?lang=en` still gives its TVDB id.
const TMDB_GUID = /tmdb:\/\/(\d+)/i;
const TVDB_GUID = /tvdb:\/\/(\d+)/i;
const IMDB_GUID = /imdb:\/\/(tt\d+)/i;

/** A stable id for this PC, so plex.tv lists one device however often the tools run. It holds no secret. */
export function defaultClientId() {
  return `${PRODUCT}-${createHash("sha1").update(hostname()).digest("hex").slice(0, 16)}`;
}

function headers(clientId, token) {
  return {
    Accept: "application/json",
    "X-Plex-Product": PRODUCT,
    "X-Plex-Version": "0.1",
    "X-Plex-Device-Name": "Basic Cable tools",
    ...(clientId && { "X-Plex-Client-Identifier": clientId }),
    ...(token && { "X-Plex-Token": token }),
  };
}

/**
 * One request. An answer outside 200 to 299 throws an Error with the HTTP status in `status`.
 * A request that gets no answer throws an Error with `retryable` set, since the next try may
 * work. `path` may carry a query string, so callers pass nothing secret in it.
 *
 * A request that carries the token does not follow redirects. A custom header such as
 * X-Plex-Token survives a redirect to another origin, so following one could hand the token to
 * an address plex.tv never listed.
 *
 * `signal` stops the request early; it then throws the signal's reason, which is not retryable.
 */
async function request(method, base, path, { token, clientId, timeoutMs = REQUEST_TIMEOUT_MS, signal }) {
  let response;
  try {
    signal?.throwIfAborted();
    response = await fetch(new URL(path, base), {
      method,
      headers: headers(clientId, token),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      ...(token && { redirect: "error" }),
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    const redirected = /redirect/i.test(error.cause?.message ?? "");
    const reason = redirected
      ? "it answered with a redirect"
      : error.name === "TimeoutError"
        ? "no answer in time"
        : (error.cause?.code ?? error.message);
    throw Object.assign(new Error(`Could not reach ${new URL(base).host} (${reason}).`), { retryable: !redirected });
  }
  if (!response.ok) {
    throw Object.assign(new Error(`Plex answered ${response.status} to ${method} ${path}.`), { status: response.status });
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`Plex sent something other than JSON to ${method} ${path}.`);
  }
}

/**
 * A new plex.tv/link PIN. Without `strong`, plex.tv gives a short code for the person to
 * type at plex.tv/link.
 * @param {{ clientId: string, plexBase?: string }} options `plexBase` is plex.tv unless a test points it elsewhere
 * @returns {Promise<{ id: number, code: string }>}
 */
export async function createPin({ clientId, plexBase = PLEX_TV }) {
  if (!clientId) throw new Error("createPin needs a clientId.");
  const pin = await request("POST", plexBase, "/api/v2/pins", { clientId });
  if (pin?.id === undefined || typeof pin.code !== "string") throw new Error("Plex sent a link code without an id.");
  return { id: pin.id, code: pin.code.toUpperCase() };
}

/**
 * Waits for the person to enter the code at plex.tv/link, then returns the account's token.
 * A poll that gets no answer is tried again until the deadline, since the person may still be
 * typing the code. If the network never comes back, the last such error is thrown. `signal`
 * stops the wait: the poll in flight is cut off and the signal's reason is thrown.
 * @param {{ id: number, clientId: string, timeoutMs?: number, intervalMs?: number, plexBase?: string,
 *   signal?: AbortSignal }} options
 * @returns {Promise<string>} the auth token
 */
export async function pollPin({ id, clientId, timeoutMs = 300_000, intervalMs = 1000, plexBase = PLEX_TV, signal }) {
  const deadline = Date.now() + timeoutMs;
  const pause = () => sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), undefined, { signal }).catch(() => signal.throwIfAborted());
  for (;;) {
    let pin;
    try {
      pin = await request("GET", plexBase, `/api/v2/pins/${encodeURIComponent(id)}`, { clientId, signal });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error.status === 404) throw new Error("The link code expired. Run the tool again for a new one.");
      if (!error.retryable || Date.now() >= deadline) throw error;
      await pause();
      continue;
    }
    if (typeof pin?.authToken === "string" && pin.authToken !== "") return pin.authToken;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the link code to be entered at plex.tv/link.");
    await pause();
  }
}

/**
 * GET `path` from a Plex server (or plex.tv) and parse the JSON answer. With no `baseUrl`,
 * the request goes to `plexBase`.
 * @param {string | undefined} baseUrl e.g. "https://192-168-1-5.abc.plex.direct:32400"
 * @param {string} path e.g. "/library/sections"
 * @param {{ token?: string, clientId?: string, plexBase?: string, timeoutMs?: number }} [options]
 */
export async function plexGet(baseUrl, path, { token, clientId, plexBase = PLEX_TV, timeoutMs } = {}) {
  return request("GET", baseUrl ?? plexBase, path, { token, clientId, timeoutMs });
}

/**
 * The servers on the account.
 * @param {{ token: string, clientId: string, plexBase?: string }} options
 * @returns {Promise<{ name: string, machineIdentifier: string, owned: boolean,
 *   connections: { uri: string, local: boolean, relay: boolean }[] }[]>}
 */
export async function listServers({ token, clientId, plexBase = PLEX_TV }) {
  const resources = await plexGet(plexBase, "/api/v2/resources?includeHttps=1&includeRelay=1", { token, clientId });
  if (!Array.isArray(resources)) throw new Error("Plex sent a server list that is not a list.");
  return resources
    .filter((resource) => typeof resource?.provides === "string" && resource.provides.split(",").map((p) => p.trim()).includes("server"))
    .map((resource) => ({
      name: String(resource.name ?? ""),
      machineIdentifier: String(resource.clientIdentifier ?? ""),
      owned: resource.owned === true,
      connections: (Array.isArray(resource.connections) ? resource.connections : [])
        .filter((c) => typeof c?.uri === "string")
        .map((c) => ({ uri: c.uri, local: c.local === true, relay: c.relay === true })),
    }));
}

/**
 * The first of the server's connections that answers GET /identity with the server's own
 * machine identifier, trying local addresses, then remote ones, then relays. The probe sends
 * no token, so a wrong address never sees it. null when none answers.
 * @param {{ machineIdentifier: string, connections: { uri: string, local: boolean, relay: boolean }[] }} server
 * @param {{ timeoutMs?: number }} [options]
 */
export async function pickConnection(server, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const rank = (c) => (c.relay ? 2 : c.local ? 0 : 1);
  const ordered = [...server.connections].sort((a, b) => rank(a) - rank(b));
  for (const candidate of ordered) {
    try {
      const identity = await request("GET", candidate.uri, "/identity", { timeoutMs });
      if (identity?.MediaContainer?.machineIdentifier === server.machineIdentifier) return candidate;
    } catch {
      // Closed, slow or not Plex: try the next address.
    }
  }
  return null;
}

/**
 * The ids in a Plex item's `Guid` list (`includeGuids=1`): TMDB and TVDB as numbers, IMDb as
 * a lowercase `tt` string. Reads the same patterns as the Roku app, so the legacy TheTVDB
 * agent's `com.plexapp.agents.thetvdb://76346` counts as TVDB. An id that is missing or not
 * a positive whole number is left out; the first of each kind wins.
 * @param {unknown} guids a list of `{ id }` objects or of strings
 * @returns {{ tmdb?: number, tvdb?: number, imdb?: string }}
 */
export function plexIds(guids) {
  const ids = {};
  for (const guid of Array.isArray(guids) ? guids : []) {
    const text = typeof guid === "string" ? guid : guid?.id;
    if (typeof text !== "string") continue;
    const tmdb = Number(TMDB_GUID.exec(text)?.[1]);
    if (ids.tmdb === undefined && Number.isSafeInteger(tmdb) && tmdb > 0) ids.tmdb = tmdb;
    const tvdb = Number(TVDB_GUID.exec(text)?.[1]);
    if (ids.tvdb === undefined && Number.isSafeInteger(tvdb) && tvdb > 0) ids.tvdb = tvdb;
    const imdb = IMDB_GUID.exec(text)?.[1];
    if (ids.imdb === undefined && imdb) ids.imdb = imdb.toLowerCase();
  }
  return ids;
}
