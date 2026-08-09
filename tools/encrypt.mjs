// Encrypts private/board.json -> data.enc.json
//
// The published GitHub Pages site contains ONLY the ciphertext. The passphrase
// lives in private/passphrase.txt, which .gitignore keeps out of the repo, and
// is never printed to the terminal — read it out of the file yourself.
//
//   node tools/encrypt.mjs
//
// PBKDF2-SHA256 (310k iterations, OWASP guidance) -> AES-256-GCM.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PASS_FILE = join(ROOT, "private", "passphrase.txt");
const DATA_FILE = join(ROOT, "private", "board.json");
const OUT_FILE = join(ROOT, "data.enc.json");

const ITERATIONS = 310_000;

// Ambiguous glyphs removed — this gets typed on a phone, in a truck.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generatePassphrase() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)]
    .map((g) => g.join(""))
    .join("-");
}

async function ensurePassphrase() {
  if (existsSync(PASS_FILE)) {
    const pass = (await readFile(PASS_FILE, "utf8")).trim();
    if (!pass) throw new Error(`${PASS_FILE} is empty — put your PIN in it or delete the file to have one generated.`);
    return pass;
  }
  await mkdir(join(ROOT, "private"), { recursive: true });
  const pass = generatePassphrase();
  await writeFile(PASS_FILE, pass + "\n", "utf8");
  console.log("\n  No passphrase found, so a strong one was generated.");
  console.log("  It was written to:  private/passphrase.txt");
  console.log("  Open that file to read it. It is deliberately not printed here,");
  console.log("  and .gitignore keeps it out of the repo.\n");
  return pass;
}

async function deriveKey(passphrase, salt) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
}

const b64 = (buf) => Buffer.from(buf).toString("base64");

async function main() {
  if (!existsSync(DATA_FILE)) {
    console.error(`\n  Missing ${DATA_FILE}\n  That file holds the plaintext board. Ask Claude to regenerate it.\n`);
    process.exit(1);
  }

  const passphrase = await ensurePassphrase();
  const plaintext = await readFile(DATA_FILE, "utf8");

  JSON.parse(plaintext); // fail loudly here rather than in the browser

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );

  await writeFile(
    OUT_FILE,
    JSON.stringify(
      {
        v: 1,
        kdf: "PBKDF2-SHA256",
        iterations: ITERATIONS,
        salt: b64(salt),
        iv: b64(iv),
        ct: b64(ciphertext),
        built: new Date().toISOString(),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const kb = (Buffer.byteLength(JSON.stringify({ ct: b64(ciphertext) })) / 1024).toFixed(1);
  console.log(`  Encrypted ${kb} KB -> data.enc.json`);
  console.log("  Safe to commit. It is unreadable without the passphrase.\n");
}

main().catch((err) => {
  console.error("\n  Encryption failed:", err.message, "\n");
  process.exit(1);
});
