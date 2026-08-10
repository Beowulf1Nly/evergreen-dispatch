// Renders the spoken brief to brief.mp3 using a neural TTS service.
//
// Run by tools/publish.mjs. Silently does nothing if no key is configured, so
// the board still publishes and the app falls back to browser speech.
//
// The key lives in private/tts-key.txt (gitignored) as ONE line:
//
//     elevenlabs:sk-...
//     azure:<key>:<region>          e.g. azure:abc123:eastus
//     openai:sk-...
//
// It never reaches the browser and never enters the repo — the audio is
// rendered here and only the finished MP3 is published.

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY_FILE = join(ROOT, "private", "tts-key.txt");
const BOARD = join(ROOT, "private", "board.json");
const OUT = join(ROOT, "brief.mp3");
const META = join(ROOT, "brief.json");

// THE SHORT BRIEF ONLY — deliberately.
//
// The free tier is 10,000 characters a MONTH. The full rundown runs ~2,100
// characters, so rendering that would buy four briefs and then silence. This
// renders the headline instead (~300 chars): the one thing that matters, the
// count of what's behind it, and what needs deciding. The full walk-through is
// spoken by the browser, which is free and unlimited.
function scriptFrom(board) {
  const h = new Date().getHours();
  const parts = [(h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening") + ", Hunter."];

  const quests = board.quests || [];
  const overdue = quests.filter((q) => q.when === "overdue");
  const today = quests.filter((q) => q.when === "today");

  // Lead with the single highest-consequence thing, not a list.
  const lead = overdue.find((q) => q.tone === "critical")
    || today.find((q) => q.tone === "critical")
    || overdue[0] || today[0];

  if (lead) {
    const first = lead.objectives.find((o) => o) || {};
    parts.push(`First: ${lead.giver}. ${first.title}.`);
  }

  const counts = [];
  if (overdue.length) counts.push(`${overdue.length} overdue`);
  if (today.length) counts.push(`${today.length} due today`);
  if (counts.length) parts.push(`You have ${counts.join(" and ")}.`);

  const qn = (board.questions || []).length;
  if (qn) parts.push(`${qn} ${qn === 1 ? "thing needs" : "things need"} your call.`);

  parts.push("Tap full rundown for the rest.");
  return parts.join(" ");
}

// "Daniel" — British, deep, news-presenter. A *premade* voice, which matters:
// ElevenLabs blocks free accounts from using voice-LIBRARY voices over the API
// (402 paid_plan_required), and Hunter's first pick (yj30vwTGJxSHezdAGsv9) is a
// library voice. Premade voices work on the free tier. Restore his pick here if
// he ever upgrades. A voice id is public config, not a secret — only the key is.
// Override without touching code via private/tts-voice.txt.
const DEFAULT_VOICE = "onwK4e9ZLuTAKqWW03F9";

async function elevenlabs(key, text) {
  const VOICE_FILE = join(ROOT, "private", "tts-voice.txt");
  const VOICE = existsSync(VOICE_FILE)
    ? (await readFile(VOICE_FILE, "utf8")).trim() || DEFAULT_VOICE
    : DEFAULT_VOICE;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: "eleven_turbo_v2_5",
      voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.25, use_speaker_boost: true },
    }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    if (res.status === 401) throw new Error("ElevenLabs rejected the key (401). Check private/tts-key.txt holds your API key, not a voice id.");
    if (res.status === 404) throw new Error(`ElevenLabs doesn't recognise voice ${VOICE} (404). If it's a library voice, add it to your account first.`);
    if (res.status === 429) throw new Error("ElevenLabs quota exhausted (429) — the board still published, just without new audio.");
    throw new Error(`ElevenLabs ${res.status}: ${body}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function azure(key, region, text) {
  const tokRes = await fetch(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
    method: "POST", headers: { "Ocp-Apim-Subscription-Key": key },
  });
  if (!tokRes.ok) throw new Error(`Azure token ${tokRes.status}`);
  const token = await tokRes.text();

  const ssml = `<speak version='1.0' xml:lang='en-GB'>
    <voice name='en-GB-RyanNeural'>
      <prosody rate='-4%' pitch='-3%'>${text.replace(/[<&>]/g, "")}</prosody>
    </voice></speak>`;

  const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3",
    },
    body: ssml,
  });
  if (!res.ok) throw new Error(`Azure TTS ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function openai(key, text) {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "tts-1-hd", voice: "onyx", input: text, speed: 0.96 }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  if (!existsSync(KEY_FILE)) {
    console.log("  Voice: no private/tts-key.txt — using the browser voice.");
    return;
  }
  const raw = (await readFile(KEY_FILE, "utf8")).trim();
  const [provider, ...rest] = raw.split(":");
  const board = JSON.parse(await readFile(BOARD, "utf8"));
  const text = scriptFrom(board);

  // QUOTA GUARD. The board republishes many times an hour; a brief is ~2,000
  // characters and the ElevenLabs free tier is 10,000 a MONTH. Rendering on
  // every publish would exhaust it in a single day. So: only re-render when the
  // words actually changed, and never more than BUDGET_PER_DAY times daily.
  const BUDGET_PER_DAY = 6;        // generous — the real ceiling is monthly
  const MONTHLY_CHARS = 9200;      // headroom under the 10,000 free tier
  const LEDGER = join(ROOT, "private", ".voice-ledger.json");
  const scriptHash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  let ledger = { month, day: today, spent: 0, hash: "", chars: 0, monthChars: 0 };
  if (existsSync(LEDGER)) {
    try { ledger = { ...ledger, ...JSON.parse(await readFile(LEDGER, "utf8")) }; } catch {}
  }
  if (ledger.month !== month) { ledger.month = month; ledger.monthChars = 0; }
  if (ledger.day !== today) { ledger.day = today; ledger.spent = 0; }

  if (ledger.hash === scriptHash && existsSync(OUT)) {
    console.log("  Voice: brief unchanged — keeping the existing audio (0 characters spent).");
    return;
  }
  if (ledger.monthChars + text.length > MONTHLY_CHARS) {
    console.log(`  Voice: monthly budget spent (${ledger.monthChars}/${MONTHLY_CHARS} chars) — keeping the existing audio.`);
    return;
  }
  if (ledger.spent >= BUDGET_PER_DAY) {
    console.log(`  Voice: daily render cap reached (${ledger.spent}/${BUDGET_PER_DAY}) — keeping the existing audio.`);
    return;
  }

  let audio;
  try {
    if (provider === "elevenlabs") audio = await elevenlabs(rest.join(":"), text);
    else if (provider === "azure") audio = await azure(rest[0], rest[1] || "eastus", text);
    else if (provider === "openai") audio = await openai(rest.join(":"), text);
    else throw new Error(`unknown provider "${provider}" — use elevenlabs, azure or openai`);
  } catch (err) {
    // A voice failure must never block the board from publishing.
    console.log(`  Voice: FAILED (${err.message}) — falling back to the browser voice.`);
    return;
  }

  await writeFile(OUT, audio);
  await writeFile(META, JSON.stringify({
    provider, chars: text.length, built: new Date().toISOString(),
  }, null, 2) + "\n", "utf8");

  ledger = {
    month, day: today,
    spent: ledger.spent + 1,
    hash: scriptHash,
    monthChars: (ledger.monthChars || 0) + text.length,
  };
  await writeFile(LEDGER, JSON.stringify(ledger, null, 2) + "\n", "utf8");

  console.log(`  Voice: ${(audio.length / 1024).toFixed(0)} KB via ${provider} -> brief.mp3`);
  console.log(`         ${text.length} chars · ${ledger.monthChars}/${MONTHLY_CHARS} used this month`);
}

main().catch((e) => { console.log("  Voice: " + e.message); });
