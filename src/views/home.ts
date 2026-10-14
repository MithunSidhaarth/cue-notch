// The Home page: the widget page the island opens on (design/cue.html).
// A top bar (Tock is the island's own, the track, agent dots, the clock), the
// page tabs, and seven tiles that read the same State the other views do.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { State, type AgentTask } from "../core/state";
import type { IslandViewName } from "../core/layout";
import { Bridge } from "../core/bridge";
import { Focus, Todos, clock } from "../core/extras";
import { pauseFocus, startFocus } from "./extras";
import { togglePlay } from "./spotify";
import { Spotify, currentArtwork, formatTime, isAd, spotifyPosition } from "../core/spotify";
import { TockEngine, createMiniBot, pruneMiniBots } from "../avatar/tock";
import { BIG_DOWN, BIG_UP, Missed, formatRate } from "../core/moments";
import { buildSongExtras } from "./song";
import { N_, language, t, tl, tn } from "../i18n/i18n";
import type { ViewActions, ViewHost } from "./views";
import { agentTasks, buildAgentsPage, buildSettingsPage, buildFilesPage, buildMediaPage, buildPhonePage, type HomePage } from "./home-pages";

const NS = "http://www.w3.org/2000/svg";
/** Stroke icons the catalog (icons.ts) has no fill version of. */
export const LINE = {
  pin: "M9 4h6l-1 6 4 3H6l4-3zM12 13v7",
  moon: "M20 14A8 8 0 1 1 10 4a7 7 0 0 0 10 10z",
  lock: "M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM8 11V8a4 4 0 0 1 8 0v3",
  vol: "M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5",
  cam: "M5 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zM12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM8 7l2-3h4l2 3",
  mic: "M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3",
};
export const line = (d: string, size = 15) => svg(d, size, { stroke: 1.8 });

/** States that mean an agent is waiting on the user. */
const WAITING = new Set(["approval", "question"]);
// ponytail: English only for now; add these to extra.json with the Agents page.
const STATE_TEXT: Record<string, string> = {
  working: "working", thinking: "thinking", searching: "searching", approval: "",
  question: "", error: "error", finished: "done", ratelimit: "rate limit",
};

function bars(count: number, cls: string): HTMLElement {
  const el = h("span", { class: cls });
  for (let i = 0; i < count; i++) el.append(h("i"));
  return el;
}

function ring(): { el: SVGSVGElement; set(done: number): void } {
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("viewBox", "0 0 80 80");
  el.setAttribute("class", "hm-ring");
  const C = 2 * Math.PI * 33;
  const mk = (cls: string) => {
    const c = document.createElementNS(NS, "circle");
    for (const [k, v] of [["cx", "40"], ["cy", "40"], ["r", "33"], ["fill", "none"], ["stroke-width", "7"], ["class", cls]]) c.setAttribute(k, v);
    el.append(c);
    return c;
  };
  mk("hm-ring-track");
  const arc = mk("hm-ring-arc");
  arc.setAttribute("stroke-dasharray", String(C));
  arc.setAttribute("transform", "rotate(-90 40 40)");
  return { el, set: (done) => arc.setAttribute("stroke-dashoffset", String(C * (1 - Math.max(0, Math.min(1, done))))) };
}

/**
 * The bar across the top of the notch, closed or open on the widget page: the
 * track, a level meter, one dot per coding session, the clock. Tock is the
 * island's own, drawn to its left.
 */
let split = false;
/** Two sessions are at work: the bar is showing a Tock for each (island.ts hides its own). */
export function barIsSplit(): boolean {
  return split;
}

/** Eye colours for the two halves of a split capsule. */
const SPLIT_EYES = ["#16120a", "#0b3a8f"];

