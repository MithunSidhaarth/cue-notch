// The widget page's other tabs (design/cue.html): Media, Files, Phone, Agents.
// Each is a grid of tiles over the same State the Home tiles read.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { State, type AgentTask } from "../core/state";
import { pillDefinition } from "../core/pills";
import { Bridge, onEvent, type DroppedFile } from "../core/bridge";
import { Inbox } from "../core/extras";
import { togglePlay } from "./spotify";
import { Spotify, currentArtwork, isAd, playerName, spotifyPosition } from "../core/spotify";
import { Live } from "../island/live";
import { N_, t, tl, tn } from "../i18n/i18n";
import { PhoneInfo, Receipts, Saved, formatSpan, songLink } from "../core/moments";
import { buildSongExtras } from "./song";
import type { ViewActions } from "./views";

export interface HomePage {
  el: HTMLElement;
  sync(): void;
  /** The tab was just opened: time to ask Rust for what it shows. */
  shown?(): void;
  tick?(nowMs: number): void;
}

const tile = (cls: string, title: string, right: HTMLElement | string | null, ...body: (HTMLElement | string)[]) =>
  h(
    "section",
    { class: `hm-tile ${cls}` },
    h("div", { class: "hm-th" }, h("span", { text: tl(title) }), right == null ? "" : typeof right === "string" ? h("span", { class: "hm-r", text: tl(right) }) : right),
    h("div", { class: "hm-tb" }, ...body),
  );

/**
 * The coding sessions: pills of a workspace (VS Code, Cursor…) or an agent
 * that has a session or is doing something. Services and chat providers are not.
 */
export function agentTasks(): AgentTask[] {
  return State.tasks.filter((x) => {
    const category = pillDefinition(x.id)?.category;
    const coding = category ? category === "workspace" || category === "agent" : !x.isIntegration;
    return coding && (!!x.sessionId || x.state !== "idle");
  });
}

