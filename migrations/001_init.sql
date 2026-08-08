-- Initial schema, matching CONTRACT.md section 2 exactly.
-- gen_random_uuid() comes from pgcrypto; CREATE EXTENSION IF NOT EXISTS keeps this migration
-- portable across Postgres versions/builds where it isn't preloaded.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE technicians (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  api_key_hash    TEXT NOT NULL UNIQUE,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE machines (
  mobo_serial     TEXT PRIMARY KEY,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE session_type AS ENUM ('new_build', 'repair');

CREATE TABLE sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mobo_serial     TEXT NOT NULL REFERENCES machines(mobo_serial),
  technician_id   UUID NOT NULL REFERENCES technicians(id),
  customer_name   TEXT,
  session_type    session_type NOT NULL,
  notes           TEXT,
  ssd_serials     JSONB NOT NULL DEFAULT '[]',   -- ["serial1", "serial2", ...]
  other_serials   JSONB NOT NULL DEFAULT '{}',   -- { "gpu": "...", ... } best-effort, may be empty
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ
);

CREATE TYPE component AS ENUM ('cpu', 'gpu', 'ram', 'ssd');
CREATE TYPE test_result AS ENUM ('pass', 'fail', 'flagged', 'aborted');

CREATE TABLE test_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES sessions(id),
  component       component NOT NULL,
  config_snapshot JSONB NOT NULL,       -- the config.json subtree used for this run, frozen at start time
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ,
  tool_exit_code  INTEGER,
  tool_output_raw TEXT,                 -- raw stdout/log from Prime95/FurMark/TM5/CrystalDiskMark
  summary_stats   JSONB,                -- e.g. { "max_temp_c": 87, "error_count": 0, "avg_load_pct": 99 }
  result          test_result,
  stop_reason     TEXT                  -- null on a normal finish; see CONTRACT.md section 7 for the non-null values
);

CREATE TABLE telemetry (
  id              BIGSERIAL PRIMARY KEY,
  test_run_id     UUID NOT NULL REFERENCES test_runs(id),
  ts              TIMESTAMPTZ NOT NULL,
  sensor_name     TEXT NOT NULL,        -- e.g. "cpu_package_temp_c", "gpu_fan_rpm"
  value           DOUBLE PRECISION NOT NULL
);
CREATE INDEX idx_telemetry_test_run_ts ON telemetry (test_run_id, ts);

-- Helper indexes for common dashboard filters/lookups. Not specified in CONTRACT.md section 2's
-- literal DDL block, but cheap and non-invasive additions that don't change the schema shape.
CREATE INDEX idx_sessions_mobo_serial ON sessions (mobo_serial);
CREATE INDEX idx_sessions_technician_id ON sessions (technician_id);
CREATE INDEX idx_sessions_started_at ON sessions (started_at);
CREATE INDEX idx_test_runs_session_id ON test_runs (session_id);
CREATE INDEX idx_test_runs_active ON test_runs (session_id) WHERE ended_at IS NULL;
