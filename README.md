# Luxtronic PCTools -- Server

Node.js/Express + PostgreSQL server for the Luxtronic PCTools hardware-testing system. Ingests
telemetry from the PC-side client (`Luxtronic-PCTools-Client`), evaluates pass/fail against a
config file of thresholds, and serves a live-updating web dashboard with PDF export.

**This pass implements the CPU-only walking skeleton** per PROJECT_PLAN.md section 9: the full DB
schema and all REST endpoints exist, but only the CPU path is exercised by tests/manual
verification. See "Scope notes and judgment calls" below.

Canonical references: [PROJECT_PLAN.md](PROJECT_PLAN.md) (architecture/decisions) and
[CONTRACT.md](CONTRACT.md) (exact API/DB/WebSocket contract -- this implementation follows it
literally; deviations are called out below).

## Stack

- Node.js (>=18) + Express
- PostgreSQL (schema in `migrations/001_init.sql`, matches CONTRACT.md section 2 exactly)
- `ws` for WebSocket (`/ws/telemetry` ingest, `/ws/live` dashboard fan-out)
- `pdfkit` for PDF report generation (pure JS, no headless-browser dependency)
- Plain HTML/CSS/vanilla JS dashboard (Chart.js vendored locally in `public/vendor/`, no CDN/build
  step) -- intentionally minimal, this is an internal tool for 2 technicians.

No ORM, no ..js framework beyond Express, no ..js frameworks for the frontend, per the task's "don't
add a heavy ORM/framework beyond what's needed" instruction.

## Local setup

### 1. Postgres

You need a local Postgres reachable via a connection string. Two easy options:

**Docker (recommended for a throwaway local dev DB):**

```
docker run -d --name luxtronic_pctools_db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=luxtronic_pctools -p 5434:5432 postgres:16-alpine
```

