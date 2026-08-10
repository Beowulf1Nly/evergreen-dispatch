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
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY_FILE = join(ROOT, "private", "tts-key.txt");
const BOARD = join(ROOT, "private", "board.json");
const OUT = join(ROOT, "brief.mp3");
const META = join(ROOT, "brief.json");

// Same order the app reads the board in, so the audio matches the screen.
function scriptFrom(board) {
  const parts = [];
  const h = new Date().getHours();
  parts.push((h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening") + ", Hunter.");
  if (board.assessment) parts.push(board.assessment);

  const groups = { overdue: "Overdue.", today: "Today." };
  for (const when of ["overdue", "today"]) {
    const qs = (board.quests || []).filter((q) => q.when === when);
    if (!qs.length) continue;
    parts.push(groups[when] + " " + qs.map((q) =>
      q.giver + ": " + q.objectives.map((o) => o.title).join(", ")).join(". ") + ".");
  }

  const qn = (board.questions || []).length;
  if (qn) {
    parts.push(`${qn} ${qn === 1 ? "thing needs" : "things need"} your call. ` +
      board.questions.map((q) => q.q).join(" "));
  }
  return parts.join(" ");
}

async function elevenlabs(key, text) {
  // Adam — the closest stock voice to what he's after. Swap the id to retune.
  const VOICE = "pNInz6obpgDQGcFmaJgB";
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: "eleven_turbo_v2_5",
      voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.25, use_speaker_boost: true },
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
  console.log(`  Voice: ${(audio.length / 1024).toFixed(0)} KB via ${provider} -> brief.mp3`);
}

main().catch((e) => { console.log("  Voice: " + e.message); });