export function buildCueBar(): { el: HTMLElement; sync(): void } {
  const art = h("i", { class: "hm-art" });
  const title = h("b", { class: "hm-ell" });
  const artist = h("span", { class: "hm-ell" });
  const eq = bars(4, "hm-eq");
  // A big transfer under way: its rate, for as long as it runs.
  const net = h("span", { class: "hm-net" });
  // Pops the user did not open the notch for.
  const missed = h("span", { class: "hm-missed" });
  const dots = h("span", { class: "hm-dots" });
  const time = h("span", { class: "hm-clock" });
  // Two sessions at once: one half each, in place of the track.
  const halves = h("div", { class: "hm-halves" });
  const live = h("div", { class: "hm-live" }, art, title, artist);
  const el = h("div", { class: "hm-bar" }, live, halves, eq, net, missed, dots, time);
  let dotsKey = "-";
  let missedKey = "-";
  let halvesKey = "-";
  const tickClock = () => {
    const d = new Date();
    const hhmm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
    if (time.textContent !== hhmm) time.textContent = hhmm;
  };
  tickClock();
  window.setInterval(tickClock, 5000);

  // The network: asked every two seconds, and only while the notch can be seen.
  let lastTotals: { down: number; up: number; at: number } | null = null;
  window.setInterval(() => {
    if (State.mode === "hidden") {
      lastTotals = null;
      return;
    }
    void Bridge.netTotals().then((now) => {
      if (!now) return;
      const at = performance.now();
      const before = lastTotals;
      lastTotals = { ...now, at };
      if (!before) return;
      const secs = (at - before.at) / 1000;
      const down = (now.down - before.down) / secs;
      const up = (now.up - before.up) / secs;
      const text = down >= BIG_DOWN ? `↓ ${formatRate(down)}` : up >= BIG_UP ? `↑ ${formatRate(up)}` : "";
      if (net.textContent !== text) net.textContent = text;
    });
  }, 2000);

  return {
    el,
    sync() {
      const s = Spotify.state;
      const track = s.track;
      const cover = currentArtwork();
      art.style.backgroundImage = cover ? `url("${cover}")` : "";
      art.style.display = track ? "" : "none";
      title.textContent = track?.title ?? "";
      artist.textContent = track?.artist ?? "";
      el.classList.toggle("playing", !!track && s.playing);

      const list = agentTasks();
      const key = list.map((a) => a.state).join("|");
      if (key !== dotsKey) {
        dotsKey = key;
        clear(dots);
        for (const a of list.slice(0, 5)) dots.append(h("i", WAITING.has(a.state) ? { class: "wait" } : a.state === "idle" ? {} : { class: "run" }));
      }

      // Opened on the widget page: whatever was missed has now been seen.
      if (State.mode === "expanded" && State.view === "home" && Missed.items.length) Missed.clear();
      const mKey = Missed.items.map((m) => `${m.at}${m.failed}`).join("|");
      if (mKey !== missedKey) {
        missedKey = mKey;
        clear(missed);
        for (const m of Missed.items) missed.append(h("i", { class: m.failed ? "bad" : "", title: m.text }));
      }

      // Two sessions at work and the notch closed: the capsule splits in two.
      const busy = list.filter((a) => a.state !== "idle" && a.state !== "finished").slice(0, 2);
      split = State.mode === "compact" && busy.length === 2;
      el.classList.toggle("split", split);
      const hKey = split ? busy.map((a) => `${a.id}:${a.state}:${a.steps[a.steps.length - 1] ?? ""}`).join("|") : "";
      if (hKey !== halvesKey) {
        const ids = (k: string) => k.split("|").map((p) => p.split(":")[0]).join("|");
        const sameBots = split && ids(hKey) === ids(halvesKey);
        halvesKey = hKey;
        if (!split) {
          clear(halves);
          pruneMiniBots();
        } else if (sameBots) {
          // Only the lines changed: the two Tocks stay, their text is rewritten.
          busy.forEach((a, i) => {
            const line = halves.children[i]?.querySelector<HTMLElement>(".hm-half-line");
            if (line) line.textContent = a.steps[a.steps.length - 1] ?? a.name;
          });
        } else {
          clear(halves);
          busy.forEach((a, i) => {
            halves.append(h(
              "div",
              { class: "hm-half", title: a.name },
              createMiniBot(a, 15, undefined, SPLIT_EYES[i]),
              h("span", { class: "hm-half-line hm-ell", text: a.steps[a.steps.length - 1] ?? a.name }),
            ));
          });
          pruneMiniBots();
        }
      }
    },
  };
}

