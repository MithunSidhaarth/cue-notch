// Cinema: while LyricGlow sings the song that is playing, the closed notch
// opens into a letterbox along the top of the screen and shows the song one
// word at a time, the sung word huge in the album's colours, the words before
// it drifting off to the left and the ones after it waiting on the right.
// Words held longer are drawn bigger. Everything moves every frame from
// Glow's clock (core/glow.ts); island.ts sizes the notch (CINEMA_W × CINEMA_H).

import { h } from "./dom";
import { Glow } from "../core/glow";
import { glowLineAt, wordProgress, type GlowWord } from "../core/moments";
import { Spotify, currentArtwork, formatTime } from "../core/spotify";
import { CINEMA_W } from "../core/layout";
import { tl } from "../i18n/i18n";

const SVG = "http://www.w3.org/2000/svg";
/** Words shown on each side of the sung one. */
const SIDE = 3;
/** Widest the sung word may be, in px, before it is drawn smaller. */
const WORD_MAX_W = 560;
/** How far ahead of the clock the words run, in seconds: the read, the frame and the eye all lag a little. */
const LEAD = 0.16;
const MINI_KEY = "cue.cinema-mini";

/** Whether the user folded Cinema back into the ordinary notch (kept in this PC's webview storage). */
export const CinemaPref = {
  get mini(): boolean {
    try {
      return localStorage.getItem(MINI_KEY) === "1";
    } catch {
      return false;
    }
  },
  toggle() {
    try {
      localStorage.setItem(MINI_KEY, this.mini ? "0" : "1");
    } catch {
      /* storage refused: nothing to keep */
    }
  },
};

/** The sung word's size: 64 px, up to 92 px for a held note, and never wider than the stage. */
export function cinemaWordSize(text: string, seconds: number): number {
  const held = Math.min(28, Math.max(0, (seconds - 0.3) * 36));
  const fit = WORD_MAX_W / (Math.max(1, text.length) * 0.8);
  return Math.round(Math.min(64 + held, fit));
}

/** The word being sung at `pos` (the last one started), 0 before the first. */
export function cinemaWordAt(words: GlowWord[], pos: number): number {
  let k = 0;
  for (let n = 0; n < words.length; n++) {
    if (words[n].start > pos + 0.04) break;
    k = n;
  }
  return k;
}