(Port 5434 mirrors the production port from PROJECT_PLAN.md section 5, but for local dev any free
port works -- it's just what `.env.example` defaults to.)

**Or use an existing local Postgres install:** create a database, e.g.:

```
createdb luxtronic_pctools
```

### 2. Configure environment

```
cp .env.example .env
```

Edit `.env` if your `DATABASE_URL` differs from the default (`postgres://postgres:postgres@localhost:5434/luxtronic_pctools`).

### 3. Install dependencies

```
npm install
```

### 4. Run migrations

```
npm run migrate
```

This creates all tables from CONTRACT.md section 2 (technicians, machines, sessions, test_runs,
telemetry) plus a couple of non-schema-changing helper indexes. Safe to re-run -- tracks applied
migrations in a `schema_migrations` table.

### 5. Create a technician (API key)

CONTRACT.md has no REST endpoint for provisioning technicians (it's an infrequent admin action for
a 2-person shop), so there's a small CLI script instead:

```
npm run seed:technician -- "Your Name"
```

This prints a raw API key **once** -- save it. Only its SHA-256 hash is stored in the DB. The
PC-side client sends this as `X-Api-Key` on every request.

### 6. Start the server

```
npm start
```

or, for auto-restart on file changes during development:

```
npm run dev
```

Server listens on `PORT` (default `7777`). Dashboard: `http://localhost:7777/index.html`.

Production deploy (LAN box, `192.168.68.255:7777`, out of scope for this pass) follows the same
pm2 pattern as the other Luxtronic services (`lan-portal-deploy`: git pull + pm2 restart) --
nothing here assumes or configures that box.

### 7. Run the unit tests

```
npm test
```

Covers the two pieces of pure business logic that don't need a DB: the concurrency rule
(CONTRACT.md section 6) and result computation (section 7), including the stop_reason/aborted path
and the pass/fail/flagged boundary conditions.

## Project layout

```
migrations/           Plain SQL migrations (001_init.sql = CONTRACT.md section 2 schema)
db/
  pool.js              pg Pool, reads DATABASE_URL
  migrate.js           Minimal migration runner (tracks applied files in schema_migrations)
config/
  default.json         Thresholds/durations config file (CONTRACT.md section 3)
src/
  app.js               Express app wiring (routes, static files, error handling)
  server.js             Entrypoint: HTTP server + WebSocket upgrade routing, starts here
  config.js             Config file loader (re-reads from disk each call, see comments)
  lib/
    auth.js              API key hashing + lookup + requireApiKey() middleware
    concurrency.js        CONTRACT.md section 6 rule, as a pure function
    resultComputation.js  CONTRACT.md section 7 rule, as a pure function
    testRunCache.js        In-memory test_run_id -> {session_id, component} cache
    validation.js          Small input-validation helpers
    pdf.js                 PDF report generation (pdfkit)
  routes/
    pcClient.js            PC-client endpoints (auth required)
    dashboard.js            Dashboard endpoints (no auth)
  ws/
    hub.js                  In-memory pub/sub for /ws/live fan-out, keyed by session_id
    telemetry.js             /ws/telemetry connection handler
    live.js                  /ws/live connection handler
scripts/
  create-technician.js    CLI to provision a technician + API key
public/                  Static dashboard (plain HTML/CSS/JS, no build step)
  index.html               Session list + search
  session.html              Session detail: live/historical chart per test_run, PDF export link
  js/app.js, js/session.js
  css/style.css
  vendor/chart.umd.min.js  Vendored Chart.js (no CDN dependency)
test/                    node:test unit tests for concurrency.js and resultComputation.js
```

## Manual verification checklist

Everything below was exercised during development against a local Postgres via curl + a small
throwaway WebSocket script, and the dashboard was checked in a browser (including a 375px-wide
viewport for the mobile-responsiveness requirement). A human should re-verify end-to-end on a real
setup:

1. `npm run migrate` against a fresh DB, then `npm run seed:technician -- "Tech"` -- confirm it
   prints an API key.
2. `GET /api/config` with `X-Api-Key: <key>` -- confirm it returns the full config JSON; without
   the header, confirm `401`.
3. `POST /api/sessions` with a `mobo_serial`/`session_type` -- confirm `201` + `session_id`, and
   that a `machines` row was created/touched.
4. `POST /api/sessions/:id/test-runs` with `{"component":"cpu"}` -- confirm `201` + `test_run_id`.
   Immediately POST another `cpu` test-run for the same session -- confirm `409
   exclusive_conflict`. POST a `gpu` test-run while the `cpu` one is still open -- confirm `201`
   (this is the "together" mode). POST a `ram` test-run while `cpu` is open -- confirm `409`.
5. Open the dashboard (`/index.html`), open the session's detail page
   (`/session.html?id=<session_id>`) in a browser **before** completing the test run -- confirm
   the "running" badge shows and a chart area renders.
6. Connect a WebSocket to `/ws/telemetry?api_key=<key>` (or `X-Api-Key` header) and send a few
   `{"test_run_id":...,"ts":...,"sensor_name":"cpu_package_temp_c","value":...}` messages -- confirm
   the open dashboard tab's chart updates live, with no page reload.
7. `PATCH /api/sessions/:id/test-runs/:test_run_id` with `summary_stats` under/at/over
   `max_temp_c` -- confirm `pass`/`flagged`/`fail` respectively, and that the dashboard tab flips
   its badge and shows summary stats live (via the `test_run_status` push, no manual refresh).
8. `PATCH /api/sessions/:id/test-runs/:test_run_id` with a `stop_reason` -- confirm `result` is
   always `aborted` regardless of `summary_stats` content.
9. Start a test-run and then call `PATCH /api/sessions/:id` (end session) **without** completing
   the test-run first -- confirm the test_run is auto-closed with `result: "aborted"`,
   `stop_reason: "session_ended_early"`.
10. `GET /api/sessions/:id/report.pdf` -- confirm a PDF downloads with the session summary, a
    per-test-run table, and a line chart of the telemetry.
11. Load the dashboard on an actual phone (or a resized/mobile-emulated browser) -- confirm the
    session list and session detail (including the chart) are usable without horizontal scrolling
    of the page itself.
12. Restart the server process mid-test-run (simulating a crash) and send another telemetry
    sample for the same `test_run_id` -- confirm it's still accepted (the in-memory
    `testRunCache` falls back to a DB lookup for unknown `test_run_id`s) and still shows up live
    on a dashboard tab that re-subscribes.

## Scope notes and judgment calls (for reconciling with the client-side implementation)

CONTRACT.md is treated as canonical throughout, but a handful of points aren't fully pinned down
by it. Flagging these explicitly since the client is being built in parallel against the same
document:

1. **`GET /api/config` response shape.** CONTRACT.md section 4 just says "fetch current
   thresholds/durations JSON," with no query params defined. This implementation returns the
   **entire** config file (all four component subtrees + `concurrency`), not a single-component
   slice -- reasoned that the client needs the `concurrency` subtree regardless of which
   component(s) it's about to run, and potentially more than one component subtree in "cpu+gpu
   together" mode. If the client instead expects a per-component filtered response, that's a gap
   to reconcile.

