-- Downloadable apps/installers the PC client can fetch from the server. Metadata lives here; the
-- uploaded package and icon live on disk under APPS_DIR/<id>/ (see src/lib/apps.js). file_*
-- columns are NULL until a package has been uploaded; icon_* until an icon has been uploaded or
-- extracted from an .exe.
CREATE TABLE IF NOT EXISTS apps (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  description   TEXT,
  version       TEXT,
  file_name     TEXT,           -- original file name, used for the download
  file_size     BIGINT,
  file_sha256   TEXT,
  icon_mime     TEXT,
  icon_source   TEXT,           -- 'upload' | 'extracted'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
