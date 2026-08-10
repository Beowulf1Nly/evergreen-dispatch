/**
 * Evergreen Dispatch — sync worker.
 *
 * The board is a static page on GitHub Pages, so it has nowhere to write. This
 * is the smallest thing that gives it one: a Cloudflare Worker over a KV
 * namespace holding a single shared overlay (what's ticked off, renamed,
 * hidden, reordered, and any notes dictated in the walkthrough).
 *
 * Every device reads and writes the same record, so completing a job on the
 * phone shows up on the PC, and the morning brief can see it too.
 *
 * AUTH — the device key already installed on each of Hunter's devices doubles
 * as the bearer token. It is 128 bits, never in the repo, and already required
 * to decrypt the board, so anything that can read the board can sync it and
 * nothing else can. No new secret to manage.
 *
 * MERGE — last-write-wins per field, by timestamp. Two devices ticking
 * different jobs both stick; the same job ticked twice keeps the later one.
 * Never blind-overwrite the whole record: that's how a phone that's been in a
 * pocket all afternoon wipes the morning's work.
 *
 * Deploy:
 *   wrangler kv namespace create DISPATCH
 *   wrangler secret put DEVICE_KEY      (paste private/devicekey.txt)
 *   wrangler deploy
 */

const KEY = "overlay";

const CORS = {
  "Access-Control-Allow-Origin": "https://beowulf1nly.github.io",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
  "Access-Control-Max-Age": "86400",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });

function authed(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim().toLowerCase();
  const expected = (env.DEVICE_KEY || "").trim().toLowerCase();
  if (!expected || token.length !== expected.length) return false;
  // Constant-time-ish compare so a wrong token can't be narrowed by timing.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function blank() {
  return { v: 1, done: {}, hidden: {}, titles: {}, order: {}, custom: [], notes: {}, stamps: {}, updated: 0 };
}

/**
 * Merge one incoming record into the stored one.
 * `stamps` carries a per-field millisecond timestamp; whichever side touched a
 * field more recently wins that field, so no device can trample another's work.
 */
function merge(base, incoming) {
  const out = { ...blank(), ...base };
  out.stamps = { ...(base.stamps || {}) };
  const inStamps = incoming.stamps || {};

  for (const bucket of ["done", "hidden", "titles", "notes"]) {
    out[bucket] = { ...(base[bucket] || {}) };
    for (const [id, val] of Object.entries(incoming[bucket] || {})) {
      const k = bucket + ":" + id;
      const mine = out.stamps[k] || 0;
      const theirs = inStamps[k] || incoming.updated || 0;
      if (theirs >= mine) {
        if (val === null || val === undefined) delete out[bucket][id];
        else out[bucket][id] = val;
        out.stamps[k] = theirs;
      }
    }
    // Deletions travel as explicit tombstones so an un-tick propagates too.
    for (const id of incoming["_del_" + bucket] || []) {
      const k = bucket + ":" + id;
      const theirs = inStamps[k] || incoming.updated || 0;
      if (theirs >= (out.stamps[k] || 0)) { delete out[bucket][id]; out.stamps[k] = theirs; }
    }
  }

  // Order and custom quests are whole-value fields — newest writer wins.
  if ((inStamps.order || 0) >= (out.stamps.order || 0) && incoming.order) {
    out.order = incoming.order;
    out.stamps.order = inStamps.order || incoming.updated || 0;
  }
  if ((inStamps.custom || 0) >= (out.stamps.custom || 0) && Array.isArray(incoming.custom)) {
    out.custom = incoming.custom;
    out.stamps.custom = inStamps.custom || incoming.updated || 0;
  }

  out.updated = Date.now();
  return out;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!authed(request, env)) return json({ error: "unauthorized" }, 401);

    const url = new URL(request.url);
    if (!url.pathname.startsWith("/state")) return json({ error: "not found" }, 404);

    if (request.method === "GET") {
      const stored = await env.DISPATCH.get(KEY, "json");
      return json(stored || blank());
    }

    if (request.method === "POST") {
      let incoming;
      try { incoming = await request.json(); }
      catch { return json({ error: "bad json" }, 400); }

      const stored = (await env.DISPATCH.get(KEY, "json")) || blank();
      const merged = merge(stored, incoming || {});
      await env.DISPATCH.put(KEY, JSON.stringify(merged));
      return json(merged);
    }

    return json({ error: "method not allowed" }, 405);
  },
};
