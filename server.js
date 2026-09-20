// Waypoint edit-log server: Express + Postgres (Tiger Data / TimescaleDB).
//
//   npm install
//   cp .env.example .env      # paste your Tiger Data connection string into DATABASE_URL
//   npm start                 # then open http://localhost:3000
//
// It serves explorer.html / map-picker.html / config.js from this folder and exposes a small API that
// explorer.html uses to store the edit log in the database. The connection string never reaches the browser.

import express from "express";
import pg from "pg";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Be forgiving if the key was pasted into .env as JavaScript (const GEMINI_API_KEY = "...";): use it, but say how to tidy it.
if (!process.env.GEMINI_API_KEY) {
  try {
    const txt = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    const m = txt.match(/^\s*(?:const\s+|let\s+|export\s+)?GEMINI_API_KEY\s*[=:]\s*["'`]?\s*([^"'`\s;,]+)/m);
    if (m) {
      process.env.GEMINI_API_KEY = m[1];
      console.warn('Note: GEMINI_API_KEY in .env is not in plain NAME=value form. Using it anyway - tidy it to:  GEMINI_API_KEY=...');
    }
  } catch { /* no .env next to server.js */ }
}

// ---------- database ----------
let DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env and paste your Tiger Data connection string.");
  process.exit(1);
}
const isLocal = /@(localhost|127\.0\.0\.1)([:/]|$)/.test(DATABASE_URL) || /host=(localhost|\/)/.test(DATABASE_URL);
// pg lets ?sslmode= in the URL override the ssl option, so drop it and set ssl ourselves
try { const u = new URL(DATABASE_URL); u.searchParams.delete("sslmode"); DATABASE_URL = u.toString(); } catch { /* keep as is */ }
const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: isLocal ? false : { rejectUnauthorized: false }, max: 5 });
pool.on("error", (err) => console.error("Postgres pool error:", err.message));

let hasTimescale = false;

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scenes (
      scene_key  text PRIMARY KEY,               -- "lat,lng,radius" exactly as the explorer builds it
      lat double precision, lng double precision, radius integer,
      base       jsonb NOT NULL,                 -- scene state before the first logged edit
      state      jsonb,                          -- scene state after the latest edit
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS edits (
      ts         timestamptz NOT NULL,
      scene_key  text NOT NULL,
      entry_id   text NOT NULL,                  -- client-generated, makes retries idempotent
      action     text NOT NULL,                  -- delete | replace_model | place_model | rotate | resize | revert | undo | import | reset
      target_id  text,
      label      text,
      at_x double precision, at_z double precision,
      state      jsonb NOT NULL,                 -- scene state right after this edit (used for revert / replay)
      session_id text,
      delta      jsonb,                          -- just what this edit changed (teammates apply it live)
      created_at timestamptz NOT NULL DEFAULT now()   -- when the server stored it (live sync polls on this, not the client clock)
    )`);
  // tables made by an earlier version of this server get the new columns too
  await pool.query("ALTER TABLE edits ADD COLUMN IF NOT EXISTS delta jsonb");
  await pool.query("ALTER TABLE edits ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()");
  try {
    // Tiger Data already has the extension; the CREATE may be refused for a non-superuser, which is fine
    await pool.query("CREATE EXTENSION IF NOT EXISTS timescaledb").catch(() => {});
    await pool.query("SELECT create_hypertable('edits', 'ts', if_not_exists => TRUE, migrate_data => TRUE)");
    hasTimescale = true;
  } catch (e) {
    console.warn("TimescaleDB not available here (" + e.message + ") - using a plain Postgres table. Tiger Data has it built in.");
  }
  // unique indexes on a hypertable must include the time column
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS edits_entry_uniq ON edits (scene_key, entry_id, ts)");
  await pool.query("CREATE INDEX IF NOT EXISTS edits_scene_ts ON edits (scene_key, ts DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS edits_scene_created ON edits (scene_key, created_at)");
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: "5mb" }));
app.use((req, res, next) => {   // lets explorer.html opened from another origin (e.g. VS Code Live Server) use ?api=http://localhost:3000
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => { console.error(req.method, req.path, err); res.status(500).json({ error: err.message }); });
const SCENE_RE = /^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?,\d{1,5}$/;
const sceneOf = (v) => (typeof v === "string" && SCENE_RE.test(v) ? v : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

app.get("/api/health", wrap(async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true, timescale: hasTimescale });
}));

// Save one edit (and the scene row it belongs to). Safe to call twice with the same entry.
app.post("/api/edit", wrap(async (req, res) => {
  const { scene, center, radius, base, session, entry } = req.body || {};
  const key = sceneOf(scene);
  if (!key || !isObj(base) || !isObj(entry) || typeof entry.id !== "string" || !isObj(entry.state))
    return res.status(400).json({ error: "bad request" });
  const ts = new Date(entry.ts);
  if (Number.isNaN(ts.getTime())) return res.status(400).json({ error: "bad timestamp" });
  const at = Array.isArray(entry.at) ? entry.at : [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO scenes (scene_key, lat, lng, radius, base, state) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (scene_key) DO UPDATE SET state = $6, updated_at = now()`,
      [key, num(center?.[0]), num(center?.[1]), Number.isInteger(radius) ? radius : null, base, entry.state]);
    await client.query(
      `INSERT INTO edits (ts, scene_key, entry_id, action, target_id, label, at_x, at_z, state, session_id, delta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (scene_key, entry_id, ts) DO NOTHING`,
      [ts, key, entry.id.slice(0, 80), String(entry.action || "edit").slice(0, 40), entry.targetId ? String(entry.targetId).slice(0, 120) : null,
       String(entry.label || "").slice(0, 300), num(at[0]), num(at[1]), entry.state, typeof session === "string" ? session.slice(0, 80) : null,
       isObj(entry.delta) ? entry.delta : null]);
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { client.release(); }
}));

