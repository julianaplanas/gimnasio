// Entrenos de Juli — single-page mobile app (vanilla JS)

const $app = document.getElementById("app");
const DAY_IDS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];

const S = {
  me: null, athletes: [], athleteId: null, canParse: false,
  routines: [], sessions: [],
  tab: null,
  train: null,          // { routineId, dayId, date, entries, note, coach_note, sessionId }
  progressKey: null,
  openSession: null, confirmDelete: null,
  openRoutine: null, confirmRoutine: null,
  editor: null,         // { id, data }
  sheet: null,          // "menu" | "new-routine"
  save: { state: "idle", timer: null, inFlight: false, again: false },
};

// ---------- utils ----------
const h = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const asDate = (iso) => new Date(iso + "T12:00:00");
const fmtDay = (iso) => asDate(iso).toLocaleDateString("es-ES", { weekday: "short", day: "numeric", month: "short" });
const fmtShort = (iso) => asDate(iso).toLocaleDateString("es-ES", { day: "numeric", month: "short" });
const fmtNum = (n) => (n == null || n === "" ? "" : Number(n).toLocaleString("es-ES", { maximumFractionDigits: 2 }));
const toNum = (v) => { if (v === "" || v == null) return null; const n = parseFloat(String(v).replace(",", ".")); return Number.isFinite(n) ? n : null; };
const clone = (o) => JSON.parse(JSON.stringify(o));
const slug = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "ejercicio";
function plateClass(kg) {
  const n = toNum(kg); if (n == null) return "";
  return n >= 25 ? "r" : n >= 20 ? "b" : n >= 15 ? "y" : n >= 10 ? "g" : "";
}

