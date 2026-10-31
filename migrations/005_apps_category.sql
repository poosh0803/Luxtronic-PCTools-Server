-- The apps table now also holds drivers: same upload/download mechanics, listed on a separate
-- dashboard page. 'app' keeps the PC client's existing GET /api/apps unchanged.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'app'
  CHECK (category IN ('app', 'driver'));
