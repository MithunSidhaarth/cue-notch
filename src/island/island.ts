// The island: DOM shell, sizing animation, Cue placement, mouse handling.
// Mirrors IslandRootView.swift + IslandWindowController.swift.

import { Ease, Tracked, Spring, clamp } from "../core/anim";
import { Bridge, IS_TAURI, onDragDrop } from "../core/bridge";
import {
  EXPANDED_CORNER, EXPANDED_W, HOME_TALL_H, HOME_TALL_W, NOTCH_W, PANEL_H, PANEL_W,
  ROUNDED_CORNER, VIEW_LAYOUTS, botGlowColor, botGlowOpacity, botPosition, chatPromptHeight,
  islandSize,
  QUESTION_PICKER_H,
  CINEMA_W, CINEMA_H, CINEMA_CORNER,
  type BotEmoteName, type IslandMode, type IslandViewName,
} from "../core/layout";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { Spotify, isMusicPill, islandDances } from "../core/spotify";
import { TockEngine, Hello, createMiniBot, pruneMiniBots, syncMiniBotStates, tickMiniBots } from "../avatar/tock";



import { UploadCanvas } from "../upload/canvas";
import { USC, UploadSeq } from "../upload/sequence";
import { closePlanCard } from "../views/usage";
import { buildHeader, buildViews, type ViewActions, type ViewHost } from "../views/views";
import { h } from "../views/dom";
import { IslandStateMachine } from "./fsm";
import { refreshHookPills } from "./integrations";
import type { ViewCommand } from "./shortcuts";
import { LIVE_W, Live, buildLive } from "./live";
import { buildMiniPlayer } from "./miniplayer";
import { barIsSplit, barLyrics, buildCueBar } from "../views/home";
import { CinemaPref, buildCinema } from "../views/cinema";
import { applyMotion } from "../core/motion";

const BOT_OVERHANG = 40;

/**
 * The pills, the empty card and the permission card are pages of the widget
 * page now (views/home.ts: Agents shows the sessions and the waiting request),
 * so whatever still asks for one of the old views gets the page.
 */
function cueView(view: IslandViewName): IslandViewName {
  return view === "overview" || view === "empty" || view === "approval" ? "home" : view;
}
// How the island opens and closes: quick, with a little give and no long tail.
// (The first values, 0.5 / 0.72 and 340 ms, took over a second to settle.)
const OPEN_RESPONSE = 0.3;
const OPEN_DAMPING = 0.84;
const CLOSE_MS = 240;
/** The card a Claude update opens the closed notch into. */
const AGENT_CARD_W = 460;
const AGENT_CARD_H = 132;
const CLAUDE_DESKTOP_ID = "agent_claude-desktop";
/** Extra canvas on each side of Cue, for the witch hat's brim and the Santa hat's tip. */
const BOT_SIDE = 24;
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;

/** The three views the drop sequence owns; leaving them stops the engine. */
const UPLOAD_VIEWS: ReadonlySet<IslandViewName> = new Set(["upload", "uploading", "choose"]);

/** Seconds between the drop and the moment the progress bar starts filling. */
const PRE_PROGRESS = USC.T_PROG_START - USC.T_DROP;

const modeOrder = (m: IslandMode) => (m === "hidden" ? 0 : m === "compact" ? 1 : 2);

export class Island {
  readonly fsm = new IslandStateMachine();

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private botGlow!: HTMLElement;
  private greetingCanvas!: HTMLCanvasElement;
  /** Tock is leaning out of the closed notch towards a pointer nearby. */
  private peeking = false;
  /** The bar of the closed notch and of the widget page (views/home.ts). */
  private cueBar!: { el: HTMLElement; sync(): void };
  private cinema!: { el: HTMLElement; fold: HTMLElement; sync(on: boolean): void };
  private miniGrid!: HTMLElement;
  private live = buildLive();
  private mini = buildMiniPlayer();
  /** The compact width last animated to, so music starting widens it once. */
  private compactW = 0;
  private countdown!: HTMLElement;
  private wakeStrip!: HTMLElement;

  private header!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;
  private uploadCanvas!: UploadCanvas;

  private width = new Tracked(NOTCH_W);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  private botCx = new Spring(46);
  private botCy = new Spring(16);
  private botSize = new Spring(10);

  private engine = new TockEngine();
  private greeting = new Hello();
  private greetingShown = false;

  private running = false;
  private lastFrame = 0;
  private dirty = true;
  private canvasPx = 0;

