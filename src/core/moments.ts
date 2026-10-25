// Small pieces of logic behind the notch's moments: a one-time code in a text
// message, a synced lyric line, the songs saved with the heart, the receipt of
// a finished agent session, a transfer rate. Pure, so they are tested without
// a notch (tests/moments.test.mjs).

// ── One-time codes ───────────────────────────────────────────────────────────

const OTP_WORDS = /\b(code|otp|passcode|password|verification|verify|one[- ]time|pin|login|sign[- ]?in|2fa|security)\b/i;

/**
 * The one-time code in a text message, or null. Only a message that talks
 * about a code counts: "Flat 4021, call me" has four digits and is not one.
 */
export function findOtp(text: string): string | null {
  if (!OTP_WORDS.test(text)) return null;
  // 4 to 8 digits, alone or as "123 456" / "123-456"; not part of a longer number.
  const m = text.match(/(?<!\d)(?<!\d[.,\/-])(\d{3}[ -]\d{3}|\d{4,8})(?![\d\/-]|[.,]\d)/);
  return m ? m[1].replace(/[ -]/g, "") : null;
}

/** The message with its code hidden, for the inbox. */
export function hideOtp(text: string): string {
  const code = findOtp(text);
  if (!code) return text;
  return text.replace(/\d{3}[ -]\d{3}|\d{4,8}/, "••••");
}

// ── Lyrics ───────────────────────────────────────────────────────────────────

export interface LyricLine {
  /** Seconds from the start of the track. */
  at: number;
  text: string;
}

/** An LRC file ("[01:02.50] words") as lines in time order. Empty lines mark a pause. */
export function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const s of stamps) out.push({ at: Number(s[1]) * 60 + Number(s[2].replace(":", ".")), text });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The line being sung at `seconds`, or "" before the first one and in a pause. */
export function lyricAt(lines: LyricLine[], seconds: number): string {
  let current = "";
  for (const line of lines) {
    if (line.at > seconds) break;
    current = line.text;
  }
  return current;
}

// ── LyricGlow ────────────────────────────────────────────────────────────────

/** One sung word, in seconds from the start of the track. */
export interface GlowWord {
  text: string;
  start: number;
  end: number;
}

/** What LyricGlow (the full-screen lyrics app) answers on its loopback port. */
export interface GlowNow {
  title?: string | null;
  artist?: string | null;
  position: number;
  playing: boolean;
  /** idle, loading, none (no lyrics for this song) or ok. */
  state: string;
  line?: { text: string; interlude: boolean; start: number; end: number; words: GlowWord[] } | null;
  primary?: string;
  secondary?: string;
}

/** LyricGlow's position at `at` (ms), run forward from when it was read at `readAt` (ms). */
export function glowPosition(now: GlowNow, readAt: number, at: number): number {
  return now.playing ? now.position + Math.max(0, at - readAt) / 1000 : now.position;
}

/** How much of each word has been sung at `seconds`, from 0 to 1. */
export function wordProgress(words: GlowWord[], seconds: number): number[] {
  return words.map((w) => {
    if (seconds <= w.start) return 0;
    if (w.end <= w.start || seconds >= w.end) return 1;
    return (seconds - w.start) / (w.end - w.start);
  });
}

/** True when LyricGlow is reporting the same song the notch is showing. */
export function glowMatches(now: GlowNow, title: string, artist: string): boolean {
  const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return norm(now.title) === norm(title) && (norm(now.artist) === norm(artist) || norm(artist).startsWith(norm(now.artist)));
}

// ── Saved songs ──────────────────────────────────────────────────────────────

export interface SavedSong {
  title: string;
  artist: string;
  /** The player it was heard in ("Spotify", "Opera"…). */
  app: string;
  at: number;
}

const SAVED_KEY = "cue.saved-songs";
const sameSong = (a: { title: string; artist: string }, b: { title: string; artist: string }) =>
  a.title.toLowerCase() === b.title.toLowerCase() && a.artist.toLowerCase() === b.artist.toLowerCase();

function read(): SavedSong[] {
  try {
    const raw = globalThis.localStorage?.getItem(SAVED_KEY);
    return raw ? (JSON.parse(raw) as SavedSong[]) : [];
  } catch {
    return [];
  }
}

