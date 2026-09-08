require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const STAGES = ["Development", "Pre-Production", "Production", "Post", "Delivered", "On Hold"];
const HEALTHS = ["On track", "At risk", "Blocked", "Paused"];
const GENERAL_PROJECT_NAME = "General / Company-Wide";

if (!process.env.DATABASE_URL) {
  console.error(
    "Missing DATABASE_URL. Locally: copy .env.example to .env and fill it in.\n" +
    "On Railway: add a Postgres plugin to this project — it injects DATABASE_URL automatically."
  );
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

let anthropic = null;
if (process.env.ANTHROPIC_API_KEY) {
  const Anthropic = require("@anthropic-ai/sdk");
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
} else {
  console.warn("ANTHROPIC_API_KEY not set — /api/notes/generate will return 501 until it's added.");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'Untitled Project',
  stage TEXT NOT NULL DEFAULT 'Development',
  health TEXT NOT NULL DEFAULT 'On track',
  summary TEXT NOT NULL DEFAULT '',
  staffing JSONB NOT NULL DEFAULT '[]',
  milestones JSONB NOT NULL DEFAULT '[]',
  items JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS checkins (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL DEFAULT '',
  attendees TEXT NOT NULL DEFAULT '',
  decisions JSONB NOT NULL DEFAULT '[]',
  parking_lot JSONB NOT NULL DEFAULT '[]',
  projects_touched JSONB NOT NULL DEFAULT '[]',
  transcript_excerpt TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function initSchema() {
  await pool.query(SCHEMA);
  console.log("Schema ready.");
}

function rowToJson(r) {
  return {
    id: r.id, name: r.name, stage: r.stage, health: r.health, summary: r.summary,
    staffing: r.staffing, milestones: r.milestones, items: r.items,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function checkinToJson(r) {
  return {
    id: r.id, date: r.date, attendees: r.attendees, decisions: r.decisions,
    parkingLot: r.parking_lot, projectsTouched: r.projects_touched,
    transcriptExcerpt: r.transcript_excerpt, createdAt: r.created_at,
  };
}

// Tolerant JSON extraction from an LLM reply: try the whole text, then a
// fenced code block, then the outermost {...} span.
function extractJson(text) {
  const attempts = [text.trim()];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) attempts.push(fence[1].trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) attempts.push(text.slice(first, last + 1));
  for (const attempt of attempts) {
    try { return JSON.parse(attempt); } catch (_e) { /* try next */ }
  }
  throw new Error("Could not parse a JSON object out of the model's reply.");
}

function truncateForPrompt(text) {
  const MAX = 50000;
  if (text.length <= MAX) return text;
  return text.slice(0, 30000) + "\n\n[... transcript truncated for length ...]\n\n" + text.slice(text.length - 18000);
}

const RULES = `You are drafting notes for a bi-weekly Exec Producer check-in at Andas Productions.
The person running this meeting is a co-founder acting as Exec Producer: he tracks high-level status
across every production without necessarily running any of them day to day. This is NOT a project
working session — keep every project write-up high-level (1-3 sentences), never a blow-by-blow.

Rule 1 (most important): every follow-up item MUST have an owner. Never invent or guess one from vague
context. If the transcript does not make the owner unambiguous, set owner to exactly "UNCLEAR".
Rule 2: only record something under decisions if it was an explicit agreement or call, not just floated
or debated — undecided-but-discussed topics go under parkingLot instead.
Rule 3: set needsSupport to true on a follow-up only if it's something the company/leadership needs to
help unblock (budget, an intro, a resourcing decision, approval) — not routine project work.
Rule 4: set calendarFlag to true on a follow-up only if it implies scheduling a future meeting or event.
Rule 5: do not fabricate. If part of the transcript is unclear or cut off, say so plainly instead of guessing.
Rule 6: be concise and scannable — no filler, no restating the obvious.

Every projectUpdate, decision and followUp must be tagged with a "project" field. If it clearly belongs
to one of the EXISTING PROJECTS listed below, use that project's name exactly as given. If it's about a
new production not in that list, use its name and set isNewProject: true (projectUpdates only). If it
isn't about any specific production (company-wide business), use exactly "${GENERAL_PROJECT_NAME}".

Valid "stage" values: ${STAGES.join(", ")}.
Valid "health" values: ${HEALTHS.join(", ")}.

Reply with ONLY a JSON object of exactly this shape, no other text, no markdown fence:
{
  "date": "YYYY-MM-DD, best guess or the given date",
  "attendees": "comma-separated names, best effort",
  "projectUpdates": [ { "project": "string", "isNewProject": true, "stage": "string or empty", "health": "string or empty", "update": "1-3 sentence summary" } ],
  "decisions": [ { "project": "string", "text": "string" } ],
  "followUps": [ { "project": "string", "owner": "name or UNCLEAR", "item": "string", "due": "date string or empty", "needsSupport": true, "calendarFlag": false } ],
  "parkingLot": [ "string" ]
}
Use empty arrays where a section has nothing.`;

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (req, res) => res.json({ ok: true }));

// ---------- projects ----------
app.get("/api/projects", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM projects ORDER BY created_at ASC");
    res.json(rows.map(rowToJson));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Couldn't load projects." });
  }
});

app.post("/api/projects", async (req, res) => {
  try {
    const b = req.body || {};
    const id = b.id || crypto.randomUUID();
    const { rows } = await pool.query(
      `INSERT INTO projects (id, name, stage, health, summary, staffing, milestones, items)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, b.name || "Untitled Project", b.stage || "Development", b.health || "On track", b.summary || "",
       JSON.stringify(b.staffing || []), JSON.stringify(b.milestones || []), JSON.stringify(b.items || [])]
    );
    res.status(201).json(rowToJson(rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Couldn't create project." });
  }
});

app.put("/api/projects/:id", async (req, res) => {
  try {
    const b = req.body || {};
    const { rows } = await pool.query(
      `UPDATE projects SET name=$2, stage=$3, health=$4, summary=$5, staffing=$6, milestones=$7, items=$8, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [req.params.id, b.name || "Untitled Project", b.stage || "Development", b.health || "On track", b.summary || "",
       JSON.stringify(b.staffing || []), JSON.stringify(b.milestones || []), JSON.stringify(b.items || [])]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Not found." });
    res.json(rowToJson(rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Couldn't save project." });
  }
});

app.delete("/api/projects/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM projects WHERE id=$1", [req.params.id]);
    res.status(204).end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Couldn't delete project." });
  }
});

// ---------- check-ins ----------
app.get("/api/checkins", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM checkins ORDER BY created_at DESC LIMIT 20");
    res.json(rows.map(checkinToJson));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Couldn't load check-ins." });
  }
});