async function api(method, url, body) {
  const sep = url.includes("?") ? "&" : "?";
  const full = S.me?.role === "entrenadora" && S.athleteId ? `${url}${sep}athlete=${S.athleteId}` : url;
  const r = await fetch(full, {
    method, credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== "/api/login") { S.me = null; renderLogin(); throw Object.assign(new Error("auth"), { silent: true }); }
  if (!r.ok) throw new Error(data.error || "No se pudo completar.");
  return data;
}

// ---------- data helpers ----------
const isCoach = () => S.me?.role === "entrenadora";
const athleteName = () => S.athletes.find((a) => a.id === S.athleteId)?.name || "Juli";
const routineById = (id) => S.routines.find((r) => r.id === id);

function currentRoutine(date = todayISO()) {
  if (!S.routines.length) return null;
  return S.routines.find((r) => r.from && r.to && r.from <= date && date <= r.to)
    || S.routines.find((r) => r.from && r.from <= date)
    || S.routines[0];
}
function exerciseIndex() {
  const m = new Map();
  [...S.routines].reverse().forEach((r) => r.days.forEach((d) => d.blocks.forEach((b) => b.exercises.forEach((e) => m.set(e.key, e)))));
  return m;
}
const setsOf = (entry) => (entry?.sets || []).filter((s) => toNum(s.reps) != null || toNum(s.kg) != null);
const entryHasData = (e) => !!e && (e.done || setsOf(e).length > 0 || (e.note || "").trim());

function lastFor(key, date, dayId) {
  const list = S.sessions.filter((s) => !(s.date === date && s.day_id === dayId) && setsOf(s.entries[key]).length);
  return list.find((s) => s.date <= date) || list[0] || null;
}
function setsText(sets) {
  return setsOf({ sets }).map((s) => {
    const r = toNum(s.reps), k = toNum(s.kg);
    return k != null ? `${r ?? "–"} × ${fmtNum(k)} kg` : `${r} reps`;
  }).join(" · ");
}
function sessionVolume(s) {
  let v = 0;
  Object.values(s.entries || {}).forEach((e) => setsOf(e).forEach((x) => { v += (toNum(x.reps) || 0) * (toNum(x.kg) || 0); }));
  return v;
}

// ---------- boot ----------
async function boot() {
  try {
    const me = await api("GET", "/api/me");
    S.me = me.user; S.athletes = me.athletes; S.canParse = me.canParse;
    S.athleteId = store.get("athlete", null);
    if (!S.athletes.some((a) => a.id === S.athleteId)) S.athleteId = S.athletes[0]?.id ?? null;
    S.tab = store.get("tab", null);
    const allowed = isCoach() ? ["historial", "progreso", "rutinas"] : ["entrenar", "progreso", "historial", "rutinas"];
    if (!allowed.includes(S.tab)) S.tab = allowed[0];
    await loadData();
    flushPending();
    render();
  } catch (e) {
    if (!e.silent) renderLogin();
  }
}

async function loadData() {
  const [routines, sessions] = await Promise.all([api("GET", "/api/routines"), api("GET", "/api/sessions")]);
  S.routines = routines; S.sessions = sessions;
  if (!isCoach()) initTrain();
}

function initTrain(date, dayId, routineId) {
  date = date || S.train?.date || todayISO();
  const routine = (routineId && routineById(routineId)) || currentRoutine(date);
  if (!routine) { S.train = null; return; }
  if (!dayId || !routine.days.some((d) => d.id === dayId)) {
    const wd = DAY_IDS[asDate(date).getDay()];
    dayId = routine.days.find((d) => d.id === wd)?.id || routine.days[0]?.id;
  }
  const existing = S.sessions.find((s) => s.date === date && s.day_id === dayId);
  const pending = store.get("pending", {})[`${date}|${dayId}`];
  S.train = {
    routineId: routine.id, dayId, date,
    sessionId: existing?.id || null,
    entries: clone(pending?.entries || existing?.entries || {}),
    note: pending?.note ?? existing?.note ?? "",
    coach_note: existing?.coach_note || "",
  };
}

// ---------- saving (debounced autosave + offline queue) ----------
function changed() {
  setSaveState("dirty");
  clearTimeout(S.save.timer);
  S.save.timer = setTimeout(saveTrain, 1200);
}
function cleanEntries(entries) {
  const out = {};
  for (const [k, e] of Object.entries(entries)) {
    const sets = setsOf(e).map((s) => ({ reps: toNum(s.reps), kg: toNum(s.kg) }));
    const item = {};
    if (sets.length) item.sets = sets;
    if (e.done) item.done = true;
    if ((e.note || "").trim()) item.note = e.note.trim();
    if (Object.keys(item).length) out[k] = item;
  }
  return out;
}
async function saveTrain() {
  const t = S.train; if (!t) return;
  if (S.save.inFlight) { S.save.again = true; return; }
  const entries = cleanEntries(t.entries);
  if (!t.sessionId && !Object.keys(entries).length && !t.note.trim()) { setSaveState("idle"); return; }
  const routine = routineById(t.routineId);
  const body = { date: t.date, day_id: t.dayId, day_name: routine?.days.find((d) => d.id === t.dayId)?.name, routine_id: t.routineId, entries, note: t.note };
  const pkey = `${t.date}|${t.dayId}`;
  S.save.inFlight = true; setSaveState("saving");
  try {
    const saved = await api("PUT", "/api/sessions", body);
    const i = S.sessions.findIndex((s) => s.id === saved.id);
    if (i >= 0) S.sessions[i] = saved; else { S.sessions.unshift(saved); S.sessions.sort((a, b) => b.date.localeCompare(a.date)); }
    if (S.train && S.train.date === t.date && S.train.dayId === t.dayId) S.train.sessionId = saved.id;
    const p = store.get("pending", {}); delete p[pkey]; store.set("pending", p);
    setSaveState("saved");
  } catch (e) {
    if (e.silent) return;
    const p = store.get("pending", {}); p[pkey] = body; store.set("pending", p);
    setSaveState(navigator.onLine ? "error" : "offline");
  } finally {
    S.save.inFlight = false;
    if (S.save.again) { S.save.again = false; saveTrain(); }
  }
}
async function flushPending() {
  const p = store.get("pending", {});
  for (const [k, body] of Object.entries(p)) {
    try {
      const saved = await api("PUT", "/api/sessions", body);
      const i = S.sessions.findIndex((s) => s.id === saved.id);
      if (i >= 0) S.sessions[i] = saved; else S.sessions.unshift(saved);
      const cur = store.get("pending", {}); delete cur[k]; store.set("pending", cur);
    } catch { return; }
  }
}
window.addEventListener("online", () => { flushPending().then(() => { if (S.save.state === "offline") setSaveState("saved"); }); });

function setSaveState(state) {
  S.save.state = state;
  const el = document.getElementById("save-status");
  if (!el) return;
  const map = {
    idle: ["", ""], dirty: ["Sin guardar…", ""], saving: ["Guardando…", ""], saved: ["Guardado", "ok"],
    offline: ["Sin conexión · se guarda al volver", "warn"], error: ["No se pudo guardar · reintentá", "warn"],
  };
  const [txt, cls] = map[state];
  el.textContent = txt; el.className = `status ${cls}`; el.hidden = !txt;
}

// ---------- icons ----------
const ICON = {
  entrenar: '<svg viewBox="0 0 24 24"><path d="M6.5 6.5v11M17.5 6.5v11M3 9v6M21 9v6M6.5 12h11"/></svg>',
  progreso: '<svg viewBox="0 0 24 24"><path d="M4 19h16"/><path d="M5 15l4-4 3 3 6-7"/><path d="M15 7h3v3"/></svg>',
  historial: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
  rutinas: '<svg viewBox="0 0 24 24"><path d="M7 4h10a1 1 0 0 1 1 1v15l-6-3-6 3V5a1 1 0 0 1 1-1z"/></svg>',
};
const TAB_LABEL = { entrenar: "Entrenar", progreso: "Progreso", historial: "Historial", rutinas: "Rutinas" };

// ---------- render ----------
function render() {
  if (!S.me) return renderLogin();
  const tabs = isCoach() ? ["historial", "progreso", "rutinas"] : ["entrenar", "progreso", "historial", "rutinas"];
  let sub = TAB_LABEL[S.tab];
  if (S.tab === "entrenar" && S.train) {
    const r = routineById(S.train.routineId);
    sub = r ? `${r.name}${r.from ? ` · ${fmtShort(r.from)} – ${fmtShort(r.to)}` : ""}` : sub;
  }
  if (S.editor) sub = S.editor.id ? "Editando rutina" : "Nueva rutina";
  const athleteSel = isCoach() && S.athletes.length > 1
    ? `<select class="athlete" id="athlete-sel" aria-label="Atleta">${S.athletes.map((a) => `<option value="${a.id}" ${a.id === S.athleteId ? "selected" : ""}>${h(a.name)}</option>`).join("")}</select>` : "";

  let body = "";
  if (S.editor) body = viewEditor();
  else if (S.tab === "entrenar") body = viewTrain();
  else if (S.tab === "progreso") body = viewProgress();
  else if (S.tab === "historial") body = viewHistory();
  else if (S.tab === "rutinas") body = viewRoutines();

  $app.innerHTML = `
    <div class="shell">
      <header class="top">
        <h1>Entrenos de ${h(athleteName())}<small>${h(sub)}</small></h1>
        ${athleteSel}
        <button class="avatar" data-act="menu" aria-label="Cuenta">${h(S.me.name[0] || "?")}</button>
      </header>
      <main>${body}</main>
    </div>
    ${S.tab === "entrenar" && !S.editor ? `<div class="savebar"><div class="inner"><span id="save-status" class="status" hidden></span></div></div>` : ""}
    <div class="tabs"><nav>${tabs.map((t) => `<button data-tab="${t}" ${S.tab === t && !S.editor ? 'aria-current="page"' : ""}>${ICON[t]}<span>${TAB_LABEL[t]}</span></button>`).join("")}</nav></div>
    ${S.sheet ? viewSheet() : ""}`;
  setSaveState(S.save.state);
}

// ----- Train -----
function viewTrain() {
  const t = S.train;
  if (!t) return `<div class="empty card" style="margin-top:20px"><strong>Todavía no hay rutina cargada</strong>Andá a Rutinas para cargar la del mes.</div>`;
  const routine = routineById(t.routineId);
  const day = routine.days.find((d) => d.id === t.dayId);
  const doneDays = new Set(S.sessions.filter((s) => s.routine_id === routine.id && s.date >= (routine.from || "")).map((s) => s.day_id));
  const routineSel = S.routines.length > 1
    ? `<select class="input" id="train-routine" style="width:auto;padding:7px 10px" aria-label="Rutina">${S.routines.map((r) => `<option value="${r.id}" ${r.id === routine.id ? "selected" : ""}>${h(r.name)}</option>`).join("")}</select>` : "";

  return `
    <div class="daybar">
      <div class="chips" role="group" aria-label="Día">
        ${routine.days.map((d) => `<button class="chip" data-day="${d.id}" aria-pressed="${d.id === t.dayId}">${h(d.name)}${doneDays.has(d.id) ? '<span class="dot" title="Hecho esta rutina"></span>' : ""}</button>`).join("")}
      </div>
      <div class="date-row">
        <input type="date" class="input" id="train-date" value="${t.date}" aria-label="Fecha">
        <span class="small muted grow">${t.sessionId ? "Editando lo que anotaste ese día" : fmtDay(t.date)}</span>
        ${routineSel}
      </div>
    </div>
    ${t.coach_note ? `<div class="coach-box" style="margin-top:14px"><div class="who">Tu entrenadora</div>${h(t.coach_note)}</div>` : ""}
    ${day.blocks.map((b, bi) => viewBlock(b, bi)).join("")}
    <div class="section-title">Notas del día</div>
    <textarea class="input" id="train-note" placeholder="Cómo te sentiste, molestias, cardio…">${h(t.note)}</textarea>`;
}

function viewBlock(b, bi) {
  const allCheck = b.exercises.length && b.exercises.every((e) => e.mode === "check");
  const head = `<div class="block-head"><h2>${h(b.name)}</h2>${b.sets ? `<span class="sets">${h(b.sets)}</span>` : ""}</div>${b.notes ? `<p class="block-note">${h(b.notes)}</p>` : ""}`;
  if (!allCheck && isCircuit(b)) return viewCircuit(b, bi, head);
  if (allCheck) {
    return `<section class="block">${head}<div class="card check-list">${b.exercises.map((e) => {
      return checkRow(e, false);
    }).join("")}</div></section>`;
  }
  return `<section class="block">${head}${b.exercises.map((e) => viewExercise(e)).join("")}</section>`;
}

// Dupletos / tripletos / cuartetos: exercises alternate, one round at a time
const CIRCUIT_RE = /dupleto|tripleto|triplet0|cuarteto|circuito|superserie|bi-?serie|tri-?serie/i;
function isCircuit(b) {
  if (b.circuit === true || b.circuit === "si") return true;
  if (b.circuit === false || b.circuit === "no") return false;
  return CIRCUIT_RE.test(b.name || "") && b.exercises.filter((e) => e.mode !== "check").length > 1;
}
const LETTERS = "ABCDEFGH";

function viewCircuit(b, bi, head) {
  const t = S.train;
  const checks = b.exercises.filter((e) => e.mode === "check");
  const exs = b.exercises.filter((e) => e.mode !== "check");
  const info = exs.map((e) => {
    const last = lastFor(e.key, t.date, t.dayId);
    return { e, last, lastSets: last ? setsOf(last.entries[e.key]) : [] };
  });
  const filled = Math.max(0, ...exs.map((e) => t.entries[e.key]?.sets?.length || 0));
  const n = filled || parseInt(b.sets, 10) || Math.max(0, ...exs.map((e) => parseInt(e.sets, 10) || 0)) || 3;
  const restSecs = Math.max(...exs.map(restOf));

  const legend = info.map(({ e, last }, k) => {
    const kgP = e.kg ? `<span class="pill kg-pill"><span class="plate ${plateClass(e.kg)}"></span>${h(e.kg)} kg</span>` : "";
    return `<div class="cx">
      <span class="letter">${LETTERS[k]}</span>
      <div class="grow">
        <div class="ex-name">${h(e.name)}</div>
        <div class="target">${e.reps ? `<span class="pill">${h(e.reps)} reps</span>` : ""}${kgP}</div>
        ${e.notes ? `<details class="how"><summary>Cómo se hace</summary><p>${h(e.notes)}</p></details>` : ""}
        ${last ? `<div class="last"><span>Última vez, ${fmtShort(last.date)}:</span><b class="num">${h(setsText(last.entries[e.key].sets))}</b></div>` : ""}
      </div>
    </div>`;
  }).join("");

  const rounds = Array.from({ length: n }, (_, i) => {
    const items = info.map(({ e, lastSets }, k) => {
      const s = t.entries[e.key]?.sets?.[i] || { reps: "", kg: "" };
      const ph = (f) => { const x = lastSets[i] || lastSets[lastSets.length - 1]; return x ? fmtNum(x[f]) : ""; };
      const withKg = e.mode !== "reps";
      return `<div class="ri">
        <span class="letter sm">${LETTERS[k]}</span>
        <span class="ri-name">${h(e.name)}</span>
        <div class="ri-inputs ${withKg ? "" : "no-kg"}">
          <div class="cell"><input inputmode="numeric" data-set="${h(e.key)}" data-i="${i}" data-f="reps" data-block="${bi}" value="${h(s.reps ?? "")}" placeholder="${h(ph("reps"))}" aria-label="Ronda ${i + 1}, ${h(e.name)}, repeticiones"><span class="unit">reps</span></div>
          ${withKg ? `<div class="cell"><input inputmode="decimal" data-set="${h(e.key)}" data-i="${i}" data-f="kg" data-block="${bi}" value="${h(s.kg ?? "")}" placeholder="${h(ph("kg"))}" aria-label="Ronda ${i + 1}, ${h(e.name)}, kilos"><span class="unit">kg</span></div>` : ""}
        </div>
      </div>`;
    }).join("");
    return `<div class="round ${roundDone(exs, i) ? "done" : ""}" data-round="${bi}-${i}">
      <div class="round-head"><span class="round-n">Ronda ${i + 1}</span><span class="round-ok" aria-hidden="true">✓</span><span class="grow"></span>
        <button class="btn ghost sm" data-rest="${h(exs[0].key)}" data-secs="${restSecs}" data-label="${h(b.name)} · ronda ${i + 1}">Descanso</button>
        <button class="del" data-delround="${bi}" data-i="${i}" aria-label="Quitar ronda ${i + 1}">×</button></div>
      ${items}
    </div>`;
  }).join("");

  return `<section class="block" data-block="${bi}">${head}
    ${checks.length ? `<div class="card check-list" style="margin-bottom:10px">${checks.map((e) => checkRow(e, false)).join("")}</div>` : ""}
    <div class="card circuit">
      <div class="cx-legend">${legend}</div>
      <div class="rounds">${rounds}</div>
      <div class="ex-actions"><button class="btn ghost sm" data-addround="${bi}">+ Ronda</button><span class="small muted">Alternás ${exs.map((_, k) => LETTERS[k]).join(" → ")} y repetís</span></div>
    </div>
  </section>`;
}
function roundDone(exs, i) {
  return exs.every((e) => { const s = S.train.entries[e.key]?.sets?.[i]; return s && toNum(s.reps) != null; });
}
function circuitExercises(bi) {
  const day = routineById(S.train.routineId).days.find((d) => d.id === S.train.dayId);
  const b = day.blocks[bi];
  return { b, exs: b.exercises.filter((e) => e.mode !== "check") };
}
function rerenderBlock(bi) {
  const { b } = circuitExercises(bi);
  const el = $app.querySelector(`section[data-block="${bi}"]`);
  if (el) { const head = el.querySelector(".block-head").outerHTML + (el.querySelector(".block-note")?.outerHTML || ""); el.outerHTML = viewCircuit(b, bi, head); }
}

// "30 seg", "20 seg o 20 rep" → 30, 20
const secsOf = (e) => { const m = String(e.reps || "").match(/(\d+)\s*(seg|s\b|")/i); return m ? +m[1] : 0; };
const restOf = (e) => toNum(e.rest) || store.get("restDefault", 60);
const fmtClock = (sec) => { const a = Math.abs(Math.round(sec)); return `${Math.floor(a / 60)}:${String(a % 60).padStart(2, "0")}`; };

function checkRow(e, bold) {
  const done = !!S.train.entries[e.key]?.done;
  const secs = secsOf(e);
  return `<div class="check-row">
    <button class="check" data-check="${h(e.key)}" aria-pressed="${done}"><span class="box"></span><span class="t">${bold ? `<b>${h(e.name)}</b>` : h(e.name)}</span><span class="r">${h(e.reps || "")}</span></button>
    ${secs ? `<button class="play" data-extimer="${h(e.key)}" data-secs="${secs}" data-label="${h(e.name)}" aria-label="Temporizador ${secs} segundos">${ICON_PLAY}</button>` : ""}
  </div>`;
}

function viewExercise(e) {
  const t = S.train;
  if (e.mode === "check") {
    return `<div class="card" data-card="${h(e.key)}">${checkRow(e, true)}</div>`;
  }
  const withKg = e.mode !== "reps";
  const entry = t.entries[e.key];
  const last = lastFor(e.key, t.date, t.dayId);
  const lastSets = last ? setsOf(last.entries[e.key]) : [];
  const n = entry?.sets?.length || parseInt(e.sets, 10) || lastSets.length || 3;
  const rows = Array.from({ length: n }, (_, i) => entry?.sets?.[i] || { reps: "", kg: "" });
  const ph = (i, f) => { const s = lastSets[i] || lastSets[lastSets.length - 1]; return s ? fmtNum(s[f]) : ""; };
  const kgP = e.kg ? `<span class="pill kg-pill"><span class="plate ${plateClass(e.kg)}"></span>${h(e.kg)} kg</span>` : "";
  const note = entry?.note || "";

  return `<article class="card ex" data-card="${h(e.key)}">
    <div class="ex-head"><div class="grow">
      <div class="ex-name">${h(e.name)}</div>
      <div class="target">${e.sets ? `<span class="pill">${h(e.sets)} series</span>` : ""}${e.reps ? `<span class="pill">${h(e.reps)} reps</span>` : ""}${kgP}</div>
    </div></div>
    ${e.notes ? `<details class="how"><summary>Cómo se hace</summary><p>${h(e.notes)}</p></details>` : ""}
    ${last ? `<div class="last"><span>Última vez, ${fmtShort(last.date)}:</span><b class="num">${h(setsText(last.entries[e.key].sets))}</b></div>` : ""}
    <div class="sets-grid">
      <div class="set-row set-head ${withKg ? "" : "no-kg"}"><span></span><span>Reps</span>${withKg ? "<span>Peso</span>" : ""}<span></span></div>
      ${rows.map((s, i) => `
        <div class="set-row ${withKg ? "" : "no-kg"}">
          <span class="n">${i + 1}</span>
          <div class="cell"><input inputmode="numeric" data-set="${h(e.key)}" data-i="${i}" data-f="reps" value="${h(s.reps ?? "")}" placeholder="${h(ph(i, "reps"))}" aria-label="Serie ${i + 1} repeticiones"></div>
          ${withKg ? `<div class="cell"><input inputmode="decimal" data-set="${h(e.key)}" data-i="${i}" data-f="kg" value="${h(s.kg ?? "")}" placeholder="${h(ph(i, "kg"))}" aria-label="Serie ${i + 1} kilos"><span class="unit">kg</span></div>` : ""}
          <button class="del" data-delset="${h(e.key)}" data-i="${i}" aria-label="Quitar serie ${i + 1}">×</button>
        </div>`).join("")}
    </div>
    <div class="ex-actions">
      <button class="btn ghost sm" data-addset="${h(e.key)}">+ Serie</button>
      <button class="btn ghost sm" data-rest="${h(e.key)}" data-secs="${restOf(e)}" data-label="${h(e.name)}">Descanso ${fmtClock(restOf(e))}</button>
      ${lastSets.length ? `<button class="btn ghost sm" data-copylast="${h(e.key)}">Copiar última vez</button>` : ""}
      ${note ? "" : `<button class="btn ghost sm" data-addnote="${h(e.key)}">+ Nota</button>`}
    </div>
    <input class="input small" data-note="${h(e.key)}" value="${h(note)}" placeholder="Nota sobre este ejercicio" ${note ? "" : "hidden"}>
  </article>`;
}

function rerenderCard(key) {
  const day = routineById(S.train.routineId).days.find((d) => d.id === S.train.dayId);
  for (const b of day.blocks) {
    const e = b.exercises.find((x) => x.key === key);
    if (e) {
      const el = $app.querySelector(`[data-card="${CSS.escape(key)}"]`);
      if (el) el.outerHTML = viewExercise(e);
      return;
    }
  }
}
function ensureEntry(key, n) {
  const t = S.train;
  if (!t.entries[key]) t.entries[key] = {};
  const e = t.entries[key];
  if (!e.sets) e.sets = [];
  while (e.sets.length < n) e.sets.push({ reps: "", kg: "" });
  return e;
}
const visibleRows = (key) => $app.querySelectorAll(`input[data-set="${CSS.escape(key)}"][data-f="reps"]`).length;

// ----- Progress -----
function progressData() {
  const idx = exerciseIndex();
  const map = new Map();
  [...S.sessions].sort((a, b) => a.date.localeCompare(b.date)).forEach((s) => {
    for (const [key, e] of Object.entries(s.entries || {})) {
      const sets = setsOf(e); if (!sets.length) continue;
      const kgs = sets.map((x) => toNum(x.kg)).filter((x) => x != null);
      const useKg = kgs.length > 0;
      const top = useKg ? Math.max(...kgs) : Math.max(...sets.map((x) => toNum(x.reps) || 0));
      if (!map.has(key)) map.set(key, { key, name: idx.get(key)?.name || key, unit: useKg ? "kg" : "reps", pts: [] });
      map.get(key).pts.push({ date: s.date, top, sets, vol: sets.reduce((a, x) => a + (toNum(x.reps) || 0) * (toNum(x.kg) || 0), 0) });
    }
  });
  return [...map.values()].sort((a, b) => b.pts.at(-1).date.localeCompare(a.pts.at(-1).date) || a.name.localeCompare(b.name));
}
function sparkline(pts) {
  const w = 84, hgt = 30, p = 3;
  if (pts.length < 2) return `<svg class="spark" viewBox="0 0 ${w} ${hgt}"><circle cx="${w - p}" cy="${hgt / 2}" r="3" style="fill:var(--accent)"/></svg>`;
  const vals = pts.map((x) => x.top); const lo = Math.min(...vals), hi = Math.max(...vals); const rg = hi - lo || 1;
  const xy = vals.map((v, i) => [p + (i * (w - 2 * p)) / (vals.length - 1), hgt - p - ((v - lo) / rg) * (hgt - 2 * p)]);
  const last = xy.at(-1);
  return `<svg class="spark" viewBox="0 0 ${w} ${hgt}"><polyline points="${xy.map((q) => q.join(",")).join(" ")}" style="fill:none;stroke:var(--muted);stroke-width:1.6;stroke-linejoin:round"/><circle cx="${last[0]}" cy="${last[1]}" r="3" style="fill:var(--accent)"/></svg>`;
}
function bigChart(item) {
  const pts = item.pts; const W = 520, H = 220, L = 40, R = 16, T = 16, B = 30;
  const vals = pts.map((x) => x.top);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.2, item.unit === "kg" ? 2.5 : 2);
  lo = Math.max(0, Math.floor(lo - pad)); hi = Math.ceil(hi + pad);
  const X = (i) => (pts.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (pts.length - 1));
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const ticks = [lo, (lo + hi) / 2, hi].map((v) => Math.round(v * 2) / 2);
  const grid = ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" style="stroke:var(--line);stroke-width:1"/><text x="${L - 8}" y="${Y(v) + 4}" text-anchor="end" style="fill:var(--muted);font-size:12px">${fmtNum(v)}</text>`).join("");
  const step = Math.max(1, Math.ceil(pts.length / 5));
  const xl = pts.map((p, i) => (i % step === 0 || i === pts.length - 1) ? `<text x="${X(i)}" y="${H - 8}" text-anchor="middle" style="fill:var(--muted);font-size:12px">${fmtShort(p.date)}</text>` : "").join("");
  const line = pts.map((p, i) => `${X(i)},${Y(p.top)}`).join(" ");
  const area = pts.length > 1 ? `<polygon points="${X(0)},${H - B} ${line} ${X(pts.length - 1)},${H - B}" style="fill:var(--accent);opacity:.1"/>` : "";
  const dots = pts.map((p, i) => `<circle cx="${X(i)}" cy="${Y(p.top)}" r="${i === pts.length - 1 ? 5 : 3}" style="fill:${i === pts.length - 1 ? "var(--accent)" : "var(--surface)"};stroke:var(--accent);stroke-width:2"/>`).join("");
  const lastP = pts.at(-1);
  const lbl = `<text x="${Math.min(X(pts.length - 1), W - R - 4)}" y="${Y(lastP.top) - 12}" text-anchor="end" style="fill:var(--fg);font-size:13px;font-weight:700">${fmtNum(lastP.top)} ${item.unit}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolución de ${h(item.name)}">${grid}${area}<polyline points="${line}" style="fill:none;stroke:var(--accent);stroke-width:2.5;stroke-linejoin:round"/>${dots}${lbl}${xl}</svg>`;
}
function viewProgress() {
  const data = progressData();
  if (S.progressKey) {
    const item = data.find((d) => d.key === S.progressKey);
    if (item) {
      const first = item.pts[0].top, last = item.pts.at(-1).top, d = last - first;
      return `
        <button class="btn ghost back" data-act="prog-back">‹ Todos los ejercicios</button>
        <div class="section-title">${h(item.name)}</div>
        <div class="stats">
          <div class="card stat"><div class="v num">${fmtNum(last)}</div><div class="l">Máx. último (${item.unit})</div></div>
          <div class="card stat"><div class="v num">${d > 0 ? "+" : ""}${fmtNum(d)}</div><div class="l">Desde el ${fmtShort(item.pts[0].date)}</div></div>
          <div class="card stat"><div class="v num">${item.pts.length}</div><div class="l">Veces registrado</div></div>
        </div>
        <div class="card chart-wrap" style="margin-top:10px">${bigChart(item)}</div>
        <div class="section-title">Registro</div>
        <div class="card" style="overflow-x:auto"><table class="tbl"><thead><tr><th>Fecha</th><th>Series</th></tr></thead><tbody>
          ${[...item.pts].reverse().map((p) => `<tr><td style="white-space:nowrap">${fmtDay(p.date)}</td><td class="num">${h(setsText(p.sets))}</td></tr>`).join("")}
        </tbody></table></div>`;
    }
    S.progressKey = null;
  }
  const month = todayISO().slice(0, 7);
  const days = new Set(S.sessions.map((s) => s.date));
  const thisMonth = [...days].filter((d) => d.startsWith(month)).length;
  const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 6);
  const wk = weekAgo.toISOString().slice(0, 10);
  const thisWeek = [...days].filter((d) => d >= wk).length;
  if (!data.length) return `<div class="empty card" style="margin-top:20px"><strong>Todavía no hay registros</strong>Cuando anotes series con peso, acá vas a ver cómo suben.</div>`;
  return `
    <div class="stats">
      <div class="card stat"><div class="v num">${thisWeek}</div><div class="l">Últimos 7 días</div></div>
      <div class="card stat"><div class="v num">${thisMonth}</div><div class="l">Este mes</div></div>
      <div class="card stat"><div class="v num">${days.size}</div><div class="l">Entrenos en total</div></div>
    </div>
    <div class="section-title">Por ejercicio <span class="tag muted">máximo de cada día</span></div>
    <div class="card prog-list">
      ${data.map((it) => {
        const d = it.pts.at(-1).top - it.pts[0].top;
        const cls = it.pts.length < 2 ? "flat" : d > 0 ? "up" : d < 0 ? "down" : "flat";
        const dtxt = it.pts.length < 2 ? "1 registro" : d === 0 ? "igual" : `${d > 0 ? "+" : ""}${fmtNum(d)} ${it.unit}`;
        return `<button class="prog-item" data-prog="${h(it.key)}">
          <span><span class="name">${h(it.name)}</span><br><span class="sub">Último: ${fmtShort(it.pts.at(-1).date)}</span></span>
          ${sparkline(it.pts)}
          <span class="val num">${fmtNum(it.pts.at(-1).top)}<small style="font-size:13px"> ${it.unit}</small><span class="delta ${cls}">${dtxt}</span></span>
        </button>`;
      }).join("")}
    </div>`;
}

// ----- History -----
function viewHistory() {
  if (!S.sessions.length) return `<div class="empty card" style="margin-top:20px"><strong>Sin entrenos todavía</strong>${isCoach() ? "Cuando anote un entreno lo vas a ver acá." : "Lo que anotes en Entrenar aparece acá."}</div>`;
  const idx = exerciseIndex();
  let html = "", lastMonth = "";
  for (const s of S.sessions) {
    const m = asDate(s.date).toLocaleDateString("es-ES", { month: "long", year: "numeric" });
    if (m !== lastMonth) { html += `<div class="section-title">${h(m)}</div>`; lastMonth = m; }
    const open = S.openSession === s.id;
    const r = routineById(s.routine_id);
    const exs = Object.entries(s.entries || {});
    const withSets = exs.filter(([, e]) => setsOf(e).length);
    const vol = sessionVolume(s);
    const order = [];
    if (r) r.days.find((d) => d.id === s.day_id)?.blocks.forEach((b) => b.exercises.forEach((e) => order.push(e.key)));
    withSets.sort((a, b) => (order.indexOf(a[0]) + 1 || 999) - (order.indexOf(b[0]) + 1 || 999));
    const checks = exs.filter(([, e]) => e.done).length;
    html += `<article class="card sess">
      <button class="sess-head" data-sess="${s.id}" aria-expanded="${open}">
        <span class="date-badge"><span class="d num">${asDate(s.date).getDate()}</span><span class="m">${asDate(s.date).toLocaleDateString("es-ES", { weekday: "short" })}</span></span>
        <span class="grow"><b>${h(s.day_name || s.day_id)}</b>${r ? ` <span class="muted small">· ${h(r.name)}</span>` : ""}<br>
          <span class="small muted num">${withSets.length} ejercicios${vol ? ` · ${fmtNum(Math.round(vol))} kg movidos` : ""}${s.coach_note ? " · 💬" : ""}</span></span>
        <span class="muted" aria-hidden="true">${open ? "▴" : "▾"}</span>
      </button>
      ${open ? `<div class="sess-body">
        ${checks ? `<div class="small muted">Entrada en calor: ${checks} ejercicios marcados</div>` : ""}
        ${withSets.map(([k, e]) => `<div class="sess-ex"><b>${h(idx.get(k)?.name || k)}</b><span></span><span class="sets-txt">${h(setsText(e.sets))}${e.note ? ` — ${h(e.note)}` : ""}</span></div>`).join("")}
        ${s.note ? `<div class="small"><b>Notas:</b> ${h(s.note)}</div>` : ""}
        ${isCoach() ? `
          <div class="field"><label for="cn-${s.id}">Tu comentario para ${h(athleteName())}</label>
          <textarea class="input" id="cn-${s.id}" data-coachnote="${s.id}">${h(s.coach_note)}</textarea></div>
          <div><button class="btn primary sm" data-savecoach="${s.id}">Guardar comentario</button> <span class="small muted" id="cn-st-${s.id}"></span></div>`
          : (s.coach_note ? `<div class="coach-box"><div class="who">Tu entrenadora</div>${h(s.coach_note)}</div>` : "")}
        ${!isCoach() ? (S.confirmDelete === s.id
          ? `<div class="confirm"><span>¿Borrar este entreno?</span><button class="btn sm danger" data-delsess="${s.id}">Sí, borrar</button><button class="btn sm" data-act="cancel-del">No</button></div>`
          : `<div class="row"><button class="btn sm" data-editsess="${s.id}">Editar</button><button class="btn ghost sm danger" data-askdel="${s.id}">Borrar</button></div>`) : ""}
      </div>` : ""}
    </article>`;
  }
  return html;
}

// ----- Routines -----
function viewRoutines() {
  const cur = currentRoutine();
  const list = S.routines.map((r) => {
    const open = S.openRoutine === r.id;
    return `<article class="card rt">
      <button class="rt-head" data-rt="${r.id}" aria-expanded="${open}">
        <span class="grow"><span class="nm">${h(r.name)}</span><br><span class="small muted">${r.from ? `${fmtShort(r.from)} – ${fmtShort(r.to)}` : "Sin fechas"} · ${r.days.map((d) => h(d.name)).join(", ")}</span></span>
        ${cur && cur.id === r.id ? '<span class="badge">Vigente</span>' : ""}
        <span class="muted" aria-hidden="true">${open ? "▴" : "▾"}</span>
      </button>
      ${open ? `<div class="rt-body">
        <div class="row" style="flex-wrap:wrap">
          <button class="btn sm" data-editrt="${r.id}">Editar</button>
          <button class="btn sm" data-duprt="${r.id}">Duplicar como nueva</button>
          ${S.confirmRoutine === r.id
            ? `<span class="confirm"><span>¿Borrar rutina? Los entrenos quedan.</span><button class="btn sm danger" data-delrt="${r.id}">Borrar</button><button class="btn sm" data-act="cancel-rt">No</button></span>`
            : `<button class="btn ghost sm danger" data-askrt="${r.id}">Borrar</button>`}
        </div>
        ${r.days.map((d) => `<div class="rt-day"><h3>${h(d.name)}</h3>${d.blocks.map((b) => `
          <div class="rt-block"><span class="bn">${h(b.name)}</span>${b.sets ? ` <span class="muted">· ${h(b.sets)}</span>` : ""}
            ${b.notes ? `<div class="muted small">${h(b.notes)}</div>` : ""}
            <ul>${b.exercises.map((e) => `<li>${h(e.name)}${[e.sets && `${e.sets} series`, e.reps && `${e.reps} reps`, e.kg && `${e.kg} kg`].filter(Boolean).length ? ` <span class="muted">— ${h([e.sets && `${e.sets} series`, e.reps && (e.mode === "check" ? e.reps : `${e.reps} reps`), e.kg && `${e.kg} kg`].filter(Boolean).join(" · "))}</span>` : ""}</li>`).join("")}</ul>
          </div>`).join("")}</div>`).join("")}
      </div>` : ""}
    </article>`;
  }).join("");
  return `
    <div class="row" style="margin-top:14px"><span class="grow small muted">${S.routines.length} rutina${S.routines.length === 1 ? "" : "s"}</span><button class="btn primary" data-act="new-routine">+ Nueva rutina</button></div>
    <div style="margin-top:12px">${list || '<div class="empty card"><strong>Sin rutinas</strong>Cargá la primera con el botón de arriba.</div>'}</div>`;
}

// ----- Routine editor -----
function viewEditor() {
  const r = S.editor.data;
  const known = [...exerciseIndex().values()];
  return `
    <datalist id="known-ex">${known.map((e) => `<option value="${h(e.name)}"></option>`).join("")}</datalist>
    <div class="stack" style="margin-top:14px">
      <div class="field"><label for="ed-name">Nombre</label><input class="input" id="ed-name" data-path="name" value="${h(r.name)}" placeholder="Mes 6"></div>
      <div class="ed-grid two">
        <div class="field"><label for="ed-from">Desde</label><input type="date" class="input" id="ed-from" data-path="from" value="${h(r.from || "")}"></div>
        <div class="field"><label for="ed-to">Hasta</label><input type="date" class="input" id="ed-to" data-path="to" value="${h(r.to || "")}"></div>
      </div>
      ${r.days.map((d, di) => `
        <div class="ed-day">
          <div class="ed-head"><div class="field"><label>Día</label><input class="input" data-path="days.${di}.name" value="${h(d.name)}"></div><button class="x" data-ed="del-day" data-di="${di}" aria-label="Quitar día">×</button></div>
          ${d.blocks.map((b, bi) => `
            <div class="ed-block">
              <div class="ed-head"><div class="field"><label>Bloque</label><input class="input" data-path="days.${di}.blocks.${bi}.name" value="${h(b.name)}"></div>
                <div class="field" style="max-width:110px"><label>Series</label><input class="input" data-path="days.${di}.blocks.${bi}.sets" value="${h(b.sets || "")}"></div>
                <button class="x" data-ed="del-block" data-di="${di}" data-bi="${bi}" aria-label="Quitar bloque">×</button></div>
              <div class="field"><label>Indicaciones del bloque</label><input class="input" data-path="days.${di}.blocks.${bi}.notes" value="${h(b.notes || "")}"></div>
              <div class="field"><label>Cómo se hacen</label><select class="input" data-path="days.${di}.blocks.${bi}.circuit">
                <option value="no" ${!isCircuit(b) ? "selected" : ""}>Cada ejercicio con todas sus series</option>
                <option value="si" ${isCircuit(b) ? "selected" : ""}>Alternados por ronda (dupleto, tripleto…)</option>
              </select></div>
              ${b.exercises.map((e, ei) => {
                const p = `days.${di}.blocks.${bi}.exercises.${ei}`;
                return `<div class="ed-ex">
                  <div class="ed-head"><div class="field"><label>Ejercicio</label><input class="input" list="known-ex" data-path="${p}.name" value="${h(e.name)}"></div>
                    <button class="x" data-ed="del-ex" data-di="${di}" data-bi="${bi}" data-ei="${ei}" aria-label="Quitar ejercicio">×</button></div>
                  <div class="ed-grid">
                    <div class="field"><label>Series</label><input class="input" data-path="${p}.sets" value="${h(e.sets || "")}"></div>
                    <div class="field"><label>Reps</label><input class="input" data-path="${p}.reps" value="${h(e.reps || "")}"></div>
                    <div class="field"><label>Kg</label><input class="input" data-path="${p}.kg" value="${h(e.kg || "")}"></div>
                  </div>
                  <div class="field"><label>Se anota</label><select class="input" data-path="${p}.mode">
                    ${[["peso", "Reps y peso"], ["reps", "Solo reps"], ["check", "Tilde (hecho)"]].map(([v, l]) => `<option value="${v}" ${e.mode === v ? "selected" : ""}>${l}</option>`).join("")}
                  </select></div>
                  <div class="field"><label>Descanso entre series (seg)</label><input class="input" inputmode="numeric" data-path="${p}.rest" value="${h(e.rest || "")}" placeholder="${store.get("restDefault", 60)}"></div>
                  <div class="field"><label>Cómo se hace</label><textarea class="input" data-path="${p}.notes">${h(e.notes || "")}</textarea></div>
                </div>`;
              }).join("")}
              <button class="btn ghost sm" data-ed="add-ex" data-di="${di}" data-bi="${bi}">+ Ejercicio</button>
            </div>`).join("")}
          <button class="btn ghost sm" data-ed="add-block" data-di="${di}">+ Bloque</button>
        </div>`).join("")}
      <button class="btn" data-ed="add-day">+ Día</button>
      <p class="err" id="ed-err" hidden></p>
      <div class="row"><button class="btn primary" data-act="save-routine">Guardar rutina</button><button class="btn" data-act="cancel-editor">Cancelar</button></div>
    </div>`;
}
function setPath(obj, path, val) {
  const parts = path.split("."); let o = obj;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
  o[parts.at(-1)] = val;
}
function finalizeRoutine(r) {
  const byName = new Map([...exerciseIndex().values()].map((e) => [e.name.trim().toLowerCase(), e.key]));
  r.days.forEach((d) => {
    d.id = d.id || slug(d.name);
    const used = new Set();
    d.blocks.forEach((b) => b.exercises.forEach((e) => {
      e.name = (e.name || "").trim() || "Ejercicio";
      // same name as a known exercise → same key, so progress carries across months
      e.key = byName.get(e.name.toLowerCase()) || e.key || slug(e.name);
      let k = e.key, n = 2;
      while (used.has(k)) k = `${e.key}-${n++}`;
      e.key = k; used.add(k);
      e.mode = e.mode || "peso";
    }));
  });
  const ids = new Set();
  r.days.forEach((d) => { let id = d.id, n = 2; while (ids.has(id)) id = `${d.id}-${n++}`; d.id = id; ids.add(id); });
  return r;
}

// ----- Sheets -----
function viewSheet() {
  if (S.sheet === "menu") {
    return `<div class="sheet-bg" data-act="close-sheet"><div class="sheet" role="dialog" aria-label="Cuenta">
      <h2>${h(S.me.name)}</h2>
      <div class="small muted">${h(S.me.email)} · ${isCoach() ? "Entrenadora" : "Atleta"}</div>
      <div class="field"><label for="pw-cur">Contraseña actual</label><input type="password" class="input" id="pw-cur" autocomplete="current-password"></div>
      <div class="field"><label for="pw-new">Nueva contraseña (mín. 8)</label><input type="password" class="input" id="pw-new" autocomplete="new-password"></div>
      <p class="small" id="pw-msg" hidden></p>
      <div class="row"><button class="btn" data-act="change-pw">Cambiar contraseña</button><span class="grow"></span><button class="btn danger" data-act="logout">Cerrar sesión</button></div>
    </div></div>`;
  }
  if (S.sheet === "new-routine") {
    return `<div class="sheet-bg" data-act="close-sheet"><div class="sheet" role="dialog" aria-label="Nueva rutina">
      <h2>Nueva rutina</h2>
      ${S.canParse ? `
        <div class="field"><label for="paste">Pegá el mensaje de WhatsApp de la rutina</label>
        <textarea class="input" id="paste" rows="8" placeholder="*Entrenamiento Juli 6to mes* …"></textarea></div>
        <p class="err" id="parse-err" hidden></p>
        <button class="btn primary" data-act="parse">Interpretar y revisar</button>
        <div class="small muted">Vas a poder revisar y corregir todo antes de guardar.</div>
        <hr style="border:0;border-top:1px solid var(--line);width:100%">`
        : `<p class="small muted">Para pegar el texto de WhatsApp y que se cargue solo, hay que configurar OPENROUTER_API_KEY en el servidor.</p>`}
      ${S.routines.length ? `<button class="btn" data-duprt="${currentRoutine().id}">Partir de la rutina vigente</button>` : ""}
      <button class="btn" data-act="blank-routine">Empezar en blanco</button>
    </div></div>`;
  }
  return "";
}

// ---------- events ----------
$app.addEventListener("input", (ev) => {
  const el = ev.target;
  if (el.dataset.set) {
    const key = el.dataset.set, i = +el.dataset.i;
    const e = ensureEntry(key, Math.max(visibleRows(key), i + 1));
    e.sets[i][el.dataset.f] = el.value;
    if (el.dataset.block) {
      const { exs } = circuitExercises(+el.dataset.block);
      $app.querySelector(`[data-round="${el.dataset.block}-${i}"]`)?.classList.toggle("done", roundDone(exs, i));
    }
    changed();
  } else if (el.dataset.note !== undefined && S.train) {
    if (!S.train.entries[el.dataset.note]) S.train.entries[el.dataset.note] = {};
    S.train.entries[el.dataset.note].note = el.value; changed();
  } else if (el.id === "train-note") {
    S.train.note = el.value; changed();
  } else if (el.dataset.path && S.editor) {
    setPath(S.editor.data, el.dataset.path, el.value);
  }
});

$app.addEventListener("change", async (ev) => {
  const el = ev.target;
  if (el.id === "train-date" && el.value) {
    await saveNow();
    // jump to that weekday's routine day if there is one, otherwise stay on the current day
    const wd = DAY_IDS[asDate(el.value).getDay()];
    const r = currentRoutine(el.value);
    initTrain(el.value, r?.days.some((d) => d.id === wd) ? wd : S.train.dayId); render();
  }
  if (el.id === "train-routine") { await saveNow(); initTrain(S.train.date, null, +el.value); render(); }
  if (el.id === "athlete-sel") { S.athleteId = +el.value; store.set("athlete", S.athleteId); await loadData(); render(); }
  if (el.dataset.path && S.editor && el.tagName === "SELECT") setPath(S.editor.data, el.dataset.path, el.value);
});

async function saveNow() {
  if (S.save.state === "dirty") { clearTimeout(S.save.timer); await saveTrain(); }
}

$app.addEventListener("click", async (ev) => {
  const el = ev.target.closest("button, [data-act]");
  if (!el) return;
  if (el.classList.contains("sheet-bg") && ev.target !== el) return;
  const d = el.dataset;

  if (d.tab) {
    await saveNow(); S.tab = d.tab; S.editor = null; store.set("tab", d.tab);
    if (d.tab === "entrenar" && !isCoach()) initTrain();
    render(); window.scrollTo(0, 0); return;
  }
  if (d.day) { await saveNow(); initTrain(S.train.date, d.day, S.train.routineId); render(); return; }
  if (d.check) {
    const e = S.train.entries[d.check] || (S.train.entries[d.check] = {});
    e.done = !e.done; el.setAttribute("aria-pressed", String(e.done)); changed(); return;
  }
  if (d.extimer) { startTimer({ kind: "ex", key: d.extimer, secs: +d.secs, label: d.label }); return; }
  if (d.rest) { startTimer({ kind: "rest", key: d.rest, secs: +d.secs, label: d.label }); return; }
  if (d.addround) {
    const { exs } = circuitExercises(+d.addround);
    const n = $app.querySelectorAll(`section[data-block="${d.addround}"] .round`).length;
    exs.forEach((e) => { const en = ensureEntry(e.key, n); en.sets.push({ reps: "", kg: "" }); });
    rerenderBlock(+d.addround); return;
  }
  if (d.delround) {
    const { exs } = circuitExercises(+d.delround);
    const n = $app.querySelectorAll(`section[data-block="${d.delround}"] .round`).length;
    exs.forEach((e) => {
      const en = ensureEntry(e.key, n);
      if (en.sets.length > 1) en.sets.splice(+d.i, 1); else en.sets = [{ reps: "", kg: "" }];
    });
    rerenderBlock(+d.delround); changed(); return;
  }
  if (d.addset) { const e = ensureEntry(d.addset, visibleRows(d.addset)); e.sets.push({ reps: "", kg: "" }); rerenderCard(d.addset); return; }
  if (d.delset) {
    const e = ensureEntry(d.delset, visibleRows(d.delset));
    if (e.sets.length > 1) e.sets.splice(+d.i, 1); else e.sets = [{ reps: "", kg: "" }];
    rerenderCard(d.delset); changed(); return;
  }
  if (d.copylast) {
    const last = lastFor(d.copylast, S.train.date, S.train.dayId);
    const e = ensureEntry(d.copylast, 0);
    e.sets = setsOf(last.entries[d.copylast]).map((s) => ({ reps: s.reps ?? "", kg: s.kg ?? "" }));
    rerenderCard(d.copylast); changed(); return;
  }
  if (d.addnote) {
    el.hidden = true;
    const inp = $app.querySelector(`[data-note="${CSS.escape(d.addnote)}"]`); inp.hidden = false; inp.focus(); return;
  }
  if (d.prog) { S.progressKey = d.prog; render(); window.scrollTo(0, 0); return; }
  if (d.sess) { S.openSession = S.openSession === +d.sess ? null : +d.sess; S.confirmDelete = null; render(); return; }
  if (d.askdel) { S.confirmDelete = +d.askdel; render(); return; }
  if (d.delsess) {
    await api("DELETE", `/api/sessions/${d.delsess}`);
    S.sessions = S.sessions.filter((s) => s.id !== +d.delsess); S.confirmDelete = null; render(); return;
  }
  if (d.editsess) {
    const s = S.sessions.find((x) => x.id === +d.editsess);
    S.tab = "entrenar"; store.set("tab", "entrenar");
    initTrain(s.date, s.day_id, s.routine_id || undefined); render(); window.scrollTo(0, 0); return;
  }
  if (d.savecoach) {
    const id = +d.savecoach; const txt = document.getElementById(`cn-${id}`).value;
    const st = document.getElementById(`cn-st-${id}`); st.textContent = "Guardando…";
    try {
      const saved = await api("PATCH", `/api/sessions/${id}/coach-note`, { coach_note: txt });
      const i = S.sessions.findIndex((s) => s.id === id); S.sessions[i] = saved; st.textContent = "Guardado";
    } catch (e) { st.textContent = e.message; }
    return;
  }
  if (d.rt) { S.openRoutine = S.openRoutine === +d.rt ? null : +d.rt; S.confirmRoutine = null; render(); return; }
  if (d.askrt) { S.confirmRoutine = +d.askrt; render(); return; }
  if (d.delrt) {
    await api("DELETE", `/api/routines/${d.delrt}`);
    S.routines = S.routines.filter((r) => r.id !== +d.delrt); S.confirmRoutine = null; if (!isCoach()) initTrain(); render(); return;
  }
  if (d.editrt) { const r = routineById(+d.editrt); S.editor = { id: r.id, data: clone({ name: r.name, from: r.from, to: r.to, days: r.days }) }; render(); window.scrollTo(0, 0); return; }
  if (d.duprt) {
    const r = routineById(+d.duprt);
    const num = parseInt((r.name.match(/\d+/) || [])[0], 10);
    S.sheet = null;
    S.editor = { id: null, data: clone({ name: Number.isFinite(num) ? r.name.replace(/\d+/, num + 1) : `${r.name} (copia)`, from: "", to: "", days: r.days }) };
    render(); window.scrollTo(0, 0); return;
  }
  if (d.ed) {
    const r = S.editor.data, di = +d.di, bi = +d.bi, ei = +d.ei;
    if (d.ed === "add-day") r.days.push({ id: "", name: "Nuevo día", blocks: [{ name: "Bloque", sets: "", notes: "", exercises: [] }] });
    if (d.ed === "del-day") r.days.splice(di, 1);
    if (d.ed === "add-block") r.days[di].blocks.push({ name: "Bloque", sets: "", notes: "", exercises: [] });
    if (d.ed === "del-block") r.days[di].blocks.splice(bi, 1);
    if (d.ed === "add-ex") r.days[di].blocks[bi].exercises.push({ key: "", name: "", mode: "peso", sets: "3", reps: "", kg: "", notes: "" });
    if (d.ed === "del-ex") r.days[di].blocks[bi].exercises.splice(ei, 1);
    const y = window.scrollY; render(); window.scrollTo(0, y); return;
  }

  switch (d.act) {
    case "menu": S.sheet = "menu"; render(); break;
    case "close-sheet": if (ev.target === el) { S.sheet = null; render(); } break;
    case "logout": await api("POST", "/api/logout").catch(() => {}); S.me = null; S.sheet = null; renderLogin(); break;
    case "change-pw": {
      const msg = document.getElementById("pw-msg"); msg.hidden = false;
      try {
        await api("POST", "/api/password", { current: document.getElementById("pw-cur").value, next: document.getElementById("pw-new").value });
        msg.textContent = "Contraseña cambiada."; msg.className = "small";
      } catch (e) { msg.textContent = e.message; msg.className = "small err"; }
      break;
    }
    case "prog-back": S.progressKey = null; render(); break;
    case "cancel-del": S.confirmDelete = null; render(); break;
    case "cancel-rt": S.confirmRoutine = null; render(); break;
    case "new-routine": S.sheet = "new-routine"; render(); break;
    case "blank-routine":
      S.sheet = null;
      S.editor = { id: null, data: { name: "", from: "", to: "", days: [{ id: "lunes", name: "Lunes", blocks: [{ name: "Bloque", sets: "", notes: "", exercises: [] }] }] } };
      render(); break;
    case "parse": {
      const err = document.getElementById("parse-err"); err.hidden = true;
      el.disabled = true; el.textContent = "Leyendo la rutina…";
      try {
        const data = await api("POST", "/api/routines/parse", { text: document.getElementById("paste").value });
        S.sheet = null; S.editor = { id: null, data: { name: data.name || "", from: data.from || "", to: data.to || "", days: data.days || [] } };
        render(); window.scrollTo(0, 0);
      } catch (e) { err.textContent = e.message; err.hidden = false; el.disabled = false; el.textContent = "Interpretar y revisar"; }
      break;
    }
    case "cancel-editor": S.editor = null; render(); break;
    case "save-routine": {
      const err = document.getElementById("ed-err"); err.hidden = true;
      const data = finalizeRoutine(clone(S.editor.data));
      if (!data.name.trim()) { err.textContent = "Ponele un nombre a la rutina."; err.hidden = false; break; }
      if (!data.days.length) { err.textContent = "La rutina necesita al menos un día."; err.hidden = false; break; }
      el.disabled = true;
      try {
        const saved = S.editor.id ? await api("PUT", `/api/routines/${S.editor.id}`, data) : await api("POST", "/api/routines", data);
        S.routines = await api("GET", "/api/routines");
        S.editor = null; S.tab = "rutinas"; S.openRoutine = saved.id;
        if (!isCoach()) initTrain();
        render(); window.scrollTo(0, 0);
      } catch (e) { err.textContent = e.message; err.hidden = false; el.disabled = false; }
      break;
    }
  }
});

// ---------- login ----------
function renderLogin() {
  $app.innerHTML = `
    <form class="login" id="login-form" novalidate>
      <div class="mark" aria-hidden="true"><span style="background:var(--plate-red)"></span><span style="background:var(--plate-blue)"></span><span style="background:var(--plate-yellow)"></span><span style="background:var(--plate-green)"></span></div>
      <h1>Entrenos de Juli</h1>
      <div class="field"><label for="email">Email</label><input class="input" id="email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="password">Contraseña</label><input class="input" id="password" type="password" autocomplete="current-password" required></div>
      <p class="err" id="login-err" hidden></p>
      <button class="btn primary" type="submit" style="justify-content:center">Entrar</button>
    </form>`;
  document.getElementById("login-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const err = document.getElementById("login-err"); err.hidden = true;
    try {
      await api("POST", "/api/login", { email: document.getElementById("email").value, password: document.getElementById("password").value });
      boot();
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  });
}

// ---------- timers ----------
// One timer at a time, in its own layer so re-renders never reset it.
// Counts from a fixed end time, so it stays right if the phone sleeps or the tab is throttled.
const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>';
const $timer = document.createElement("div");
$timer.className = "timer-layer";
document.body.appendChild($timer);
let T = null, tick = null, audio = null, wake = null;

function beep(times = 3) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < times; i++) {
      const o = audio.createOscillator(), g = audio.createGain(), t0 = audio.currentTime + i * 0.28;
      o.frequency.value = i === times - 1 ? 1320 : 880; o.type = "sine";
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.5, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      o.connect(g).connect(audio.destination); o.start(t0); o.stop(t0 + 0.24);
    }
  } catch {}
  try { navigator.vibrate?.([200, 100, 200, 100, 400]); } catch {}
}