// ponytail: Cue's own list on this PC. No player lets another app press its
// heart (Spotify needs a signed-in API, Apple Music and YouTube offer none), so
// the list works the same for all of them; a Spotify login could mirror it later.
export const Saved = {
  items: read(),
  has(song: { title: string; artist: string }): boolean {
    return this.items.some((x) => sameSong(x, song));
  },
  /** Saves the song, or takes it out if it was saved. True when it is saved now. */
  toggle(song: Omit<SavedSong, "at">, now = Date.now()): boolean {
    const had = this.has(song);
    this.items = had ? this.items.filter((x) => !sameSong(x, song)) : [{ ...song, at: now }, ...this.items].slice(0, 200);
    try {
      globalThis.localStorage?.setItem(SAVED_KEY, JSON.stringify(this.items));
    } catch {
      // Storage off: the list lives until Cue quits.
    }
    return !had;
  },
};

/** Where to hear a saved song again: a search in the service it came from. */
export function songLink(song: { title: string; artist: string; app: string }): string {
  const q = encodeURIComponent(`${song.title} ${song.artist}`.trim());
  const app = song.app.toLowerCase();
  if (app.includes("spotify")) return `https://open.spotify.com/search/${q}`;
  if (app.includes("apple") || app.includes("itunes")) return `https://music.apple.com/search?term=${q}`;
  return `https://music.youtube.com/search?q=${q}`;
}

// ── A finished session's receipt ─────────────────────────────────────────────

export interface Receipt {
  files: string[];
  added: number;
  removed: number;
  /** Test commands the session ran. */
  tests: number;
  /** Seconds from the prompt to the end of the turn, or null when not seen. */
  seconds: number | null;
  /** A pull request it mentioned, if any. */
  pr: string | null;
}

const TEST_COMMAND = /\b(npm (run )?test|pnpm (run )?test|yarn test|cargo test|pytest|go test|vitest|jest|dotnet test|mvn test|gradle test|node --test)\b/i;
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

export function buildReceipt(o: {
  diffs: { path: string; added: number; removed: number }[];
  steps: string[];
  finalLine?: string | null;
  startedAt?: number | null;
  endedAt?: number | null;
}): Receipt {
  const files = [...new Set(o.diffs.map((d) => d.path.replace(/\\/g, "/").split("/").pop() ?? d.path))];
  const text = [...o.steps, o.finalLine ?? ""].join("\n");
  return {
    files,
    added: o.diffs.reduce((n, d) => n + d.added, 0),
    removed: o.diffs.reduce((n, d) => n + d.removed, 0),
    tests: o.steps.filter((s) => TEST_COMMAND.test(s)).length,
    seconds: o.startedAt && o.endedAt && o.endedAt >= o.startedAt ? Math.round((o.endedAt - o.startedAt) / 1000) : null,
    pr: text.match(PR_URL)?.[0] ?? null,
  };
}

/** "42s", "3m 05s", "1h 12m". */
export function formatSpan(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

// ── Transfers ────────────────────────────────────────────────────────────────

/** Bytes a second, short: "850 KB/s", "12 MB/s", "1.4 GB/s". */
export function formatRate(bytesPerSecond: number): string {
  const kb = bytesPerSecond / 1024;
  if (kb < 1000) return `${Math.round(kb)} KB/s`;
  const mb = kb / 1024;
  if (mb < 100) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB/s`;
  return mb < 1000 ? `${Math.round(mb)} MB/s` : `${(mb / 1024).toFixed(1)} GB/s`;
}

/** A transfer worth a blip: a megabyte a second down, or half that up. */
export const BIG_DOWN = 1024 * 1024;
export const BIG_UP = 512 * 1024;

// ── What the notch remembers between frames ──────────────────────────────────

/** The last session that finished, for the Agents page. */
export const Receipts = {
  last: null as (Receipt & { name: string; at: number }) | null,
  /** When each session's turn began (ms), by pill id. */
  started: new Map<string, number>(),
};

/** A pop the user did not open the notch for: it stays as a dot in the bar. */
export const Missed = {
  items: [] as { text: string; failed: boolean; at: number }[],
  add(text: string, failed: boolean, now = Date.now()) {
    this.items = [...this.items, { text, failed, at: now }].slice(-4);
  },
  clear() {
    this.items = [];
  },
};

/** What the phone last said about itself (its battery, through the iPhone Shortcut). */
export const PhoneInfo = { battery: null as number | null, at: 0 };

/** "battery 82", "Battery: 82%": the phone reporting its charge through the bridge. */
export function phoneBattery(text: string): number | null {
  const m = text.trim().match(/^battery\D{0,3}(\d{1,3})\s*%?$/i);
  const n = m ? Number(m[1]) : NaN;
  return n >= 0 && n <= 100 ? n : null;
}
