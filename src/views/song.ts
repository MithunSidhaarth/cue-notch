// What sits on a player beside its controls: the heart that saves the song,
// the Lyrics switch, and the line being sung. Used by the Home tile and the
// Media page; the logic is in core/moments.ts.

import { h, svg } from "./dom";
import { State, DEFAULT_PLUS } from "../core/state";
import { Bridge } from "../core/bridge";
import { Spotify, isAd, playerName, spotifyPosition } from "../core/spotify";
import { Saved, lyricAt, parseLrc, type LyricLine } from "../core/moments";
import { tl } from "../i18n/i18n";

const HEART = "M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z";
const LINES = "M5 7h14M5 12h10M5 17h12";

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
  const line = h("div", { class: "hm-lyric hm-ell" });
  let shown = "";

  return {
    buttons: h("div", { class: "hm-song-btns" }, lyricsBtn, heart),
    line,
    sync() {
      const track = Spotify.state.track;
      heart.classList.toggle("on", !!track && Saved.has(track));
      heart.style.display = track && !isAd(track) ? "" : "none";
      lyricsBtn.classList.toggle("on", lyricsOn());
      line.style.display = lyricsOn() ? "" : "none";
      ensureLyrics();
    },
    tick() {
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
