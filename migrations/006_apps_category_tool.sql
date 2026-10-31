-- A third category for the apps table: general tools (alongside apps and drivers).
ALTER TABLE apps DROP CONSTRAINT IF EXISTS apps_category_check;
ALTER TABLE apps ADD CONSTRAINT apps_category_check CHECK (category IN ('app', 'driver', 'tool'));
