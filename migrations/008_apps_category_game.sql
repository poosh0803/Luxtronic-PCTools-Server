-- Fifth category for the apps table: games (alongside apps, drivers, tools and client releases).
ALTER TABLE apps DROP CONSTRAINT IF EXISTS apps_category_check;
ALTER TABLE apps ADD CONSTRAINT apps_category_check CHECK (category IN ('app', 'driver', 'tool', 'client', 'game'));