function startTimer({ kind, key, secs, label }) {
  // first tap unlocks audio on iPhone
  try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch {}
  try { navigator.wakeLock?.request("screen").then((w) => { wake = w; }).catch(() => {}); } catch {}
  T = { kind, key, label, total: secs, endAt: Date.now() + secs * 1000, startedAt: Date.now(), done: false, paused: null };
  document.body.classList.add("has-timer");
  clearInterval(tick); tick = setInterval(drawTimer, 250);
  drawTimer();
}
function stopTimer() {
  clearInterval(tick); T = null; $timer.innerHTML = "";
  document.body.classList.remove("has-timer");
  try { wake?.release(); } catch {} wake = null;
}
function finishTimer() {
  T.done = true; beep();
  if (T.kind === "ex" && S.train) {
    const e = S.train.entries[T.key] || (S.train.entries[T.key] = {});
    if (!e.done) {
      e.done = true; changed();
      $app.querySelectorAll(`[data-check="${CSS.escape(T.key)}"]`).forEach((b) => b.setAttribute("aria-pressed", "true"));
    }
    setTimeout(() => { if (T && T.kind === "ex" && T.done) stopTimer(); }, 2500);
  }
}
function drawTimer() {
  if (!T) return;
  const now = T.paused ?? Date.now();
  const left = (T.endAt - now) / 1000;
  if (left <= 0 && !T.done) finishTimer();
  if (!T) return;
  const over = left <= 0;
  const frac = Math.max(0, Math.min(1, left / T.total));
  const title = T.kind === "rest" ? "Descanso" : "En curso";
  $timer.innerHTML = `
    <div class="timer ${over ? "over" : ""} ${T.kind}" role="timer" aria-live="off">
      <div class="timer-bar" style="transform:scaleX(${frac})"></div>
      <div class="timer-info">
        <span class="timer-kind">${over ? (T.kind === "rest" ? "¡A la serie!" : "¡Listo!") : title}</span>
        <span class="timer-label">${h(T.label)}</span>
      </div>
      <span class="timer-clock num">${over ? "+" : ""}${fmtClock(left > 0 ? Math.ceil(left) : left)}</span>
      <div class="timer-btns">
        ${over ? "" : `<button data-t="minus" aria-label="Restar 15 segundos">−15</button><button data-t="plus" aria-label="Sumar 15 segundos">+15</button>`}
        ${!over ? `<button data-t="pause" aria-label="${T.paused ? "Seguir" : "Pausar"}">${T.paused ? "▶" : "❚❚"}</button>` : ""}
        <button data-t="stop" class="stop" aria-label="Cerrar temporizador">✕</button>
      </div>
    </div>`;
}
$timer.addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-t]"); if (!b || !T) return;
  const a = b.dataset.t;
  if (a === "stop") return stopTimer();
  if (a === "plus") { T.endAt += 15000; T.total += 15; }
  if (a === "minus") { T.endAt -= 15000; T.total = Math.max(1, T.total - 15); }
  if (a === "pause") {
    if (T.paused) { T.endAt += Date.now() - T.paused; T.paused = null; } else T.paused = Date.now();
  }
  drawTimer();
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && T) { drawTimer(); try { navigator.wakeLock?.request("screen").then((w) => { wake = w; }).catch(() => {}); } catch {} } });

// Save before the app goes to background (phones kill tabs)
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveNow(); });

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
boot();
