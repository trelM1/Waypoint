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
import crypto from "node:crypto";
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

// Same forgiveness for the Baseten settings (BASETEN_API_KEY / BASETEN_MODEL_ID)
for (const name of ["BASETEN_API_KEY", "BASETEN_MODEL_ID"]) {
  if (process.env[name]) continue;
  try {
    const txt = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    const m = txt.match(new RegExp("^\\s*(?:const\\s+|let\\s+|export\\s+)?" + name + "\\s*[=:]\\s*[\"'`]?\\s*([^\"'`\\s;,]+)", "m"));
    if (m) { process.env[name] = m[1]; console.warn(`Note: ${name} in .env is not in plain NAME=value form. Using it anyway - tidy it to:  ${name}=...`); }
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
  // imported 3D models (.glb): the file itself is kept here so teammates get the same buildings
  await pool.query(`
    CREATE TABLE IF NOT EXISTS models (
      sha256     text PRIMARY KEY,               -- content hash: the same file uploaded twice is stored once
      name       text NOT NULL,                  -- file name as imported, e.g. engineering_7.glb
      size_bytes integer NOT NULL,
      data       bytea NOT NULL,
      scene_key  text,                           -- the scene it was first imported into
      session_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await pool.query("CREATE INDEX IF NOT EXISTS models_name_created ON models (name, created_at DESC)");
  // unique indexes on a hypertable must include the time column
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS edits_entry_uniq ON edits (scene_key, entry_id, ts)");
  await pool.query("CREATE INDEX IF NOT EXISTS edits_scene_ts ON edits (scene_key, ts DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS edits_scene_created ON edits (scene_key, created_at)");
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: "14mb" }));   // the image-to-3D route receives a base64 photo
app.use((req, res, next) => {   // lets explorer.html opened from another origin (e.g. VS Code Live Server) use ?api=http://localhost:3000
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Expose-Headers", "X-Model-Format");
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

// ---------- AI: restyle the buildings near the player (Gemini, photo-aware with a text-only fallback) ----------
const GEMINI_MODELS = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : ["gemini-3.6-flash", "gemini-2.5-flash"];
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

const PHOTO_PROMPT = (b, n) => `You are looking at ${n} real street photo(s) of the same building near the University of Waterloo / Kitchener-Waterloo (Ontario, Canada).
Known info: ${JSON.stringify({ name: b.name, type: b.type, heightMetres: b.heightMetres, tags: b.tags })}
Describe the building's EXTERIOR based mainly on what the photo(s) actually show, using the known info only as extra context.
Return ONLY compact JSON, exactly this shape:
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

// One shared call path (with model + brief retry fallback) for both the text batch and per-building vision calls.
async function callGemini(parts) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set in .env (create one at https://aistudio.google.com/apikey), then restart the server.");
  let lastErr = "no model tried";
  const attempts = GEMINI_MODELS.flatMap((m) => [m, m]);
  for (let i = 0; i < attempts.length; i++) {
    const model = attempts[i];
    if (i > 0 && attempts[i] === attempts[i - 1]) await new Promise((r) => setTimeout(r, 1200));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60000);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.4, responseMimeType: "application/json" } }),
        signal: ctl.signal
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = data?.error?.message || r.statusText;
        lastErr = `Gemini error ${r.status}: ${msg}`;
        if (r.status === 401 || r.status === 403) lastErr = "Gemini rejected the API key. Check GEMINI_API_KEY in .env.";
        if (r.status === 429) lastErr = "Gemini rate limit or quota hit (429). Wait a bit, or enable billing at aistudio.google.com.";
        if (r.status === 404 || r.status === 429 || r.status === 503) continue;
        throw new Error(lastErr);
      }
      const candidate = data?.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text || "";
      const parsed = parseJsonLoose(text);
      if (!parsed) { lastErr = "unreadable answer"; continue; }
      return { parsed, model };
    } catch (e) {
      if (e.name === "AbortError") lastErr = "Gemini timed out";
      else if (!lastErr.startsWith("Gemini")) lastErr = "Could not reach Gemini: " + e.message;
    } finally { clearTimeout(timer); }
  }
  throw new Error(lastErr);
}

async function urlToInlineImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("photo fetch HTTP " + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const mimeType = res.headers.get("content-type") || "image/jpeg";
  return { inline_data: { mime_type: mimeType, data: buf.toString("base64") } };
}

