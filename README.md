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
  step) -- intentionally minimal, this is an internal tool for 2 technicians. Has a light/dark
  theme toggle (opt-in via the button, never inferred from OS preference -- see `public/js/theme.js`)
  and dashboard-side controls to force-close a stuck test-run/session when its owning PC client has
  crashed or gone unreachable (`POST .../stop`, `POST .../end` -- CONTRACT.md section 4).

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

This prints a raw API key **once** -- save it. Only its SHA-256 hash is stored in the DB. It's also
written to `api_keys/<name>.txt` (git-ignored, see `api_keys/README.md`) -- that file's contents
are exactly what `Luxtronic-PCTools-Client`'s `ApiKeyProvider` expects, so provisioning a technician
is: run this command, then copy the resulting file onto their PC and rename it to `apikey.txt` next
to the client executable. The PC-side client sends the key as `X-Api-Key` on every request.

### 6. Start the server

```
npm start
```

or, for auto-restart on file changes during development:

```
npm run dev
```

Server listens on `PORT` (default `7777`). Dashboard: `http://localhost:7777/index.html`.

**Production (pm2):** `ecosystem.config.js` defines the process for the LAN box
(`192.168.68.255:7777`), deployed the same way as the other Luxtronic services
(`lan-portal-deploy`: git pull + pm2 restart) -- `pm2 start ecosystem.config.js`. It's fork mode
with exactly 1 instance, deliberately not cluster: `testRunCache.js` and the `/ws/live` pub/sub hub
are in-memory, per-process state, so more than one instance would let a dashboard tab subscribe to
an instance that never sees the telemetry another instance is receiving. Secrets (`DATABASE_URL`)
stay in `.env` on the box, not in the pm2 config file. Verified locally (`pm2 start
ecosystem.config.js` against a real Postgres, confirmed the dashboard and auth both work,
`logs/out.log` picks up the startup line) but nothing here has touched the actual
`192.168.68.255` box.

### 7. Run the unit tests

```
npm test
```

71 tests (Node's built-in `node --test`, no framework dependency -- see
`.claude/skills/unit-testing/SKILL.md` for the conventions this suite follows). Covers every
pure/deterministic piece: the concurrency rule (CONTRACT.md section 6) and result computation
(section 7, including the SSD ATA-vs-NVMe threshold split and the stop_reason/aborted and
pass/fail/flagged boundary conditions), API-key hashing, the config file loader (including its
BOM-handling and no-stale-caching behavior), request-validation predicates, the telemetry cache's
hit path, and the technician-provisioning filename sanitization. Deliberately does not cover
anything needing a live Postgres/HTTP/WebSocket connection -- routes and WS handlers (including
`createTechnician()` itself, which inserts a row) are exercised by the manual checklist below
instead.

## Project layout

