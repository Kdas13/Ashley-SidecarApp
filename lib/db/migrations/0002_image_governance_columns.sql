-- Section 9 image governance — Mode 1 manual defaults
-- Additive migration: adds four nullable text columns to ashley_profile.
-- All DEFAULT NULL → the server treats null as "auto" (Mode 2: derive from
-- real clock time / day of week / season). Non-null values engage Mode 1
-- (explicit override from the mobile profile screen).
-- All statements are idempotent (ADD COLUMN IF NOT EXISTS).

ALTER TABLE "ashley_profile"
  ADD COLUMN IF NOT EXISTS "image_composition_mode"   text,
  ADD COLUMN IF NOT EXISTS "image_environment_default" text,
  ADD COLUMN IF NOT EXISTS "image_occupancy_default"  text,
  ADD COLUMN IF NOT EXISTS "image_camera_default"     text;