  // Unknown at load: the page may reload (an update, a wake from sleep) while
  // Rust holds the window at the wake strip. Starting from "collapsed" makes
  // the first opening ask Rust for the full window, so the two cannot disagree
  // and leave an open notch invisible in a strip 8 pixels tall.
  private collapsed = true;
  private wasInIsland = false;
  /** Last shape handed to Rust for the click-through test. */
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };

  // Bot hover → love (IslandWindowController.botHoverIn)
  private botHovering = false;
  private botHoverTimer: number | null = null;
  private lastLoveTime = 0;
  private botHoverStart = { x: 0, y: 0 };

  private confusedRecovery: number | null = null;
  private prevViewBeforeConfused: IslandViewName = "overview";
  private lastSyncedView: IslandViewName | null = null;

  /** The launch greeting ended, or the island came out of hidden — two of the
   *  moments the Monday recap may open (see src/recap/recap.ts). */
  onGreetingDone: (() => void) | null = null;
  onWake: (() => void) | null = null;

  /** The next reveal from hidden makes no peek (music starting, as on macOS). */
  private silentReveal = false;

  /** Drop sequence bookkeeping: last tick played, and whether the ✓ has fired. */
  private uploadTens = 0;
  private uploadDone = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.build();
    this.wireFsm();
    this.wireInput();
    this.engine.onDizzy = () => this.handleDizzy();
    this.greeting.onComplete = () => {
      this.fsm.greetComplete();
      this.onGreetingDone?.();
    };
    State.subscribe(() => {
      this.dirty = true;
      this.ensureRunning();
    });
  }

  /** Allow / Deny on the waiting permission: the card's buttons and the global shortcuts. */
  decide(d: "allow" | "deny") {
    const req = State.pendingApproval;
    void Bridge.log(`decide ${d} req=${req?.requestId ?? "none"}`);
    if (!req) return;
    Sound.play(d === "deny" ? "blip" : "approve");
    void Bridge.approvalDecision(req.requestId, d);
    this.closeApproval();
  }

  /** The request has its answer: the card goes and the session carries on. */
  private closeApproval() {
    State.endApproval();
    this.fsm.pinned = false;
    this.setView(State.defaultView());
  }

  /**
   * Folds a card that is waiting for an answer down to the compact island,
   * without answering it (Mac #290). Nothing is decided: the request keeps
   * waiting, the island stays on screen, and opening it shows the card again.
   */
  foldApproval() {
    if (!State.pendingApproval || State.mode !== "expanded") return;
    State.isPinned = true;
    this.fsm.pinned = true;
    this.fsm.forcePetit();
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  private build() {
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      cancelDrop: () => this.discardDrop(),
      collapse: () => this.collapse(),
      foldApproval: () => this.foldApproval(),
      setFocus: (id) => {
        State.setFocus(id);
        Sound.play("blip");
        // A pill with a waiting request opens on its card: going back to it
        // after looking at another pill brings the card up again.
        const req = State.pendingApproval;
        if (req?.pillId === id) this.setView(req.questions ? "question" : "approval");
      },
      openTerminal: () => {
        const task = State.focusTask;
        // Sessions from the Claude desktop app live there, not in a terminal.
        if (task?.id === CLAUDE_DESKTOP_ID) void Bridge.openClaudeDesktop();
        else void Bridge.openSession(task?.sessionId ?? null, task?.sessionCwd ?? null);
      },
      // The ↗ button — same targets as openAgentTarget() on macOS.
      openTarget: () => {
        const task = State.focusTask;
        if (!task) return;
        const urls: Record<string, string> = {
          integration_resend: "https://resend.com/emails",
          integration_vercel: "https://vercel.com/dashboard",
          integration_github: "https://github.com/pulls",
          integration_stripe: "https://dashboard.stripe.com/payments",
          integration_notion: "https://notion.so",
          integration_calcom: "https://app.cal.com/bookings",
        };
        if (task.id === CLAUDE_DESKTOP_ID) void Bridge.openClaudeDesktop();
        else if (task.id === "integration_claude" || task.sessionId) {
          void Bridge.openSession(task.sessionId ?? null, task.sessionCwd ?? null);
        } else if (task.id === "integration_n8n") void Bridge.openN8n();
        else if (isMusicPill(task.id)) void Bridge.spotifyOpen();
        else if (urls[task.id]) void Bridge.openUrl(urls[task.id]);
      },
      openUrl: (url) => {
        if (url) void Bridge.openUrl(url);
      },
      decide: (d) => this.decide(d),
      answer: (answers) => {
        const req = State.pendingApproval;
        if (!req) return;
        Sound.play("approve");
        void Bridge.approvalAnswer(req.requestId, answers);
        this.closeApproval();
      },
      answerInTerminal: () => {
        const req = State.pendingApproval;
        if (!req) return;
        Sound.play("blip");
        void Bridge.approvalDecline(req.requestId);
        this.closeApproval();
      },
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setVolume: (v) => {
        State.settings.soundVolume = v;
        Sound.setVolume(v);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setAutoClose: (s) => {
        State.settings.autoCloseInterval = s;
        this.fsm.homeToPetitDelay = s;
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      openSettingsWindow: () => void Bridge.openSettingsWindow(),
      blip: () => Sound.play("blip"),
    };

    this.wakeStrip = h("div", { id: "wake-strip" });
    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.miniGrid = h("div", { id: "mini-grid" });
    this.countdown = h("div", { id: "countdown" });

    this.header = buildHeader(actions);
    this.cueBar = buildCueBar();
    this.cinema = buildCinema();
    this.views = buildViews(actions, () => this.animateGeometry(false));
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);

    // The drop sequence draws the card, the bar and its own Cue. It sits under
    // the header, which stays visible on top of it exactly as on macOS.
    this.uploadCanvas = new UploadCanvas({
      ask: () => {
        State.promptContext = State.droppedFile
          ? { kind: "file", name: State.droppedFile.name, path: State.droppedFile.path }
          : null;
        this.setView("prompt");
      },
      cancel: () => this.discardDrop(),
    });

    this.clipEl = h(
      "div",
      { id: "island-clip" },
      this.greetingCanvas,
      this.uploadCanvas.el,
      this.contentEl,
      this.cueBar.el,
      this.cinema.el,
    );
    this.islandEl = h(
      "div",
      { id: "island" },
      this.clipEl,
      this.botGlow,
      this.botCanvas,
      this.miniGrid,
      this.live.el,
      this.mini.el,
      this.countdown,
    );

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
    this.greetingCanvas.height = Math.round(150 * dpr);
    this.greetingCanvas.style.width = `${EXPANDED_W}px`;
    this.greetingCanvas.style.height = "150px";

    // One device pixel, for hairlines that stay sharp at any display scaling.
    document.documentElement.style.setProperty("--hair", `${1 / (window.devicePixelRatio || 1)}px`);
    this.root.append(this.wakeStrip, this.islandEl);
    this.applyGeometry();
  }

  // ── FSM ─────────────────────────────────────────────────────────────────────

  private wireFsm() {
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.openOnHover = State.settings.openOnHover;
    this.fsm.onTransition = (from, to) => {
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          if (from === "cue") this.greeting.interrupt();
          else if (from === "hidden" && !this.silentReveal) Sound.play("peek");
          this.setMode("compact");
          if (from === "cue") State.view = State.defaultView();
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "home":
          this.expand(State.defaultView());
          if (!this.wasInIsland) this.fsm.mouseLeft();
          // Hooks may have been installed in a terminal since: the idle cards
          // say so on the next open, without polling while the island is shut.
          void refreshHookPills();
          break;
        case "cue":
          this.expand("greeting");
          this.greeting.start();
          break;
      }
      State.notify();
      if (from === "hidden") this.onWake?.();
    };
  }

  launch() {
    this.fsm.launch();
  }

  // ── Mode / view ─────────────────────────────────────────────────────────────

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    void Bridge.log(`island ${prev} -> ${mode}`);
    State.mode = mode;
    if (mode === "expanded") Sound.play("open");
    if (prev === "expanded") {
      Sound.play("close");
      // A folded card is still waiting: it keeps the island pinned.
      if (!State.pendingApproval) State.isPinned = false;
      void Bridge.focusWindow(false);
    }
    if (mode !== "expanded") {
      closePlanCard();
      this.engine.resetMorph();
      // Nothing can be seen of the sequence once the island is shut, and leaving
      // it running would keep the frame loop awake — the island must cost
      // nothing while hidden.
      UploadSeq.deactivate();
    }
    const shrinking = modeOrder(mode) < modeOrder(prev);
    const growing = this.updateWindowCollapsed();
    if (growing) {
      // The window was down to the wake strip. Resizing it is the one slow
      // frame of an opening, so it happens first and the island moves after,
      // instead of stuttering through it.
      void growing.then(() => requestAnimationFrame(() => this.animateGeometry(shrinking)));
    } else {
      this.animateGeometry(shrinking);
    }
    State.notify();
  }

  /** True while the drop sequence owns the island body. */
  private get uploadActive(): boolean {
    return State.mode === "expanded" && UploadSeq.isActive && UPLOAD_VIEWS.has(State.view);
  }

  /** Navigating out of the drop flow ends the sequence, as on macOS. */
  private stopSequenceIfLeaving(view: IslandViewName) {
    if (UploadSeq.isActive && !UPLOAD_VIEWS.has(view)) UploadSeq.deactivate();
  }

  expand(view: IslandViewName) {
    view = cueView(view);
    this.stopSequenceIfLeaving(view);
    if (view !== "overview") closePlanCard();
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    State.notify();
  }

  setView(view: IslandViewName) {
    view = cueView(view);
    this.stopSequenceIfLeaving(view);
    if (view !== "overview") closePlanCard();
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      return;
    }
    const grew = VIEW_LAYOUTS[view].height >= VIEW_LAYOUTS[State.view].height;
    State.view = view;
    State.lastActivity = performance.now();
    this.animateGeometry(!grew);
    State.notify();
  }

  collapse() {
    // A waiting card is only ever folded, never dropped by a close.
    if (State.pendingApproval) {
      this.foldApproval();
      return;
    }
    State.isPinned = false;
    this.fsm.pinned = false;
    // Drive the state machine rather than the mode: setting the mode behind its
    // back left it thinking the island was still open, and a click on the compact
    // island then did nothing — the island could never be reopened.
    this.fsm.forcePetit();
  }

  /** Alert from the hook server: open on this view. Pinned alerts never auto-close. */
  alert(view: IslandViewName) {
    this.fsm.pinned = State.isPinned;
    this.fsm.forceHome();
    this.expand(view);
  }

  reveal() {
    this.fsm.reveal();
  }

  /** Music started playing: the compact island, without the peek sound (musicReveal). */
  revealSilently() {
    this.silentReveal = true;
    this.fsm.reveal();
    this.silentReveal = false;
  }

  /** A live activity (island/live.ts): out of hidden for `ms`, silently. */
  peekLive(ms: number) {
    if (State.paused) return;
    this.silentReveal = true;
    this.fsm.peek(ms);
    this.silentReveal = false;
  }

  /** A live activity came or went: the compact island widens or narrows. */
  liveResized() {
    this.animateGeometry(Live.current == null);
  }

  /** An alert stopped waiting for an answer: let the island auto-close again. */
  dropPin() {
    this.fsm.pinned = false;
    // The countdown the pin held back starts now, if the mouse is elsewhere.
    if (!this.wasInIsland) this.fsm.mouseLeft();
  }

  // ── Keyboard shortcuts (island/shortcuts.ts) ────────────────────────────────

  emote(name: BotEmoteName) {
    this.engine.triggerEmote(name);
    this.ensureRunning();
  }

  // ── Cue (voice/eleven.ts): Cue is the one talking ────────────────────────

  /** Listening (cyan, all ears), thinking (purple), working (blue), speaking (himself). */
  voiceMood(mood: "listening" | "thinking" | "working" | "speaking" | null) {
    const state = mood === "listening" ? "question" : mood === "thinking" ? "thinking" : mood === "working" ? "working" : null;
    State.stateOverride = mood == null ? null : (state ?? "idle");
    this.engine.setState(State.effectiveState);
    // Listening: dots, not the "?" of a question.
    if (mood === "listening") this.engine.setBadge({ kind: "dots", color: [0.133, 0.827, 0.933] });
    this.ensureRunning();
  }

  /** One beat of the voice: Cue bobs with Cue's words, widens his eyes at yours. */
  voicePulse(level: number, user: boolean) {
    const v = clamp(level, 0, 1);
    if (user) {
      this.engine.anim("es", [[1 + 0.18 * v, 70, Ease.out], [1, 160, Ease.inOut]]);
    } else {
      this.engine.anim("sy", [[1 + 0.09 * v, 70, Ease.out], [1, 150, Ease.inOut]]);
      this.engine.anim("sx", [[1 - 0.04 * v, 70, Ease.out], [1, 150, Ease.inOut]]);
      this.engine.anim("oy", [[-0.07 * v, 70, Ease.out], [0, 150, Ease.inOut]]);
    }
    this.ensureRunning();
  }

  /** A passing eye shape for moods without an emote (sad, curious). */
  voiceEye(eye: "tired" | "wide", seconds = 1.8) {
    this.engine.eyeOverride = eye;
    this.engine.eyeOverrideUntil = performance.now() / 1000 + seconds;
    this.ensureRunning();
  }

  /** Ctrl+P: keep the open island from folding away, or let it fold again. */
  setPinned(on: boolean) {
    State.isPinned = on;
    this.fsm.pinned = on;
    if (on) {
      // The countdown bar reads the state machine's deadline, cleared with it.
      this.fsm.cancelTimers();
    } else if (!this.wasInIsland && this.fsm.state === "home") {
      this.fsm.mouseLeft();
    }
    State.notify();
  }

  /** The island takes the keyboard, so its own shortcuts work (Mac: makeKey).
   *  It gives it back when it closes, or when the chat is left. */
  takeKeyboard() {
    void Bridge.focusWindow(true);
  }

  /** Ctrl+O / Ctrl+E go to the view on screen. */
  viewCommand(command: ViewCommand) {
    this.views.get(State.view)?.command?.(command);
  }

  // ── File drop ───────────────────────────────────────────────────────────────

  private onDragDrop(e: { type: string; paths?: string[] }) {
    if (e.type !== "over") void Bridge.log(`drag ${e.type} ${e.paths?.length ?? 0} file(s)`);
    if (State.paused) return;
    switch (e.type) {
      case "enter":
      case "over": {
        if (State.fileDragOver) return;
        State.fileDragOver = true;
        this.engine.animateMorph(1);
        // enterZone must run before the island expands, so the sequence is
        // already active by the time the view becomes `upload`.
        UploadSeq.enterZone(State.mouseInIsland.x, State.mouseInIsland.y);
        this.alert("upload");
        break;
      }
      case "leave": {
        if (!State.fileDragOver) return;
        State.fileDragOver = false;
        this.engine.animateMorph(0);
        // The island deliberately stays open: the drag session is still alive.
        UploadSeq.exitZone();
        State.notify();
        break;
      }
      case "drop": {
        State.fileDragOver = false;
        const path = e.paths?.[0];
        if (!path) {
          this.engine.animateMorph(0);
          this.setView(State.defaultView());
          return;
        }
        this.swallow(path);
        break;
      }
    }
  }

  /**
   * Cue eats the file. Nothing here waits on the file system: the copy into
   * the inbox runs in the background and swaps the path in when it lands, so a
   * slow disk can never stall the animation — same as FileDropHandler on macOS.
   */
  private swallow(path: string) {
    const name = path.split(/[\\/]/).pop() || "file";
    State.droppedFile = { name, path };
    State.promptContext = { kind: "file", name, path };
    State.chatHistory = [];
    void Bridge.chatReset();

    UploadSeq.performDrop(State.uploadDuration);
    this.uploadTens = 0;
    this.uploadDone = false;

    this.engine.gulp();
    Sound.play("approve");
    this.engine.triggerEmote("happy");
    this.engine.animateMorph(0);

    State.uploadProgress = 0;
    this.setView("uploading");
    this.ensureRunning();

    void Bridge.ingestFile(path)
      .then((file) => {
        // Cancelled (or replaced by another drop) while the copy was running.
        if (State.droppedFile?.path !== path) return;
        State.droppedFile = { name: file.name, path: file.path };
        State.promptContext = { kind: "file", name: file.name, path: file.path };
        State.notify();
      })
      .catch((err) => {
        if (State.droppedFile?.path !== path) return;
        UploadSeq.deactivate();
        State.noteMessage = String(err).replace(/^Error:\s*/, "");
        this.engine.animateMorph(0);
        this.setView("note");
        Sound.play("error");
        window.setTimeout(() => this.setView(State.defaultView()), 2400);
      });
  }

  /** "Cancel" on the dropped file: forget it, so the chat does not pick it up. */
  private discardDrop() {
    State.droppedFile = null;
    State.promptContext = null;
    this.setView(State.defaultView());
  }

  /**
   * Sounds and view changes hung off the canvas timeline: a `tick` every 10 %,
   * the ✓ chime when the bar completes, then `choose` once Cue has grown back.
   */
  private stepSequence() {
    const since = UploadSeq.sinceDrop();
    if (since == null) return;
    const dur = State.uploadDuration;
    const p = Math.max(0, Math.min(1, (since - PRE_PROGRESS) / dur));

    const tens = Math.floor(p * 10);
    if (tens > this.uploadTens && tens < 10) {
      this.uploadTens = tens;
      Sound.play("tick");
    }

    if (!this.uploadDone && since >= PRE_PROGRESS + dur) {
      this.uploadDone = true;
      Sound.play("approve");
      this.engine.triggerEmote("happy");
    }
    // The extra second is the grow-back, after which the choose card is up.
    if (since >= PRE_PROGRESS + dur + 1 && State.view === "uploading") {
      this.setView("choose");
    }
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  /** LyricGlow is singing in the closed notch and the user has not folded the letterbox away. */
  private cinemaOn(): boolean {
    return State.mode === "compact" && !Live.current && barLyrics() && !CinemaPref.mini;
  }

  /** A click on Cinema's minimise, or on the bar's button that brings it back. */
  private cinemaToggleHit(x: number, y: number): boolean {
    if (State.mode !== "compact" || Live.current || !barLyrics()) return false;
    const btn = this.cinemaOn() ? this.cinema.fold : this.cueBar.el.querySelector<HTMLElement>(".hm-cin-btn");
    if (!btn) return false;
    const r = btn.getBoundingClientRect();
    const pad = 6;
    return r.width > 0 && x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
  }

  private targetSize(): { w: number; h: number; r: number } {
    let { w, h } = islandSize(State.mode, State.view, State.chatHistory.length);
    if (State.mode === "compact" && Live.current) {
      w = Live.current.kind === "call" ? LIVE_W + 64 : LIVE_W;
      // An agent's update is a card: the notch opens into one box for it.
      // (Other news is a line of text and only stretches the notch sideways.)
      if (Live.current.kind === "agent") {
        w = AGENT_CARD_W;
        // No facts line (nothing counted): the card is that much shorter.
        h = Live.current.detail ? AGENT_CARD_H : AGENT_CARD_H - 22;
      }
    }
    const cinema = this.cinemaOn();
    if (cinema) {
      w = CINEMA_W;
      h = CINEMA_H;
    }
    if (State.mode === "expanded" && State.view === "question" && State.pendingApproval?.questions) {
      h = QUESTION_PICKER_H;
    }
    if (State.mode === "expanded" && State.view === "home" && State.homeTall) {
      w = HOME_TALL_W;
      h = HOME_TALL_H;
    }
    const r = cinema ? CINEMA_CORNER : State.mode !== "expanded" ? ROUNDED_CORNER : State.view === "home" ? 28 : EXPANDED_CORNER;
    return { w, h, r };
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    if (shrinking) {
      this.width.curveTowards(w, CLOSE_MS);
      this.height.curveTowards(h, CLOSE_MS);
      this.radius.curveTowards(r, CLOSE_MS);
    } else {
      this.width.springTo(w, OPEN_RESPONSE, OPEN_DAMPING);
      this.height.springTo(h, OPEN_RESPONSE, OPEN_DAMPING);
      this.radius.springTo(r, OPEN_RESPONSE, OPEN_DAMPING);
    }
    this.ensureRunning();
  }

  private applyGeometry() {
    const w = this.width.value;
    const hh = this.height.value;
    const r = this.radius.value;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    this.islandEl.style.borderRadius = `0 0 ${r}px ${r}px`;
    this.islandEl.style.transform = `translateX(-50%)`;
    // These follow the island as it resizes, so they belong here rather than in
    // the state-driven DOM sync.
    this.miniGrid.style.left = `${w - 40 - 14.5}px`;
    this.miniGrid.style.top = `${hh / 2 - 14.5}px`;
    this.greetingCanvas.style.left = `${(w - EXPANDED_W) / 2}px`;
    this.uploadCanvas.el.style.left = `${(w - EXPANDED_W) / 2}px`;

    // Rust is told where the island is heading, once, not every frame of the way.
    const tw = this.width.target;
    const rect = { x: (PANEL_W - tw) / 2, y: 0, w: tw, h: this.height.target };
    const p = this.pushedRect;
    if (Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  /** Island rect in window coordinates (origin top-left of the 720×320 window). */
  private islandRect(): { x: number; y: number; w: number; h: number } {
    const w = this.width.value;
    const hh = this.height.value;
    return { x: (PANEL_W - w) / 2, y: 0, w, h: hh };
  }

  // ── Window collapse (hidden → tiny wake strip, zero polling) ────────────────

  /** Returns the window's growth when it was collapsed and has to come back first. */
  private updateWindowCollapsed(): Promise<unknown> | null {
    // The window no longer drops to the wake strip when idle: the idle notch is
    // drawn in it, and waking it then costs no window resize (the one slow
    // frame an opening had). The cursor poll that keeps running is cheap.
    if (this.collapsed) {
      this.collapsed = false;
      return Bridge.setCollapsed(false);
    }
    return null;
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  private wireInput() {
    // The wake strip is the only thing the OS can hit while the island is hidden.
    this.wakeStrip.addEventListener("mouseenter", () => {
      Sound.resume();
      if (State.mode === "hidden") this.fsm.mouseEntered();
    });

    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      // A click makes a hover-opened island an ordinary open one.
      this.fsm.userInteracted();
      if (this.cinemaToggleHit(e.clientX, e.clientY)) {
        CinemaPref.toggle();
        Sound.play("blip");
        State.notify();
        return;
      }
      if (State.mode !== "expanded") {
        this.fsm.click();
        return;
      }
      if (this.isBotHit(e.clientX, e.clientY)) {
        this.cancelBotHover();
        this.engine.slap();
      }
    });

    // Only keys typed into the island itself land here, never Escape typed in
    // a terminal — so it may fold a waiting card away, as Escape in the notch
    // does on macOS.
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && State.mode === "expanded") {
        if (State.pendingApproval) this.foldApproval();
        else if (!State.isPinned) this.collapse();
      }
      State.lastActivity = performance.now();
    });

    void onDragDrop((e) => this.onDragDrop(e));

    // Outside Tauri (plain browser) drive the cursor from DOM events so the
    // island can be inspected with `npm run dev`.
    if (!IS_TAURI) this.followPageCursor();
  }

  /**
   * Takes the cursor from the page's own mouse events instead of Rust's poll.
   * Used where the OS has no global cursor position (Wayland): the events only
   * fire while the pointer is over the island, so leaving the window is
   * reported as a cursor far away, which is what the poll would have said.
   */
  followPageCursor() {
    window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    window.addEventListener("mouseout", (e) => {
      if (e.relatedTarget == null) this.onCursor(-10_000, -10_000);
    });
  }

  /**
   * Pointer on/off the island as the compositor sees it (Linux only). Null
   * until the first report, so a platform that never sends it is not gated.
   */
  private pointerInside: boolean | null = null;

  setPointerInside(inside: boolean) {
    this.pointerInside = inside;
  }

  /** Cursor in window-logical coordinates. */
  onCursor(x: number, y: number) {
    // WebKitGTK can deliver a mousemove after the pointer has left the layer
    // surface; trusting it re-enters the island and the auto-close never runs.
    if (this.pointerInside === false) {
      x = -10_000;
      y = -10_000;
    }
    State.mouse = { x, y };
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };

    // Windows sends no cursor position with an OLE drag, so the drop sequence is
    // fed from the Win32 cursor poll instead — it runs throughout the drag.
    if (UploadSeq.isActive && !UploadSeq.dropped) {
      UploadSeq.updateCursor(State.mouseInIsland.x, State.mouseInIsland.y);
    }

    const inIsland =
      x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
      y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;

    // Recorded before the state machine hears of it: a transition it makes
    // right away (open on hover) reads where the pointer is, and must not see
    // the pointer as still outside.
    const wasIn = this.wasInIsland;
    this.wasInIsland = inIsland;
    if (inIsland && !wasIn) {
      if (this.fsm.state === "cue") this.greeting.hover();
      this.fsm.mouseEntered();
    }
    if (!inIsland && wasIn) {
      this.fsm.mouseLeft();
    }

    // Bot hover → love
    const overBot = State.mode === "expanded" && State.stateOverride == null && this.isBotHit(x, y);
    if (overBot && !this.botHovering) this.botHoverIn(x, y);
    if (!overBot && this.botHovering) this.cancelBotHover();
    this.botHovering = overBot;
    if (this.botHovering) {
      const d = Math.hypot(x - this.botHoverStart.x, y - this.botHoverStart.y);
      if (d > 40) {
        this.botHoverStart = { x, y };
        this.scheduleLove();
      }
    }

    this.ensureRunning();
  }

  private isBotHit(x: number, y: number): boolean {
    const rect = this.islandRect();
    const cx = rect.x + this.botCx.value;
    const cy = rect.y + this.botCy.value;
    const radius = this.botSize.value / 2;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  }

  private botHoverIn(x: number, y: number) {
    if (performance.now() / 1000 - this.lastLoveTime < 6) return;
    this.botHoverStart = { x, y };
    this.engine.blink();
    this.engine.tgEs = 1.08;
    Sound.play("hover");
    this.scheduleLove();
  }

  private scheduleLove() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = window.setTimeout(() => {
      this.botHoverTimer = null;
      if (!this.botHovering || State.stateOverride != null) return;
      if (performance.now() / 1000 - this.lastLoveTime < 6) return;
      this.lastLoveTime = performance.now() / 1000;
      this.engine.triggerEmote("love");
      Sound.play("love");
    }, 1900);
  }

  private cancelBotHover() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = null;
    this.engine.tgEs = 1;
  }

  /** Three slaps → dizzy + confused view for 3.3 s, then back. */
  handleDizzy() {
    this.prevViewBeforeConfused = State.view;
    State.stateOverride = "dizzy";
    this.engine.setState("dizzy");
    Sound.play("dizzy");
    this.alert("confused");
    if (this.confusedRecovery != null) window.clearTimeout(this.confusedRecovery);
    this.confusedRecovery = window.setTimeout(() => {
      this.confusedRecovery = null;
      State.stateOverride = null;
      this.engine.setState(State.effectiveState);
      if (State.view === "confused") {
        const fallback = State.defaultView();
        this.setView(this.prevViewBeforeConfused === "confused" ? fallback : this.prevViewBeforeConfused);
      }
      this.engine.triggerEmote("happy");
    }, 3300);
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  /** Frame times of the resize under way, for the log: how smooth it was. */
  private animFrames: number[] = [];

  private frame = (nowMs: number) => {
    const rawMs = nowMs - this.lastFrame;
    const dt = Math.min(0.05, rawMs / 1000);
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    if (greetingActive) {
      const gctx = this.greetingCanvas.getContext("2d");
      if (gctx) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.greeting.draw(gctx);
      }
    } else {
      // Kept running even while the drop canvas is up, so the island's own Cue
      // is already in the right place the moment the canvas fades out.
      this.drawBot(dt);
    }

    const uploadActive = this.uploadActive;
    if (uploadActive) this.uploadCanvas.draw(UploadSeq.frame(), nowMs / 1000);
    this.uploadCanvas.el.classList.toggle("on", uploadActive);
    this.viewsEl.classList.toggle("hidden-by-upload", uploadActive);

    tickMiniBots(dt);
    // A ticker scroll that loses its frames freezes mid-way, rows overlapping.
    const viewAnimating = this.views.get(State.view)?.tick?.(nowMs) === true;
    if (UploadSeq.isActive) this.stepSequence();
    this.updateCountdown(nowMs);

    // Nothing is drawn while the island is hidden, so nothing may keep the loop
    // alive either. This used to read `... || this.engine.busy || State.mode !==
    // "hidden"`, and engine.busy is permanently true for any state with a
    // looping animation — breathing, ratelimit sweat, sleeping z's, the search
    // sweep — so a hidden island went on burning frames in exactly the states it
    // spends most of its life in. Geometry still has to finish retracting.
    const settling =
      this.width.animating || this.height.animating || this.radius.animating;
    if (settling) this.animFrames.push(rawMs);
    else if (this.animFrames.length > 3) {
      // The first frame's time is the wait before the animation, not a frame.
      const f = this.animFrames.slice(1);
      const avg = f.reduce((a, b) => a + b, 0) / f.length;
      void Bridge.log(`resize ${f.length} frames, avg ${avg.toFixed(1)} ms, worst ${Math.max(...f).toFixed(1)} ms`);
      this.animFrames = [];
    } else this.animFrames = [];
    const busy = State.mode === "hidden"
      ? settling
      : settling ||
        !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
        greetingActive || this.engine.busy || UploadSeq.isActive || viewAnimating;

    if (busy) {
      requestAnimationFrame(this.frame);
    } else {
      this.running = false;
      Sound.idle();
    }
  };

  private updateBotTargets() {
    const p = botPosition(State.mode, State.view, this.height.value, State.uploadProgress);
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    // The pointer is near the closed notch but not on it: Tock leans out of
    // the bottom edge to look.
    if (State.mode === "compact" && !Live.current) {
      const rect = this.islandRect();
      const dx = Math.max(rect.x - State.mouse.x, State.mouse.x - (rect.x + rect.w), 0);
      const dy = State.mouse.y - rect.h;
      const near = dy > 0 && dy < 110 && dx < 90;
      if (near) this.botCy.target = p.cy + 9;
      if (near !== this.peeking) {
        this.peeking = near;
        if (near) this.engine.blink();
      }
    }
    this.botSize.target = p.diameter / 0.6;

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    // The drop canvas draws its own Cue; two of them would overlap.
    // Two sessions at once: the bar draws a Tock for each, so the single one steps aside.
    const split = State.mode === "compact" && !Live.current && barIsSplit();
    const visible = p.opacity > 0 && !greetingActive && !this.uploadActive && !split;
    this.botCanvas.style.opacity = visible ? "1" : "0";

    if (State.mode === "expanded" && State.view !== "uploading" && !greetingActive && !this.uploadActive) {
      const d = p.diameter;
      const color = botGlowColor(State.effectiveState);
      this.botGlow.style.display = "block";
      this.botGlow.style.width = `${d * 2.2}px`;
      this.botGlow.style.height = `${d * 2.2}px`;
      this.botGlow.style.left = `${this.botCx.value - d * 1.1}px`;
      this.botGlow.style.top = `${this.botCy.value - d * 1.1}px`;
      this.botGlow.style.background = `radial-gradient(circle, ${color} 0%, transparent 62%)`;
      this.botGlow.style.opacity = String(botGlowOpacity(State.effectiveState));
    } else {
      this.botGlow.style.display = "none";
    }
  }

  private drawBot(dt: number) {
    const size = this.botSize.value;
    const w = Math.max(1, Math.round(size));
    const hCss = w + BOT_OVERHANG;
    const wCss = w + BOT_SIDE * 2;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (this.canvasPx !== w) {
      this.canvasPx = w;
      this.botCanvas.width = Math.round(wCss * dpr);
      this.botCanvas.height = Math.round(hCss * dpr);
      // Exactly its pixels over the ratio: a canvas shown at any other size is
      // resampled, which is what made Tock look soft at 125 % scaling.
      this.botCanvas.style.width = `${this.botCanvas.width / dpr}px`;
      this.botCanvas.style.height = `${this.botCanvas.height / dpr}px`;
    }
    // A transform, not left/top: moving Tock costs no layout. Snapped to whole
    // device pixels, or the bitmap is filtered and its edges blur.
    const snap = (v: number) => Math.round(v * dpr) / dpr;
    this.botCanvas.style.transform = `translate(${snap(this.botCx.value - wCss / 2)}px, ${snap(this.botCy.value - BOT_OVERHANG / 2 - hCss / 2)}px)`;

    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;

    // Tock is amber: there are no pills left to take a colour from.
    this.engine.bodyColor = null;
    this.engine.particleOverhang = BOT_OVERHANG;
    this.engine.lookX = this.lookX();
    this.engine.lookY = this.lookY();
    if (this.engine.morph > 0.3) {
      this.engine.slotHTarget = State.fileDragOver ? 0.2 : 0;
    } else {
      this.engine.slotHTarget = 0;
      if (this.engine.morph < 0.05) {
        this.engine.slotH = 0;
        this.engine.slotHVel = 0;
      }
    }
    // Dances while music plays: always in the compact island, expanded only on
    // the music pill's card (BotCanvasView, macOS). Asked every frame.
    this.engine.setDancing(islandDances({
      music: State.spotifyPlaying,
      state: State.effectiveState,
      mode: State.mode,
      view: State.view,
      focusId: State.focusTask?.id,
    }));

    this.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, BOT_SIDE * dpr, 0);
    ctx.clearRect(-BOT_SIDE, 0, wCss, hCss);
    ctx.save();
    this.engine.applyDance(ctx, w, hCss);
    this.engine.draw(ctx, w, hCss);
    ctx.restore();
  }

  /** BotCanvasView.lookX / lookY — tanh of the distance to the bot. */
  private lookX(): number {
    const rect = this.islandRect();
    const botScreenX = rect.x + this.botCx.value;
    return Math.tanh((State.mouse.x - botScreenX) / 260);
  }

  private lookY(): number {
    return -Math.tanh((State.mouse.y - this.botCy.value) / 200);
  }

  private updateCountdown(nowMs: number) {
    // The state machine's own deadline, so the bar follows an auto-close delay
    // edited while the countdown runs.
    const dueAt = this.fsm.homeCollapseDueAt;
    if (State.mode !== "expanded" || State.isPinned || dueAt == null) {
      this.countdown.style.width = "0px";
      return;
    }
    const autoClose = this.fsm.homeToPetitDelay;
    const windowS = Math.min(10, autoClose * 0.6);
    const remaining = (dueAt - nowMs) / 1000;
    this.countdown.style.width =
      remaining < windowS ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * 160)}px` : "0px";
  }

  // ── DOM sync ────────────────────────────────────────────────────────────────

  private syncDom() {
    const expanded = State.mode === "expanded";
    const greetingActive = expanded && State.view === "greeting";

    const live = expanded && !greetingActive;
    this.contentEl.style.opacity = live ? "1" : "0";
    // While the drop sequence owns the body its buttons are painted on the canvas
    // underneath, so only the header may keep taking clicks up here.
    this.contentEl.style.pointerEvents = live && !this.uploadActive ? "auto" : "none";
    this.header.el.style.pointerEvents = live ? "auto" : "none";
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    // Leaving the greeting, however it ends, lets its sound fade out.
    if (this.greetingShown && !greetingActive) this.greeting.leave();
    this.greetingShown = greetingActive;

    this.header.sync();
    for (const [name, view] of this.views) {
      const on = name === State.view;
      view.el.classList.toggle("on", on);
      if (on) view.sync();
    }

    // The chat is the only view with a text field, so it is the only time the
    // island is allowed to take keyboard focus.
    if (this.lastSyncedView !== State.view) {
      const wasChat = this.lastSyncedView === "prompt";
      this.lastSyncedView = State.view;
      if (State.view === "prompt") {
        void Bridge.focusWindow(true);
        window.setTimeout(() => this.views.get("prompt")?.focus?.(), 120);
      } else if (wasChat) {
        void Bridge.focusWindow(false);
      }
    }

    // A live activity takes the mini grid's place while it lasts.
    this.live.sync(expanded);

    // Compact mini grid
    // Music: the mini player, unless a live activity is up (it comes back after).
    // The bar carries the track and the agents now (design/cue.html): the mini
    // player and the grid of mini Tocks stay off.
    const barOn = (State.mode === "compact" && !Live.current) || (expanded && State.view === "home");
    // LyricGlow singing: the letterbox takes the bar's place.
    const cinemaOn = this.cinemaOn();
    this.cinema.sync(cinemaOn);
    this.cueBar.el.style.opacity = (barOn && !cinemaOn) || State.mode === "hidden" ? "1" : "0";
    // Idle: the bar keeps only the time, beside Tock.
    this.cueBar.el.classList.toggle("idle", State.mode === "hidden");
    if (barOn) this.cueBar.sync();
    const showMini = false;
    this.mini.sync(showMini);
    // Lyrics being sung: the closed notch stays out while the song plays.
    this.fsm.keepOpen = barLyrics() && Spotify.state.playing && !CinemaPref.mini;
    if (State.mode === "compact") {
      const { w, h } = this.targetSize();
      if (w + h * 10000 !== this.compactW) {
        this.compactW = w + h * 10000;
        this.animateGeometry(false);
      }
    }
    // The agents' mini Cues stay beside the player: an agent at work (the
    // orange Claude Desktop one included) must still be seen while music plays.
    const showGrid = false;
    this.miniGrid.style.opacity = showGrid ? "1" : "0";
    if (showGrid) {
      const others = State.otherTasks.slice(0, 4);
      const key = others.map((t) => t.id).join("|");
      if (this.miniGrid.dataset.key !== key) {
        this.miniGrid.dataset.key = key;
        this.miniGrid.replaceChildren();
        for (const t of others) {
          this.miniGrid.append(createMiniBot(t, 13));
        }
        pruneMiniBots();
      }
    }

    syncMiniBotStates(State.tasks);
    this.engine.setState(State.effectiveState);
  }

  /** Applies settings coming from Rust at boot. */
  applySettings() {
    applyMotion(State.settings.plus?.motion);
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.openOnHover = State.settings.openOnHover;
    this.fsm.alwaysVisible = State.settings.plus?.alwaysVisible ?? false;
    // Already hidden when it was switched on: come back out.
    if (this.fsm.alwaysVisible && this.fsm.state === "hidden") this.fsm.reveal();
    State.notify();
  }

  get panelSize() {
    return { w: PANEL_W, h: PANEL_H };
  }

  get chatHeight() {
    return chatPromptHeight(State.chatHistory.length);
  }
}
