// Basic Cable in a browser, laid out and driven as the TV's guide is
// (docs/2026-11-04-guide-redesign-design.md): the video window, the show panel and the grid on a
// 1920 x 1080 stage scaled to the window, the remote's keys on the keyboard, and the picture's
// OSD, channel strip and cards. The page signs in to Plex with a link code, finds the lineup's
// server, reads the library, builds today's guide with the engines the editor uses and plays the
// tuned channel through Plex's HLS stream. Nothing but Plex and plex.tv is asked for anything.
import { fetchLibrary } from "../../editor/lib/library.js";
import { createPin, listServers, pollPin } from "../../editor/lib/plex.js";
import { guideDay } from "../../editor/lib/preview.js";
import { episodeLine, firstRow, guideBack, hms, layoutRow, moveSelection, onAir, rowPage, rowStep, selectedProgram, settleSelection, whenLine, windowStart } from "./grid.js";
import { artKey, createPictures } from "./pictures.js";
import { pickConnectionWeb, stopUrl, streamUrl } from "./plex-web.js";
import { clearLibrary, loadLibrary, saveLibrary, settings } from "./store.js";
import { airing, channelStep, clock, countdown, programName, seekFor } from "./tune.js";

const LIBRARY_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const OSD_SEC = 8;
const THEMES = ["cable-box", "prevue", "clean"];
const THEME_NAMES = { "cable-box": "CABLE BOX", prevue: "PREVUE", clean: "CLEAN" };
const KEYS_HINT = "Arrows move. Enter is OK. Esc is Back. Page Up and Page Down move a screen of channels. P switches profile. F fills the screen. M mutes.";
const $ = (id) => document.getElementById(id);
const stage = $("stage");
const screen = $("screen");
const video = $("video");

// A page on this computer may point at a stand-in for plex.tv (?plex=http://127.0.0.1:port), which
// is how the page is checked without a Plex account. A hosted page never reads it.
const onThisComputer = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
const plexBase = (onThisComputer && new URLSearchParams(location.search).get("plex")) || undefined;

const state = {
  lineup: null,
  token: settings.get("token"),
  clientId: settings.get("clientId"),
  base: null,
  items: null,
  savedAt: 0,
  profile: settings.get("profile") === "kids" ? "kids" : "grownups",
  theme: "cable-box",
  scanlines: settings.get("scanlines") !== "off",
  layout: null,
  // The guide: its channels, the focused row, the selection on it, and where the keys go.
  channels: [],
  dayEndSec: 0,
  guideHour: "",
  focusId: null,
  sel: { live: true },
  nav: "grid",
  menu: null,
  panelKey: "",
  panelSettled: "",
  panelTimer: 0,
  minute: "",
  // The picture: the tuned channel, what plays, and what draws over it.
  tunedId: null,
  playing: null,
  untilSec: null,
  breakNext: null,
  session: null,
  // Settles once the last stream's stop has answered: Plex refuses a new stream while the
  // old one still runs, so each start waits for it, as the TV's tune waits (onStopDone).
  stopped: Promise.resolve(),
  hls: null,
  tuning: false,
  failed: false,
  soundBlocked: false,
  full: false,
  osdUntil: 0,
  touchUntil: 0,
  strip: null,
  nowPlaying: false,
  signIn: null,
};

if (!state.clientId) {
  state.clientId = `basic-cable-web-${randomId()}`;
  settings.set("clientId", state.clientId);
}

const pictures = createPictures({ onArrive: () => requestAnimationFrame(render) });

function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