app.post("/api/notes/generate", async (req, res) => {
  if (!anthropic) {
    return res.status(501).json({ error: "ANTHROPIC_API_KEY isn't set on the server yet. Add it in Railway → Variables." });
  }
  const { transcript, date, attendees } = req.body || {};
  if (!transcript || !transcript.trim()) {
    return res.status(400).json({ error: "Transcript is empty." });
  }
  try {
    const { rows } = await pool.query("SELECT name FROM projects ORDER BY name ASC");
    const existingNames = rows.map((r) => r.name);
    const prompt =
      `EXISTING PROJECTS: ${existingNames.length ? existingNames.join(", ") : "(none yet)"}\n\n` +
      `Meeting date (given): ${date || "unspecified"}\n` +
      `Attendees (given, may be incomplete): ${attendees || "unspecified"}\n\n` +
      `TRANSCRIPT:\n"""\n${truncateForPrompt(transcript)}\n"""`;

    const msg = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
      max_tokens: 4096,
      system: RULES,
      messages: [{ role: "user", content: prompt }],
    });
    const text = (msg.content || []).map((b) => (b.type === "text" ? b.text : "")).join("");
    const data = extractJson(text);
    res.json(data);
  } catch (e) {
    console.error(e);
    const msg = e && e.status === 401
      ? "Anthropic rejected the API key — check ANTHROPIC_API_KEY in Railway."
      : "Couldn't generate notes. Try again.";
    res.status(500).json({ error: msg });
  }
});