async function analyzePhotoLook(b) {
  const images = await Promise.all(b.photos.map(urlToInlineImage));
  const { parsed } = await callGemini([{ text: PHOTO_PROMPT(b, images.length) }, ...images]);
  return cleanLook(parsed);
}

const shortStr = (v, n) => (typeof v === "string" ? v.slice(0, n) : undefined);

app.post("/api/restyle-nearby", wrap(async (req, res) => {
  const input = Array.isArray(req.body?.buildings) ? req.body.buildings.slice(0, MAX_BUILDINGS) : [];
  const list = [];
  for (const b of input) {
    if (!isObj(b) || typeof b.id !== "string" || !/^[\w-]{1,40}$/.test(b.id)) continue;
    const tags = {};
    if (isObj(b.tags)) for (const [k, v] of Object.entries(b.tags).slice(0, 14)) if (/^[a-z:_]{1,30}$/.test(k) && typeof v === "string" && v.length <= 60) tags[k] = v;
    const photos = Array.isArray(b.photos) ? b.photos.filter((u) => typeof u === "string" && /^https?:\/\//.test(u)).slice(0, 3) : [];
    list.push({ id: b.id, name: shortStr(b.name, 80) || null, type: shortStr(b.type, 40) || null,
      heightMetres: Number.isFinite(b.heightMetres) ? Math.round(b.heightMetres) : null,
      footprintM2: Number.isFinite(b.areaM2) ? Math.round(b.areaM2) : null, tags, photos });
  }
  if (!list.length) return res.status(400).json({ error: "buildings (a non-empty list) is required" });

  const withPhotos = list.filter((b) => b.photos.length);
  const withoutPhotos = list.filter((b) => !b.photos.length);
  const looks = {};
  let usedModel = null;

  try {
    for (const b of withPhotos) {   // sequential: keeps quota usage predictable, and these are already capped by MAX_BUILDINGS
      try {
        const look = await analyzePhotoLook(b);
        if (look) looks[b.id] = look;
      } catch (e) { console.warn("Photo-based look failed for", b.id, e.message); }
    }
    if (withoutPhotos.length) {
      const { parsed, model } = await callGemini([{ text: LOOK_PROMPT(withoutPhotos) }]);
      usedModel = model;
      const map = isObj(parsed?.buildings) ? parsed.buildings : isObj(parsed) ? parsed : {};
      for (const b of withoutPhotos) { const l = cleanLook(map[b.id]); if (l) looks[b.id] = l; }
    }
  } catch (e) {
    if (!Object.keys(looks).length) return res.status(502).json({ error: e.message });
    // partial success (e.g. photo-based looks worked, the text batch failed): still return what we have
  }

  if (!Object.keys(looks).length) return res.status(502).json({ error: "Gemini did not return usable descriptions. Try again." });
  res.json({ looks, model: usedModel || "gemini (photo-based)" });
}));


// ---------- imported 3D models (.glb) are stored here so every teammate sees the same buildings ----------
const MODEL_NAME_RE = /^[\w .()+-]{1,120}\.(glb|gltf)$/i;
const MODEL_MAX = 25 * 1024 * 1024;
const looksLikeModel = (b) => b.length > 20 && (b.subarray(0, 4).toString("latin1") === "glTF" || b[0] === 0x7b);   // binary glTF, or a .gltf JSON file

// upload: raw file bytes in the body, ?name=file.glb&scene=lat,lng,radius&session=...
app.post("/api/models", express.raw({ type: () => true, limit: MODEL_MAX }), wrap(async (req, res) => {
  const name = String(req.query.name || "");
  if (!MODEL_NAME_RE.test(name)) return res.status(400).json({ error: "name must be a .glb or .gltf file name" });
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!looksLikeModel(body)) return res.status(400).json({ error: "that does not look like a glTF/GLB file" });
  const sha = crypto.createHash("sha256").update(body).digest("hex");
  const r = await pool.query(
    `INSERT INTO models (sha256, name, size_bytes, data, scene_key, session_id) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (sha256) DO NOTHING`,
    [sha, name, body.length, body, sceneOf(req.query.scene), typeof req.query.session === "string" ? req.query.session.slice(0, 80) : null]);
  res.json({ ok: true, sha256: sha, name, size: body.length, existed: r.rowCount === 0 });
}));

