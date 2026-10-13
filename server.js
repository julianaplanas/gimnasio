import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === "production";
const SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  console.error("Falta SESSION_SECRET (cualquier texto largo y aleatorio).");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("Falta DATABASE_URL (agregá Postgres en Railway y referenciá su DATABASE_URL).");
  process.exit(1);
}

// DATE columns as plain "YYYY-MM-DD" strings (no timezone shifts)
pg.types.setTypeParser(1082, (v) => v);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "1" ? { rejectUnauthorized: false } : undefined,
});
const q = (text, params) => pool.query(text, params);

// ---------- Schema + seed ----------
async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('atleta','entrenadora')),
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS routines (
      id SERIAL PRIMARY KEY,
      athlete_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      date_from DATE,
      date_to DATE,
      days JSONB NOT NULL DEFAULT '[]',
      created_by INT REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      athlete_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      routine_id INT REFERENCES routines(id) ON DELETE SET NULL,
      day_id TEXT NOT NULL,
      day_name TEXT,
      entries JSONB NOT NULL DEFAULT '{}',
      note TEXT DEFAULT '',
      coach_note TEXT DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (athlete_id, date, day_id)
    );
  `);
}

async function ensureUser(email, password, name, role) {
  if (!email || !password) return null;
  email = email.trim().toLowerCase();
  const { rows } = await q("SELECT id FROM users WHERE email=$1", [email]);
  if (rows[0]) {
    if (process.env.RESET_PASSWORDS === "1") {
      await q("UPDATE users SET password_hash=$1 WHERE id=$2", [await bcrypt.hash(password, 10), rows[0].id]);
    }
    return rows[0].id;
  }
  const r = await q(
    "INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id",
    [email, name, role, await bcrypt.hash(password, 10)]
  );
  console.log(`Usuario creado: ${email} (${role})`);
  return r.rows[0].id;
}

async function seed(athleteId) {
  if (!athleteId) return;
  const { rows } = await q("SELECT count(*)::int AS n FROM routines WHERE athlete_id=$1", [athleteId]);
  if (rows[0].n > 0) return;
  const r = JSON.parse(fs.readFileSync(path.join(__dirname, "seed-routine.json"), "utf8"));
  const ins = await q(
    "INSERT INTO routines (athlete_id,name,date_from,date_to,days) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [athleteId, r.name, r.from, r.to, JSON.stringify(r.days)]
  );
  const set = (n, reps, kg) => Array.from({ length: n }, () => ({ reps, kg }));
  const entries = {
    "sentadilla-press": { sets: set(3, 10, 12) },
    "codo-rodilla-pie": { sets: set(3, 20, null) },
    "hip-thrust": { sets: [{ reps: 10, kg: 20 }, { reps: 8, kg: 25 }, { reps: 6, kg: 30 }] },
    "peso-muerto-1-pierna": { sets: set(3, 10, 20), note: "Con dos piernas" },
    "dorsales-prono": { sets: set(2, 6, 40) },
    "dorsales-supino": { sets: set(2, 6, 40) },
    "biceps-mancuernas": { sets: set(2, 10, 8) },
    "triceps-extension-arriba": { sets: set(2, 10, 6) },
  };
  await q(
    "INSERT INTO sessions (athlete_id,date,routine_id,day_id,day_name,entries) VALUES ($1,$2,$3,$4,$5,$6)",
    [athleteId, "2026-10-12", ins.rows[0].id, "lunes", "Lunes", JSON.stringify(entries)]
  );
  console.log("Rutina del mes 5 y entreno del 12/10 cargados.");
}

// ---------- App ----------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "same-origin");
  next();
});

const COOKIE = "ej_session";
function setSession(res, user) {
  const token = jwt.sign({ uid: user.id }, SECRET, { expiresIn: "120d" });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: PROD,
    maxAge: 120 * 24 * 3600 * 1000,
  });
}

async function auth(req, res, next) {
  try {
    const { uid } = jwt.verify(req.cookies[COOKIE] || "", SECRET);
    const { rows } = await q("SELECT id,email,name,role FROM users WHERE id=$1", [uid]);
    if (!rows[0]) throw new Error();
    req.user = rows[0];
    next();
  } catch {
    res.status(401).json({ error: "Iniciá sesión de nuevo." });
  }
}

// Which athlete does this request act on?
async function athleteFor(req) {
  if (req.user.role === "atleta") return req.user.id;
  const wanted = Number(req.query.athlete || req.body?.athlete_id);
  const { rows } = await q("SELECT id FROM users WHERE role='atleta' ORDER BY id");
  if (wanted && rows.some((r) => r.id === wanted)) return wanted;
  return rows[0]?.id ?? null;
}

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Login, with a small brute-force brake
const attempts = new Map();
app.post("/api/login", wrap(async (req, res) => {
  const key = req.ip;
  const a = attempts.get(key) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60 * 1000) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) return res.status(429).json({ error: "Demasiados intentos. Probá en 15 minutos." });
  const email = String(req.body.email || "").trim().toLowerCase();
  const { rows } = await q("SELECT * FROM users WHERE email=$1", [email]);
  const ok = rows[0] && (await bcrypt.compare(String(req.body.password || ""), rows[0].password_hash));
  if (!ok) {
    a.n++; attempts.set(key, a);
    return res.status(401).json({ error: "Email o contraseña incorrectos." });
  }
  attempts.delete(key);
  setSession(res, rows[0]);
  res.json({ ok: true });
}));

app.post("/api/logout", (req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

app.get("/api/me", auth, wrap(async (req, res) => {
  const athletes = req.user.role === "entrenadora"
    ? (await q("SELECT id,name FROM users WHERE role='atleta' ORDER BY id")).rows
    : [{ id: req.user.id, name: req.user.name }];
  res.json({ user: req.user, athletes, canParse: !!process.env.ANTHROPIC_API_KEY });
}));

app.post("/api/password", auth, wrap(async (req, res) => {
  const { current, next } = req.body;
  if (!next || String(next).length < 8) return res.status(400).json({ error: "La nueva contraseña necesita al menos 8 caracteres." });
  const { rows } = await q("SELECT password_hash FROM users WHERE id=$1", [req.user.id]);
  if (!(await bcrypt.compare(String(current || ""), rows[0].password_hash)))
    return res.status(400).json({ error: "La contraseña actual no coincide." });
  await q("UPDATE users SET password_hash=$1 WHERE id=$2", [await bcrypt.hash(String(next), 10), req.user.id]);
  res.json({ ok: true });
}));

// ---------- Routines ----------
const routineOut = (r) => ({
  id: r.id, name: r.name,
  from: r.date_from || null,
  to: r.date_to || null,
  days: r.days, updated_at: r.updated_at,
});

app.get("/api/routines", auth, wrap(async (req, res) => {
  const aid = await athleteFor(req);
  const { rows } = await q("SELECT * FROM routines WHERE athlete_id=$1 ORDER BY date_from DESC NULLS LAST, id DESC", [aid]);
  res.json(rows.map(routineOut));
}));

function cleanRoutine(b) {
  if (!b || typeof b.name !== "string" || !Array.isArray(b.days)) throw Object.assign(new Error("Rutina inválida."), { status: 400 });
  return [b.name.slice(0, 120), b.from || null, b.to || null, JSON.stringify(b.days)];
}

app.post("/api/routines", auth, wrap(async (req, res) => {
  const aid = await athleteFor(req);
  const [name, from, to, days] = cleanRoutine(req.body);
  const { rows } = await q(
    "INSERT INTO routines (athlete_id,name,date_from,date_to,days,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
    [aid, name, from, to, days, req.user.id]
  );
  res.json(routineOut(rows[0]));
}));

async function ownsRoutine(req, id) {
  const aid = await athleteFor(req);
  const { rows } = await q("SELECT id FROM routines WHERE id=$1 AND athlete_id=$2", [id, aid]);
  return !!rows[0];
}

app.put("/api/routines/:id", auth, wrap(async (req, res) => {
  if (!(await ownsRoutine(req, req.params.id))) return res.status(404).json({ error: "No encontrada." });
  const [name, from, to, days] = cleanRoutine(req.body);
  const { rows } = await q(
    "UPDATE routines SET name=$1,date_from=$2,date_to=$3,days=$4,updated_at=now() WHERE id=$5 RETURNING *",
    [name, from, to, days, req.params.id]
  );
  res.json(routineOut(rows[0]));
}));

app.delete("/api/routines/:id", auth, wrap(async (req, res) => {
  if (!(await ownsRoutine(req, req.params.id))) return res.status(404).json({ error: "No encontrada." });
  await q("DELETE FROM routines WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
}));

// Turn the trainer's WhatsApp text into a structured routine
app.post("/api/routines/parse", auth, wrap(async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(400).json({ error: "Falta ANTHROPIC_API_KEY en el servidor." });
  const text = String(req.body.text || "").slice(0, 30000);
  if (text.trim().length < 20) return res.status(400).json({ error: "Pegá el texto completo de la rutina." });
  const aid = await athleteFor(req);
  const { rows } = await q("SELECT days FROM routines WHERE athlete_id=$1", [aid]);
  const known = new Map();
  rows.forEach((r) => r.days.forEach((d) => d.blocks.forEach((b) => b.exercises.forEach((e) => known.set(e.key, e.name)))));
  const knownList = [...known].map(([k, n]) => `${k}: ${n}`).join("\n");
  const today = new Date().toISOString().slice(0, 10);

  const prompt = `Convertí esta rutina de gimnasio (texto de WhatsApp de una entrenadora) a JSON.