/** "4m", "2h", "now": how long ago, short. */
function ago(at: number, now = Date.now()): string {
  const m = Math.floor((now - at) / 60_000);
  return m < 1 ? t("now") : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

// ── Media ────────────────────────────────────────────────────────────────────

export function buildMediaPage(actions: ViewActions): HomePage {
  const app = h("span", { class: "hm-r" });
  const cover = h("div", { class: "hm-cover" });
  const trk = h("div", { class: "hm-trk hm-ell" });
  const sub = h("div", { class: "hm-sub hm-ell" });
  const prog = h("i");
  const pp = h("button", { class: "hm-pp", title: tl("Play"), onclick: () => (Spotify.state.running ? togglePlay() : void Bridge.spotifyOpen()) });
  const song = buildSongExtras(() => actions.blip());
  cover.append(song.buttons);
  const player = h(
    "section",
    { class: "hm-tile hm-player" },
    h("div", { class: "hm-th" }, h("span", { text: tl("Now playing") }), app),
    cover,
    h(
      "div",
      {},
      trk,
      sub,
      song.line,
      h("div", { class: "hm-prog" }, prog),
      h(
        "div",
        { class: "hm-ctrl" },
        h("button", { title: tl("Previous"), onclick: () => void Bridge.spotifyControl("previous") }, svg(ICONS.backward, 16)),
        pp,
        h("button", { title: tl("Next"), onclick: () => void Bridge.spotifyControl("next") }, svg(ICONS.forward, 16)),
      ),
    ),
  );

  // Every app playing or paused on this PC; a click shows it in the player.
  const list = h("div", { class: "hm-rows" });
  const sessions = tile("hm-auto", N_("Playing on this PC"), N_("click to switch"), list);
  let listKey = "-";
  let asked = 0;
  function loadSessions() {
    asked = performance.now();
    void Bridge.mediaSessions().then((all) => {
      const items = all ?? [];
      const key = items.map((x) => `${x.id}|${x.title}|${x.playing}|${x.shown}`).join("\n");
      if (key === listKey) return;
      listKey = key;
      clear(list);
      if (!items.length) list.append(h("div", { class: "hm-sub", text: tl("Nothing playing") }));
      for (const x of items) {
        list.append(h(
          "div",
          { class: x.shown ? "hm-sess on" : "hm-sess", onclick: () => { actions.blip(); void Bridge.mediaSelect(x.id).then(loadSessions); } },
          h("span", { class: "hm-ic" }),
          h("div", {}, h("b", { class: "hm-ell", text: x.title || x.app }), h("div", { class: "hm-sub hm-ell", text: [x.artist, x.app].filter(Boolean).join(" · ") })),
          h("i", { class: x.playing ? "hm-on-air" : "" }),
        ));
      }
    });
  }
  // The songs saved with the heart; before there are any, what to say to Cue.
  const hint = h("div", { class: "hm-lyr", text: tl("Say “play something calm” or “skip this song” without touching anything.") });
  const savedList = h("div", { class: "hm-rows hm-saved" });
  const askTitle = h("span");
  const ask = h("section", { class: "hm-tile" }, h("div", { class: "hm-th" }, askTitle), h("div", { class: "hm-tb" }, hint, savedList));
  let savedKey = "-";
  function syncSaved() {
    const key = Saved.items.map((x) => x.title + x.artist).join("|") + State.settings.language;
    if (key === savedKey) return;
    savedKey = key;
    askTitle.textContent = Saved.items.length ? t("Saved songs") : t("Ask Cue");
    hint.style.display = Saved.items.length ? "none" : "";
    clear(savedList);
    for (const x of Saved.items.slice(0, 30)) {
      savedList.append(h(
        "div",
        { class: "hm-msg", title: tl("Open in its player"), onclick: () => void Bridge.openUrl(songLink(x)) },
        h("span", { class: "hm-ap hm-ic" }),
        h("div", {}, h("b", { class: "hm-ell", text: x.title }), h("span", { class: "hm-sub hm-ell", text: [x.artist, x.app].filter(Boolean).join(" · ") })),
        h("button", { class: "hm-btn", text: tl("Remove"), onclick: (e: Event) => { e.stopPropagation(); Saved.toggle(x); State.notify(); } }),
      ));
    }
  }

  return {
    el: h("div", { class: "hm-pg hm-media-pg" }, player, h("div", { class: "hm-right" }, sessions, ask)),
    shown: loadSessions,
    sync() {
      const s = Spotify.state;
      const track = s.track;
      const art = currentArtwork();
      const image = art ? `url("${art}")` : "";
      cover.style.backgroundImage = image;
      app.textContent = track ? playerName(s) : "";
      trk.textContent = track ? track.title : t("Nothing playing");
      sub.textContent = track ? [track.artist, track.album].filter(Boolean).join(" · ") : "";
      clear(pp);
      pp.append(svg(s.playing ? ICONS.pause : ICONS.play, 16));
      song.sync();
      syncSaved();
    },
    tick() {
      song.tick();
      const s = Spotify.state;
      const live = s.track && !isAd(s.track);
      const p = live ? spotifyPosition(s, Date.now()) : 0;
      prog.style.width = live ? `${Math.min(100, (p / Math.max(1, s.track!.duration)) * 100)}%` : "0";
      // The list of players is asked for again every two seconds while the page is up.
      if (performance.now() - asked > 2000) loadSessions();
    },
  };
}

// ── Files ────────────────────────────────────────────────────────────────────

export function buildFilesPage(actions: ViewActions): HomePage {
  const drop = h(
    "div",
    { class: "hm-drop" },
    h("span", { text: tl("Drop files here to keep them handy") }),
    h("span", { class: "hm-sub", text: tl("Originals are never moved") }),
  );
  const shelf = h("div", { class: "hm-shelf" });
  const shelfTile = tile("", N_("Shelf"), null, drop, shelf);

  const search = h("input", { class: "hm-search", placeholder: tl("Search clipboard") });
  const list = h("div", { class: "hm-cliplist" });
  const clipTile = tile("hm-clip", N_("Clipboard history"), null, search, list);
  let clips: { id: number; text: string; at: number }[] = [];
  let files: DroppedFile[] = [];

  /** URL, CODE or TEXT: what a copied text looks like. */
  const kind = (text: string) => (/^https?:\/\//i.test(text) ? "URL" : /[{};]|=>|^\s*(const|let|fn|def|import)\b/m.test(text) ? "CODE" : "TEXT");

  function renderClips() {
    const q = search.value.trim().toLowerCase();
    clear(list);
    const shown = clips.filter((c) => !q || c.text.toLowerCase().includes(q)).slice(0, 30);
    if (!shown.length) {
      list.append(h("div", { class: "hm-sub", text: State.settings.plus?.clipboardHistory === false ? tl("Clipboard history is off in Settings.") : tl("Nothing copied yet") }));
    }
    for (const c of shown) {
      list.append(h(
        "div",
        { class: "hm-c", title: tl("Copy again"), onclick: () => { actions.blip(); void Bridge.clipboardCopy(c.text); } },
        h("span", { class: "hm-k", text: kind(c.text) }),
        h("span", { class: "hm-ell", text: c.text.replace(/\s+/g, " ").slice(0, 200) }),
        h("button", {
          class: "hm-ask",
          text: tl("Ask"),
          title: tl("Ask Cue about this"),
          onclick: (e: Event) => {
            e.stopPropagation();
            actions.blip();
            // ponytail: capped at 4000 characters; a whole file belongs in a dropped file.
            State.chatDraft = `${t("Explain this:")}\n\n${c.text.slice(0, 4000)}`;
            actions.setView("prompt");
          },
        }),
      ));
    }
  }
  function renderShelf() {
    clear(shelf);
    for (const f of files) {
      const ext = (f.name.includes(".") ? f.name.split(".").pop()! : "FILE").slice(0, 4).toUpperCase();
      shelf.append(h(
        "div",
        { class: "hm-file", title: f.name, onclick: () => void Bridge.shelfOpen(f.name) },
        h("div", { class: "hm-doc", text: ext }),
        h("span", { class: "hm-ell", text: f.name }),
      ));
    }
  }
  function load() {
    void Bridge.clipboardHistory().then((c) => { clips = c ?? []; renderClips(); });
    void Bridge.shelfList().then((f) => { files = f ?? []; renderShelf(); });
  }
  search.addEventListener("input", renderClips);
  void onEvent<null>("clipboard-changed", () => void Bridge.clipboardHistory().then((c) => { clips = c ?? []; renderClips(); }));

  return {
    el: h("div", { class: "hm-pg hm-files-pg" }, shelfTile, clipTile),
    shown: load,
    sync() {
      drop.classList.toggle("over", State.fileDragOver);
    },
  };
}

// ── Phone ────────────────────────────────────────────────────────────────────

const AVATAR_COLORS = ["#25d366", "#2aa3ef", "#34c759", "#a46bff", "#ff8a3c", "#ff5a7a"];
const colorOf = (name: string) => AVATAR_COLORS[[...name].reduce((n, ch) => n + ch.charCodeAt(0), 0) % AVATAR_COLORS.length];

export function buildPhonePage(actions: ViewActions): HomePage {
  const av = h("div", { class: "hm-av" });
  const who = h("b");
  const callSub = h("span", { class: "hm-sub" });
  const callBtns = h(
    "div",
    { class: "hm-callbtns" },
    h("button", { class: "hm-cb no", title: tl("Decline"), onclick: () => void Bridge.callAction(false) }, svg("M4 15c4-4 12-4 16 0l-2 3-4-1v-3a10 10 0 0 0-4 0v3l-4 1z", 18)),
    h("button", { class: "hm-cb ok", title: tl("Answer"), onclick: () => void Bridge.callAction(true) }, svg("M5 4h4l2 5-3 2a11 11 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z", 18)),
  );
  const link = h("button", { class: "hm-btn", text: tl("Open Phone Link"), onclick: () => void Bridge.openPhoneLink() });
  const ringBtn = h("button", { class: "hm-btn", text: tl("Find my phone"), onclick: () => {
    actions.blip();
    ringBtn.textContent = t("Ringing…");
    void Bridge.phoneRing().then((ok) => {
      ringBtn.textContent = ok ? t("Ringing…") : t("Add an ntfy topic first");
      window.setTimeout(() => (ringBtn.textContent = t("Find my phone")), 4000);
    });
  } });
  const phoneBatt = h("span", { class: "hm-r" });
  const calls = tile("hm-call", N_("Calls"), phoneBatt, av, who, callSub, callBtns, link, ringBtn);

  const msgNew = h("span", { class: "hm-r" });
  const msgs = h("div", { class: "hm-rows" });
  const messages = tile("", N_("Messages"), msgNew, msgs);
  let msgKey = "";

  const note = h("textarea", { placeholder: tl("A note or a link") });
  const sent = h("span", { class: "hm-sub hm-ell hm-sp", text: tl("Alerts reach your phone when you're away") });
  const sendBtn = h("button", { class: "hm-btn acc", text: tl("Send"), onclick: () => {
    const text = note.value.trim();
    if (!text) return;
    actions.blip();
    void Bridge.phoneSend(text).then((r) => {
      sent.classList.remove("hm-ell");
      sent.textContent = r?.push
        ? t("Sent to your phone")
        : r?.icloud
          ? t("Saved to iCloud Drive. For a notification, add an ntfy topic in Settings → iPhone.")
          : t("No phone is set up. Add an ntfy topic in Settings → iPhone.");
      if (r?.push || r?.icloud) note.value = "";
    });
  } });
  const send = tile("hm-send", N_("Send to phone"), null, note, h("div", { class: "hm-row2" }, sent, sendBtn));

  return {
    el: h("div", { class: "hm-pg hm-phone-pg" }, calls, messages, send),
    shown() {
      Inbox.unseen = 0;
    },
    sync() {
      // A ringing call is a live activity (island/live.ts); the last one otherwise.
      const ringing = Live.current?.kind === "call" && !Live.current.muted;
      const last = Inbox.items.find((x) => x.kind === "call");
      const name = ringing ? Live.current!.text : last?.who ?? "";
      av.textContent = (last?.who ?? name).trim().charAt(0).toUpperCase() || "☎";
      who.textContent = ringing ? name : last?.who ?? t("No calls yet");
      callSub.textContent = ringing ? t("Incoming call") : last ? ago(last.at) : "";
      callBtns.style.display = ringing ? "" : "none";
      link.style.display = ringing ? "none" : "";
      ringBtn.style.display = ringing ? "none" : "";
      phoneBatt.textContent = PhoneInfo.battery == null ? t("via Phone Link") : t("Phone {0}%", { 0: PhoneInfo.battery });

      const list = Inbox.items.filter((x) => x.kind === "message").slice(0, 5);
      msgNew.textContent = Inbox.unseen ? tn("{count} new", "{count} new", Inbox.unseen, { count: Inbox.unseen }) : "";
      const key = list.map((m) => `${m.who}:${m.at}`).join("|") + Math.floor(Date.now() / 60_000);
      if (key === msgKey) return;
      msgKey = key;
      clear(msgs);
      if (!list.length) msgs.append(h("div", { class: "hm-sub", text: tl("No messages yet") }));
      for (const m of list) {
        const ap = h("span", { class: "hm-ap" });
        ap.style.background = colorOf(m.who);
        msgs.append(h(
          "div",
          { class: "hm-msg" },
          ap,
          h("div", {}, h("b", { class: "hm-ell", text: m.who }), h("span", { class: "hm-sub hm-ell", text: m.body })),
          h("span", { class: "hm-t", text: ago(m.at) }),
        ));
      }
    },
  };
}

// ── Settings ─────────────────────────────────────────────────────────────────

/**
 * The settings page itself (src/settings), shown in the notch. It is loaded the
 * first time the gear is used: it finds its root by id and draws itself there.
 */
export function buildSettingsPage(): HomePage {
  const el = h("div", { class: "hm-pg hm-settings-pg" }, h("div", { id: "settings-root" }));
  let loaded = false;
  return {
    el,
    shown() {
      if (loaded) return;
      loaded = true;
      void import("../settings/main");
    },
    sync() {},
  };
}

// ── Agents ───────────────────────────────────────────────────────────────────

/** The last folder of a path: the project a session runs in. */
const project = (cwd: string | null | undefined) => (cwd ? cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "" : "");

export function buildAgentsPage(actions: ViewActions): HomePage {
  const running = h("span", { class: "hm-r" });
  const rows = h("div", { class: "hm-rows" });
  const sessions = tile("", N_("Sessions"), running, rows);
  let key = "-";

  const reqSub = h("div", { class: "hm-sub" });
  const reqCmd = h("div", { class: "hm-cmd" });
  const keys = h(
    "div",
    { class: "hm-keys" },
    h("button", { class: "hm-btn acc", onclick: () => actions.decide("allow") }, h("span", { text: tl("Allow once") }), h("kbd", { text: "Y" })),
    h("button", { class: "hm-btn", onclick: () => actions.decide("deny") }, h("span", { text: tl("Deny") }), h("kbd", { text: "N" })),
    h("button", { class: "hm-btn", text: tl("Answer in terminal"), onclick: () => actions.answerInTerminal() }),
  );
  const answer = h("button", { class: "hm-btn acc", text: tl("Answer"), onclick: () => { actions.blip(); actions.setView("question"); } });
  const req = h("div", { class: "hm-req" }, reqSub, reqCmd, keys, answer);
  const quiet = h("div", { class: "hm-sub", text: tl("Nothing is waiting for you.") });
  // What the last finished session did: files, tests, time, and its pull request.
  const rcTitle = h("b");
  const rcFacts = h("div", { class: "hm-rc-facts" });
  const rcFiles = h("div", { class: "hm-sub hm-rc-files" });
  const rcOpen = h("button", { class: "hm-btn acc" });
  const receipt = h("div", { class: "hm-req hm-receipt" }, rcTitle, rcFacts, rcFiles, rcOpen);
  let rcKey = 0;
  const needsTitle = h("span");
  const needsHint = h("span", { class: "hm-r" });
  const needs = h("section", { class: "hm-tile" }, h("div", { class: "hm-th" }, needsTitle, needsHint), h("div", { class: "hm-tb" }, req, receipt, quiet));

  // Y / N answer the waiting request while this page is up.
  window.addEventListener("keydown", (e) => {
    const on = State.view === "home" && State.mode === "expanded" && sessions.isConnected && sessions.parentElement?.classList.contains("on");
    const pending = State.pendingApproval;
    if (!on || !pending || pending.questions || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key.toLowerCase() === "y") actions.decide("allow");
    else if (e.key.toLowerCase() === "n") actions.decide("deny");
  });

  return {
    el: h("div", { class: "hm-pg hm-agents-pg" }, sessions, needs),
    sync() {
      const list = agentTasks();
      const active = list.filter((x) => x.state !== "idle").length;
      running.textContent = active ? tn("{count} running", "{count} running", active, { count: active }) : "";
      const k = list.map((x) => `${x.id}:${x.name}:${x.state}:${x.sessionCwd}:${x.finalLine}`).join("|");
      if (k !== key) {
        key = k;
        clear(rows);
        if (!list.length) rows.append(h("div", { class: "hm-sub", text: tl("No agents running") }));
        for (const a of list.slice(0, 8)) {
          const waiting = a.state === "approval" || a.state === "question";
          const name = [a.name, project(a.sessionCwd)].filter(Boolean).join(" · ");
          rows.append(h(
            "div",
            { class: `hm-srow${waiting ? " w" : a.state === "error" ? " f" : a.state === "idle" ? " off" : ""}`, title: tl("Open terminal"), onclick: () => { actions.setFocus(a.id); actions.openTerminal(); } },
            h("i"),
            h("span", { class: "hm-ell", text: a.finalLine && a.state === "finished" ? `${name} — ${a.finalLine}` : name }),
            h("span", { class: "hm-m", text: waiting ? t("needs you") : a.state === "error" ? t("open ↗") : a.state === "idle" ? "" : a.state }),
          ));
        }
      }

      const pending = State.pendingApproval;
      const last = pending ? null : Receipts.last;
      req.style.display = pending ? "" : "none";
      receipt.style.display = last ? "" : "none";
      quiet.style.display = pending || last ? "none" : "";
      needsTitle.textContent = pending || !last ? t("Needs you") : t("Last finished");
      needsHint.textContent = pending ? t("Y allow · N deny") : "";
      if (last && last.at !== rcKey) {
        rcKey = last.at;
        rcTitle.textContent = last.name;
        clear(rcFacts);
        const fact = (value: string, label: string) => rcFacts.append(h("span", {}, h("b", { text: value }), h("i", { text: label })));
        fact(String(last.files.length), t("files changed"));
        fact(`+${last.added} −${last.removed}`, t("lines"));
        fact(String(last.tests), t("test runs"));
        if (last.seconds != null) fact(formatSpan(last.seconds), t("time taken"));
        rcFiles.textContent = last.files.slice(0, 8).join(" · ") + (last.files.length > 8 ? " …" : "");
        rcOpen.textContent = last.pr ? t("Open the pull request ↗") : t("Open pull requests ↗");
        rcOpen.onclick = () => void Bridge.openUrl(last.pr ?? "https://github.com/pulls");
      }
      if (!pending) return;
      const task = State.tasks.find((x) => x.id === pending.pillId);
      reqSub.textContent = [task?.name, task?.sessionCwd, pending.tool].filter(Boolean).join(" · ");
      clear(reqCmd);
      reqCmd.append(h("span", { text: "$ " }), pending.command || pending.tool);
      keys.style.display = pending.questions ? "none" : "";
      answer.style.display = pending.questions ? "" : "none";
    },
  };
}