export function buildHome(actions: ViewActions): ViewHost {
  const go = (v: IslandViewName) => { actions.blip(); actions.setView(v); };
  const agents = agentTasks;

  // ── Tabs ──────────────────────────────────────────────────────────────────
  const TABS = ["home", "media", "files", "phone", "agents"] as const;
  /** The tabs, then Settings, which the gear opens. */
  const PAGES = [...TABS, "settings"] as const;
  type Page = (typeof PAGES)[number];
  let page: Page = "home";
  const tabs = new Map<Page, HTMLElement>();
  const tab = (id: Page, label: string) => {
    const b = h("button", { class: "hm-tab", text: tl(label), onclick: () => { actions.blip(); show(id); } });
    tabs.set(id, b);
    return b;
  };
  const pinBtn = h("button", { class: "hm-icb", title: tl("Keep open"), onclick: () => { State.isPinned = !State.isPinned; actions.blip(); State.notify(); } }, line(LINE.pin));
  const gearBtn = h("button", { class: "hm-icb", title: tl("Settings"), onclick: () => { actions.blip(); show(page === "settings" ? "home" : "settings"); } }, svg(ICONS.gear, 15));
  const nav = h(
    "div",
    { class: "hm-nav" },
    tab("home", N_("Home")),
    tab("media", N_("Media")),
    tab("files", N_("Files")),
    tab("phone", N_("Phone")),
    tab("agents", N_("Agents")),
    h("span", { class: "hm-sp" }),
    pinBtn,
    gearBtn,
  );

  // ── Now playing ───────────────────────────────────────────────────────────
  const cover = h("div", { class: "hm-cover" });
  const viz = bars(24, "hm-viz");
  cover.append(viz);
  const trk = h("div", { class: "hm-trk hm-ell" });
  const trkSub = h("div", { class: "hm-sub hm-ell" });
  const prog = h("i");
  const pos = h("span");
  const dur = h("span");
  const ppBtn = h("button", { class: "hm-pp", title: tl("Play"), onclick: () => (Spotify.state.running ? togglePlay() : void Bridge.spotifyOpen()) });
  const song = buildSongExtras(() => actions.blip());
  cover.append(song.buttons);
  const media = h(
    "section",
    { class: "hm-tile hm-media" },
    cover,
    h(
      "div",
      {},
      trk,
      trkSub,
      song.line,
      h("div", { class: "hm-prog" }, prog),
      h("div", { class: "hm-times" }, pos, dur),
      h(
        "div",
        { class: "hm-ctrl" },
        h("button", { title: tl("Previous"), onclick: () => void Bridge.spotifyControl("previous") }, svg(ICONS.backward, 16)),
        ppBtn,
        h("button", { title: tl("Next"), onclick: () => void Bridge.spotifyControl("next") }, svg(ICONS.forward, 16)),
      ),
    ),
  );

  // ── Cue ───────────────────────────────────────────────────────────────────
  const face = new TockEngine();
  const faceCanvas = h("canvas", { class: "hm-bigface" });
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  faceCanvas.width = Math.round(96 * dpr);
  faceCanvas.height = Math.round(72 * dpr);
  const cueQ = h("div", { class: "hm-q hm-ell" });
  const cueA = h("div", { class: "hm-a" });
  const talkBtn = h("button", { class: "hm-btn acc", onclick: () => {
    actions.blip();
    if (State.settings.plus?.voice) void Bridge.voiceListenNow();
    else actions.setView("prompt");
  } });
  const cueHint = h("span", { class: "hm-r" });
  const cue = h(
    "section",
    { class: "hm-tile hm-cue" },
    h("div", { class: "hm-th" }, "Cue", cueHint),
    h("div", { class: "hm-tb" }, faceCanvas, h("div", { class: "hm-txt" }, cueQ, cueA, h("div", { class: "hm-row" }, h("span", { class: "hm-sp" }), talkBtn))),
  );

  // ── Today ─────────────────────────────────────────────────────────────────
  const bigClock = h("div", { class: "hm-big" });
  const date = h("div", { class: "hm-sub" });
  const evTitle = h("b");
  const evWhen = h("span", { class: "hm-sub" });
  const ev = h("div", { class: "hm-ev" }, evTitle, evWhen);
  const today = h("section", { class: "hm-tile hm-today" }, h("div", { class: "hm-th", text: tl("Today") }), h("div", { class: "hm-tb" }, bigClock, date, ev));

  // ── Focus ─────────────────────────────────────────────────────────────────
  const focusRing = ring();
  const focusTime = h("span", { class: "hm-ft" });
  const focusSub = h("span", { class: "hm-sub" });
  const focusBtn = h("button", { class: "hm-btn", onclick: () => { actions.blip(); if (Focus.active) pauseFocus(); else startFocus(Focus.minutes); } });
  const focusMin = h("span", { class: "hm-r" });
  const focus = h(
    "section",
    { class: "hm-tile hm-focus" },
    h("div", { class: "hm-th", onclick: () => go("focus") }, h("span", { text: tl("Focus") }), focusMin),
    h("div", { class: "hm-tb" }, focusRing.el, h("div", { class: "hm-col" }, focusTime, focusSub, focusBtn)),
  );

  // ── Agents ────────────────────────────────────────────────────────────────
  const agentsNeed = h("span", { class: "hm-r" });
  const agentRows = h("div", { class: "hm-rows" });
  const steps = h("div", { class: "hm-steps" });
  const apprText = h("span", { class: "hm-ell" });
  const appr = h(
    "div",
    { class: "hm-appr" },
    apprText,
    h("button", { class: "hm-btn acc", text: tl("Allow"), onclick: () => actions.decide("allow") }),
    h("button", { class: "hm-btn", text: tl("Deny"), onclick: () => actions.decide("deny") }),
  );
  const answerBtn = h("button", { class: "hm-btn acc", text: tl("Answer"), onclick: () => go("question") });
  const ask = h("div", { class: "hm-appr" }, h("span", { class: "hm-ell" }), answerBtn);
  const agentsTile = h(
    "section",
    { class: "hm-tile hm-agents" },
    h("div", { class: "hm-th", onclick: () => { actions.blip(); show("agents"); } }, h("span", { text: tl("Agents") }), agentsNeed),
    h("div", { class: "hm-tb" }, agentRows, steps, appr, ask),
  );
  let agentsKey = "-";
  let stepsShown = "-";

  // ── To-do ─────────────────────────────────────────────────────────────────
  const todoLeft = h("span", { class: "hm-r" });
  const todoRows = h("div", { class: "hm-rows" });
  const todo = h(
    "section",
    { class: "hm-tile hm-todo" },
    h("div", { class: "hm-th", onclick: () => go("todo") }, h("span", { text: tl("To-do") }), todoLeft),
    h("div", { class: "hm-tb" }, todoRows),
  );
  let todoKey = "";

  // ── System ────────────────────────────────────────────────────────────────
  const batt = h("span", { class: "hm-r" });
  const vol = h("input", { class: "hm-range", type: "range", min: "0", max: "100", title: tl("Volume") });
  const volNum = h("span", { class: "hm-num" });
  // One call in flight at a time: a drag never queues up behind itself.
  let volBusy = false;
  let volNext: number | null = null;
  const sendVolume = (v: number) => {
    if (volBusy) { volNext = v; return; }
    volBusy = true;
    void Bridge.setSystemVolume(v).finally(() => {
      volBusy = false;
      const next = volNext;
      volNext = null;
      if (next != null) sendVolume(next);
    });
  };
  vol.addEventListener("input", () => {
    volNum.textContent = vol.value;
    vol.style.setProperty("--v", `${vol.value}%`);
    sendVolume(Number(vol.value) / 100);
  });
  const bri = h("input", { class: "hm-range", type: "range", min: "0", max: "100", title: tl("Brightness") });
  const briNum = h("span", { class: "hm-num" });
  const briRow = h("div", { class: "hm-s" }, line(LINE.sun, 14), bri, briNum);
  bri.addEventListener("input", () => {
    briNum.textContent = bri.value;
    bri.style.setProperty("--v", `${bri.value}%`);
  });
  // One WMI call when the drag ends, not one a pixel.
  bri.addEventListener("change", () => void Bridge.setBrightness(Number(bri.value)));
  const battIcon = h("span", { class: "hm-batt" }, h("i"));
  const battText = h("span");
  batt.append(battIcon, battText);
  const moonBtn = h("button", { title: tl("Focus"), onclick: () => { actions.blip(); if (Focus.active) pauseFocus(); else startFocus(Focus.minutes); } }, line(LINE.moon));
  const sys = h(
    "section",
    { class: "hm-tile hm-sys" },
    h("div", { class: "hm-th" }, h("span", { text: tl("System") }), batt),
    h(
      "div",
      { class: "hm-tb" },
      h("div", { class: "hm-s" }, line(LINE.vol, 14), vol, volNum),
      briRow,
      h(
        "div",
        { class: "hm-qa" },
        moonBtn,
        h("button", { title: tl("Screenshot"), onclick: () => { actions.collapse(); void Bridge.screenSnip(); } }, line(LINE.cam)),
        h("button", { title: tl("Lock the PC"), onclick: () => void Bridge.lockScreen().catch(() => {}) }, line(LINE.lock)),
        h("button", { title: tl("Talk"), onclick: () => { actions.blip(); void Bridge.voiceListenNow(); } }, line(LINE.mic)),
      ),
    ),
  );
  let statusAt = 0;
  function readSystem(force = false) {
    const now = performance.now();
    if (!force && now - statusAt < 2000) return;
    statusAt = now;
    void Bridge.systemStatus().then((s) => {
      if (!s) return;
      if (s.volume != null && document.activeElement !== vol) {
        const v = Math.round(s.volume * 100);
        vol.value = String(v);
        volNum.textContent = String(v);
        vol.style.setProperty("--v", `${v}%`);
      }
      // No slider where Windows can't dim the display (a desktop monitor).
      briRow.style.display = s.brightness == null ? "none" : "";
      if (s.brightness != null && document.activeElement !== bri) {
        bri.value = String(s.brightness);
        briNum.textContent = String(s.brightness);
        bri.style.setProperty("--v", `${s.brightness}%`);
      }
      batt.style.display = s.battery == null ? "none" : "";
      battText.textContent = `${s.battery ?? ""}%`;
      (battIcon.firstElementChild as HTMLElement).style.width = `${s.battery ?? 0}%`;
      battIcon.classList.toggle("ac", !!s.charging);
    });
  }

  const pages: Record<Page, HomePage> = {
    home: { el: h("div", { class: "hm-pg hm-grid" }, media, cue, today, focus, agentsTile, todo, sys), sync() {} },
    media: buildMediaPage(actions),
    files: buildFilesPage(actions),
    phone: buildPhonePage(actions),
    agents: buildAgentsPage(actions),
    settings: buildSettingsPage(),
  };
  const pagesEl = h("div", { class: "hm-pages" }, ...PAGES.map((p) => pages[p].el));
  /** `resize`: false when the island is closing anyway and must not be reopened. */
  function show(next: Page, resize = true) {
    const wasTall = page === "settings";
    page = next;
    for (const p of PAGES) {
      pages[p].el.classList.toggle("on", p === page);
      tabs.get(p as (typeof TABS)[number])?.classList.toggle("on", p === page);
    }
    // Settings take the tall panel and the keyboard (the island never has it otherwise).
    const tall = page === "settings";
    gearBtn.classList.toggle("on", tall);
    if (tall !== wasTall) {
      el.classList.toggle("tall", tall);
      State.homeTall = tall;
      void Bridge.focusWindow(tall);
      if (resize) actions.setView("home");
    }
    pages[page].shown?.();
    pages[page].sync();
  }

  const el = h("div", { class: "view hm" }, h("div", { class: "hm-frame" }, nav, pagesEl));
  show("home");
  readSystem(true);
  // Ctrl+← / Ctrl+→ walk the pages while the notch has the keyboard.
  window.addEventListener("keydown", (e) => {
    if (State.view !== "home" || State.mode !== "expanded" || !e.ctrlKey || e.altKey) return;
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step || page === "settings") return;
    show(TABS[(TABS.indexOf(page) + step + TABS.length) % TABS.length]);
  });

  /** What each session last showed, to know a new line from one already there. */
  const seen = new Map<string, string>();
  function syncAgents() {
    const list = agents();
    const waiting = list.filter((x) => WAITING.has(x.state)).length;
    agentsNeed.textContent = waiting ? tn("{count} waiting", "{count} waiting", waiting, { count: waiting }) : "";

    // The session in front: one that needs you, else one at work, else the first.
    const front = list.find((x) => WAITING.has(x.state)) ?? list.find((x) => x.state !== "idle" && x.state !== "finished") ?? list[0];
    const key = list.map((x: AgentTask) => `${x.id}:${x.name}:${x.state}`).join("|") + "#" + (front?.id ?? "");
    if (key !== agentsKey) {
      agentsKey = key;
      clear(agentRows);
      if (!list.length) agentRows.append(h("div", { class: "hm-sub", text: tl("No agents running") }));
      for (const a of list.slice(0, 2)) {
        agentRows.append(h(
          "div",
          { class: WAITING.has(a.state) ? "hm-a-row w" : "hm-a-row", onclick: () => { actions.blip(); show("agents"); } },
          h("i", a.state === "error" ? { class: "bad" } : a.state === "idle" ? { class: "off" } : {}),
          h("span", { class: "hm-ell", text: a.name }),
          h("span", { class: "hm-m", text: t(STATE_TEXT[a.state] ?? "") }),
        ));
      }
    }

    // Its build, live: the last steps, then what it said when it finished. A
    // line that was not there a moment ago pops in.
    const req = State.pendingApproval;
    const room = req ? 1 : 3;
    const lines: { text: string; kind: string }[] = [];
    if (front) {
      for (const s of front.steps.slice(-room)) lines.push({ text: s, kind: "" });
      if (front.state === "finished") lines.push({ text: front.finalLine || t("Finished"), kind: "done" });
      else if (front.state === "error") lines.push({ text: t("Something went wrong"), kind: "bad" });
    }
    const shown = lines.slice(-room);
    const stepsKey = (front?.id ?? "") + "|" + shown.map((l) => l.kind + l.text).join("\n");
    if (stepsKey !== stepsShown) {
      const before = seen.get(front?.id ?? "") ?? "";
      const last = shown[shown.length - 1];
      const fresh = !!last && last.kind + last.text !== before;
      stepsShown = stepsKey;
      clear(steps);
      shown.forEach((l, i) => {
        const newest = i === shown.length - 1;
        steps.append(h(
          "div",
          { class: `hm-step ${l.kind}${newest ? " now" : ""}${newest && fresh ? " pop" : ""}` },
          h("span", { class: "hm-step-mark", text: l.kind === "done" ? "✓" : l.kind === "bad" ? "!" : newest ? "›" : "·" }),
          h("span", { class: "hm-ell", text: l.text }),
        ));
      });
      if (front && last) {
        seen.set(front.id, last.kind + last.text);
        // Tock is pleased when a build finishes.
        if (fresh && last.kind === "done") face.triggerEmote("happy");
      }
    }

    appr.style.display = req && !req.questions ? "" : "none";
    ask.style.display = req?.questions ? "" : "none";
    if (req) {
      apprText.textContent = req.command || req.tool;
      (ask.firstElementChild as HTMLElement).textContent = req.tool;
    }
  }

  function syncTodos() {
    const list = Todos.sorted.slice(0, 4);
    todoLeft.textContent = Todos.open ? tn("{count} left", "{count} left", Todos.open, { count: Todos.open }) : "";
    const key = list.map((x) => `${x.id}:${x.done}:${x.text}`).join("|") + language();
    if (key === todoKey) return;
    todoKey = key;
    clear(todoRows);
    if (!list.length) todoRows.append(h("div", { class: "hm-sub", text: tl("Nothing to do") }));
    for (const item of list) {
      const box = h("input", { type: "checkbox" });
      box.checked = item.done;
      box.addEventListener("change", () => Todos.toggle(item.id));
      todoRows.append(h("label", item.done ? { class: "done" } : {}, box, h("span", { class: "hm-ell", text: item.text })));
    }
  }

  function syncMedia() {
    const s = Spotify.state;
    const track = s.track;
    const art = currentArtwork();
    const image = art ? `url("${art}")` : "";
    cover.style.backgroundImage = image;
    trk.textContent = track ? track.title : t("Nothing playing");
    trkSub.textContent = track ? [track.artist, s.app].filter(Boolean).join(" · ") : "";
    dur.textContent = track && !isAd(track) ? formatTime(track.duration) : "";
    clear(ppBtn);
    ppBtn.append(svg(s.playing ? ICONS.pause : ICONS.play, 16));
    el.classList.toggle("playing", !!track && s.playing);
    song.sync();
  }

  function syncCue() {
    const voice = !!State.settings.plus?.voice;
    talkBtn.textContent = voice ? t("Talk") : t("Ask");
    cueHint.textContent = voice ? "" : "Ctrl+Alt+Space";
    const said = [...State.chatHistory].reverse();
    const answer = said.find((m) => m.role !== "user");
    const question = said.find((m) => m.role === "user");
    cueQ.textContent = question ? `“${question.content}”` : "";
    cueA.textContent = answer?.content || t("Ask me anything");
    face.setState(State.effectiveState);
  }

  let lastTick = 0;
  let shownRequest: string | null = null;
  // Everything that reads a clock: four times a second, and only on screen.
  window.setInterval(() => {
    if (State.mode !== "expanded" || State.view !== "home") {
      // Closed with Settings open: next time it opens on Home, at the usual size.
      if (page === "settings") show("home", false);
      return;
    }
    slow();
    if (page !== "home") pages[page].tick?.(performance.now());
  }, 250);
  let faceDrawn = false;
  let clockText = "";
  /** Writes only what changed: an identical text still costs a layout. */
  const put = (node: HTMLElement, text: string) => { if (node.textContent !== text) node.textContent = text; };
  function slow() {
    const d = new Date();
    const hhmm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
    if (clockText !== hhmm) {
      clockText = hhmm;
      bigClock.textContent = hhmm;
      date.textContent = d.toLocaleDateString(language() || undefined, { weekday: "long", day: "numeric", month: "long" });
    }
    // The next reminder, if there is one.
    const next = Todos.items.filter((x) => !x.done && x.due != null).sort((a, b) => a.due! - b.due!)[0];
    ev.style.display = next ? "" : "none";
    if (next) {
      evTitle.textContent = next.text;
      evWhen.textContent = new Date(next.due!).toLocaleTimeString(language() || undefined, { hour: "numeric", minute: "2-digit" });
    }

    const s = Spotify.state;
    if (s.track && !isAd(s.track)) {
      const p = spotifyPosition(s, Date.now());
      put(pos, formatTime(p));
      prog.style.width = `${Math.min(100, (p / Math.max(1, s.track.duration)) * 100)}%`;
    } else {
      pos.textContent = "";
      prog.style.width = "0";
    }

    song.tick();

    const left = Focus.left();
    put(focusTime, clock(Focus.active ? left : Focus.minutes * 60_000));
    focusRing.set(Focus.active ? 1 - left / (Focus.minutes * 60_000) : 0);
    put(focusSub, Focus.running ? t("Alerts held") : "");
    put(focusBtn, Focus.running ? t("Pause") : Focus.active ? t("Resume") : t("Start"));
    put(focusMin, `${Focus.minutes} min`);
    moonBtn.classList.toggle("on", Focus.running);
    readSystem();
  }
  return {
    el,
    sync() {
      // A request that just arrived opens on the page that shows it whole.
      const waitingId = State.pendingApproval && !State.pendingApproval.questions ? State.pendingApproval.requestId : null;
      if (waitingId && waitingId !== shownRequest) show("agents");
      shownRequest = waitingId;
      pinBtn.classList.toggle("on", State.isPinned);
      syncMedia();
      syncCue();
      syncAgents();
      syncTodos();
      slow();
      if (page !== "home") pages[page].sync();
    },
    tick(now) {
      // Back on screen after a while: the sliders are fresh at once.
      if (now - lastTick > 500) readSystem(true);
      const dt = Math.min(0.05, lastTick ? (now - lastTick) / 1000 : 0.016);
      lastTick = now;
      // Tock in the Cue tile: drawn only while it moves.
      if (page === "home") {
        // Its eyes follow the pointer, as the bar's Tock does.
        const r = faceCanvas.getBoundingClientRect();
        face.lookX = Math.tanh((State.mouse.x - (r.left + r.width / 2)) / 260);
        face.lookY = -Math.tanh((State.mouse.y - (r.top + r.height / 2)) / 200);
        face.update(dt);
        if (face.busy || !faceDrawn) {
          faceDrawn = true;
          const ctx = faceCanvas.getContext("2d");
          if (ctx) {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, 96, 72);
            face.draw(ctx, 96, 72);
          }
        }
      }
      // Frames only while Tock moves; the clocks have their own timer below.
      return page === "home" && face.busy;
    },
  };
}