Hoy es ${today}. Respondé SOLO con JSON válido, sin texto extra, con esta forma:
{"name":"Mes N","from":"YYYY-MM-DD","to":"YYYY-MM-DD","days":[{"id":"lunes","name":"Lunes","blocks":[{"name":"Glúteos","sets":"3 series","notes":"","exercises":[{"key":"hip-thrust","name":"Hip thrust","mode":"peso","sets":"3","reps":"8–10","kg":"40+","notes":""}]}]}]}

Reglas:
- Días: si un día no tiene título, es lunes. Ids en minúscula sin tildes (lunes, martes, miercoles, jueves, viernes, sabado, domingo).
- "mode": "peso" si lleva carga, "reps" si solo repeticiones, "check" para ejercicios de entrada en calor o por tiempo.
- Si dice "entrada en calor igual" en otro día, copiá el bloque completo de entrada en calor en ese día.
- "notes": resumí las indicaciones técnicas en español rioplatense, claro y breve. No inventes cargas ni repeticiones.
- "key": slug estable. Si el ejercicio es el mismo que alguno de esta lista, reutilizá exactamente esa key:
${knownList || "(no hay ejercicios previos)"}
- Ignorá las líneas con ✅ (son registros, no indicaciones).

Texto:
"""
${text}
"""`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await r.json();
  if (!r.ok) return res.status(502).json({ error: "Claude no pudo leer la rutina: " + (data.error?.message || r.status) });
  const out = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
  try {
    res.json(JSON.parse(json));
  } catch {
    res.status(502).json({ error: "La respuesta no se pudo interpretar. Probá de nuevo." });
  }
}));

// ---------- Sessions ----------
const sessionOut = (s) => ({
  id: s.id, date: s.date, routine_id: s.routine_id,
  day_id: s.day_id, day_name: s.day_name, entries: s.entries, note: s.note,
  coach_note: s.coach_note, updated_at: s.updated_at,
});

app.get("/api/sessions", auth, wrap(async (req, res) => {
  const aid = await athleteFor(req);
  const { rows } = await q("SELECT * FROM sessions WHERE athlete_id=$1 ORDER BY date DESC, id DESC", [aid]);
  res.json(rows.map(sessionOut));
}));

app.put("/api/sessions", auth, wrap(async (req, res) => {
  const aid = await athleteFor(req);
  const { date, day_id, day_name, routine_id, entries, note } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !day_id) return res.status(400).json({ error: "Falta fecha o día." });
  const { rows } = await q(
    `INSERT INTO sessions (athlete_id,date,routine_id,day_id,day_name,entries,note)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (athlete_id,date,day_id) DO UPDATE
       SET entries=EXCLUDED.entries, note=EXCLUDED.note, routine_id=EXCLUDED.routine_id,
           day_name=EXCLUDED.day_name, updated_at=now()
     RETURNING *`,
    [aid, date, routine_id || null, day_id, day_name || day_id, JSON.stringify(entries || {}), String(note || "")]
  );
  res.json(sessionOut(rows[0]));
}));

app.patch("/api/sessions/:id/coach-note", auth, wrap(async (req, res) => {
  if (req.user.role !== "entrenadora") return res.status(403).json({ error: "Solo la entrenadora puede comentar." });
  const { rows } = await q(
    "UPDATE sessions SET coach_note=$1 WHERE id=$2 RETURNING *",
    [String(req.body.coach_note || "").slice(0, 2000), req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "No encontrado." });
  res.json(sessionOut(rows[0]));
}));

app.delete("/api/sessions/:id", auth, wrap(async (req, res) => {
  const aid = await athleteFor(req);
  await q("DELETE FROM sessions WHERE id=$1 AND athlete_id=$2", [req.params.id, aid]);
  res.json({ ok: true });
}));

app.get("/healthz", (req, res) => res.send("ok"));

// ---------- Static PWA ----------
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, p) {
    if (p.endsWith("sw.js") || p.endsWith(".html")) res.set("Cache-Control", "no-cache");
  },
}));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : "Algo falló en el servidor." });
});

// ---------- Boot ----------
await migrate();
const athleteId = await ensureUser(process.env.ATHLETE_EMAIL, process.env.ATHLETE_PASSWORD, process.env.ATHLETE_NAME || "Juli", "atleta");
await ensureUser(process.env.COACH_EMAIL, process.env.COACH_PASSWORD, process.env.COACH_NAME || "Entrenadora", "entrenadora");
await seed(athleteId);
app.listen(PORT, () => console.log(`Entrenos escuchando en :${PORT}`));