// the shared library: newest first (file contents are not included)
app.get("/api/models", wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT sha256, name, size_bytes, scene_key, session_id, created_at FROM models ORDER BY created_at DESC LIMIT 100`);
  res.json(rows.map((r) => ({ sha256: r.sha256, name: r.name, size: r.size_bytes, scene: r.scene_key, session: r.session_id, ts: r.created_at.toISOString() })));
}));

// download: the newest file with that name (?name=), or one exact file (?sha=)
app.get("/api/models/file", wrap(async (req, res) => {
  const sha = typeof req.query.sha === "string" && /^[0-9a-f]{64}$/.test(req.query.sha) ? req.query.sha : null;
  const name = typeof req.query.name === "string" ? req.query.name : null;
  if (!sha && !name) return res.status(400).json({ error: "name or sha is required" });
  const { rows } = sha
    ? await pool.query("SELECT sha256, name, data FROM models WHERE sha256 = $1", [sha])
    : await pool.query("SELECT sha256, name, data FROM models WHERE name = $1 ORDER BY created_at DESC LIMIT 1", [name]);
  if (!rows.length) return res.status(404).json({ error: "no such model" });
  res.set({ "Content-Type": "application/octet-stream", "X-Model-Sha": rows[0].sha256, "Access-Control-Expose-Headers": "X-Model-Sha", "Cache-Control": "no-store" });
  res.send(rows[0].data);
}));

// remove a model from the shared library: every stored copy with that name (?name=), or one exact file (?sha=)
app.delete("/api/models", wrap(async (req, res) => {
  const sha = typeof req.query.sha === "string" && /^[0-9a-f]{64}$/.test(req.query.sha) ? req.query.sha : null;
  const name = typeof req.query.name === "string" ? req.query.name : null;
  if (!sha && !name) return res.status(400).json({ error: "name or sha is required" });
  const r = sha
    ? await pool.query("DELETE FROM models WHERE sha256 = $1", [sha])
    : await pool.query("DELETE FROM models WHERE name = $1", [name]);
  res.json({ ok: true, deleted: r.rowCount });
}));

// ---------- image -> 3D building (Baseten) ----------
// converter.html sends a photo here; we forward it to a model deployed on Baseten (see baseten-truss/) and hand the
// resulting .glb back. The Baseten key stays on the server, and Baseten's API cannot be called from a browser anyway.
const basetenUrl = () => {
  const id = (process.env.BASETEN_MODEL_ID || "").trim();
  if (process.env.BASETEN_URL) return process.env.BASETEN_URL.trim();           // full override, e.g. a dedicated deployment URL
  const env = (process.env.BASETEN_ENVIRONMENT || "production").trim();
  return `https://model-${id}.api.baseten.co/environments/${env}/predict`;
};
const basetenConfigured = () => !!(process.env.BASETEN_API_KEY && (process.env.BASETEN_MODEL_ID || process.env.BASETEN_URL));

app.get("/api/baseten-status", (req, res) => res.json({ configured: basetenConfigured() }));

const b64ToBuf = (s) => Buffer.from(String(s).replace(/^data:[^,]*,/, ""), "base64");
const findFirst = (obj, keys) => { for (const k of keys) if (obj && obj[k] != null && obj[k] !== "") return [k, obj[k]]; return null; };

