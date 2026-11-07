-- Fourth category for the apps table: published builds of the PC client itself (one row per
-- release, the version being what distinguishes them), uploaded on the dashboard's Publish page.
ALTER TABLE apps DROP CONSTRAINT IF EXISTS apps_category_check;
ALTER TABLE apps ADD CONSTRAINT apps_category_check CHECK (category IN ('app', 'driver', 'tool', 'client'));