const nowSec = () => Math.floor(Date.now() / 1000);
const tuned = () => state.channels.find((c) => c.id === state.tunedId) ?? null;
const focused = () => state.channels.find((c) => c.id === state.focusId) ?? null;
const chipColor = (channel) => (/^#[0-9a-f]{6}$/i.test(channel?.colorHex ?? "") ? channel.colorHex : "#3D5AFE");

function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// ── The stage: the TV's screen, scaled to the window ─────────────────────────

/**
 * Where the pieces sit. A wide window gets the TV's own layout. An upright phone gets the same
 * pieces stacked on a narrow stage, with one hour of the grid and larger type.
 */
function layoutFor(vw, vh) {
  if (vw >= vh) {
    return { w: 1920, h: 1080, t: 1, compact: false, video: [40, 92, 640, 360], panel: [696, 92, 1184, 360], artW: 900, gridY: 468, dateX: 40, plateX: 24, plateW: 222, blocksX: 256, blocksW: 1640, windowSec: 7200, rows: 6 };
  }
  const w = 820;
  const h = Math.max(1458, Math.round((w * vh) / vw));
  const gridY = 805;
  return { w, h, t: 1.4, compact: true, video: [20, 84, 780, 439], panel: [20, 539, 780, 250], artW: 520, gridY, dateX: 12, plateX: 12, plateW: 200, blocksX: 222, blocksW: 586, windowSec: 3600, rows: Math.max(3, Math.floor((h - gridY - 44 - 6) / 94)) };
}

function place(node, [x, y, w, h]) {
  Object.assign(node.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
}

function applyLayout() {
  // A window with no size yet (a tab opened in the background) is laid out when it gets one.
  const vw = window.innerWidth || 1920;
  const vh = window.innerHeight || 1080;
  const L = layoutFor(vw, vh);
  state.layout = L;
  const k = Math.min(vw / L.w, vh / L.h);
  stage.style.width = `${L.w}px`;
  stage.style.height = `${L.h}px`;
  stage.style.transform = `translate(${(vw - L.w * k) / 2}px, ${(vh - L.h * k) / 2}px) scale(${k})`;
  stage.style.setProperty("--t", String(L.t));
  stage.classList.toggle("compact", L.compact);
  place($("panel"), L.panel);
  place($("grid"), [0, L.gridY, L.w, L.h - L.gridY]);
  $("panelArt").style.width = `${L.artW}px`;
  placeScreen();
  render();
}

/** The picture sits in the guide's video window, or over the whole stage in full screen. */
function placeScreen() {
  const L = state.layout;
  const rect = state.full ? [0, 0, L.w, L.h] : L.video;
  place(screen, rect);
  screen.style.fontSize = `${rect[2] * 0.01875}px`;
}

function applyLook() {
  stage.dataset.theme = state.theme;
  stage.dataset.scanlines = state.scanlines ? "on" : "off";
  stage.dataset.profile = state.profile;
  $("pillLabel").textContent = state.profile === "kids" ? "KIDS" : "GROWN-UPS";
}

/** The tuning card's snow: one small tile of noise, which the stylesheet shifts about. */
function makeSnow() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(128, 128);
  for (let i = 0; i < image.data.length; i += 4) {
    const v = Math.floor(Math.random() * 150);
    image.data[i] = image.data[i + 1] = image.data[i + 2] = v;
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  $("haze").style.backgroundImage = `url(${canvas.toDataURL()})`;
}

// ── The gate: sign-in, loading and anything that stops the guide ─────────────

function gate({ title, text = "", code = "", link = false, button = "", onButton = null }) {
  $("gate").hidden = false;
  $("gateTitle").textContent = title;
  $("gateText").textContent = text;
  $("gateCode").textContent = code;
  $("gateCode").hidden = code === "";
  $("gateLink").hidden = !link;
  $("gateButton").textContent = button;
  $("gateButton").hidden = button === "";
  $("gateButton").onclick = onButton;
}

function askSignIn(why = "") {
  state.signIn?.abort();
  stopStream();
  state.token = null;
  settings.remove("token");
  state.menu = null;
  gate({
    title: "Sign in to Plex",
    text: `${why}${why ? " " : ""}Basic Cable plays your own Plex library. This browser keeps the sign-in until you sign out.`,
    button: "GET A LINK CODE",
    onButton: signIn,
  });
  render();
}

async function signIn() {
  state.signIn = new AbortController();
  const { signal } = state.signIn;
  try {
    gate({ title: "Sign in to Plex", text: "Asking Plex for a link code." });
    const pin = await createPin({ clientId: state.clientId, plexBase });
    gate({
      title: "Enter this code at plex.tv/link",
      text: "Open plex.tv/link on any device, sign in and type the code. This page carries on by itself.",
      code: pin.code,
      link: true,
    });
    state.token = await pollPin({ id: pin.id, clientId: state.clientId, plexBase, signal });
    settings.set("token", state.token);
    await connect();
  } catch (error) {
    if (signal.aborted) return;
    gate({ title: "The sign-in did not finish", text: error.message, button: "TRY AGAIN", onButton: signIn });
  }
}

async function signOut() {
  stopStream();
  setFull(false);
  state.items = null;
  state.channels = [];
  state.tunedId = null;
  state.focusId = null;
  pictures.clear();
  await clearLibrary();
  askSignIn();
}

// ── Plex: the server and the library ─────────────────────────────────────────

async function connect() {
  try {
    gate({ title: "Finding your Plex server", text: "Asking Plex where the server is." });
    const servers = await listServers({ token: state.token, clientId: state.clientId, plexBase });
    const server = servers.find((s) => s.machineIdentifier === state.lineup.server.machineIdentifier);
    if (!server) {
      gate({
        title: "This Plex account can't see the server",
        text: "The lineup was made for one Plex server, and the account you signed in with has no access to it.",
        button: "SIGN IN WITH ANOTHER ACCOUNT",
        onButton: signOut,
      });
      return;
    }
    const connection = await pickConnectionWeb(server, state.token, { secureOnly: location.protocol === "https:" });
    if (!connection) {
      gate({
        title: `${server.name || "The Plex server"} is out of reach`,
        text: "None of its addresses answered from here. Check that the server is on, and that remote access is on in Plex when you are away from home.",
        button: "TRY AGAIN",
        onButton: connect,
      });
      return;
    }
    state.base = connection.uri;
    // A stream the last visit left running blocks this one's: stop it first, as the TV does at
    // launch (rememberStop).
    const left = settings.get("session");
    if (left) {
      state.session = left;
      stopStream();
    }
    await loadItems(false);
  } catch (error) {
    if (error?.status === 401) return askSignIn("Plex no longer accepts the saved sign-in.");
    gate({ title: "Plex did not answer", text: error.message, button: "TRY AGAIN", onButton: connect });
  }
}

async function loadItems(fresh) {
  const serverId = state.lineup.server.machineIdentifier;
  try {
    const saved = fresh ? null : await loadLibrary(serverId);
    if (saved && Array.isArray(saved.items) && Date.now() - saved.savedAt < LIBRARY_MAX_AGE_MS) {
      state.items = saved.items;
      state.savedAt = saved.savedAt;
    } else {
      gate({ title: "Reading your Plex library", text: "A big library takes about a minute. The page keeps it for 12 hours." });
      const client = { baseUrl: state.base, token: state.token, clientId: state.clientId };
      const library = await fetchLibrary(client, state.lineup.server.programSections);
      state.items = library.items;
      state.savedAt = Date.now();
      await saveLibrary(serverId, state.items, state.savedAt);
    }
    gate({ title: "Building the guide", text: `${state.items.length.toLocaleString()} programs in the library.` });
    // The gate paints before the guide's work holds the page for a second or two.
    await new Promise((resolve) => setTimeout(resolve, 50));
    openGuide();
  } catch (error) {
    if (error?.status === 401) return askSignIn("Plex no longer accepts the saved sign-in.");
    gate({ title: "The library read stopped", text: error.message, button: "TRY AGAIN", onButton: () => loadItems(true) });
  }
}

// ── The guide ────────────────────────────────────────────────────────────────

function buildGuide() {
  const now = new Date();
  state.guideHour = `${now.toDateString()} ${now.getHours()}`;
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  state.dayEndSec = Math.floor(midnight.getTime() / 1000);
  state.channels = guideDay(state.lineup, state.items, { nowMs: now.getTime(), profile: state.profile });
}

/**
 * The guide comes up as the TV's does: on the channel this profile watched last, else the top
 * row, with that channel playing in the video window and its program on air selected.
 */
function openGuide() {
  buildGuide();
  $("gate").hidden = true;
  state.nav = "grid";
  state.sel = { live: true };
  const saved = Number(settings.get(`channel.${state.profile}`));
  const start = state.channels.find((c) => c.id === saved) ?? state.channels[0] ?? null;
  if (start) {
    state.focusId = start.id;
    tune(start.id);
  } else {
    stopStream();
    state.tunedId = null;
    state.focusId = null;
    card({ title: "No channels yet", text: emptyGuideText() });
  }
  render();
}

/** A new hour or day: the guide is made again, and what still airs plays on. */
function refreshGuide() {
  buildGuide();
  if (!tuned()) return openGuide();
  if (!focused()) state.focusId = state.tunedId;
  showOnAir();
  render();
}

function emptyGuideText() {
  return state.profile === "kids"
    ? "A channel shows here when the lineup marks it for Kids and enough of its shows are rated within the Kids limit."
    : "No channel in the lineup has enough programs in this library.";
}

function render() {
  if (!state.layout) return;
  renderTop();
  renderGrid();
  renderPanel();
  renderScreen();
  renderMenu();
}

function renderTop() {
  $("clock").textContent = clock(nowSec());
  $("navSettings").classList.toggle("focus", state.nav === "settings");
  $("pill").classList.toggle("focus", state.nav === "pill");
}

function spec(item, kind, width, height) {
  return { base: state.base, token: state.token, key: artKey(item), kind, width, height };
}

function renderGrid() {
  const L = state.layout;
  const now = nowSec();
  const channels = state.channels;
  const focus = Math.max(0, channels.findIndex((c) => c.id === state.focusId));
  const selected = channels[focus] ? selectedProgram(channels[focus].blocks, state.sel, now) : null;
  const start = windowStart(now, state.sel.live ? null : selected, L.windowSec, state.dayEndSec);
  const pxPerMin = L.blocksW / (L.windowSec / 60);
  const kids = state.profile === "kids";

  $("notice").hidden = channels.length > 0 || !state.items;
  $("notice").textContent = emptyGuideText();
  $("gridDate").style.left = `${L.dateX}px`;
  $("gridDate").textContent = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).toUpperCase();
  const marks = [];
  for (let t = start; t < start + L.windowSec; t += 1800) {
    const mark = el("div", "mark", clock(t));
    mark.style.left = `${L.blocksX + ((t - start) / 60) * pxPerMin}px`;
    marks.push(mark);
  }
  $("marks").replaceChildren(...marks);

  const top = firstRow(focus, channels.length, L.rows);
  const rows = channels.slice(top, top + L.rows).map((channel, i) => {
    const index = top + i;
    const row = el("div", "row");
    row.style.top = `${44 + i * 94}px`;
    row.style.width = `${L.w}px`;
    const plate = el("div", `plate${index === focus && state.nav === "grid" ? " focus" : ""}`);
    plate.dataset.channel = String(channel.id);
    plate.style.left = `${L.plateX}px`;
    plate.style.width = `${L.plateW}px`;
    plate.append(el("div", "plateNumber", String(channel.number)), el("div", "plateName", channel.name));
    const blocks = el("div", "blocks");
    blocks.style.left = `${L.blocksX}px`;
    blocks.style.width = `${L.blocksW}px`;
    for (const cell of layoutRow(channel.blocks, start, L.windowSec, pxPerMin)) {
      const { block } = cell;
      const isSel = index === focus && block === selected && state.nav === "grid";
      const node = el("div", `block${block.slotEndSec <= now ? " past" : ""}${isSel ? " sel" : ""}`);
      node.dataset.channel = String(channel.id);
      node.dataset.start = String(block.startSec);
      node.style.left = `${cell.x}px`;
      node.style.width = `${cell.w}px`;
      const edge = el("div", "edge");
      edge.style.background = chipColor(channel);
      node.append(edge);
      if (cell.clipL) node.append(el("div", "arrow l"));
      // Kids blocks lead with the show's logo, else its poster; a narrow block shows the picture alone.
      let picture = null;
      if (kids && cell.w >= 130) {
        const logo = spec(block.item, "clearLogo", 224, 128);
        picture = pictures.get(logo) ?? (pictures.missing(logo) ? pictures.get(spec(block.item, "thumb", 128, 128)) : null);
        if (picture) {
          const img = el("img", "logo");
          img.src = picture;
          img.alt = "";
          node.append(img);
        }
      }
      if (cell.w >= 56 && !(picture && cell.w < 190)) {
        const text = el("div", "text");
        text.append(el("div", "btitle", block.item.title), el("div", "bsub", episodeLine(block.item)));
        node.append(text);
      }
      if (cell.clipR) node.append(el("div", "arrow r"));
      blocks.append(node);
    }
    row.append(plate, blocks);
    return row;
  });
  $("rows").replaceChildren(...rows);

  const nowX = L.blocksX + ((now - start) / 60) * pxPerMin;
  $("nowLine").hidden = channels.length === 0 || nowX < L.blocksX || nowX > L.blocksX + L.blocksW;
  $("nowLine").style.left = `${nowX}px`;
}

/**
 * The show panel follows the selection. Its text changes at once. Its pictures wait for the
 * selection to rest a quarter of a second, so holding a key never fetches a picture a press; a
 * picture already here shows at once.
 */
function renderPanel() {
  const channel = focused();
  const now = nowSec();
  const block = channel ? selectedProgram(channel.blocks, state.sel, now) : null;
  const item = block?.item ?? null;
  $("panelChannel").textContent = channel ? `CH ${channel.number} · ${channel.name.toUpperCase()}` : "";
  const rating = item ? item.episodeRating || item.contentRating || "" : "";
  $("panelRating").textContent = rating;
  $("panelRating").hidden = rating === "";
  $("panelEpisode").textContent = episodeLine(item);
  $("panelWhen").textContent = block ? whenLine(block, now, clock) : "";

  const key = item ? `${artKey(item)}` : "";
  if (key !== state.panelKey) {
    state.panelKey = key;
    clearTimeout(state.panelTimer);
    state.panelTimer = setTimeout(() => {
      state.panelSettled = key;
      renderPanel();
    }, 250);
  }
  const settled = state.panelSettled === key;
  const ask = (s) => (settled ? pictures.get(s) : pictures.peek(s));
  const art = item ? ask(spec(item, "art", state.layout.artW, state.layout.panel[3])) : null;
  const logo = item ? ask(spec(item, "clearLogo", 1040, 300)) : null;
  $("panelArt").hidden = !art;
  if (art && $("panelArt").src !== art) $("panelArt").src = art;
  $("panelLogo").hidden = !logo;
  if (logo && $("panelLogo").src !== logo) $("panelLogo").src = logo;
  $("panelLogo").alt = item?.title ?? "";
  $("panelTitle").hidden = Boolean(logo);
  $("panelTitle").textContent = item?.title ?? "";
}

// ── The picture and what draws over it ───────────────────────────────────────

function renderScreen() {
  const now = Date.now() / 1000;
  const channel = tuned();
  $("haze").hidden = !state.tuning;
  $("hazeText").textContent = channel ? `TUNING · CH ${channel.number}` : "";
  $("soundChip").hidden = !state.soundBlocked || !state.playing;
  const overlay = state.strip !== null || state.nowPlaying;
  $("osd").hidden = !(state.full && now < state.osdUntil && !overlay);
  $("touch").hidden = !(state.full && now < state.touchUntil && !overlay);
  $("strip").hidden = !(state.full && state.strip !== null);
  $("nowPlaying").hidden = !(state.full && state.nowPlaying);
  if (!$("osd").hidden) renderOsdTime();
  if (state.breakNext && !$("card").hidden) renderBreak();
}

function card({ title, kicker = "", text = "", foot = "" }) {
  $("card").hidden = false;
  $("cardTitle").textContent = title.toUpperCase();
  $("cardKicker").textContent = kicker;
  $("cardText").textContent = text;
  $("cardFoot").textContent = foot;
  $("cardRule").style.background = tuned() ? chipColor(tuned()) : "";
}

function renderBreak() {
  const next = state.breakNext;
  if (!next) return;
  card({ title: "We'll be right back", kicker: "UP NEXT", text: programName(next.item), foot: `${clock(next.startSec)} · ${countdown(next.startSec - Date.now() / 1000)}` });
}

/**
 * Full screen's channel OSD, bottom left, for 8 seconds: a bar and the channel in its colour,
 * what airs, and the time into it (GuideView's showOsd).
 */
function showOsd() {
  const channel = tuned();
  if (!channel) return;
  const color = chipColor(channel);
  const bar = el("div", "bar");
  bar.style.background = color;
  const ch = el("div", "ch", `CH ${channel.number}`);
  const name = el("div", "name", channel.name);
  ch.style.color = name.style.color = color;
  const nodes = [bar, ch, name];
  const on = airing(channel.blocks, nowSec()).on;
  if (on?.item) {
    const item = on.item;
    const tag = [item.seasonNumber != null ? `S${item.seasonNumber}` : "", item.episodeNumber != null ? `E${item.episodeNumber}` : ""].filter(Boolean).join(" ");
    const what = item.type === "episode" && item.episodeTitle ? [item.title, tag, `"${item.episodeTitle}"`].filter(Boolean).join("  ") : [item.title, item.year || ""].filter(Boolean).join("  ");
    nodes.push(el("div", "what", what), el("div", "time"));
  }
  $("osd").replaceChildren(...nodes);
  state.osdUntil = Date.now() / 1000 + OSD_SEC;
  renderScreen();
}

function renderOsdTime() {
  const line = $("osd").querySelector(".time");
  const on = tuned() ? airing(tuned().blocks, nowSec()).on : null;
  if (line && on) line.textContent = `${hms(nowSec() - on.startSec)} / ${hms(on.endSec - on.startSec)}`;
}

/** The channel strip, Up in full screen: a card a channel, the focused one centred. */
function renderStrip() {
  if (state.strip === null) return;
  const now = nowSec();
  const cards = el("div");
  cards.id = "stripCards";
  state.channels.forEach((channel, i) => {
    const color = chipColor(channel);
    const node = el("div", `scard${i === state.strip ? " focus" : ""}`);
    node.dataset.index = String(i);
    if (i === state.strip) node.style.borderColor = color;
    else if (channel.id === state.tunedId) node.style.background = `${color}55`;
    const top = el("div", "top");
    top.style.background = color;
    const line = el("div", "line");
    const num = el("div", "num", String(channel.number));
    num.style.color = color;
    line.append(num, el("div", "nm", channel.name));
    const { on, next } = airing(channel.blocks, now);
    node.append(top, line, el("div", "on", on ? programName(on.item) : next ? `Back at ${clock(next.startSec)}` : "Off the air"));
    cards.append(node);
  });
  $("strip").replaceChildren(cards);
  // 1em is the picture's width over 53.33, a card 8.6em and the gap 0.33em.
  const em = parseFloat(screen.style.fontSize);
  const centre = (state.strip + 0.5) * 8.6 * em + state.strip * 0.33 * em;
  cards.style.transform = `translateX(${parseFloat(screen.style.width) / 2 - centre}px)`;
}

/** Now Playing, Down in full screen: the poster, the channel, what is on and what follows. */
function renderNowPlaying() {
  const channel = tuned();
  if (!channel) return;
  const now = nowSec();
  const { on, next } = airing(channel.blocks, now);
  const nodes = [];
  if (on?.item) {
    const poster = pictures.get(spec(on.item, "thumb", 312, 468));
    const img = el("img");
    img.alt = "";
    if (poster) img.src = poster;
    nodes.push(img);
  }
  const text = el("div", "np");
  text.append(el("div", "npCh", `CH ${channel.number} · ${channel.name.toUpperCase()}`));
  if (on?.item) {
    const rating = on.item.episodeRating || on.item.contentRating || "";
    const when = el("div", "npWhen", whenLine(on, now, clock));
    if (rating) when.append(el("span", "chip", rating));
    text.append(el("div", "npTitle", on.item.title), el("div", "npEp", episodeLine(on.item)), when, el("div", "npSum", on.item.summary || ""));
  } else {
    text.append(el("div", "npTitle", "ON A BREAK"));
  }
  if (next) text.append(el("div", "npNext", `UP NEXT  ${programName(next.item)} at ${clock(next.startSec)}`));
  nodes.push(text);
  $("nowPlaying").replaceChildren(...nodes);
}

function setFull(on) {
  if (state.full === on) return;
  state.full = on;
  stage.classList.toggle("full", on);
  state.strip = null;
  state.nowPlaying = false;
  placeScreen();
  if (on) showOsd();
  else {
    // The guide opens on the program on air on the tuned channel.
    if (state.tunedId !== null) state.focusId = state.tunedId;
    state.sel = { live: true };
    state.nav = "grid";
  }
  render();
}

// ── Tuning and the player ────────────────────────────────────────────────────

function tune(id) {
  if (!state.channels.some((c) => c.id === id)) return;
  state.tunedId = id;
  settings.set(`channel.${state.profile}`, String(id));
  showOnAir();
}

/** Plays what the tuned channel airs now, or shows the break card until its next program. */
function showOnAir() {
  const channel = tuned();
  if (!channel) return;
  const now = nowSec();
  const { on, next, untilSec } = airing(channel.blocks, now);
  state.untilSec = untilSec;
  state.failed = false;
  if (on?.item) {
    play(on, now);
  } else {
    stopStream();
    if (next) {
      state.breakNext = next;
      renderBreak();
    } else {
      card({ title: "Off the air", text: "This channel has nothing more today." });
    }
  }
  renderScreen();
}

function play(block, now) {
  const same = state.playing && state.playing.ratingKey === block.ratingKey && state.playing.startSec === block.startSec;
  if (same) return;
  stopStream();
  state.playing = block;
  state.tuning = true;
  $("card").hidden = true;
  const offsetSec = seekFor(block, now);
  const session = randomId();
  state.session = session;
  settings.set("session", session);
  const url = streamUrl({ base: state.base, ratingKey: block.ratingKey, offsetSec, session, clientId: state.clientId });
  // The stream starts once the one before it has stopped, unless another tune came meanwhile.
  state.stopped.then(() => {
    if (state.session === session) startStream(url, offsetSec);
  });
}

function startStream(url, offsetSec) {
  // A browser lets a page start sound only after a key or a click. Until one comes the picture
  // plays without sound and a chip says so.
  const started = () =>
    video.play().catch(() => {
      video.muted = true;
      state.soundBlocked = true;
      renderScreen();
      return video.play().catch(() => {});
    });
  const Hls = globalThis.Hls;
  if (Hls?.isSupported()) {
    // The sign-in goes in a header on each request, so no address carries it.
    const hls = new Hls({
      maxBufferLength: 30,
      startPosition: offsetSec,
      xhrSetup: (xhr) => xhr.setRequestHeader("X-Plex-Token", state.token),
    });
    state.hls = hls;
    // One recovery of each kind per program, counted here: hls.js makes a new payload for
    // every error, so a flag on the payload never holds (upstream's web tuner, 2026-10-07).
    let networkRetried = false;
    let mediaRecovered = false;
    hls.on(Hls.Events.MANIFEST_PARSED, started);
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal || state.hls !== hls) return;
      if (data.response?.code === 401) return askSignIn("Plex no longer accepts the saved sign-in.");
      const manifest = String(data.details ?? "").startsWith("manifest");
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !manifest && !networkRetried) {
        networkRetried = true;
        hls.startLoad();
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovered) {
        mediaRecovered = true;
        hls.recoverMediaError();
      } else {
        streamFailed();
      }
    });
    hls.loadSource(url);
    hls.attachMedia(video);
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    // Safari plays HLS itself and sends no header of ours, so here the address carries the sign-in.
    video.src = `${url}&X-Plex-Token=${encodeURIComponent(state.token)}`;
    video.addEventListener(
      "loadedmetadata",
      () => {
        video.currentTime = offsetSec;
        started();
      },
      { once: true },
    );
  } else {
    stopStream();
    card({ title: "Standby", text: "This browser can't play the stream. Try a current Chrome, Edge, Firefox or Safari." });
  }
}