export function buildCinema(): { el: HTMLElement; fold: HTMLElement; sync(on: boolean): void } {
  const art = h("i", { class: "cin-art" });
  const meta = h("span", { class: "cin-meta hm-ell" });
  const time = h("span", { class: "cin-time" });
  // Folds Cinema back into the ordinary notch; island.ts takes the click (the band itself lets clicks through).
  const fold = h("i", { class: "cin-fold", title: tl("Minimise") });
  const past = h("div", { class: "cin-past" });
  const word = h("span", { class: "cin-word" });
  const now = h("div", { class: "cin-now" }, word);
  const next = h("div", { class: "cin-next" });
  const wave = document.createElementNS(SVG, "svg");
  wave.setAttribute("class", "cin-wave");
  wave.setAttribute("viewBox", `0 0 ${CINEMA_W} 22`);
  wave.setAttribute("preserveAspectRatio", "none");
  wave.setAttribute("aria-hidden", "true");
  wave.innerHTML =
    `<defs><linearGradient id="cin-g" x1="0" x2="1"><stop offset="0"/><stop offset="0.5"/><stop offset="1"/></linearGradient></defs>` +
    `<path fill="none" stroke="url(#cin-g)" stroke-width="1.6" stroke-linecap="round"/>`;
  const stops = wave.querySelectorAll("stop");
  const path = wave.querySelector("path") as SVGPathElement;
  const el = h(
    "div",
    { class: "cin" },
    h("div", { class: "cin-head" }, art, meta, time, fold),
    h("div", { class: "cin-stage" }, past, now, next),
    wave,
  );

  let on = false;
  let shown = "";
  let painted = -1;
  let colours = "";
  let phase = 0;
  let last = 0;
  let timeText = "";

  function paintColours() {
    const live = Glow.live();
    const a = live?.primary ?? "#ff2d95";
    const b = live?.secondary ?? live?.primary ?? "#7b5cff";
    if (a + b === colours) return;
    colours = a + b;
    el.style.setProperty("--lg-a", a);
    el.style.setProperty("--lg-b", b);
    stops[0].setAttribute("stop-color", a);
    stops[1].setAttribute("stop-color", b);
    stops[2].setAttribute("stop-color", a);
  }

  /** The words either side of the sung one, faded and shrunk by distance. */
  function side(list: string[], cls: string, fromEnd: boolean): HTMLElement[] {
    return list.map((t, n) => h("span", { class: `${cls} d${fromEnd ? list.length - n : n + 1}` }, t));
  }

  function frame(at: number) {
    if (!on) return;
    requestAnimationFrame(frame);
    const dt = last ? Math.min(0.1, (at - last) / 1000) : 0;
    last = at;
    paintColours();

    const live = Glow.live();
    const lines = Glow.lines;
    const pos = Glow.position(at) + LEAD;
    const i = glowLineAt(lines, pos);
    const l = i >= 0 ? lines[i] : null;
    const after = lines[i + 1];
    // A solo or a long breath: the dots, as in an interlude.
    const resting = !!l && !l.interlude && pos > l.end + 1.5 && (!after || after.start - pos > 3);
    const waiting = !live || live.state === "loading" || !l || l.interlude || resting;

    let energy = 0.15;
    if (waiting) {
      if (shown !== "wait") {
        shown = "wait";
        painted = -1;
        past.replaceChildren();
        next.replaceChildren();
        word.className = "cin-word cin-wait";
        word.style.fontSize = "";
        word.replaceChildren(...[0, 1, 2].map((n) => h("i", { style: `animation-delay:${n * 160}ms` })));
      }
    } else if (l) {
      const words = l.words.length ? l.words : [{ text: l.text, start: l.start, end: l.end }];
      const k = cinemaWordAt(words, pos);
      const key = `${i}|${l.start}|${k}`;
      if (key !== shown) {
        shown = key;
        painted = -1;
        const w = words[k];
        const text = w.text.toUpperCase();
        past.replaceChildren(...side(words.slice(Math.max(0, k - SIDE), k).map((x) => x.text), "cin-w", true));
        // The line runs out: the next line's first words wait after it.
        const ahead = side(words.slice(k + 1, k + 1 + SIDE).map((x) => x.text), "cin-w", false);
        if (ahead.length < SIDE && after && !after.interlude) {
          const more = side(after.text.split(/\s+/).filter(Boolean).slice(0, SIDE - ahead.length), "cin-w", false);
          more.forEach((m, n) => (m.className = `cin-w nl d${ahead.length + n + 1}`));
          ahead.push(...more);
        }
        next.replaceChildren(...ahead);
        word.replaceChildren(text);
        word.style.fontSize = `${cinemaWordSize(text, w.end - w.start)}px`;
        word.className = "cin-word";
        // Each word springs in at its own sung start (style.css).
        void word.offsetWidth;
        word.classList.add("pop");
      }
      const w = words[k];
      const p = Math.round(wordProgress([w], pos)[0] * 1000) / 1000;
      if (p !== painted) {
        painted = p;
        word.style.setProperty("--p", String(p));
      }
      energy = 0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, Math.max(0, p)));
    }

    // The wave moves with the singing: faster and taller while a word is sung.
    if (!document.documentElement.hasAttribute("data-rm")) phase += dt * (1.5 + 4 * energy);
    const amp = 1.5 + 6 * energy;
    let d = "";
    for (let x = 0; x <= CINEMA_W; x += 12) {
      const y = 11 + amp * Math.sin(x / 23 + phase) * Math.sin(x / 97 - phase * 0.3);
      d += `${x ? "L" : "M"}${x} ${y.toFixed(1)}`;
    }
    path.setAttribute("d", d);

    const track = Spotify.state.track;
    const t = track ? `${formatTime(pos)} / ${formatTime(track.duration)}` : "";
    if (t !== timeText) {
      timeText = t;
      time.textContent = t;
    }
  }

  return {
    el,
    fold,
    sync(want: boolean) {
      el.classList.toggle("on", want);
      const track = Spotify.state.track;
      const cover = currentArtwork();
      art.style.backgroundImage = cover ? `url("${cover}")` : "";
      meta.textContent = track ? `${track.title} · ${track.artist}` : "";
      if (want === on) return;
      on = want;
      if (on) {
        last = 0;
        shown = "";
        requestAnimationFrame(frame);
      }
    },
  };
}
