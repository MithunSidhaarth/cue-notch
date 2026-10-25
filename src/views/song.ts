// What sits on a player beside its controls: the heart that saves the song,
// the Lyrics switch, and the line being sung. Used by the Home tile and the
// Media page; the logic is in core/moments.ts.
//
// When LyricGlow (the full-screen lyrics app) is running, the line comes from
// it instead (core/glow.ts): word-synced, lit word by word in the album's
// colour on every animation frame, with no request leaving the PC. The ring
// button opens LyricGlow.

import { h, svg } from "./dom";
import { State, DEFAULT_PLUS } from "../core/state";
import { Bridge } from "../core/bridge";
import { Spotify, isAd, playerName, spotifyPosition } from "../core/spotify";
import { Saved, glowLineAt, lyricAt, parseLrc, wordProgress, type GlowNow, type LyricLine } from "../core/moments";
import { Glow } from "../core/glow";
import { tl } from "../i18n/i18n";

const HEART = "M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z";
const LINES = "M5 7h14M5 12h10M5 17h12";
const RING = "M12 4.5a7.5 7.5 0 1 1 0 15a7.5 7.5 0 1 1 0-15zM12 10.6a1.4 1.4 0 1 1 0 2.8a1.4 1.4 0 1 1 0-2.8z";

/** The lyrics of the track that is playing, shared by every player on screen. */
const sheet = { key: "", lines: [] as LyricLine[] };

function lyricsOn(): boolean {
  return State.settings.plus?.lyrics === true;
}

/** Asks for the track's lyrics once, when the switch is on. */
function ensureLyrics() {
  const track = Spotify.state.track;
  const key = track && !isAd(track) && lyricsOn() ? `${track.title}|${track.artist}` : "";
  if (key === sheet.key) return;
  sheet.key = key;
  sheet.lines = [];
  if (!key || !track) return;
  void Bridge.lyrics(track.title, track.artist, track.album, track.duration).then((lrc) => {
    // Another song may have started while this one's lyrics were on their way.
    if (sheet.key !== key) return;
    sheet.lines = lrc ? parseLrc(lrc) : [];
    State.notify();
  });
}

export interface SongExtras {
  /** The heart and the Lyrics switch, to lay over the cover. */
  buttons: HTMLElement;
  /** The line being sung. */
  line: HTMLElement;
  sync(): void;
  /** Called a few times a second while the player is on screen. */
  tick(): void;
}

