# The Slate — Andas Productions

A shared, always-on project board: every production's stage, health, staffing,
upcoming milestones, and what it needs from the company. No login for v1 —
anyone with the URL can view and edit.

## Local dev

```
npm install
cp .env.example .env   # point DATABASE_URL at a local Postgres
npm start
```
Then open http://localhost:3000

## Deploy on Railway

You've already got the Railway CLI (`.railway` config on this machine), so:

```
railway login
railway init                # creates a new Railway project, run from this folder
railway add                 # choose "Postgres" — this provisions a DB and
                             # wires DATABASE_URL into your app's environment automatically
railway up                  # deploys this folder
```

Once it's deployed, run `railway domain` (or generate one from the Railway
dashboard: your service → Settings → Networking → Generate Domain) to get a
public URL. Share that URL with the team — that's the shared link everyone
opens.

The server creates its `projects` table automatically on first boot
(see `server.js` → `initSchema`), so there's no separate migration step.

## What's in here

- `server.js` — Express server: serves the frontend, and a small REST API
  (`GET/POST /api/projects`, `PUT/DELETE /api/projects/:id`) backed by Postgres.
- `public/index.html` — the whole frontend (board / milestones / needs-support
  views), plain HTML+CSS+JS, no build step. Polls the API every ~10s so
  everyone's changes show up for everyone else without a page refresh.
- No auth yet. If this needs to be locked down later (real login, or even
  just a shared password gate), that's a small addition — flag it when it
  matters.

## Notes for whoever picks this up later

- Health (On track / At risk / Blocked / Paused) is intentionally separate
  from Stage (Development → ... → Delivered) — one tracks production phase,
  the other tracks whether it needs attention.
- "Tasks & Support Asks" is one unified checklist per project; ticking
  "needs support" on an item is what makes it show up in the company-wide
  "Needs Support" tab.
- Deleting a project requires clicking Delete twice (arms, then confirms) —
  there's no undo, so that's deliberate friction, not a bug.
