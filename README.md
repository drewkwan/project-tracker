# The Slate — Andas Productions

A shared, always-on project board: every production's stage, health, staffing,
upcoming milestones, and what it needs from the company. No login for v1 —
anyone with the URL can view and edit.

Two pages:
- `/` — the board (All Projects / Upcoming Milestones / Needs Support)
- `/notes.html` — bi-weekly check-in notes: record live or paste a transcript,
  Claude drafts structured notes, you review and edit, then push confirmed
  follow-ups straight into the right project's checklist (creating a new
  project card automatically if it names one that doesn't exist yet).

## Local dev

```
npm install
cp .env.example .env   # fill in DATABASE_URL and ANTHROPIC_API_KEY
npm start
```
Then open http://localhost:3000

## Deploy on Railway

```
railway login
railway init                # from this folder
railway add                  # pick "PostgreSQL" (arrow keys + Spacebar to select, then Enter)
railway up
```

Then, in the Railway dashboard, on your **app service** (not the Postgres one)
→ **Variables**, set:
- `DATABASE_URL` — paste the literal value from the Postgres service's own
  Variables tab (the `postgres.railway.internal` one — it only resolves
  between services running on Railway, not from your own machine)
- `ANTHROPIC_API_KEY` — from console.anthropic.com

Auto-deploy from GitHub: connect the app service to this repo (Settings →
connect the GitHub repo) and every `git push` to `main` redeploys automatically
— no more `railway up`.

The server creates its tables automatically on first boot (`server.js` →
`initSchema`), so there's no separate migration step.

## What's in here

- `server.js` — Express server: serves the frontend, a REST API for projects
  (`GET/POST /api/projects`, `PUT/DELETE /api/projects/:id`), a REST API for
  check-ins (`GET /api/checkins`, `POST /api/notes/generate`,
  `POST /api/notes/confirm`), all backed by Postgres. Calls Claude
  (`@anthropic-ai/sdk`) to turn a transcript into structured notes.
- `public/index.html` — the board.
- `public/notes.html` — check-in capture, review, and push-to-board.
- `public/styles.css` — shared design system for both pages.
- No auth yet. Flag it when it matters — small addition later.

## Data model notes

- A project's `health` (On track / At risk / Blocked / Paused) is
  intentionally separate from its `stage` (Development → ... → Delivered) —
  one tracks production phase, the other tracks whether it needs attention.
- "Tasks & Support Asks" is one unified checklist per project (`items`); an
  item with `needsSupport: true` shows up in the board's company-wide
  "Needs Support" tab. An item with `calendarFlag: true` came from a
  follow-up that implied scheduling something — nothing auto-schedules yet,
  that's flagged for the future Google Calendar / Telegram integration.
- Check-in notes that aren't about any specific production land on a
  catch-all project card named **"General / Company-Wide"**, auto-created
  the first time it's needed.
- `/api/notes/generate` never writes to the database — it only asks Claude
  and returns the draft for review. Nothing touches the board until you
  click "Push to the Slate" on `/notes.html`, which is the one endpoint
  (`/api/notes/confirm`) that writes.
- Deleting a project on the board requires clicking Delete twice (arms,
  then confirms) — there's no undo, so that's deliberate friction, not a bug.
