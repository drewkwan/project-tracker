require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;

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
`;

async function initSchema() {
  await pool.query(SCHEMA);
  console.log("Schema ready.");
}

function rowToJson(r) {
  return {
    id: r.id,
    name: r.name,
    stage: r.stage,
    health: r.health,
    summary: r.summary,
    staffing: r.staffing,
    milestones: r.milestones,
    items: r.items,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (req, res) => res.json({ ok: true }));

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
      [
        id,
        b.name || "Untitled Project",
        b.stage || "Development",
        b.health || "On track",
        b.summary || "",
        JSON.stringify(b.staffing || []),
        JSON.stringify(b.milestones || []),
        JSON.stringify(b.items || []),
      ]
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
      `UPDATE projects SET
         name=$2, stage=$3, health=$4, summary=$5,
         staffing=$6, milestones=$7, items=$8, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [
        req.params.id,
        b.name || "Untitled Project",
        b.stage || "Development",
        b.health || "On track",
        b.summary || "",
        JSON.stringify(b.staffing || []),
        JSON.stringify(b.milestones || []),
        JSON.stringify(b.items || []),
      ]
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

initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`The Slate running on port ${PORT}`));
  })
  .catch((e) => {
    console.error("Failed to initialize database schema:", e);
    process.exit(1);
  });
