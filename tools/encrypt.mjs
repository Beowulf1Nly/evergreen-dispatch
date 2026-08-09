// Encrypts private/board.json -> data.enc.json
//
//   node tools/encrypt.mjs
//
// THE KEY IS IN TWO PARTS, and both are required to decrypt:
//
//   1. private/pin.txt        the short PIN Hunter types        (e.g. 0726)
//   2. private/devicekey.txt  a 128-bit random device key       (never typed)
//
// The device key rides in the URL fragment of the setup link. A fragment is
// never sent to the server and never appears in the repo, so the published
// ciphertext is useless to anyone who merely finds the GitHub Pages URL.
// That is what makes a 4-digit PIN safe here: on its own it unlocks nothing.
//
// PBKDF2-SHA256 (310k iterations) -> AES-256-GCM.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE = join(ROOT, "private");
const PIN_FILE = join(PRIVATE, "pin.txt");
const DEVKEY_FILE = join(PRIVATE, "devicekey.txt");
const LINK_FILE = join(PRIVATE, "setup-link.txt");
const DATA_FILE = join(PRIVATE, "board.json");
const OUT_FILE = join(ROOT, "data.enc.json");

const ITERATIONS = 310_000;
const SITE = "https://beowulf1nly.github.io/evergreen-dispatch/";

async function readOrCreate(path, make, label) {
  if (existsSync(path)) {
    const v = (await readFile(path, "utf8")).trim();
    if (v) return v;
  }
  await mkdir(PRIVATE, { recursive: true });
  const v = make();
  await writeFile(path, v + "\n", "utf8");
  console.log(`  Generated a new ${label} -> ${path.replace(ROOT, ".")}`);
  return v;
}

const randomHex = (bytes) =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");

async function deriveKey(passphrase, salt) {
  const material = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    material, { name: "AES-GCM", length: 256 }, false, ["encrypt"]
  );
}

const b64 = (buf) => Buffer.from(buf).toString("base64");

async function main() {
  if (!existsSync(DATA_FILE)) {
    console.error(`\n  Missing ${DATA_FILE}\n  Ask Claude to rebuild the board from Pocket.\n`);
    process.exit(1);
  }

  const pin = await readOrCreate(PIN_FILE, () => "0726", "PIN");
  const deviceKey = await readOrCreate(DEVKEY_FILE, () => randomHex(16), "device key");

  if (deviceKey.length < 24) {
    console.error("\n  Device key looks too short to be safe. Delete private/devicekey.txt and re-run.\n");
    process.exit(1);
  }

  const passphrase = `${pin}:${deviceKey}`;
  const plaintext = await readFile(DATA_FILE, "utf8");
  JSON.parse(plaintext); // fail here, not in the browser

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)
  );

  await writeFile(OUT_FILE, JSON.stringify({
    v: 2,
    kdf: "PBKDF2-SHA256",
    iterations: ITERATIONS,
    salt: b64(salt),
    iv: b64(iv),
    ct: b64(ciphertext),
    built: new Date().toISOString(),
  }, null, 2) + "\n", "utf8");

  await writeFile(LINK_FILE,
    `Open this link ONCE on each device (phone, PC), then add it to your home screen.\n` +
    `The device remembers the key and strips it from the address bar. After that you\n` +
    `only ever type your PIN.\n\n` +
    `${SITE}#k=${deviceKey}\n\n` +
    `Treat this link like a house key — anyone who has BOTH it and your PIN can read\n` +
    `the board. It is gitignored and never published.\n`,
    "utf8");

  console.log(`  Encrypted ${(Buffer.byteLength(b64(ciphertext)) / 1024).toFixed(1)} KB -> data.enc.json`);
  console.log(`  Setup link written to private/setup-link.txt\n`);
}

main().catch((err) => {
  console.error("\n  Encryption failed:", err.message, "\n");
  process.exit(1);
});