// The saved log of a scene: { base, entries: [oldest ... newest], cursor }. Long logs are trimmed to the latest 500,
// with `base` moved forward so revert and replay still line up.
// With ?since=<cursor> it returns only what was stored after that point (this is what live polling uses),
// oldest first, plus a new cursor. Cursors are server times, so teammates' clocks don't matter.
const LOG_LIMIT = 500, POLL_LIMIT = 200;
const entryOut = (r) => ({
  id: r.entry_id, ts: r.ts.toISOString(), action: r.action, targetId: r.target_id, label: r.label,
  at: r.at_x === null || r.at_z === null ? null : [r.at_x, r.at_z], state: r.state, delta: r.delta, session: r.session_id
});
app.get("/api/log", wrap(async (req, res) => {
  const key = sceneOf(req.query.scene);
  if (!key) return res.status(400).json({ error: "bad scene" });
  const COLS = "ts, created_at, entry_id, action, target_id, label, at_x, at_z, state, delta, session_id";
  if (req.query.since) {
    const since = new Date(req.query.since);
    if (Number.isNaN(since.getTime())) return res.status(400).json({ error: "bad since" });
    // 2 s of overlap so an edit that committed a moment late is never missed; the client skips ones it already has
    const { rows } = await pool.query(
      `SELECT ${COLS} FROM edits WHERE scene_key = $1 AND created_at > $2::timestamptz - interval '2 seconds'
       ORDER BY created_at, ts LIMIT $3`, [key, since, POLL_LIMIT]);
    const cursor = rows.length ? rows[rows.length - 1].created_at.toISOString() : since.toISOString();
    return res.json({ entries: rows.map(entryOut), cursor });
  }
  const scene = await pool.query("SELECT base FROM scenes WHERE scene_key = $1", [key]);
  const cur = await pool.query("SELECT COALESCE(max(created_at), now()) AS c FROM edits WHERE scene_key = $1", [key]);
  const cursor = cur.rows[0].c.toISOString();
  if (!scene.rowCount) return res.json({ base: null, entries: [], cursor });
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM edits WHERE scene_key = $1 ORDER BY ts DESC, entry_id DESC LIMIT $2`, [key, LOG_LIMIT + 1]);
  rows.reverse();
  let base = scene.rows[0].base;
  if (rows.length > LOG_LIMIT) base = rows.shift().state;
  res.json({ base, entries: rows.map(entryOut), cursor });
}));

app.delete("/api/log", wrap(async (req, res) => {
  const key = sceneOf(req.query.scene);
  if (!key) return res.status(400).json({ error: "bad scene" });
  await pool.query("DELETE FROM edits WHERE scene_key = $1", [key]);
  await pool.query("DELETE FROM scenes WHERE scene_key = $1", [key]);
  res.json({ ok: true });
}));

// Edits per minute for a scene (charts / demo). On Tiger Data you could swap date_trunc for time_bucket.
app.get("/api/activity", wrap(async (req, res) => {
  const key = sceneOf(req.query.scene);
  if (!key) return res.status(400).json({ error: "bad scene" });
  const { rows } = await pool.query(
    `SELECT date_trunc('minute', ts) AS minute, count(*)::int AS edits FROM edits WHERE scene_key = $1 GROUP BY 1 ORDER BY 1`, [key]);
  res.json(rows.map((r) => ({ minute: r.minute.toISOString(), edits: r.edits })));
}));

// Every scene that has saved edits, newest first (the map picker lists these so you can jump back into them).
app.get("/api/scenes", wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 50);
  const { rows } = await pool.query(
    `SELECT s.scene_key, s.lat, s.lng, s.radius, count(e.*)::int AS edits, max(e.ts) AS last_ts,
            (array_agg(e.label ORDER BY e.ts DESC))[1] AS last_label
     FROM scenes s JOIN edits e ON e.scene_key = s.scene_key
     GROUP BY s.scene_key, s.lat, s.lng, s.radius ORDER BY last_ts DESC LIMIT $1`, [limit]);
  res.json(rows.map((r) => ({ scene: r.scene_key, lat: r.lat, lng: r.lng, radius: r.radius, edits: r.edits, lastTs: r.last_ts.toISOString(), lastLabel: r.last_label })));
}));

// Latest edits across every scene (a live feed for the demo).
app.get("/api/recent", wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const { rows } = await pool.query(
    `SELECT ts, scene_key, action, label, session_id FROM edits ORDER BY ts DESC LIMIT $1`, [limit]);
  res.json(rows.map((r) => ({ ts: r.ts.toISOString(), scene: r.scene_key, action: r.action, label: r.label, session: r.session_id })));
}));

// ---------- AI: restyle the buildings near the player (Gemini) ----------
// explorer.html sends the closest few buildings (name, size, a few OpenStreetMap tags); one Gemini call returns a small JSON
// "look" for each (materials, colours, glazing...) which the explorer applies. The API key stays here on the server.
const GEMINI_MODELS = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : ["gemini-2.5-flash"];
const MAX_BUILDINGS = 12;

const LOOK_KEYS = `{
  "material": one of "brick" | "concrete" | "glass" | "metal" | "stone" | "stucco" | "wood" | "mixed",
  "wallColor": main wall colour as "#rrggbb" (the wall surface itself, not glass, not sky),
  "roofColor": roof colour as "#rrggbb" or null if unknown,
  "glazing": fraction 0..1 of the facade area that is glass (0.1 = few small windows, 0.4 = big windows, 0.85 = glass curtain wall),
  "windowStyle": one of "punched" (separate window openings in a solid wall) | "ribbon" (continuous horizontal window bands) | "curtain" (almost fully glass) | "none",
  "windowTint": glass colour as "#rrggbb",
  "frameColor": window frame / mullion colour as "#rrggbb",
  "roofShape": one of "flat" | "gabled" | "hipped" | "dome" | "other" | null,
  "storeys": integer number of visible floors, or null if unsure,
  "confidence": 0..1, how sure you are (0.2-0.5 when guessing, 0.7+ only when you clearly recognise the building),
  "notes": one short sentence
}`;

const LOOK_PROMPT = (list) => `You are helping make a 3D map of the University of Waterloo / Kitchener-Waterloo area (Ontario, Canada) look like the real place.
Below are buildings from OpenStreetMap. For EACH one, describe the EXTERIOR of the real building as you know it: use its name and location if you recognise it,
otherwise infer the typical look from its type, size and tags (a plain guess is fine, with a low confidence).
Buildings:
${list.map((b) => JSON.stringify(b)).join("\n")}
Return ONLY a JSON object of the form {"buildings": {"<id>": LOOK, ...}} with one LOOK for every id above, where LOOK is exactly:
${LOOK_KEYS}
No markdown, no commentary, JSON only.`;

const hex = (v) => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim().toLowerCase() : null);
const oneOf = (v, list) => (typeof v === "string" && list.includes(v.toLowerCase()) ? v.toLowerCase() : null);
const clamp01 = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);

function cleanLook(raw) {
  if (!isObj(raw)) return null;
  const storeys = Number.isFinite(raw.storeys) ? Math.round(raw.storeys) : null;
  return {
    material: oneOf(raw.material, ["brick", "concrete", "glass", "metal", "stone", "stucco", "wood", "mixed"]),
    wallColor: hex(raw.wallColor),
    roofColor: hex(raw.roofColor),
    glazing: clamp01(raw.glazing),
    windowStyle: oneOf(raw.windowStyle, ["punched", "ribbon", "curtain", "none"]),
    windowTint: hex(raw.windowTint),
    frameColor: hex(raw.frameColor),
    roofShape: oneOf(raw.roofShape, ["flat", "gabled", "hipped", "dome", "other"]),
    storeys: storeys && storeys >= 1 && storeys <= 80 ? storeys : null,
    confidence: clamp01(raw.confidence) ?? 0.5,
    notes: typeof raw.notes === "string" ? raw.notes.slice(0, 200) : ""
  };
}

function parseJsonLoose(text) {
  let t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* ignore */ } }
  return null;
}

const shortStr = (v, n) => (typeof v === "string" ? v.slice(0, n) : undefined);

app.post("/api/restyle-nearby", wrap(async (req, res) => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(503).json({ error: "GEMINI_API_KEY is not set in .env (create one at https://aistudio.google.com/apikey), then restart the server." });
  const input = Array.isArray(req.body?.buildings) ? req.body.buildings.slice(0, MAX_BUILDINGS) : [];
  const list = [];
  for (const b of input) {
    if (!isObj(b) || typeof b.id !== "string" || !/^[\w-]{1,40}$/.test(b.id)) continue;
    const tags = {};
    if (isObj(b.tags)) for (const [k, v] of Object.entries(b.tags).slice(0, 14)) if (/^[a-z:_]{1,30}$/.test(k) && typeof v === "string" && v.length <= 60) tags[k] = v;
    list.push({ id: b.id, name: shortStr(b.name, 80) || null, type: shortStr(b.type, 40) || null,
      heightMetres: Number.isFinite(b.heightMetres) ? Math.round(b.heightMetres) : null,
      footprintM2: Number.isFinite(b.areaM2) ? Math.round(b.areaM2) : null, tags });
  }
  if (!list.length) return res.status(400).json({ error: "buildings (a non-empty list) is required" });
  const prompt = LOOK_PROMPT(list);

  let lastErr = "no model tried";
  for (const model of GEMINI_MODELS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60000);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, responseMimeType: "application/json" }
        }),
        signal: ctl.signal
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = data?.error?.message || r.statusText;
        lastErr = `Gemini error ${r.status}: ${msg}`;
        if (r.status === 401 || r.status === 403) lastErr = "Gemini rejected the API key. Check GEMINI_API_KEY in .env.";
        if (r.status === 429) lastErr = "Gemini rate limit or quota hit (429). Wait a bit, or enable billing at aistudio.google.com.";
        if (r.status === 404) continue;   // model name not available: try the next one
        return res.status(502).json({ error: lastErr });
      }
      const candidate = data?.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text || "";
      const parsed = parseJsonLoose(text);
      const map = isObj(parsed?.buildings) ? parsed.buildings : isObj(parsed) ? parsed : {};
      const looks = {};
      for (const b of list) { const l = cleanLook(map[b.id]); if (l) looks[b.id] = l; }
      if (!Object.keys(looks).length) {
        const why = candidate?.finishReason && candidate.finishReason !== "STOP" ? candidate.finishReason : "unreadable answer";
        return res.status(502).json({ error: `Gemini did not return usable descriptions (${why}). Try again.` });
      }
      return res.json({ looks, model });
    } catch (e) {
      lastErr = e.name === "AbortError" ? "Gemini timed out" : "Could not reach Gemini: " + e.message;
    } finally { clearTimeout(timer); }
  }
  res.status(502).json({ error: lastErr });
}));

// ---------- static files (only these three, so .env and server.js can never be served) ----------
for (const f of ["explorer.html", "map-picker.html", "config.js"]) {
  app.get("/" + f, (req, res) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(__dirname, f), (err) => { if (err && !res.headersSent) res.status(404).send("Not found: " + f); });
  });
}
app.get("/", (req, res) => res.redirect("/map-picker.html"));

// ---------- start ----------
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || "127.0.0.1";   // set HOST=0.0.0.0 to let other devices on your network in
initSchema()
  .then(() => app.listen(PORT, HOST, () => {
    console.log(`Waypoint server ready: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}  (database connected${hasTimescale ? ", TimescaleDB hypertable on" : ", plain Postgres"})`);
    console.log(process.env.GEMINI_API_KEY
  ? "Gemini key: found (AI restyle is ready)"
  : `Gemini key: NOT FOUND - add a line  GEMINI_API_KEY=...  to ${path.join(process.cwd(), ".env")}  (no 'const', no quotes), save, and restart.`);
  }))
  .catch((err) => { console.error("Could not connect to / set up the database:", err.message); process.exit(1); });