function streamFailed() {
  const channel = tuned();
  const next = channel ? airing(channel.blocks, nowSec()).next : null;
  stopStream();
  state.failed = true;
  card({ title: "Standby", text: "Plex could not play this program.", foot: next ? `${programName(next.item)} at ${clock(next.startSec)}` : "" });
  renderScreen();
}

/**
 * Ends the stream here and on the server, which otherwise keeps converting the file. As the page
 * closes, `keepNote` leaves the stream's id saved, so the next visit stops it again if this stop
 * never arrived.
 */
function stopStream(keepNote = false) {
  state.playing = null;
  state.breakNext = null;
  state.tuning = false;
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
  video.pause();
  video.removeAttribute("src");
  video.load();
  if (state.session && state.base) {
    const answered = fetch(stopUrl({ base: state.base, session: state.session }), { headers: { "X-Plex-Token": state.token }, keepalive: true }).then(
      () => {},
      () => {},
    );
    state.stopped = Promise.race([answered, new Promise((resolve) => setTimeout(resolve, 4000))]);
  }
  state.session = null;
  if (!keepNote) settings.remove("session");
}

/** The first key or click gives the page leave to play sound. */
function allowSound() {
  if (!state.soundBlocked) return;
  state.soundBlocked = false;
  video.muted = false;
  renderScreen();
}

