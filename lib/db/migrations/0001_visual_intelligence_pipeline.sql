-- Task #58: Ashley Visual Intelligence — multi-image pipeline
-- Additive migration: adds the three schema changes introduced by this task.
-- All statements are forward-safe (IF NOT EXISTS) so this migration can be
-- applied to an existing DB that was previously synced via drizzle-kit push.

-- 1. New columns on messages: visual_packet_id groups a multi-image packet;
--    selfie_vibe_list carries the array of vibe strings emitted by the AI.
ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "visual_packet_id" text,
  ADD COLUMN IF NOT EXISTS "selfie_vibe_list" text;

-- 2. New table: media_attachments tracks every individual image in a packet
--    (generated or user-submitted), including generation status, intent,
--    attribute scope (permanent / temporary), and display sort order.
CREATE TABLE IF NOT EXISTS "media_attachments" (
  "id"               text PRIMARY KEY NOT NULL,
  "message_id"       text NOT NULL,
  "device_id"        text NOT NULL,
  "visual_packet_id" text NOT NULL,
  "role"             text DEFAULT 'generated_option' NOT NULL,
  "status"           text DEFAULT 'pending' NOT NULL,
  "category"         text DEFAULT 'selfie' NOT NULL,
  "intent"           text,
  "image_url"        text,
  "description"      text,
  "attribute_scope"  text DEFAULT 'permanent' NOT NULL,
  "sort_order"       integer DEFAULT 0 NOT NULL,
  "job_id"           text,
  "created_at"       timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"       timestamp with time zone DEFAULT now() NOT NULL
);

-- 3. Indexes for the two most common lookup patterns.
CREATE INDEX IF NOT EXISTS "media_attachments_message_idx"
  ON "media_attachments" USING btree ("message_id");

CREATE INDEX IF NOT EXISTS "media_attachments_packet_idx"
  ON "media_attachments" USING btree ("visual_packet_id");
