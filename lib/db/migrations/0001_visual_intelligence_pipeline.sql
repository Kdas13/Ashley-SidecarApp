-- Task #58: Ashley Visual Intelligence — multi-image pipeline
-- Additive migration: adds the three schema changes introduced by this task.
-- All statements are forward-safe (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)
-- so this migration is idempotent on an existing DB synced via drizzle-kit push.

-- 1. New columns on messages: visual_packet_id groups a multi-image packet;
--    selfie_vibe_list carries the raw array of vibe strings from the AI reply.
ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "visual_packet_id" text,
  ADD COLUMN IF NOT EXISTS "selfie_vibe_list" text;

-- 2. New table: media_attachments tracks every individual image in a packet
--    (generated or user-submitted). Columns mirror mediaAttachmentsTable in
--    lib/db/src/schema/ashley.ts exactly.
CREATE TABLE IF NOT EXISTS "media_attachments" (
  "id"               text PRIMARY KEY NOT NULL,
  "device_id"        text NOT NULL,
  "message_id"       text NOT NULL,
  "visual_packet_id" text NOT NULL,
  -- Who originated this attachment (generated_option | user_input | …).
  "role"             text DEFAULT 'generated_option' NOT NULL,
  -- Semantic category (selfie, full_body, medical, …). Nullable.
  "category"         text,
  -- Lifecycle: pending | ready | failed.
  "status"           text DEFAULT 'pending' NOT NULL,
  -- Raw marker string as emitted by the model, e.g. "[image:SELFIE_MODE|warm close-up]".
  -- Null on user_input rows.
  "marker"           text,
  -- Encoded MODE|vibe string from the AI marker. Null on user_input rows.
  "selfie_vibe"      text,
  -- Image-mode name (SELFIE_MODE, FULL_BODY_MODE, …). Null on user_input rows.
  "intent"           text,
  -- Optional description or caption.
  "description"      text,
  -- temporary (default) | permanent. Flipped only on explicit user request.
  "attribute_scope"  text DEFAULT 'temporary' NOT NULL,
  -- Resolved image URL. Null until the generation job completes.
  "image_url"        text,
  -- 0-based sort order within the packet (preserves the LLM's emission order).
  "sort_order"       integer DEFAULT 0 NOT NULL,
  "created_at"       timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"       timestamp with time zone DEFAULT now() NOT NULL
);

-- 3. Indexes for the two most common lookup patterns.
CREATE INDEX IF NOT EXISTS "media_attachments_message_idx"
  ON "media_attachments" USING btree ("message_id");

CREATE INDEX IF NOT EXISTS "media_attachments_packet_idx"
  ON "media_attachments" USING btree ("visual_packet_id");