// ── Settings and the profile switch ──────────────────────────────────────────

function menuRows() {
  if (state.menu?.kind === "profile") {
    return ["grownups", "kids"].map((profile) => ({
      label: profile === "kids" ? "KIDS" : "GROWN-UPS",
      value: profile === state.profile ? "ON NOW" : "",
      pick: () => {
        state.menu = null;
        setProfile(profile);
      },
    }));
  }
  return [
    {
      label: "THEME",
      value: THEME_NAMES[state.theme],
      pick: () => {
        state.theme = THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length];
        settings.set("theme", state.theme);
        applyLook();
      },
    },
    {
      label: "SCANLINES",
      value: state.scanlines ? "ON" : "OFF",
      pick: () => {
        state.scanlines = !state.scanlines;
        settings.set("scanlines", state.scanlines ? "on" : "off");
        applyLook();
      },
    },
    {
      label: "READ THE LIBRARY AGAIN",
      value: state.savedAt ? new Date(state.savedAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }).toUpperCase() : "",
      pick: () => {
        state.menu = null;
        stopStream();
        setFull(false);
        loadItems(true);
      },
    },
    {
      label: "SIGN OUT",
      value: "",
      pick: () => {
        state.menu = null;
        signOut();
      },
    },
  ];
}

function openMenu(kind) {
  state.menu = { kind, focus: kind === "profile" ? (state.profile === "kids" ? 1 : 0) : 0 };
  render();
}

