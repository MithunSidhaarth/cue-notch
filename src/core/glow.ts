// LyricGlow (the full-screen lyrics app) over its loopback port: what it is
// playing, every line of the song, and a clock that runs smoothly between
// reads, so the words can be lit every frame instead of a few times a second.
// Shared by every view that shows the line; nothing leaves the PC.

import { Bridge } from "./bridge";
import { State } from "./state";
import { Spotify, isAd } from "./spotify";
import { GlowClock, glowMatches, type GlowLine, type GlowNow } from "./moments";

/** How often LyricGlow is asked while it answers, and while it does not. */
const FAST_MS = 250;
const SLOW_MS = 2000;

const clock = new GlowClock();
let now: GlowNow | null = null;
let lines: GlowLine[] = [];
let linesId = -1;
let linesKey = "";
let asking = false;
let wasLive = false;
let timer = 0;

function songKey(n: GlowNow): string {
  return `${n.title ?? ""}|${n.artist ?? ""}`;
}

/** Asks for every line once per set of lyrics; an older LyricGlow without /lyrics keeps to the line in /now. */
async function loadLines(n: GlowNow) {
  if (n.lyricsId == null || n.lyricsId === linesId) return;
  linesId = n.lyricsId;
  const all = await Bridge.lyricglowLyrics().catch(() => null);
  if (!all || all.lyricsId !== n.lyricsId) {
    linesId = -1;
    return;
  }
  lines = all.lines ?? [];
  linesKey = songKey(n);
}

async function ask() {
  if (asking) return;
  asking = true;
  const sent = performance.now();
  try {
    const n = await Bridge.lyricglowNow().catch(() => null);
    // The answer was read about halfway through the round trip.
    const readAt = (sent + performance.now()) / 2;
    if (!n || n.state === "idle") {
      now = null;
      clock.reset();
    } else {
      if (!now || songKey(now) !== songKey(n)) clock.reset();
      now = n;
      clock.update(n.position, n.playing, readAt);
      if (songKey(n) !== linesKey && n.lyricsId == null) lines = [];
      await loadLines(n);
    }
  } finally {
    asking = false;
  }
  const live = Glow.live() != null;
  if (live !== wasLive) {
    wasLive = live;
    State.notify();
  }
}

function schedule() {
  window.clearTimeout(timer);
  // Nothing to show while the notch is out of sight or nothing plays.
  const wanted = State.mode !== "hidden" && !!Spotify.state.track;
  const delay = wanted && now ? FAST_MS : SLOW_MS;
  timer = window.setTimeout(() => {
    if (wanted) void ask().finally(schedule);
    else schedule();
  }, delay);
}

export const Glow = {
  /** Starts asking LyricGlow; safe to call more than once. */
  start() {
    if (!timer) schedule();
  },

  /** LyricGlow's answer while it plays the same song as the notch, else null. */
  live(): GlowNow | null {
    const track = Spotify.state.track;
    if (!now || !track || isAd(track)) return null;
    return glowMatches(now, track.title, track.artist) ? now : null;
  },

  /** Every line of the song; just the line being sung when LyricGlow is older than 1.4. */
  get lines(): GlowLine[] {
    if (lines.length && now && songKey(now) === linesKey) return lines;
    return now?.line ? [now.line] : [];
  },

  /** Where the song is at `at` (performance.now), in seconds. Cheap enough for every frame. */
  position(at: number): number {
    return clock.read(at);
  },
};
