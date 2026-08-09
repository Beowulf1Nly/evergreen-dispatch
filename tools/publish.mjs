// One command to put a fresh board live:  node tools/publish.mjs
//
//   1. encrypt private/board.json -> data.enc.json
//   2. commit, but only if the ciphertext actually changed
//   3. push, so GitHub Pages redeploys
//
// Claude regenerates private/board.json from Pocket before calling this.
// Nothing here ever touches private/passphrase.txt except to read it.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "private", "board.json");
const HASH_FILE = join(ROOT, "private", ".lasthash");

function git(...args) {
  return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();
}

// Every encrypt run draws a fresh salt and IV, so the ciphertext differs even when
// nothing about the day changed. Compare the plaintext instead. The hash lives in
// private/ rather than in data.enc.json so the public file leaks nothing at all.
if (!existsSync(SRC)) {
  console.error(`\n  Missing ${SRC} — ask Claude to rebuild the board from Pocket first.\n`);
  process.exit(1);
}
const srcHash = createHash("sha256").update(readFileSync(SRC)).digest("hex");
const lastHash = existsSync(HASH_FILE) ? readFileSync(HASH_FILE, "utf8").trim() : "";

if (srcHash === lastHash && !git("status", "--porcelain", "--", "data.enc.json")) {
  console.log("  Board is unchanged since the last publish. Nothing to do.\n");
  process.exit(0);
}

function step(label, fn) {
  try {
    return fn();
  } catch (err) {
    const detail = (err.stderr || err.stdout || err.message || "").toString().trim();
    console.error(`\n  ${label} failed:\n  ${detail.split("\n").join("\n  ")}\n`);
    process.exit(1);
  }
}

// 1. encrypt
step("encrypt", () =>
  execFileSync(process.execPath, [join(ROOT, "tools", "encrypt.mjs")], { stdio: "inherit" })
);

// 2. commit
const stamp = new Date().toLocaleString("en-US", {
  timeZone: "America/New_York",
  dateStyle: "medium",
  timeStyle: "short",
});

step("git commit", () => {
  git("add", "--", "data.enc.json");
  git("commit", "-m", `Board update — ${stamp}`);
});

// 3. push
step("git push", () => git("push"));

writeFileSync(HASH_FILE, srcHash + "\n", "utf8");

console.log(`\n  Published. Pages redeploys in about a minute.`);
console.log(`  https://beowulf1nly.github.io/evergreen-dispatch/\n`);