app.post("/api/notes/confirm", async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: existingRows } = await client.query("SELECT * FROM projects");
    const byName = new Map(existingRows.map((r) => [r.name.trim().toLowerCase(), r]));

    async function getOrCreateProject(name, seedStage, seedHealth, seedSummary) {
      const key = (name || GENERAL_PROJECT_NAME).trim().toLowerCase();
      let row = byName.get(key);
      if (row) return { row, wasCreated: false };
      const id = crypto.randomUUID();
      const stage = STAGES.includes(seedStage) ? seedStage : "Development";
      const health = HEALTHS.includes(seedHealth) ? seedHealth : "On track";
      const { rows: created } = await client.query(
        `INSERT INTO projects (id, name, stage, health, summary, staffing, milestones, items)
         VALUES ($1,$2,$3,$4,$5,'[]','[]','[]') RETURNING *`,
        [id, name || GENERAL_PROJECT_NAME, stage, health, seedSummary || ""]
      );
      row = created[0];
      byName.set(key, row);
      return { row, wasCreated: true };
    }

    const itemsToAdd = new Map(); // project id -> array of items to append
    function queueItem(projectRow, item) {
      if (!itemsToAdd.has(projectRow.id)) itemsToAdd.set(projectRow.id, []);
      itemsToAdd.get(projectRow.id).push(item);
    }

    const touched = new Map(); // id -> {id, name, created, itemsAdded}
    function markTouched(row, created) {
      const t = touched.get(row.id) || { id: row.id, name: row.name, created: !!created, itemsAdded: 0 };
      t.created = t.created || !!created;
      touched.set(row.id, t);
      return t;
    }

    for (const pu of b.projectUpdates || []) {
      if (!pu || !pu.include) continue;
      const { row, wasCreated } = await getOrCreateProject(pu.project, pu.stage, pu.health, pu.update);
      markTouched(row, wasCreated);
      const stage = STAGES.includes(pu.stage) ? pu.stage : row.stage;
      const health = HEALTHS.includes(pu.health) ? pu.health : row.health;
      const summary = pu.update && pu.update.trim() ? pu.update.trim() : row.summary;
      await client.query(
        "UPDATE projects SET stage=$2, health=$3, summary=$4, updated_at=now() WHERE id=$1",
        [row.id, stage, health, summary]
      );
      row.stage = stage; row.health = health; row.summary = summary;
    }

    for (const f of b.followUps || []) {
      if (!f || !f.include) continue;
      const { row, wasCreated } = await getOrCreateProject(f.project, null, null, "");
      markTouched(row, wasCreated);
      queueItem(row, {
        text: (f.item || "").trim(),
        owner: (f.owner || "UNCLEAR").trim() || "UNCLEAR",
        due: f.due || "",
        done: false,
        needsSupport: !!f.needsSupport,
        calendarFlag: !!f.calendarFlag,
      });
    }

    for (const [projectId, newItems] of itemsToAdd.entries()) {
      const { rows: cur } = await client.query("SELECT items FROM projects WHERE id=$1", [projectId]);
      const existingItems = (cur[0] && cur[0].items) || [];
      const merged = existingItems.concat(newItems.filter((i) => i.text));
      await client.query("UPDATE projects SET items=$2, updated_at=now() WHERE id=$1", [projectId, JSON.stringify(merged)]);
      const t = touched.get(projectId);
      if (t) t.itemsAdded += newItems.filter((i) => i.text).length;
    }

    const checkinId = crypto.randomUUID();
    const projectsTouched = Array.from(touched.values());
    await client.query(
      `INSERT INTO checkins (id, date, attendees, decisions, parking_lot, projects_touched, transcript_excerpt)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [checkinId, b.date || "", b.attendees || "", JSON.stringify(b.decisions || []),
       JSON.stringify(b.parkingLot || []), JSON.stringify(projectsTouched), (b.transcriptExcerpt || "").slice(0, 4000)]
    );

    await client.query("COMMIT");
    res.status(201).json({ checkinId, projectsTouched });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "Couldn't push these notes to the board. Nothing was saved — try again." });
  } finally {
    client.release();
  }
});

initSchema()
  .then(() => { app.listen(PORT, () => console.log(`The Slate running on port ${PORT}`)); })
  .catch((e) => { console.error("Failed to initialize database schema:", e); process.exit(1); });