function renderMenu() {
  $("menu").hidden = !state.menu;
  if (!state.menu) return;
  $("menuTitle").textContent = state.menu.kind === "profile" ? "Who is watching?" : "Settings";
  $("menuHint").textContent = state.menu.kind === "profile" ? "Kids lists the Kids channels, within the Kids rating limit." : KEYS_HINT;
  $("menuRows").replaceChildren(
    ...menuRows().map((row, i) => {
      const node = el("button", `mrow${i === state.menu.focus ? " focus" : ""}`);
      node.type = "button";
      node.dataset.index = String(i);
      node.append(el("span", "", row.label), el("span", "val", row.value));
      return node;
    }),
  );
}

function setProfile(profile) {
  if (profile !== state.profile) {
    state.profile = profile;
    settings.set("profile", profile);
    applyLook();
    stopStream();
    openGuide();
  }
  render();
}

// ── The remote ───────────────────────────────────────────────────────────────

const KEY_NAMES = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Enter: "OK", " ": "OK", Escape: "back", Backspace: "back", PageUp: "rewind", PageDown: "fastforward", p: "play", P: "play" };

function press(key) {
  if (!$("gate").hidden) {
    if (key === "OK" && !$("gateButton").hidden) $("gateButton").click();
    return;
  }
  if (state.menu) pressMenu(key);
  else if (key === "play") openMenu("profile");
  else if (state.full) pressFull(key);
  else if (state.nav !== "grid") pressNav(key);
  else pressGrid(key);
  render();
}

