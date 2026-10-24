-- Hardware details of the PC under test (CPU/GPU/RAM modules/motherboard/drives/OS), sent by the
-- client when it creates a session so the report shows the machine's specification. Free-form
-- JSON (see src/lib/systemInfo.js for the shape it understands); NULL for sessions from clients
-- that don't send it.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS system_info JSONB;