2. **Result computation's generic threshold-matching algorithm (section 7).** The spec gives
   examples (`max_temp_c` breached, `min_seq_read_mb_s` not met) but not a general algorithm for
   how `summary_stats` keys map to config threshold keys across differently-shaped component
   config subtrees. This implementation uses a naming convention: any numeric config key starting
   with `max_` is an upper-bound hard limit if the *same key name* also appears in
   `summary_stats`; `min_` keys are lower-bound limits the same way. `error_count > 0` is always a
   hard fail per the literal wording, independent of any config key. Keys that don't fit the
   convention (e.g. `smart_reallocated_sectors_max`, whose likely `summary_stats` counterpart
   isn't specified anywhere) are simply not evaluated as thresholds. This only matters in practice
   for CPU right now (`max_temp_c`, which fits the convention cleanly) -- flagging it now so
   GPU/RAM/SSD summary_stats key names get chosen client-side to match this convention (or the
   server-side matching gets revisited) when those wrappers are built.

3. **"Borderline" / `flagged` threshold.** Interpreted literally per section 7's own example
   ("within 5% of a threshold") as `observed >= limit * 0.95` (for `max_` limits) or `observed <=
   limit * 1.05` (for `min_` limits). Not stated anywhere else, so worth confirming this matches
   what the client-side (or a human reviewer) expects, especially at exact boundary values (e.g.
   `max_temp_c` submitted exactly equal to the limit is currently `flagged`, not `fail` or `pass`
   -- see `test/resultComputation.test.js` for the boundary cases this implementation picked).

4. **`PATCH /api/sessions/:id` (end session) response body.** CONTRACT.md only specifies the
   request body (`{}`) and the side effect (sets `ended_at`, auto-closes open test_runs). This
   implementation returns `{ session_id, ended_at, auto_closed_test_run_ids }` so the client can
   confirm what happened. If the client expects an empty `200` or a different shape, reconcile.

5. **`GET /api/sessions/:id/telemetry` -- is `test_run_id` required?** Shown in CONTRACT.md as a
   query param on an endpoint description ("Historical telemetry for charts on a completed
   session") without stating required/optional. Implemented as optional: if given, scoped to that
   one test_run (validated as belonging to the session, `404` if not); if omitted, returns
   telemetry for every test_run in the session, each row tagged with its `test_run_id`.

6. **No technicians-list endpoint.** CONTRACT.md's dashboard `GET /api/sessions` query params
   include `technician_id`, but there's no endpoint for the dashboard to discover technician
   IDs/names to populate a filter control. The dashboard UI here doesn't expose a technician
   picker as a result (the query param is still honored server-side if hand-supplied); each
   session row is enriched with the technician's *name* (a join, not a schema or endpoint change)
   so the list is still useful without one. If a technicians-list endpoint is wanted, it isn't in
   CONTRACT.md's table and would need to be added there first.

7. **Technician provisioning has no endpoint at all** (mentioned above, restated here since it's a
   contract gap rather than an implementation choice) -- handled via `scripts/create-technician.js`
   instead. If technicians should ever be creatable from the client or dashboard, that needs a new
   endpoint added to CONTRACT.md.

8. **Extra (non-schema) DB indexes.** `migrations/001_init.sql` adds a few `CREATE INDEX`
   statements beyond CONTRACT.md section 2's literal DDL block (on `sessions.mobo_serial`,
   `sessions.technician_id`, `sessions.started_at`, `test_runs.session_id`, and a partial index for
   active `test_runs`). These don't change any table/column shape, just query performance for the
   dashboard's filters and the concurrency check's active-run lookup -- called out per the "don't
   add anything not in CONTRACT.md without flagging it" instruction, even though this isn't an
   endpoint.

9. **API key hashing algorithm.** CONTRACT.md says "server stores only a hash," not which
   algorithm. Used plain SHA-256 (not bcrypt/scrypt/argon2) since these are high-entropy,
   server-generated, long-lived technician keys (not user passwords) on a LAN-only tool -- and a
   fast deterministic hash keeps the WebSocket upgrade auth path simple (needs a quick synchronous
   lookup before accepting the handshake). Worth a second look if that threat model assumption is
   wrong.

## Explicitly not done in this pass (by design, per task scope)

- No GPU/RAM/SSD-specific parsing, threshold tuning, or wrapper logic -- those config sections are
  the contract's placeholder example values, untouched.
- No dashboard login/auth (explicitly no-login per PROJECT_PLAN.md).
- No admin UI for editing `config/default.json` (hand-edit the file, per plan).
- No connection to or configuration of the real `192.168.68.255` production box -- everything here
  is local-dev-configurable via `.env`.
- Nothing pushed to a remote -- this repo has no remote configured, and none was added.