function pressMenu(key) {
  const rows = menuRows();
  if (key === "up") state.menu.focus = (state.menu.focus + rows.length - 1) % rows.length;
  else if (key === "down") state.menu.focus = (state.menu.focus + 1) % rows.length;
  else if (key === "OK") rows[state.menu.focus].pick();
  else if (key === "back" || key === "play") state.menu = null;
}

/** The top bar's items, reached by Up from the first row: SETTINGS in Grown-ups, and the profile. */
function pressNav(key) {
  const settingsShown = state.profile !== "kids";
  if (key === "left" && settingsShown) state.nav = "settings";
  else if (key === "right") state.nav = "pill";
  else if (key === "down" || key === "back") state.nav = "grid";
  else if (key === "OK") openMenu(state.nav === "pill" ? "profile" : "settings");
}

function pressGrid(key) {
  const channels = state.channels;
  const channel = focused();
  const now = nowSec();
  if (!channel) {
    if (key === "up" || key === "OK") state.nav = state.profile === "kids" ? "pill" : "settings";
    return;
  }
  const index = channels.indexOf(channel);
  if (key === "up" || key === "down") {
    const to = rowStep(index, channels.length, key);
    if (to >= 0) state.focusId = channels[to].id;
    else if (key === "up") state.nav = state.profile === "kids" ? "pill" : "settings";
  } else if (key === "rewind" || key === "fastforward") {
    const to = rowPage(index, channels.length, state.layout.rows, key);
    if (to >= 0) state.focusId = channels[to].id;
  } else if (key === "left" || key === "right") {
    const moved = moveSelection(channel.blocks, state.sel, now, key);
    if (moved && (moved.live || moved.timeSec < state.dayEndSec)) state.sel = moved;
  } else if (key === "OK") {
    pressOK();
  } else if (key === "back") {
    const action = guideBack({ focusId: state.focusId, tunedId: state.tunedId, live: state.sel.live, playing: tuned() !== null });
    if (action === "live") {
      state.focusId = state.tunedId;
      state.sel = { live: true };
    } else if (action === "full") {
      setFull(true);
    }
  }
}

