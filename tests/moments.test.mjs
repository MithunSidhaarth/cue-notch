// The logic behind the notch's moments (src/core/moments.ts).
import test from "node:test";
import assert from "node:assert/strict";
import {
  Saved, buildReceipt, findOtp, formatRate, formatSpan, hideOtp, lyricAt, parseLrc, songLink,
} from "../src/core/moments.ts";

test("a one-time code is found only in a message that talks about one", () => {
  assert.equal(findOtp("Your verification code is 482913. Don't share it."), "482913");
  assert.equal(findOtp("G-123 456 is your Google login code"), "123456");
  assert.equal(findOtp("OTP 4821 for txn of Rs 1,250.00 at STORE"), "4821");
  assert.equal(findOtp("Flat 4021, call me when you reach"), null, "digits, but no code");
  assert.equal(findOtp("Your code will arrive shortly"), null, "a code, but no digits");
  assert.equal(findOtp("Use code 12345678901 to pay"), null, "a long number is not a code");
  assert.equal(hideOtp("Your login code is 482913"), "Your login code is ••••");
  assert.equal(hideOtp("see you at 7"), "see you at 7");
});

test("lyrics follow the position, and say nothing before the first line or in a pause", () => {
  const lines = parseLrc("[00:12.50]Waiting in a car\n[00:17.00]Waiting for a ride in the dark\n[00:25.00]\n[ar:M83]\nno stamp here");
  assert.deepEqual(lines.map((l) => l.at), [12.5, 17, 25]);
  assert.equal(lyricAt(lines, 3), "");
  assert.equal(lyricAt(lines, 12.5), "Waiting in a car");
  assert.equal(lyricAt(lines, 20), "Waiting for a ride in the dark");
  assert.equal(lyricAt(lines, 30), "");
  // One line sung twice carries two stamps.
  assert.deepEqual(parseLrc("[00:10.00][01:10.00]Again").map((l) => l.at), [10, 70]);
});

test("the heart saves a song once, whatever played it, and takes it out again", () => {
  Saved.items = [];
  const song = { title: "Midnight City", artist: "M83", app: "Spotify" };
  assert.equal(Saved.toggle(song, 1), true);
  assert.ok(Saved.has({ title: "midnight city", artist: "m83" }), "the same song in another player");
  assert.equal(Saved.items.length, 1);
  assert.equal(Saved.toggle({ ...song, app: "Opera" }, 2), false);
  assert.equal(Saved.items.length, 0);
  assert.match(songLink(song), /^https:\/\/open\.spotify\.com\/search\/Midnight%20City%20M83$/);
  assert.match(songLink({ ...song, app: "Apple Music" }), /^https:\/\/music\.apple\.com\/search\?term=/);
  assert.match(songLink({ ...song, app: "Opera" }), /^https:\/\/music\.youtube\.com\/search\?q=/);
});

test("a receipt counts files once, tests run, the time taken and a pull request", () => {
  const r = buildReceipt({
    diffs: [
      { path: "D:\\dev\\cue\\src\\home.ts", added: 40, removed: 7 },
      { path: "src/home.ts", added: 2, removed: 0 },
      { path: "src/style.css", added: 10, removed: 1 },
    ],
    steps: ["Read home.ts", "Runs · npm test", "Runs · cargo test --workspace", "Runs · git push"],
    finalLine: "Opened https://github.com/me/cue/pull/12 for review.",
    startedAt: 1_000,
    endedAt: 186_000,
  });
  assert.deepEqual(r.files, ["home.ts", "style.css"]);
  assert.deepEqual([r.added, r.removed, r.tests, r.seconds], [52, 8, 2, 185]);
  assert.equal(r.pr, "https://github.com/me/cue/pull/12");
  const bare = buildReceipt({ diffs: [], steps: [] });
  assert.deepEqual([bare.files.length, bare.tests, bare.seconds, bare.pr], [0, 0, null, null]);
  assert.deepEqual([formatSpan(42), formatSpan(185), formatSpan(4320)], ["42s", "3m 05s", "1h 12m"]);
});

test("transfer rates read short", () => {
  assert.equal(formatRate(870 * 1024), "870 KB/s");
  assert.equal(formatRate(1.4 * 1024 * 1024), "1.4 MB/s");
  assert.equal(formatRate(12 * 1024 * 1024), "12 MB/s");
  assert.equal(formatRate(1.5 * 1024 * 1024 * 1024), "1.5 GB/s");
});

test("LyricGlow's line runs on from when it was read, and lights words as they are sung", async () => {
  const { glowPosition, wordProgress, glowMatches } = await import("../src/core/moments.ts");
  const now = { position: 10, playing: true, state: "ok", title: "Party Girl", artist: "StaySolidRocky" };
  assert.equal(glowPosition(now, 1000, 1500), 10.5);
  assert.equal(glowPosition({ ...now, playing: false }, 1000, 1500), 10);
  const words = [{ text: "Party ", start: 10, end: 10.4 }, { text: "girl", start: 10.4, end: 11 }];
  assert.deepEqual(wordProgress(words, 10.2).map((p) => +p.toFixed(2)), [0.5, 0]);
  assert.deepEqual(wordProgress(words, 12), [1, 1]);
  assert.equal(glowMatches(now, "party girl", "StaySolidRocky"), true);
  assert.equal(glowMatches(now, "Party Girl", "StaySolidRocky, Lil Uzi Vert"), true);
  assert.equal(glowMatches(now, "Another Song", "StaySolidRocky"), false);
});

test("LyricGlow's clock runs smoothly between reads, eases out drift and takes a seek at once", async () => {
  const { GlowClock, glowLineAt } = await import("../src/core/moments.ts");
  const c = new GlowClock();
  c.update(10, true, 1000);
  assert.equal(c.read(1500), 10.5);
  // 40 ms of drift is eased out a quarter at a time, not jumped.
  c.update(10.54, true, 1500);
  assert.equal(c.read(1500), 10.51);
  // A seek is taken whole.
  c.update(60, true, 2000);
  assert.equal(c.read(2000), 60);
  // Paused, it holds still.
  c.update(61, false, 3000);
  assert.equal(c.read(9000), 61);

  const lines = [
    { text: "one", interlude: false, start: 5, end: 7, words: [] },
    { text: "two", interlude: false, start: 8, end: 9, words: [] },
  ];
  assert.equal(glowLineAt(lines, 2), -1);
  assert.equal(glowLineAt(lines, 4.9), 0, "a touch early");
  assert.equal(glowLineAt(lines, 7.5), 0);
  assert.equal(glowLineAt(lines, 20), 1);
});