export function buildSongExtras(blip: () => void): SongExtras {
  const heart = h("button", { class: "hm-heart", title: tl("Save this song"), onclick: () => {
    const s = Spotify.state;
    if (!s.track || isAd(s.track)) return;
    blip();
    Saved.toggle({ title: s.track.title, artist: s.track.artist, app: playerName(s) });
    State.notify();
  } }, svg(HEART, 15, { stroke: 1.9 }));
  const lyricsBtn = h("button", { class: "hm-heart", title: tl("Lyrics"), onclick: () => {
    blip();
    State.settings.plus = { ...DEFAULT_PLUS, ...State.settings.plus, lyrics: !lyricsOn() };
    void Bridge.saveSettings(State.settings);
    State.notify();
  } }, svg(LINES, 15, { stroke: 2 }));
  const glowBtn = h("button", { class: "hm-heart hm-glow-btn", title: tl("Open LyricGlow"), onclick: () => {
    blip();
    void Bridge.lyricglowOpen();
  } }, svg(RING, 15, { stroke: 2, evenOdd: true }));
  glowBtn.style.display = "none";
  const line = h("div", { class: "hm-lyric hm-ell" });
  let shown = "";
  let words: HTMLElement[] = [];
  let painted: number[] = [];
  let glowMode = false;
  Glow.start();

  /** LyricGlow's line, a span per word, so each one can light up as it is sung. */
  function showGlow(now: GlowNow) {
    const lines = Glow.lines;
    const pos = Glow.position(performance.now());
    const i = glowLineAt(lines, pos);
    const l = i >= 0 ? lines[i] : null;
    // Between lines for a while (a solo, a long breath): the dots, as in an interlude.
    const next = lines[i + 1];
    const resting = !!l && !l.interlude && pos > l.end + 1.5 && (!next || next.start - pos > 3);
    const waiting = now.state === "loading" || !!l?.interlude || resting;
    const key = waiting ? "wait" : now.state === "ok" && l ? `${i}|${l.start}|${l.text}` : `state:${now.state}`;
    line.style.setProperty("--lg-a", now.primary ?? "#ff2d95");
    line.style.setProperty("--lg-b", now.secondary ?? now.primary ?? "#7b5cff");
    if (key !== shown) {
      shown = key;
      line.replaceChildren();
      words = [];
      line.classList.toggle("wait", waiting);
      if (waiting) {
        line.append(...[0, 1, 2].map((n) => h("span", { class: "hm-lg-dot", style: `animation-delay:${n * 140}ms` }, "•")));
      } else if (now.state === "ok" && l && l.text) {
        words = l.words.length
          ? l.words.map((w) => h("span", { class: "hm-lg-w" }, w.text))
          : [h("span", { class: "hm-lg-w" }, l.text)];
        line.append(...words);
      }
      line.classList.remove("in");
      void line.offsetWidth;
      line.classList.add("in");
      painted = [];
    }
    if (!words.length || !l) return;
    const timed = l.words.length ? l.words : [{ text: l.text, start: l.start, end: l.end }];
    const progress = wordProgress(timed, pos);
    words.forEach((el, n) => {
      // Only what changed is written: a style write per word per frame is wasted work.
      const p = Math.round(progress[n] * 1000) / 1000;
      if (painted[n] === p) return;
      painted[n] = p;
      el.style.setProperty("--p", String(p));
    });
  }

  /** While LyricGlow's line is on screen it is drawn every frame, not only when the island ticks. */
  let frameOn = false;
  const frame = () => {
    const live = glowMode ? Glow.live() : null;
    if (!live || !line.isConnected || line.offsetParent === null) {
      frameOn = false;
      return;
    }
    showGlow(live);
    requestAnimationFrame(frame);
  };

  return {
    buttons: h("div", { class: "hm-song-btns" }, glowBtn, lyricsBtn, heart),
    line,
    sync() {
      const track = Spotify.state.track;
      heart.classList.toggle("on", !!track && Saved.has(track));
      heart.style.display = track && !isAd(track) ? "" : "none";
      const live = Glow.live();
      glowBtn.style.display = live ? "" : "none";
      lyricsBtn.style.display = live ? "none" : "";
      lyricsBtn.classList.toggle("on", lyricsOn());
      line.style.display = live || lyricsOn() ? "" : "none";
      if (!live) ensureLyrics();
    },
    tick() {
      const live = Glow.live();
      line.classList.toggle("hm-lg", !!live);
      glowBtn.style.display = live ? "" : "none";
      lyricsBtn.style.display = live ? "none" : "";
      if (live) {
        glowMode = true;
        line.style.display = "";
        if (!frameOn) {
          frameOn = true;
          requestAnimationFrame(frame);
        }
        return;
      }
      if (glowMode) {
        // LyricGlow went away: back to Cue's own line.
        glowMode = false;
        words = [];
        shown = "";
        line.replaceChildren();
        line.classList.remove("wait");
        line.style.display = lyricsOn() ? "" : "none";
        ensureLyrics();
      }
      if (!lyricsOn()) return;
      const s = Spotify.state;
      // A touch early: the line should be up as it is sung, not after.
      const text = s.track && sheet.lines.length ? lyricAt(sheet.lines, spotifyPosition(s, Date.now()) + 0.3) : "";
      if (text === shown) return;
      shown = text;
      line.textContent = text;
      // A new line slides in (style.css; stands still under reduced motion).
      line.classList.remove("in");
      void line.offsetWidth;
      line.classList.add("in");
    },
  };
}
