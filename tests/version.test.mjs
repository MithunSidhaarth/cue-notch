// package.json is the version Tauri and pack.mjs read; Cargo's must agree.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("package.json and Cargo.toml carry the same version", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const cargo = readFileSync(new URL("../Cargo.toml", import.meta.url), "utf8");
  assert.equal(cargo.match(/^version = "(.+)"$/m)?.[1], pkg.version);
});