// Turn whatever the deployed model returned into { bytes, format }. Accepts a raw GLB body, or JSON such as
// { glb_base64 } / { model_base64, format } / { model_url } / { output: {...} }.
async function readBasetenModel(r) {
  const ctype = r.headers.get("content-type") || "";
  if (!/json|text/i.test(ctype)) {
    const bytes = Buffer.from(await r.arrayBuffer());
    const format = bytes.slice(0, 4).toString() === "glTF" ? "glb" : (r.headers.get("x-model-format") || "obj");
    return { bytes, format };
  }
  let j = await r.json();
  if (typeof j === "string") { try { j = JSON.parse(j); } catch { /* plain string */ } }
  if (j && typeof j === "object" && j.output && typeof j.output === "object") j = j.output;
  if (j && typeof j === "object" && j.data && typeof j.data === "object") j = j.data;
  if (typeof j === "string") j = { model_base64: j };
  if (j && typeof j.error === "string" && j.error) throw new Error(j.error);
  const glb = findFirst(j, ["glb_base64", "glb"]);
  if (glb) return { bytes: b64ToBuf(glb[1]), format: "glb" };
  const any = findFirst(j, ["model_base64", "model", "mesh_base64", "mesh", "obj_base64", "obj", "base64"]);
  if (any) {
    const bytes = b64ToBuf(any[1]);
    const format = bytes.slice(0, 4).toString() === "glTF" ? "glb" : String(j.format || (any[0].startsWith("obj") ? "obj" : "obj")).toLowerCase();
    return { bytes, format };
  }
  const url = findFirst(j, ["model_url", "glb_url", "url", "mesh_url"]);
  if (url && /^https:\/\//i.test(url[1])) {
    const m = await fetch(url[1]);
    if (!m.ok) throw new Error(`Could not download the generated model (HTTP ${m.status}).`);
    const bytes = Buffer.from(await m.arrayBuffer());
    return { bytes, format: bytes.slice(0, 4).toString() === "glTF" ? "glb" : (/\.obj(\?|$)/i.test(url[1]) ? "obj" : "glb") };
  }
  throw new Error("Baseten replied, but not with a 3D model. Expected a field like glb_base64 in the response - check baseten-truss/model/model.py.");
}

app.post("/api/image-to-3d", wrap(async (req, res) => {
  if (!basetenConfigured()) {
    return res.status(503).json({ error: "Baseten is not set up yet. Add BASETEN_API_KEY and BASETEN_MODEL_ID to .env and restart the server (see baseten-truss/README.md)." });
  }
  const image = req.body?.image;
  if (typeof image !== "string" || !/^data:image\/(png|jpe?g|webp);base64,/i.test(image)) {
    return res.status(400).json({ error: "Send the photo as a PNG, JPEG or WebP data URL in the 'image' field." });
  }
  const o = req.body?.options || {};
  const payload = {
    image,
    remove_background: o.removeBackground !== false,
    mc_resolution: Math.min(512, Math.max(64, parseInt(o.resolution, 10) || 256)),
    foreground_ratio: 0.85,
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 280000);
  let r;
  try {
    r = await fetch(basetenUrl(), {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.BASETEN_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") return res.status(504).json({ error: "Baseten took longer than 4½ minutes. If the model was asleep it may be ready now - try again." });
    return res.status(502).json({ error: "Could not reach Baseten: " + (e.cause?.code || e.message) });
  }
  clearTimeout(timer);
  if (!r.ok) {
    const body = (await r.text().catch(() => "")).slice(0, 300);
    console.warn("Baseten HTTP", r.status, body);
    const msg =
      r.status === 401 || r.status === 403 ? "Baseten rejected the API key. Check BASETEN_API_KEY in .env." :
      r.status === 404 ? "Baseten could not find that model. Check BASETEN_MODEL_ID in .env, and that the model is deployed (truss push)." :
      r.status === 429 ? "Baseten is rate-limiting this request. Wait a moment and try again." :
      r.status >= 500 ? "The model is starting up or crashed on Baseten. The first request after idle can take a few minutes - try again shortly." :
      `Baseten returned HTTP ${r.status}.`;
    return res.status(r.status === 401 || r.status === 403 || r.status === 404 ? 502 : r.status >= 500 ? 503 : r.status).json({ error: msg, detail: body });
  }
  let out;
  try { out = await readBasetenModel(r); } catch (e) { return res.status(502).json({ error: e.message }); }
  if (!out.bytes.length) return res.status(502).json({ error: "Baseten returned an empty model." });
  res.set("Content-Type", out.format === "glb" ? "model/gltf-binary" : "application/octet-stream");
  res.set("X-Model-Format", out.format);
  res.set("Access-Control-Expose-Headers", "X-Model-Format");
  res.send(out.bytes);
}));

// ---------- static files (only these four, so .env and server.js can never be served) ----------
for (const f of ["explorer.html", "map-picker.html", "converter.html", "config.js"]) {
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
    console.log(basetenConfigured()
  ? "Baseten: configured (image-to-3D converter is ready)"
  : "Baseten: not configured - the image-to-3D page will ask you to add BASETEN_API_KEY and BASETEN_MODEL_ID to .env (see baseten-truss/README.md).");
  }))
  .catch((err) => { console.error("Could not connect to / set up the database:", err.message); process.exit(1); });