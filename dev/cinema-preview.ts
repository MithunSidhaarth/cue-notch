// The Cinema letterbox on a made-up song, without the island around it.
// `npm run dev`, then open /dev/cinema-preview.html (?t=seconds to hold a moment). Not shipped in the app.

import "../src/style.css";
import { buildCinema } from "../src/views/cinema";
import { Glow } from "../src/core/glow";
import { Spotify, SPOTIFY_ID } from "../src/core/spotify";
import type { GlowLine, GlowNow } from "../src/core/moments";

const TEXT = [
  "Turn it up till the walls start to glow",
  "Every heartbeat is a step we take",
  "Louder, louder, never let it go",
];
const lines: GlowLine[] = [];
let t = 1;
for (const text of TEXT) {
  const ws = text.split(" ");
  const total = ws.reduce((a, w) => a + w.length + 1.5, 0);
  let s = t;
  const words = ws.map((w) => {
    const d = (3.2 * (w.length + 1.5)) / total;
    const o = { text: w, start: s, end: s + d };
    s += d;
    return o;
  });
  lines.push({ text, interlude: false, start: t, end: t + 3.2, words });
  t += 3.8;
}
const loop = t + 1;
const hold = Number(new URLSearchParams(location.search).get("t") ?? NaN);
const now: GlowNow = { title: "Static Bloom", artist: "HALVRSN", position: 0, playing: true, state: "ok", primary: "#ff3fae", secondary: "#8a5cff" };
Spotify.state = {
  source: SPOTIFY_ID, app: "Spotify", running: true, installed: true, playing: true,
  track: { id: "x", title: "Static Bloom", artist: "HALVRSN", album: "", duration: 211, artUrl: null },
  position: 0, positionAt: Date.now(), shuffle: false, repeat: false, volume: 60,
};
Object.assign(Glow, { live: () => now, position: (at: number) => (Number.isFinite(hold) ? hold : (at / 1000) % loop), start: () => {} });
Object.defineProperty(Glow, "lines", { get: () => lines });

const cinema = buildCinema();
document.getElementById("island")!.append(cinema.el);
cinema.sync(true);
