-- The client gained a VRAM test (memtest_vulkan), reported as its own component. Postgres enums
-- can only grow by ADD VALUE; IF NOT EXISTS keeps this safe to re-run by hand. Needs Postgres 12+
-- (ADD VALUE inside a transaction block, which the migration runner uses, is rejected before that).
ALTER TYPE component ADD VALUE IF NOT EXISTS 'vram';