/** OK tunes the focused channel, or goes to the picture when that channel already plays. */
function pressOK() {
  const channel = focused();
  if (!channel) return;
  if (state.tunedId !== channel.id) tune(channel.id);
  else setFull(true);
}

/** Full screen's remote: Left and Right change channel with the OSD, Up the strip, Down Now Playing. */
function pressFull(key) {
  if (state.strip !== null) {
    if (key === "left") state.strip = Math.max(0, state.strip - 1);
    else if (key === "right") state.strip = Math.min(state.channels.length - 1, state.strip + 1);
    else if (key === "OK") {
      const to = state.channels[state.strip];
      state.strip = null;
      if (to && to.id !== state.tunedId) tune(to.id);
      showOsd();
    } else if (key === "back" || key === "down") state.strip = null;
    renderStrip();
    return;
  }
  if (state.nowPlaying) {
    if (key === "back" || key === "down" || key === "up" || key === "OK") state.nowPlaying = false;
    return;
  }
  if (key === "left" || key === "right") {
    const to = channelStep(state.channels, state.tunedId, key === "left" ? -1 : 1);
    if (to) {
      tune(to.id);
      state.focusId = to.id;
      showOsd();
    }
  } else if (key === "up") {
    state.strip = Math.max(0, state.channels.findIndex((c) => c.id === state.tunedId));
    renderStrip();
  } else if (key === "down") {
    state.nowPlaying = true;
    renderNowPlaying();
  } else if (key === "OK") {
    // A channel that stopped trying tries again.
    if (state.failed) showOnAir();
    showOsd();
  } else if (key === "back") {
    setFull(false);
  }
}

