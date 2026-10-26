// The Cinema letterbox's sizing and word timing (src/views/cinema.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { cinemaWordAt, cinemaWordSize } from "../src/views/cinema.ts";

const words = [
  { text: "Turn", start: 1, end: 1.4 },
  { text: "it", start: 1.4, end: 1.6 },
  { text: "up", start: 1.6, end: 2.6 },
];

test("the sung word is the last one started", () => {
  assert.equal(cinemaWordAt(words, 0), 0, "before the first word");
  assert.equal(cinemaWordAt(words, 1.2), 0);
  assert.equal(cinemaWordAt(words, 1.5), 1);
  assert.equal(cinemaWordAt(words, 9), 2, "after the last word");
});

test("held notes are drawn bigger, long words smaller", () => {
  assert.equal(cinemaWordSize("UP", 0.2), 64);
  assert.equal(cinemaWordSize("UP", 2), 92, "capped");
  assert.ok(cinemaWordSize("UP", 0.8) > 64);
  assert.ok(cinemaWordSize("EXTRAORDINARILY", 2) < 64, "fits the stage");
});
