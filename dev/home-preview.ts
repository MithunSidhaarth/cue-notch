// The Home page on sample data, without the island's springs around it.
// `npm run dev`, then open /dev/home-preview.html. Not shipped in the app.

import "../src/style.css";
import { buildCueBar, buildHome } from "../src/views/home";
import { State } from "../src/core/state";
import { Spotify, SPOTIFY_ID } from "../src/core/spotify";
import { Inbox, Todos } from "../src/core/extras";
import { TockEngine } from "../src/avatar/tock";
import type { ViewActions } from "../src/views/views";

const noop = () => {};
const actions = new Proxy({}, { get: () => noop }) as ViewActions;

Spotify.state = {
  source: SPOTIFY_ID, app: "Spotify", running: true, installed: true, playing: true,
  track: { id: "spotify:track:1", title: "Midnight City", artist: "M83", album: "", duration: 243, artUrl: null },
  position: 98, positionAt: Date.now(), shuffle: false, repeat: false, volume: 60,
};
State.tasks = [
  { id: "agent_claude", name: "Claude Code", color: "#D97757", state: "idle", stepIndex: 0, steps: [], source: "hook", isIntegration: false },
  { id: "agent_codex", name: "Codex", color: "#2DD4BF", state: "working", stepIndex: 2, steps: ["Read src/island/island.ts", "Edit home.ts +42 −7", "npm test"], source: "hook", isIntegration: false },
] as typeof State.tasks;
State.chatHistory = [
  { id: 1, role: "user", content: "Book a table for two at 7 and text Aarav." },
  { id: 2, role: "assistant", content: "On it. Hermes is finding a table near you. I'll call you back with options." },
];
Todos.items = [
  { id: 1, text: "Send invoice", done: true },
  { id: 2, text: "Call mom", done: false },
  { id: 3, text: "Renew passport", done: false },
];

Inbox.items = [
  { kind: "message", who: "Aarav", body: "are we still on for 7?", at: Date.now() - 20_000 },
  { kind: "message", who: "Priya", body: "Sent the slides", at: Date.now() - 12 * 60_000 },
  { kind: "call", who: "Mom", body: "", at: Date.now() - 4 * 60_000 },
];
Inbox.unseen = 2;

State.mode = "expanded";
State.view = "home";

const home = buildHome(actions);
home.el.classList.add("on");
document.getElementById("views")!.append(home.el);
const cueBar = buildCueBar();
document.getElementById("island")!.append(cueBar.el);
cueBar.sync();

// Tock in the bar: the island draws its own there.
const bar = document.getElementById("bar-tock") as HTMLCanvasElement;
const tock = new TockEngine();
const ctx = bar.getContext("2d")!;

home.sync();
// ?page=media and so on: open that tab.
const want = new URLSearchParams(location.search).get("page");
if (want) [...document.querySelectorAll<HTMLElement>(".hm-tab")].find((b) => b.textContent?.toLowerCase() === want)?.click();
setInterval(() => {
  home.tick?.(performance.now());
  tock.update(0.016);
  ctx.clearRect(0, 0, 44, 30);
  tock.draw(ctx, 44, 30);
}, 16);