document.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  allowSound();
  if (event.key === "f" || event.key === "F") {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
    return;
  }
  if (event.key === "m" || event.key === "M") {
    video.muted = !video.muted;
    return;
  }
  const key = KEY_NAMES[event.key];
  if (!key) return;
  event.preventDefault();
  press(key);
});

// A mouse or a finger: a block or a channel is selected by a press, and a second press is OK.
document.addEventListener("pointerdown", allowSound, true);

$("rows").addEventListener("click", (event) => {
  const block = event.target.closest(".block");
  const plate = event.target.closest(".plate");
  const id = Number((block ?? plate)?.dataset.channel);
  const channel = state.channels.find((c) => c.id === id);
  if (!channel) return;
  const now = nowSec();
  const before = `${state.focusId} ${selectedProgram(focused()?.blocks ?? [], state.sel, now)?.startSec}`;
  state.nav = "grid";
  state.focusId = id;
  if (block) {
    const chosen = channel.blocks.find((b) => b.kind === "program" && b.startSec === Number(block.dataset.start));
    state.sel = !chosen || onAir(chosen, now) || chosen.slotEndSec <= now ? { live: true } : { live: false, timeSec: chosen.startSec };
  } else {
    state.sel = { live: true };
  }
  const after = `${state.focusId} ${selectedProgram(channel.blocks, state.sel, now)?.startSec}`;
  if (before === after) pressOK();
  render();
});

let wheelAt = 0;
$("grid").addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    if (Date.now() - wheelAt < 110 || !$("gate").hidden || state.menu) return;
    wheelAt = Date.now();
    state.nav = "grid";
    press(event.deltaY > 0 ? "down" : "up");
  },
  { passive: false },
);

screen.addEventListener("click", (event) => {
  const key = event.target.closest("#touch button")?.dataset.key;
  const stripCard = event.target.closest(".scard");
  if (key) {
    state.touchUntil = Date.now() / 1000 + OSD_SEC;
    press(key);
  } else if (stripCard) {
    state.strip = Number(stripCard.dataset.index);
    press("OK");
  } else if (!state.full) {
    if (tuned()) setFull(true);
    else pressOK();
  } else if (state.strip !== null || state.nowPlaying) {
    press("back");
  } else {
    // A press on the picture flashes the OSD, as OK does, with the buttons a finger needs.
    state.touchUntil = Date.now() / 1000 + OSD_SEC;
    press("OK");
  }
});

// The chip's own press turns the sound on and nothing else: it does not also open the picture.
$("soundChip").addEventListener("click", (event) => event.stopPropagation());
$("navSettings").addEventListener("click", () => openMenu("settings"));
$("pill").addEventListener("click", () => openMenu("profile"));
$("menu").addEventListener("click", (event) => {
  const row = event.target.closest(".mrow");
  if (row) {
    state.menu.focus = Number(row.dataset.index);
    press("OK");
  } else if (event.target === $("menu")) {
    press("back");
  }
});

video.addEventListener("playing", () => {
  state.tuning = false;
  renderScreen();
});

// The file ended before its slot did: the break card holds until the next program.
video.addEventListener("ended", () => {
  const channel = tuned();
  if (!channel) return;
  const next = airing(channel.blocks, nowSec()).next;
  stopStream();
  if (next) {
    state.breakNext = next;
    renderBreak();
  } else {
    card({ title: "Off the air", text: "This channel has nothing more today." });
  }
  renderScreen();
});

// ── The clock ────────────────────────────────────────────────────────────────

function tick() {
  if (!$("gate").hidden || !state.items) return;
  const now = new Date();
  if (`${now.toDateString()} ${now.getHours()}` !== state.guideHour) {
    // A new hour changes what a channel off the slot packer may air, and a new day everything.
    refreshGuide();
    return;
  }
  const sec = nowSec();
  if (tuned() && state.untilSec !== null && sec >= state.untilSec) showOnAir();
  // A chosen program that has come on air, or ended, is followed as the program on air.
  const settled = settleSelection(state.sel, sec);
  const minute = `${now.getHours()}:${now.getMinutes()}`;
  if (settled !== state.sel || minute !== state.minute) {
    state.sel = settled;
    state.minute = minute;
    render();
  } else {
    renderScreen();
  }
}

window.addEventListener("resize", applyLayout);
window.addEventListener("pagehide", () => stopStream(true));
setInterval(tick, 1000);

async function start() {
  makeSnow();
  applyLook();
  applyLayout();
  try {
    const response = await fetch("./lineup.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`The page's lineup did not load (${response.status}).`);
    state.lineup = await response.json();
  } catch (error) {
    gate({ title: "The lineup is missing", text: error.message });
    return;
  }
  // The theme this browser chose in Settings, else the lineup's, else Cable Box, as the TV picks.
  const saved = settings.get("theme");
  state.theme = THEMES.includes(saved) ? saved : THEMES.includes(state.lineup.theme) ? state.lineup.theme : "cable-box";
  applyLook();
  // A lineup with a name of its own leads the tab's title; one named for the app adds nothing.
  const name = String(state.lineup.name ?? "").trim();
  document.title = name && name.toLowerCase() !== "basic cable" ? `${name} · Basic Cable` : "Basic Cable";
  if (state.token) await connect();
  else askSignIn();
}

start();
