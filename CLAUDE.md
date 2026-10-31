# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

**Full server in production use** on the LAN box with the rebuilt v2 client: schema (migrations 001-006),
all REST endpoints, the concurrency rule (CONTRACT.md section 6), result computation (section 7), both
WebSocket protocols (section 5), components cpu/gpu/vram/ram/ssd, `system_info` (PC specification) and
`run_settings`, a dashboard (session list, session detail with live + historical charts, technicians page, and Apps / Drivers / Tools pages where installers are uploaded for the PC client to download)
and a designed PDF report. Dashboard and PDF follow LUXTRONIC-DESIGN-GUIDELINES.md (compact header, 1080p
layout) - keep new UI within them. See [README.md](README.md) for run/deploy commands and judgment calls.

[PROJECT_PLAN.md](PROJECT_PLAN.md) (its last section lists changes since it was written) is the source of
truth for architecture and scope. [CONTRACT.md](CONTRACT.md) is the contract with the client; this repo's
copy is canonical and the client repo keeps an identical copy. After changing server files, restart the local
pm2 service (`pm2 restart luxtronic-pctools-server`); deploy to the LAN box only when asked.

## Build/lint/test commands (this repo)

- `npm install` — install dependencies.
- `npm run migrate` — apply `migrations/*.sql` against `DATABASE_URL` (see `.env.example`).
- `npm run seed:technician -- "Name"` — provision a technician + print a raw API key.
- `npm start` / `npm run dev` — run the server (`dev` uses `node --watch`).
- `npm test` — run `node:test` unit tests in `test/` (93 tests: concurrency, result computation, validation, config, auth).
- No linter is configured yet.

## What this project is

Luxtronic PCTools: a two-part hardware testing system, split into two **separate git repos** (not subdirectories of this one — this repo is planning/contract docs only):

- **`Luxtronic-PCTools-Client`** (`C:\Users\Admin\Documents\Github\Luxtronic-PCTools-Client`, git-initialized, no commits yet) — C#/.NET WPF, runs on Windows 11/10 machines under test (new builds and customer repairs). Technician-operated, no customer-facing UI. Runs Prime95 (CPU), FurMark (GPU), TestMem5 (RAM), CrystalDiskMark/CrystalDiskInfo (SSD) as external processes bundled in its own install folder (pinned versions, no runtime download), reads sensors via LibreHardwareMonitorLib, and streams everything to the server. It does **not** decide pass/fail — that's server-side.
- **`Luxtronic-PCTools-Server`** (`C:\Users\Admin\Documents\Github\Luxtronic-PCTools-Server`, git-initialized, no commits yet) — Node.js/Express + PostgreSQL (own instance on port `5434`, separate from the other services' Postgres on `5432`/`5433`), deployed via the same pm2 pattern as the other Luxtronic LAN services (`lan-portal-deploy`: git pull + pm2 restart), listening on `192.168.68.255:7777`. Ingests telemetry, evaluates results against a config file of thresholds, and serves a live-updating web dashboard (no login — LAN-trust only) for reviewing sessions and exporting PDF reports.

**Build order**: a single CPU-only vertical slice end-to-end first (client → server → live dashboard view → PDF export), to prove the sensor driver works on real Windows 11 hardware and that CONTRACT.md holds up, before parallelizing the GPU/RAM/SSD wrappers. See PROJECT_PLAN.md §9 for why.

## Architecture points that span both sides

- **Identity model**: a test session is keyed by the PC's motherboard serial number (read on the client, not user-entered). Technicians are identified by a static API key file, one per technician — this key is how the server attributes a session to whoever ran it.
- **Config flows one direction**: from server to client. The client fetches thresholds/durations at session start and just executes; the server is the only place that holds/evaluates pass/fail logic. Don't add client-side pass/fail logic — it belongs server-side by design.
- **Test concurrency rule**: CPU and GPU tests may run simultaneously or individually; RAM and SSD tests must always run exclusively (never concurrently with anything else). This is a real constraint from test validity, not an arbitrary UI limitation — preserve it in any orchestration code.
- **No results on the PC side.** All review/export happens through the server's web dashboard. Don't add report-viewing or result UI to the PC-side client.
- **Third-party test tools are licensed for internal use only** (notably FurMark's free tier explicitly excludes commercial applications — acceptable here only because usage stays internal/unshipped). Do not bundle, redistribute, or sell any part of this tool without re-checking those licenses.