```
ecosystem.config.js   pm2 process definition (production/LAN deploy, see "Start the server" above)
migrations/           Plain SQL migrations (001_init.sql = CONTRACT.md section 2 schema)
db/
  pool.js              pg Pool, reads DATABASE_URL
  migrate.js           Minimal migration runner (tracks applied files in schema_migrations)
config/
  default.json         Thresholds/durations config file (CONTRACT.md section 3)
src/
  app.js               Express app wiring (routes, static files, error handling)
  server.js             Entrypoint: HTTP server + WebSocket upgrade routing, starts here
  config.js             Config file loader (re-reads from disk each call, strips a leading
                           UTF-8 BOM -- see comments)
  lib/
    auth.js              API key hashing + lookup + requireApiKey() middleware
    technicians.js         createTechnician() -- shared by scripts/create-technician.js and the
                              dashboard's POST /api/technicians, so provisioning logic lives once
    concurrency.js        CONTRACT.md section 6 rule, as a pure function
    resultComputation.js  CONTRACT.md section 7 rule, as a pure function
    testRunCache.js        In-memory test_run_id -> {session_id, component} cache
    validation.js          Small input-validation helpers
    pdf.js                 PDF report generation (pdfkit)
  routes/
    pcClient.js            PC-client endpoints (auth required)
    dashboard.js            Dashboard endpoints (no auth) -- includes the force-close
                               .../stop and .../end endpoints, and technician management
                               (CONTRACT.md section 4)
  ws/
    hub.js                  In-memory pub/sub for /ws/live fan-out, keyed by session_id
    telemetry.js             /ws/telemetry connection handler
    live.js                  /ws/live connection handler
scripts/
  create-technician.js    CLI wrapper around src/lib/technicians.js -- for shell access / bulk
                             import; public/technicians.html covers this day-to-day now
api_keys/                Generated technician API key files (git-ignored except its own README --
                            see api_keys/README.md)
public/                  Static dashboard (plain HTML/CSS/JS, no build step)
  index.html               Session list + search
  session.html              Session detail: live/historical chart per test_run, PDF export link,
                               force-stop/end controls
  technicians.html          List/create/revoke technicians, one-time API key reveal on creation
  js/app.js, js/session.js, js/technicians.js, js/theme.js  (theme.js: light/dark toggle, opt-in only)
  css/style.css
  vendor/chart.umd.min.js  Vendored Chart.js (no CDN dependency)
test/                    node:test unit tests (71 tests -- see "Run the unit tests" above)
.claude/skills/unit-testing/  Project-scoped Claude Code skill documenting this suite's conventions
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
13. Load the dashboard with the OS/browser set to dark mode -- confirm it still loads **light**
    (dark mode here is opt-in only, never inferred). Click the theme toggle, confirm it switches
    and reloading the page remembers the choice (`localStorage`).
14. Start a test-run, then walk away without ever calling its completion or session-end endpoint
    (simulating a crashed client) -- confirm the session detail page shows a "Stop running
    test(s)" button, and that clicking it marks the test_run `aborted`
    (`stop_reason: manual_stop`) and closes the session, with no duplicate panels.
15. Manually create a session + test-run via curl, complete the test-run normally, but never call
    end-session -- confirm the session detail page shows an "End session" button (not "Stop
    running test(s)", since nothing is running) and that clicking it closes the session.
16. `PATCH` a test-run's `summary_stats` with SSD SMART fields for both an ATA-style drive
    (`max_smart_reallocated_sectors`) and an NVMe-style drive (`max_smart_percentage_used`,
    `min_smart_available_spare_percent`) in separate test-runs -- confirm both evaluate correctly
    against `config/default.json`'s bus-aware thresholds and render on the dashboard.
17. On `/technicians.html`, create a technician -- confirm the raw key is shown once, the Copy
    button works (or at minimum the key is pre-selected for manual Ctrl+C), and `api_keys/<name>.txt`
    was written with exactly that key as its whole content. Deactivate that technician, then try a
    request with their key (e.g. `GET /api/config`) -- confirm `401`. Reactivate, confirm the same
    key works again (the key itself never changes across deactivate/reactivate).
18. On `/technicians.html`, click Delete on a fresh technician with no sessions -- confirm they're
    gone from the list and the DB row is actually removed (not just deactivated). Then click
    Delete on a technician who owns at least one session -- confirm it's rejected with a clear
    "has session(s)" message, not a raw DB error, and that they're still in the list afterward.

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
   hard fail per the literal wording, independent of any config key.

   **Update once GPU/RAM/SSD landed**: this originally flagged `smart_reallocated_sectors_max` as
   an example of a key that didn't fit the convention ("max" as a suffix, not a prefix) and so
   silently never evaluated. Once the client side actually implemented SSD SMART reading
   (`SsdSmartReader`), its README caught that gap for real and flagged it back here for
   reconciliation -- fixed by renaming to `max_smart_reallocated_sectors` and adding NVMe-specific
   `max_smart_percentage_used`/`min_smart_available_spare_percent`/`max_smart_media_errors`
   alongside it (see CONTRACT.md section 3 and `resultComputation.js`'s comment for the full
   ATA-vs-NVMe story). No config threshold currently goes unevaluated due to a naming mismatch.

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

6. ~~No technicians-list endpoint.~~ **Resolved**: `GET /api/technicians` now exists
   (`public/technicians.html`), so `GET /api/sessions`'s `technician_id` filter and the session
   list's technician-name column both have a real source to back a picker with, if one gets built.

7. ~~Technician provisioning has no endpoint at all.~~ **Resolved**: `POST /api/technicians` and
   `PATCH /api/technicians/:id` (revoke/reactivate) now exist alongside the list endpoint above,
   sharing their actual provisioning logic with `scripts/create-technician.js` via
   `src/lib/technicians.js` so the CLI and the dashboard page can't drift apart. The CLI script
   still exists for anyone who prefers shell access (e.g. scripting a bulk import).

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

- No GPU/RAM-specific parsing, threshold tuning, or wrapper logic -- those config sections are
  still the contract's placeholder example values, untouched.
- SSD thresholds are real now (bus-aware ATA/NVMe SMART fields, see "Scope notes" item 2), but
  that's config/result-computation only -- the client's SSD test-run orchestration (UI, session
  `ssd_serials` wiring, actually running CrystalDiskMark) isn't built yet, so nothing exercises
  these thresholds end-to-end outside of manual `curl`/test calls.
- No dashboard login/auth (explicitly no-login per PROJECT_PLAN.md).
- No admin UI for editing `config/default.json` (hand-edit the file, per plan).
- No connection to or configuration of the real `192.168.68.255` production box -- everything here
  is local-dev-configurable via `.env`.
- Nothing pushed to a remote -- this repo has no remote configured, and none was added.
